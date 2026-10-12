use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, io::Read, path::Path};

#[path = "history/chromium.rs"]
mod chromium;

const MAX_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 256;
const MAX_ENTRIES: usize = 128;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryExport {
    pub schema_version: u8,
    pub exported_at: String,
    pub entries: BTreeMap<String, String>,
}
pub fn read_export(path: &Path) -> Result<Option<HistoryExport>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("History export is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_EXPORT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("History export exceeds 8 MiB".into());
    }
    let export: HistoryExport =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid history export: {e}"))?;
    validate_export(&export)?;
    Ok(Some(export))
}

/// Explicit exports retain precedence. An absent export falls back to a private
/// copy of the original Electron profile's Chromium database. Neither source
/// is written here; the renderer owns the existing one-time import transaction.
pub fn read_legacy_source(export_path: &Path) -> Result<Option<HistoryExport>, String> {
    if let Some(export) = read_export(export_path)? {
        return Ok(Some(export));
    }
    let profile = export_path
        .parent()
        .ok_or("Legacy history export has no profile directory")?;
    chromium::read(&profile.join("Local Storage").join("leveldb"))
}

/// Normal upgrades use the current Electron database. A developer-created export
/// may be older than later Electron activity, so it is only a fallback if the
/// original database no longer exists. Explicit fixture/export paths keep precedence.
pub fn read_current_profile(export_path: &Path) -> Result<Option<HistoryExport>, String> {
    let profile = export_path
        .parent()
        .ok_or("Legacy history export has no profile directory")?;
    let database = profile.join("Local Storage").join("leveldb");
    match std::fs::symlink_metadata(&database) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => read_export(export_path),
        _ => chromium::read(&database),
    }
}

fn is_app_key(key: &str) -> bool {
    key.starts_with("myeyes_") || key == "blincho-language-v1"
}

fn validate_export(export: &HistoryExport) -> Result<(), String> {
    if export.schema_version != 1
        || export.exported_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&export.exported_at).is_err()
        || export.entries.len() > MAX_ENTRIES
    {
        return Err("Unsupported history export".into());
    }
    for (key, value) in &export.entries {
        if !is_app_key(key)
            || matches!(
                key.as_str(),
                "myeyes_tauri_import_v1" | "myeyes_tauri_import_pending_v1"
            )
            || key.len() > MAX_KEY_BYTES
            || value.len() > MAX_VALUE_BYTES
        {
            return Err("Invalid history entry".into());
        }
    }
    // Count escaped JSON bytes without allocating a second large export.
    struct BoundedSize(usize);
    impl std::io::Write for BoundedSize {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_EXPORT_BYTES {
                return Err(std::io::Error::other("History export exceeds 8 MiB"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(BoundedSize(0), export).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_foreign_keys_without_touching_source() {
        let path =
            std::env::temp_dir().join(format!("blincho-history-{}.json", std::process::id()));
        let original = r#"{"schemaVersion":1,"exportedAt":"2026-10-12T12:00:00Z","entries":{"foreign":"secret"}}"#;
        std::fs::write(&path, original).unwrap();
        assert!(read_export(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        std::fs::remove_file(path).unwrap();
    }
}
