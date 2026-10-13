#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod history;
mod platform;
mod startup;
mod timer;
mod ui;
mod updates;
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use timer::{Snapshot, Timer, TimerInput};

struct Runtime {
    timer: Mutex<Timer>,
    events: Mutex<Vec<Value>>,
    renderer: Mutex<Value>,
    autostart: Mutex<Value>,
    profile: PathBuf,
    source: PathBuf,
    test_dir: Option<PathBuf>,
    quitting: AtomicBool,
    updates: Arc<updates::UpdateController>,
    meeting: platform::MeetingMonitor,
}
static HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
extern "C" fn power_event(code: i32) {
    if let Some(app) = HANDLE.get() {
        let runtime = app.state::<Runtime>();
        if let Ok(mut timer) = runtime.timer.lock() {
            timer.power(code, Utc::now().timestamp_millis());
        }
        if let Ok(mut events) = runtime.events.lock() {
            if events.len() == 100 {
                events.remove(0);
            }
            events.push(
                json!({"code":code,"at":Utc::now().to_rfc3339(),"source":platform::power_source()}),
            );
        };
    }
}
extern "C" fn notification_clicked() {
    if let Some(app) = HANDLE.get() {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = show_manual(&handle);
        });
    }
}
fn foreground_expiry(
    app: &tauri::AppHandle,
    version: u64,
    policy: (bool, bool, bool),
) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let runtime = handle.state::<Runtime>();
        let mut timer = runtime.timer.lock().unwrap();
        sample(&mut timer);
        if timer.input.as_ref().is_none_or(|input| {
            (
                input.meeting_enabled,
                input.auto_takeover,
                input.strict_mode,
            ) != policy
                || !(input.auto_takeover || input.strict_mode)
        }) || timer.snapshot.version != version
            || !timer.snapshot.expiry_pending
            || timer.snapshot.manual_paused
            || !timer.snapshot.reasons.is_empty()
        {
            return;
        }
        drop(timer);
        if let Err(error) = ui::finish_hidden_startup(&handle) {
            eprintln!("Startup window: {error}");
            return;
        }
        if let Ok(window) = window(&handle) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .map_err(|e| e.to_string())
}
fn sample(timer: &mut Timer) -> bool {
    let isolated_smoke = std::env::var_os("BLINCHO_SMOKE_PRESENCE").is_some_and(|v| v == "1")
        && HANDLE
            .get()
            .and_then(|app| app.try_state::<Runtime>())
            .is_some_and(|runtime| runtime.test_dir.is_some());
    let presence = if isolated_smoke {
        platform::Presence {
            idle_seconds: Some(0.),
            locked: Some(false),
        }
    } else {
        platform::presence()
    };
    timer.tick(
        Utc::now().timestamp_millis(),
        presence.idle_seconds,
        presence.locked,
    )
}
fn window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window unavailable".into())
}
fn presentation(app: &tauri::AppHandle, strict: bool, release: bool) -> Result<(), String> {
    let window = window(app)?;
    ui::set_strict(app, strict)?;
    window.set_closable(!strict).map_err(|e| e.to_string())?;
    window.set_minimizable(!strict).map_err(|e| e.to_string())?;
    window
        .set_always_on_top(strict)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let pointer = window.ns_window().map_err(|e| e.to_string())? as usize;
        window
            .run_on_main_thread(move || unsafe {
                platform::window_level(pointer as *mut _, strict)
            })
            .map_err(|e| e.to_string())?;
    }
    if release {
        set_fullscreen(&window, false)?;
    }
    Ok(())
}
fn set_fullscreen(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window
            .set_simple_fullscreen(enabled)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_fullscreen(enabled).map_err(|e| e.to_string())
    }
}
// Explicit tray, notification and reopen actions must remain available even when
// a desktop cannot supply presence samples. Showing the UI never resumes timing.
fn show_manual(app: &tauri::AppHandle) -> Result<(), String> {
    ui::finish_hidden_startup(app)?;
    let window = window(app)?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
fn foreground(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Runtime>();
    let mut timer = runtime.timer.lock().map_err(|e| e.to_string())?;
    sample(&mut timer);
    if !timer.snapshot.reasons.is_empty() {
        return Err("Presence is not confirmed".into());
    }
    drop(timer);
    ui::finish_hidden_startup(app)?;
    let window = window(app)?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
fn configure_timer(input: TimerInput, app: tauri::AppHandle) -> Result<Snapshot, String> {
    let runtime = app.state::<Runtime>();
    let mut timer = runtime.timer.lock().map_err(|e| e.to_string())?;
    // Account for native elapsed time before accepting an explicit UI transition.
    sample(&mut timer);
    timer.configure(input, Utc::now().timestamp_millis())?;
    let snapshot = timer.snapshot.clone();
    drop(timer);
    ui::finish_hidden_startup(&app)?;
    Ok(snapshot)
}
#[tauri::command]
fn timer_snapshot(app: tauri::AppHandle) -> Result<Snapshot, String> {
    let runtime = app.state::<Runtime>();
    let mut timer = runtime.timer.lock().map_err(|e| e.to_string())?;
    sample(&mut timer);
    Ok(timer.snapshot.clone())
}
#[tauri::command]
fn desktop_command(
    operation: String,
    flag: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    match operation.as_str() {
        "hide" => {
            let runtime = app.state::<Runtime>();
            if runtime.timer.lock().map_err(|e| e.to_string())?.strict() {
                return Err("Strict break active".into());
            }
            window(&app)?.hide().map_err(|e| e.to_string())
        }
        "minimize" => {
            let runtime = app.state::<Runtime>();
            if runtime.timer.lock().map_err(|e| e.to_string())?.strict() {
                return Err("Strict break active".into());
            }
            window(&app)?.minimize().map_err(|e| e.to_string())
        }
        "show" => foreground(&app),
        "fullscreen" => {
            if flag == Some(true) {
                foreground(&app)?;
            }
            set_fullscreen(&window(&app)?, flag.unwrap_or(false))
        }
        "strict" => {
            let strict = flag.unwrap_or(false)
                && app
                    .state::<Runtime>()
                    .timer
                    .lock()
                    .map_err(|e| e.to_string())?
                    .strict();
            presentation(&app, strict, false)
        }
        "alwaysOnTop" => {
            let strict = flag.unwrap_or(false)
                && app
                    .state::<Runtime>()
                    .timer
                    .lock()
                    .map_err(|e| e.to_string())?
                    .strict();
            presentation(&app, strict, false)
        }
        _ => Err("Unsupported desktop command".into()),
    }
}
#[tauri::command]
async fn legacy_history(app: tauri::AppHandle) -> Result<Option<history::HistoryExport>, String> {
    let source = app.state::<Runtime>().source.clone();
    let explicit = std::env::var_os("BLINCHO_PROTOTYPE_HISTORY_SOURCE").is_some();
    tauri::async_runtime::spawn_blocking(move || {
        if explicit {
            history::read_legacy_source(&source)
        } else {
            history::read_current_profile(&source)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn notification_permission(app: tauri::AppHandle) -> Result<bool, String> {
    platform::notification_permission(&app).await
}
#[tauri::command]
async fn notification_send(
    title: String,
    body: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    if title.len() > 1024 || body.len() > 8192 {
        return Err("Notification too large".into());
    }
    platform::notification_send(&app, title, body).await
}
#[tauri::command]
fn get_runtime_metadata() -> &'static str {
    option_env!("BLINCHO_RELEASE_METADATA").unwrap_or("")
}
#[tauri::command]
async fn desktop_info() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win32"
        } else {
            "linux"
        };
        json!({"platform":platform, "meetingDetectionSupported":platform::meeting_supported()})
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn attention(app: tauri::AppHandle) -> Result<(), String> {
    window(&app)?
        .request_user_attention(Some(tauri::UserAttentionType::Informational))
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::open_external(&url))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_locale(locale: String, app: tauri::AppHandle) -> Result<(), String> {
    if locale.len() > 32 {
        return Err("Invalid locale".into());
    }
    ui::set_locale(&app, &locale.to_lowercase())
}
#[tauri::command]
fn update_get_state(app: tauri::AppHandle) -> updates::UpdateState {
    app.state::<Runtime>().updates.get_state()
}
#[tauri::command]
fn update_set_policy(policy: String, app: tauri::AppHandle) -> updates::UpdateState {
    app.state::<Runtime>().updates.set_policy(&policy)
}
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<updates::UpdateState, String> {
    let controller = app.state::<Runtime>().updates.clone();
    tauri::async_runtime::spawn_blocking(move || controller.check(true))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn update_skip(version: String, app: tauri::AppHandle) -> updates::UpdateState {
    app.state::<Runtime>().updates.skip(&version)
}
#[tauri::command]
fn update_download(version: String, app: tauri::AppHandle) -> updates::UpdateState {
    app.state::<Runtime>().updates.download(&version)
}
#[tauri::command]
async fn update_open_download() -> Result<bool, String> {
    open_external(updates::MANUAL_DOWNLOAD_URL.into())
        .await
        .map(|_| true)
}
#[tauri::command]
async fn check_meeting_active(app: tauri::AppHandle) -> Result<platform::MeetingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = app.state::<Runtime>();
        let (epoch, absent) = {
            let timer = runtime.timer.lock().unwrap();
            (
                timer.snapshot.absence_epoch,
                !timer.snapshot.reasons.is_empty(),
            )
        };
        let status = runtime.meeting.check(epoch, absent);
        let timer = runtime.timer.lock().unwrap();
        if timer.snapshot.absence_epoch != epoch || !timer.snapshot.reasons.is_empty() {
            platform::MeetingStatus {
                in_meeting: false,
                supported: status.supported,
            }
        } else {
            status
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn renderer_report(report: Value, app: tauri::AppHandle) -> Result<(), String> {
    if report.to_string().len() > 16384 {
        return Err("Report too large".into());
    }
    *app.state::<Runtime>()
        .renderer
        .lock()
        .map_err(|e| e.to_string())? = report;
    Ok(())
}
#[tauri::command]
fn preferred_languages() -> Vec<String> {
    platform::preferred_languages()
}
fn diagnostics(app: &tauri::AppHandle) {
    let runtime = app.state::<Runtime>();
    if runtime.test_dir.is_none() && std::env::var("BLINCHO_DIAGNOSTICS").as_deref() != Ok("1") {
        return;
    }
    let (snapshot, strict) = {
        let Ok(timer) = runtime.timer.lock() else {
            return;
        };
        (timer.snapshot.clone(), timer.strict())
    };
    let value = json!({"timer":snapshot,"strict":strict,"visible":window(app).ok().and_then(|w|w.is_visible().ok()),
        "focused":window(app).ok().and_then(|w|w.is_focused().ok()),"events":runtime.events.lock().ok().map(|v|v.clone()),
        "fullscreen":window(app).ok().and_then(|w|w.is_fullscreen().ok()),
        "closable":window(app).ok().and_then(|w|w.is_closable().ok()),
        "minimizable":window(app).ok().and_then(|w|w.is_minimizable().ok()),
        "position":window(app).ok().and_then(|w|w.outer_position().ok()),
        "size":window(app).ok().and_then(|w|w.outer_size().ok()),
        "renderer":runtime.renderer.lock().ok().map(|v|v.clone()),"sourceExport":runtime.source,"profile":runtime.profile,
        "pid":std::process::id(),"updates":runtime.updates.get_state(),"autostart":runtime.autostart.lock().ok().map(|v|v.clone())});
    let path = runtime
        .test_dir
        .as_ref()
        .unwrap_or(&runtime.profile)
        .join("runtime-diagnostics.json");
    if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
        let temporary = path.with_extension("tmp");
        if let Err(error) =
            std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path))
        {
            eprintln!("Diagnostics: {error}");
        }
    }
}
// Native smoke tests opt in explicitly. This local file interface does not exist unless the
// launching developer supplies a dedicated test directory. It never exposes an HTTP server.
fn test_control(app: &tauri::AppHandle) {
    let runtime = app.state::<Runtime>();
    let Some(directory) = &runtime.test_dir else {
        return;
    };
    let path = directory.join("control.json");
    if !path.exists() {
        return;
    }
    let result = (|| -> Result<Value, String> {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        if bytes.len() > 16384 {
            return Err("Control too large".into());
        }
        let command: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        match command["operation"].as_str().unwrap_or("") {
            "meeting" => {
                runtime
                    .meeting
                    .set_test_status(command["active"].as_bool().ok_or("Missing meeting state")?);
            }
            "configure" => {
                let input: TimerInput =
                    serde_json::from_value(command["input"].clone()).map_err(|e| e.to_string())?;
                configure_timer(input, app.clone())?;
            }
            "hide" => desktop_command("hide".into(), None, app.clone())?,
            "show" => foreground(app)?,
            "close" => window(app)?.close().map_err(|e| e.to_string())?,
            "resize" => {
                let width = command["width"].as_u64().ok_or("Missing width")?;
                let height = command["height"].as_u64().ok_or("Missing height")?;
                if !(780..=2500).contains(&width) || !(620..=1800).contains(&height) {
                    return Err("Invalid test window size".into());
                }
                window(app)?
                    .set_size(tauri::LogicalSize::new(width as f64, height as f64))
                    .map_err(|e| e.to_string())?;
            }
            "rest" => {
                foreground(app)?;
                app.emit("trigger-break", ()).map_err(|e| e.to_string())?;
            }
            "power-cycle" => {
                let mut timer = runtime.timer.lock().map_err(|e| e.to_string())?;
                let now = Utc::now().timestamp_millis();
                timer.power(1, now - 300000);
                timer.power(2, now);
            }
            "eval" => window(app)?
                .eval(command["script"].as_str().ok_or("Missing script")?)
                .map_err(|e| e.to_string())?,
            "quit" => {
                runtime.quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => return Err("Unsupported test control".into()),
        }
        Ok(json!({"ok":true,"id":command["id"]}))
    })();
    let response = match result {
        Ok(value) => value,
        Err(error) => json!({"ok":false,"error":error}),
    };
    let _ = std::fs::write(directory.join("response.json"), response.to_string());
}
fn main() {
    let hidden = std::env::args_os().any(|arg| arg == "--autostart");
    let mut context = tauri::generate_context!();
    // A test profile must never address the normal instance's singleton socket.
    if let Some(path) = std::env::var_os("BLINCHO_PROTOTYPE_TEST_DIR") {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut hash);
        context.config_mut().identifier = format!("com.myeyes.tauri.test{:x}", hash.finish());
    }
    let autostart_builder = tauri_plugin_autostart::Builder::new()
        .app_name(startup::LABEL)
        .arg("--autostart");
    #[cfg(target_os = "macos")]
    let autostart_builder =
        autostart_builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            let autostart = args.iter().any(|arg| arg == "--autostart");
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(runtime) = handle.try_state::<Runtime>() {
                    if let Ok(mut events) = runtime.events.lock() {
                        if events.len() == 100 { events.remove(0); }
                        events.push(json!({"source":"single-instance","autostart":autostart,"at":Utc::now().to_rfc3339()}));
                    }
                    if !autostart {
                        if let Err(error) = show_manual(&handle) { eprintln!("Reopen: {error}"); }
                    }
                }
            });
        }))
        .plugin(autostart_builder.build())
        .invoke_handler(tauri::generate_handler![
            configure_timer,
            timer_snapshot,
            desktop_command,
            legacy_history,
            renderer_report,
            get_runtime_metadata, desktop_info, preferred_languages, notification_permission, notification_send, attention, open_external,
            set_locale, update_get_state, update_set_policy, update_check, update_skip, update_download, update_open_download, check_meeting_active
        ])
        .setup(move |app| {
            let test_dir = std::env::var_os("BLINCHO_PROTOTYPE_TEST_DIR").map(PathBuf::from);
            let profile = match &test_dir {
                Some(path) => path.join("profile"),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&profile)?;
            let autostart = startup::initialize(app.handle(), &profile, test_dir.is_some(), hidden);
            if let Some(path) = &test_dir {
                std::fs::create_dir_all(path)?;
            }
            let mut builder =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .visible(!hidden)
                    .focused(!hidden)
                    .on_navigation(|url| {
                        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                            || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
                    });
            #[cfg(target_os = "windows")]
            if hidden {
                builder = builder.skip_taskbar(true).focusable(false);
            }
            if let Some(path) = &test_dir {
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
                { builder = builder.data_directory(path.join("webview")); }
            }
            let source = std::env::var_os("BLINCHO_PROTOTYPE_HISTORY_SOURCE")
                .map(PathBuf::from)
                .unwrap_or(history::legacy_profile_dir()?.join("tauri-history-export.json"));
            let preferences = profile.join("update-preferences.json");
            if test_dir.is_none() && !preferences.exists() {
                let legacy=history::legacy_profile_dir()?.join("update-preferences.json");
                if legacy.is_file() {
                    use std::io::Read;
                    let mut bytes=Vec::new();
                    std::fs::File::open(legacy)?.take(16_385).read_to_end(&mut bytes)?;
                    if bytes.len()>16_384 {bytes=b"{}".to_vec();}
                    std::fs::write(&preferences,bytes)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&preferences,std::fs::Permissions::from_mode(0o600))?;
                    }
                }
            }
            let updates_app=app.handle().clone();
            let bundled=startup::is_packaged();
            let update_controller=updates::UpdateController::new(profile.clone(),app.package_info().version.to_string(),std::env::consts::ARCH,bundled,move|state|{let _=updates_app.emit("update-state",state);});
            app.manage(Runtime {
                timer: Mutex::new(Timer::new(Utc::now().timestamp_millis())),
                events: Mutex::new(vec![]),
                renderer: Mutex::new(Value::Null),
                autostart: Mutex::new(autostart.clone()),
                profile,
                source,
                test_dir,
                quitting: AtomicBool::new(false),
                updates: update_controller.clone(),
                meeting: platform::MeetingMonitor::new(),
            });
            HANDLE
                .set(app.handle().clone())
                .map_err(|_| "Duplicate runtime")?;
            if let Err(error) = platform::observe_power(power_event) { eprintln!("Power observer: {error}"); }
            if bundled { platform::notifications_initialize(notification_clicked); }
            let show = MenuItem::with_id(app, "show", "Показать Blincho", true, None::<&str>)?;
            let rest = MenuItem::with_id(app, "rest", "Сделать перерыв", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let launch_at_login = CheckMenuItem::with_id(app, "autostart", "Запускать при входе",
                autostart["managed"].as_bool().unwrap_or(false),
                autostart["registered"].as_bool().unwrap_or(false), None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &rest, &launch_at_login, &quit])?;
            app.manage(ui::NativeUi{show:show.clone(),rest:rest.clone(),quit:quit.clone(),autostart:launch_at_login.clone(),guards:Mutex::new(vec![])});
            TrayIconBuilder::with_id("blincho")
                .icon(tauri::image::Image::from_bytes(if cfg!(target_os = "macos") {
                    include_bytes!("../../assets/trayTemplate.png")
                } else { include_bytes!("../../assets/icon.png") })?)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Blincho")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "autostart" => {
                        let result = startup::is_enabled(app).map_err(|e| e.to_string()).and_then(|registered| {
                            if registered { startup::disable(app).map_err(|e| e.to_string()) } else { startup::enable(app) }
                        });
                        let registered = startup::is_enabled(app).ok();
                        let _ = launch_at_login.set_checked(registered.unwrap_or(false));
                        if let Ok(mut status) = app.state::<Runtime>().autostart.lock() {
                            status["registered"] = json!(registered);
                            status["error"] = json!(result.err().map(|e| e.to_string()));
                        }
                    }
                    "show" => {
                        if let Err(e) = show_manual(app) {
                            eprintln!("Show: {e}");
                        }
                    }
                    "rest" => {
                        if foreground(app).is_ok() {
                            let _ = app.emit("trigger-break", ());
                        }
                    }
                    "quit" => {
                        app.state::<Runtime>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            app.on_menu_event(|app, event| {
                let operation = match event.id.as_ref() {
                    "native-hide" => "hide",
                    "native-minimize" => "minimize",
                    _ => return,
                };
                let _ = desktop_command(operation.into(), None, app.clone());
            });
            ui::set_locale(app.handle(),preferred_languages().first().map(String::as_str).unwrap_or("en"))?;
            let _main_window = builder.build()?;
            #[cfg(target_os = "windows")]
            if hidden {
                let config = &app.config().app.windows[0];
                ui::initialize_hidden_startup(&_main_window, config.skip_taskbar, config.focusable)?;
            }
            if app.state::<Runtime>().test_dir.is_none() {update_controller.start();}
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last_strict = false;
                let mut last_release = false;
                let mut handled_expiry: Option<(u64,bool,bool,bool)> = None;
                loop {
                    if handle.state::<Runtime>().quitting.load(Ordering::SeqCst) {break;}
                    std::thread::sleep(Duration::from_millis(250));
                    let runtime = handle.state::<Runtime>();
                    let (expired, strict, release, mut snapshot, policy) = {
                        let Ok(mut timer) = runtime.timer.lock() else {
                            break;
                        };
                        sample(&mut timer);
                        let expired = timer.snapshot.expiry_pending && !timer.snapshot.manual_paused && timer.snapshot.reasons.is_empty() && handled_expiry!=timer.input.as_ref().map(|input|(timer.snapshot.version,input.meeting_enabled,input.auto_takeover,input.strict_mode));
                        (
                            expired,
                            timer.strict(),
                            !timer.snapshot.reasons.is_empty() || timer.snapshot.break_elapsed,
                            timer.snapshot.clone(),
                            timer.input.clone(),
                        )
                    };
                    if !snapshot.expiry_pending {handled_expiry=None;}
                    if expired {
                        handled_expiry=policy.as_ref().map(|input|(snapshot.version,input.meeting_enabled,input.auto_takeover,input.strict_mode));
                        let expected_version = snapshot.version;
                        let meeting = policy.as_ref().is_some_and(|input|input.meeting_enabled && !input.strict_mode)
                            && runtime.meeting.check(snapshot.absence_epoch,!snapshot.reasons.is_empty()).in_meeting;
                        let allow_foreground = {
                            let Ok(mut timer) = runtime.timer.lock() else {break;};
                            let postponed = meeting && timer.postpone_meeting(expected_version,Utc::now().timestamp_millis());
                            let allowed = !postponed && timer.snapshot.version==expected_version && timer.snapshot.expiry_pending
                                && !timer.snapshot.manual_paused && timer.snapshot.reasons.is_empty()
                                && timer.input.as_ref().is_some_and(|input|input.auto_takeover || input.strict_mode);
                            snapshot=timer.snapshot.clone(); allowed
                        };
                        if allow_foreground {
                            if let Err(error)=foreground_expiry(&handle,expected_version,policy.as_ref().map(|input|(input.meeting_enabled,input.auto_takeover,input.strict_mode)).unwrap_or((false,false,false))) {eprintln!("Timer foreground: {error}");}
                        }
                    }
                    if strict != last_strict || release != last_release {
                        if let Err(e) = presentation(&handle, strict, release) {
                            eprintln!("Presentation: {e}");
                        }
                        last_strict = strict;
                        last_release = release;
                    }
                    let _ = handle.emit("native-timer", snapshot);
                    test_control(&handle);
                    diagnostics(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let runtime = window.state::<Runtime>();
            let strict = runtime.timer.lock().map(|t| t.strict()).unwrap_or(false);
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if !runtime.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        if !strict {
                            let _ = window.hide();
                        }
                    }
                }
                tauri::WindowEvent::Focused(false) if strict => {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                tauri::WindowEvent::Resized(_) if strict => {
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(context)
        .expect("Blincho failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(runtime)=app.try_state::<Runtime>() {runtime.quitting.store(true,Ordering::SeqCst);runtime.updates.dispose();}
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                if let Err(error) = show_manual(app) { eprintln!("Reopen: {error}"); }
            }
        });
}
