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
}
pub struct MeetingMonitor {
    cache: Mutex<Option<(Instant, u64, MeetingStatus)>>,
    test_status: Mutex<Option<bool>>,
}
impl MeetingMonitor {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
            test_status: Mutex::new(None),
        }
    }
    pub fn set_test_status(&self, value: bool) {
        *self.test_status.lock().unwrap() = Some(value);
    }
    pub fn check(&self, epoch: u64, absent: bool) -> MeetingStatus {
        if absent {
            *self.cache.lock().unwrap() = None;
            return MeetingStatus {
                in_meeting: false,
                supported: meeting_supported(),
            };
        }
        if let Some(value) = *self.test_status.lock().unwrap() {
            return MeetingStatus {
                in_meeting: value,
                supported: true,
            };
        }
        let mut cache = self.cache.lock().unwrap();
        if let Some((at, generation, value)) = &*cache {
            if *generation == epoch && at.elapsed() < Duration::from_secs(10) {
                return value.clone();
            }
        }
        let result = native::meeting_status();
        *cache = Some((Instant::now(), epoch, result.clone()));
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
pub fn active_meeting_assertion(output: &str) -> bool {
    static SUMMARY: OnceLock<Regex> = OnceLock::new();
    static ASSERTION: OnceLock<Regex> = OnceLock::new();
    let summary = SUMMARY
        .get_or_init(|| Regex::new(r"(?m)^\s*PreventUserIdleDisplaySleep\s+(\d+)\s*$").unwrap());
    if !summary
        .captures(output)
        .is_some_and(|capture| capture[1].parse::<u32>().is_ok_and(|value| value > 0))
    {
        return false;
    }
    let assertion = ASSERTION.get_or_init(|| {
        Regex::new(r#"(?i)\bpid\s+\d+\((.+?)\):.*?\b\d+:\d+:\d+\s+(\w+)\s+named:\s*"([^"]*)""#)
            .unwrap()
    });
    output
        .lines()
        .filter_map(|line| assertion.captures(line))
        .any(|capture| {
            if &capture[2] != "PreventUserIdleDisplaySleep" {
                return false;
            }
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
            known
                || browser
                    && (name == "webrtc"
                        || name.starts_with("webrtc ")
                        || name.contains("meet.google.com"))
        })
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
