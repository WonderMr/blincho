use serde::Deserialize;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct CameraActivity(Mutex<Activity>);

#[derive(Default)]
struct Activity {
    generation: u64,
    revision: u64,
    active: bool,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    generation: u64,
    revision: u64,
    active: bool,
    label: String,
}

impl Activity {
    fn accept(&mut self, report: Report) -> Result<(), String> {
        if report.generation != self.generation || report.revision <= self.revision {
            return Err("Obsolete camera activity".into());
        }
        if report.revision > 9_007_199_254_740_991
            || report.label.trim().is_empty()
            || report.label.len() > 256
            || report.label.contains('\0')
        {
            return Err("Invalid camera activity".into());
        }
        self.revision = report.revision;
        self.active = report.active;
        self.label = report.label;
        Ok(())
    }

    fn reset(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.revision = 0;
        self.active = false;
        self.label.clear();
    }
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Camera activity belongs to the main renderer".into())
    }
}

#[tauri::command]
pub fn camera_activity_generation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    require_main(&window)?;
    let state = app.state::<CameraActivity>();
    let generation = state
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .generation;
    Ok(generation)
}

#[tauri::command]
pub async fn camera_activity_update(
    input: Report,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    require_main(&window)?;
    app.state::<CameraActivity>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .accept(input)?;
    tauri::async_runtime::spawn_blocking(move || refresh(&app))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn current(app: &tauri::AppHandle) -> (bool, String) {
    app.try_state::<CameraActivity>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .map(|value| (value.active, value.label.clone()))
        })
        .unwrap_or_default()
}

fn refresh(app: &tauri::AppHandle) {
    let Some(runtime) = app.try_state::<crate::Runtime>() else {
        return;
    };
    let Some(_) = app.try_state::<crate::tray_preview::Preview>() else {
        return;
    };
    let Ok(timer) = runtime.timer.lock() else {
        return;
    };
    let snapshot = timer.snapshot.clone();
    drop(timer);
    crate::tray_preview::update(app, &snapshot, false);
}

/// Main-document replacement invalidates queued reports from the old renderer.
/// Hiding/minimizing the window does not release its camera ownership.
pub fn reset(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<CameraActivity>() else {
        return;
    };
    if let Ok(mut value) = state.0.lock() {
        value.reset();
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&handle));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report(generation: u64, revision: u64, active: bool) -> Report {
        Report {
            generation,
            revision,
            active,
            label: "Blincho is using the camera".into(),
        }
    }
    #[test]
    fn ordered_reports_and_renderer_replacement_cannot_restore_an_obsolete_capture() {
        let mut activity = Activity::default();
        activity.accept(report(0, 1, true)).unwrap();
        activity.accept(report(0, 3, false)).unwrap();
        assert!(activity.accept(report(0, 2, true)).is_err());
        assert!(!activity.active);
        activity.reset();
        assert!(activity.accept(report(0, 4, true)).is_err());
        activity.accept(report(1, 1, true)).unwrap();
        assert!(activity.active);
        activity.reset();
        assert!(!activity.active);
    }
    #[test]
    fn malformed_camera_metadata_does_not_change_the_last_acknowledged_state() {
        let mut activity = Activity::default();
        activity.accept(report(0, 1, true)).unwrap();
        for label in [String::new(), "x".repeat(257), "camera\0hidden".into()] {
            let mut input = report(0, 2, false);
            input.label = label;
            assert!(activity.accept(input).is_err());
            assert!(activity.active);
            assert_eq!(activity.revision, 1);
        }
        assert!(serde_json::from_str::<Report>(
            r#"{"generation":0,"revision":2,"active":true,"label":"camera","frames":[]}"#
        )
        .is_err());
    }
}
