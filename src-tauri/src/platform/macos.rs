use super::{active_meeting_assertion, bounded_probe, MeetingStatus, Presence};
use std::{
    ffi::{c_void, CString},
    sync::mpsc,
    time::Duration,
};

extern "C" {
    fn blincho_observe_power(callback: extern "C" fn(i32));
    fn blincho_idle_seconds() -> f64;
    fn blincho_session_locked() -> i32;
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
    let assertion = bounded_probe("/usr/bin/pmset", &["-g", "assertions"]);
    let (in_meeting, supported) = match assertion {
        Some(output) if active_meeting_assertion(&output) => (true, true),
        Some(_) => (
            bounded_probe("/usr/bin/pgrep", &["-i", "-x", "CptHost"])
                .is_some_and(|text| text.lines().any(|line| line.parse::<u32>().is_ok())),
            true,
        ),
        None => (false, false),
    };
    MeetingStatus {
        in_meeting,
        supported,
    }
}
