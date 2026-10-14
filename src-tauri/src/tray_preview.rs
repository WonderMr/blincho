use crate::{timer::Snapshot, Runtime};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{tray::TrayIconEvent, Emitter, Manager};

pub const LABEL: &str = "tray-preview";
const WIDTH: f64 = 308.;
const HEIGHT: f64 = 198.;

/// Localized display data comes from the one main renderer that owns statistics.
/// The preview never imports history, writes settings or configures the timer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    date: String,
    focus_minutes: f64,
    breaks_completed: u64,
    locale: String,
    title: String,
    next_break_label: String,
    focus_label: String,
    breaks_label: String,
    paused_label: String,
    absent_label: String,
    break_label: String,
    exercise_label: String,
    ready_label: String,
    focus_value: String,
    breaks_value: String,
    today_label: String,
    #[serde(default)]
    theme: String,
    #[serde(default)]
    color_palette: String,
}

impl Summary {
    fn validate(&self) -> Result<(), String> {
        if !self.focus_minutes.is_finite()
            || self.focus_minutes < 0.
            || self.breaks_completed > 1_000_000
            || self.date.len() != 10
            || self.locale.is_empty()
            || self.locale.len() > 32
        {
            return Err("Invalid tray summary".into());
        }
        for value in [
            &self.date,
            &self.locale,
            &self.title,
            &self.next_break_label,
            &self.focus_label,
            &self.breaks_label,
            &self.paused_label,
            &self.absent_label,
            &self.break_label,
            &self.exercise_label,
            &self.ready_label,
            &self.focus_value,
            &self.breaks_value,
            &self.today_label,
            &self.theme,
            &self.color_palette,
        ] {
            if value.len() > 512 || value.contains('\0') {
                return Err("Invalid tray summary text".into());
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Preview {
    summary: Mutex<Option<Summary>>,
    tooltip: Mutex<String>,
    clicked: AtomicBool,
    #[cfg(target_os = "linux")]
    menu_rows: Mutex<Vec<tauri::menu::MenuItem<tauri::Wry>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    timer: Snapshot,
    summary: Option<Summary>,
}

pub fn allowed_command(command: &str) -> bool {
    command == "tray_preview_state"
}

#[tauri::command]
pub fn tray_preview_state(app: tauri::AppHandle) -> Result<PreviewState, String> {
    // Clone the authoritative timer without sampling or starting another clock.
    let timer = app
        .state::<Runtime>()
        .timer
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot
        .clone();
    let summary = app
        .state::<Preview>()
        .summary
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(PreviewState { timer, summary })
}

#[tauri::command]
pub fn tray_preview_summary(summary: Summary, app: tauri::AppHandle) -> Result<(), String> {
    summary.validate()?;
    *app.state::<Preview>()
        .summary
        .lock()
        .map_err(|e| e.to_string())? = Some(summary.clone());
    app.emit_to(LABEL, "tray-preview-summary", summary)
        .map_err(|e| e.to_string())
}

/// The Linux backend has neither hover events nor tooltips. Disabled menu rows
/// keep the same live summary available on desktops using that backend.
pub fn append_menu_summary(
    _app: &tauri::AppHandle,
    _menu: &tauri::menu::Menu<tauri::Wry>,
) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use tauri::menu::{MenuItem, PredefinedMenuItem};
        _menu.append(&PredefinedMenuItem::separator(_app)?)?;
        let mut rows = Vec::new();
        for id in ["preview-next", "preview-focus", "preview-breaks"] {
            let row = MenuItem::with_id(_app, id, "Blincho", false, None::<&str>)?;
            _menu.append(&row)?;
            rows.push(row);
        }
        *_app.state::<Preview>().menu_rows.lock().unwrap() = rows;
    }
    Ok(())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    if cfg!(target_os = "linux") {
        return Ok(());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?tray-preview=1".into()),
    )
    .title("Blincho")
    .inner_size(WIDTH, HEIGHT)
    .visible(false)
    .focused(false)
    .focusable(false)
    .decorations(false)
    .resizable(false)
    .closable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(true)
    .on_navigation(|url| {
        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost"))
    });
    if let Some(path) = &app.state::<Runtime>().test_dir {
        #[cfg(target_os = "macos")]
        {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            path.hash(&mut hash);
            let value = hash.finish();
            let mut identifier = [0_u8; 16];
            identifier[..8].copy_from_slice(&value.to_le_bytes());
            identifier[8..].copy_from_slice(&value.to_be_bytes());
            builder = builder.data_store_identifier(identifier);
        }
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.data_directory(path.join("webview"));
        }
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    unsafe {
        macos::exclude_from_window_menu(window.ns_window().map_err(|e| e.to_string())?);
    }
    Ok(())
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

pub fn diagnostics(app: &tauri::AppHandle) -> serde_json::Value {
    let window = app.get_webview_window(LABEL);
    #[cfg(target_os = "macos")]
    let native = macos::diagnostics(window.as_ref());
    #[cfg(not(target_os = "macos"))]
    let native = serde_json::Value::Null;
    #[cfg(target_os = "macos")]
    let dock_visible = crate::ui::dock_is_visible(app).ok();
    #[cfg(not(target_os = "macos"))]
    let dock_visible: Option<bool> = None;
    #[cfg(target_os = "linux")]
    let fallback_rows: Vec<String> = app
        .state::<Preview>()
        .menu_rows
        .lock()
        .ok()
        .map(|rows| rows.iter().filter_map(|row| row.text().ok()).collect())
        .unwrap_or_default();
    #[cfg(not(target_os = "linux"))]
    let fallback_rows: Vec<String> = Vec::new();
    serde_json::json!({
        "visible": window.as_ref().and_then(|w| w.is_visible().ok()),
        "focused": window.as_ref().and_then(|w| w.is_focused().ok()),
        "position": window.as_ref().and_then(|w| w.outer_position().ok()),
        "size": window.as_ref().and_then(|w| w.outer_size().ok()),
        "summary": app.state::<Preview>().summary.lock().ok().and_then(|s| s.clone()),
        "native": native,
        "dockVisible": dock_visible,
        "fallbackRows": fallback_rows,
    })
}

/// Called exclusively through the existing explicitly isolated smoke interface.
pub fn test_event(app: &tauri::AppHandle, kind: &str, rect: tauri::Rect) -> Result<(), String> {
    if app.state::<Runtime>().test_dir.is_none() {
        return Err("Preview test requires isolated profile".into());
    }
    let id = "blincho".into();
    let position = rect.position.to_physical::<f64>(1.);
    let event = match kind {
        "enter" => TrayIconEvent::Enter { id, position, rect },
        "move" => TrayIconEvent::Move { id, position, rect },
        "leave" => TrayIconEvent::Leave { id, position, rect },
        "click" => TrayIconEvent::Click {
            id,
            position,
            rect,
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Down,
        },
        _ => return Err("Invalid preview event".into()),
    };
    on_tray_event(app, event);
    Ok(())
}

pub fn on_tray_event(app: &tauri::AppHandle, event: TrayIconEvent) {
    let state = app.state::<Preview>();
    match event {
        TrayIconEvent::Enter { rect, .. } => {
            state.clicked.store(false, Ordering::SeqCst);
            if let Err(error) = show(app, rect) {
                eprintln!("Tray preview: {error}");
            }
        }
        TrayIconEvent::Move { rect, .. } if !state.clicked.load(Ordering::SeqCst) => {
            if let Err(error) = show(app, rect) {
                eprintln!("Tray preview: {error}");
            }
        }
        TrayIconEvent::Leave { .. } => {
            state.clicked.store(false, Ordering::SeqCst);
            hide(app);
        }
        TrayIconEvent::Click { .. } | TrayIconEvent::DoubleClick { .. } => {
            state.clicked.store(true, Ordering::SeqCst);
            hide(app);
        }
        _ => {}
    }
}

fn show(app: &tauri::AppHandle, rect: tauri::Rect) -> Result<(), String> {
    if app
        .state::<Runtime>()
        .timer
        .lock()
        .map_err(|e| e.to_string())?
        .strict()
    {
        hide(app);
        return Ok(());
    }
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let monitor = macos::cursor().and_then(|cursor| nearest_monitor(&monitors, cursor));
    #[cfg(not(target_os = "macos"))]
    let monitor = {
        let point = rect.position.to_physical::<f64>(1.);
        app.monitor_from_point(point.x, point.y)
            .map_err(|e| e.to_string())?
    };
    let Some(monitor) = monitor.or_else(|| monitors.first().cloned()) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let anchor = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let area = monitor.work_area();
    let position = popup_position(
        (anchor.x, anchor.y, icon_size.width, icon_size.height),
        (
            area.position.x as f64,
            area.position.y as f64,
            area.size.width as f64,
            area.size.height as f64,
        ),
        scale,
    );
    #[cfg(target_os = "macos")]
    {
        window
            .set_position(tauri::LogicalPosition::new(
                position.0 / scale,
                position.1 / scale,
            ))
            .map_err(|e| e.to_string())?;
        // Tao's show() calls makeKeyAndOrderFront. AppKit's ordering operation
        // displays this nonfocusable window without activating Blincho.
        unsafe {
            macos::show_without_activation(window.ns_window().map_err(|e| e.to_string())?);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_position(tauri::PhysicalPosition::new(
                position.0.round() as i32,
                position.1.round() as i32,
            ))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn popup_position(
    icon: (f64, f64, f64, f64),
    area: (f64, f64, f64, f64),
    scale: f64,
) -> (f64, f64) {
    let (left, top, width, height) = area;
    let gap = 8. * scale;
    let popup_width = WIDTH * scale;
    let popup_height = HEIGHT * scale;
    let max_x = (left + width - popup_width - gap).max(left + gap);
    let max_y = (top + height - popup_height - gap).max(top + gap);
    let x = (icon.0 + icon.2 / 2. - popup_width / 2.).clamp(left + gap, max_x);
    let below = icon.1 + icon.3 + gap;
    let y = if below + popup_height <= top + height - gap {
        below
    } else {
        icon.1 - popup_height - gap
    };
    (x, y.clamp(top + gap, max_y))
}

#[cfg(target_os = "macos")]
fn nearest_monitor(monitors: &[tauri::Monitor], cursor: (f64, f64)) -> Option<tauri::Monitor> {
    monitors
        .iter()
        .min_by(|a, b| {
            let distance = |monitor: &tauri::Monitor| {
                let scale = monitor.scale_factor();
                let area = monitor.work_area();
                let x = area.position.x as f64 / scale;
                let y = area.position.y as f64 / scale;
                let right = x + area.size.width as f64 / scale;
                let bottom = y + area.size.height as f64 / scale;
                (cursor.0 - cursor.0.clamp(x, right)).powi(2)
                    + (cursor.1 - cursor.1.clamp(y, bottom)).powi(2)
            };
            distance(a).total_cmp(&distance(b))
        })
        .cloned()
}

fn countdown(snapshot: &Snapshot) -> String {
    let remaining = if snapshot.break_active {
        snapshot
            .break_end_at
            .map_or(snapshot.remaining_ms, |deadline| {
                (deadline - chrono::Utc::now().timestamp_millis()) as f64
            })
    } else {
        snapshot.remaining_ms
    };
    let seconds = (remaining.max(0.) / 1000.).ceil() as u64;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn timer_label<'a>(summary: &'a Summary, snapshot: &Snapshot) -> &'a str {
    if snapshot.exercising {
        &summary.exercise_label
    } else if snapshot.break_active {
        &summary.break_label
    } else if snapshot.manual_paused {
        &summary.paused_label
    } else if !snapshot.reasons.is_empty() {
        &summary.absent_label
    } else if snapshot.expiry_pending {
        &summary.ready_label
    } else {
        &summary.next_break_label
    }
}

pub fn update(app: &tauri::AppHandle, snapshot: &Snapshot, strict: bool) {
    if strict {
        hide(app);
    }
    let state = app.state::<Preview>();
    let Some(summary) = state.summary.lock().ok().and_then(|s| s.clone()) else {
        return;
    };
    let rows = [
        format!(
            "{}: {}",
            timer_label(&summary, snapshot),
            countdown(snapshot)
        ),
        format!("{}: {}", summary.focus_label, summary.focus_value),
        format!("{}: {}", summary.breaks_label, summary.breaks_value),
    ];
    let tooltip = format!("{}\n{}\n{}\n{}", summary.title, rows[0], rows[1], rows[2]);
    let Ok(mut previous) = state.tooltip.lock() else {
        return;
    };
    if *previous == tooltip {
        return;
    }
    *previous = tooltip.clone();
    #[cfg(target_os = "linux")]
    if let Ok(items) = state.menu_rows.lock() {
        for (item, text) in items.iter().zip(&rows) {
            let _ = item.set_text(text);
        }
    };
    #[cfg(not(target_os = "linux"))]
    if let Some(tray) = app.tray_by_id("blincho") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void};
    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> Point;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: *const c_void);
    }

    pub unsafe fn show_without_activation(window: *mut c_void) {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        send(window, sel_registerName(c"orderFrontRegardless".as_ptr()));
    }
    pub unsafe fn exclude_from_window_menu(window: *mut c_void) {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void, i8) =
            std::mem::transmute(objc_msgSend as *const ());
        send(
            window,
            sel_registerName(c"setExcludedFromWindowsMenu:".as_ptr()),
            1,
        );
    }
    pub fn diagnostics(window: Option<&tauri::WebviewWindow>) -> serde_json::Value {
        unsafe {
            let object: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let number: unsafe extern "C" fn(*mut c_void, *mut c_void) -> isize =
                std::mem::transmute(objc_msgSend as *const ());
            let pid: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32 =
                std::mem::transmute(objc_msgSend as *const ());
            let workspace = object(
                objc_getClass(c"NSWorkspace".as_ptr()),
                sel_registerName(c"sharedWorkspace".as_ptr()),
            );
            let frontmost = object(
                workspace,
                sel_registerName(c"frontmostApplication".as_ptr()),
            );
            let frontmost_pid = pid(frontmost, sel_registerName(c"processIdentifier".as_ptr()));
            let window_number = window
                .and_then(|w| w.ns_window().ok())
                .map(|w| number(w, sel_registerName(c"windowNumber".as_ptr())));
            serde_json::json!({ "frontmostPid": frontmost_pid, "windowNumber": window_number })
        }
    }
    pub fn cursor() -> Option<(f64, f64)> {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() {
                return None;
            }
            let point = CGEventGetLocation(event);
            CFRelease(event);
            Some((point.x, point.y))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_stays_in_work_area_at_edges_and_scaled_negative_monitors() {
        assert_eq!(
            popup_position((1800., 0., 24., 24.), (0., 24., 1920., 1056.), 1.),
            (1604., 32.)
        );
        assert_eq!(
            popup_position((1800., 1060., 24., 24.), (0., 0., 1920., 1060.), 1.),
            (1604., 854.)
        );
        assert_eq!(
            popup_position((-2400., -40., 48., 48.), (-2560., 8., 2560., 1392.), 2.),
            (-2544., 24.)
        );
    }
    #[test]
    fn preview_invoke_allowlist_never_accepts_timer_or_locale_writes() {
        assert!(allowed_command("tray_preview_state"));
        for command in [
            "configure_timer",
            "tray_preview_summary",
            "set_locale",
            "desktop_command",
            "legacy_history",
            "renderer_report",
        ] {
            assert!(!allowed_command(command));
        }
    }
}
