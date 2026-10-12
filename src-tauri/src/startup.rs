use serde_json::{json, Value};
use std::path::Path;
use tauri_plugin_autostart::ManagerExt;

pub const LABEL: &str = "com.myeyes.app";
const MARKER: &str = "autostart-initialized-v1";

// Only record the default after registration succeeds. Later launches respect removal
// or disabling of the login item by the user instead of silently registering it again.
fn enable_once(profile: &Path, enable: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let marker = profile.join(MARKER);
    if marker.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    enable()?;
    let temporary = profile.join("autostart-initialized-v1.tmp");
    std::fs::write(&temporary, b"1\n").map_err(|e| e.to_string())?;
    std::fs::rename(temporary, marker).map_err(|e| e.to_string())
}

pub fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    // auto-launch 0.5 does not XML-escape paths in its LaunchAgent plist.
    let executable = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|e| e.to_string())?;
    if executable.to_string_lossy().contains(['&', '<', '>']) {
        return Err("Путь приложения содержит символы, несовместимые с автозапуском".into());
    }
    app.autolaunch().enable().map_err(|e| e.to_string())
}

pub fn initialize(app: &tauri::AppHandle, profile: &Path, isolated: bool, hidden: bool) -> Value {
    let executable = std::env::current_exe().ok();
    let bundled = executable
        .as_ref()
        .is_some_and(|path| path.parent().is_some_and(|p| p.ends_with("Contents/MacOS")));
    let managed = !isolated && bundled;
    let result = if managed {
        enable_once(profile, || enable(app))
    } else {
        Ok(())
    };
    if let Err(error) = &result {
        eprintln!("Autostart: {error}");
    }
    json!({"startedHidden":hidden,"managed":managed,
        "registered":if managed {app.autolaunch().is_enabled().ok()} else {None},
        "error":result.err()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn directory() -> std::path::PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "blincho-startup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn registration_is_once_and_does_not_undo_later_disabling() {
        let path = directory();
        let calls = AtomicUsize::new(0);
        enable_once(&path, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .unwrap();
        // The simulated backend is now disabled. The persisted decision must prevent
        // another enable call on restart regardless of that backend state.
        enable_once(&path, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn failed_registration_is_not_marked_and_can_retry() {
        let path = directory();
        assert!(enable_once(&path, || Err("permission denied".into())).is_err());
        assert!(!path.join(MARKER).exists());
        enable_once(&path, || Ok(())).unwrap();
        assert!(path.join(MARKER).exists());
        std::fs::remove_dir_all(path).unwrap();
    }
}
