use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

#[cfg(any(target_os = "linux", test))]
#[path = "symbiote_shortcuts/linux.rs"]
mod linux;
#[cfg(target_os = "windows")]
#[path = "symbiote_shortcuts/windows.rs"]
mod windows;

const DOCUMENT: &[u8] = b"{\"schema\":\"blincho-shortcut/1\"}\n";
const MAX_FILE: u64 = 65_536;
const RECORD: &str = "symbiote-shortcut-v1.json";
const JOURNAL: &str = "symbiote-shortcut-transaction-v1.json";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub mask: u8,
    pub name: String,
}
impl Selection {
    fn validate(&self) -> Result<(), String> {
        if self.mask > 63
            || self.name.is_empty()
            || self.name.len() > 256
            || self.name.chars().count() > 96
            || self.name.chars().any(char::is_control)
        {
            return Err("Invalid shortcut selection".into());
        }
        Ok(())
    }
    fn title(&self) -> String {
        if self.mask == 0 {
            return "Blincho".into();
        }
        let mut clean = String::new();
        for c in self.name.chars() {
            let c = if "<>:\"/\\|?*".contains(c)
                || ('\u{202a}'..='\u{202e}').contains(&c)
                || ('\u{2066}'..='\u{2069}').contains(&c)
            {
                ' '
            } else {
                c
            };
            if clean.len() + c.len_utf8() > 180 {
                break;
            }
            clean.push(c);
        }
        let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        let clean = clean.trim_matches([' ', '.']);
        if clean.is_empty() {
            "Blincho".into()
        } else {
            format!("Blincho · {clean}")
        }
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    exists: bool,
    path: Option<String>,
}
#[derive(Default)]
struct Pending {
    selection: Option<Selection>,
    revision: u64,
    create: bool,
    status: Status,
}
#[derive(Default)]
pub struct Shortcuts {
    pending: Mutex<Pending>,
    operation: Mutex<()>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u8,
    file_name: String,
    bytes: Vec<u8>,
}
struct Context {
    profile: PathBuf,
    desktop: PathBuf,
    target: PathBuf,
}
fn extension() -> &'static str {
    if cfg!(target_os = "macos") {
        "blincho"
    } else if cfg!(target_os = "windows") {
        "lnk"
    } else {
        "desktop"
    }
}
fn context(app: &tauri::AppHandle) -> Result<Option<Context>, String> {
    let runtime = app.state::<crate::Runtime>();
    if crate::channel::is_test(app) && runtime.test_dir.is_none() {
        return Ok(None);
    }
    if runtime.test_dir.is_none() && !crate::startup::is_packaged() {
        return Ok(None);
    }
    let desktop = match &runtime.test_dir {
        Some(path) => path.join("desktop"),
        None => app.path().desktop_dir().map_err(|e| e.to_string())?,
    };
    let target = crate::startup::launch_executable(app)?;
    let profile = runtime.profile.canonicalize().map_err(|e| e.to_string())?;
    let desktop = desktop.canonicalize().unwrap_or(desktop);
    // Runtime data may never be written into the signed package.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = target
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        if bundle.extension().is_some_and(|ext| ext == "app") {
            for path in [&profile, &desktop] {
                let physical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
                if physical.starts_with(bundle) {
                    return Err("Shortcut storage must be outside the application".into());
                }
            }
        }
    }
    Ok(Some(Context {
        profile,
        desktop,
        target,
    }))
}
fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    read_file(path, limit, false)
}
fn read_file(path: &Path, limit: u64, allow_links: bool) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() || meta.len() > limit {
        return Err("Shortcut file is not a regular owned file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !allow_links && meta.nlink() != 1 {
            return Err("Shortcut file has unexpected links".into());
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != meta.dev()
            || opened.ino() != meta.ino()
            || (!allow_links && opened.nlink() != 1)
        {
            return Err("Shortcut changed while reading".into());
        }
    }
    if !opened.is_file() || opened.len() > limit {
        return Err("Invalid shortcut file".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let final_meta = file.metadata().map_err(|e| e.to_string())?;
    if bytes.len() as u64 != opened.len()
        || final_meta.len() != opened.len()
        || final_meta.modified().ok() != opened.modified().ok()
    {
        return Err("Shortcut changed while reading".into());
    }
    Ok(bytes)
}
fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 240
        && name.starts_with("Blincho")
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
        && !name.contains(['/', '\\'])
        && Path::new(name).extension().and_then(|n| n.to_str()) == Some(extension())
}
fn load(ctx: &Context) -> Result<Option<Record>, String> {
    recover(ctx)?;
    let path = ctx.profile.join(RECORD);
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let record: Record =
        serde_json::from_slice(&read_regular(&path, 400_000)?).map_err(|e| e.to_string())?;
    if record.schema != 1
        || record.bytes.len() as u64 > MAX_FILE
        || !valid_file_name(&record.file_name)
    {
        return Err("Shortcut ownership record is invalid".into());
    }
    Ok(Some(record))
}
fn save(ctx: &Context, record: &Record) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(&ctx.profile).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(record).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.persist(ctx.profile.join(RECORD))
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn owned(ctx: &Context, record: &Record) -> Result<bool, String> {
    let path = ctx.desktop.join(&record.file_name);
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(false);
    }
    if read_regular(&path, MAX_FILE)? != record.bytes {
        return Err("Shortcut was edited outside Blincho".into());
    }
    Ok(true)
}
fn status(ctx: &Context) -> Result<Status, String> {
    let record = load(ctx)?;
    let exists = match &record {
        Some(record) => owned(ctx, record)?,
        None => false,
    };
    Ok(Status {
        supported: true,
        exists,
        path: record
            .filter(|_| exists)
            .map(|r| ctx.desktop.join(r.file_name).to_string_lossy().into_owned()),
    })
}
fn random_path(directory: &Path, suffix: &str) -> Result<PathBuf, String> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    Ok(directory.join(format!(
        ".blincho-{}.{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        suffix
    )))
}
fn safe_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.file_type().is_dir() {
        return Err("Shortcut storage is not a regular directory".into());
    }
    Ok(())
}
fn store_icon(ctx: &Context, mask: u8) -> Result<PathBuf, String> {
    let directory = ctx.profile.join("shortcut-icons");
    safe_directory(&directory)?;
    let png = crate::symbiote_icons::png(mask);
    let (bytes, ext) = if cfg!(target_os = "windows") {
        (ico(png), "ico")
    } else {
        (png.to_vec(), "png")
    };
    let path = directory.join(format!("{mask:02x}.{ext}"));
    if path.try_exists().map_err(|e| e.to_string())? && read_regular(&path, 1_048_576)? == bytes {
        return Ok(path);
    }
    // Derived assets live in our private cache. Rebuild a partial cached image
    // atomically from the approved embedded bytes after an interrupted write.
    let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn ico(png: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0];
    bytes.extend_from_slice(&(png.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&22u32.to_le_bytes());
    bytes.extend_from_slice(png);
    bytes
}
#[cfg(target_os = "macos")]
fn set_icon(path: &Path, mask: u8) -> Result<(), String> {
    use std::ffi::CString;
    unsafe extern "C" {
        fn blincho_set_shortcut_icon(
            path: *const std::ffi::c_char,
            bytes: *const u8,
            length: usize,
        ) -> bool;
    }
    let path = CString::new(path.to_str().ok_or("Shortcut path is not UTF-8")?)
        .map_err(|e| e.to_string())?;
    let bytes = crate::symbiote_icons::png(mask);
    if unsafe { blincho_set_shortcut_icon(path.as_ptr(), bytes.as_ptr(), bytes.len()) } {
        Ok(())
    } else {
        Err("Unable to set shortcut icon".into())
    }
}
fn write_shortcut(
    path: &Path,
    ctx: &Context,
    selection: &Selection,
    icon: &Path,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows::write(path, &ctx.target, icon, &selection.title())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let bytes = DOCUMENT.to_vec();
        #[cfg(not(target_os = "macos"))]
        let bytes = linux::contents(&ctx.target, icon, &selection.title())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            let _ = (&ctx.target, icon);
            set_icon(path, selection.mask)?;
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn notify(path: &Path) {
    #[cfg(target_os = "windows")]
    windows::notify(path);
    #[cfg(target_os = "linux")]
    linux::trust(path);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = path;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    next: Record,
    previous: Option<Record>,
    stage: Option<String>,
    backup: Option<String>,
    identity: [u64; 2],
    previous_identity: Option<[u64; 2]>,
}
fn identity(path: &Path) -> Result<[u64; 2], String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        Ok([metadata.dev(), metadata.ino()])
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok([
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ])
    }
}
fn record_valid(record: &Record) -> bool {
    record.schema == 1
        && valid_file_name(&record.file_name)
        && !record.bytes.is_empty()
        && record.bytes.len() as u64 <= MAX_FILE
}
fn temporary_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".blincho-") else {
        return false;
    };
    let Some((random, ext)) = rest.split_once('.') else {
        return false;
    };
    random.len() == 24 && random.bytes().all(|c| c.is_ascii_hexdigit()) && ext == extension()
}
fn persist_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let directory = path.parent().ok_or("Invalid shortcut journal path")?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn matches(path: &Path, bytes: &[u8], expected: [u64; 2]) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
        Ok(_) => Ok(read_file(path, MAX_FILE, true)? == bytes && identity(path)? == expected),
    }
}
fn remove_transaction_file(path: &Path, bytes: &[u8], expected: [u64; 2]) -> Result<(), String> {
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    if !matches(path, bytes, expected)? {
        return Err("Shortcut transaction file was changed".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}
fn recover(ctx: &Context) -> Result<(), String> {
    let journal = ctx.profile.join(JOURNAL);
    if !journal.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let transaction: Transaction =
        serde_json::from_slice(&read_regular(&journal, 800_000)?).map_err(|e| e.to_string())?;
    if !record_valid(&transaction.next)
        || transaction
            .previous
            .as_ref()
            .is_some_and(|r| !record_valid(r))
        || transaction
            .stage
            .as_ref()
            .is_some_and(|s| !temporary_name(s))
        || transaction
            .backup
            .as_ref()
            .is_some_and(|s| !temporary_name(s))
    {
        return Err("Invalid shortcut transaction".into());
    }
    let destination = ctx.desktop.join(&transaction.next.file_name);
    if matches(&destination, &transaction.next.bytes, transaction.identity)? {
        if let Some(stage) = &transaction.stage {
            remove_transaction_file(
                &ctx.desktop.join(stage),
                &transaction.next.bytes,
                transaction.identity,
            )?;
        }
        if let (Some(previous), Some(previous_id)) =
            (&transaction.previous, transaction.previous_identity)
        {
            let old = ctx.desktop.join(&previous.file_name);
            if old != destination {
                // Once next is published, a replacement at the old visible name
                // belongs to its new owner and must not block committing next.
                match fs::symlink_metadata(&old) {
                    Ok(meta) if meta.file_type().is_file() => {
                        if identity(&old)? == previous_id
                            && matches(&old, &previous.bytes, previous_id)?
                        {
                            remove_transaction_file(&old, &previous.bytes, previous_id)?;
                        }
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
            if let Some(backup) = &transaction.backup {
                remove_transaction_file(&ctx.desktop.join(backup), &previous.bytes, previous_id)?;
            }
        }
        // Unknown additional hardlinks never become owned during recovery.
        if read_regular(&destination, MAX_FILE)? != transaction.next.bytes {
            return Err("Shortcut changed during recovery".into());
        }
        save(ctx, &transaction.next)?;
    } else {
        // Publication did not complete. Restore our exact previous file, keeping
        // any unrelated destination intact. A later explicit retry can proceed.
        if let (Some(previous), Some(previous_id)) =
            (&transaction.previous, transaction.previous_identity)
        {
            let old = ctx.desktop.join(&previous.file_name);
            if let Some(backup) = &transaction.backup {
                let backup = ctx.desktop.join(backup);
                if matches(&backup, &previous.bytes, previous_id)? {
                    if !old.try_exists().map_err(|e| e.to_string())? {
                        fs::hard_link(&backup, &old).map_err(|e| e.to_string())?;
                    }
                    if !matches(&old, &previous.bytes, previous_id)? {
                        return Err("Previous shortcut name is occupied".into());
                    }
                    remove_transaction_file(&backup, &previous.bytes, previous_id)?;
                }
            }
            if !matches(&old, &previous.bytes, previous_id)? {
                return Err("Previous shortcut changed during recovery".into());
            }
            if read_regular(&old, MAX_FILE)? != previous.bytes {
                return Err("Unknown shortcut links".into());
            }
            save(ctx, previous)?;
        }
        if let Some(stage) = &transaction.stage {
            remove_transaction_file(
                &ctx.desktop.join(stage),
                &transaction.next.bytes,
                transaction.identity,
            )?;
        }
    }
    fs::remove_file(journal).map_err(|e| e.to_string())
}
fn sync(ctx: &Context, selection: &Selection, create: bool) -> Result<Status, String> {
    let previous = load(ctx)?;
    let exists = match &previous {
        Some(record) => owned(ctx, record)?,
        None => false,
    };
    if !exists && !create {
        return Ok(Status {
            supported: true,
            ..Status::default()
        });
    }
    safe_directory(&ctx.desktop)?;
    let file_name = format!("{}.{}", selection.title(), extension());
    let destination = ctx.desktop.join(&file_name);
    let previous = previous.filter(|_| exists);
    let old_path = previous.as_ref().map(|r| ctx.desktop.join(&r.file_name));
    if destination.try_exists().map_err(|e| e.to_string())?
        && old_path.as_ref() != Some(&destination)
    {
        return Err("A different file already uses this shortcut name".into());
    }
    let icon = store_icon(ctx, selection.mask)?;
    #[cfg(target_os = "macos")]
    if let (Some(record), Some(old_path)) = (&previous, &old_path) {
        let id = identity(old_path)?;
        let transaction = Transaction {
            next: Record {
                schema: 1,
                file_name,
                bytes: record.bytes.clone(),
            },
            previous: previous.clone(),
            stage: None,
            backup: None,
            identity: id,
            previous_identity: Some(id),
        };
        persist_json(&ctx.profile.join(JOURNAL), &transaction)?;
        let result = (|| {
            if &destination != old_path {
                fs::hard_link(old_path, &destination).map_err(|e| e.to_string())?;
            }
            set_icon(&destination, selection.mask)?;
            recover(ctx)
        })();
        if let Err(error) = result {
            let _ = recover(ctx);
            return Err(error);
        }
        return status(ctx);
    }
    let staged = random_path(&ctx.desktop, extension())?;
    let result = (|| {
        write_shortcut(&staged, ctx, selection, &icon)?;
        let bytes = read_regular(&staged, MAX_FILE)?;
        let id = identity(&staged)?;
        let previous_id = old_path.as_ref().map(|path| identity(path)).transpose()?;
        let backup = old_path
            .as_ref()
            .map(|_| random_path(&ctx.desktop, extension()))
            .transpose()?;
        let transaction = Transaction {
            next: Record {
                schema: 1,
                file_name,
                bytes,
            },
            previous: previous.clone(),
            stage: Some(staged.file_name().unwrap().to_string_lossy().into_owned()),
            backup: backup
                .as_ref()
                .map(|p| p.file_name().unwrap().to_string_lossy().into_owned()),
            identity: id,
            previous_identity: previous_id,
        };
        persist_json(&ctx.profile.join(JOURNAL), &transaction)?;
        let publish = (|| {
            if let (Some(record), Some(old_path), Some(backup)) = (&previous, &old_path, &backup) {
                if !owned(ctx, record)? {
                    return Err("Shortcut disappeared during update".into());
                }
                fs::rename(old_path, backup).map_err(|e| e.to_string())?;
            }
            fs::hard_link(&staged, &destination).map_err(|e| e.to_string())?;
            recover(ctx)
        })();
        if let Err(error) = publish {
            let _ = recover(ctx);
            return Err(error);
        }
        Ok(())
    })();
    // Keep an outstanding journal's staging link for restart reconciliation.
    if !ctx.profile.join(JOURNAL).exists() {
        let _ = fs::remove_file(staged);
    }
    result?;
    notify(&destination);
    status(ctx)
}

async fn request(
    app: tauri::AppHandle,
    selection: Selection,
    create: bool,
) -> Result<Status, String> {
    selection.validate()?;
    {
        let state = app.state::<Shortcuts>();
        let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
        pending.selection = Some(selection);
        pending.revision += 1;
        pending.create |= create;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        loop {
            let (selection, revision, create) = {
                let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
                let selection = pending
                    .selection
                    .clone()
                    .ok_or("Shortcut selection unavailable")?;
                let create = pending.create;
                pending.create = false;
                (selection, pending.revision, create)
            };
            let value = match context(&app)? {
                Some(ctx) => sync(&ctx, &selection, create)?,
                None => Status::default(),
            };
            let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
            pending.status = value.clone();
            if pending.revision == revision {
                return Ok(value);
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_symbiote_shortcut(
    app: tauri::AppHandle,
    selection: Selection,
) -> Result<Status, String> {
    request(app, selection, false).await
}
#[tauri::command]
pub async fn create_symbiote_shortcut(
    app: tauri::AppHandle,
    selection: Selection,
) -> Result<Status, String> {
    request(app, selection, true).await
}
#[tauri::command]
pub fn symbiote_shortcut_status(app: tauri::AppHandle) -> Result<Status, String> {
    let state = app.state::<Shortcuts>();
    let _operation = state.operation.lock().map_err(|e| e.to_string())?;
    context(&app)?
        .map(|ctx| status(&ctx))
        .unwrap_or(Ok(Status::default()))
}
#[tauri::command]
pub fn show_symbiote_shortcut(app: tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<Shortcuts>();
    let _operation = state.operation.lock().map_err(|e| e.to_string())?;
    let Some(ctx) = context(&app)? else {
        return Ok(false);
    };
    let Some(record) = load(&ctx)? else {
        return Ok(false);
    };
    if !owned(&ctx, &record)? {
        return Ok(false);
    }
    let path = ctx.desktop.join(record.file_name);
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        unsafe extern "C" {
            fn blincho_reveal_shortcut(path: *const std::ffi::c_char);
        }
        let path = CString::new(path.to_str().ok_or("Shortcut path is not UTF-8")?)
            .map_err(|e| e.to_string())?;
        app.run_on_main_thread(move || unsafe {
            blincho_reveal_shortcut(path.as_ptr());
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&ctx.desktop)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(true)
}
pub fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("blincho"))
        && read_regular(path, 128).is_ok_and(|bytes| bytes == DOCUMENT)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_flat_bounded_and_preserve_localized_text() {
        for name in [
            "../../bad:icon?*",
            "עברית",
            "守护者",
            "Хранитель",
            "a\u{202e}exe",
        ] {
            let selection = Selection {
                mask: 63,
                name: name.into(),
            };
            selection.validate().unwrap();
            let title = selection.title();
            assert!(title.len() < 220);
            assert!(!title.contains(['/', '\\', ':', '?', '*', '\u{202e}']));
        }
        assert_eq!(
            Selection {
                mask: 0,
                name: "Блинчо".into()
            }
            .title(),
            "Blincho"
        );
        assert!(Selection {
            mask: 64,
            name: "bad".into()
        }
        .validate()
        .is_err());
        assert!(Selection {
            mask: 0,
            name: "a\nb".into()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn document_is_only_a_bounded_marker_and_does_not_carry_commands() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Blincho.blincho");
        fs::write(&path, DOCUMENT).unwrap();
        assert!(is_document(&path));
        fs::write(
            &path,
            b"{\"schema\":\"blincho-shortcut/1\",\"command\":\"anything\"}",
        )
        .unwrap();
        assert!(!is_document(&path));
        fs::write(&path, vec![1; 129]).unwrap();
        assert!(!is_document(&path));
    }
    #[test]
    fn ownership_detects_deletion_edits_and_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Context {
            profile: dir.path().into(),
            desktop: dir.path().join("desktop"),
            target: "/opt/blincho".into(),
        };
        fs::create_dir(&ctx.desktop).unwrap();
        let record = Record {
            schema: 1,
            file_name: format!("Blincho.{}", extension()),
            bytes: DOCUMENT.into(),
        };
        save(&ctx, &record).unwrap();
        assert!(!owned(&ctx, &record).unwrap());
        fs::write(ctx.desktop.join(&record.file_name), DOCUMENT).unwrap();
        assert!(owned(&ctx, &record).unwrap());
        fs::write(ctx.desktop.join(&record.file_name), b"edited").unwrap();
        assert!(owned(&ctx, &record).is_err());
        assert!(!valid_file_name("Blincho/../../other.blincho"));
        #[cfg(unix)]
        {
            fs::remove_file(ctx.desktop.join(&record.file_name)).unwrap();
            std::os::unix::fs::symlink(
                ctx.profile.join(RECORD),
                ctx.desktop.join(&record.file_name),
            )
            .unwrap();
            assert!(owned(&ctx, &record).is_err());
        }
    }
    #[test]
    fn ico_contains_one_png_backed_256_pixel_image() {
        for mask in 0..64 {
            let png = crate::symbiote_icons::png(mask);
            let bytes = ico(png);
            assert_eq!(&bytes[..6], &[0, 0, 1, 0, 1, 0]);
            assert_eq!(u32::from_le_bytes(bytes[18..22].try_into().unwrap()), 22);
            assert_eq!(&bytes[22..], png);
        }
    }
    #[test]
    fn interrupted_creation_and_rename_recover_without_accepting_unknown_links() {
        for rename in [false, true] {
            for committed in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let ctx = Context {
                    profile: dir.path().into(),
                    desktop: dir.path().join("desktop"),
                    target: "/opt/blincho".into(),
                };
                fs::create_dir(&ctx.desktop).unwrap();
                let old_name = format!("Blincho.{}", extension());
                let old = ctx.desktop.join(&old_name);
                let source = if rename {
                    old.clone()
                } else {
                    random_path(&ctx.desktop, extension()).unwrap()
                };
                fs::write(&source, DOCUMENT).unwrap();
                let id = identity(&source).unwrap();
                let previous = rename.then(|| Record {
                    schema: 1,
                    file_name: old_name,
                    bytes: DOCUMENT.into(),
                });
                if let Some(previous) = &previous {
                    save(&ctx, previous).unwrap();
                }
                let next = Record {
                    schema: 1,
                    file_name: format!("Blincho · Guardian.{}", extension()),
                    bytes: DOCUMENT.into(),
                };
                let destination = ctx.desktop.join(&next.file_name);
                let transaction = Transaction {
                    next: next.clone(),
                    previous,
                    stage: (!rename)
                        .then(|| source.file_name().unwrap().to_str().unwrap().to_owned()),
                    backup: None,
                    identity: id,
                    previous_identity: rename.then_some(id),
                };
                persist_json(&ctx.profile.join(JOURNAL), &transaction).unwrap();
                fs::hard_link(&source, &destination).unwrap();
                if committed {
                    save(&ctx, &next).unwrap();
                }
                // This disk state is what remains if the process stops before cleanup.
                recover(&ctx).unwrap();
                assert_eq!(read_regular(&destination, MAX_FILE).unwrap(), DOCUMENT);
                assert!(owned(&ctx, &load(&ctx).unwrap().unwrap()).unwrap());
                assert!(!source.exists());
                assert!(!ctx.profile.join(JOURNAL).exists());
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn published_recovery_preserves_a_foreign_replacement_at_the_previous_name() {
        for backup_mode in [false, true] {
            for symlink in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let ctx = Context {
                    profile: dir.path().into(),
                    desktop: dir.path().join("desktop"),
                    target: "/opt/blincho".into(),
                };
                fs::create_dir(&ctx.desktop).unwrap();
                let previous = Record {
                    schema: 1,
                    file_name: format!("Blincho.{}", extension()),
                    bytes: DOCUMENT.into(),
                };
                let old = ctx.desktop.join(&previous.file_name);
                fs::write(&old, DOCUMENT).unwrap();
                let previous_id = identity(&old).unwrap();
                save(&ctx, &previous).unwrap();
                let backup = backup_mode.then(|| random_path(&ctx.desktop, extension()).unwrap());
                let stage = backup_mode.then(|| random_path(&ctx.desktop, extension()).unwrap());
                if let Some(backup) = &backup {
                    fs::rename(&old, backup).unwrap();
                }
                if let Some(stage) = &stage {
                    fs::write(stage, DOCUMENT).unwrap();
                }
                let source = stage.as_deref().unwrap_or(&old);
                let next = Record {
                    schema: 1,
                    file_name: format!("Blincho · Next.{}", extension()),
                    bytes: DOCUMENT.into(),
                };
                let destination = ctx.desktop.join(&next.file_name);
                let next_id = identity(source).unwrap();
                fs::hard_link(source, &destination).unwrap();
                if !backup_mode {
                    fs::remove_file(&old).unwrap();
                }
                let foreign = dir.path().join("foreign");
                fs::write(&foreign, b"unrelated").unwrap();
                if symlink {
                    std::os::unix::fs::symlink(&foreign, &old).unwrap();
                } else {
                    // Even identical document bytes do not authorize a foreign inode.
                    fs::write(&old, DOCUMENT).unwrap();
                }
                let foreign_id = identity(&old).unwrap();
                let transaction = Transaction {
                    next: next.clone(),
                    previous: Some(previous),
                    stage: stage
                        .as_ref()
                        .map(|p| p.file_name().unwrap().to_str().unwrap().into()),
                    backup: backup
                        .as_ref()
                        .map(|p| p.file_name().unwrap().to_str().unwrap().into()),
                    identity: next_id,
                    previous_identity: Some(previous_id),
                };
                persist_json(&ctx.profile.join(JOURNAL), &transaction).unwrap();
                recover(&ctx).unwrap();
                assert_eq!(identity(&old).unwrap(), foreign_id);
                assert_eq!(fs::read(&foreign).unwrap(), b"unrelated");
                assert_eq!(load(&ctx).unwrap().unwrap().file_name, next.file_name);
                assert!(status(&ctx).unwrap().exists);
                assert!(!ctx.profile.join(JOURNAL).exists());
                if let Some(backup) = backup {
                    assert!(!backup.exists());
                }
                if let Some(stage) = stage {
                    assert!(!stage.exists());
                }
            }
        }
    }
    #[test]
    fn unpublished_transaction_restores_the_previous_file_and_preserves_a_collision() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Context {
            profile: dir.path().into(),
            desktop: dir.path().join("desktop"),
            target: "/opt/blincho".into(),
        };
        fs::create_dir(&ctx.desktop).unwrap();
        let previous = Record {
            schema: 1,
            file_name: format!("Blincho.{}", extension()),
            bytes: b"previous".to_vec(),
        };
        let old = ctx.desktop.join(&previous.file_name);
        fs::write(&old, &previous.bytes).unwrap();
        let previous_id = identity(&old).unwrap();
        save(&ctx, &previous).unwrap();
        let stage = random_path(&ctx.desktop, extension()).unwrap();
        fs::write(&stage, b"next").unwrap();
        let stage_id = identity(&stage).unwrap();
        let next = Record {
            schema: 1,
            file_name: format!("Blincho · Next.{}", extension()),
            bytes: b"next".to_vec(),
        };
        let destination = ctx.desktop.join(&next.file_name);
        // Same bytes do not authorize a foreign file with a different identity.
        fs::write(&destination, b"next").unwrap();
        let backup = random_path(&ctx.desktop, extension()).unwrap();
        let transaction = Transaction {
            next,
            previous: Some(previous.clone()),
            stage: Some(stage.file_name().unwrap().to_str().unwrap().into()),
            backup: Some(backup.file_name().unwrap().to_str().unwrap().into()),
            identity: stage_id,
            previous_identity: Some(previous_id),
        };
        persist_json(&ctx.profile.join(JOURNAL), &transaction).unwrap();
        fs::rename(&old, &backup).unwrap();
        recover(&ctx).unwrap();
        assert_eq!(read_regular(&old, MAX_FILE).unwrap(), b"previous");
        assert_eq!(fs::read(&destination).unwrap(), b"next");
        assert!(!stage.exists());
        assert!(!backup.exists());
        assert_eq!(load(&ctx).unwrap().unwrap().file_name, previous.file_name);
    }
    #[cfg(unix)]
    #[test]
    fn recovery_never_removes_an_unknown_hardlink() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Context {
            profile: dir.path().into(),
            desktop: dir.path().join("desktop"),
            target: "/opt/blincho".into(),
        };
        fs::create_dir(&ctx.desktop).unwrap();
        let stage = random_path(&ctx.desktop, extension()).unwrap();
        fs::write(&stage, DOCUMENT).unwrap();
        let next = Record {
            schema: 1,
            file_name: format!("Blincho.{}", extension()),
            bytes: DOCUMENT.into(),
        };
        let destination = ctx.desktop.join(&next.file_name);
        let unknown = dir.path().join("user-copy");
        let transaction = Transaction {
            next,
            previous: None,
            stage: Some(stage.file_name().unwrap().to_str().unwrap().into()),
            backup: None,
            identity: identity(&stage).unwrap(),
            previous_identity: None,
        };
        persist_json(&ctx.profile.join(JOURNAL), &transaction).unwrap();
        fs::hard_link(&stage, &destination).unwrap();
        fs::hard_link(&stage, &unknown).unwrap();
        assert!(recover(&ctx).is_err());
        assert!(unknown.exists());
        assert!(ctx.profile.join(JOURNAL).exists());
        fs::remove_file(&unknown).unwrap();
        recover(&ctx).unwrap();
        assert!(status(&ctx).unwrap().exists);
    }
}
