use crate::{timer::Snapshot, Runtime};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{tray::TrayIconEvent, Emitter, Manager};

mod call_icon;

pub const LABEL: &str = "tray-preview";
const WIDTH: f64 = 308.;
const HEIGHT: f64 = 232.;

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
    #[serde(default = "default_meeting_label")]
    meeting_label: String,
    #[serde(default = "default_meeting_inactive_label")]
    meeting_inactive_label: String,
    #[serde(default = "default_meeting_unknown_label")]
    meeting_unknown_label: String,
    #[serde(default = "default_meeting_disabled_label")]
    meeting_disabled_label: String,
    #[serde(default = "default_unknown_meeting_app_label")]
    unknown_meeting_app_label: String,
    #[serde(default)]
    theme: String,
    #[serde(default)]
    color_palette: String,
    #[serde(default)]
    symbiote_mask: u8,
    #[serde(default)]
    build_name: String,
}

fn default_meeting_label() -> String {
    "Call".into()
}

fn default_meeting_inactive_label() -> String {
    "No active call".into()
}

fn default_meeting_unknown_label() -> String {
    "Call status unavailable".into()
}

fn default_meeting_disabled_label() -> String {
    "Call detection disabled".into()
}

fn default_unknown_meeting_app_label() -> String {
    "Unknown app".into()
}

impl Summary {
    fn validate(&self) -> Result<(), String> {
        if !self.focus_minutes.is_finite()
            || self.focus_minutes < 0.
            || self.breaks_completed > 1_000_000
            || self.date.len() != 10
            || self.locale.is_empty()
            || self.locale.len() > 32
            || self.symbiote_mask > 63
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
            &self.meeting_label,
            &self.meeting_inactive_label,
            &self.meeting_unknown_label,
            &self.meeting_disabled_label,
            &self.unknown_meeting_app_label,
            &self.theme,
            &self.color_palette,
            &self.build_name,
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
    tooltip: Mutex<SummaryTooltip>,
    native_tooltip: Mutex<NativeTooltip>,
    call_indicator: Mutex<CallIndicator>,
    clicked: AtomicBool,
    #[cfg(target_os = "linux")]
    menu_rows: Mutex<Vec<tauri::menu::MenuItem<tauri::Wry>>>,
}

#[derive(Default)]
struct SummaryTooltip {
    text: String,
    preview_available: bool,
}

#[derive(Clone, Default)]
struct NativeTooltip {
    applied: bool,
    text: Option<String>,
    error: Option<String>,
}

pub fn set_tooltip(app: &tauri::AppHandle, text: &str) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("blincho") else {
        return Ok(());
    };
    // A custom hover window replaces the OS tooltip. Keep the text fallback
    // when that window could not be created or is no longer available.
    let (camera_active, camera_label) = crate::camera_activity::current(app);
    let camera_tooltip = format!("Blincho\n{camera_label}");
    let tooltip = if camera_active {
        Some(camera_tooltip.as_str())
    } else {
        app.get_webview_window(LABEL).is_none().then_some(text)
    };
    // Native tray setters dispatch to the UI thread, so lock only afterwards.
    let result = tray.set_tooltip(tooltip).map_err(|error| error.to_string());
    let state = app.state::<Preview>();
    let mut native = state
        .native_tooltip
        .lock()
        .map_err(|error| error.to_string())?;
    match result {
        Ok(()) => {
            native.applied = true;
            native.text = tooltip.map(str::to_owned);
            native.error = None;
            Ok(())
        }
        Err(error) => {
            native.error = Some(error.clone());
            Err(error)
        }
    }
}

#[derive(Default)]
struct CallIndicator {
    active: bool,
    camera: bool,
    camera_activations: u64,
    camera_restores: u64,
    mask: u8,
    applied_mask: u8,
    updates: u64,
    attempts: u64,
    applying: bool,
    retry: Option<((u8, bool, bool), Instant)>,
    last_error: Option<String>,
    images: Option<(u8, [tauri::image::Image<'static>; 4])>,
}

impl CallIndicator {
    fn needs_update(&self, active: bool, camera: bool) -> bool {
        self.needs_update_at(active, camera, Instant::now())
    }

    fn needs_update_at(&self, active: bool, camera: bool, now: Instant) -> bool {
        (self.active != active || self.camera != camera || self.applied_mask != self.mask)
            && !self.applying
            && self.retry.as_ref().is_none_or(|(wanted, deadline)| {
                *wanted != (self.mask, active, camera) || now >= *deadline
            })
    }

    fn failed(&mut self, mask: u8, active: bool, camera: bool, now: Instant, error: String) {
        self.applying = false;
        self.retry = Some(((mask, active, camera), now + Duration::from_secs(3)));
        self.last_error = Some(error);
    }

    fn clear_obsolete_error(&mut self, active: bool, camera: bool) {
        if self.active == active && self.camera == camera && self.applied_mask == self.mask {
            self.retry = None;
            self.last_error = None;
        }
    }

    fn applied(&mut self, mask: u8, active: bool, camera: bool) {
        self.active = active;
        if self.camera != camera {
            if camera {
                self.camera_activations += 1;
            } else {
                self.camera_restores += 1;
            }
        }
        self.camera = camera;
        self.applied_mask = mask;
        self.updates += 1;
        self.applying = false;
        self.retry = None;
        self.last_error = None;
    }

    fn call_error(&self, desired_active: bool) -> Option<&str> {
        // A rejected portrait is separate from a failed call badge. A badge
        // that was applied still requires a successful native restoration.
        let failed_active = self
            .retry
            .as_ref()
            .is_some_and(|((_, active, _), _)| *active);
        if self.active || (desired_active && failed_active) {
            self.last_error.as_deref()
        } else {
            None
        }
    }

    fn image(&mut self, active: bool, camera: bool) -> tauri::Result<tauri::image::Image<'static>> {
        if self
            .images
            .as_ref()
            .is_none_or(|(mask, _)| *mask != self.mask)
        {
            let original = crate::symbiote_icons::image(self.mask)?;
            let calling = call_icon::with_call_badge(&original, false);
            let filming = call_icon::with_camera_badge(&original);
            let both = call_icon::with_camera_badge(&calling);
            self.images = Some((self.mask, [original, calling, filming, both]));
        }
        let (_, images) = self.images.as_ref().unwrap();
        Ok(images[usize::from(active) + 2 * usize::from(camera)].clone())
    }
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
        for id in [
            "preview-next",
            "preview-call",
            "preview-focus",
            "preview-breaks",
        ] {
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
    // An unavailable notification area must not invalidate a working hover
    // window. The setter retains the native error for diagnostics and tests.
    if let Err(error) = set_tooltip(app, "Blincho") {
        eprintln!("Tray tooltip: {error}");
    }
    Ok(())
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

pub fn diagnostics(app: &tauri::AppHandle) -> serde_json::Value {
    let desired_active = app
        .state::<Runtime>()
        .timer
        .lock()
        .map(|timer| call_active(&timer.snapshot))
        .unwrap_or(false);
    let state = app.state::<Preview>();
    let native_tooltip = state
        .native_tooltip
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let (
        indicator_active,
        indicator_updates,
        indicator_attempts,
        indicator_error,
        icon_error,
        requested_mask,
        applied_mask,
    ) = state
        .call_indicator
        .lock()
        .map(|indicator| {
            (
                Some(indicator.active),
                Some(indicator.updates),
                Some(indicator.attempts),
                indicator.call_error(desired_active).map(str::to_owned),
                indicator.last_error.clone(),
                Some(indicator.mask),
                Some(indicator.applied_mask),
            )
        })
        .unwrap_or_default();
    let call_status = state
        .summary
        .lock()
        .ok()
        .and_then(|summary| summary.clone())
        .and_then(|summary| {
            app.state::<Runtime>()
                .timer
                .lock()
                .ok()
                .map(|timer| meeting_label(&summary, &timer.snapshot))
        });
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
        .map(|rows| rows.clone())
        .unwrap_or_default()
        .iter()
        .filter_map(|row| row.text().ok())
        .collect();
    #[cfg(not(target_os = "linux"))]
    let fallback_rows: Vec<String> = Vec::new();
    serde_json::json!({
        "visible": window.as_ref().and_then(|w| w.is_visible().ok()),
        "focused": window.as_ref().and_then(|w| w.is_focused().ok()),
        "position": window.as_ref().and_then(|w| w.outer_position().ok()),
        "size": window.as_ref().and_then(|w| w.outer_size().ok()),
        "innerSize": window.as_ref().and_then(|w| w.inner_size().ok()),
        "scaleFactor": window.as_ref().and_then(|w| w.scale_factor().ok()),
        "summary": app.state::<Preview>().summary.lock().ok().and_then(|s| s.clone()),
        "native": native,
        "dockVisible": dock_visible,
        "fallbackRows": fallback_rows,
        "callIndicatorActive": indicator_active,
        "cameraRequestedActive": crate::camera_activity::current(app).0,
        "cameraIndicatorActive": state.call_indicator.lock().ok().map(|indicator| indicator.camera),
        "cameraIndicatorActivations": state.call_indicator.lock().ok().map(|indicator| indicator.camera_activations),
        "cameraIndicatorRestores": state.call_indicator.lock().ok().map(|indicator| indicator.camera_restores),
        "requestedBuildMask": requested_mask, "appliedBuildMask": applied_mask,
        "callIndicatorUpdates": indicator_updates,
        "callIndicatorAttempts": indicator_attempts,
        "callIndicatorError": indicator_error,
        "trayIconError": icon_error,
        "tooltip": state.tooltip.lock().ok().map(|tooltip| tooltip.text.clone()),
        "nativeTooltip": native_tooltip.text,
        "nativeTooltipApplied": native_tooltip.applied,
        "nativeTooltipError": native_tooltip.error,
        "callStatus": call_status,
    })
}

/// Called exclusively through the existing explicitly isolated smoke interface.
pub fn test_event(app: &tauri::AppHandle, kind: &str, rect: tauri::Rect) -> Result<(), String> {
    if app.state::<Runtime>().test_dir.is_none() {
        return Err("Preview test requires isolated profile".into());
    }
    if kind == "destroy" {
        if let Some(window) = app.get_webview_window(LABEL) {
            window.destroy().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if kind == "initialize" {
        return initialize(app);
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

fn call_active(snapshot: &Snapshot) -> bool {
    snapshot.live_meeting_enabled
        && snapshot
            .live_meeting_status
            .as_ref()
            .is_some_and(|status| status.supported && status.in_meeting)
}

fn meeting_label(summary: &Summary, snapshot: &Snapshot) -> String {
    if !snapshot.live_meeting_enabled {
        return summary.meeting_disabled_label.clone();
    }
    let Some(status) = snapshot
        .live_meeting_status
        .as_ref()
        .filter(|status| status.supported)
    else {
        return summary.meeting_unknown_label.clone();
    };
    if !status.in_meeting {
        return summary.meeting_inactive_label.clone();
    }
    let apps: Vec<&str> = status
        .applications
        .iter()
        .map(|app| {
            if app == "unknown" {
                summary.unknown_meeting_app_label.as_str()
            } else {
                app.as_str()
            }
        })
        .filter(|app| !app.trim().is_empty())
        .collect();
    let apps = if apps.is_empty() {
        summary.unknown_meeting_app_label.clone()
    } else {
        apps.join(", ")
    };
    format!("{}: {}", summary.meeting_label, apps)
}

fn update_call_indicator(app: &tauri::AppHandle, snapshot: &Snapshot, state: &Preview) {
    let active = call_active(snapshot);
    let camera = crate::camera_activity::current(app).0;
    let Some(tray) = app.tray_by_id("blincho") else {
        return;
    };
    let (mask, image) = {
        let Ok(mut indicator) = state.call_indicator.lock() else {
            return;
        };
        indicator.clear_obsolete_error(active, camera);
        if !indicator.needs_update(active, camera) {
            return;
        }
        indicator.attempts += 1;
        let mask = indicator.mask;
        match indicator.image(active, camera) {
            Ok(image) => {
                indicator.applying = true;
                (mask, image)
            }
            Err(error) => {
                indicator.failed(mask, active, camera, Instant::now(), error.to_string());
                eprintln!("Tray call indicator: {error}");
                return;
            }
        }
    };
    // Never hold a state mutex while dispatching synchronously to the UI thread.
    // The approved raster remains full-color on every desktop backend.
    let result = tray.set_icon_with_as_template(Some(image), false);
    if let Ok(mut indicator) = state.call_indicator.lock() {
        match result {
            Ok(()) => indicator.applied(mask, active, camera),
            Err(error) => {
                indicator.failed(mask, active, camera, Instant::now(), error.to_string());
                eprintln!("Tray call indicator: {error}");
            }
        }
    }
}

pub fn set_symbiote_mask(app: &tauri::AppHandle, mask: u8) -> Result<(), String> {
    if mask > 63 {
        return Err("Invalid build mask".into());
    }
    let state = app.state::<Preview>();
    state
        .call_indicator
        .lock()
        .map_err(|error| error.to_string())?
        .mask = mask;
    let snapshot = app
        .state::<Runtime>()
        .timer
        .lock()
        .map_err(|error| error.to_string())?
        .snapshot
        .clone();
    update_call_indicator(app, &snapshot, &state);
    Ok(())
}

pub fn update(app: &tauri::AppHandle, snapshot: &Snapshot, strict: bool) {
    if strict {
        hide(app);
    }
    let state = app.state::<Preview>();
    update_call_indicator(app, snapshot, &state);
    let Some(summary) = state.summary.lock().ok().and_then(|s| s.clone()) else {
        return;
    };
    let rows = [
        format!(
            "{}: {}",
            timer_label(&summary, snapshot),
            countdown(snapshot)
        ),
        meeting_label(&summary, snapshot),
        format!("{}: {}", summary.focus_label, summary.focus_value),
        format!("{}: {}", summary.breaks_label, summary.breaks_value),
    ];
    let (camera_active, camera_label) = crate::camera_activity::current(app);
    let tooltip = if camera_active {
        format!("Blincho\n{camera_label}\n{}", rows.join("\n"))
    } else {
        format!("{}\n{}", summary.title, rows.join("\n"))
    };
    let preview_available = app.get_webview_window(LABEL).is_some();
    {
        let Ok(mut previous) = state.tooltip.lock() else {
            return;
        };
        // Window loss and recovery also change the native tooltip policy when
        // a paused timer leaves every summary row unchanged.
        if previous.text == tooltip && previous.preview_available == preview_available {
            return;
        }
        previous.text = tooltip.clone();
        previous.preview_available = preview_available;
    }
    #[cfg(target_os = "linux")]
    if let Ok(items) = state.menu_rows.lock().map(|items| items.clone()) {
        for (item, text) in items.iter().zip(&rows) {
            let _ = item.set_text(text);
        }
    };
    #[cfg(not(target_os = "linux"))]
    if let Err(error) = set_tooltip(app, &tooltip) {
        eprintln!("Tray tooltip: {error}");
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

    fn summary() -> Summary {
        serde_json::from_value(serde_json::json!({
            "date": "2026-10-14", "focusMinutes": 12.0, "breaksCompleted": 2,
            "locale": "ru", "title": "Blincho", "nextBreakLabel": "До перерыва",
            "focusLabel": "Работа", "breaksLabel": "Перерывы", "pausedLabel": "Пауза",
            "absentLabel": "Нет активности", "breakLabel": "Перерыв", "exerciseLabel": "Упражнение",
            "readyLabel": "Пора отдохнуть", "focusValue": "12 мин", "breaksValue": "2",
            "todayLabel": "Сегодня", "meetingLabel": "Звонок", "meetingInactiveLabel": "Нет активного звонка",
            "meetingUnknownLabel": "Статус звонка неизвестен", "meetingDisabledLabel": "Определение звонков выключено",
            "unknownMeetingAppLabel": "Неизвестное приложение"
        })).unwrap()
    }

    #[test]
    fn call_status_uses_live_snapshot_and_translated_labels_in_every_state() {
        let summary = summary();
        let mut snapshot = crate::timer::Timer::new(0).snapshot;
        snapshot.live_meeting_enabled = false;
        snapshot.live_meeting_status = Some(crate::platform::MeetingStatus {
            capture_active: None,
            capture_supported: false,
            in_meeting: true,
            supported: true,
            applications: vec!["Zoom".into()],
        });
        assert!(!call_active(&snapshot));
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Определение звонков выключено"
        );
        snapshot.live_meeting_enabled = true;
        assert!(call_active(&snapshot));
        assert_eq!(meeting_label(&summary, &snapshot), "Звонок: Zoom");
        assert!(snapshot.meeting_spans.is_empty());
        assert!(snapshot.meeting_applications.is_empty());
        snapshot.live_meeting_status.as_mut().unwrap().applications =
            vec!["Zoom".into(), "Microsoft Teams".into()];
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Звонок: Zoom, Microsoft Teams"
        );
        snapshot.live_meeting_status.as_mut().unwrap().applications = vec![" ".into()];
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Звонок: Неизвестное приложение"
        );
        snapshot.live_meeting_status.as_mut().unwrap().applications = vec!["unknown".into()];
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Звонок: Неизвестное приложение"
        );
        snapshot.live_meeting_status.as_mut().unwrap().applications =
            vec!["Zoom".into(), "unknown".into()];
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Звонок: Zoom, Неизвестное приложение"
        );
        snapshot.live_meeting_status = Some(crate::platform::MeetingStatus::inactive(true));
        assert!(!call_active(&snapshot));
        assert_eq!(meeting_label(&summary, &snapshot), "Нет активного звонка");
        snapshot.live_meeting_status = Some(crate::platform::MeetingStatus {
            capture_active: None,
            capture_supported: false,
            in_meeting: true,
            supported: false,
            applications: vec!["Zoom".into()],
        });
        assert!(!call_active(&snapshot));
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Статус звонка неизвестен"
        );
        snapshot.live_meeting_status = None;
        assert!(!call_active(&snapshot));
        assert_eq!(
            meeting_label(&summary, &snapshot),
            "Статус звонка неизвестен"
        );
    }

    #[test]
    fn missing_meeting_labels_remain_backward_compatible_and_new_text_is_validated() {
        let mut value = serde_json::to_value(summary()).unwrap();
        for key in [
            "meetingLabel",
            "meetingInactiveLabel",
            "meetingUnknownLabel",
            "meetingDisabledLabel",
            "unknownMeetingAppLabel",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
        let legacy: Summary = serde_json::from_value(value).unwrap();
        assert_eq!(legacy.meeting_label, "Call");
        assert_eq!(legacy.meeting_inactive_label, "No active call");
        assert_eq!(legacy.meeting_unknown_label, "Call status unavailable");
        assert_eq!(legacy.meeting_disabled_label, "Call detection disabled");
        assert_eq!(legacy.unknown_meeting_app_label, "Unknown app");
        assert!(legacy.validate().is_ok());
        let mut invalid = summary();
        invalid.meeting_label = "a".repeat(513);
        assert!(invalid.validate().is_err());
        invalid.meeting_label = "Call\0status".into();
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn icon_changes_only_on_applied_transitions_and_restores_exact_original() {
        let mut indicator = CallIndicator::default();
        assert!(!indicator.needs_update(false, false));
        assert!(indicator.needs_update(true, false));
        let active = indicator.image(true, false).unwrap();
        // Obtaining an image never marks a failed native apply as successful.
        assert!(indicator.needs_update(true, false));
        assert_eq!(indicator.updates, 0);
        indicator.applying = true;
        assert!(!indicator.needs_update(true, false));
        indicator.applying = false;
        assert!(indicator.needs_update(true, false));
        indicator.applied(0, true, false);
        assert!(!indicator.needs_update(true, false));
        assert_eq!(indicator.updates, 1);
        let original = indicator.image(false, false).unwrap();
        let expected = crate::symbiote_icons::image(0).unwrap();
        assert_ne!(active.rgba(), original.rgba());
        assert_eq!(original.rgba(), expected.rgba());
        assert!(indicator.needs_update(false, false));
        indicator.applied(0, false, false);
        assert!(!indicator.needs_update(false, false));
        assert_eq!(indicator.updates, 2);
    }
    #[test]
    fn camera_and_call_states_compose_and_restore_every_current_portrait() {
        for mask in 0..64 {
            let mut indicator = CallIndicator::default();
            indicator.mask = mask;
            let original = indicator.image(false, false).unwrap();
            let camera = indicator.image(false, true).unwrap();
            let call = indicator.image(true, false).unwrap();
            let both = indicator.image(true, true).unwrap();
            assert_ne!(camera.rgba(), original.rgba());
            assert_ne!(both.rgba(), call.rgba());
            assert_ne!(both.rgba(), camera.rgba());
            indicator.applied(mask, true, true);
            assert!(!indicator.needs_update(true, true));
            assert!(indicator.needs_update(true, false));
            indicator.failed(mask, true, false, Instant::now(), "restore failed".into());
            assert!(indicator.camera);
            indicator.applied(mask, true, false);
            assert_eq!(indicator.image(true, false).unwrap().rgba(), call.rgba());
            indicator.applied(mask, false, true);
            assert_eq!(indicator.image(false, true).unwrap().rgba(), camera.rgba());
            indicator.applied(mask, false, false);
            assert_eq!(
                indicator.image(false, false).unwrap().rgba(),
                crate::symbiote_icons::image(mask).unwrap().rgba()
            );
        }
    }

    #[test]
    fn native_icon_failure_backs_off_without_claiming_success_and_recovers() {
        let now = Instant::now();
        let mut indicator = CallIndicator::default();
        indicator.applying = true;
        indicator.attempts = 1;
        indicator.failed(0, true, false, now, "backend unavailable".into());
        assert!(!indicator.active);
        assert_eq!(indicator.updates, 0);
        assert_eq!(indicator.last_error.as_deref(), Some("backend unavailable"));
        assert!(!indicator.needs_update_at(true, false, now + Duration::from_millis(250)));
        assert!(!indicator.needs_update_at(true, false, now + Duration::from_millis(2999)));
        assert!(indicator.needs_update_at(true, false, now + Duration::from_secs(3)));
        indicator.clear_obsolete_error(false, false);
        assert!(indicator.last_error.is_none());
        assert!(indicator.needs_update_at(true, false, now));
        indicator.applied(0, true, false);
        assert!(indicator.last_error.is_none());
        assert_eq!(indicator.updates, 1);
        indicator.failed(0, false, false, now, "temporary restore failure".into());
        assert!(
            indicator.active,
            "A failed restore cannot be reported as successful"
        );
        assert!(!indicator.needs_update_at(false, false, now + Duration::from_secs(1)));
        indicator.applied(0, false, false);
        assert!(!indicator.active);
        assert!(indicator.last_error.is_none());
        assert_eq!(indicator.updates, 2);
    }

    #[test]
    fn inactive_portrait_rejection_is_not_a_failed_call_restore() {
        let now = Instant::now();
        let mut indicator = CallIndicator::default();
        indicator.mask = 16;
        indicator.attempts = 1;
        indicator.failed(16, false, false, now, "portrait unavailable".into());
        assert!(indicator.call_error(false).is_none());
        assert_eq!(
            indicator.last_error.as_deref(),
            Some("portrait unavailable")
        );
        assert_eq!(indicator.applied_mask, 0);
        assert_eq!(indicator.updates, 0);
        assert_eq!(indicator.attempts, 1);
        assert!(!indicator.needs_update_at(false, false, now + Duration::from_secs(1)));
        assert!(indicator.needs_update_at(true, false, now));
        assert!(
            indicator.call_error(true).is_none(),
            "A portrait failure is not evidence of a failed active-call attempt"
        );
        indicator.attempts += 1;
        indicator.failed(16, true, false, now, "call unavailable".into());
        assert_eq!(indicator.call_error(true), Some("call unavailable"));
        assert!(indicator.call_error(false).is_none());
        indicator.clear_obsolete_error(false, false);
        assert_eq!(indicator.last_error.as_deref(), Some("call unavailable"));
        assert_eq!(indicator.updates, 0);
        assert_eq!(indicator.attempts, 2);
        indicator.applied(16, true, false);
        indicator.mask = 32;
        indicator.failed(32, false, false, now, "restore unavailable".into());
        assert_eq!(indicator.call_error(false), Some("restore unavailable"));
        assert!(
            indicator.active,
            "A failed restore must remain an applied call badge"
        );
        assert_eq!(indicator.applied_mask, 16);
        assert_eq!(indicator.updates, 1);
        indicator.applied(32, false, false);
        assert!(indicator.call_error(false).is_none());
        assert!(indicator.last_error.is_none());
        assert_eq!(indicator.applied_mask, 32);
        assert_eq!(indicator.updates, 2);
    }

    #[test]
    fn build_changes_during_calls_restore_the_latest_portrait_and_retry_identity() {
        let now = Instant::now();
        let mut indicator = CallIndicator::default();
        indicator.applied(0, true, false);
        indicator.mask = 32;
        assert!(indicator.needs_update(true, false));
        let calling = indicator.image(true, false).unwrap();
        let expected = crate::symbiote_icons::image(32).unwrap();
        assert_ne!(calling.rgba(), expected.rgba());
        indicator.applying = true;
        indicator.mask = 63;
        assert!(!indicator.needs_update(true, false));
        indicator.applied(32, true, false);
        assert!(
            indicator.needs_update(true, false),
            "An old completion cannot acknowledge the newest mask"
        );
        indicator.failed(63, true, false, now, "temporary failure".into());
        assert!(!indicator.needs_update_at(true, false, now));
        indicator.mask = 16;
        assert!(
            indicator.needs_update_at(true, false, now),
            "A new build bypasses an unrelated retry delay"
        );
        indicator.applied(16, true, false);
        assert!(indicator.needs_update(false, false));
        let restored = indicator.image(false, false).unwrap();
        assert_eq!(
            restored.rgba(),
            crate::symbiote_icons::image(16).unwrap().rgba()
        );
        indicator.applied(16, false, false);
        assert!(!indicator.needs_update(false, false));
    }

    #[test]
    fn popup_stays_in_work_area_at_edges_and_scaled_negative_monitors() {
        assert_eq!(
            popup_position((1800., 0., 24., 24.), (0., 24., 1920., 1056.), 1.),
            (1604., 32.)
        );
        assert_eq!(
            popup_position((1800., 1060., 24., 24.), (0., 0., 1920., 1060.), 1.),
            (1604., 820.)
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
            "set_symbiote_build",
            "set_locale",
            "desktop_command",
            "legacy_history",
            "renderer_report",
        ] {
            assert!(!allowed_command(command));
        }
    }
}
