use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem as Item, Submenu},
    Manager,
};

pub struct NativeUi {
    pub show: MenuItem<tauri::Wry>,
    pub rest: MenuItem<tauri::Wry>,
    pub quit: MenuItem<tauri::Wry>,
    pub autostart: CheckMenuItem<tauri::Wry>,
    pub guards: Mutex<Vec<MenuItem<tauri::Wry>>>,
}

#[cfg(target_os = "macos")]
struct DockVisibility(Mutex<bool>);

pub fn initialize_dock(_app: &tauri::AppHandle, _visible: bool) {
    #[cfg(target_os = "macos")]
    _app.manage(DockVisibility(Mutex::new(_visible)));
}

#[cfg(target_os = "macos")]
pub fn activation_policy(visible: bool) -> tauri::ActivationPolicy {
    if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    }
}

pub fn set_dock_visible(_app: &tauri::AppHandle, _visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let state = _app
            .try_state::<DockVisibility>()
            .ok_or("Dock visibility unavailable")?;
        let mut visible = state.0.lock().map_err(|e| e.to_string())?;
        if *visible != _visible {
            // The Dock-only API suppresses rapid hide/show requests. Activation
            // policy applies each transition without making native windows unhideable.
            _app.set_activation_policy(activation_policy(_visible))
                .map_err(|e| e.to_string())?;
            *visible = _visible;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn reconcile_dock(app: &tauri::AppHandle) -> Result<(), String> {
    // Strict shields temporarily own activation policy and restore their
    // captured baseline. A newer tray action must supersede that baseline.
    let visible = dock_is_visible(app)?;
    // Compare AppKit's actual Regular (0) or Accessory (1) policy so duplicate
    // teardown does not mutate an already restored application.
    if crate::platform::activation_policy(app) == Some(if visible { 0 } else { 1 }) {
        return Ok(());
    }
    app.set_activation_policy(activation_policy(visible))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub fn dock_is_visible(app: &tauri::AppHandle) -> Result<bool, String> {
    let state = app
        .try_state::<DockVisibility>()
        .ok_or("Dock visibility unavailable")?;
    let visible = state.0.lock().map_err(|e| e.to_string())?;
    Ok(*visible)
}

pub fn show_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let previous = dock_is_visible(window.app_handle())?;
    set_dock_visible(window.app_handle(), true)?;
    let result = window.show().map_err(|e| e.to_string());
    #[cfg(target_os = "macos")]
    if result.is_err() {
        if let Err(error) = set_dock_visible(window.app_handle(), previous) {
            eprintln!("Dock rollback: {error}");
        }
    }
    result
}

pub fn hide_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())?;
    set_dock_visible(window.app_handle(), false)
}

#[cfg(target_os = "windows")]
struct HiddenStartup {
    position: tauri::PhysicalPosition<i32>,
    skip_taskbar: bool,
    focusable: bool,
}
#[cfg(target_os = "windows")]
struct HiddenStartupState(Mutex<Option<HiddenStartup>>);

#[cfg(target_os = "windows")]
pub fn initialize_hidden_startup(
    window: &tauri::WebviewWindow,
    skip_taskbar: bool,
    focusable: bool,
) -> tauri::Result<()> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let monitors = window.available_monitors()?;
    let left = monitors.iter().map(|m| m.position().x).min().unwrap_or(0);
    let top = monitors.iter().map(|m| m.position().y).min().unwrap_or(0);
    let offscreen = tauri::PhysicalPosition::new(
        left.saturating_sub(i32::try_from(size.width).unwrap_or(i32::MAX))
            .saturating_sub(64),
        top.saturating_sub(i32::try_from(size.height).unwrap_or(i32::MAX))
            .saturating_sub(64),
    );
    window
        .app_handle()
        .manage(HiddenStartupState(Mutex::new(Some(HiddenStartup {
            position,
            skip_taskbar,
            focusable,
        }))));
    window.set_position(offscreen)?;
    // WebView2 can stall its first navigation under a hidden native HWND.
    // Warm up outside every monitor without a taskbar icon or activation.
    window.show()
}

pub fn finish_hidden_startup(_app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if let Some(state) = _app.try_state::<HiddenStartupState>() {
        let mut startup = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(saved) = startup.as_ref() {
            let window = _app
                .get_webview_window("main")
                .ok_or("Main window unavailable")?;
            window.hide().map_err(|e| e.to_string())?;
            window
                .set_position(saved.position)
                .map_err(|e| e.to_string())?;
            window
                .set_skip_taskbar(saved.skip_taskbar)
                .map_err(|e| e.to_string())?;
            window
                .set_focusable(saved.focusable)
                .map_err(|e| e.to_string())?;
            *startup = None;
        }
    }
    Ok(())
}

fn locale_text(locale: &str) -> &'static Value {
    static STRINGS: OnceLock<Value> = OnceLock::new();
    let strings = STRINGS.get_or_init(|| {
        serde_json::from_str(include_str!("../locales.json")).expect("Valid native translations")
    });
    let code = locale.split(['-', '_']).next().unwrap_or("en");
    strings.get(code).unwrap_or(&strings["en"])
}

pub fn tray_title(locale: &str) -> &'static str {
    locale_text(locale)["title"].as_str().unwrap_or("Blincho")
}

pub fn set_locale(app: &tauri::AppHandle, locale: &str) -> Result<(), String> {
    let text = locale_text(locale);
    let label = |key: &str| text[key].as_str().unwrap_or("Blincho");
    let ui = app.state::<NativeUi>();
    ui.show.set_text(label("show")).map_err(|e| e.to_string())?;
    ui.rest
        .set_text(label("breakNow"))
        .map_err(|e| e.to_string())?;
    ui.quit.set_text(label("quit")).map_err(|e| e.to_string())?;
    ui.autostart
        .set_text(label("autostart"))
        .map_err(|e| e.to_string())?;
    // Windows can start login items before Explorer is ready. The tray
    // library retains its window and registers again on TaskbarCreated.
    // An optional tooltip update must not abort that recovery or startup.
    if let Err(error) = crate::tray_preview::set_tooltip(app, label("title")) {
        eprintln!("Tray tooltip: {error}");
    }
    #[cfg(target_os = "macos")]
    let result = (|| -> tauri::Result<()> {
        let about = AboutMetadata {
            name: Some("Blincho".into()),
            version: Some(app.package_info().version.to_string()),
            ..Default::default()
        };
        let hide = MenuItem::with_id(app, "native-hide", label("hide"), true, Some("Cmd+H"))?;
        let minimize = MenuItem::with_id(
            app,
            "native-minimize",
            label("minimize"),
            true,
            Some("Cmd+M"),
        )?;
        let application = Submenu::with_items(
            app,
            "Blincho",
            true,
            &[
                &Item::about(app, Some(label("about")), Some(about))?,
                &Item::separator(app)?,
                &hide,
                &Item::hide_others(app, Some(label("hideOthers")))?,
                &Item::show_all(app, Some(label("showAll")))?,
                &Item::separator(app)?,
                &Item::quit(app, Some(label("quit")))?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            label("edit"),
            true,
            &[
                &Item::undo(app, Some(label("undo")))?,
                &Item::redo(app, Some(label("redo")))?,
                &Item::separator(app)?,
                &Item::cut(app, Some(label("cut")))?,
                &Item::copy(app, Some(label("copy")))?,
                &Item::paste(app, Some(label("paste")))?,
                &Item::select_all(app, Some(label("selectAll")))?,
            ],
        )?;
        let window = Submenu::with_items(
            app,
            label("window"),
            true,
            &[
                &minimize,
                &Item::maximize(app, Some(label("zoom")))?,
                &Item::bring_all_to_front(app, Some(label("front")))?,
            ],
        )?;
        *ui.guards.lock().unwrap() = vec![hide, minimize];
        app.set_menu(Menu::with_items(app, &[&application, &edit, &window])?)?;
        Ok(())
    })();
    #[cfg(target_os = "macos")]
    result.map_err(|e| e.to_string())?;
    let strict = app
        .state::<crate::Runtime>()
        .timer
        .lock()
        .map(|timer| timer.strict())
        .unwrap_or(false);
    set_strict(app, strict)
}

pub fn set_strict(app: &tauri::AppHandle, strict: bool) -> Result<(), String> {
    if let Some(ui) = app.try_state::<NativeUi>() {
        let guards = ui.guards.lock().map_err(|e| e.to_string())?.clone();
        for item in guards {
            item.set_enabled(!strict).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
