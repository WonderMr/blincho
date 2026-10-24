use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const TEST_NAME: &str = "Blincho Test";
pub const TEST_IDENTIFIER: &str = "com.myeyes.test";

pub fn is_test(app: &AppHandle) -> bool {
    // Native smoke profiles replace the identifier, but keep the channel name.
    app.config().identifier == TEST_IDENTIFIER
        || app.config().product_name.as_deref() == Some(TEST_NAME)
}

pub fn name(app: &AppHandle) -> &str {
    if is_test(app) {
        TEST_NAME
    } else {
        "Blincho"
    }
}

pub fn webview_directory(
    app: &AppHandle,
    prototype: Option<&Path>,
    profile: &Path,
) -> Option<PathBuf> {
    prototype
        .map(Path::to_path_buf)
        .or_else(|| is_test(app).then(|| profile.to_path_buf()))
}

#[cfg(any(target_os = "macos", test))]
pub fn webview_store_identifier(prototype: Option<&Path>, path: &Path) -> [u8; 16] {
    if prototype.is_none() {
        // Persistent test storage must survive toolchain upgrades and profile moves.
        return *b"blincho-test-v1\0";
    }
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    let value = hash.finish();
    let mut identifier = [0_u8; 16];
    identifier[..8].copy_from_slice(&value.to_le_bytes());
    identifier[8..].copy_from_slice(&value.to_be_bytes());
    identifier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_test_webviews_keep_the_same_store_when_the_profile_moves() {
        assert_eq!(
            webview_store_identifier(None, Path::new("/first/profile")),
            *b"blincho-test-v1\0"
        );
        assert_eq!(
            webview_store_identifier(None, Path::new("/moved/profile")),
            *b"blincho-test-v1\0"
        );
    }

    #[test]
    fn prototype_webviews_share_their_profile_store_but_stay_isolated_from_other_runs() {
        let first = Path::new("/prototype/first");
        let second = Path::new("/prototype/second");
        let identifier = webview_store_identifier(Some(first), first);
        assert_eq!(identifier, webview_store_identifier(Some(first), first));
        assert_ne!(identifier, webview_store_identifier(Some(second), second));
        assert_ne!(identifier, webview_store_identifier(None, first));
    }
}
