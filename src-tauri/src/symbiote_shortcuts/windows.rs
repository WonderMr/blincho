//! A separate, application-owned Desktop launcher. Call only with internally
//! generated paths; the controller owns path validation, staging cleanup and the
//! final atomic rename. Never call this adapter for installed or discovered links.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    marker::PhantomData,
    os::windows::ffi::OsStrExt,
    path::Path,
    rc::Rc,
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::{E_NOINTERFACE, RPC_E_CHANGED_MODE},
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                StructuredStorage::PROPVARIANT, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                COINIT_DISABLE_OLE1DDE,
            },
            Variant::VT_LPWSTR,
        },
        UI::Shell::{
            IShellLinkW, PropertiesSystem::IPropertyStore, SHChangeNotify, SHStrDupW, ShellLink,
            SHCNE_UPDATEITEM, SHCNF_FLUSHNOWAIT, SHCNF_PATHW,
        },
    },
};

// SHCNF_PATHW accepts MAX_PATH, including the terminating NUL. Keep every Shell
// path within the same bound rather than silently omitting change notifications.
const MAX_PATH_UNITS: usize = 259;
const MAX_TITLE_UNITS: usize = 255;
const APP_ID: &str = "com.myeyes.app";

fn com_error(operation: &str, error: windows::core::Error) -> String {
    format!(
        "{operation} failed (HRESULT 0x{:08X})",
        error.code().0 as u32
    )
}

fn io_error(operation: &str, error: io::Error) -> String {
    format!("{operation} failed ({:?})", error.kind())
}

fn checked_wide(
    units: impl IntoIterator<Item = u16>,
    limit: usize,
    label: &str,
) -> Result<Vec<u16>, String> {
    let mut result = Vec::with_capacity(limit + 1);
    for unit in units {
        if unit == 0 || result.len() == limit {
            return Err(format!("Invalid {label}"));
        }
        result.push(unit);
    }
    if result.is_empty() {
        return Err(format!("Invalid {label}"));
    }
    result.push(0);
    Ok(result)
}

fn wide_path(path: &Path, label: &str) -> Result<Vec<u16>, String> {
    if !path.is_absolute() {
        return Err(format!("Invalid {label}"));
    }
    checked_wide(path.as_os_str().encode_wide(), MAX_PATH_UNITS, label)
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn regular_file(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(label, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("Invalid {label}"));
    }
    Ok(metadata)
}

fn icon_header_valid(header: &[u8; 6], file_len: u64) -> bool {
    let images = u16::from_le_bytes([header[4], header[5]]);
    header[..4] == [0, 0, 1, 0]
        && (1..=256).contains(&images)
        && file_len >= 6 + 16 * u64::from(images)
}

fn validate_icon(icon: &Path) -> Result<(), String> {
    if !has_extension(icon, "ico") {
        return Err("Shortcut icon must be an ICO file".into());
    }
    let metadata = regular_file(icon, "shortcut icon")?;
    let mut file = File::open(icon).map_err(|error| io_error("Read shortcut icon", error))?;
    let mut header = [0; 6];
    file.read_exact(&mut header)
        .map_err(|error| io_error("Read shortcut icon", error))?;
    if !icon_header_valid(&header, metadata.len()) {
        return Err("Invalid shortcut ICO header".into());
    }
    Ok(())
}

// A successful CoInitializeEx, including S_FALSE, owns one matching uninitialize.
// RPC_E_CHANGED_MODE means the caller already owns an initialized apartment.
// This guard cannot be transferred to another thread.
struct Apartment {
    owned: bool,
    _thread: PhantomData<Rc<()>>,
}

impl Apartment {
    fn new() -> Result<Self, String> {
        let status =
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        let owned = if status.is_ok() {
            true
        } else if status == RPC_E_CHANGED_MODE {
            false
        } else {
            return Err(com_error("Initialize shortcut COM", status.into()));
        };
        Ok(Self {
            owned,
            _thread: PhantomData,
        })
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.owned {
            unsafe { CoUninitialize() };
        }
    }
}

fn set_identity(link: &IShellLinkW) -> Result<(), String> {
    let properties: IPropertyStore = match link.cast() {
        Ok(properties) => properties,
        Err(error) if error.code() == E_NOINTERFACE => return Ok(()),
        Err(error) => return Err(com_error("Read shortcut properties", error)),
    };
    let app_id = checked_wide(APP_ID.encode_utf16(), MAX_TITLE_UNITS, "application ID")?;
    unsafe {
        // The property requires VT_LPWSTR, not the VT_BSTR produced by From<&str>.
        // SHStrDupW supplies COM-owned storage; PROPVARIANT::drop clears it even
        // when SetValue or Commit fails in the pinned windows 0.61.3 bindings.
        let owned = SHStrDupW(PCWSTR(app_id.as_ptr()))
            .map_err(|error| com_error("Allocate shortcut application ID", error))?;
        let mut value = PROPVARIANT::default();
        (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*value.Anonymous.Anonymous).Anonymous.pwszVal = owned;
        properties
            .SetValue(&PKEY_AppUserModel_ID, &value)
            .map_err(|error| com_error("Set shortcut application ID", error))?;
        properties
            .Commit()
            .map_err(|error| com_error("Commit shortcut application ID", error))?;
    }
    Ok(())
}

/// Write a new staging .lnk. The caller must pass an absent path in its private
/// staging directory and remove that staging file after an error. Existing paths,
/// including symlinks, are never accepted. No notification is sent before rename.
pub fn write(path: &Path, target: &Path, icon: &Path, title: &str) -> Result<(), String> {
    if !has_extension(path, "lnk") {
        return Err("Shortcut staging file must have the LNK extension".into());
    }
    let path_wide = wide_path(path, "shortcut staging path")?;
    let target_wide = wide_path(target, "shortcut target path")?;
    let icon_wide = wide_path(icon, "shortcut icon path")?;
    let title_wide = checked_wide(title.encode_utf16(), MAX_TITLE_UNITS, "shortcut title")?;
    let directory = target
        .parent()
        .ok_or_else(|| "Invalid shortcut working directory".to_string())?;
    let directory_wide = wide_path(directory, "shortcut working directory")?;
    regular_file(target, "shortcut target")?;
    validate_icon(icon)?;

    let _apartment = Apartment::new()?;
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| com_error("Create shortcut", error))?;
        link.SetPath(PCWSTR(target_wide.as_ptr()))
            .map_err(|error| com_error("Set shortcut target", error))?;
        let empty_arguments = [0u16];
        link.SetArguments(PCWSTR(empty_arguments.as_ptr()))
            .map_err(|error| com_error("Clear shortcut arguments", error))?;
        link.SetWorkingDirectory(PCWSTR(directory_wide.as_ptr()))
            .map_err(|error| com_error("Set shortcut working directory", error))?;
        link.SetDescription(PCWSTR(title_wide.as_ptr()))
            .map_err(|error| com_error("Set shortcut description", error))?;
        // Pass the ICO pathname verbatim, without quotes or a comma/index suffix.
        // SetIconLocation's second parameter carries the icon index separately.
        link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0)
            .map_err(|error| com_error("Set shortcut icon", error))?;
        set_identity(&link)?;
        let file: IPersistFile = link
            .cast()
            .map_err(|error| com_error("Prepare shortcut persistence", error))?;

        // Reserve only a fresh file. IPersistFile writes the empty staging file
        // created here, never a preexisting Desktop or installer-owned shortcut.
        drop(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|error| io_error("Reserve shortcut staging file", error))?,
        );
        file.Save(PCWSTR(path_wide.as_ptr()), true)
            .map_err(|error| com_error("Save shortcut staging file", error))?;
    }
    Ok(())
}

/// Notify Explorer about the one final owned item, only after the caller's
/// atomic rename. This never invalidates the global icon or association cache.
pub fn notify(path: &Path) {
    let Ok(path_wide) = wide_path(path, "shortcut notification path") else {
        return;
    };
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEITEM,
            SHCNF_PATHW | SHCNF_FLUSHNOWAIT,
            Some(path_wide.as_ptr().cast()),
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_wide_strings_reject_nul_empty_and_overflow() {
        assert!(checked_wide([], 5, "test").is_err());
        assert!(checked_wide([65, 0, 66], 5, "test").is_err());
        assert!(checked_wide([65, 66], 1, "test").is_err());
        assert_eq!(checked_wide([65, 66], 2, "test").unwrap(), [65, 66, 0]);
        assert!(checked_wide("🫐".encode_utf16(), 1, "test").is_err());
        assert_eq!(
            checked_wide("🫐".encode_utf16(), 2, "test").unwrap().len(),
            3
        );
    }

    #[test]
    fn shell_paths_preserve_unicode_spaces_and_commas() {
        let path = Path::new(r"C:\Users\Example\Blincho, мир\state.ico");
        let wide = wide_path(path, "test").unwrap();
        assert_eq!(
            wide,
            path.as_os_str()
                .encode_wide()
                .chain([0])
                .collect::<Vec<_>>()
        );
        assert!(wide_path(Path::new(r"relative\state.ico"), "test").is_err());
        assert!(has_extension(Path::new(r"C:\state.ICO"), "ico"));
        assert!(!has_extension(Path::new(r"C:\state.ico,0"), "ico"));
    }

    #[test]
    fn icon_header_requires_icon_directory_and_bounded_count() {
        assert!(icon_header_valid(&[0, 0, 1, 0, 1, 0], 22));
        assert!(!icon_header_valid(&[0, 0, 2, 0, 1, 0], 22));
        assert!(!icon_header_valid(&[0, 0, 1, 0, 0, 0], 22));
        assert!(!icon_header_valid(&[0, 0, 1, 0, 1, 1], 10000));
        assert!(!icon_header_valid(&[0, 0, 1, 0, 2, 0], 22));
    }
}
