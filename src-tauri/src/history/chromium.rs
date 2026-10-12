//! Chromium localStorage schema and string tags are documented in its
//! components/services/storage/dom_storage/leveldb/local_storage_leveldb.h and
//! third_party/blink/renderer/modules/storage/cached_storage_area.cc.
//! Google LevelDB's log_format.md defines the strict WAL preflight below.

use super::{
    is_app_key, validate_export, HistoryExport, MAX_ENTRIES, MAX_KEY_BYTES, MAX_VALUE_BYTES,
};
use leveldb_sys as ldb;
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::{self, Metadata, OpenOptions},
    io::{Read, Write},
    os::raw::c_char,
    path::Path,
    ptr,
};

const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DATABASE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DATABASE_ENTRIES: usize = 4096;
const MAX_RAW_KEY_BYTES: usize = 4096;
const MAX_RAW_VALUE_BYTES: usize = MAX_VALUE_BYTES * 2 + 1;
const ELECTRON_ORIGIN: &[u8] = b"file://";

pub(super) fn read(source: &Path) -> Result<Option<HistoryExport>, String> {
    read_with_temp_parent(source, &std::env::temp_dir())
}

fn read_with_temp_parent(
    source: &Path,
    temp_parent: &Path,
) -> Result<Option<HistoryExport>, String> {
    match fs::symlink_metadata(source) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Legacy history directory is unavailable: {error}")),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err("Legacy history directory must be a regular directory".into());
        }
        Ok(_) => {}
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix("blincho-history-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let snapshot = builder.tempdir_in(temp_parent).map_err(|e| e.to_string())?;
    let result = (|| {
        copy_database(source, snapshot.path())?;
        read_snapshot(snapshot.path())
    })();
    // Close native handles before removing the private copy, on every outcome.
    let cleanup = snapshot
        .close()
        .map_err(|e| format!("Legacy history copy cleanup failed: {e}"));
    match (result, cleanup) {
        (Ok(export), Ok(())) => Ok(export),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

#[derive(PartialEq, Eq)]
struct SourceFile {
    name: String,
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl SourceFile {
    fn from_metadata(name: String, metadata: &Metadata) -> Result<Self, String> {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Legacy history contains a link or nonregular file".into());
        }
        if metadata.len() > MAX_FILE_BYTES {
            return Err("Legacy history file exceeds 32 MiB".into());
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            name,
            length: metadata.len(),
            modified: metadata.modified().map_err(|e| e.to_string())?,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}

fn inventory(source: &Path) -> Result<Vec<SourceFile>, String> {
    let mut files = Vec::new();
    let mut total = 0u64;
    for item in fs::read_dir(source).map_err(|e| e.to_string())? {
        if files.len() >= MAX_FILES {
            return Err("Legacy history contains too many files".into());
        }
        let item = item.map_err(|e| e.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "Invalid legacy history filename")?;
        if !is_database_filename(&name) {
            return Err("Legacy history contains an unsupported database file".into());
        }
        let file = SourceFile::from_metadata(
            name,
            &fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?,
        )?;
        total = total
            .checked_add(file.length)
            .ok_or("Legacy history database is too large")?;
        if total > MAX_DATABASE_BYTES {
            return Err("Legacy history database exceeds 64 MiB".into());
        }
        files.push(file);
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(files)
}

fn is_number(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_database_filename(name: &str) -> bool {
    matches!(name, "CURRENT" | "LOCK" | "LOG" | "LOG.old")
        || name.strip_prefix("MANIFEST-").is_some_and(is_number)
        || name.rsplit_once('.').is_some_and(|(number, extension)| {
            is_number(number) && matches!(extension, "ldb" | "sst" | "log" | "dbtmp")
        })
}

fn copy_database(source: &Path, destination: &Path) -> Result<(), String> {
    let before = inventory(source)?;
    for expected in &before {
        let source_path = source.join(&expected.name);
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(&source_path)
            .map_err(|e| format!("Legacy history cannot be copied: {e}"))?;
        if SourceFile::from_metadata(
            expected.name.clone(),
            &file.metadata().map_err(|e| e.to_string())?,
        )? != *expected
        {
            return Err(
                "Legacy history changed while being copied, close the Electron app and try again"
                    .into(),
            );
        }
        let mut bytes = Vec::new();
        file.take(expected.length + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != expected.length {
            return Err(
                "Legacy history changed while being copied, close the Electron app and try again"
                    .into(),
            );
        }
        if expected.name.starts_with("MANIFEST-") || expected.name.ends_with(".log") {
            validate_log(&bytes)?;
        } else if expected.name.ends_with(".ldb") || expected.name.ends_with(".sst") {
            validate_table_footer(&bytes)?;
        }
        let mut output_options = OpenOptions::new();
        output_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            output_options.mode(0o600);
        }
        let mut output = output_options
            .open(destination.join(&expected.name))
            .map_err(|e| e.to_string())?;
        output.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    if inventory(source)? != before {
        return Err(
            "Legacy history changed while being copied, close the Electron app and try again"
                .into(),
        );
    }
    let current = fs::read(destination.join("CURRENT"))
        .map_err(|_| "Legacy history has no CURRENT manifest")?;
    let manifest =
        std::str::from_utf8(&current).map_err(|_| "Invalid legacy history CURRENT manifest")?;
    let manifest = manifest
        .strip_suffix('\n')
        .ok_or("Invalid legacy history CURRENT manifest")?;
    if !manifest.strip_prefix("MANIFEST-").is_some_and(is_number)
        || !before.iter().any(|file| file.name == manifest)
    {
        return Err("Invalid legacy history CURRENT manifest".into());
    }
    Ok(())
}

// A normal LevelDB recovery may silently discard a torn final WAL record. A
// one-time migration must instead refuse a partial history, so validate framing,
// fragmentation and every record checksum before native recovery reads the copy.
fn validate_log(bytes: &[u8]) -> Result<(), String> {
    let mut fragmented = false;
    let mut fragment_bytes = 0usize;
    for block in bytes.chunks(32768) {
        let mut position = 0;
        while position < block.len() {
            let remaining = &block[position..];
            if remaining.len() < 7 {
                if block.len() != 32768 || remaining.iter().any(|byte| *byte != 0) {
                    return Err("Legacy history has a truncated log record".into());
                }
                break;
            }
            let length = u16::from_le_bytes([remaining[4], remaining[5]]) as usize;
            let kind = remaining[6];
            if kind == 0 && length == 0 && remaining.iter().all(|byte| *byte == 0) {
                break; // LevelDB mmap writers can preallocate zero-filled tails.
            }
            if length + 7 > remaining.len() {
                return Err("Legacy history has a truncated log record".into());
            }
            let expected = u32::from_le_bytes(remaining[..4].try_into().unwrap());
            let actual = crc32c(&remaining[6..length + 7])
                .rotate_right(15)
                .wrapping_add(0xa282ead8);
            if actual != expected {
                return Err("Legacy history log checksum is invalid".into());
            }
            match kind {
                1 if !fragmented || fragment_bytes == 0 => {
                    fragmented = false;
                    fragment_bytes = 0;
                }
                2 if !fragmented || fragment_bytes == 0 => {
                    fragmented = true;
                    fragment_bytes = length;
                }
                3 if fragmented => fragment_bytes += length,
                4 if fragmented => {
                    fragmented = false;
                    fragment_bytes = 0;
                }
                _ => return Err("Legacy history log fragmentation is invalid".into()),
            }
            position += length + 7;
        }
    }
    if fragmented {
        return Err("Legacy history has an incomplete log record".into());
    }
    Ok(())
}

fn crc32c(bytes: &[u8]) -> u32 {
    let mut checksum = !0u32;
    for byte in bytes {
        checksum ^= u32::from(*byte);
        for _ in 0..8 {
            checksum = (checksum >> 1) ^ (0x82f63b78 & 0u32.wrapping_sub(checksum & 1));
        }
    }
    !checksum
}

// SSTable footers have no checksum. Bound both block handles before the native
// reader uses their sizes for allocation; ordinary data/index block corruption
// is then caught by LevelDB's verify_checksums option.
fn validate_table_footer(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 48 {
        return Err("Legacy history table footer is truncated".into());
    }
    let footer_start = bytes.len() - 48;
    if bytes[bytes.len() - 8..] != 0xdb4775248b80fb57u64.to_le_bytes() {
        return Err("Legacy history table magic is invalid".into());
    }
    let mut footer = &bytes[footer_start..bytes.len() - 8];
    fn varint(input: &mut &[u8]) -> Option<u64> {
        let mut number = 0u64;
        for shift in (0..=63).step_by(7) {
            let byte = *input.first()?;
            *input = &input[1..];
            if shift == 63 && byte > 1 {
                return None;
            }
            number |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 {
                return Some(number);
            }
        }
        None
    }
    for _ in 0..2 {
        let offset = varint(&mut footer).ok_or("Invalid legacy history table block handle")?;
        let size = varint(&mut footer).ok_or("Invalid legacy history table block handle")?;
        let end = offset.checked_add(size).and_then(|end| end.checked_add(5));
        if end.is_none_or(|end| end > footer_start as u64) {
            return Err("Legacy history table block exceeds its file bounds".into());
        }
    }
    Ok(())
}

struct Database(*mut ldb::leveldb_t);
impl Drop for Database {
    fn drop(&mut self) {
        unsafe { ldb::leveldb_close(self.0) }
    }
}
struct IteratorHandle(*mut ldb::leveldb_iterator_t);
impl Drop for IteratorHandle {
    fn drop(&mut self) {
        unsafe { ldb::leveldb_iter_destroy(self.0) }
    }
}

fn take_error(error: *mut c_char) -> Option<String> {
    if error.is_null() {
        return None;
    }
    // LevelDB allocates error messages and requires its own freeing function.
    let message = unsafe { CStr::from_ptr(error).to_string_lossy().into_owned() };
    unsafe { ldb::leveldb_free(error.cast()) };
    Some(format!("Legacy history database is invalid: {message}"))
}

fn open_database(path: &Path, create: bool) -> Result<Database, String> {
    #[cfg(unix)]
    let name = {
        use std::os::unix::ffi::OsStrExt;
        CString::new(path.as_os_str().as_bytes())
    };
    #[cfg(not(unix))]
    let name = CString::new(path.to_str().ok_or("Invalid legacy history path")?);
    let name = name.map_err(|_| "Invalid legacy history path")?;
    let mut error = ptr::null_mut();
    // All native database writes, including recovery, are confined to the copy.
    let raw = unsafe {
        let options = ldb::leveldb_options_create();
        ldb::leveldb_options_set_create_if_missing(options, u8::from(create));
        ldb::leveldb_options_set_paranoid_checks(options, 1);
        ldb::leveldb_options_set_max_open_files(options, 32);
        ldb::leveldb_options_set_write_buffer_size(options, 4 * 1024 * 1024);
        ldb::leveldb_options_set_compression(options, ldb::Compression::Snappy);
        let raw = ldb::leveldb_open(options, name.as_ptr(), &mut error);
        ldb::leveldb_options_destroy(options);
        raw
    };
    if let Some(error) = take_error(error) {
        if !raw.is_null() {
            unsafe { ldb::leveldb_close(raw) };
        }
        return Err(error);
    }
    if raw.is_null() {
        return Err("Legacy history database could not be opened".into());
    }
    Ok(Database(raw))
}

fn read_snapshot(path: &Path) -> Result<Option<HistoryExport>, String> {
    let database = open_database(path, false)?;
    let iterator = unsafe {
        let options = ldb::leveldb_readoptions_create();
        ldb::leveldb_readoptions_set_verify_checksums(options, 1);
        ldb::leveldb_readoptions_set_fill_cache(options, 0);
        let iterator = ldb::leveldb_create_iterator(database.0, options);
        ldb::leveldb_readoptions_destroy(options);
        if iterator.is_null() {
            return Err("Legacy history iterator could not be created".into());
        }
        IteratorHandle(iterator)
    };
    let mut entries = BTreeMap::new();
    let mut count = 0;
    let mut app_bytes = 0usize;
    let mut version = false;
    unsafe { ldb::leveldb_iter_seek_to_first(iterator.0) };
    while unsafe { ldb::leveldb_iter_valid(iterator.0) } != 0 {
        count += 1;
        if count > MAX_DATABASE_ENTRIES {
            return Err("Legacy history database contains too many entries".into());
        }
        let mut key_length = 0usize;
        let mut value_length = 0usize;
        // Borrow only while this iterator remains valid and before advancing it.
        let key_pointer = unsafe { ldb::leveldb_iter_key(iterator.0, &mut key_length) };
        let value_pointer = unsafe { ldb::leveldb_iter_value(iterator.0, &mut value_length) };
        if key_length > MAX_RAW_KEY_BYTES || value_length > MAX_RAW_VALUE_BYTES {
            return Err("Legacy history database entry is too large".into());
        }
        let key = if key_length == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(key_pointer.cast::<u8>(), key_length) }
        };
        let value = if value_length == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(value_pointer.cast::<u8>(), value_length) }
        };
        if key == b"VERSION" {
            if value != b"1" {
                return Err("Unsupported Chromium local storage version".into());
            }
            version = true;
        } else if let Some(script_key) = key.strip_prefix(b"_") {
            let separator = script_key
                .iter()
                .position(|byte| *byte == 0)
                .ok_or("Invalid Chromium storage key")?;
            let origin = &script_key[..separator];
            let decoded_key = decode_string(&script_key[separator + 1..], MAX_KEY_BYTES)?;
            if is_app_key(&decoded_key) {
                if origin != ELECTRON_ORIGIN {
                    return Err(
                        "Legacy app history has an unsupported or conflicting origin".into(),
                    );
                }
                if entries.len() >= MAX_ENTRIES {
                    return Err("Legacy history contains too many app entries".into());
                }
                let decoded_value = decode_string(value, MAX_VALUE_BYTES)?;
                app_bytes += decoded_key.len() + decoded_value.len();
                if app_bytes > super::MAX_EXPORT_BYTES {
                    return Err("Legacy history export exceeds 8 MiB".into());
                }
                if entries.insert(decoded_key, decoded_value).is_some() {
                    return Err(
                        "Legacy history contains conflicting encodings of an app key".into(),
                    );
                }
            }
        }
        unsafe { ldb::leveldb_iter_next(iterator.0) };
    }
    let mut error: *mut c_char = ptr::null_mut();
    // The crate declaration incorrectly marks the C output argument const.
    // Its upstream C API is char**; retain a mutable slot and cast only here.
    unsafe { ldb::leveldb_iter_get_error(iterator.0, (&mut error as *mut *mut c_char).cast()) };
    if let Some(error) = take_error(error) {
        return Err(error);
    }
    if !version {
        return Err("Legacy history has no Chromium schema version".into());
    }
    if entries.is_empty() {
        return Ok(None);
    }
    let export = HistoryExport {
        schema_version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        entries,
    };
    validate_export(&export)?;
    Ok(Some(export))
}

fn decode_string(bytes: &[u8], limit: usize) -> Result<String, String> {
    if bytes.len() > limit * 2 + 1 {
        return Err("Legacy history string is too large".into());
    }
    // Blink permits a zero-byte value as the empty string. Normal writes include
    // a format byte, even for empty strings.
    if bytes.is_empty() {
        return Ok(String::new());
    }
    let text = match bytes[0] {
        0 => {
            if (bytes.len() - 1) % 2 != 0 {
                return Err("Legacy history UTF-16 string has an invalid length".into());
            }
            let units: Vec<u16> = bytes[1..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16(&units).map_err(|_| "Legacy history contains invalid UTF-16")?
        }
        1 => bytes[1..].iter().map(|byte| char::from(*byte)).collect(),
        _ => return Err("Legacy history has an unsupported string encoding".into()),
    };
    if text.len() > limit {
        return Err("Legacy history string is too large".into());
    }
    Ok(text)
}

#[cfg(test)]
#[path = "chromium_tests.rs"]
mod tests;
