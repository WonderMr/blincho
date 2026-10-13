use super::*;
use std::fs::File;

fn latin1(value: &str) -> Vec<u8> {
    let mut result = vec![1];
    result.extend(value.chars().map(|character| {
        assert!(u32::from(character) <= 255);
        character as u8
    }));
    result
}

fn utf16(value: &str) -> Vec<u8> {
    let mut result = vec![0];
    for unit in value.encode_utf16() {
        result.extend_from_slice(&unit.to_le_bytes());
    }
    result
}

fn storage_key(origin: &str, encoded: &[u8]) -> Vec<u8> {
    let mut result = format!("_{origin}").into_bytes();
    result.push(0);
    result.extend_from_slice(encoded);
    result
}

fn write(db: &Database, key: &[u8], value: Option<&[u8]>) {
    unsafe {
        let options = ldb::leveldb_writeoptions_create();
        ldb::leveldb_writeoptions_set_sync(options, 1);
        let mut error = ptr::null_mut();
        if let Some(value) = value {
            ldb::leveldb_put(
                db.0,
                options,
                key.as_ptr().cast(),
                key.len(),
                value.as_ptr().cast(),
                value.len(),
                &mut error,
            );
        } else {
            ldb::leveldb_delete(db.0, options, key.as_ptr().cast(), key.len(), &mut error);
        }
        ldb::leveldb_writeoptions_destroy(options);
        assert_eq!(take_error(error), None);
    }
}

fn fixture(path: &Path, pairs: &[(Vec<u8>, Vec<u8>)], compact: bool) {
    fs::create_dir_all(path).unwrap();
    let db = open_database(path, true).unwrap();
    write(&db, b"VERSION", Some(b"1"));
    write(&db, b"META:file://", Some(&[8, 1, 16, 2]));
    for (key, value) in pairs {
        write(&db, key, Some(value));
    }
    if compact {
        unsafe { ldb::leveldb_compact_range(db.0, ptr::null(), 0, ptr::null(), 0) };
    }
}

fn app_pair(key: &str, value: &str) -> (Vec<u8>, Vec<u8>) {
    (storage_key("file://", &latin1(key)), latin1(value))
}

fn files(path: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(path)
        .unwrap()
        .map(|item| {
            let item = item.unwrap();
            (
                item.file_name().to_str().unwrap().to_string(),
                fs::read(item.path()).unwrap(),
            )
        })
        .collect()
}

fn copy_root(parent: &Path) -> std::path::PathBuf {
    let root = parent.join("copies");
    fs::create_dir(&root).unwrap();
    root
}

fn assert_failure_preserves_source(source: &Path, copies: &Path) -> String {
    let original = files(source);
    let error = match read_with_temp_parent(source, copies) {
        Err(error) => error,
        Ok(_) => panic!("Invalid source was accepted"),
    };
    assert_eq!(files(source), original);
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
    error
}

#[test]
fn imports_real_leveldb_tags_latest_values_and_deletes_without_source_writes() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    let stats = r#"{"totalBreaksCompleted":7,"focusByDate":{"2026-10-10":3600},"sessions":[{"note":"Привет 👁"}]}"#;
    let settings = r#"{"workMinutes":20,"strictMode":true,"name":"café"}"#;
    fixture(
        &source,
        &[
            app_pair("myeyes_settings_v1", settings),
            (
                storage_key("file://", &utf16("myeyes_stats_v1")),
                utf16(stats),
            ),
            app_pair("blincho-language-v1", r#""ru""#),
            (
                storage_key("file://", &latin1("foreign")),
                latin1("do not import"),
            ),
            app_pair("myeyes_deleted", "old"),
        ],
        false,
    );
    {
        let db = open_database(&source, false).unwrap();
        write(
            &db,
            &storage_key("file://", &latin1("myeyes_deleted")),
            None,
        );
        write(
            &db,
            &storage_key("file://", &latin1("blincho-language-v1")),
            Some(&latin1(r#""es""#)),
        );
    }
    let original = files(&source);
    let export = read_with_temp_parent(&source, &copies).unwrap().unwrap();
    assert_eq!(
        export.entries,
        BTreeMap::from([
            ("myeyes_settings_v1".into(), settings.into()),
            ("myeyes_stats_v1".into(), stats.into()),
            ("blincho-language-v1".into(), r#""es""#.into()),
        ])
    );
    assert_eq!(files(&source), original);
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
    assert!(chrono::DateTime::parse_from_rfc3339(&export.exported_at).is_ok());
}

#[test]
fn imports_snappy_sstable_and_refuses_corruption() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    let value = "many repeated words ".repeat(4000);
    fixture(&source, &[app_pair("myeyes_history", &value)], true);
    let table = fs::read_dir(&source)
        .unwrap()
        .map(|item| item.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "ldb" || extension == "sst")
        })
        .unwrap();
    assert!(
        fs::metadata(&table).unwrap().len() < value.len() as u64,
        "Fixture must use compressed table blocks"
    );
    let original = files(&source);
    assert_eq!(
        read_with_temp_parent(&source, &copies)
            .unwrap()
            .unwrap()
            .entries["myeyes_history"],
        value
    );
    assert_eq!(files(&source), original);
    let mut bytes = fs::read(&table).unwrap();
    bytes[20] ^= 0x80;
    fs::write(&table, bytes).unwrap();
    assert!(assert_failure_preserves_source(&source, &copies).contains("invalid"));
}

#[test]
fn refuses_corrupt_and_truncated_wal_before_recovery() {
    for truncate in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let copies = copy_root(root.path());
        fixture(&source, &[app_pair("myeyes_stats_v1", "{}")], false);
        let log = fs::read_dir(&source)
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|path| path.extension().is_some_and(|extension| extension == "log"))
            .unwrap();
        let mut bytes = fs::read(&log).unwrap();
        if truncate {
            bytes.truncate(bytes.len() - 2);
        } else {
            bytes[10] ^= 1;
        }
        fs::write(log, bytes).unwrap();
        let error = assert_failure_preserves_source(&source, &copies);
        assert!(error.contains(if truncate { "truncated" } else { "checksum" }));
    }
}

#[test]
fn rejects_noncanonical_origins_and_duplicate_script_key_encodings() {
    for pairs in [
        vec![
            app_pair("myeyes_stats_v1", "{}"),
            (
                storage_key("http://localhost:5173", &latin1("myeyes_stats_v1")),
                latin1("{}"),
            ),
        ],
        vec![(
            storage_key("file:///", &latin1("myeyes_stats_v1")),
            latin1("{}"),
        )],
        vec![
            app_pair("myeyes_stats_v1", "{}"),
            (
                storage_key("file://", &utf16("myeyes_stats_v1")),
                latin1("{}"),
            ),
        ],
    ] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let copies = copy_root(root.path());
        fixture(&source, &pairs, false);
        let error = assert_failure_preserves_source(&source, &copies);
        assert!(error.contains("origin") || error.contains("conflicting encodings"));
    }
}

#[test]
fn rejects_invalid_tags_utf16_and_import_markers() {
    for value in [vec![2, 65], vec![0, 1], vec![0, 0, 0xd8]] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let copies = copy_root(root.path());
        fixture(
            &source,
            &[(storage_key("file://", &latin1("myeyes_stats_v1")), value)],
            false,
        );
        assert_failure_preserves_source(&source, &copies);
    }
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[app_pair("myeyes_tauri_import_v1", "{}")], false);
    assert_failure_preserves_source(&source, &copies);
}

#[test]
fn enforces_file_value_entry_and_serialized_size_bounds() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(
        &source,
        &[app_pair("myeyes_history", &"x".repeat(MAX_VALUE_BYTES + 1))],
        false,
    );
    assert_failure_preserves_source(&source, &copies);

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    let pairs: Vec<_> = (0..=MAX_ENTRIES)
        .map(|index| app_pair(&format!("myeyes_{index}"), "x"))
        .collect();
    fixture(&source, &pairs, false);
    assert_failure_preserves_source(&source, &copies);

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    // Control characters expand to six JSON bytes, despite a small decoded value.
    fixture(
        &source,
        &[app_pair(
            "myeyes_history",
            &"\u{0001}".repeat(2 * 1024 * 1024),
        )],
        true,
    );
    assert!(assert_failure_preserves_source(&source, &copies).contains("8 MiB"));

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[], false);
    let file = File::create(source.join("100000.dbtmp")).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert!(read_with_temp_parent(&source, &copies)
        .err()
        .unwrap()
        .contains("32 MiB"));
    assert_eq!(
        fs::metadata(source.join("100000.dbtmp")).unwrap().len(),
        MAX_FILE_BYTES + 1
    );
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
}

#[test]
fn rejects_excess_files_total_bytes_and_current_path_traversal() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[], false);
    for index in 10000..10000 + MAX_FILES {
        fs::write(source.join(format!("{index}.dbtmp")), []).unwrap();
    }
    assert!(read_with_temp_parent(&source, &copies)
        .err()
        .unwrap()
        .contains("too many files"));
    assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[], false);
    for index in 10000..10003 {
        File::create(source.join(format!("{index}.dbtmp")))
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
    }
    assert!(read_with_temp_parent(&source, &copies)
        .err()
        .unwrap()
        .contains("64 MiB"));
    assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);

    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[], false);
    fs::write(source.join("CURRENT"), b"../outside\n").unwrap();
    assert!(assert_failure_preserves_source(&source, &copies).contains("CURRENT"));
}

#[test]
fn preserves_explicit_export_precedence_and_invalid_export_errors() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("Local Storage").join("leveldb");
    fixture(&source, &[app_pair("myeyes_history", "database")], false);
    let export_path = root.path().join("tauri-history-export.json");
    assert_eq!(
        super::super::read_legacy_source(&export_path)
            .unwrap()
            .unwrap()
            .entries["myeyes_history"],
        "database"
    );
    let original = files(&source);
    fs::write(&export_path, br#"{"schemaVersion":1,"exportedAt":"2026-10-12T12:00:00Z","entries":{"myeyes_history":"export"}}"#).unwrap();
    assert_eq!(
        super::super::read_legacy_source(&export_path)
            .unwrap()
            .unwrap()
            .entries["myeyes_history"],
        "export"
    );
    fs::write(&export_path, b"invalid").unwrap();
    assert!(super::super::read_legacy_source(&export_path).is_err());
    assert_eq!(files(&source), original);
    assert_eq!(fs::read(&export_path).unwrap(), b"invalid");
}

#[test]
fn missing_and_foreign_only_profiles_return_none_without_artifacts() {
    let root = tempfile::tempdir().unwrap();
    assert!(read(&root.path().join("missing")).unwrap().is_none());
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(
        &source,
        &[(
            storage_key("file://", &latin1("foreign")),
            latin1("ignored"),
        )],
        false,
    );
    let original = files(&source);
    assert!(read_with_temp_parent(&source, &copies).unwrap().is_none());
    assert_eq!(files(&source), original);
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn rejects_symbolic_links_and_uses_private_snapshot_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&source, &[], false);
    let other = root.path().join("other");
    fs::write(&other, b"private").unwrap();
    symlink(&other, source.join("100000.dbtmp")).unwrap();
    assert!(read_with_temp_parent(&source, &copies)
        .err()
        .unwrap()
        .contains("link"));
    assert_eq!(fs::read(&other).unwrap(), b"private");
    assert_eq!(fs::read_dir(&copies).unwrap().count(), 0);
    fs::remove_file(source.join("100000.dbtmp")).unwrap();
    let snapshot = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(&copies)
        .unwrap();
    copy_database(&source, snapshot.path()).unwrap();
    assert_eq!(
        fs::metadata(snapshot.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for file in fs::read_dir(snapshot.path()).unwrap() {
        assert_eq!(
            file.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn crc32c_matches_the_published_standard_vector() {
    assert_eq!(crc32c(b"123456789"), 0xe3069283);
}

#[test]
fn refuses_unchecked_table_footer_allocation_sizes() {
    let mut table = vec![0u8; 48];
    table[40..].copy_from_slice(&0xdb4775248b80fb57u64.to_le_bytes());
    assert!(validate_table_footer(&table).is_err());
    // An overflowing varint must fail before the C++ reader can allocate it.
    table[..10].fill(255);
    assert!(validate_table_footer(&table).is_err());
    table[..10].fill(0);
    table[1] = 127;
    assert!(validate_table_footer(&table).is_err());
}

#[test]
fn normal_upgrade_uses_current_database_instead_of_stale_export() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path();
    let database = profile.join("Local Storage/leveldb");
    std::fs::create_dir_all(database.parent().unwrap()).unwrap();
    fixture(
        &database,
        &[app_pair("myeyes_stats_v1", "{\"new\":true}")],
        false,
    );
    let export = profile.join("tauri-history-export.json");
    std::fs::write(&export, "{stale corrupted export").unwrap();
    let current = super::super::read_current_profile(&export)
        .unwrap()
        .unwrap();
    assert_eq!(current.entries["myeyes_stats_v1"], "{\"new\":true}");
    assert!(super::super::read_legacy_source(&export).is_err());
}

#[test]
fn unicode_electron_profile_is_copied_without_reencoding_or_source_writes() {
    let root = tempfile::tempdir().unwrap();
    let ascii = root.path().join("source");
    let copies = copy_root(root.path());
    fixture(&ascii, &[app_pair("myeyes_history", "preserved")], true);
    // Native LevelDB only needs the snapshot's path. The original Chromium
    // directory is accessed through Rust's platform filesystem implementation.
    let source = root.path().join("Юлия 👁");
    fs::rename(&ascii, &source).unwrap();
    let original = files(&source);
    let export = read_with_temp_parent(&source, &copies).unwrap().unwrap();
    assert_eq!(export.entries["myeyes_history"], "preserved");
    assert_eq!(files(&source), original);
    assert_eq!(fs::read_dir(copies).unwrap().count(), 0);
}
