use super::{may_restore_focus, parsing, MeetingStatus, Presence};
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use windows::{
    core::{Interface, GUID, HSTRING, PCWSTR},
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    Win32::{
        Media::Audio::{
            eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
            IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                StructuredStorage::PROPVARIANT, CLSCTX_ALL, COINIT_MULTITHREADED,
            },
            Variant::VT_LPWSTR,
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
        UI::Shell::{
            FOLDERID_CommonPrograms, FOLDERID_Programs, IShellLinkW,
            PropertiesSystem::IPropertyStore, SHGetKnownFolderPath, SHStrDupW,
            SetCurrentProcessExplicitAppUserModelID, ShellLink, KF_FLAG_DEFAULT,
        },
    },
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, FILETIME, HWND, LPARAM, LRESULT, WPARAM},
    Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME},
    System::{
        LibraryLoader::GetModuleHandleW,
        RemoteDesktop::*,
        SystemInformation::GetTickCount,
        Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::{
        Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        Shell::ShellExecuteW,
        WindowsAndMessaging::*,
    },
};

#[derive(Clone, Debug)]
pub struct FocusTarget {
    window: usize,
    process: u32,
    created: u64,
}
fn window_process(window: HWND) -> Option<u32> {
    if window.is_null() || unsafe { IsWindow(window) } == 0 {
        return None;
    }
    let mut process = 0;
    (unsafe { GetWindowThreadProcessId(window, &mut process) } != 0 && process != 0)
        .then_some(process)
}
fn process_created(process: u32) -> Option<u64> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process) };
    if handle.is_null() {
        return None;
    }
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let success =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0 };
    unsafe { CloseHandle(handle) };
    success.then_some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}
pub fn capture_focus() -> Option<FocusTarget> {
    let window = unsafe { GetForegroundWindow() };
    let process = window_process(window)?;
    if process == std::process::id() {
        return None;
    }
    let created = process_created(process)?;
    Some(FocusTarget {
        window: window as usize,
        process,
        created,
    })
}
pub fn restore_focus(target: &FocusTarget) -> Result<(), String> {
    let window = target.window as HWND;
    // Recheck both HWND ownership and process creation time: either identifier
    // may have been reused after the original application closed.
    let original = window_process(window) == Some(target.process)
        && process_created(target.process) == Some(target.created);
    let foreground = window_process(unsafe { GetForegroundWindow() });
    if !may_restore_focus(std::process::id(), foreground, target.process, original) {
        return Ok(());
    }
    if unsafe { SetForegroundWindow(window) } != 0 {
        Ok(())
    } else {
        Err("Could not restore window focus".into())
    }
}

static POWER_CALLBACK: OnceLock<extern "C" fn(i32)> = OnceLock::new();
static CLICKED: OnceLock<extern "C" fn()> = OnceLock::new();
static NOTIFICATION_IDENTITY: OnceLock<Result<(), String>> = OnceLock::new();
static TOASTS: Mutex<Vec<ToastNotification>> = Mutex::new(Vec::new());
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub fn presence() -> Presence {
    let mut last = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    let idle_seconds = (unsafe { GetLastInputInfo(&mut last) } != 0)
        .then(|| parsing::windows_idle_seconds(unsafe { GetTickCount() }, last.dwTime));
    let mut buffer = null_mut();
    let mut bytes = 0;
    let success = unsafe {
        WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
    } != 0;
    let locked =
        if success && !buffer.is_null() && bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = unsafe { &*buffer.cast::<WTSINFOEXW>() };
            if info.Level == 1 {
                let session = unsafe { info.Data.WTSInfoExLevel1 };
                if session.SessionState != WTSActive {
                    Some(true)
                } else {
                    match session.SessionFlags as u32 {
                        WTS_SESSIONSTATE_LOCK => Some(true),
                        WTS_SESSIONSTATE_UNLOCK => Some(false),
                        _ => None,
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
    if !buffer.is_null() {
        unsafe {
            WTSFreeMemory(buffer.cast());
        }
    }
    Presence {
        idle_seconds,
        locked,
    }
}
unsafe extern "system" fn power_window(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let code = match message {
        WM_POWERBROADCAST => match wparam as u32 {
            PBT_APMSUSPEND => Some(1),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND | PBT_APMRESUMECRITICAL => Some(2),
            _ => None,
        },
        WM_WTSSESSION_CHANGE => match wparam as u32 {
            WTS_SESSION_LOCK
            | WTS_CONSOLE_DISCONNECT
            | WTS_REMOTE_DISCONNECT
            | WTS_SESSION_LOGOFF => Some(3),
            WTS_SESSION_UNLOCK | WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT | WTS_SESSION_LOGON => {
                Some(4)
            }
            _ => None,
        },
        WM_DESTROY => {
            PostQuitMessage(0);
            None
        }
        _ => None,
    };
    if let Some(code) = code {
        if let Some(callback) = POWER_CALLBACK.get() {
            callback(code);
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}
pub fn observe_power(callback: extern "C" fn(i32)) -> Result<(), String> {
    if POWER_CALLBACK.set(callback).is_err() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("native-power".into())
        .spawn(move || unsafe {
            let class_name = wide("BlinchoPowerObserver");
            let instance = GetModuleHandleW(null());
            let class = WNDCLASSW {
                lpfnWndProc: Some(power_window),
                hInstance: instance,
                lpszClassName: class_name.as_ptr(),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                let _ = sender.send(Err(format!(
                    "Power observer class failed: {}",
                    GetLastError()
                )));
                return;
            }
            // An invisible top-level window receives power broadcasts; message-only
            // windows do not receive broadcast messages.
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            if hwnd.is_null() {
                let _ = sender.send(Err(format!(
                    "Power observer window failed: {}",
                    GetLastError()
                )));
                return;
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                let _ = sender.send(Err(format!("Session observer failed: {}", GetLastError())));
                DestroyWindow(hwnd);
                return;
            }
            let _ = sender.send(Ok(()));
            let mut message = MSG::default();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            WTSUnRegisterSessionNotification(hwnd);
            DestroyWindow(hwnd);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?
}
pub fn power_source() -> &'static str {
    "Win32 power broadcasts/WTS session notifications"
}
pub fn notifications_initialize(clicked: extern "C" fn()) {
    let _ = CLICKED.set(clicked);
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self, String> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).map_err(|error| error.to_string())?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}
fn isolated_notifications() -> bool {
    cfg!(test) || std::env::var_os("BLINCHO_PROTOTYPE_TEST_DIR").is_some()
}
fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn known_programs(folder: &GUID) -> Result<PathBuf, String> {
    unsafe {
        let value = SHGetKnownFolderPath(folder, KF_FLAG_DEFAULT, None)
            .map_err(|error| error.to_string())?;
        let path = value
            .to_string()
            .map(PathBuf::from)
            .map_err(|error| error.to_string());
        CoTaskMemFree(Some(value.0.cast()));
        path
    }
}
fn notification_identity(identifier: &str) -> Result<(), String> {
    NOTIFICATION_IDENTITY
        .get_or_init(|| {
            let app_id = wide(identifier);
            unsafe {
                SetCurrentProcessExplicitAppUserModelID(PCWSTR(app_id.as_ptr()))
                    .map_err(|error| error.to_string())?;
            }
            let programs = known_programs(&FOLDERID_Programs)?;
            let mut locations = vec![programs.clone()];
            if let Ok(common) = known_programs(&FOLDERID_CommonPrograms) {
                locations.push(common);
            }
            // NSIS/MSI may already own the app shortcut. Do not overwrite it.
            if locations.iter().any(|directory| {
                [
                    directory.join("Blincho.lnk"),
                    directory.join("Blincho").join("Blincho.lnk"),
                ]
                .iter()
                .any(|path| path.is_file())
            }) {
                return Ok(());
            }
            std::fs::create_dir_all(&programs).map_err(|error| error.to_string())?;
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let executable_wide = wide_path(&executable);
            let shortcut = programs.join("Blincho.lnk");
            // Save to a temporary path, then move without replacing any existing file.
            let temporary = tempfile::Builder::new()
                .prefix("blincho-notification-")
                .suffix(".lnk")
                .tempfile_in(&programs)
                .map_err(|error| error.to_string())?
                .into_temp_path();
            let temporary_wide = wide_path(&temporary);
            unsafe {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL)
                    .map_err(|error| error.to_string())?;
                link.SetPath(PCWSTR(executable_wide.as_ptr()))
                    .map_err(|error| error.to_string())?;
                link.SetArguments(PCWSTR(wide("").as_ptr()))
                    .map_err(|error| error.to_string())?;
                link.SetDescription(PCWSTR(wide("Blincho").as_ptr()))
                    .map_err(|error| error.to_string())?;
                link.SetIconLocation(PCWSTR(executable_wide.as_ptr()), 0)
                    .map_err(|error| error.to_string())?;
                if let Some(directory) = executable.parent() {
                    link.SetWorkingDirectory(PCWSTR(wide_path(directory).as_ptr()))
                        .map_err(|error| error.to_string())?;
                }
                let properties: IPropertyStore = link.cast().map_err(|error| error.to_string())?;
                // PKEY_AppUserModel_ID expects VT_LPWSTR, matching the Windows SDK's
                // InitPropVariantFromString. PROPVARIANT frees this owned string.
                let mut value = PROPVARIANT::default();
                (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
                (*value.Anonymous.Anonymous).Anonymous.pwszVal =
                    SHStrDupW(PCWSTR(app_id.as_ptr())).map_err(|error| error.to_string())?;
                properties
                    .SetValue(&PKEY_AppUserModel_ID, &value)
                    .map_err(|error| error.to_string())?;
                properties.Commit().map_err(|error| error.to_string())?;
                let file: IPersistFile = link.cast().map_err(|error| error.to_string())?;
                file.Save(PCWSTR(temporary_wide.as_ptr()), true)
                    .map_err(|error| error.to_string())?;
            }
            match temporary.persist_noclobber(&shortcut) {
                Ok(()) => Ok(()),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(error) => Err(error.error.to_string()),
            }
        })
        .clone()
}
pub async fn notification_permission(app: &tauri::AppHandle) -> Result<bool, String> {
    if isolated_notifications() {
        return Ok(false);
    }
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _apartment = Apartment::new()?;
        notification_identity(&identifier)?;
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identifier))
                .map_err(|error| error.to_string())?;
        notifier
            .Setting()
            .map(|setting| setting == NotificationSetting::Enabled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub async fn notification_send(
    app: &tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    if isolated_notifications() {
        return Ok(false);
    }
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _apartment = Apartment::new()?;
        notification_identity(&identifier)?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(identifier)).map_err(|error| error.to_string())?;
        if notifier.Setting().map_err(|error| error.to_string())? != NotificationSetting::Enabled { return Ok(false); }
        let xml = XmlDocument::new().map_err(|error| error.to_string())?;
        xml.LoadXml(&HSTRING::from(format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>", escape_xml(&title), escape_xml(&body)))).map_err(|error| error.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&xml).map_err(|error| error.to_string())?;
        toast.Activated(&TypedEventHandler::new(|_, _| { if let Some(clicked) = CLICKED.get() { clicked(); } Ok(()) })).map_err(|error| error.to_string())?;
        notifier.Show(&toast).map_err(|error| error.to_string())?;
        // Retain the event source while the process is running. Windows may suppress
        // a successfully submitted toast under focus assist or user policy.
        let mut retained = TOASTS.lock().map_err(|error| error.to_string())?;
        if retained.len() == 32 { retained.remove(0); }
        retained.push(toast);
        Ok(true)
    }).await.map_err(|error| error.to_string())?
}
pub fn preferred_languages() -> Vec<String> {
    let mut count = 0;
    let mut length = 0;
    if unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, null_mut(), &mut length)
    } == 0
        || length == 0
        || length > 65536
    {
        return vec![];
    }
    let mut buffer = vec![0u16; length as usize];
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } == 0
    {
        return vec![];
    }
    parsing::normalize_languages(
        buffer
            .split(|character| *character == 0)
            .filter(|part| !part.is_empty())
            .map(String::from_utf16_lossy),
    )
}
pub fn open_external(url: &str) -> Result<(), String> {
    let operation = wide("open");
    let url = wide(url);
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!("Could not open external link: {}", result as isize))
    }
}
fn capture_meeting() -> Result<Vec<String>, String> {
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
        let _com = Com;
        let mut applications = Vec::new();
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| error.to_string())?;
        let devices = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|error| error.to_string())?;
        let mut complete = true;
        for device_index in 0..devices.GetCount().map_err(|error| error.to_string())? {
            let scan = (|| -> Result<(), String> {
                let device = devices
                    .Item(device_index)
                    .map_err(|error| error.to_string())?;
                let manager: IAudioSessionManager2 = device
                    .Activate(CLSCTX_ALL, None)
                    .map_err(|error| error.to_string())?;
                let sessions = manager
                    .GetSessionEnumerator()
                    .map_err(|error| error.to_string())?;
                for session_index in 0..sessions.GetCount().map_err(|error| error.to_string())? {
                    let session = sessions
                        .GetSession(session_index)
                        .map_err(|error| error.to_string())?;
                    if session.GetState().map_err(|error| error.to_string())?
                        != AudioSessionStateActive
                    {
                        continue;
                    }
                    let details: IAudioSessionControl2 =
                        session.cast().map_err(|error| error.to_string())?;
                    let pid = details.GetProcessId().map_err(|error| error.to_string())?;
                    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                    if process.is_null() {
                        complete = false;
                        continue;
                    }
                    let mut image = vec![0u16; 32768];
                    let mut length = image.len() as u32;
                    let success =
                        QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length)
                            != 0;
                    CloseHandle(process);
                    if !success {
                        complete = false;
                        continue;
                    }
                    if let Some(application) = parsing::meeting_application(
                        &String::from_utf16_lossy(&image[..length as usize]),
                    ) {
                        applications.push(application.to_string());
                    }
                }
                Ok(())
            })();
            if scan.is_err() {
                complete = false;
            }
        }
        parsing::capture_applications_result(applications, complete)
            .ok_or_else(|| "Microphone process information unavailable".into())
    }
}
pub fn meeting_status() -> MeetingStatus {
    match capture_meeting() {
        Ok(applications) => MeetingStatus::detected(applications, true),
        Err(_) => MeetingStatus::inactive(false),
    }
}
pub fn meeting_supported() -> bool {
    meeting_status().supported
}
