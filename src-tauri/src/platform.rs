#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod parsing;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
use linux as native;
#[cfg(target_os = "macos")]
use macos as native;
use regex::Regex;
#[cfg(target_os = "windows")]
use windows as native;

pub use native::FocusTarget;

/// Capture the external application/window before the break takes foreground focus.
/// Native window operations, including these helpers, run on the UI thread.
pub fn capture_focus() -> Option<FocusTarget> {
    native::capture_focus()
}

/// Return focus only while Blincho still owns it. A user-selected app or a stale
/// target is an intentional no-op. Call before hiding/minimizing our window.
pub fn restore_focus(target: &FocusTarget) -> Result<(), String> {
    native::restore_focus(target)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn may_restore_focus(
    own_process: u32,
    foreground_process: Option<u32>,
    target_process: u32,
    target_is_original: bool,
) -> bool {
    foreground_process == Some(own_process)
        && target_process != 0
        && target_process != own_process
        && target_is_original
}

/// A failed native probe stays unknown. The timer deliberately pauses while presence
/// cannot be confirmed, rather than counting work based on invented zero idle time.
#[derive(Clone, Copy, Debug, Default)]
pub struct Presence {
    pub idle_seconds: Option<f64>,
    pub locked: Option<bool>,
}
pub fn presence() -> Presence {
    let mut value = native::presence();
    value.idle_seconds = value
        .idle_seconds
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.);
    value
}
pub fn observe_power(callback: extern "C" fn(i32)) -> Result<(), String> {
    native::observe_power(callback)
}
pub fn power_source() -> &'static str {
    native::power_source()
}
pub fn lock_computer(test_profile: bool) -> Result<bool, String> {
    lock_computer_with(
        test_profile || std::env::var_os("BLINCHO_PROTOTYPE_TEST_DIR").is_some(),
        native::request_lock,
        native::lock_confirmed,
        || std::thread::sleep(Duration::from_millis(50)),
    )
}
fn lock_computer_with(
    test_profile: bool,
    request: impl FnOnce() -> Result<(), String>,
    mut confirmed: impl FnMut() -> Option<bool>,
    mut wait: impl FnMut(),
) -> Result<bool, String> {
    if test_profile {
        return Err("Computer locking is disabled in test profiles".into());
    }
    request()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    // A successful native request can be asynchronous or ignored by a desktop
    // without a screen locker. Only confirmed state is reported as success.
    for _ in 0..60 {
        if confirmed() == Some(true) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            break;
        }
        wait();
    }
    Err("The computer lock could not be confirmed".into())
}
pub fn notifications_initialize(clicked: extern "C" fn()) {
    native::notifications_initialize(clicked);
}
pub async fn notification_permission(app: &tauri::AppHandle) -> Result<bool, String> {
    native::notification_permission(app).await
}
pub async fn notification_send(
    app: &tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    if title.len() > 1024 || body.len() > 8192 || title.contains('\0') || body.contains('\0') {
        return Err("Invalid notification text".into());
    }
    native::notification_send(app, title, body).await
}
pub fn preferred_languages() -> Vec<String> {
    native::preferred_languages()
}
pub fn meeting_supported() -> bool {
    native::meeting_supported()
}
#[cfg(target_os = "macos")]
pub unsafe fn window_level(pointer: *mut std::ffi::c_void, strict: bool) {
    macos::window_level(pointer, strict);
}
#[cfg(target_os = "macos")]
pub fn strict_shield_count() -> i32 {
    macos::strict_shield_count()
}
#[cfg(target_os = "macos")]
pub fn activation_policy(app: &tauri::AppHandle) -> Option<i32> {
    macos::activation_policy(app)
}
use serde::Serialize;
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatus {
    pub in_meeting: bool,
    pub supported: bool,
    pub applications: Vec<String>,
}
impl MeetingStatus {
    pub fn detected(applications: Vec<String>, supported: bool) -> Self {
        let applications = normalize_meeting_applications(&applications);
        Self {
            in_meeting: supported && !applications.is_empty(),
            supported,
            applications,
        }
    }
    pub fn inactive(supported: bool) -> Self {
        Self {
            in_meeting: false,
            supported,
            applications: vec![],
        }
    }
}
pub fn normalize_meeting_applications(values: &[String]) -> Vec<String> {
    parsing::normalize_meeting_applications(values)
}
#[derive(Default)]
struct MeetingCache {
    revision: u64,
    status: Option<(Instant, u64, MeetingStatus)>,
}
pub struct MeetingMonitor {
    cache: Mutex<MeetingCache>,
    test_status: Mutex<Option<MeetingStatus>>,
}
impl MeetingMonitor {
    const BACKGROUND_CACHE_TTL: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self {
            cache: Mutex::new(MeetingCache::default()),
            test_status: Mutex::new(None),
        }
    }
    pub fn set_test_status(&self, active: bool, applications: Vec<String>) {
        let applications = if active {
            let applications = normalize_meeting_applications(&applications);
            if applications.is_empty() {
                vec!["unknown".into()]
            } else {
                applications
            }
        } else {
            vec![]
        };
        *self.test_status.lock().unwrap() = Some(MeetingStatus {
            in_meeting: active,
            supported: true,
            applications,
        });
        self.invalidate();
    }
    pub fn invalidate(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.revision = cache.revision.wrapping_add(1);
        cache.status = None;
    }
    pub fn inactive_status(&self) -> MeetingStatus {
        let supported = self
            .test_status
            .lock()
            .unwrap()
            .as_ref()
            .map(|status| status.supported)
            .or_else(|| {
                self.cache
                    .lock()
                    .unwrap()
                    .status
                    .as_ref()
                    .map(|(_, _, status)| status.supported)
            })
            .unwrap_or(cfg!(target_os = "macos"));
        self.invalidate();
        MeetingStatus::inactive(supported)
    }
    pub fn check(&self, epoch: u64, absent: bool) -> MeetingStatus {
        if absent {
            return self.inactive_status();
        }
        self.check_with(epoch, false, native::meeting_status)
    }
    pub fn check_fresh(&self, epoch: u64) -> MeetingStatus {
        self.check_with(epoch, true, native::meeting_status)
    }
    fn check_with(
        &self,
        epoch: u64,
        fresh: bool,
        probe: impl FnOnce() -> MeetingStatus,
    ) -> MeetingStatus {
        if let Some(value) = self.test_status.lock().unwrap().as_ref() {
            return value.clone();
        }
        let mut cache = self.cache.lock().unwrap();
        if let Some((at, generation, value)) = &cache.status {
            if !fresh && *generation == epoch && at.elapsed() < Self::BACKGROUND_CACHE_TTL {
                return value.clone();
            }
        }
        cache.revision = cache.revision.wrapping_add(1);
        let revision = cache.revision;
        drop(cache);
        let result = probe();
        let mut cache = self.cache.lock().unwrap();
        // Clearing history or changing the policy may invalidate a slow probe
        // while it runs. Such a result must never restore the old cache.
        if cache.revision == revision {
            cache.status = Some((Instant::now(), epoch, result.clone()));
        }
        result
    }
}
pub(super) fn bounded_probe(program: &str, args: &[&str]) -> Option<String> {
    const LIMIT: u64 = 256 * 1024;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > LIMIT {
            return None;
        }
        String::from_utf8(bytes).ok()
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = reader.join().ok().flatten();
    if status.is_some_and(|value| value.success()) {
        output
    } else {
        None
    }
}
pub fn active_meeting_applications(output: &str) -> Vec<String> {
    static SUMMARY: OnceLock<Regex> = OnceLock::new();
    static ASSERTION: OnceLock<Regex> = OnceLock::new();
    let summary = SUMMARY
        .get_or_init(|| Regex::new(r"(?m)^\s*PreventUserIdleDisplaySleep\s+(\d+)\s*$").unwrap());
    let display_sleep_prevented = summary
        .captures(output)
        .is_some_and(|capture| capture[1].parse::<u32>().is_ok_and(|value| value > 0));
    let assertion = ASSERTION.get_or_init(|| {
        Regex::new(r#"(?i)\bpid\s+\d+\((.+?)\):.*?\b\d+:\d+:\d+\s+(\w+)\s+named:\s*"([^"]*)""#)
            .unwrap()
    });
    let applications = output
        .lines()
        .filter_map(|line| assertion.captures(line))
        .filter_map(|capture| {
            let display_assertion =
                display_sleep_prevented && &capture[2] == "PreventUserIdleDisplaySleep";
            let owner = capture[1].trim().to_lowercase();
            let name = capture[3].to_lowercase();
            let known = [
                "zoom",
                "zoom.us",
                "cpthost",
                "microsoft teams",
                "teams",
                "webex",
                "skype",
                "facetime",
            ]
            .contains(&owner.as_str());
            let browser = [
                "google chrome",
                "chromium",
                "safari",
                "firefox",
                "microsoft edge",
            ]
            .contains(&owner.as_str());
            let webrtc = name == "webrtc" || name.starts_with("webrtc ");
            // Background Chrome calls can keep the system awake without
            // preventing display sleep, including while the microphone is muted.
            let background_webrtc = browser
                && webrtc
                && matches!(
                    &capture[2],
                    "NoIdleSleepAssertion" | "PreventUserIdleSystemSleep"
                );
            let meeting = background_webrtc
                || display_assertion
                    && (known || browser && (webrtc || name.contains("meet.google.com")));
            meeting
                .then(|| parsing::meeting_application(&owner).map(String::from))
                .flatten()
        })
        .collect::<Vec<_>>();
    normalize_meeting_applications(&applications)
}
#[cfg(any(target_os = "macos", test))]
fn needs_zoom_capture_probe(applications: &[String]) -> bool {
    !applications.iter().any(|application| application == "Zoom")
}
#[cfg(test)]
pub fn active_meeting_assertion(output: &str) -> bool {
    !active_meeting_applications(output).is_empty()
}
pub fn open_external(url: &str) -> Result<(), String> {
    if url.len() > 4096 {
        return Err("Invalid external URL".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid external URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only HTTPS links without credentials are supported".into());
    }
    native::open_external(parsed.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_profiles_never_issue_a_lock_request() {
        assert!(lock_computer_with(
            true,
            || panic!("Must not lock"),
            || panic!("Must not probe"),
            || panic!("Must not wait")
        )
        .is_err());
    }
    #[test]
    fn lock_request_errors_are_preserved_without_probing() {
        assert_eq!(
            lock_computer_with(
                false,
                || Err("Native failure".into()),
                || panic!("Must not probe"),
                || panic!("Must not wait")
            ),
            Err("Native failure".into())
        );
    }
    #[test]
    fn accepted_lock_request_waits_for_confirmed_state() {
        let mut samples = [Some(false), None, Some(true)].into_iter();
        let mut waits = 0;
        assert_eq!(
            lock_computer_with(false, || Ok(()), || samples.next().unwrap(), || waits += 1),
            Ok(true)
        );
        assert_eq!(waits, 2);
    }
    #[test]
    fn accepted_but_unconfirmed_lock_requests_fail() {
        for state in [Some(false), None] {
            let mut probes = 0;
            assert!(lock_computer_with(
                false,
                || Ok(()),
                || {
                    probes += 1;
                    state
                },
                || {}
            )
            .is_err());
            assert_eq!(probes, 60);
        }
    }
    #[test]
    fn focus_restoration_requires_own_foreground_and_original_external_target() {
        assert!(may_restore_focus(10, Some(10), 20, true));
        assert!(!may_restore_focus(10, Some(30), 20, true));
        assert!(!may_restore_focus(10, None, 20, true));
        assert!(!may_restore_focus(10, Some(10), 10, true));
        assert!(!may_restore_focus(10, Some(10), 0, true));
        assert!(!may_restore_focus(10, Some(10), 20, false));
    }
    #[test]
    fn focus_target_can_be_cloned_and_stored_in_window_session() {
        fn requires_traits<T: Clone + Send + Sync>() {}
        requires_traits::<FocusTarget>();
    }
    fn assertion(owner: &str, kind: &str, name: &str) -> String {
        format!("PreventUserIdleDisplaySleep 1\n pid 42({owner}): [0x1] 00:01:20 {kind} named: \"{name}\"")
    }
    #[test]
    fn meeting_assertion_ignores_media_and_wrong_power_type() {
        assert!(active_meeting_assertion(&assertion(
            "zoom.us",
            "PreventUserIdleDisplaySleep",
            "video meeting"
        )));
        assert!(active_meeting_assertion(&assertion(
            "Google Chrome",
            "PreventUserIdleDisplaySleep",
            "WebRTC call"
        )));
        assert!(!active_meeting_assertion(&assertion(
            "Google Chrome",
            "PreventUserIdleDisplaySleep",
            "Playing video"
        )));
        assert!(!active_meeting_assertion(&assertion(
            "Spotify",
            "PreventUserIdleDisplaySleep",
            "WebRTC"
        )));
        assert!(!active_meeting_assertion(&assertion(
            "zoom.us",
            "PreventUserIdleSystemSleep",
            "video meeting"
        )));
        assert!(!active_meeting_assertion(
            &assertion("zoom.us", "PreventUserIdleDisplaySleep", "meeting")
                .replace("Sleep 1", "Sleep 0")
        ));
    }
    #[test]
    fn background_browser_webrtc_does_not_require_display_sleep_prevention() {
        let output = "PreventUserIdleDisplaySleep 0\nPreventUserIdleSystemSleep 1\n   pid 98974(Google Chrome): [0x000ef28000019b96] 00:17:39 NoIdleSleepAssertion named: \"WebRTC has active PeerConnections\"";
        assert_eq!(active_meeting_applications(output), ["Google Chrome"]);
        for playback in ["Playing audio", "Playing video"] {
            assert!(active_meeting_applications(
                &output.replace("WebRTC has active PeerConnections", playback)
            )
            .is_empty());
        }
        for owner in ["Spotify", "caffeinate", "zoom.us"] {
            assert!(
                active_meeting_applications(&output.replace("Google Chrome", owner)).is_empty()
            );
        }
        for kind in ["BackgroundTask", "InternalPreventDisplaySleep"] {
            assert!(
                active_meeting_applications(&output.replace("NoIdleSleepAssertion", kind))
                    .is_empty()
            );
        }
        assert_eq!(
            active_meeting_applications(
                &output.replace("NoIdleSleepAssertion", "PreventUserIdleSystemSleep")
            ),
            ["Google Chrome"]
        );
    }
    #[test]
    fn meeting_assertions_attribute_multiple_apps_without_retaining_titles() {
        let output = [
            assertion(
                "CptHost",
                "PreventUserIdleDisplaySleep",
                "Alice's Zoom meeting",
            ),
            assertion("zoom.us", "PreventUserIdleDisplaySleep", "private call"),
            assertion(
                "Google Chrome",
                "PreventUserIdleDisplaySleep",
                "WebRTC https://meet.google.com/private-room",
            ),
            assertion(
                "Microsoft Teams",
                "PreventUserIdleDisplaySleep",
                "private customer",
            ),
            assertion("Firefox", "PreventUserIdleDisplaySleep", "Playing video"),
        ]
        .join("\n");
        assert_eq!(
            active_meeting_applications(&output),
            ["Google Chrome", "Microsoft Teams", "Zoom"]
        );
    }
    #[test]
    fn modeled_meeting_status_keeps_legacy_boolean_and_filters_applications() {
        let monitor = MeetingMonitor::new();
        monitor.set_test_status(true, vec![]);
        let unknown = monitor.check(0, false);
        assert!(unknown.in_meeting && unknown.supported);
        assert_eq!(unknown.applications, ["unknown"]);
        monitor.set_test_status(
            true,
            vec![
                "Zoom.exe".into(),
                "CptHost".into(),
                "private meeting title".into(),
            ],
        );
        assert_eq!(monitor.check(0, false).applications, ["Zoom"]);
        monitor.set_test_status(false, vec!["Zoom".into()]);
        let inactive = monitor.check(0, false);
        assert!(!inactive.in_meeting);
        assert!(inactive.applications.is_empty());
    }
    #[test]
    fn another_assertion_does_not_suppress_the_zoom_capture_fallback() {
        let applications = active_meeting_applications(&assertion(
            "Microsoft Teams",
            "PreventUserIdleDisplaySleep",
            "private call",
        ));
        assert!(needs_zoom_capture_probe(&applications));
        assert!(needs_zoom_capture_probe(&["Google Chrome".into()]));
        assert!(!needs_zoom_capture_probe(&[
            "Zoom".into(),
            "Microsoft Teams".into()
        ]));
    }
    #[test]
    fn expiry_probe_bypasses_cached_positive_and_negative_background_samples() {
        let monitor = MeetingMonitor::new();
        let zoom = || MeetingStatus::detected(vec!["Zoom".into()], true);
        let inactive = || MeetingStatus::inactive(true);
        assert!(monitor.check_with(0, false, zoom).in_meeting);
        assert!(monitor.check_with(0, false, inactive).in_meeting);
        assert!(!monitor.check_with(0, true, inactive).in_meeting);
        assert!(!monitor.check_with(0, false, zoom).in_meeting);
        assert!(monitor.check_with(0, true, zoom).in_meeting);
    }
    #[test]
    fn background_calls_share_a_three_second_cache_and_refresh_after_expiry() {
        let monitor = MeetingMonitor::new();
        assert!(
            monitor
                .check_with(7, false, || MeetingStatus::detected(
                    vec!["Zoom".into()],
                    true
                ))
                .in_meeting
        );
        let mut cache = monitor.cache.lock().unwrap();
        let (at, _, _) = cache.status.as_mut().unwrap();
        *at = Instant::now() - Duration::from_millis(2500);
        drop(cache);
        assert!(
            monitor
                .check_with(7, false, || panic!(
                    "Background heartbeat should reuse its cache"
                ))
                .in_meeting
        );
        let mut cache = monitor.cache.lock().unwrap();
        let (at, _, _) = cache.status.as_mut().unwrap();
        *at = Instant::now() - Duration::from_millis(3100);
        drop(cache);
        assert!(
            !monitor
                .check_with(7, false, || MeetingStatus::inactive(true))
                .in_meeting
        );
        assert!(
            monitor
                .check_with(8, false, || MeetingStatus::detected(
                    vec!["Discord".into()],
                    true
                ))
                .in_meeting
        );
    }
    #[test]
    fn absence_returns_inactive_without_probing_and_invalidates_old_cache() {
        let monitor = MeetingMonitor::new();
        assert!(
            monitor
                .check_with(0, false, || MeetingStatus::detected(
                    vec!["Zoom".into()],
                    true
                ))
                .in_meeting
        );
        let absent = monitor.check(0, true);
        assert!(!absent.in_meeting && absent.supported);
        assert!(absent.applications.is_empty());
        assert!(
            !monitor
                .check_with(0, false, || MeetingStatus::inactive(true))
                .in_meeting
        );
    }
    #[test]
    fn invalidation_during_a_probe_cannot_restore_the_cleared_cache() {
        let monitor = MeetingMonitor::new();
        let result = monitor.check_with(0, false, || {
            monitor.invalidate();
            MeetingStatus::detected(vec!["Zoom".into()], true)
        });
        assert!(result.in_meeting);
        assert!(monitor.cache.lock().unwrap().status.is_none());
        let fresh = monitor.check_with(0, false, || MeetingStatus::inactive(true));
        assert!(!fresh.in_meeting);
    }
    #[test]
    fn an_older_probe_cannot_overwrite_a_newer_fresh_cache_sample() {
        let monitor = MeetingMonitor::new();
        monitor.check_with(0, false, || {
            assert!(
                !monitor
                    .check_with(0, true, || MeetingStatus::inactive(true))
                    .in_meeting
            );
            MeetingStatus::detected(vec!["Zoom".into()], true)
        });
        assert!(
            !monitor
                .check_with(0, false, || panic!("Newest sample should remain cached"))
                .in_meeting
        );
    }
    #[test]
    fn unsafe_external_schemes_do_not_open_any_program() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "https:///",
            "mailto:user@example.com",
        ] {
            assert!(open_external(url).is_err());
        }
    }
}
