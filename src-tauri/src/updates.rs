//! Metadata-only update notifications for unsigned macOS packages.
//!
//! The renderer cannot supply a feed or package URL. A check never fetches an
//! installer, and opening the fixed download page belongs to the native bridge.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

pub const MANIFEST_URL: &str = "https://blincho.app/releases.json";
pub const MANUAL_DOWNLOAD_URL: &str = "https://blincho.app/#download";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_PREFERENCE_BYTES: usize = 4096;
const INITIAL_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static TEMPORARY_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    Ask,
    Auto,
    Off,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub policy: UpdatePolicy,
    pub status: &'static str,
    pub supported: bool,
    pub check_supported: bool,
    pub support_reason: Option<&'static str>,
    pub current_version: String,
    pub available_version: Option<String>,
    pub skipped_version: Option<String>,
    pub progress: Option<u8>,
    pub last_checked_at: Option<String>,
    pub error_code: Option<&'static str>,
    pub install_on_quit: bool,
    pub manual_check: bool,
    pub manual_download_url: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    schema_version: u8,
    policy: UpdatePolicy,
    #[serde(deserialize_with = "deserialize_skipped_version")]
    skipped_version: Option<String>,
}

fn deserialize_skipped_version<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            policy: UpdatePolicy::Ask,
            skipped_version: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    repository: String,
    releases: Vec<Release>,
}

#[derive(Deserialize)]
struct Release {
    version: String,
    tag: String,
    url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    platform: String,
    architecture: String,
    format: String,
    url: String,
    size: u64,
    sha256: String,
}

/// Only stable, canonical SemVer releases are advertised by this manifest.
/// Keep the numeric bound shared with the Electron implementation.
fn version_parts(value: &str) -> Result<[u64; 3], String> {
    if value.len() > 100 {
        return Err("Invalid release version".into());
    }
    let mut parts = [0; 3];
    let components: Vec<_> = value.split('.').collect();
    if components.len() != 3 {
        return Err("Invalid release version".into());
    }
    for (index, component) in components.iter().enumerate() {
        if component.is_empty()
            || !component.bytes().all(|byte| byte.is_ascii_digit())
            || (component.len() > 1 && component.starts_with('0'))
        {
            return Err("Invalid release version".into());
        }
        let number = component
            .parse::<u64>()
            .map_err(|_| "Invalid release version".to_string())?;
        if number > MAX_SAFE_INTEGER {
            return Err("Invalid release version".into());
        }
        parts[index] = number;
    }
    Ok(parts)
}

fn available_mac_version(
    bytes: &[u8],
    current_version: &str,
    arch: &str,
) -> Result<Option<String>, String> {
    let current = version_parts(current_version)?;
    if !matches!(arch, "arm64" | "x64") || bytes.len() > MAX_MANIFEST_BYTES {
        return Err("Invalid release manifest".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "Invalid release manifest".to_string())?;
    if manifest.schema_version != 1
        || manifest.repository != "WonderMr/blincho"
        || manifest.releases.len() > 200
    {
        return Err("Invalid release manifest".into());
    }
    let mut latest: Option<([u64; 3], String)> = None;
    let mut versions = HashSet::new();
    for release in manifest.releases {
        let parts = version_parts(&release.version)?;
        if !versions.insert(release.version.clone())
            || release.tag != format!("v{}", release.version)
            || release.url
                != format!(
                    "https://github.com/WonderMr/blincho/releases/tag/v{}",
                    release.version
                )
            || release.assets.len() > 30
        {
            return Err("Invalid release metadata".into());
        }
        let expected_name = format!("Blincho-{}-macos-{arch}.zip", release.version);
        let mut names = HashSet::new();
        let mut matching_asset = false;
        for asset in release.assets {
            // Validate canonical paths even for assets belonging to another
            // platform. Extra manifest fields never influence a native action.
            if asset.name.is_empty()
                || asset.name.len() > 255
                || !asset
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                || !names.insert(asset.name.clone())
                || asset.url
                    != format!(
                        "https://github.com/WonderMr/blincho/releases/download/v{}/{}",
                        release.version, asset.name
                    )
                || asset.size == 0
                || asset.size > MAX_SAFE_INTEGER
                || asset.sha256.len() != 64
                || !asset
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("Invalid package metadata".into());
            }
            if asset.name == expected_name {
                if asset.platform != "macos" || asset.architecture != arch || asset.format != "zip"
                {
                    return Err("Invalid package metadata".into());
                }
                matching_asset = true;
            }
        }
        if matching_asset
            && parts > current
            && latest
                .as_ref()
                .is_none_or(|(previous, _)| parts > *previous)
        {
            latest = Some((parts, release.version));
        }
    }
    Ok(latest.map(|(_, version)| version))
}

fn bounded_read(mut reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Read failed".to_string())?;
    if bytes.len() > limit {
        return Err("Oversized metadata".into());
    }
    Ok(bytes)
}

fn fetch_manifest(version: &str) -> Result<Vec<u8>, String> {
    version_parts(version)?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .user_agent(format!("Blincho/{version} (+https://blincho.app)"))
        .build()
        .map_err(|_| "Manifest request failed".to_string())?;
    let response = client
        .get(MANIFEST_URL)
        // Set the request timeout as well as the blocking client's timeout.
        // Its deadline includes the entire body, including a trickling stream.
        .timeout(REQUEST_TIMEOUT)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|_| "Manifest request failed".to_string())?;
    read_manifest_response(
        response.status().as_u16(),
        response.content_length(),
        response,
    )
}

fn read_manifest_response(
    status: u16,
    content_length: Option<u64>,
    reader: impl Read,
) -> Result<Vec<u8>, String> {
    if status != 200 || content_length.is_some_and(|size| size > MAX_MANIFEST_BYTES as u64) {
        return Err("Invalid manifest response".into());
    }
    bounded_read(reader, MAX_MANIFEST_BYTES)
}

fn read_preferences(path: &Path) -> Result<Preferences, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preferences::default());
        }
        Err(_) => return Err("Preferences unavailable".into()),
    };
    let bytes = bounded_read(file, MAX_PREFERENCE_BYTES)?;
    let preferences: Preferences =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid preferences".to_string())?;
    if preferences.schema_version != 1
        || preferences
            .skipped_version
            .as_deref()
            .is_some_and(|version| version_parts(version).is_err())
    {
        return Err("Invalid preferences".into());
    }
    Ok(preferences)
}

fn save_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "Invalid preference path".to_string())?;
    fs::create_dir_all(directory).map_err(|_| "Preferences unavailable".to_string())?;
    let id = TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(
        ".update-preferences.{}.{id}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Preferences unavailable".to_string())?;
        serde_json::to_writer(&mut file, preferences)
            .map_err(|_| "Preferences unavailable".to_string())?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|_| "Preferences unavailable".to_string())?;
        fs::rename(&temporary, path).map_err(|_| "Preferences unavailable".to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

type FetchManifest = dyn Fn(&str) -> Result<Vec<u8>, String> + Send + Sync;
type StateCallback = dyn Fn(UpdateState) + Send + Sync;

struct Inner {
    state: UpdateState,
    preferences: Preferences,
    generation: u64,
    operation: Option<u64>,
    started: bool,
    disposed: bool,
    next_check_at: Option<Instant>,
}

pub struct UpdateController {
    inner: Mutex<Inner>,
    changed: Condvar,
    preference_path: PathBuf,
    arch: String,
    fetch: Arc<FetchManifest>,
    on_state: Arc<StateCallback>,
    initial_delay: Duration,
    check_interval: Duration,
}

impl UpdateController {
    /// The callback is serialized with state mutations. It may emit an event,
    /// but must not call another controller method from inside the callback.
    pub fn new(
        data_dir: PathBuf,
        current_version: String,
        arch: &str,
        packaged: bool,
        on_state: impl Fn(UpdateState) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let arch = match arch {
            "aarch64" | "arm64" => "arm64",
            "x86_64" | "x64" => "x64",
            _ => arch,
        };
        let support_reason = if !packaged {
            Some("development")
        } else if !cfg!(target_os = "macos") || !matches!(arch, "arm64" | "x64") {
            Some("unsupported-package")
        } else if version_parts(&current_version).is_err() {
            Some("missing-config")
        } else {
            Some("unsigned-mac")
        };
        Self::with_dependencies(
            data_dir,
            current_version,
            arch,
            support_reason,
            Arc::new(fetch_manifest),
            Arc::new(on_state),
            INITIAL_DELAY,
            CHECK_INTERVAL,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_dependencies(
        data_dir: PathBuf,
        current_version: String,
        arch: &str,
        support_reason: Option<&'static str>,
        fetch: Arc<FetchManifest>,
        on_state: Arc<StateCallback>,
        initial_delay: Duration,
        check_interval: Duration,
    ) -> Arc<Self> {
        let preference_path = data_dir.join("update-preferences.json");
        let (mut preferences, preference_error) = match read_preferences(&preference_path) {
            Ok(preferences) => (preferences, false),
            Err(_) => (
                Preferences {
                    policy: UpdatePolicy::Off,
                    ..Preferences::default()
                },
                true,
            ),
        };
        // Existing Electron auto consent cannot promise installation for an
        // unsigned manual package. Preserve its normalization to ask.
        if preferences.policy == UpdatePolicy::Auto {
            preferences.policy = UpdatePolicy::Ask;
        }
        let state = UpdateState {
            policy: preferences.policy,
            status: if preference_error { "error" } else { "idle" },
            supported: false,
            check_supported: support_reason == Some("unsigned-mac"),
            support_reason,
            current_version,
            available_version: None,
            skipped_version: preferences.skipped_version.clone(),
            progress: None,
            last_checked_at: None,
            error_code: preference_error.then_some("preferences-failed"),
            install_on_quit: false,
            manual_check: false,
            manual_download_url: MANUAL_DOWNLOAD_URL,
        };
        Arc::new(Self {
            inner: Mutex::new(Inner {
                state,
                preferences,
                generation: 0,
                operation: None,
                started: false,
                disposed: false,
                next_check_at: None,
            }),
            changed: Condvar::new(),
            preference_path,
            arch: arch.to_string(),
            fetch,
            on_state,
            initial_delay,
            check_interval,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, inner: &Inner) -> UpdateState {
        let state = inner.state.clone();
        // Renderer shutdown or callback failure must not disrupt preferences.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.on_state)(state.clone());
        }));
        state
    }

    pub fn get_state(&self) -> UpdateState {
        self.lock().state.clone()
    }

    fn revoke(&self, inner: &mut Inner) {
        inner.generation = inner.generation.wrapping_add(1);
        inner.operation = None;
        self.changed.notify_all();
    }

    fn reschedule(&self, inner: &mut Inner) {
        inner.next_check_at = if inner.started
            && !inner.disposed
            && inner.state.check_supported
            && inner.state.policy != UpdatePolicy::Off
        {
            Some(Instant::now() + self.initial_delay)
        } else {
            None
        };
        self.changed.notify_all();
    }

    fn save(&self, inner: &mut Inner, preferences: Preferences) -> bool {
        if save_preferences(&self.preference_path, &preferences).is_err() {
            self.revoke(inner);
            inner.state.policy = UpdatePolicy::Off;
            inner.state.status = "error";
            inner.state.error_code = Some("preferences-failed");
            inner.state.available_version = None;
            inner.next_check_at = None;
            self.changed.notify_all();
            return false;
        }
        inner.preferences = preferences;
        true
    }

    pub fn set_policy(&self, policy: &str) -> UpdateState {
        let mut inner = self.lock();
        let policy = match policy {
            "ask" => UpdatePolicy::Ask,
            "off" => UpdatePolicy::Off,
            // Automatic installation is unavailable for an unsigned package.
            _ => {
                inner.state.error_code = Some("invalid-request");
                return self.publish(&inner);
            }
        };
        if inner.disposed {
            return inner.state.clone();
        }
        self.revoke(&mut inner);
        let preferences = Preferences {
            policy,
            ..inner.preferences.clone()
        };
        if !self.save(&mut inner, preferences) {
            return self.publish(&inner);
        }
        inner.state.policy = policy;
        inner.state.status = "idle";
        inner.state.available_version = None;
        inner.state.error_code = None;
        inner.state.manual_check = false;
        self.reschedule(&mut inner);
        self.publish(&inner)
    }

    /// Run on a blocking worker. Concurrent callers share the pending result.
    /// Policy changes, skipping and disposal invalidate every earlier result.
    pub fn check(&self, manual: bool) -> UpdateState {
        let (generation, version) = {
            let mut inner = self.lock();
            if inner.disposed || (!manual && inner.state.policy == UpdatePolicy::Off) {
                return inner.state.clone();
            }
            if let Some(operation) = inner.operation {
                while inner.operation == Some(operation)
                    && inner.generation == operation
                    && !inner.disposed
                {
                    inner = self
                        .changed
                        .wait(inner)
                        .unwrap_or_else(|error| error.into_inner());
                }
                return inner.state.clone();
            }
            if !inner.state.check_supported {
                if manual {
                    inner.state.status = "manual";
                    inner.state.manual_check = true;
                    inner.state.error_code = None;
                    return self.publish(&inner);
                }
                return inner.state.clone();
            }
            inner.generation = inner.generation.wrapping_add(1);
            inner.operation = Some(inner.generation);
            inner.state.status = "checking";
            inner.state.available_version = None;
            inner.state.manual_check = manual;
            inner.state.error_code = None;
            self.publish(&inner);
            (inner.generation, inner.state.current_version.clone())
        };
        let result = (self.fetch)(&version)
            .and_then(|bytes| available_mac_version(&bytes, &version, &self.arch));
        let mut inner = self.lock();
        if inner.disposed || inner.generation != generation || inner.operation != Some(generation) {
            return inner.state.clone();
        }
        inner.operation = None;
        match result {
            Ok(next_version) => {
                let skipped = !manual
                    && next_version.is_some()
                    && next_version == inner.preferences.skipped_version;
                inner.state.status = if skipped {
                    "idle"
                } else if next_version.is_some() {
                    "available"
                } else {
                    "up-to-date"
                };
                inner.state.available_version = if skipped { None } else { next_version };
                inner.state.last_checked_at =
                    Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
            Err(_) => {
                inner.state.status = "error";
                inner.state.error_code = Some("check-failed");
            }
        }
        self.changed.notify_all();
        self.publish(&inner)
    }

    pub fn skip(&self, version: &str) -> UpdateState {
        let mut inner = self.lock();
        if inner.disposed
            || version_parts(version).is_err()
            || inner.state.available_version.as_deref() != Some(version)
        {
            inner.state.error_code = Some("invalid-request");
            return self.publish(&inner);
        }
        self.revoke(&mut inner);
        let preferences = Preferences {
            skipped_version: Some(version.to_string()),
            ..inner.preferences.clone()
        };
        if !self.save(&mut inner, preferences) {
            return self.publish(&inner);
        }
        inner.state.skipped_version = Some(version.to_string());
        inner.state.available_version = None;
        inner.state.status = "idle";
        inner.state.error_code = None;
        self.publish(&inner)
    }

    /// Preserve the shared bridge API without ever downloading an installer.
    pub fn download(&self, _version: &str) -> UpdateState {
        let mut inner = self.lock();
        inner.state.error_code = Some("invalid-request");
        self.publish(&inner)
    }

    pub fn start(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            if inner.started || inner.disposed {
                return;
            }
            inner.started = true;
            self.reschedule(&mut inner);
        }
        let controller = Arc::clone(self);
        std::thread::spawn(move || controller.background_loop());
    }

    fn background_loop(&self) {
        let mut inner = self.lock();
        loop {
            if inner.disposed {
                return;
            }
            if let Some(deadline) = inner.next_check_at {
                let delay = deadline.saturating_duration_since(Instant::now());
                if delay.is_zero() {
                    inner.next_check_at = None;
                    drop(inner);
                    self.check(false);
                    inner = self.lock();
                    if !inner.disposed
                        && inner.state.check_supported
                        && inner.state.policy != UpdatePolicy::Off
                        && inner.next_check_at.is_none()
                    {
                        inner.next_check_at = Some(Instant::now() + self.check_interval);
                    }
                    continue;
                }
                inner = self
                    .changed
                    .wait_timeout(inner, delay)
                    .unwrap_or_else(|error| error.into_inner())
                    .0;
            } else {
                inner = self
                    .changed
                    .wait(inner)
                    .unwrap_or_else(|error| error.into_inner());
            }
        }
    }

    pub fn dispose(&self) {
        let mut inner = self.lock();
        inner.disposed = true;
        inner.next_check_at = None;
        self.revoke(&mut inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::{atomic::AtomicUsize, mpsc};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = TEMPORARY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("blincho-updates-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn release(version: &str, arch: &str) -> Value {
        let name = format!("Blincho-{version}-macos-{arch}.zip");
        json!({
            "version": version, "tag": format!("v{version}"),
            "url": format!("https://github.com/WonderMr/blincho/releases/tag/v{version}"),
            "assets": [{ "name": name, "platform": "macos", "architecture": arch,
                "format": "zip", "size": 1024, "sha256": "a".repeat(64),
                "url": format!("https://github.com/WonderMr/blincho/releases/download/v{version}/{name}") }]
        })
    }

    fn manifest(releases: Vec<Value>) -> Value {
        json!({"schemaVersion": 1, "repository": "WonderMr/blincho", "releases": releases})
    }

    fn bytes(manifest: &Value) -> Vec<u8> {
        serde_json::to_vec(manifest).unwrap()
    }

    fn newer_manifest() -> Vec<u8> {
        bytes(&manifest(vec![release("1.6.0", "arm64")]))
    }

    fn controller(directory: &TestDirectory, fetch: Arc<FetchManifest>) -> Arc<UpdateController> {
        UpdateController::with_dependencies(
            directory.0.clone(),
            "1.5.0".into(),
            "arm64",
            Some("unsigned-mac"),
            fetch,
            Arc::new(|_| {}),
            Duration::from_millis(20),
            Duration::from_millis(40),
        )
    }

    #[test]
    fn strict_stable_semver_and_numeric_comparison() {
        assert!(version_parts("1.10.0").unwrap() > version_parts("1.9.0").unwrap());
        for invalid in [
            "",
            "1.4",
            "1.4.0.1",
            "01.4.0",
            "1.04.0",
            "1.4.00",
            "1.4.3-beta",
            "1.4.3+build",
            " 1.4.3",
            "1.4.3\n",
            "9007199254740992.0.0",
            "99999999999999999999.0.0",
            "１.4.0",
            "<script>",
        ] {
            assert!(version_parts(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn selects_newer_matching_architecture_only() {
        let list = bytes(&manifest(vec![
            release("1.9.0", "arm64"),
            release("1.10.0", "arm64"),
            release("2.0.0", "x64"),
            release("1.4.2", "arm64"),
        ]));
        assert_eq!(
            available_mac_version(&list, "1.5.0", "arm64").unwrap(),
            Some("1.10.0".into())
        );
        assert_eq!(
            available_mac_version(&list, "1.5.0", "x64").unwrap(),
            Some("2.0.0".into())
        );
        assert_eq!(
            available_mac_version(&list, "2.0.0", "arm64").unwrap(),
            None
        );
        assert_eq!(
            available_mac_version(&bytes(&manifest(vec![])), "1.5.0", "arm64").unwrap(),
            None
        );
        assert!(available_mac_version(&list, "1.5.0", "riscv64").is_err());
    }

    #[test]
    fn rejects_schema_repository_version_and_release_url_tampering() {
        for bad in [
            Value::Null,
            json!({}),
            json!({"schemaVersion": 1}),
            json!({"schemaVersion": 2, "repository": "WonderMr/blincho", "releases": []}),
            json!({"schemaVersion": 1, "repository": "attacker/repo", "releases": []}),
            manifest(vec![Value::Null]),
            manifest(vec![release("01.6.0", "arm64")]),
        ] {
            assert!(available_mac_version(&bytes(&bad), "1.5.0", "arm64").is_err());
        }
        for (field, value) in [
            ("tag", json!("1.6.0")),
            ("url", json!("https://evil.test/release")),
        ] {
            let mut item = release("1.6.0", "arm64");
            item[field] = value;
            assert!(
                available_mac_version(&bytes(&manifest(vec![item])), "1.5.0", "arm64").is_err()
            );
        }
    }

    #[test]
    fn rejects_package_url_architecture_and_integrity_tampering() {
        let urls = [
            "http://github.com/WonderMr/blincho/releases/download/v1.6.0/Blincho-1.6.0-macos-arm64.zip",
            "https://evil.test/update.zip",
            "https://github.com@evil.test/update.zip",
            "https://github.com/WonderMr/other/releases/download/v1.6.0/Blincho-1.6.0-macos-arm64.zip",
            "https://github.com/WonderMr/blincho/releases/download/v1.6.0/Blincho-1.6.0-macos-arm64.zip?token=a",
        ];
        let mut patches = urls
            .into_iter()
            .map(|url| ("url", json!(url)))
            .collect::<Vec<_>>();
        patches.extend([
            ("size", json!(0)),
            ("size", json!(-1)),
            ("size", json!(1.5)),
            ("size", json!(MAX_SAFE_INTEGER + 1)),
            ("sha256", json!("")),
            ("sha256", json!("A".repeat(64))),
            ("architecture", json!("x64")),
            ("format", json!("dmg")),
            ("platform", json!("windows")),
        ]);
        for (field, value) in patches {
            let mut item = release("1.6.0", "arm64");
            item["assets"][0][field] = value;
            assert!(
                available_mac_version(&bytes(&manifest(vec![item])), "1.5.0", "arm64").is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn rejects_oversized_duplicate_and_ambiguous_metadata() {
        assert!(bounded_read(&b"12345"[..], 4).is_err());
        assert_eq!(bounded_read(&b"1234"[..], 4).unwrap(), b"1234");
        assert!(
            available_mac_version(&vec![b' '; MAX_MANIFEST_BYTES + 1], "1.5.0", "arm64").is_err()
        );
        let item = release("1.6.0", "arm64");
        assert!(available_mac_version(
            &bytes(&manifest(vec![item.clone(), item.clone()])),
            "1.5.0",
            "arm64"
        )
        .is_err());
        let mut duplicate_asset = item.clone();
        duplicate_asset["assets"] = json!([item["assets"][0], item["assets"][0]]);
        assert!(
            available_mac_version(&bytes(&manifest(vec![duplicate_asset])), "1.5.0", "arm64")
                .is_err()
        );
        assert!(
            available_mac_version(&bytes(&manifest(vec![item; 201])), "1.5.0", "arm64").is_err()
        );
    }

    #[test]
    fn transport_rejects_redirect_errors_and_bounded_body_failures() {
        assert_eq!(MANIFEST_URL, "https://blincho.app/releases.json");
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(15));
        for status in [204, 301, 302, 307, 308, 404, 500] {
            assert!(read_manifest_response(status, None, &b"{}"[..]).is_err());
        }
        assert!(
            read_manifest_response(200, Some(MAX_MANIFEST_BYTES as u64 + 1), &b"{}"[..]).is_err()
        );
        assert!(
            read_manifest_response(200, None, &vec![b'x'; MAX_MANIFEST_BYTES + 1][..]).is_err()
        );
        assert_eq!(
            read_manifest_response(200, Some(2), &b"{}"[..]).unwrap(),
            b"{}"
        );
        assert!(fetch_manifest("1.5.0\r\nInjected: value").is_err());
    }

    #[test]
    fn persists_policy_skip_and_normalizes_legacy_auto_consent() {
        let directory = TestDirectory::new();
        let updates = controller(&directory, Arc::new(|_| Ok(newer_manifest())));
        assert_eq!(
            updates.check(true).available_version.as_deref(),
            Some("1.6.0")
        );
        assert_eq!(
            updates.skip("1.6.0").skipped_version.as_deref(),
            Some("1.6.0")
        );
        updates.set_policy("off");
        let reopened = controller(&directory, Arc::new(|_| Ok(newer_manifest())));
        assert_eq!(reopened.get_state().policy, UpdatePolicy::Off);
        assert_eq!(
            reopened.get_state().skipped_version.as_deref(),
            Some("1.6.0")
        );
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.0.join("update-preferences.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        save_preferences(
            &directory.0.join("update-preferences.json"),
            &Preferences {
                policy: UpdatePolicy::Auto,
                ..Preferences::default()
            },
        )
        .unwrap();
        assert_eq!(
            controller(&directory, Arc::new(|_| Ok(newer_manifest())))
                .get_state()
                .policy,
            UpdatePolicy::Ask
        );
        assert_eq!(
            updates.set_policy("auto").error_code,
            Some("invalid-request")
        );
    }

    #[test]
    fn corrupt_preferences_fail_closed_and_do_not_start_background_checks() {
        for invalid in [
            "{",
            r#"{"schemaVersion":2,"policy":"ask","skippedVersion":null}"#,
            r#"{"schemaVersion":1,"policy":"evil","skippedVersion":null}"#,
            r#"{"schemaVersion":1,"policy":"auto","skippedVersion":"01.6.0"}"#,
            r#"{"schemaVersion":1,"policy":"ask"}"#,
        ] {
            let directory = TestDirectory::new();
            fs::write(directory.0.join("update-preferences.json"), invalid).unwrap();
            let count = Arc::new(AtomicUsize::new(0));
            let counter = count.clone();
            let updates = controller(
                &directory,
                Arc::new(move |_| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(newer_manifest())
                }),
            );
            assert_eq!(updates.get_state().policy, UpdatePolicy::Off);
            assert_eq!(updates.get_state().error_code, Some("preferences-failed"));
            updates.start();
            std::thread::sleep(Duration::from_millis(35));
            assert_eq!(count.load(Ordering::SeqCst), 0);
            updates.dispose();
        }
    }

    #[test]
    fn preference_save_failure_revokes_policy_and_preserves_existing_bytes() {
        let directory = TestDirectory::new();
        let updates = controller(&directory, Arc::new(|_| Ok(newer_manifest())));
        // Replacing the destination with a directory makes rename fail.
        fs::create_dir(directory.0.join("update-preferences.json")).unwrap();
        let state = updates.set_policy("ask");
        assert_eq!(state.policy, UpdatePolicy::Off);
        assert_eq!(state.status, "error");
        assert_eq!(state.error_code, Some("preferences-failed"));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn off_disables_background_but_manual_checks_ignore_off_and_skips() {
        let directory = TestDirectory::new();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let updates = controller(
            &directory,
            Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(newer_manifest())
            }),
        );
        updates.set_policy("off");
        assert_eq!(updates.check(false).status, "idle");
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(updates.check(true).status, "available");
        updates.skip("1.6.0");
        updates.set_policy("ask");
        assert_eq!(updates.check(false).status, "idle");
        assert_eq!(updates.check(true).status, "available");
        assert_eq!(updates.get_state().manual_check, true);
        assert_eq!(
            updates.download("1.6.0").error_code,
            Some("invalid-request")
        );
        assert!(!updates.get_state().install_on_quit);
    }

    #[test]
    fn failed_check_is_an_error_with_no_success_timestamp() {
        let directory = TestDirectory::new();
        for fetch in [
            Arc::new(|_: &str| Err("offline".into())) as Arc<FetchManifest>,
            Arc::new(|_: &str| Ok(b"<html>".to_vec())) as Arc<FetchManifest>,
        ] {
            let state = controller(&directory, fetch).check(true);
            assert_eq!(state.status, "error");
            assert_eq!(state.error_code, Some("check-failed"));
            assert_eq!(state.last_checked_at, None);
        }
    }

    #[test]
    fn stale_network_result_cannot_overwrite_changed_policy_or_publish() {
        let directory = TestDirectory::new();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = events.clone();
        let updates = UpdateController::with_dependencies(
            directory.0.clone(),
            "1.5.0".into(),
            "arm64",
            Some("unsigned-mac"),
            Arc::new(move |_| {
                entered_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
                Ok(newer_manifest())
            }),
            Arc::new(move |state| captured_events.lock().unwrap().push(state)),
            INITIAL_DELAY,
            CHECK_INTERVAL,
        );
        let checking = updates.clone();
        let worker = std::thread::spawn(move || checking.check(true));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let changed = updates.set_policy("off");
        let event_count = events.lock().unwrap().len();
        release_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), changed);
        assert_eq!(updates.get_state(), changed);
        assert_eq!(events.lock().unwrap().len(), event_count);
    }

    #[test]
    fn concurrent_checks_share_a_single_fetch() {
        let directory = TestDirectory::new();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let updates = controller(
            &directory,
            Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                entered_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
                Ok(newer_manifest())
            }),
        );
        let first = updates.clone();
        let first = std::thread::spawn(move || first.check(true));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = updates.clone();
        let second = std::thread::spawn(move || second.check(true));
        std::thread::sleep(Duration::from_millis(20));
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap(), second.join().unwrap());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn background_initial_delay_interval_single_loop_and_policy_revocation() {
        assert_eq!(INITIAL_DELAY, Duration::from_secs(60));
        assert_eq!(CHECK_INTERVAL, Duration::from_secs(6 * 60 * 60));
        let directory = TestDirectory::new();
        let (fetched_tx, fetched_rx) = mpsc::channel();
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let updates = controller(
            &directory,
            Arc::new(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                fetched_tx.send(Instant::now()).unwrap();
                Ok(newer_manifest())
            }),
        );
        let started_at = Instant::now();
        updates.start();
        updates.start();
        let first_at = fetched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second_at = fetched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(first_at.duration_since(started_at) >= Duration::from_millis(20));
        assert!(second_at.duration_since(first_at) >= Duration::from_millis(40));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        updates.set_policy("off");
        assert!(fetched_rx.recv_timeout(Duration::from_millis(60)).is_err());
        updates.set_policy("ask");
        fetched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        updates.dispose();
        assert!(fetched_rx.recv_timeout(Duration::from_millis(60)).is_err());
    }

    #[test]
    fn serialized_state_matches_shared_frontend_names_and_manual_support() {
        let directory = TestDirectory::new();
        let updates = controller(&directory, Arc::new(|_| Ok(newer_manifest())));
        let state = serde_json::to_value(updates.get_state()).unwrap();
        assert_eq!(state["checkSupported"], true);
        assert_eq!(state["supported"], false);
        assert_eq!(state["supportReason"], "unsigned-mac");
        assert_eq!(state["manualDownloadUrl"], MANUAL_DOWNLOAD_URL);
        assert_eq!(state["installOnQuit"], false);
        assert_eq!(state.as_object().unwrap().len(), 14);
    }
}
