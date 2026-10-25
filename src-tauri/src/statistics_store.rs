use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_STATISTICS_BYTES: usize = 64 * 1024 * 1024;

/// One application-owned JSON file. Share this instance between command handlers
/// so reads, replacements and the successful-byte cache use the same lock.
pub struct StatisticsStore {
    path: PathBuf,
    last_saved: Mutex<SavedStatistics>,
}

#[derive(Default)]
struct SavedStatistics {
    bytes: Option<String>,
    // A rename may succeed even when its durability acknowledgement fails.
    // Reading those bytes must not make a subsequent save skip synchronization.
    pending_sync: bool,
}

impl StatisticsStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            last_saved: Mutex::new(SavedStatistics::default()),
        }
    }

    pub fn load(&self) -> Result<Option<String>, String> {
        self.load_with_sync(sync_parent_directory)
    }

    fn load_with_sync(
        &self,
        sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<Option<String>, String> {
        let mut last_saved = self
            .last_saved
            .lock()
            .map_err(|_| "Statistics store lock is poisoned".to_string())?;
        // A failed read must not leave stale bytes eligible for deduplication.
        last_saved.bytes = None;
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                last_saved.bytes = None;
                return Ok(None);
            }
            Err(error) => return Err(format!("Cannot open statistics: {:?}", error.kind())),
        };
        let mut value = String::new();
        file.take((MAX_STATISTICS_BYTES + 1) as u64)
            .read_to_string(&mut value)
            .map_err(|error| format!("Cannot read statistics: {:?}", error.kind()))?;
        validate(&value)?;
        let directory = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        // A previous process may have renamed this file without successfully
        // synchronizing the directory. Verify durability before seeding the
        // cache that permits save to acknowledge identical bytes immediately.
        sync_directory(directory)
            .map_err(|error| format!("Cannot sync statistics directory: {:?}", error.kind()))?;
        if cfg!(unix) && !last_saved.pending_sync {
            last_saved.bytes = Some(value.clone());
        }
        // Windows cannot verify a containing directory with fsync. Keep loaded
        // bytes uncached so the startup save must use the write-through move.
        Ok(Some(value))
    }

    pub fn save(&self, value: String) -> Result<(), String> {
        self.save_with_sync(value, sync_parent_directory)
    }

    fn save_with_sync(
        &self,
        value: String,
        sync_directory: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        let mut last_saved = self
            .last_saved
            .lock()
            .map_err(|_| "Statistics store lock is poisoned".to_string())?;
        if last_saved.bytes.as_ref() == Some(&value) {
            return Ok(());
        }
        validate(&value)?;
        let directory = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("Cannot create statistics directory: {:?}", error.kind()))?;
        // NamedTempFile creates private (0600) files on Unix. Placing it beside
        // the destination makes persist an atomic replacement on one filesystem.
        let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|error| {
            format!(
                "Cannot create statistics temporary file: {:?}",
                error.kind()
            )
        })?;
        temporary
            .write_all(value.as_bytes())
            .map_err(|error| format!("Cannot write statistics: {:?}", error.kind()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| format!("Cannot sync statistics: {:?}", error.kind()))?;
        // Invalidate the preceding cache before replacement: a failed directory
        // sync can leave the new file visible while its rename is not durable.
        last_saved.bytes = None;
        last_saved.pending_sync = true;
        persist_statistics(temporary, &self.path)
            .map_err(|error| format!("Cannot replace statistics: {:?}", error.kind()))?;
        sync_directory(directory)
            .map_err(|error| format!("Cannot sync statistics directory: {:?}", error.kind()))?;
        last_saved.bytes = Some(value);
        last_saved.pending_sync = false;
        Ok(())
    }
}

#[cfg(not(windows))]
fn persist_statistics(temporary: tempfile::NamedTempFile, path: &Path) -> std::io::Result<()> {
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

#[cfg(windows)]
fn persist_statistics(temporary: tempfile::NamedTempFile, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    };

    // tempfile 3.27's Windows persist uses MoveFileExW without WRITE_THROUGH.
    // Match its normal-file attributes and cleanup while requesting a durable
    // move before success. The file contents were already synchronized above.
    let mut temporary = temporary.into_temp_path();
    let source: Vec<u16> = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: Both buffers are NUL-terminated, live throughout these calls and
    // point to paths owned by this store. Failed moves keep TempPath cleanup.
    unsafe {
        if SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    temporary.disable_cleanup(true);
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(directory: &Path) -> std::io::Result<()> {
    // sync_all on the temporary file does not persist its new directory entry.
    File::open(directory)?.sync_all()
}

#[cfg(windows)]
fn sync_parent_directory(_directory: &Path) -> std::io::Result<()> {
    // MoveFileExW with WRITE_THROUGH already acknowledged the durable rename.
    Ok(())
}

fn validate(value: &str) -> Result<(), String> {
    if value.len() > MAX_STATISTICS_BYTES {
        return Err("Statistics exceed the 64 MiB limit".to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "Statistics contain invalid JSON".to_string())?;
    if !parsed.is_array() {
        return Err("Statistics must be a JSON array".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_round_trip_and_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/statistics.json");
        let store = StatisticsStore::new(path.clone());
        assert_eq!(store.load().unwrap(), None);
        let value = r#"[{"day":"2026-10-25","seconds":123}]"#;
        store.save(value.into()).unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some(value));
        assert_eq!(
            StatisticsStore::new(path).load().unwrap().as_deref(),
            Some(value)
        );
    }

    #[test]
    fn invalid_writes_preserve_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        for value in ["", "[", "{}", "null", "42", "[] garbage"] {
            assert!(store.save(value.into()).is_err(), "{value}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        }
        assert!(store.save(" ".repeat(MAX_STATISTICS_BYTES + 1)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_and_unreadable_files_fail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        for value in [b"broken".as_slice(), b"{}", b"[\xff]"] {
            fs::write(&path, value).unwrap();
            assert!(store.load().is_err());
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    fn oversized_reads_fail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let mut value = String::with_capacity(MAX_STATISTICS_BYTES + 1);
        value.push_str("[]");
        value.extend(std::iter::repeat_n(' ', MAX_STATISTICS_BYTES - 2));
        assert!(validate(&value).is_ok());
        value.push(' ');
        fs::write(&path, value).unwrap();
        assert!(StatisticsStore::new(path).load().is_err());
    }

    #[test]
    fn failed_load_invalidates_cached_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        fs::write(&path, "broken").unwrap();
        assert!(store.load().is_err());
        store.save("[1]".into()).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "[1]");
    }

    #[cfg(unix)]
    #[test]
    fn permission_errors_preserve_previous_file_and_allow_retry() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let read_result = store.load();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_result.is_err());
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let save_result = store.save("[2]".into());
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(save_result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        store.save("[2]".into()).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "[2]");
    }

    #[test]
    fn failed_replacement_cleans_temporary_file_and_can_retry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), "previous content").unwrap();
        let store = StatisticsStore::new(path.clone());
        assert!(store.save("[2]".into()).is_err());
        assert_eq!(
            fs::read_to_string(path.join("keep")).unwrap(),
            "previous content"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        fs::remove_dir_all(&path).unwrap();
        store.save("[2]".into()).unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("[2]"));
    }

    #[test]
    fn failed_directory_sync_retries_before_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        let error = store
            .save_with_sync("[2]".into(), |parent| {
                assert_eq!(parent, directory.path());
                assert_eq!(fs::read_to_string(&path).unwrap(), "[2]");
                Err(std::io::Error::from(std::io::ErrorKind::Other))
            })
            .unwrap_err();
        assert_eq!(error, "Cannot sync statistics directory: Other");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);

        // A read between attempts must not turn unacknowledged bytes into a
        // successful-byte cache entry and bypass the durability retry.
        assert_eq!(store.load().unwrap().as_deref(), Some("[2]"));
        let synchronized = std::cell::Cell::new(false);
        store
            .save_with_sync("[2]".into(), |parent| {
                sync_parent_directory(parent)?;
                synchronized.set(true);
                Ok(())
            })
            .unwrap();
        assert!(synchronized.get());
        store
            .save_with_sync("[2]".into(), |_| panic!("durable bytes should deduplicate"))
            .unwrap();
    }

    #[test]
    fn failed_directory_sync_invalidates_preceding_successful_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        assert!(store
            .save_with_sync("[2]".into(), |_| {
                Err(std::io::Error::from(std::io::ErrorKind::Other))
            })
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[2]");
        let synchronized = std::cell::Cell::new(false);
        store
            .save_with_sync("[1]".into(), |parent| {
                assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
                sync_parent_directory(parent)?;
                synchronized.set(true);
                Ok(())
            })
            .unwrap();
        assert!(synchronized.get());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
    }

    #[test]
    fn cold_reopen_verifies_loaded_bytes_before_deduplicating() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        assert!(store
            .save_with_sync("[1]".into(), |_| {
                Err(std::io::Error::from(std::io::ErrorKind::Other))
            })
            .is_err());
        drop(store);

        let reopened = StatisticsStore::new(path.clone());
        let load_synchronized = std::cell::Cell::new(false);
        assert_eq!(
            reopened
                .load_with_sync(|parent| {
                    assert_eq!(parent, directory.path());
                    assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
                    sync_parent_directory(parent)?;
                    load_synchronized.set(true);
                    Ok(())
                })
                .unwrap()
                .as_deref(),
            Some("[1]")
        );
        assert!(load_synchronized.get());
        let save_synchronized = std::cell::Cell::new(false);
        reopened
            .save_with_sync("[1]".into(), |parent| {
                sync_parent_directory(parent)?;
                save_synchronized.set(true);
                Ok(())
            })
            .unwrap();
        // Unix verified the directory on load. Windows must perform its
        // write-through move on save because it cannot use directory fsync.
        assert_eq!(save_synchronized.get(), cfg!(windows));
    }

    #[test]
    fn cold_load_directory_sync_failure_cannot_seed_saved_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        assert!(store
            .save_with_sync("[1]".into(), |_| {
                Err(std::io::Error::from(std::io::ErrorKind::Other))
            })
            .is_err());
        drop(store);

        let reopened = StatisticsStore::new(path.clone());
        let result =
            reopened.load_with_sync(|_| Err(std::io::Error::from(std::io::ErrorKind::Other)));
        assert_eq!(
            result.unwrap_err(),
            "Cannot sync statistics directory: Other"
        );
        let synchronized = std::cell::Cell::new(false);
        reopened
            .save_with_sync("[1]".into(), |parent| {
                assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
                sync_parent_directory(parent)?;
                synchronized.set(true);
                Ok(())
            })
            .unwrap();
        assert!(synchronized.get());
    }

    #[test]
    fn repeated_large_replacements_leave_only_one_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        let padding = "x".repeat(1024 * 1024);
        for index in 0..32 {
            let value = format!(r#"[{{"index":{index},"padding":"{padding}"}}]"#);
            store.save(value.clone()).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), value);
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
        for index in 0..1000 {
            store.save(format!("[{index}]")).unwrap();
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
        assert_eq!(store.load().unwrap().as_deref(), Some("[999]"));
    }

    #[cfg(unix)]
    #[test]
    fn duplicate_save_and_loaded_bytes_do_not_replace_private_file() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("statistics.json");
        let store = StatisticsStore::new(path.clone());
        store.save("[1]".into()).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        store.save("[1]".into()).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        let reopened = StatisticsStore::new(path.clone());
        reopened.load().unwrap();
        reopened.save("[1]".into()).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    }
}
