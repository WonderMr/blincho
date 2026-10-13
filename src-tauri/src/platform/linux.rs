use super::{bounded_probe, parsing, MeetingStatus, Presence};
use std::{
    collections::{HashMap, HashSet},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use x11_dl::{xlib, xss};
use zbus::{
    blocking::{connection::Builder, proxy::SignalIterator, Connection, Proxy},
    zvariant::{OwnedObjectPath, OwnedValue},
};

const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const LOGIN_MANAGER: &str = "org.freedesktop.login1.Manager";
const LOGIN_PATH: &str = "/org/freedesktop/login1";
const NOTIFICATIONS: &str = "org.freedesktop.Notifications";
const NOTIFICATIONS_PATH: &str = "/org/freedesktop/Notifications";
static POWER_CALLBACK: OnceLock<extern "C" fn(i32)> = OnceLock::new();
static CLICKED: OnceLock<extern "C" fn()> = OnceLock::new();
static PRESENCE: OnceLock<Arc<Mutex<Option<(Instant, Presence)>>>> = OnceLock::new();
static NOTIFICATION_SERVICE: Mutex<Option<NotificationService>> = Mutex::new(None);

fn session_bus() -> zbus::Result<Connection> {
    Builder::session()?
        .method_timeout(Duration::from_millis(500))
        .build()
}
fn system_bus() -> zbus::Result<Connection> {
    Builder::system()?
        .method_timeout(Duration::from_millis(500))
        .build()
}
pub fn presence() -> Presence {
    let state = PRESENCE.get_or_init(|| {
        let state = Arc::new(Mutex::new(None));
        let worker = Arc::clone(&state);
        let _ = std::thread::Builder::new()
            .name("native-presence".into())
            .spawn(move || presence_worker(worker));
        state
    });
    state
        .lock()
        .ok()
        .and_then(|state| *state)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(3))
        .map(|(_, value)| value)
        .unwrap_or_default()
}
fn presence_worker(state: Arc<Mutex<Option<(Instant, Presence)>>>) {
    let mut session = None;
    let mut system = None;
    let mut previous_lock = None;
    let mut x11 = X11Idle::new();
    loop {
        if session.is_none() {
            session = session_bus().ok();
        }
        if system.is_none() {
            system = system_bus().ok();
        }
        let idle_seconds = session
            .as_ref()
            .and_then(desktop_idle)
            .or_else(|| x11.as_mut().and_then(X11Idle::seconds));
        let locked = system
            .as_ref()
            .and_then(logind_locked)
            .or_else(|| session.as_ref().and_then(screensaver_active));
        if let Some(locked) = locked {
            if previous_lock != Some(locked) {
                if let Some(callback) = POWER_CALLBACK.get() {
                    callback(if locked { 3 } else { 4 });
                }
                previous_lock = Some(locked);
            }
        }
        if let Ok(mut state) = state.lock() {
            *state = Some((
                Instant::now(),
                Presence {
                    idle_seconds,
                    locked,
                },
            ));
        }
        if idle_seconds.is_none() {
            session = None;
        }
        if locked.is_none() {
            system = None;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
fn desktop_idle(connection: &Connection) -> Option<f64> {
    let mutter = Proxy::new(
        connection,
        "org.gnome.Mutter.IdleMonitor",
        "/org/gnome/Mutter/IdleMonitor/Core",
        "org.gnome.Mutter.IdleMonitor",
    )
    .ok()?;
    if let Ok(milliseconds) = mutter.call::<_, _, u64>("GetIdletime", &()) {
        return Some(milliseconds as f64 / 1000.);
    }
    // Some desktops expose this extension. Unsupported methods stay unknown.
    for (service, path, interface) in [
        (
            "org.freedesktop.ScreenSaver",
            "/ScreenSaver",
            "org.freedesktop.ScreenSaver",
        ),
        (
            "org.kde.screensaver",
            "/ScreenSaver",
            "org.freedesktop.ScreenSaver",
        ),
        (
            "org.gnome.ScreenSaver",
            "/org/gnome/ScreenSaver",
            "org.gnome.ScreenSaver",
        ),
    ] {
        if let Ok(proxy) = Proxy::new(connection, service, path, interface) {
            if let Ok(seconds) = proxy.call::<_, _, u32>("GetSessionIdleTime", &()) {
                return Some(f64::from(seconds));
            }
        }
    }
    None
}
fn session_path(connection: &Connection) -> Option<OwnedObjectPath> {
    let manager = Proxy::new(connection, LOGIN_SERVICE, LOGIN_PATH, LOGIN_MANAGER).ok()?;
    manager
        .call("GetSessionByPID", &(std::process::id(),))
        .ok()
        .or_else(|| {
            let session_id = std::env::var("XDG_SESSION_ID").ok()?;
            manager.call("GetSession", &(session_id,)).ok()
        })
}
fn logind_locked(connection: &Connection) -> Option<bool> {
    let path = session_path(connection)?;
    // Read fresh properties; never infer an unlocked session from a failed D-Bus call.
    let properties = Proxy::new(
        connection,
        LOGIN_SERVICE,
        path.as_str(),
        "org.freedesktop.DBus.Properties",
    )
    .ok()?;
    let values: HashMap<String, OwnedValue> = properties
        .call("GetAll", &("org.freedesktop.login1.Session",))
        .ok()?;
    let locked = values
        .get("LockedHint")
        .and_then(|value| bool::try_from(value).ok());
    let active = values
        .get("Active")
        .and_then(|value| bool::try_from(value).ok());
    parsing::session_locked_hint(locked, active)
}
fn screensaver_active(connection: &Connection) -> Option<bool> {
    for (service, path, interface) in [
        (
            "org.freedesktop.ScreenSaver",
            "/ScreenSaver",
            "org.freedesktop.ScreenSaver",
        ),
        (
            "org.gnome.ScreenSaver",
            "/org/gnome/ScreenSaver",
            "org.gnome.ScreenSaver",
        ),
    ] {
        if let Ok(proxy) = Proxy::new(connection, service, path, interface) {
            if let Ok(active) = proxy.call::<_, _, bool>("GetActive", &()) {
                return Some(active);
            }
        }
    }
    None
}

// XWayland sees only X11 client input, so it must never confirm desktop presence.
struct X11Idle {
    xlib: xlib::Xlib,
    xss: xss::Xss,
    display: *mut xlib::Display,
}
impl X11Idle {
    fn new() -> Option<Self> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland")
        {
            return None;
        }
        let xlib = xlib::Xlib::open().ok()?;
        let xss = xss::Xss::open().ok()?;
        let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
        if display.is_null() {
            return None;
        }
        Some(Self { xlib, xss, display })
    }
    fn seconds(&mut self) -> Option<f64> {
        let mut event = 0;
        let mut error = 0;
        if unsafe { (self.xss.XScreenSaverQueryExtension)(self.display, &mut event, &mut error) }
            == 0
        {
            return None;
        }
        let info = unsafe { (self.xss.XScreenSaverAllocInfo)() };
        if info.is_null() {
            return None;
        }
        let root = unsafe { (self.xlib.XDefaultRootWindow)(self.display) };
        let success = unsafe { (self.xss.XScreenSaverQueryInfo)(self.display, root, info) } != 0;
        let milliseconds = unsafe { (*info).idle };
        unsafe {
            (self.xlib.XFree)(info.cast());
        }
        success.then_some(milliseconds as f64 / 1000.)
    }
}
impl Drop for X11Idle {
    fn drop(&mut self) {
        unsafe {
            (self.xlib.XCloseDisplay)(self.display);
        }
    }
}

fn sleep_signals() -> Result<SignalIterator<'static>, String> {
    let connection = system_bus().map_err(|error| error.to_string())?;
    let proxy = Proxy::new(&connection, LOGIN_SERVICE, LOGIN_PATH, LOGIN_MANAGER)
        .map_err(|error| error.to_string())?;
    // A successful subscription alone doesn't prove logind exists.
    let _: Vec<(String, u32, String, String, OwnedObjectPath)> = proxy
        .call("ListSessions", &())
        .map_err(|error| error.to_string())?;
    proxy
        .receive_signal("PrepareForSleep")
        .map_err(|error| error.to_string())
}
pub fn observe_power(callback: extern "C" fn(i32)) -> Result<(), String> {
    if POWER_CALLBACK.set(callback).is_err() {
        return Ok(());
    }
    let initial = sleep_signals();
    let error = initial.as_ref().err().cloned();
    std::thread::Builder::new()
        .name("native-power".into())
        .spawn(move || {
            let mut signals = initial.ok();
            loop {
                if let Some(stream) = signals.take() {
                    for signal in stream {
                        if let Ok((sleeping,)) = signal.body().deserialize::<(bool,)>() {
                            callback(if sleeping { 1 } else { 2 });
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(2));
                signals = sleep_signals().ok();
            }
        })
        .map_err(|error| error.to_string())?;
    let _ = presence();
    if let Some(error) = error {
        Err(error)
    } else {
        Ok(())
    }
}
pub fn power_source() -> &'static str {
    "systemd-logind/desktop session"
}

struct NotificationService {
    connection: Connection,
    ids: Arc<Mutex<HashSet<u32>>>,
    markup: bool,
}
pub fn notifications_initialize(clicked: extern "C" fn()) {
    let _ = CLICKED.set(clicked);
}
fn notifications() -> Result<std::sync::MutexGuard<'static, Option<NotificationService>>, String> {
    let mut state = NOTIFICATION_SERVICE
        .lock()
        .map_err(|error| error.to_string())?;
    if state.is_none() {
        let connection = session_bus().map_err(|error| error.to_string())?;
        let proxy = Proxy::new(
            &connection,
            NOTIFICATIONS,
            NOTIFICATIONS_PATH,
            NOTIFICATIONS,
        )
        .map_err(|error| error.to_string())?;
        let capabilities: Vec<String> = proxy
            .call("GetCapabilities", &())
            .map_err(|error| error.to_string())?;
        let signals = proxy
            .receive_all_signals()
            .map_err(|error| error.to_string())?;
        let ids = Arc::new(Mutex::new(HashSet::new()));
        let tracked = Arc::clone(&ids);
        std::thread::Builder::new()
            .name("notification-actions".into())
            .spawn(move || {
                for signal in signals {
                    match signal.header().member().map(|member| member.as_str()) {
                        Some("ActionInvoked") => {
                            if let Ok((id, action)) = signal.body().deserialize::<(u32, String)>() {
                                let known =
                                    tracked.lock().map(|ids| ids.contains(&id)).unwrap_or(false);
                                if known && action == "default" {
                                    if let Some(clicked) = CLICKED.get() {
                                        clicked();
                                    }
                                }
                            }
                        }
                        Some("NotificationClosed") => {
                            if let Ok((id, _)) = signal.body().deserialize::<(u32, u32)>() {
                                if let Ok(mut ids) = tracked.lock() {
                                    ids.remove(&id);
                                }
                            }
                        }
                        _ => (),
                    }
                }
                if let Ok(mut state) = NOTIFICATION_SERVICE.lock() {
                    *state = None;
                }
            })
            .map_err(|error| error.to_string())?;
        *state = Some(NotificationService {
            connection,
            ids,
            markup: capabilities
                .iter()
                .any(|capability| capability == "body-markup"),
        });
    }
    Ok(state)
}
pub async fn notification_permission(_app: &tauri::AppHandle) -> Result<bool, String> {
    // This protocol has no permission prompt. A live notification service is the
    // available capability; desktop do-not-disturb remains controlled by the OS.
    tauri::async_runtime::spawn_blocking(|| notifications().is_ok())
        .await
        .map_err(|error| error.to_string())
}
pub async fn notification_send(
    _app: &tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = notifications()?;
        let service = state.as_ref().ok_or("Notification service unavailable")?;
        let proxy = Proxy::new(
            &service.connection,
            NOTIFICATIONS,
            NOTIFICATIONS_PATH,
            NOTIFICATIONS,
        )
        .map_err(|error| error.to_string())?;
        let mut ids = service.ids.lock().map_err(|error| error.to_string())?;
        let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
        let escaped_body = if service.markup {
            body.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        } else {
            body
        };
        let id: u32 = proxy
            .call(
                "Notify",
                &(
                    "Blincho",
                    0u32,
                    "",
                    title,
                    escaped_body,
                    ["default", ""],
                    hints,
                    -1i32,
                ),
            )
            .map_err(|error| error.to_string())?;
        if id == 0 {
            return Err("Notification delivery failed".into());
        }
        ids.insert(id);
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}
pub fn preferred_languages() -> Vec<String> {
    let mut values = Vec::new();
    if let Ok(language) = std::env::var("LANGUAGE") {
        values.extend(language.split(':').map(String::from));
    }
    // LC_ALL overrides the individual locale category and LANG.
    if let Some(locale) = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
    {
        values.push(locale);
    }
    parsing::normalize_languages(values)
}
pub fn open_external(url: &str) -> Result<(), String> {
    let mut child = Command::new("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => return Err("Could not open external link".into()),
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("External link opener timed out".into());
            }
        }
    }
}
pub fn meeting_status() -> MeetingStatus {
    let status =
        bounded_probe("pactl", &["--format=json", "list", "source-outputs"]).and_then(|outputs| {
            bounded_probe("pactl", &["--format=json", "list", "sources"])
                .and_then(|sources| parsing::pulse_meeting_status(&outputs, &sources))
        });
    MeetingStatus {
        in_meeting: status.unwrap_or(false),
        supported: status.is_some(),
    }
}
pub fn meeting_supported() -> bool {
    meeting_status().supported
}
