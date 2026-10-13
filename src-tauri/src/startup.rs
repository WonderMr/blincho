use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use tauri::Manager;
#[cfg(target_os = "macos")]
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

fn packaged_path(path: &Path, os: &str, development: bool, release_metadata: bool) -> bool {
    if development || !path.is_absolute() {
        return false;
    }
    // Include Cargo's target triple layout and custom target directories. Their
    // debug/release folders contain build products, rather than installed apps.
    if path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|part| part == "debug" || part == "release" || part == "deps")
    {
        return false;
    }
    let executable = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    match os {
        "macos" => {
            executable.eq_ignore_ascii_case("blincho")
                && path
                    .parent()
                    .is_some_and(|parent| parent.ends_with("Contents/MacOS"))
        }
        "windows" => executable.eq_ignore_ascii_case("blincho.exe") || release_metadata,
        "linux" => executable == "blincho",
        _ => false,
    }
}

pub fn is_packaged() -> bool {
    std::env::current_exe().ok().is_some_and(|path| {
        packaged_path(
            &path,
            std::env::consts::OS,
            cfg!(debug_assertions) || cfg!(test),
            option_env!("BLINCHO_RELEASE_METADATA").is_some_and(|value| !value.is_empty()),
        )
    })
}

#[cfg(target_os = "linux")]
fn launch_executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // An AppImage mount disappears when the process exits. Persist its outer
    // image path, as the Tauri environment captured it before startup.
    app.env()
        .appimage
        .or_else(|| std::env::current_exe().ok())
        .filter(|path| path.is_absolute() && path.is_file())
        .ok_or_else(|| "Application executable is unavailable for autostart".into())
}

#[cfg(not(target_os = "linux"))]
fn launch_executable(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

fn autostart_path(path: &Path, os: &str, installed_windows: bool, appimage: bool) -> bool {
    match os {
        "macos" => path
            .parent()
            .is_some_and(|parent| parent.ends_with("Contents/MacOS")),
        // NSIS creates uninstall.exe next to the installed binary. Portable
        // executables still support manual updates without adding a login item.
        "windows" => installed_windows,
        "linux" => {
            appimage
                || matches!(
                    path.to_str(),
                    Some("/usr/bin/blincho" | "/usr/local/bin/blincho")
                )
        }
        _ => false,
    }
}

fn eligible(app: &tauri::AppHandle) -> bool {
    if !is_packaged() || std::env::var_os("BLINCHO_PROTOTYPE_TEST_DIR").is_some() {
        return false;
    }
    let Ok(path) = launch_executable(app) else {
        return false;
    };
    #[cfg(target_os = "linux")]
    let appimage = app.env().appimage.is_some();
    #[cfg(not(target_os = "linux"))]
    let appimage = false;
    let installed_windows = path
        .parent()
        .is_some_and(|parent| parent.join("uninstall.exe").is_file());
    autostart_path(&path, std::env::consts::OS, installed_windows, appimage)
}

pub fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    if !eligible(app) {
        return Err("Autostart is available only for an installed application".into());
    }
    let executable = launch_executable(app)?;
    #[cfg(target_os = "macos")]
    {
        // auto-launch 0.5 does not XML-escape paths in its LaunchAgent plist.
        let executable = executable.canonicalize().map_err(|e| e.to_string())?;
        if executable.to_string_lossy().contains(['&', '<', '>']) {
            return Err("Путь приложения содержит символы, несовместимые с автозапуском".into());
        }
        app.autolaunch().enable().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        windows::enable(&executable)
    }
    #[cfg(target_os = "linux")]
    {
        write_linux_entry(&linux_entry_path()?, &executable)
    }
}

pub fn disable(app: &tauri::AppHandle) -> Result<(), String> {
    if !eligible(app) {
        return Err("Autostart is available only for an installed application".into());
    }
    #[cfg(target_os = "macos")]
    {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        windows::disable()
    }
    #[cfg(target_os = "linux")]
    {
        match std::fs::remove_file(linux_entry_path()?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

pub fn is_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        windows::is_enabled()
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux_entry_enabled(&linux_entry_path()?)
    }
}

#[cfg(target_os = "linux")]
fn linux_entry_path() -> Result<PathBuf, String> {
    dirs::config_dir()
        .filter(|path| path.is_absolute())
        .map(|path| path.join("autostart").join(format!("{LABEL}.desktop")))
        .ok_or_else(|| "Autostart configuration directory is unavailable".into())
}

#[cfg(any(target_os = "linux", test))]
fn linux_exec(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("Autostart requires a UTF-8 executable path")?;
    if !text.starts_with('/') || text.contains(['\0', '\n', '\r', '=']) {
        return Err("Application path cannot be represented in an autostart desktop entry".into());
    }
    let mut quoted = String::from("\"");
    for character in text.chars() {
        match character {
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push_str("\" --autostart");
    Ok(quoted)
}

#[cfg(any(target_os = "linux", test))]
fn write_linux_entry(path: &Path, executable: &Path) -> Result<(), String> {
    use std::io::Write;
    let exec = linux_exec(executable)?;
    let directory = path.parent().ok_or("Autostart entry has no directory")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut file = tempfile::Builder::new()
        .prefix(".blincho-autostart-")
        .tempfile_in(directory)
        .map_err(|e| e.to_string())?;
    write!(file, "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Blincho\nExec={exec}\nTerminal=false\nStartupNotify=false\n")
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn linux_entry_enabled(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let mut text = String::new();
    file.take(16_385)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > 16_384 {
        return Err("Autostart desktop entry is too large".into());
    }
    let mut desktop_entry = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            desktop_entry = line == "[Desktop Entry]";
        }
        if desktop_entry
            && line
                .split_once('=')
                .is_some_and(|(key, value)| key.trim() == "Hidden" && value.trim() == "true")
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(any(target_os = "windows", test))]
fn windows_command(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("Autostart executable path is invalid")?;
    if text.contains(['\0', '\n', '\r', '"']) {
        return Err("Autostart executable path is invalid".into());
    }
    Ok(format!("\"{text}\" --autostart"))
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY},
        RegKey, RegValue,
    };
    // Tauri's NSIS uninstaller removes the product-name Run value.
    const NAME: &str = "Blincho";
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    pub(super) fn enable(path: &Path) -> Result<(), String> {
        let command = windows_command(path)?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.create_subkey_with_flags(RUN, KEY_SET_VALUE)
            .map_err(|e| e.to_string())?
            .0
            .set_value(NAME, &command)
            .map_err(|e| e.to_string())?;
        if let Ok(approved) = hkcu.open_subkey_with_flags(APPROVED, KEY_SET_VALUE) {
            approved
                .set_raw_value(
                    NAME,
                    &RegValue {
                        vtype: REG_BINARY,
                        bytes: vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].into(),
                    },
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub(super) fn disable() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match hkcu
            .open_subkey_with_flags(RUN, KEY_SET_VALUE)
            .and_then(|key| key.delete_value(NAME))
        {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
    pub(super) fn is_enabled() -> Result<bool, String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let value = hkcu
            .open_subkey_with_flags(RUN, KEY_READ)
            .and_then(|key| key.get_value::<String, _>(NAME));
        match value {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
            Ok(_) => {}
        }
        // Match auto-launch's handling of Task Manager's disabling timestamp.
        let approved = hkcu
            .open_subkey_with_flags(APPROVED, KEY_READ)
            .and_then(|key| key.get_raw_value(NAME));
        Ok(approved
            .map(|value| {
                value.bytes.len() < 8 || value.bytes.iter().rev().take(8).all(|byte| *byte == 0)
            })
            .unwrap_or(true))
    }
}

pub fn initialize(app: &tauri::AppHandle, profile: &Path, isolated: bool, hidden: bool) -> Value {
    let managed = !isolated && eligible(app);
    let result = if managed {
        enable_once(profile, || enable(app))
    } else {
        Ok(())
    };
    if let Err(error) = &result {
        eprintln!("Autostart: {error}");
    }
    json!({"startedHidden":hidden,"managed":managed,
        "registered":if managed {is_enabled(app).ok()} else {None}, "error":result.err()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn directory() -> PathBuf {
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
    fn rooted(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{path}"))
        } else {
            PathBuf::from(path)
        }
    }
    #[test]
    fn renamed_windows_portable_releases_allow_manual_update_checks() {
        let portable = rooted("/Apps/Blincho-1.6.0-windows-x64-portable.exe");
        assert!(packaged_path(&portable, "windows", false, true));
        assert!(!packaged_path(&portable, "windows", false, false));
        assert!(!packaged_path(&portable, "windows", true, true));
    }
    #[test]
    fn package_detection_excludes_development_test_and_cargo_outputs() {
        for (os, installed, development) in [
            (
                "macos",
                "/Applications/Blincho.app/Contents/MacOS/blincho",
                "/work/target/release/blincho",
            ),
            (
                "windows",
                "/Program Files/Blincho/blincho.exe",
                "/work/target/x86_64-pc-windows-msvc/release/blincho.exe",
            ),
            ("linux", "/usr/bin/blincho", "/work/build/debug/blincho"),
        ] {
            let installed = rooted(installed);
            let development = rooted(development);
            assert!(packaged_path(&installed, os, false, false));
            assert!(!packaged_path(&installed, os, true, true));
            assert!(!packaged_path(&development, os, false, true));
        }
        assert!(!is_packaged());
        assert!(!packaged_path(
            Path::new("/tmp/blincho-abc123"),
            "linux",
            false,
            false
        ));
    }
    #[test]
    fn autostart_requires_installed_or_outer_appimage_paths() {
        assert!(autostart_path(
            Path::new("/Blincho/blincho.exe"),
            "windows",
            true,
            false
        ));
        assert!(!autostart_path(
            Path::new("/Downloads/blincho.exe"),
            "windows",
            false,
            false
        ));
        assert!(autostart_path(
            Path::new("/usr/bin/blincho"),
            "linux",
            false,
            false
        ));
        assert!(autostart_path(
            Path::new("/home/me/Apps/Blincho.AppImage"),
            "linux",
            false,
            true
        ));
        assert!(!autostart_path(
            Path::new("/tmp/.mount_Blincho/usr/bin/blincho"),
            "linux",
            false,
            false
        ));
    }
    #[test]
    fn windows_run_command_quotes_spaces_and_unicode_without_xml_restrictions() {
        assert_eq!(
            windows_command(Path::new("C:\\Program Files\\Blincho & Юлия\\blincho.exe")).unwrap(),
            "\"C:\\Program Files\\Blincho & Юлия\\blincho.exe\" --autostart"
        );
        assert!(windows_command(Path::new("C:\\bad\"path\\blincho.exe")).is_err());
    }
    #[test]
    fn linux_desktop_exec_escapes_reserved_characters_and_rejects_newlines() {
        assert_eq!(
            linux_exec(Path::new("/home/me/Apps/Blincho & 100%.AppImage")).unwrap(),
            "\"/home/me/Apps/Blincho & 100%%.AppImage\" --autostart"
        );
        assert_eq!(
            linux_exec(Path::new("/tmp/a\\b\"c$d`e")).unwrap(),
            "\"/tmp/a\\\\\\\\b\\\\\"c\\\\$d\\\\`e\" --autostart"
        );
        assert!(linux_exec(Path::new("/tmp/new\nline.AppImage")).is_err());
        assert!(linux_exec(Path::new("/tmp/a=b.AppImage")).is_err());
    }
    #[test]
    fn linux_desktop_entry_persists_outer_path_and_respects_hidden() {
        let root = tempfile::tempdir().unwrap();
        let entry = root
            .path()
            .join("custom-config/autostart/com.myeyes.app.desktop");
        assert!(!linux_entry_enabled(&entry).unwrap());
        write_linux_entry(&entry, Path::new("/home/me/Blincho App.AppImage")).unwrap();
        assert!(linux_entry_enabled(&entry).unwrap());
        assert!(std::fs::read_to_string(&entry)
            .unwrap()
            .contains("Exec=\"/home/me/Blincho App.AppImage\" --autostart\n"));
        std::fs::write(&entry, "[Desktop Entry]\nHidden=true\n").unwrap();
        assert!(!linux_entry_enabled(&entry).unwrap());
        write_linux_entry(&entry, Path::new("/usr/bin/blincho")).unwrap();
        assert!(linux_entry_enabled(&entry).unwrap());
        assert_eq!(
            std::fs::read_dir(entry.parent().unwrap()).unwrap().count(),
            1
        );
    }
}
