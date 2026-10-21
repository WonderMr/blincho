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
