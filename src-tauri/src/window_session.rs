use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Debug)]
struct Display {
    name: Option<String>,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    scale: f64,
}
impl From<&tauri::Monitor> for Display {
    fn from(monitor: &tauri::Monitor) -> Self {
        Self {
            name: monitor.name().cloned(),
            position: *monitor.position(),
            size: *monitor.size(),
            work_position: monitor.work_area().position,
            work_size: monitor.work_area().size,
            scale: monitor.scale_factor(),
        }
    }
}

#[derive(Clone, Debug)]
struct Placement {
    position: PhysicalPosition<i32>,
    inner_size: PhysicalSize<u32>,
    outer_size: PhysicalSize<u32>,
    scale: f64,
    display: Option<Display>,
    maximized: bool,
    fullscreen: bool,
}

impl Placement {
    fn follow_display(&mut self, display: Display) {
        if let Some(previous) = &self.display {
            let ratio = display.scale / self.scale;
            self.position = PhysicalPosition::new(
                display.position.x.saturating_add(
                    ((self.position.x as f64 - previous.position.x as f64) * ratio).round() as i32,
                ),
                display.position.y.saturating_add(
                    ((self.position.y as f64 - previous.position.y as f64) * ratio).round() as i32,
                ),
            );
            self.inner_size = PhysicalSize::new(
                (self.inner_size.width as f64 * ratio).round() as u32,
                (self.inner_size.height as f64 * ratio).round() as u32,
            );
            self.outer_size = PhysicalSize::new(
                (self.outer_size.width as f64 * ratio).round() as u32,
                (self.outer_size.height as f64 * ratio).round() as u32,
            );
        }
        self.scale = display.scale;
        self.display = Some(display);
    }

    fn matching_display<'a>(&self, displays: &'a [Display]) -> Option<&'a Display> {
        let previous = self.display.as_ref()?;
        // Names are useful across a desktop rearrangement, but are not unique
        // on every platform. Disambiguate identical models by their geometry.
        let named: Vec<_> = displays
            .iter()
            .filter(|display| previous.name.is_some() && display.name == previous.name)
            .collect();
        if named.len() == 1 {
            return named.first().copied();
        }
        displays.iter().find(|display| {
            display.name == previous.name
                && display.position == previous.position
                && display.size == previous.size
        })
    }

    fn target_display<'a>(&self, displays: &'a [Display]) -> Option<&'a Display> {
        self.matching_display(displays).or_else(|| {
            displays.iter().max_by_key(|display| {
                overlap(
                    self.position,
                    self.outer_size,
                    display.position,
                    display.size,
                )
            })
        })
    }

    fn restored_bounds(&self, displays: &[Display]) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
        let matched = self.matching_display(displays);
        let Some(target) = self.target_display(displays) else {
            return (self.position, self.inner_size);
        };
        let ratio = target.scale / self.scale;
        let size = PhysicalSize::new(
            (self.inner_size.width as f64 * ratio).round() as u32,
            (self.inner_size.height as f64 * ratio).round() as u32,
        );
        let outer = PhysicalSize::new(
            (self.outer_size.width as f64 * ratio).round() as u32,
            (self.outer_size.height as f64 * ratio).round() as u32,
        );
        let position = if let (Some(_), Some(previous)) = (matched, &self.display) {
            PhysicalPosition::new(
                target.position.x.saturating_add(
                    ((self.position.x as f64 - previous.position.x as f64) * ratio).round() as i32,
                ),
                target.position.y.saturating_add(
                    ((self.position.y as f64 - previous.position.y as f64) * ratio).round() as i32,
                ),
            )
        } else {
            self.position
        };
        // Keep the title bar reachable even if the saved display was removed
        // or its resolution shrank. Do not resize below the app's minimum size.
        let right = target
            .work_position
            .x
            .saturating_add(target.work_size.width.saturating_sub(outer.width) as i32);
        let bottom = target
            .work_position
            .y
            .saturating_add(target.work_size.height.saturating_sub(outer.height) as i32);
        (
            PhysicalPosition::new(
                position.x.clamp(target.work_position.x, right),
                position.y.clamp(target.work_position.y, bottom),
            ),
            size,
        )
    }
}

fn overlap(
    a: PhysicalPosition<i32>,
    a_size: PhysicalSize<u32>,
    b: PhysicalPosition<i32>,
    b_size: PhysicalSize<u32>,
) -> i64 {
    let width = (i64::from(a.x) + i64::from(a_size.width))
        .min(i64::from(b.x) + i64::from(b_size.width))
        - i64::from(a.x.max(b.x));
    let height = (i64::from(a.y) + i64::from(a_size.height))
        .min(i64::from(b.y) + i64::from(b_size.height))
        - i64::from(a.y.max(b.y));
    width.max(0) * height.max(0)
}

#[derive(Clone)]
struct SavedWindow {
    placement: Placement,
    visible: bool,
    minimized: bool,
}

#[derive(Default)]
struct Session {
    current: Option<SavedWindow>,
    saved: Option<SavedWindow>,
    absent: bool,
    ready_at: Option<Instant>,
    break_placement: Option<Placement>,
    break_window: Option<SavedWindow>,
    break_focus: Option<crate::platform::FocusTarget>,
    deferred_focus: Option<crate::platform::FocusTarget>,
    focus_ready_at: Option<Instant>,
    deferred_placement: Option<Placement>,
}
impl Session {
    fn begin_absence(&mut self) {
        if self.saved.is_none() {
            self.saved = self
                .break_window
                .as_ref()
                .or(self.current.as_ref())
                .cloned();
        }
        self.absent = true;
        self.ready_at = None;
    }

    fn background_action(&mut self, hidden: bool, minimized: bool) {
        for saved in [&mut self.current, &mut self.saved, &mut self.break_window]
            .into_iter()
            .flatten()
        {
            if hidden {
                saved.visible = false;
            }
            if minimized {
                saved.minimized = true;
            }
        }
    }

    fn begin_break(&mut self, saved: SavedWindow, focus: Option<crate::platform::FocusTarget>) {
        if self.break_window.is_none() {
            self.break_placement = Some(saved.placement.clone());
            self.break_window = Some(saved.clone());
            self.break_focus = focus;
            self.current = Some(saved);
        }
    }

    fn finish_break(&mut self) {
        self.break_placement = None;
        if let Some(saved) = self.break_window.take() {
            // An overlapping absence already owns the original snapshot.
            if self.saved.is_none() {
                self.saved = Some(saved);
                self.ready_at = None;
            }
            self.deferred_focus = self.break_focus.take();
            self.focus_ready_at = None;
        }
    }

    fn keep_open(&mut self) {
        for saved in [&mut self.current, &mut self.saved, &mut self.break_window]
            .into_iter()
            .flatten()
        {
            saved.visible = true;
            saved.minimized = false;
        }
        self.break_focus = None;
        self.deferred_focus = None;
        self.focus_ready_at = None;
    }

    fn capture_cleanup_focus(
        &mut self,
        capture: impl FnOnce() -> Option<crate::platform::FocusTarget>,
    ) {
        if self.absent || (self.break_window.is_none() && self.deferred_focus.is_none()) {
            return;
        }
        if let Some(focus) = capture() {
            if self.break_window.is_some() {
                self.break_focus = Some(focus);
            } else {
                self.deferred_focus = Some(focus);
            }
        }
    }

    fn prepare_show(
        &mut self,
        restore: impl FnOnce(&Placement) -> Result<bool, String>,
    ) -> Result<(), String> {
        let placement = self
            .saved
            .take()
            .map(|saved| saved.placement)
            .or_else(|| self.deferred_placement.take());
        // Reopening supersedes background state even if native geometry is
        // temporarily unavailable. Only placement may be retried afterward.
        self.ready_at = None;
        self.deferred_focus = None;
        self.focus_ready_at = None;
        if let Some(current) = &mut self.current {
            current.visible = true;
            current.minimized = false;
        }
        self.deferred_placement = placement;
        if let Some(placement) = &self.deferred_placement {
            if restore(placement)? {
                self.deferred_placement = None;
            }
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct WindowSession(Mutex<Session>);

fn capture(
    window: &tauri::WebviewWindow,
    previous: Option<&SavedWindow>,
    break_placement: Option<&Placement>,
) -> Result<SavedWindow, String> {
    let minimized = window.is_minimized().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    let placement = if let Some(placement) = break_placement {
        placement.clone()
    } else if (minimized || maximized) && previous.is_some() {
        let mut placement = previous
            .ok_or("Missing normal window placement")?
            .placement
            .clone();
        if maximized {
            placement.maximized = true;
            if let Some(display) = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .as_ref()
                .map(Display::from)
            {
                placement.follow_display(display);
            }
        }
        placement
    } else {
        Placement {
            position: window.outer_position().map_err(|e| e.to_string())?,
            inner_size: window.inner_size().map_err(|e| e.to_string())?,
            outer_size: window.outer_size().map_err(|e| e.to_string())?,
            scale: window.scale_factor().map_err(|e| e.to_string())?,
            display: window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .as_ref()
                .map(Display::from),
            maximized,
            fullscreen: window.is_fullscreen().map_err(|e| e.to_string())?,
        }
    };
    Ok(SavedWindow {
        placement,
        visible: window.is_visible().map_err(|e| e.to_string())?,
        minimized,
    })
}

fn restore_placement(
    window: &tauri::WebviewWindow,
    placement: &Placement,
    displays: &[Display],
    can_present: bool,
) -> Result<bool, String> {
    // Native fullscreen owns a Space on macOS. Moving its normal frame while
    // that Space is active would exit or move the user's fullscreen window.
    if placement.fullscreen {
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    if !can_present
        || !window.is_visible().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        // GTK queues geometry requests for unmapped windows without confirming
        // their frame. Keep the original placement until reopening maps it.
        return Ok(false);
    }
    // Tao's Windows geometry setters clear MAXIMIZED through SW_RESTORE,
    // which can show or unminimize a background window. Keep that placement
    // until the user explicitly opens it instead of invoking those setters.
    if defer_background_geometry(
        can_present,
        placement.maximized,
        window.is_maximized().map_err(|e| e.to_string())?,
    ) {
        return Ok(false);
    }
    if window.is_maximized().map_err(|e| e.to_string())? {
        let current = window.current_monitor().map_err(|e| e.to_string())?;
        if placement.maximized
            && current
                .as_ref()
                .zip(placement.target_display(displays))
                .is_some_and(|(current, target)| {
                    current.name().cloned() == target.name
                        && *current.position() == target.position
                        && current.scale_factor() == target.scale
                })
        {
            // The existing zoom and its normal frame already belong to this
            // monitor. Geometry setters would unnecessarily undo that state.
            return Ok(true);
        }
        window.unmaximize().map_err(|e| e.to_string())?;
        // AppKit queues zoom changes. Retry on the next UI tick instead of
        // issuing maximize before the preceding unmaximize has taken effect.
        return Ok(false);
    }
    let (position, size) = placement.restored_bounds(displays);
    #[cfg(target_os = "macos")]
    {
        // AppKit uses a logical desktop. Tao converts physical setter arguments
        // using the current window scale, which can still belong to a different
        // display after wake. Supply the target display's logical frame instead.
        let scale = placement
            .target_display(displays)
            .map_or(placement.scale, |display| display.scale);
        let (position, size) = logical_bounds(position, size, scale);
        window.set_position(position).map_err(|e| e.to_string())?;
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_position(position).map_err(|e| e.to_string())?;
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    if can_present && placement.maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

fn defer_background_geometry(
    can_present: bool,
    saved_maximized: bool,
    current_maximized: bool,
) -> bool {
    !can_present && (saved_maximized || current_maximized)
}

#[cfg(any(target_os = "macos", test))]
fn logical_bounds(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    target_scale: f64,
) -> (tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>) {
    (
        position.to_logical(target_scale),
        size.to_logical(target_scale),
    )
}

fn displays(window: &tauri::WebviewWindow) -> Result<Vec<Display>, String> {
    Ok(window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .map(Display::from)
        .collect())
}

pub fn remember(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = window.state::<WindowSession>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    let timer_absent = window
        .state::<crate::Runtime>()
        .timer
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot
        .clone();
    if !session.absent && session.saved.is_none() && !timer_absent.locked && !timer_absent.suspended
    {
        session.current = Some(capture(
            window,
            session.current.as_ref(),
            session
                .break_placement
                .as_ref()
                .or(session.deferred_placement.as_ref()),
        )?);
    }
    Ok(())
}

pub fn begin_absence(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<WindowSession>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .begin_absence();
    Ok(())
}

pub fn background_action(
    window: &tauri::WebviewWindow,
    hidden: bool,
    minimized: bool,
) -> Result<(), String> {
    window
        .state::<WindowSession>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .background_action(hidden, minimized);
    Ok(())
}

// Runs on the UI thread and reads current presence there. A queued wake must
// never restore a window after a subsequent lock has already arrived.
pub fn synchronize(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let snapshot = app
        .state::<crate::Runtime>()
        .timer
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot
        .clone();
    let state = app.state::<WindowSession>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if snapshot.locked || snapshot.suspended {
        if !session.absent {
            session.begin_absence();
        }
        return Ok(());
    }
    session.absent = false;
    let restoring_absence = session.saved.is_some();
    if let Some(saved) = &session.saved {
        if snapshot
            .reasons
            .iter()
            .any(|reason| reason == "unconfirmed")
            || session.break_placement.is_some()
        {
            return Ok(());
        }
        let saved = saved.clone();
        let elapsed = session.ready_at.get_or_insert_with(Instant::now).elapsed();
        let displays = displays(&window)?;
        if elapsed < Duration::from_millis(500)
            || (saved.placement.matching_display(&displays).is_none()
                && elapsed < Duration::from_secs(2))
        {
            return Ok(());
        }
        // Native fullscreen/zoom cleanup can activate this window on Windows.
        // Preserve a work app selected since the break began before changing it.
        if session.deferred_focus.is_some() {
            if let Some(focus) = crate::platform::capture_focus() {
                session.deferred_focus = Some(focus);
            }
        }
        let restored = restore_placement(
            &window,
            &saved.placement,
            &displays,
            saved.visible && !saved.minimized,
        )?;
        if !restored {
            session.deferred_placement = Some(saved.placement.clone());
        }
        // Return work focus before hiding/minimizing: native focus helpers
        // restore only while Blincho is still active, never over a newer app.
        if !saved.visible || saved.minimized {
            if let Some(focus) = session.deferred_focus.take() {
                if let Err(error) = crate::platform::restore_focus(&focus) {
                    eprintln!("Work focus: {error}");
                }
            }
            session.focus_ready_at = None;
        }
        // Geometry changes must not turn a tray window into a foreground app.
        // Visible windows already belong to the desktop; no show/focus is needed.
        if !saved.visible {
            window.hide().map_err(|e| e.to_string())?;
        }
        if saved.minimized && !window.is_minimized().map_err(|e| e.to_string())? {
            window.minimize().map_err(|e| e.to_string())?;
        }
        session.saved = None;
        session.ready_at = None;
    }
    if session.saved.is_none()
        && session.deferred_placement.is_none()
        && session.deferred_focus.is_some()
    {
        // Finish queued fullscreen/zoom operations before transferring focus.
        let elapsed = session
            .focus_ready_at
            .get_or_insert_with(Instant::now)
            .elapsed();
        if elapsed >= Duration::from_millis(250) {
            if let Some(focus) = session.deferred_focus.take() {
                if let Err(error) = crate::platform::restore_focus(&focus) {
                    eprintln!("Work focus: {error}");
                }
            }
            session.focus_ready_at = None;
        }
    }
    if let Some(placement) = session.deferred_placement.clone() {
        if !restoring_absence
            && window.is_visible().map_err(|e| e.to_string())?
            && !window.is_minimized().map_err(|e| e.to_string())?
        {
            if session.deferred_focus.is_some() {
                if let Some(focus) = crate::platform::capture_focus() {
                    session.deferred_focus = Some(focus);
                }
            }
            if restore_placement(&window, &placement, &displays(&window)?, true)? {
                session.deferred_placement = None;
            }
        }
    }
    session.current = Some(capture(
        &window,
        session.current.as_ref(),
        session
            .break_placement
            .as_ref()
            .or(session.deferred_placement.as_ref()),
    )?);
    Ok(())
}

pub fn prepare_show(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = window.state::<WindowSession>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    session.prepare_show(|placement| restore_placement(window, placement, &displays(window)?, true))
}

pub fn begin_break(window: &tauri::WebviewWindow) -> Result<(), String> {
    let state = window.state::<WindowSession>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if session.break_window.is_none() {
        let saved = match &session.saved {
            Some(saved) => saved.clone(),
            None => capture(
                window,
                session.current.as_ref(),
                session.deferred_placement.as_ref(),
            )?,
        };
        session.begin_break(saved, crate::platform::capture_focus());
    }
    Ok(())
}

pub fn keep_open(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .state::<WindowSession>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .keep_open();
    Ok(())
}

pub fn preserve_work_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let present = window
        .state::<crate::Runtime>()
        .timer
        .lock()
        .map_err(|e| e.to_string())?
        .snapshot
        .reasons
        .is_empty();
    if present {
        window
            .state::<WindowSession>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .capture_cleanup_focus(crate::platform::capture_focus);
    }
    Ok(())
}

pub fn set_fullscreen(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    if enabled {
        begin_break(window)?;
    } else {
        preserve_work_focus(window)?;
    }
    let state = window.state::<WindowSession>();
    let mut session = state.0.lock().map_err(|e| e.to_string())?;
    if !enabled && session.break_placement.is_none() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    window
        .set_simple_fullscreen(enabled)
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(enabled).map_err(|e| e.to_string())?;
    if !enabled {
        session.finish_break();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(name: &str, x: i32, scale: f64) -> Display {
        Display {
            name: Some(name.into()),
            position: PhysicalPosition::new(x, 0),
            size: PhysicalSize::new(1920, 1080),
            work_position: PhysicalPosition::new(x, 24),
            work_size: PhysicalSize::new(1920, 1032),
            scale,
        }
    }
    fn placement() -> Placement {
        Placement {
            position: PhysicalPosition::new(-1800, 100),
            inner_size: PhysicalSize::new(1040, 760),
            outer_size: PhysicalSize::new(1040, 790),
            scale: 1.,
            display: Some(display("external", -1920, 1.)),
            maximized: false,
            fullscreen: false,
        }
    }
    #[test]
    fn original_monitor_and_negative_coordinates_are_preserved() {
        let saved = placement();
        assert_eq!(
            saved.restored_bounds(&[display("main", 0, 1.), display("external", -1920, 1.)]),
            (saved.position, saved.inner_size)
        );
    }
    #[test]
    fn rearranged_monitor_and_changed_scale_preserve_logical_placement() {
        let mut moved = display("external", 1920, 2.);
        moved.size = PhysicalSize::new(3840, 2160);
        moved.work_size = PhysicalSize::new(3840, 2112);
        assert_eq!(
            placement().restored_bounds(&[display("main", 0, 1.), moved]),
            (
                PhysicalPosition::new(2160, 200),
                PhysicalSize::new(2080, 1520)
            )
        );
    }
    #[test]
    fn disconnected_monitor_falls_back_to_reachable_title_bar() {
        assert_eq!(
            placement().restored_bounds(&[display("main", 0, 1.)]).0,
            PhysicalPosition::new(0, 100)
        );
    }
    #[test]
    fn duplicate_display_names_are_disambiguated_by_geometry() {
        let saved = placement();
        let displays = [display("external", 0, 1.), display("external", -1920, 1.)];
        assert_eq!(saved.matching_display(&displays).unwrap().position.x, -1920);
    }
    #[test]
    fn nested_lock_and_sleep_keep_original_tray_state() {
        let original = SavedWindow {
            placement: placement(),
            visible: false,
            minimized: false,
        };
        let mut session = Session {
            current: Some(original),
            ..Default::default()
        };
        session.begin_absence();
        session.current.as_mut().unwrap().visible = true;
        session.current.as_mut().unwrap().placement.position.x = 10;
        session.begin_absence();
        let saved = session.saved.unwrap();
        assert!(!saved.visible);
        assert_eq!(saved.placement.position.x, -1800);
    }
    #[test]
    fn minimized_state_is_retained_and_empty_monitor_list_is_safe() {
        let saved = SavedWindow {
            placement: placement(),
            visible: true,
            minimized: true,
        };
        let mut session = Session {
            current: Some(saved),
            ..Default::default()
        };
        session.begin_absence();
        let saved = session.saved.unwrap();
        assert!(saved.minimized);
        assert_eq!(
            saved.placement.restored_bounds(&[]),
            (saved.placement.position, saved.placement.inner_size)
        );
    }

    #[test]
    fn explicit_background_action_supersedes_pending_wake_visibility() {
        let saved = SavedWindow {
            placement: placement(),
            visible: true,
            minimized: false,
        };
        let mut session = Session {
            current: Some(saved),
            ..Default::default()
        };
        session.begin_absence();
        session.background_action(true, true);
        let saved = session.saved.unwrap();
        assert!(!saved.visible);
        assert!(saved.minimized);
    }

    #[test]
    fn break_restore_keeps_first_tray_snapshot_and_is_consumed_once() {
        let original = SavedWindow {
            placement: placement(),
            visible: false,
            minimized: false,
        };
        let mut session = Session::default();
        session.begin_break(original.clone(), None);
        let mut foreground = original;
        foreground.visible = true;
        foreground.placement.position.x = 10;
        session.begin_break(foreground, None);
        session.finish_break();
        assert!(session.break_window.is_none());
        assert!(session.break_placement.is_none());
        let saved = session.saved.as_ref().unwrap();
        assert!(!saved.visible);
        assert_eq!(saved.placement.position.x, -1800);
        session.saved = None;
        session.finish_break();
        assert!(session.saved.is_none());
    }

    #[test]
    fn absence_during_break_preserves_pre_break_visibility_and_minimization() {
        for (visible, minimized) in [(false, false), (true, true), (true, false)] {
            let mut session = Session::default();
            session.begin_break(
                SavedWindow {
                    placement: placement(),
                    visible,
                    minimized,
                },
                None,
            );
            session.current.as_mut().unwrap().visible = true;
            session.current.as_mut().unwrap().minimized = false;
            session.begin_absence();
            session.finish_break();
            let saved = session.saved.unwrap();
            assert_eq!(saved.visible, visible);
            assert_eq!(saved.minimized, minimized);
        }
    }

    #[test]
    fn explicit_hide_during_break_supersedes_original_visible_state() {
        let mut session = Session::default();
        session.begin_break(
            SavedWindow {
                placement: placement(),
                visible: true,
                minimized: false,
            },
            None,
        );
        session.background_action(true, false);
        session.finish_break();
        assert!(!session.saved.as_ref().unwrap().visible);
    }

    #[test]
    fn cleanup_never_captures_lock_screen_or_unrelated_window_focus() {
        let mut session = Session::default();
        session.capture_cleanup_focus(|| panic!("No break is being cleaned up"));
        session.begin_break(
            SavedWindow {
                placement: placement(),
                visible: false,
                minimized: false,
            },
            None,
        );
        let mut sampled = false;
        session.capture_cleanup_focus(|| {
            sampled = true;
            None
        });
        assert!(sampled);
        session.begin_absence();
        session.capture_cleanup_focus(|| panic!("Lock screen must not replace the work app"));
        session.finish_break();
        assert!(!session.saved.as_ref().unwrap().visible);
    }

    #[test]
    fn choosing_an_exercise_keeps_the_app_open_before_or_after_break_cleanup() {
        for cleanup_first in [false, true] {
            let mut session = Session::default();
            session.begin_break(
                SavedWindow {
                    placement: placement(),
                    visible: false,
                    minimized: false,
                },
                None,
            );
            if cleanup_first {
                session.finish_break();
            }
            session.keep_open();
            if !cleanup_first {
                session.finish_break();
            }
            assert!(session.saved.as_ref().unwrap().visible);
            assert!(!session.saved.as_ref().unwrap().minimized);
            assert!(session.deferred_focus.is_none());
        }
    }

    #[test]
    fn explicit_reopen_retains_only_geometry_after_temporary_placement_failure() {
        for (visible, minimized) in [(false, false), (true, true)] {
            let mut session = Session {
                current: Some(SavedWindow {
                    placement: placement(),
                    visible,
                    minimized,
                }),
                ..Default::default()
            };
            session.begin_absence();
            session.ready_at = Some(Instant::now());
            let error = session.prepare_show(|_| Err("Display temporarily unavailable".into()));
            assert_eq!(error.unwrap_err(), "Display temporarily unavailable");
            assert!(session.saved.is_none());
            assert!(session.ready_at.is_none());
            assert!(session.current.as_ref().unwrap().visible);
            assert!(!session.current.as_ref().unwrap().minimized);
            assert_eq!(
                session.deferred_placement.as_ref().unwrap().position,
                placement().position
            );

            // A staged native placement still needs a retry without restoring
            // the old hidden/minimized presentation state.
            session.prepare_show(|_| Ok(false)).unwrap();
            assert!(session.saved.is_none());
            assert!(session.deferred_placement.is_some());
            session
                .prepare_show(|retry| {
                    assert_eq!(retry.position, placement().position);
                    Ok(true)
                })
                .unwrap();
            assert!(session.deferred_placement.is_none());
            assert!(session.current.as_ref().unwrap().visible);
            assert!(!session.current.as_ref().unwrap().minimized);
        }
    }

    #[test]
    fn macos_restore_uses_target_scale_even_while_window_is_on_another_display() {
        let (position, size) = logical_bounds(
            PhysicalPosition::new(-3600, 200),
            PhysicalSize::new(2080, 1520),
            2.,
        );
        assert_eq!(position, tauri::LogicalPosition::new(-1800., 100.));
        assert_eq!(size, tauri::LogicalSize::new(1040., 760.));
    }

    #[test]
    fn windows_background_maximized_geometry_waits_for_explicit_show() {
        assert!(defer_background_geometry(false, true, true));
        assert!(defer_background_geometry(false, true, false));
        assert!(defer_background_geometry(false, false, true));
        assert!(!defer_background_geometry(false, false, false));
        assert!(!defer_background_geometry(true, true, true));
    }

    #[test]
    fn maximized_monitor_change_updates_metadata_and_keeps_normal_logical_frame() {
        let mut saved = placement();
        saved.maximized = true;
        saved.follow_display(display("second", 1920, 2.));
        assert_eq!(
            saved.display.as_ref().unwrap().name.as_deref(),
            Some("second")
        );
        assert_eq!(saved.scale, 2.);
        assert_eq!(saved.position, PhysicalPosition::new(2160, 200));
        assert_eq!(saved.inner_size, PhysicalSize::new(2080, 1520));
        assert!(saved.maximized);
    }
}
