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
pub fn set_locale(app: &tauri::AppHandle, locale: &str) -> Result<(), String> {
    static STRINGS: OnceLock<Value> = OnceLock::new();
    let strings = STRINGS.get_or_init(|| {
        serde_json::from_str(include_str!("../locales.json")).expect("Valid native translations")
    });
    let code = locale.split(['-', '_']).next().unwrap_or("en");
    let text = strings.get(code).unwrap_or(&strings["en"]);
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
    if let Some(tray) = app.tray_by_id("blincho") {
        tray.set_tooltip(Some(label("title")))
            .map_err(|e| e.to_string())?;
    }
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
