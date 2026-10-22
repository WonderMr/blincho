use super::{
    active_meeting_applications, bounded_probe, bounded_probe_with_exit, needs_zoom_capture_probe,
    MeetingStatus, Presence,
};
use std::{
    ffi::{c_void, CString},
    sync::{mpsc, Arc},
    time::Duration,
};

extern "C" {
    fn blincho_capture_active() -> i32;
    fn blincho_observe_power(callback: extern "C" fn(i32));
    fn blincho_idle_seconds() -> f64;
    fn blincho_session_locked() -> i32;
    fn blincho_request_lock() -> i32;
    fn blincho_lock_confirmed() -> i32;
    fn blincho_notifications_initialize(clicked: extern "C" fn());
    fn blincho_notification_permission(
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
    fn blincho_notification_send(
        title: *const std::ffi::c_char,
        body: *const std::ffi::c_char,
        context: *mut c_void,
        callback: extern "C" fn(*mut c_void, i32),
    );
    fn blincho_window_level(pointer: *mut c_void, strict: i32);
    fn blincho_strict_shield_count() -> i32;
    fn blincho_activation_policy() -> i32;
    fn blincho_capture_focus() -> *mut c_void;
    fn blincho_restore_focus(target: *mut c_void) -> i32;
    fn blincho_release_focus(target: *mut c_void);
}

// The native object is immutable and retains a thread-safe NSRunningApplication.
// Arc owns its +1 reference so session snapshots can safely clone the token.
#[derive(Clone, Debug)]
pub struct FocusTarget(Arc<RetainedFocusTarget>);
#[derive(Debug)]
struct RetainedFocusTarget {
    pointer: usize,
}
impl Drop for RetainedFocusTarget {
    fn drop(&mut self) {
        unsafe { blincho_release_focus(self.pointer as *mut c_void) };
    }
}
pub fn capture_focus() -> Option<FocusTarget> {
    let pointer = unsafe { blincho_capture_focus() };
    (!pointer.is_null()).then(|| {
        FocusTarget(Arc::new(RetainedFocusTarget {
            pointer: pointer as usize,
        }))
    })
}
pub fn restore_focus(target: &FocusTarget) -> Result<(), String> {
    match unsafe { blincho_restore_focus(target.0.pointer as *mut c_void) } {
        0 | 1 => Ok(()),
        -2 => Err("Focus restoration requires the UI thread".into()),
        _ => Err("Could not restore application focus".into()),
    }
}

pub fn presence() -> Presence {
    Presence {
        idle_seconds: Some(unsafe { blincho_idle_seconds() }),
        locked: match unsafe { blincho_session_locked() } {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
    }
}
pub fn request_lock() -> Result<(), String> {
    match unsafe { blincho_request_lock() } {
        1 => Ok(()),
        _ => Err("The macOS session lock API is unavailable".into()),
    }
}
pub fn lock_confirmed() -> Option<bool> {
    match unsafe { blincho_lock_confirmed() } {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}
pub fn observe_power(callback: extern "C" fn(i32)) -> Result<(), String> {
    unsafe {
        blincho_observe_power(callback);
    }
    Ok(())
}
pub fn power_source() -> &'static str {
    "NSWorkspace/DistributedNotificationCenter"
}
pub fn notifications_initialize(clicked: extern "C" fn()) {
    if bundled() {
        unsafe {
            blincho_notifications_initialize(clicked);
        }
    }
}
pub unsafe fn window_level(pointer: *mut c_void, strict: bool) {
    blincho_window_level(pointer, i32::from(strict));
}
pub fn strict_shield_count() -> i32 {
    unsafe { blincho_strict_shield_count() }
}
pub fn activation_policy(app: &tauri::AppHandle) -> Option<i32> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(unsafe { blincho_activation_policy() });
    })
    .ok()?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .ok()
        .filter(|policy| (0..=2).contains(policy))
}
fn bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.ends_with("Contents/MacOS"))
        })
        .unwrap_or(false)
}
extern "C" fn notification_result(context: *mut c_void, value: i32) {
    let sender = unsafe { Box::from_raw(context.cast::<mpsc::Sender<i32>>()) };
    let _ = sender.send(value);
}
pub async fn notification_permission(app: &tauri::AppHandle) -> Result<bool, String> {
    if !bundled() {
        return Ok(false);
    }
    let (sender, receiver) = mpsc::channel::<i32>();
    let context = Box::into_raw(Box::new(sender)) as usize;
    if let Err(error) = app.run_on_main_thread(move || unsafe {
        blincho_notification_permission(context as *mut _, notification_result)
    }) {
        unsafe {
            drop(Box::from_raw(
                (context as *mut c_void).cast::<mpsc::Sender<i32>>(),
            ));
        }
        return Err(error.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(120))
            .map(|value| value == 1)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
pub async fn notification_send(
    app: &tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    if !bundled() {
        return Ok(false);
    }
    let title = CString::new(title).map_err(|error| error.to_string())?;
    let body = CString::new(body).map_err(|error| error.to_string())?;
    let (sender, receiver) = mpsc::channel::<i32>();
    let context = Box::into_raw(Box::new(sender)) as usize;
    if let Err(error) = app.run_on_main_thread(move || unsafe {
        blincho_notification_send(
            title.as_ptr(),
            body.as_ptr(),
            context as *mut _,
            notification_result,
        )
    }) {
        unsafe {
            drop(Box::from_raw(
                (context as *mut c_void).cast::<mpsc::Sender<i32>>(),
            ));
        }
        return Err(error.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|error| error.to_string())
            .and_then(|value| match value {
                1 => Ok(true),
                0 => Ok(false),
                _ => Err("Notification delivery failed".into()),
            })
    })
    .await
    .map_err(|error| error.to_string())?
}
pub fn preferred_languages() -> Vec<String> {
    bounded_probe("/usr/bin/defaults", &["read", "-g", "AppleLanguages"])
        .map(|output| {
            output
                .lines()
                .map(|line| line.trim().trim_matches(&['"', ','][..]).to_string())
                .filter(|line| !line.is_empty() && line != "(" && line != ")")
                .collect()
        })
        .unwrap_or_default()
}
pub fn open_external(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open external link".into())
    }
}
pub fn meeting_supported() -> bool {
    true
}
pub fn meeting_status() -> MeetingStatus {
    meeting_status_with_probes(bounded_probe_with_exit)
}
fn meeting_status_with_probes(
    mut probe: impl FnMut(&str, &[&str], Option<i32>) -> Option<String>,
) -> MeetingStatus {
    let assertion = probe("/usr/bin/pmset", &["-g", "assertions"], None);
    let Some(output) = assertion else {
        return MeetingStatus {
            capture_supported: true,
            ..MeetingStatus::inactive(false)
        };
    };
    let mut applications = active_meeting_applications(&output);
    if needs_zoom_capture_probe(&applications) {
        match probe("/usr/bin/pgrep", &["-i", "-x", "CptHost"], Some(1)) {
            Some(text) if text.trim().is_empty() => {}
            Some(text) if text.lines().all(|line| line.parse::<u32>().is_ok()) => {
                applications.push("Zoom".into());
            }
            _ if applications.is_empty() => {
                return MeetingStatus {
                    capture_supported: true,
                    ..MeetingStatus::inactive(false)
                }
            }
            // An already identified call remains positive if the Zoom fallback fails.
            _ => {}
        }
    }
    let mut status = MeetingStatus::detected(applications, true);
    status.capture_supported = true;
    status.capture_active = match unsafe { blincho_capture_active() } {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    status
}

#[cfg(test)]
mod meeting_tests {
    use super::*;

    #[test]
    fn failed_zoom_fallback_cannot_grant_a_negative_camera_preflight() {
        for output in [None, Some("malformed process output".to_string())] {
            let status = meeting_status_with_probes(|program, _, _| {
                if program == "/usr/bin/pmset" {
                    Some(String::new())
                } else {
                    output.clone()
                }
            });
            assert!(!status.supported);
            assert!(!status.in_meeting);
        }
    }

    #[test]
    fn zoom_fallback_accepts_normal_no_match_and_positive_process_output() {
        for (output, active) in [("", false), ("123\n", true)] {
            let status = meeting_status_with_probes(|program, _, no_match| {
                if program == "/usr/bin/pmset" {
                    assert_eq!(no_match, None);
                    Some(String::new())
                } else {
                    assert_eq!(no_match, Some(1));
                    Some(output.into())
                }
            });
            assert!(status.supported);
            assert_eq!(status.in_meeting, active);
        }
    }
}

#[cfg(test)]
mod probe_positive_tests {
    use super::*;

    #[test]
    fn a_positive_call_survives_an_unavailable_zoom_fallback() {
        let status = meeting_status_with_probes(|program, _, _| {
            if program == "/usr/bin/pmset" {
                Some("PreventUserIdleDisplaySleep 1\npid 50(Microsoft Teams): [0x1] 00:00:01 PreventUserIdleDisplaySleep named: \"active meeting\"".into())
            } else {
                None
            }
        });
        assert!(status.supported);
        assert!(status.in_meeting);
        assert_eq!(status.applications, ["Microsoft Teams"]);
    }
}
