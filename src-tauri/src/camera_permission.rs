/// The Linux media grant is limited to the bundled main document. The app's
/// default-src 'self' CSP also prohibits frames from foreign origins.
fn camera_access_allowed(
    enabled: bool,
    uri: Option<&str>,
    audio: bool,
    video: bool,
    display: bool,
) -> bool {
    if !enabled || audio || !video || display {
        return false;
    }
    let Some(url) = uri.and_then(|uri| tauri::Url::parse(uri).ok()) else {
        return false;
    };
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(target_os = "linux")]
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    use webkit2gtk::{
        glib::prelude::*, PermissionRequestExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    if window.label() != "main" {
        return Err("Camera permission handler requires the main window".into());
    }
    let app = window.app_handle().clone();
    window
        .with_webview(move |platform| {
            platform
                .inner()
                .connect_permission_request(move |view, request| {
                    let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                        return false;
                    };
                    let enabled = app
                        .state::<crate::Runtime>()
                        .timer
                        .lock()
                        .map(|timer| timer.camera_lock_enabled())
                        .unwrap_or(false);
                    // The pinned binding exposes the display predicate only through
                    // FFI. WebKitGTK 2.34 added it, below Tauri's 2.40 minimum. `media`
                    // is a live, type-checked GObject borrowed for this callback.
                    let display = unsafe {
                        webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(
                            media.as_ptr(),
                        ) != 0
                    };
                    if camera_access_allowed(
                        enabled,
                        view.uri().as_deref(),
                        media.is_for_audio_device(),
                        media.is_for_video_device(),
                        display,
                    ) {
                        request.allow();
                    } else {
                        request.deny();
                    }
                    true
                });
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_video_camera_requests_can_be_granted() {
        for audio in [false, true] {
            for video in [false, true] {
                for display in [false, true] {
                    assert_eq!(
                        camera_access_allowed(
                            true,
                            Some("tauri://localhost/index.html"),
                            audio,
                            video,
                            display,
                        ),
                        !audio && video && !display,
                    );
                }
            }
        }
    }

    #[test]
    fn camera_requires_the_current_setting_and_trusted_document() {
        assert!(!camera_access_allowed(
            false,
            Some("tauri://localhost/index.html"),
            false,
            true,
            false,
        ));
        for uri in [
            None,
            Some(""),
            Some("about:blank"),
            Some("https://example.com/"),
            Some("https://tauri.localhost/"),
            Some("http://localhost:5173/"),
            Some("tauri://localhost.evil/"),
            Some("tauri://localhost:443/"),
            Some("tauri://user@localhost/"),
            Some("tauri://user:password@localhost/"),
        ] {
            assert!(!camera_access_allowed(true, uri, false, true, false));
        }
        assert!(camera_access_allowed(
            true,
            Some("tauri://localhost/index.html?route=settings#camera"),
            false,
            true,
            false,
        ));
    }
}
