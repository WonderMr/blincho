use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex};
use tauri::Manager;

macro_rules! icons {
    ($($name:literal),+ $(,)?) => { [$(include_bytes!(concat!("../../public/symbiote/", $name, ".png")) as &[u8]),+] };
}
const ICONS: [&[u8]; 64] = icons![
    "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "0a", "0b", "0c", "0d", "0e", "0f",
    "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "1a", "1b", "1c", "1d", "1e", "1f",
    "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "2a", "2b", "2c", "2d", "2e", "2f",
    "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "3a", "3b", "3c", "3d", "3e", "3f",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    mask: u8,
}

impl Selection {
    fn validate(&self) -> Result<u8, String> {
        if self.mask > 63 {
            return Err("Invalid build mask".into());
        }
        Ok(self.mask)
    }
}

#[derive(Default)]
pub struct Appearance(Mutex<Applied>, Condvar);

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Applied {
    requested: u8,
    applied: Option<u8>,
    applying: bool,
    updates: u64,
    error: Option<String>,
}

pub fn image(mask: u8) -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(ICONS[usize::from(mask)])
}

#[cfg(target_os = "macos")]
fn apply(app: &tauri::AppHandle, mask: u8) -> Result<(), String> {
    unsafe extern "C" {
        fn blincho_set_application_icon(bytes: *const u8, length: usize) -> bool;
    }
    let bytes = ICONS[usize::from(mask)];
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let applied = unsafe { blincho_set_application_icon(bytes.as_ptr(), bytes.len()) };
        let _ = send.send(applied);
    })
    .map_err(|error| error.to_string())?;
    match receive.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(true) => Ok(()),
        Ok(false) => Err("Unable to apply application icon".into()),
        Err(error) => Err(format!("Application icon dispatch: {error}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn apply(app: &tauri::AppHandle, mask: u8) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    window
        .set_icon(image(mask).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

impl Appearance {
    fn request(&self, mask: u8) -> Result<(), String> {
        self.0.lock().map_err(|error| error.to_string())?.requested = mask;
        Ok(())
    }

    // Admission happens before native dispatch. One owner updates both surfaces;
    // other callers wait for acknowledgement and can recover a failed owner.
    fn apply_latest(&self, mut apply: impl FnMut(u8) -> Result<(), String>) -> Result<(), String> {
        {
            let mut current = self.0.lock().map_err(|error| error.to_string())?;
            while current.applying {
                current = self.1.wait(current).map_err(|error| error.to_string())?;
            }
            if current.applied == Some(current.requested) {
                return Ok(());
            }
            current.applying = true;
        }
        loop {
            let wanted = {
                let mut current = self.0.lock().map_err(|error| error.to_string())?;
                if current.applied == Some(current.requested) {
                    current.applying = false;
                    self.1.notify_all();
                    return Ok(());
                }
                current.requested
            };
            let result = apply(wanted);
            let mut current = self.0.lock().map_err(|error| error.to_string())?;
            if let Err(error) = result {
                current.applying = false;
                current.applied = None;
                current.error = Some(error.clone());
                self.1.notify_all();
                return Err(error);
            }
            current.applied = Some(wanted);
            current.error = None;
            current.updates += 1;
        }
    }
}

#[tauri::command]
pub async fn set_symbiote_build(selection: Selection, app: tauri::AppHandle) -> Result<(), String> {
    let mask = selection.validate()?;
    app.state::<Appearance>().request(mask)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Appearance>().apply_latest(|wanted| {
            crate::tray_preview::set_symbiote_mask(&app, wanted)?;
            apply(&app, wanted)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

pub fn diagnostics(app: &tauri::AppHandle) -> serde_json::Value {
    app.state::<Appearance>()
        .0
        .lock()
        .map(|state| serde_json::to_value(&*state).unwrap_or_default())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_accepts_only_a_fixed_integer_mask() {
        for mask in 0..64 {
            let selection: Selection =
                serde_json::from_value(serde_json::json!({"mask": mask})).unwrap();
            assert_eq!(selection.validate().unwrap(), mask);
            let icon = image(mask).unwrap();
            assert_eq!((icon.width(), icon.height()), (256, 256));
        }
        for value in [
            serde_json::json!({"mask": -1}),
            serde_json::json!({"mask": 0.5}),
            serde_json::json!({"mask": "63"}),
            serde_json::json!({"mask": 1, "path": "/tmp/icon.png"}),
        ] {
            assert!(serde_json::from_value::<Selection>(value).is_err());
        }
        assert!(Selection { mask: 64 }.validate().is_err());
        assert!(Selection { mask: 255 }.validate().is_err());
    }
    #[test]
    fn slow_old_dispatch_catches_up_without_overwriting_a_newer_request() {
        for fail_first in [false, true] {
            let state = std::sync::Arc::new(Appearance::default());
            let applied = std::sync::Arc::new(Mutex::new(Vec::new()));
            let (entered, entered_rx) = std::sync::mpsc::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            state.request(1).unwrap();
            let first_state = state.clone();
            let first_applied = applied.clone();
            let first = std::thread::spawn(move || {
                first_state.apply_latest(|mask| {
                    if mask == 1 {
                        entered.send(()).unwrap();
                        release_rx
                            .recv_timeout(std::time::Duration::from_secs(3))
                            .unwrap();
                        if fail_first {
                            return Err("native failure".into());
                        }
                    }
                    first_applied.lock().unwrap().push(mask);
                    Ok(())
                })
            });
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
            state.request(63).unwrap();
            let next_state = state.clone();
            let next_applied = applied.clone();
            let next = std::thread::spawn(move || {
                next_state.apply_latest(|mask| {
                    next_applied.lock().unwrap().push(mask);
                    Ok(())
                })
            });
            release.send(()).unwrap();
            assert_eq!(first.join().unwrap().is_err(), fail_first);
            next.join().unwrap().unwrap();
            let current = state.0.lock().unwrap();
            assert_eq!(current.applied, Some(63));
            assert_eq!(current.requested, 63);
            assert!(!current.applying);
            assert!(current.error.is_none());
            assert_eq!(
                *applied.lock().unwrap(),
                if fail_first { vec![63] } else { vec![1, 63] }
            );
        }
    }

    #[test]
    fn a_late_worker_only_applies_the_latest_admitted_mask() {
        let state = Appearance::default();
        state.request(1).unwrap();
        state.request(2).unwrap();
        let mut masks = Vec::new();
        state
            .apply_latest(|mask| {
                masks.push(mask);
                Ok(())
            })
            .unwrap();
        state
            .apply_latest(|_| panic!("Already acknowledged"))
            .unwrap();
        assert_eq!(masks, vec![2]);
    }
    #[test]
    fn reverting_after_a_partial_failure_reapplies_both_surfaces() {
        let state = Appearance::default();
        let (mut tray, mut application) = (0, 0);
        state.request(1).unwrap();
        state
            .apply_latest(|mask| {
                tray = mask;
                application = mask;
                Ok(())
            })
            .unwrap();
        state.request(2).unwrap();
        assert!(state
            .apply_latest(|mask| {
                tray = mask;
                Err("application failure".into())
            })
            .is_err());
        assert_eq!((tray, application), (2, 1));
        state.request(1).unwrap();
        state
            .apply_latest(|mask| {
                tray = mask;
                application = mask;
                Ok(())
            })
            .unwrap();
        assert_eq!((tray, application), (1, 1));
    }
}
