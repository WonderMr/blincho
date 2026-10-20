use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerInput {
    pub total_ms: f64,
    pub remaining_ms: f64,
    pub manual_paused: bool,
    pub break_active: bool,
    pub exercising: bool,
    pub expiry_pending: bool,
    pub version: u64,
    pub break_seconds: f64,
    pub strict_mode: bool,
    pub idle_enabled: bool,
    pub idle_threshold_seconds: f64,
    #[serde(default)]
    pub meeting_enabled: bool,
    #[serde(default)]
    pub meeting_history_enabled: bool,
    // Older or incomplete renderer commands must not grant camera access.
    #[serde(default)]
    pub camera_lock_enabled: bool,
    #[serde(default)]
    pub enhanced_presence_enabled: bool,
    #[serde(default)]
    pub absence_lock_enabled: bool,
    #[serde(default = "default_takeover")]
    pub auto_takeover: bool,
}
fn default_takeover() -> bool {
    true
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySpan {
    pub start: i64,
    pub end: i64,
    pub state: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpan {
    pub start: i64,
    pub end: i64,
    pub app: String,
    #[serde(skip)]
    observation_epoch: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub total_ms: f64,
    pub remaining_ms: f64,
    pub manual_paused: bool,
    pub break_active: bool,
    pub exercising: bool,
    pub expiry_pending: bool,
    pub version: u64,
    pub reasons: Vec<String>,
    pub absent_since: Option<i64>,
    pub absence_epoch: u64,
    pub idle_seconds: f64,
    pub suspended: bool,
    pub locked: bool,
    pub break_elapsed: bool,
    pub break_end_at: Option<i64>,
    pub focus_by_date: BTreeMap<String, f64>,
    pub activity_spans: Vec<ActivitySpan>,
    pub meeting_spans: Vec<MeetingSpan>,
    pub meeting_applications: Vec<String>,
    pub live_meeting_enabled: bool,
    pub live_meeting_status: Option<crate::platform::MeetingStatus>,
    pub meeting_history_epoch: u64,
    pub tick_count: u64,
    pub meeting_postponed_epoch: u64,
    pub presence_epoch: u64,
}
pub struct Timer {
    pub input: Option<TimerInput>,
    pub snapshot: Snapshot,
    last_at: i64,
    break_end: Option<i64>,
    unconfirmed: bool,
    observed_lock: bool,
    last_meeting_at: Option<i64>,
    meeting_epoch: u64,
    meeting_clock_floor: i64,
    camera_presence: Option<(i64, Option<bool>)>,
    camera_check_deadline: Option<i64>,
    presence_lock_attempted: bool,
    last_call_at: Option<i64>,
}
impl Timer {
    #[cfg(any(target_os = "linux", test))]
    pub fn camera_lock_enabled(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.camera_lock_enabled || input.enhanced_presence_enabled)
    }
    pub fn new(now: i64) -> Self {
        Self {
            input: None,
            last_at: now,
            break_end: None,
            unconfirmed: false,
            observed_lock: false,
            last_meeting_at: None,
            meeting_epoch: 0,
            meeting_clock_floor: now,
            camera_presence: None,
            camera_check_deadline: None,
            presence_lock_attempted: false,
            last_call_at: None,
            snapshot: Snapshot {
                total_ms: 0.,
                remaining_ms: 0.,
                manual_paused: false,
                break_active: false,
                exercising: false,
                expiry_pending: false,
                version: 0,
                reasons: vec![],
                absent_since: None,
                absence_epoch: 0,
                idle_seconds: 0.,
                suspended: false,
                locked: false,
                break_elapsed: false,
                break_end_at: None,
                focus_by_date: BTreeMap::new(),
                activity_spans: vec![],
                meeting_spans: vec![],
                meeting_applications: vec![],
                live_meeting_enabled: false,
                live_meeting_status: None,
                meeting_history_epoch: 0,
                tick_count: 0,
                meeting_postponed_epoch: 0,
                presence_epoch: 0,
            },
        }
    }
    pub fn configure(&mut self, input: TimerInput, now: i64) -> Result<(), String> {
        if !input.total_ms.is_finite()
            || !(1000. ..=28_800_000.).contains(&input.total_ms)
            || !input.remaining_ms.is_finite()
            || !(0. ..=28_800_000.).contains(&input.remaining_ms)
            || !input.break_seconds.is_finite()
            || !(1. ..=1800.).contains(&input.break_seconds)
            || !input.idle_threshold_seconds.is_finite()
            || !(30. ..=3600.).contains(&input.idle_threshold_seconds)
        {
            return Err("Invalid timer configuration".into());
        }
        if self.input.is_some() && input.version < self.snapshot.version {
            return Err("Stale timer command".into());
        }
        self.observe_activity(self.last_at, now, self.activity_state());
        if self.input.as_ref().is_none_or(|old| {
            old.enhanced_presence_enabled != input.enhanced_presence_enabled
                || old.absence_lock_enabled != input.absence_lock_enabled
                || old.camera_lock_enabled != input.camera_lock_enabled
        }) {
            self.invalidate_camera_presence();
            self.snapshot.live_meeting_status = None;
            self.last_call_at = None;
            self.meeting_epoch = self.meeting_epoch.wrapping_add(1);
        }
        if self
            .input
            .as_ref()
            .is_some_and(|value| value.meeting_history_enabled)
            != input.meeting_history_enabled
        {
            // The setting transition is an explicit boundary. Re-enabling must
            // obtain a fresh observation and cannot reuse an in-flight probe.
            self.end_meeting_observation(now, !input.meeting_history_enabled);
            if input.meeting_history_enabled {
                // Persisted history belongs to the renderer. A new consent
                // cannot replay its previous native observation buffer,
                // including when wall time moved backward while disabled.
                self.snapshot.meeting_spans.clear();
            }
            self.snapshot.meeting_history_epoch =
                self.snapshot.meeting_history_epoch.wrapping_add(1);
        } else if self
            .input
            .as_ref()
            .is_some_and(|value| value.meeting_enabled)
            != input.meeting_enabled
        {
            // Postponement policy changes invalidate pending expiry probes,
            // while the separately enabled history observation remains live.
            self.meeting_epoch = self.meeting_epoch.wrapping_add(1);
            self.snapshot.live_meeting_status = None;
        }
        let changed = self.input.is_none() || input.version != self.snapshot.version;
        if changed {
            self.snapshot.remaining_ms = input.remaining_ms;
            self.snapshot.expiry_pending = input.expiry_pending;
            self.snapshot.version = input.version;
        }
        if input.break_active && !self.snapshot.break_active {
            self.break_end = Some(now + (input.break_seconds * 1000.) as i64);
            self.snapshot.break_end_at = self.break_end;
            self.snapshot.break_elapsed = false;
        } else if !input.break_active {
            self.break_end = None;
            self.snapshot.break_end_at = None;
            self.snapshot.break_elapsed = false;
        }
        self.snapshot.total_ms = input.total_ms;
        self.snapshot.manual_paused = input.manual_paused;
        self.snapshot.break_active = input.break_active && self.snapshot.reasons.is_empty();
        self.snapshot.exercising = input.exercising && self.snapshot.reasons.is_empty();
        self.snapshot.live_meeting_enabled = input.meeting_enabled
            || input.meeting_history_enabled
            || input.enhanced_presence_enabled
            || input.camera_lock_enabled;
        self.input = Some(input);
        self.last_at = now;
        Ok(())
    }
    pub fn postpone_meeting(&mut self, expected_version: u64, now: i64) -> bool {
        if self.snapshot.version != expected_version
            || !self.snapshot.expiry_pending
            || !self.snapshot.reasons.is_empty()
            || self.snapshot.break_active
            || self.snapshot.exercising
            || self.snapshot.manual_paused
            || self
                .input
                .as_ref()
                .is_none_or(|input| !input.meeting_enabled)
        {
            return false;
        }
        self.snapshot.remaining_ms = 300_000.;
        self.snapshot.expiry_pending = false;
        self.snapshot.version += 1;
        self.snapshot.meeting_postponed_epoch += 1;
        if let Some(input) = &mut self.input {
            input.remaining_ms = self.snapshot.remaining_ms;
            input.expiry_pending = false;
            input.version = self.snapshot.version;
        }
        self.last_at = now;
        true
    }
    pub fn expiry_still_current(
        &self,
        expected_version: u64,
        expected_absence_epoch: u64,
        expected_policy: (bool, bool, bool),
    ) -> bool {
        self.snapshot.version == expected_version
            && self.snapshot.absence_epoch == expected_absence_epoch
            && self.snapshot.expiry_pending
            && !self.snapshot.manual_paused
            && self.snapshot.reasons.is_empty()
            && self.input.as_ref().is_some_and(|input| {
                (
                    input.meeting_enabled,
                    input.auto_takeover,
                    input.strict_mode,
                ) == expected_policy
            })
    }
    fn cancel_for_absence(&mut self, now: i64, new_absence: bool) {
        if new_absence {
            self.snapshot.absent_since = Some(now);
            self.snapshot.absence_epoch += 1;
        }
        self.snapshot.expiry_pending = false;
        self.snapshot.break_active = false;
        self.snapshot.exercising = false;
        self.break_end = None;
        self.snapshot.break_end_at = None;
        self.snapshot.break_elapsed = false;
    }
    pub fn power(&mut self, code: i32, now: i64) {
        self.invalidate_camera_presence();
        self.observe_activity(self.last_at, now, self.activity_state());
        if (1..=4).contains(&code) {
            self.end_meeting_observation(now, code == 1 || code == 3);
        }
        if code == 1 || code == 3 {
            self.cancel_for_absence(now, self.snapshot.reasons.is_empty());
            let reason = if code == 1 { "suspended" } else { "locked" };
            if !self.snapshot.reasons.iter().any(|value| value == reason) {
                self.snapshot.reasons.push(reason.into());
            }
        }
        match code {
            1 => self.snapshot.suspended = true,
            2 => {
                self.snapshot.suspended = false;
                self.unconfirmed = true;
            }
            3 => {
                self.observed_lock = true;
                self.snapshot.locked = true;
            }
            4 => {
                self.observed_lock = false;
                self.snapshot.locked = false;
                self.unconfirmed = true;
            }
            _ => {}
        }
        self.last_at = now;
    }
    pub fn tick(&mut self, now: i64, idle: Option<f64>, locked: Option<bool>) -> bool {
        let start = self.last_at;
        let meeting_was_allowed = self.meeting_probe_allowed();
        let previous_state = self.activity_state();
        let elapsed = (now - self.last_at).max(0) as f64;
        let was_present = self.snapshot.reasons.is_empty();
        if now < start
            || elapsed > 5000.
            || idle.is_none()
            || locked.is_none()
            || idle.is_some_and(|value| value + 0.5 < self.snapshot.idle_seconds)
        {
            self.invalidate_camera_presence();
        }
        self.last_at = now;
        self.snapshot.tick_count += 1;
        if let Some(locked) = locked {
            self.snapshot.locked = locked || self.observed_lock;
        }
        if elapsed > 5000. || idle.is_none() || locked.is_none() {
            self.unconfirmed = true;
        }
        if let Some(idle) = idle {
            self.snapshot.idle_seconds = idle;
            if idle < 5. && locked.is_some() && elapsed <= 5000. {
                self.unconfirmed = false;
            }
        }
        let mut reasons = vec![];
        if self.snapshot.suspended {
            reasons.push("suspended".into());
        }
        if self.snapshot.locked {
            reasons.push("locked".into());
        }
        if self.unconfirmed {
            reasons.push("unconfirmed".into());
        }
        if let Some(input) = &self.input {
            let idle = if input.enhanced_presence_enabled {
                self.snapshot.idle_seconds >= 60. && !self.enhanced_presence_confirmed(now)
            } else {
                input.idle_enabled && self.snapshot.idle_seconds >= input.idle_threshold_seconds
            };
            if idle {
                reasons.push("idle".into());
            }
        }
        self.snapshot.reasons = reasons;
        if now < start
            || elapsed > 5000.
            || (!self.meeting_probe_allowed()
                && (meeting_was_allowed
                    || self.last_meeting_at.is_some()
                    || self.snapshot.live_meeting_status.is_some()))
        {
            // A missing presence sample or clock jump does not establish any
            // call time after the last confirmed observation.
            self.end_meeting_observation(now, false);
        }
        let current_state = self.activity_state();
        let state = if !self.snapshot.reasons.is_empty() {
            current_state
        } else {
            previous_state
        };
        self.observe_activity(start, now, state);
        if !self.snapshot.reasons.is_empty() {
            self.cancel_for_absence(now, was_present);
            return false;
        }
        if self.break_end.is_some_and(|end| now >= end) {
            self.snapshot.break_elapsed = true;
        }
        let counting = was_present
            && !self.snapshot.manual_paused
            && !self.snapshot.break_active
            && !self.snapshot.exercising
            && !self.snapshot.expiry_pending
            && elapsed <= 5000.;
        if self.input.is_some() && counting {
            let active = elapsed.min(self.snapshot.remaining_ms);
            self.snapshot.remaining_ms = (self.snapshot.remaining_ms - elapsed).max(0.);
            self.add_focus(now - elapsed as i64, active);
            if self.snapshot.remaining_ms == 0. {
                self.snapshot.expiry_pending = true;
                return true;
            }
        }
        false
    }

    fn invalidate_camera_presence(&mut self) {
        self.camera_presence = None;
        self.camera_check_deadline = None;
        self.presence_lock_attempted = false;
        self.snapshot.presence_epoch = self.snapshot.presence_epoch.wrapping_add(1);
    }

    fn enhanced_presence_confirmed(&self, now: i64) -> bool {
        (self.camera_presence.is_none() && self.snapshot.idle_seconds < 75.)
            || self.camera_presence.is_some_and(|(at, present)| {
                present == Some(true) && (0..=35_000).contains(&(now - at))
            })
            || self.camera_check_deadline.is_some_and(|until| now <= until)
            || (self
                .snapshot
                .live_meeting_status
                .as_ref()
                .is_some_and(|status| status.supported && status.in_meeting)
                && self
                    .last_call_at
                    .is_some_and(|at| (0..=6_000).contains(&(now - at))))
    }

    pub fn presence_check_allowed(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.enhanced_presence_enabled)
            && !self.snapshot.locked
            && !self.snapshot.suspended
            && !self.unconfirmed
            && self.snapshot.idle_seconds >= 60.
    }

    pub fn presence_check_may_start(&self) -> bool {
        self.presence_check_allowed()
            && !self
                .camera_presence
                .is_some_and(|(_, present)| present == Some(false))
    }

    pub fn begin_camera_check(&mut self, now: i64) {
        if self.camera_presence.is_none()
            || self
                .camera_presence
                .is_some_and(|(_, present)| present == Some(true))
        {
            self.camera_check_deadline = Some(now + 15_000);
        }
    }

    pub fn claim_presence_lock(&mut self) -> bool {
        if self.presence_lock_attempted
            || self
                .input
                .as_ref()
                .is_none_or(|input| !input.absence_lock_enabled)
        {
            return false;
        }
        self.presence_lock_attempted = true;
        true
    }

    pub fn observe_camera_presence(
        &mut self,
        epoch: u64,
        started_at: i64,
        present: Option<bool>,
        now: i64,
    ) -> bool {
        if epoch != self.snapshot.presence_epoch
            || !self.presence_check_allowed()
            || !(0..=15_000).contains(&(now - started_at))
            || now - (self.snapshot.idle_seconds * 1000.) as i64 + 1000 > started_at
            || self
                .snapshot
                .live_meeting_status
                .as_ref()
                .is_none_or(|status| !status.supported || status.in_meeting)
        {
            return false;
        }
        self.camera_check_deadline = None;
        self.camera_presence = Some((now, present));
        true
    }

    pub fn meeting_sample_allowed(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.meeting_history_enabled)
            && self.meeting_presence_confirmed()
    }

    pub fn meeting_probe_allowed(&self) -> bool {
        self.snapshot.live_meeting_enabled && self.meeting_presence_confirmed()
    }

    fn meeting_presence_confirmed(&self) -> bool {
        !self.snapshot.locked
            && !self.snapshot.suspended
            && !self.unconfirmed
            && !self.snapshot.reasons.iter().any(|reason| reason != "idle")
    }

    pub fn meeting_epoch(&self) -> u64 {
        self.meeting_epoch
    }

    pub fn clear_meeting_history(&mut self, now: i64) {
        self.end_meeting_observation(now, false);
        self.snapshot.meeting_spans.clear();
        self.snapshot.meeting_history_epoch = self.snapshot.meeting_history_epoch.wrapping_add(1);
        // A clear reply must sort after already captured native event frames.
        self.snapshot.tick_count += 1;
    }

    pub fn observe_meeting_if_current(
        &mut self,
        expected_epoch: u64,
        now: i64,
        status: &crate::platform::MeetingStatus,
    ) -> bool {
        if self.meeting_epoch != expected_epoch || !self.meeting_probe_allowed() {
            return false;
        }
        self.observe_meeting(now, status);
        true
    }

    pub fn observe_meeting(&mut self, now: i64, status: &crate::platform::MeetingStatus) {
        if now < self.meeting_clock_floor {
            if self.last_meeting_at.is_some()
                || !self.snapshot.meeting_applications.is_empty()
                || self.snapshot.live_meeting_status.is_some()
            {
                self.end_meeting_observation(now, false);
            }
            return;
        }
        self.meeting_clock_floor = now;
        if !self.meeting_probe_allowed() {
            self.end_meeting_observation(now, false);
            return;
        }
        let mut applications = if status.supported && status.in_meeting {
            crate::platform::normalize_meeting_applications(&status.applications)
        } else {
            vec![]
        };
        if status.supported && status.in_meeting && applications.is_empty() {
            applications.push("unknown".into());
        }
        self.snapshot.live_meeting_status = Some(crate::platform::MeetingStatus {
            in_meeting: status.supported && status.in_meeting,
            supported: status.supported,
            applications: applications.clone(),
        });
        self.last_call_at = status.supported.then_some(now);
        if status.in_meeting || !status.supported {
            self.invalidate_camera_presence();
        }
        // Tray state is transient. Recording still requires its own opt-in,
        // even when postponement keeps the background detector enabled.
        if !self.meeting_sample_allowed() {
            self.last_meeting_at = None;
            self.snapshot.meeting_applications.clear();
            return;
        }
        if !status.supported {
            // Keep the detector generation, so a failed probe may be cached
            // briefly rather than launching processes every heartbeat.
            self.last_meeting_at = None;
            self.snapshot.meeting_applications.clear();
            return;
        }
        // A successful negative probe establishes an end boundary. Failed
        // probes above stop at the last observation instead of filling a gap.
        self.extend_meeting_to(now);
        self.snapshot.meeting_applications = applications;
        self.last_meeting_at = Some(now);
    }

    fn end_meeting_observation(&mut self, now: i64, explicit_boundary: bool) {
        if explicit_boundary && self.meeting_sample_allowed() {
            self.extend_meeting_to(now);
        }
        self.last_meeting_at = None;
        self.meeting_clock_floor = self.meeting_clock_floor.max(now);
        self.snapshot.meeting_applications.clear();
        self.snapshot.live_meeting_status = None;
        self.meeting_epoch = self.meeting_epoch.wrapping_add(1);
    }

    fn extend_meeting_to(&mut self, now: i64) {
        let Some(start) = self.last_meeting_at else {
            return;
        };
        if now <= start || now - start > 5000 {
            return;
        }
        for app in &self.snapshot.meeting_applications {
            if let Some(previous) = self.snapshot.meeting_spans.iter_mut().rev().find(|span| {
                &span.app == app
                    && span.end == start
                    && span.observation_epoch == self.meeting_epoch
            }) {
                previous.end = now;
            } else {
                self.snapshot.meeting_spans.push(MeetingSpan {
                    start,
                    end: now,
                    app: app.clone(),
                    observation_epoch: self.meeting_epoch,
                });
            }
        }
        let cutoff = now.saturating_sub(7 * 86_400_000);
        self.snapshot.meeting_spans.retain(|span| span.end > cutoff);
        if self.snapshot.meeting_spans.len() > 4096 {
            self.snapshot
                .meeting_spans
                .drain(..self.snapshot.meeting_spans.len() - 4096);
        }
    }
    pub fn strict(&self) -> bool {
        self.snapshot.break_active
            && !self.snapshot.break_elapsed
            && self.snapshot.reasons.is_empty()
            && !self.snapshot.locked
            && !self.snapshot.suspended
            && !self.unconfirmed
            && self.input.as_ref().is_some_and(|input| input.strict_mode)
    }

    #[cfg(any(target_os = "macos", test))]
    pub fn strict_at(&self, now: i64) -> bool {
        self.strict() && self.break_end.is_some_and(|deadline| now < deadline)
    }

    fn activity_state(&self) -> String {
        for reason in ["suspended", "locked", "unconfirmed", "idle"] {
            if self.snapshot.reasons.iter().any(|value| value == reason) {
                return reason.into();
            }
        }
        if self.snapshot.break_active {
            "break"
        } else if self.snapshot.exercising {
            "exercise"
        } else if self.snapshot.manual_paused {
            "manual"
        } else {
            "work"
        }
        .into()
    }

    fn observe_activity(&mut self, start: i64, end: i64, mut state: String) {
        if self.input.is_none() || end <= start {
            return;
        }
        // Lock and sleep are explicit observations. Other long heartbeat gaps
        // cannot establish whether the computer was being used.
        if end - start > 5000 && state != "suspended" && state != "locked" {
            state = "unconfirmed".into();
        }
        let spans = &mut self.snapshot.activity_spans;
        if let Some(previous) = spans
            .last_mut()
            .filter(|span| span.state == state && span.end == start)
        {
            previous.end = end;
        } else {
            spans.push(ActivitySpan { start, end, state });
        }
        let cutoff = end.saturating_sub(7 * 86_400_000);
        spans.retain(|span| span.end > cutoff);
        if spans.len() > 4096 {
            spans.drain(..spans.len() - 4096);
        }
    }

    fn add_focus(&mut self, start: i64, duration_ms: f64) {
        let mut cursor = start;
        let mut remaining = duration_ms;
        while remaining > 0. {
            let Some(date) = Local.timestamp_millis_opt(cursor).single() else {
                break;
            };
            let end = cursor.saturating_add(remaining.ceil() as i64);
            if end <= cursor {
                break;
            }
            let Some(end_date) = Local.timestamp_millis_opt(end - 1).single() else {
                break;
            };
            let mut boundary = end;
            if date.date_naive() != end_date.date_naive() {
                // Some timezones skip local midnight. Find the observed date
                // transition within the short heartbeat instead of inventing one.
                let mut low = cursor + 1;
                let mut high = end;
                while low < high {
                    let middle = low + (high - low) / 2;
                    let same_day = Local
                        .timestamp_millis_opt(middle)
                        .single()
                        .is_some_and(|value| value.date_naive() == date.date_naive());
                    if same_day {
                        low = middle + 1;
                    } else {
                        high = middle;
                    }
                }
                boundary = low;
            }
            let active = remaining.min((boundary - cursor) as f64);
            *self
                .snapshot
                .focus_by_date
                .entry(date.format("%Y-%m-%d").to_string())
                .or_default() += active / 1000.;
            remaining -= active;
            cursor = boundary;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meeting_status(applications: &[&str]) -> crate::platform::MeetingStatus {
        crate::platform::MeetingStatus {
            in_meeting: !applications.is_empty(),
            supported: true,
            applications: applications.iter().map(|app| (*app).into()).collect(),
        }
    }
    fn meeting_timer() -> Timer {
        let mut timer = Timer::new(0);
        let mut settings = input();
        settings.meeting_history_enabled = true;
        settings.camera_lock_enabled = false;
        settings.manual_paused = true;
        timer.configure(settings, 0).unwrap();
        timer
    }
    fn live_meeting_timer() -> Timer {
        let mut timer = Timer::new(0);
        let mut settings = input();
        settings.meeting_enabled = true;
        settings.camera_lock_enabled = false;
        settings.manual_paused = true;
        timer.configure(settings, 0).unwrap();
        timer
    }
    fn meeting_sample(timer: &mut Timer, now: i64, applications: &[&str]) {
        timer.tick(now, Some(0.), Some(false));
        timer.observe_meeting(now, &meeting_status(applications));
    }
    fn meeting_intervals(timer: &Timer) -> Vec<(i64, i64, &str)> {
        timer
            .snapshot
            .meeting_spans
            .iter()
            .map(|span| (span.start, span.end, span.app.as_str()))
            .collect()
    }
    #[test]
    fn legacy_configuration_does_not_enable_call_history() {
        let legacy = serde_json::json!({
            "totalMs": 2000., "remainingMs": 2000., "manualPaused": false,
            "breakActive": false, "exercising": false, "expiryPending": false,
            "version": 0, "breakSeconds": 2., "strictMode": false,
            "idleEnabled": true, "idleThresholdSeconds": 60.,
            "meetingEnabled": true, "autoTakeover": true
        });
        let legacy_input: TimerInput = serde_json::from_value(legacy.clone()).unwrap();
        assert!(!legacy_input.meeting_history_enabled);
        assert!(!legacy_input.camera_lock_enabled);
        let mut timer = Timer::new(0);
        timer.configure(legacy_input, 0).unwrap();
        assert!(!timer.meeting_sample_allowed());
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
        assert!(timer.snapshot.live_meeting_enabled);
        let live = timer.snapshot.live_meeting_status.as_ref().unwrap();
        assert!(live.in_meeting && live.supported);
        assert_eq!(live.applications, ["Zoom"]);
        let mut opted_in = legacy;
        opted_in["meetingHistoryEnabled"] = true.into();
        let opted_in: TimerInput = serde_json::from_value(opted_in).unwrap();
        assert!(opted_in.meeting_history_enabled);
        timer.configure(opted_in, 750).unwrap();
        meeting_sample(&mut timer, 1000, &["Zoom"]);
        meeting_sample(&mut timer, 1250, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(1000, 1250, "Zoom")]);
    }
    #[test]
    fn transient_calls_work_without_history_during_idle_pause_and_strict_mode() {
        let mut timer = live_meeting_timer();
        assert!(!timer.meeting_sample_allowed());
        assert!(timer.meeting_probe_allowed());
        meeting_sample(&mut timer, 250, &["CptHost", "Teams", "Zoom"]);
        timer.tick(500, Some(120.), Some(false));
        assert!(timer.observe_meeting_if_current(
            timer.meeting_epoch(),
            500,
            &meeting_status(&["CptHost", "Teams", "Zoom"])
        ));
        assert_eq!(timer.snapshot.reasons, ["idle"]);
        assert!(timer.snapshot.manual_paused);
        assert!(timer.input.as_ref().unwrap().strict_mode);
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
        let serialized = serde_json::to_value(&timer.snapshot).unwrap();
        assert_eq!(serialized["liveMeetingEnabled"], true);
        assert_eq!(serialized["liveMeetingStatus"]["inMeeting"], true);
        assert_eq!(serialized["liveMeetingStatus"]["supported"], true);
        assert_eq!(
            serialized["liveMeetingStatus"]["applications"],
            serde_json::json!(["Microsoft Teams", "Zoom"])
        );
    }
    #[test]
    fn detector_off_on_rejects_in_flight_live_probe_without_touching_history_consent() {
        let mut timer = live_meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        let stale_epoch = timer.meeting_epoch();
        let history_epoch = timer.snapshot.meeting_history_epoch;
        let mut settings = timer.input.clone().unwrap();
        settings.meeting_enabled = false;
        timer.configure(settings.clone(), 500).unwrap();
        assert!(!timer.snapshot.live_meeting_enabled);
        assert!(timer.snapshot.live_meeting_status.is_none());
        assert!(!timer.meeting_probe_allowed());
        assert!(!timer.observe_meeting_if_current(stale_epoch, 600, &meeting_status(&["Zoom"])));
        settings.meeting_enabled = true;
        timer.configure(settings, 750).unwrap();
        assert!(timer.snapshot.live_meeting_enabled);
        assert!(timer.snapshot.live_meeting_status.is_none());
        assert!(!timer.observe_meeting_if_current(stale_epoch, 1000, &meeting_status(&["Zoom"])));
        assert!(timer.snapshot.live_meeting_status.is_none());
        assert_eq!(timer.snapshot.meeting_history_epoch, history_epoch);
        assert!(timer.observe_meeting_if_current(
            timer.meeting_epoch(),
            1250,
            &meeting_status(&["Discord"])
        ));
        assert_eq!(
            timer
                .snapshot
                .live_meeting_status
                .as_ref()
                .unwrap()
                .applications,
            ["Discord"]
        );
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
    }
    #[test]
    fn live_call_probe_cannot_survive_lock_sleep_or_unconfirmed_presence() {
        for (absent, present) in [(1, 2), (3, 4)] {
            let mut timer = live_meeting_timer();
            meeting_sample(&mut timer, 250, &["Zoom"]);
            let stale_epoch = timer.meeting_epoch();
            timer.power(absent, 500);
            assert!(timer.snapshot.live_meeting_status.is_none());
            assert!(!timer.meeting_probe_allowed());
            assert!(!timer.observe_meeting_if_current(
                stale_epoch,
                750,
                &meeting_status(&["Zoom"])
            ));
            timer.power(present, 1000);
            timer.tick(1250, Some(0.), Some(false));
            assert!(!timer.observe_meeting_if_current(
                stale_epoch,
                1250,
                &meeting_status(&["Zoom"])
            ));
            assert!(timer.snapshot.live_meeting_status.is_none());
            meeting_sample(&mut timer, 1500, &["Discord"]);
            assert!(
                timer
                    .snapshot
                    .live_meeting_status
                    .as_ref()
                    .unwrap()
                    .in_meeting
            );
            assert!(timer.snapshot.meeting_spans.is_empty());
        }
        let mut timer = live_meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        let stale_epoch = timer.meeting_epoch();
        timer.tick(500, None, Some(false));
        assert!(timer.snapshot.live_meeting_status.is_none());
        assert!(!timer.meeting_probe_allowed());
        timer.tick(750, Some(0.), Some(false));
        assert!(!timer.observe_meeting_if_current(stale_epoch, 750, &meeting_status(&["Zoom"])));
        assert!(timer.snapshot.live_meeting_status.is_none());
    }
    #[test]
    fn live_status_distinguishes_unknown_and_inactive_without_private_metadata() {
        let mut timer = live_meeting_timer();
        timer.observe_meeting(
            250,
            &crate::platform::MeetingStatus {
                in_meeting: true,
                supported: true,
                applications: vec!["Private call title".into()],
            },
        );
        let live = timer.snapshot.live_meeting_status.as_ref().unwrap();
        assert!(live.in_meeting);
        assert_eq!(live.applications, ["unknown"]);
        timer.observe_meeting(500, &crate::platform::MeetingStatus::inactive(false));
        let live = timer.snapshot.live_meeting_status.as_ref().unwrap();
        assert!(!live.in_meeting && !live.supported);
        assert!(live.applications.is_empty());
        timer.observe_meeting(750, &crate::platform::MeetingStatus::inactive(true));
        let live = timer.snapshot.live_meeting_status.as_ref().unwrap();
        assert!(!live.in_meeting && live.supported);
        assert!(live.applications.is_empty());
        assert!(timer.snapshot.meeting_spans.is_empty());
    }
    #[test]
    fn camera_grant_follows_current_configuration_without_restart() {
        let mut timer = Timer::new(0);
        assert!(!timer.camera_lock_enabled());
        let mut settings = input();
        timer.configure(settings.clone(), 0).unwrap();
        assert!(timer.camera_lock_enabled());
        settings.camera_lock_enabled = false;
        timer.configure(settings.clone(), 250).unwrap();
        assert!(!timer.camera_lock_enabled());
        settings.camera_lock_enabled = true;
        timer.configure(settings, 500).unwrap();
        assert!(timer.camera_lock_enabled());
    }
    #[test]
    fn rejected_configuration_cannot_reenable_camera() {
        let mut timer = Timer::new(0);
        let mut settings = input();
        settings.camera_lock_enabled = false;
        settings.version = 2;
        timer.configure(settings, 0).unwrap();
        assert!(timer.configure(input(), 250).is_err());
        assert!(!timer.camera_lock_enabled());
        let mut invalid = input();
        invalid.version = 2;
        invalid.total_ms = f64::NAN;
        assert!(timer.configure(invalid, 500).is_err());
        assert!(!timer.camera_lock_enabled());
    }
    #[test]
    fn reenable_discards_retained_calls_even_after_clock_rollback() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        assert!(!timer.snapshot.meeting_spans.is_empty());
        let mut settings = timer.input.clone().unwrap();
        settings.meeting_history_enabled = false;
        timer.configure(settings.clone(), 500).unwrap();
        assert!(
            !timer.snapshot.meeting_spans.is_empty(),
            "Opt-out retains the current buffer until the next opt-in"
        );
        let activity = serde_json::to_value(&timer.snapshot.activity_spans).unwrap();
        let focus = timer.snapshot.focus_by_date.clone();
        settings.meeting_history_enabled = true;
        timer.configure(settings, 100).unwrap();
        assert!(
            timer.snapshot.meeting_spans.is_empty(),
            "A new opt-in cannot replay the previous observation buffer"
        );
        assert_eq!(
            serde_json::to_value(&timer.snapshot.activity_spans).unwrap(),
            activity
        );
        assert_eq!(timer.snapshot.focus_by_date, focus);
        assert_eq!(timer.snapshot.meeting_history_epoch, 3);
        meeting_sample(&mut timer, 750, &["Discord"]);
        meeting_sample(&mut timer, 1000, &["Discord"]);
        assert_eq!(meeting_intervals(&timer), vec![(750, 1000, "Discord")]);
    }
    #[test]
    fn strict_meeting_postponement_keeps_strict_policy_and_rejects_disabled_detection() {
        for enabled in [false, true] {
            let mut timer = Timer::new(0);
            let mut settings = input();
            settings.meeting_enabled = enabled;
            timer.configure(settings, 0).unwrap();
            assert!(timer.tick(2000, Some(0.), Some(false)));
            let version = timer.snapshot.version;
            assert_eq!(timer.postpone_meeting(version, 2000), enabled);
            assert!(timer.input.as_ref().unwrap().strict_mode);
            assert!(!timer.snapshot.break_active);
            if enabled {
                assert_eq!(timer.snapshot.remaining_ms, 300_000.);
                assert!(!timer.snapshot.expiry_pending);
                assert_eq!(timer.snapshot.version, version + 1);
                assert_eq!(timer.snapshot.meeting_postponed_epoch, 1);
                assert!(!timer.postpone_meeting(version, 2000));
                for now in (3000..=302000).step_by(1000) {
                    timer.tick(now, Some(0.), Some(false));
                }
                assert!(timer.snapshot.expiry_pending);
                assert!(timer.expiry_still_current(version + 1, 0, (true, true, true)));
            } else {
                assert_eq!(timer.snapshot.remaining_ms, 0.);
                assert!(timer.snapshot.expiry_pending);
                assert_eq!(timer.snapshot.version, version);
                assert_eq!(timer.snapshot.meeting_postponed_epoch, 0);
            }
        }
    }
    #[test]
    fn history_and_postponement_have_independent_opt_in_flags() {
        let mut timer = meeting_timer();
        assert!(!timer.input.as_ref().unwrap().meeting_enabled);
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(250, 500, "Zoom")]);

        let mut settings = input();
        settings.camera_lock_enabled = false;
        settings.meeting_enabled = true;
        settings.strict_mode = false;
        settings.remaining_ms = 0.;
        settings.expiry_pending = true;
        settings.version = 1;
        timer.configure(settings, 750).unwrap();
        assert!(!timer.meeting_sample_allowed());
        assert!(timer.postpone_meeting(1, 1000));
        meeting_sample(&mut timer, 1250, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(250, 750, "Zoom")]);
        assert!(timer.snapshot.meeting_applications.is_empty());
    }
    #[test]
    fn postponement_toggle_keeps_enabled_history_observation() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        let epoch = timer.meeting_epoch();
        let history_epoch = timer.snapshot.meeting_history_epoch;
        let mut settings = timer.input.clone().unwrap();
        settings.meeting_enabled = true;
        timer.configure(settings, 500).unwrap();
        assert!(timer.meeting_sample_allowed());
        assert_ne!(timer.meeting_epoch(), epoch);
        assert_eq!(timer.snapshot.meeting_history_epoch, history_epoch);
        meeting_sample(&mut timer, 750, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(250, 750, "Zoom")]);
    }
    #[test]
    fn opt_in_toggle_rejects_probes_from_before_its_boundary() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        let stale_epoch = timer.meeting_epoch();
        let history_epoch = timer.snapshot.meeting_history_epoch;
        let mut settings = timer.input.clone().unwrap();
        settings.meeting_history_enabled = false;
        timer.configure(settings.clone(), 500).unwrap();
        settings.meeting_history_enabled = true;
        timer.configure(settings, 750).unwrap();
        assert_eq!(timer.snapshot.meeting_history_epoch, history_epoch + 2);
        assert!(!timer.observe_meeting_if_current(stale_epoch, 1000, &meeting_status(&["Zoom"])));
        assert!(timer.snapshot.meeting_applications.is_empty());
        let fresh_epoch = timer.meeting_epoch();
        assert!(timer.observe_meeting_if_current(fresh_epoch, 1250, &meeting_status(&["Zoom"])));
        meeting_sample(&mut timer, 1500, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(1250, 1500, "Zoom")]);
    }
    #[test]
    fn clear_discards_retained_and_live_history_and_requires_a_fresh_probe() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        let stale_frame = timer.snapshot.clone();
        let stale_epoch = timer.meeting_epoch();
        timer.clear_meeting_history(750);
        assert!(timer.input.as_ref().unwrap().meeting_history_enabled);
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
        assert!(timer.snapshot.tick_count > stale_frame.tick_count);
        assert_eq!(
            timer.snapshot.meeting_history_epoch,
            stale_frame.meeting_history_epoch + 1
        );
        let json = serde_json::to_value(&timer.snapshot).unwrap();
        assert_eq!(
            json["meetingHistoryEpoch"],
            timer.snapshot.meeting_history_epoch
        );
        assert!(!timer.observe_meeting_if_current(stale_epoch, 1000, &meeting_status(&["Zoom"])));
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 1250, &["Zoom"]);
        assert!(timer.snapshot.meeting_spans.is_empty());
        meeting_sample(&mut timer, 1500, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(1250, 1500, "Zoom")]);
    }
    #[test]
    fn clear_while_opted_out_preserves_the_privacy_policy() {
        let mut timer = Timer::new(0);
        timer.configure(input(), 0).unwrap();
        timer.clear_meeting_history(250);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        assert!(!timer.meeting_sample_allowed());
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
    }
    #[test]
    fn hidden_heartbeat_records_calls_during_manual_pause_and_strict_policy() {
        let mut timer = meeting_timer();
        assert!(timer.input.as_ref().unwrap().strict_mode);
        meeting_sample(&mut timer, 250, &["Zoom"]);
        assert!(timer.snapshot.meeting_spans.is_empty());
        meeting_sample(&mut timer, 500, &["Zoom"]);
        meeting_sample(&mut timer, 1000, &["Zoom"]);
        assert_eq!(meeting_intervals(&timer), [(250, 1000, "Zoom")]);
        assert_eq!(timer.snapshot.meeting_applications, ["Zoom"]);
        assert_eq!(timer.snapshot.remaining_ms, 2000.);
        assert!(!timer.snapshot.expiry_pending);
        assert!(timer.snapshot.focus_by_date.is_empty());
        let json = serde_json::to_value(&timer.snapshot).unwrap();
        assert_eq!(json["meetingSpans"][0]["app"], "Zoom");
        assert_eq!(json["meetingApplications"][0], "Zoom");
    }
    #[test]
    fn expiry_probe_result_requires_original_version_absence_and_policy() {
        let mut timer = Timer::new(0);
        let mut settings = input();
        settings.meeting_enabled = true;
        settings.strict_mode = false;
        settings.remaining_ms = 0.;
        settings.expiry_pending = true;
        timer.configure(settings.clone(), 0).unwrap();
        let policy = (true, true, false);
        assert!(timer.expiry_still_current(0, 0, policy));
        assert!(!timer.expiry_still_current(1, 0, policy));
        assert!(!timer.expiry_still_current(0, 1, policy));
        settings.strict_mode = true;
        timer.configure(settings.clone(), 250).unwrap();
        assert!(!timer.expiry_still_current(0, 0, policy));
        settings.strict_mode = false;
        timer.configure(settings, 500).unwrap();
        timer.power(3, 750);
        timer.power(4, 1000);
        timer.tick(1250, Some(0.), Some(false));
        assert!(!timer.expiry_still_current(0, 0, policy));
    }
    #[test]
    fn calls_attribute_transitions_and_overlapping_apps_without_duplicates() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom", "CptHost", "Teams"]);
        assert_eq!(
            timer.snapshot.meeting_applications,
            ["Microsoft Teams", "Zoom"]
        );
        meeting_sample(&mut timer, 500, &["Zoom", "Google Chrome"]);
        meeting_sample(&mut timer, 750, &["Google Chrome"]);
        meeting_sample(&mut timer, 1000, &[]);
        meeting_sample(&mut timer, 1500, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&timer),
            [
                (250, 500, "Microsoft Teams"),
                (250, 750, "Zoom"),
                (500, 1000, "Google Chrome"),
            ]
        );
        meeting_sample(&mut timer, 1750, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&timer).last(),
            Some(&(1500, 1750, "Zoom"))
        );
    }
    #[test]
    fn idle_alone_keeps_calls_but_lock_suspend_and_unconfirmed_presence_stop_them() {
        let mut timer = meeting_timer();
        let history_epoch = timer.snapshot.meeting_history_epoch;
        meeting_sample(&mut timer, 250, &["Zoom"]);
        timer.tick(500, Some(120.), Some(false));
        timer.observe_meeting(500, &meeting_status(&["Zoom"]));
        assert_eq!(timer.snapshot.reasons, ["idle"]);
        assert_eq!(timer.snapshot.meeting_applications, ["Zoom"]);
        timer.power(3, 750);
        assert_eq!(meeting_intervals(&timer), [(250, 750, "Zoom")]);
        assert!(timer.snapshot.meeting_applications.is_empty());
        timer.power(4, 1000);
        timer.tick(1250, Some(120.), Some(false));
        timer.observe_meeting(1250, &meeting_status(&["Zoom"]));
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 1500, &["Zoom"]);
        meeting_sample(&mut timer, 1750, &["Zoom"]);
        timer.tick(2000, None, Some(false));
        timer.observe_meeting(2000, &meeting_status(&["Zoom"]));
        assert_eq!(
            meeting_intervals(&timer).last(),
            Some(&(1500, 1750, "Zoom"))
        );
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 2250, &["Zoom"]);
        timer.power(1, 2500);
        assert_eq!(
            meeting_intervals(&timer).last(),
            Some(&(2250, 2500, "Zoom"))
        );
        assert!(timer.snapshot.meeting_applications.is_empty());
        assert_eq!(timer.snapshot.meeting_history_epoch, history_epoch);
    }
    #[test]
    fn setting_and_failed_probe_boundaries_never_backfill_call_gaps() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        let mut settings = timer.input.clone().unwrap();
        settings.meeting_history_enabled = false;
        timer.configure(settings.clone(), 750).unwrap();
        assert_eq!(meeting_intervals(&timer), [(250, 750, "Zoom")]);
        meeting_sample(&mut timer, 1000, &["Zoom"]);
        assert!(timer.snapshot.meeting_applications.is_empty());
        settings.meeting_history_enabled = true;
        timer.configure(settings, 1250).unwrap();
        assert!(
            timer.snapshot.meeting_spans.is_empty(),
            "A new opt-in starts a new observation buffer"
        );
        meeting_sample(&mut timer, 1500, &["Zoom"]);
        meeting_sample(&mut timer, 1750, &["Zoom"]);
        timer.observe_meeting(2000, &crate::platform::MeetingStatus::inactive(false));
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 2250, &["Zoom"]);
        meeting_sample(&mut timer, 2500, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&timer),
            [(1500, 1750, "Zoom"), (2250, 2500, "Zoom")]
        );
    }
    #[test]
    fn unknown_attribution_is_preserved_without_accepting_private_metadata() {
        let mut timer = meeting_timer();
        let status = crate::platform::MeetingStatus {
            in_meeting: true,
            supported: true,
            applications: vec![
                "Alice's private meeting".into(),
                "https://meet.google.com/secret".into(),
            ],
        };
        timer.observe_meeting(250, &status);
        timer.observe_meeting(500, &status);
        assert_eq!(meeting_intervals(&timer), [(250, 500, "unknown")]);
        timer.observe_meeting(750, &meeting_status(&["Zoom"]));
        timer.observe_meeting(1000, &meeting_status(&["Zoom"]));
        assert_eq!(
            meeting_intervals(&timer),
            [(250, 750, "unknown"), (750, 1000, "Zoom")]
        );
    }
    #[test]
    fn clock_jumps_and_process_restart_do_not_invent_call_time() {
        let mut timer = meeting_timer();
        meeting_sample(&mut timer, 250, &["Zoom"]);
        meeting_sample(&mut timer, 500, &["Zoom"]);
        meeting_sample(&mut timer, 60000, &["Zoom"]);
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 60250, &["Zoom"]);
        meeting_sample(&mut timer, 60500, &["Zoom"]);
        meeting_sample(&mut timer, 60000, &["Zoom"]);
        assert!(timer.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut timer, 60500, &["Zoom"]);
        meeting_sample(&mut timer, 60750, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&timer),
            [
                (250, 500, "Zoom"),
                (60250, 60500, "Zoom"),
                (60500, 60750, "Zoom")
            ]
        );
        let mut restarted = Timer::new(60750);
        restarted
            .configure(timer.input.clone().unwrap(), 60750)
            .unwrap();
        meeting_sample(&mut restarted, 61000, &["Zoom"]);
        assert!(restarted.snapshot.meeting_spans.is_empty());
        meeting_sample(&mut restarted, 61250, &["Zoom"]);
        assert_eq!(meeting_intervals(&restarted), [(61000, 61250, "Zoom")]);
        // A renderer command can reset the timer's clock baseline during a
        // backwards jump. The separate meeting floor must still close it.
        restarted
            .configure(restarted.input.clone().unwrap(), 61000)
            .unwrap();
        meeting_sample(&mut restarted, 61200, &["Zoom"]);
        assert!(restarted.snapshot.meeting_applications.is_empty());
        meeting_sample(&mut restarted, 61250, &["Zoom"]);
        meeting_sample(&mut restarted, 61500, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&restarted),
            [(61000, 61250, "Zoom"), (61250, 61500, "Zoom")]
        );
    }
    #[test]
    fn cumulative_meeting_overlay_is_bounded_and_pruned_after_a_week() {
        let mut timer = meeting_timer();
        for index in 1..=4200 {
            let app = if index % 2 == 0 {
                "Zoom"
            } else {
                "Google Chrome"
            };
            meeting_sample(&mut timer, index * 250, &[app]);
        }
        assert_eq!(timer.snapshot.meeting_spans.len(), 4096);
        let after_week = 8 * 86_400_000;
        meeting_sample(&mut timer, after_week, &["Zoom"]);
        meeting_sample(&mut timer, after_week + 250, &["Zoom"]);
        meeting_sample(&mut timer, after_week + 500, &["Zoom"]);
        assert_eq!(
            meeting_intervals(&timer),
            [(after_week + 250, after_week + 500, "Zoom")]
        );
    }
    #[test]
    fn activity_survives_hidden_renderer_and_records_pause_and_absence() {
        let mut timer = Timer::new(0);
        timer.configure(input(), 0).unwrap();
        timer.tick(1000, Some(0.), Some(false));
        let mut paused = input();
        paused.manual_paused = true;
        paused.version = 1;
        timer.configure(paused, 1000).unwrap();
        timer.tick(2000, Some(0.), Some(false));
        timer.power(3, 2000);
        timer.tick(3000, Some(0.), Some(true));
        timer.power(1, 3000);
        timer.power(2, 63000);
        let states: Vec<_> = timer
            .snapshot
            .activity_spans
            .iter()
            .map(|span| span.state.as_str())
            .collect();
        assert_eq!(states, vec!["work", "manual", "locked", "suspended"]);
        assert_eq!(timer.snapshot.activity_spans.last().unwrap().end, 63000);
        assert_eq!(timer.snapshot.focus_by_date.values().sum::<f64>(), 1.);
    }
    #[test]
    fn unknown_gap_is_never_shown_as_work_and_adjacent_samples_merge() {
        let mut timer = Timer::new(0);
        timer.configure(input(), 0).unwrap();
        timer.tick(250, Some(0.), Some(false));
        timer.tick(500, Some(0.), Some(false));
        timer.tick(60000, Some(20.), Some(false));
        assert_eq!(timer.snapshot.activity_spans.len(), 2);
        assert_eq!(timer.snapshot.activity_spans[0].end, 500);
        assert_eq!(timer.snapshot.activity_spans[1].state, "unconfirmed");
        assert_eq!(timer.snapshot.focus_by_date.values().sum::<f64>(), 0.5);
    }
    #[test]
    fn native_focus_is_split_at_local_midnight() {
        let midnight = Local
            .with_ymd_and_hms(2026, 10, 14, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let mut timer = Timer::new(midnight - 1000);
        timer.configure(input(), midnight - 1000).unwrap();
        timer.tick(midnight + 1000, Some(0.), Some(false));
        assert_eq!(timer.snapshot.focus_by_date.get("2026-10-13"), Some(&1.));
        assert_eq!(timer.snapshot.focus_by_date.get("2026-10-14"), Some(&1.));
    }
    #[test]
    fn native_focus_preserves_fractional_credit_and_skipped_midnight() {
        // With TZ=Africa/Cairo, the following day begins at 01:00.
        let noon = Local
            .with_ymd_and_hms(2026, 4, 23, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let mut timer = Timer::new(noon);
        timer.add_focus(noon, 1000.5);
        assert_eq!(
            timer.snapshot.focus_by_date.get("2026-04-23"),
            Some(&1.0005)
        );
        let next_day = Local
            .with_ymd_and_hms(2026, 4, 24, 1, 0, 0)
            .single()
            .unwrap();
        let boundary = if Local
            .with_ymd_and_hms(2026, 4, 24, 0, 0, 0)
            .single()
            .is_none()
        {
            next_day.timestamp_millis()
        } else {
            Local
                .with_ymd_and_hms(2026, 4, 24, 0, 0, 0)
                .single()
                .unwrap()
                .timestamp_millis()
        };
        let mut crossing = Timer::new(boundary - 1000);
        crossing.add_focus(boundary - 1000, 1000.5);
        assert_eq!(crossing.snapshot.focus_by_date.get("2026-04-23"), Some(&1.));
        assert_eq!(
            crossing.snapshot.focus_by_date.get("2026-04-24"),
            Some(&0.0005)
        );
    }
    fn enhanced_timer() -> Timer {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.total_ms = 1_000_000.;
        config.remaining_ms = 1_000_000.;
        config.enhanced_presence_enabled = true;
        config.camera_lock_enabled = false;
        config.absence_lock_enabled = true;
        config.idle_enabled = false;
        timer.configure(config, 0).unwrap();
        timer.tick(1000, Some(61.), Some(false));
        timer.observe_meeting(1000, &meeting_status(&[]));
        timer
    }
    #[test]
    fn enhanced_reading_continues_during_a_check_and_a_bounded_positive_lease() {
        let mut timer = enhanced_timer();
        assert!(timer.camera_lock_enabled());
        assert!(timer.snapshot.reasons.is_empty());
        let epoch = timer.snapshot.presence_epoch;
        timer.begin_camera_check(1000);
        assert!(timer.observe_camera_presence(epoch, 1000, Some(true), 1500));
        for second in 2..=36 {
            timer.tick(second * 1000, Some(60. + second as f64), Some(false));
        }
        assert!(timer.snapshot.reasons.is_empty());
        timer.tick(37000, Some(97.), Some(false));
        assert_eq!(timer.snapshot.reasons, ["idle"]);
        assert!(timer.snapshot.focus_by_date.values().sum::<f64>() > 30.);
    }
    #[test]
    fn camera_absence_and_unknown_stop_work_without_backdating_reading() {
        for result in [Some(false), None] {
            let mut timer = enhanced_timer();
            let epoch = timer.snapshot.presence_epoch;
            timer.begin_camera_check(1000);
            assert!(timer.observe_camera_presence(epoch, 1000, result, 1500));
            timer.tick(2000, Some(62.), Some(false));
            assert_eq!(timer.snapshot.reasons, ["idle"]);
            assert!(timer
                .snapshot
                .activity_spans
                .iter()
                .all(|span| span.start >= 0));
        }
        let mut timer = enhanced_timer();
        timer.begin_camera_check(1000);
        for second in 2..=17 {
            timer.tick(second * 1000, Some(60. + second as f64), Some(false));
        }
        assert_eq!(
            timer.snapshot.reasons,
            ["idle"],
            "an unfinished check cannot preserve work indefinitely"
        );
    }
    #[test]
    fn confirmed_absence_stops_camera_retries_until_new_input() {
        let mut timer = enhanced_timer();
        let epoch = timer.snapshot.presence_epoch;
        assert!(timer.presence_check_may_start());
        timer.begin_camera_check(1000);
        assert!(timer.observe_camera_presence(epoch, 1000, None, 1500));
        assert!(
            timer.presence_check_may_start(),
            "unknown results may retry"
        );
        timer.begin_camera_check(2000);
        assert!(timer.observe_camera_presence(epoch, 2000, Some(false), 2500));
        assert!(!timer.presence_check_may_start());
        assert!(
            timer.presence_check_allowed(),
            "the result may still request a lock"
        );
        assert!(timer.claim_presence_lock());
        timer.tick(3000, Some(0.), Some(false));
        for second in 4..=64 {
            timer.tick(second * 1000, Some((second - 3) as f64), Some(false));
        }
        assert!(timer.presence_check_may_start(), "new input resets absence");
    }
    #[test]
    fn input_calls_power_and_policy_changes_reject_stale_camera_results() {
        for cause in 0..5 {
            let mut timer = enhanced_timer();
            let epoch = timer.snapshot.presence_epoch;
            timer.begin_camera_check(1000);
            match cause {
                0 => {
                    timer.tick(2000, Some(0.), Some(false));
                }
                1 => timer.observe_meeting(2000, &meeting_status(&["Zoom"])),
                2 => timer.power(1, 2000),
                3 => {
                    let mut config = timer.input.clone().unwrap();
                    config.enhanced_presence_enabled = false;
                    timer.configure(config, 2000).unwrap();
                }
                _ => timer.observe_meeting(2000, &crate::platform::MeetingStatus::inactive(false)),
            }
            assert!(
                !timer.observe_camera_presence(epoch, 1000, Some(false), 2500),
                "cause {cause}"
            );
        }
    }
    #[test]
    fn enhanced_camera_leases_can_refresh_during_breaks_and_exercises() {
        for exercise in [false, true] {
            let mut timer = enhanced_timer();
            let epoch = timer.snapshot.presence_epoch;
            timer.begin_camera_check(1000);
            assert!(timer.observe_camera_presence(epoch, 1000, Some(true), 1500));
            let mut config = timer.input.clone().unwrap();
            config.break_active = !exercise;
            config.exercising = exercise;
            config.break_seconds = 120.;
            config.version += 1;
            timer.configure(config, 2000).unwrap();
            for second in 3..=30 {
                timer.tick(second * 1000, Some(60. + second as f64), Some(false));
            }
            assert!(timer.presence_check_allowed());
            timer.observe_meeting(30000, &meeting_status(&[]));
            timer.begin_camera_check(30000);
            assert!(timer.observe_camera_presence(epoch, 30000, Some(true), 30500));
            for second in 31..=40 {
                timer.tick(second * 1000, Some(60. + second as f64), Some(false));
            }
            assert!(timer.snapshot.reasons.is_empty());
            assert_eq!(timer.snapshot.break_active, !exercise);
            assert_eq!(timer.snapshot.exercising, exercise);
        }
    }
    #[test]
    fn active_call_preserves_reading_and_lock_attempts_are_bounded_per_input_episode() {
        let mut timer = enhanced_timer();
        timer.observe_meeting(2000, &meeting_status(&["Zoom"]));
        timer.tick(3000, Some(100.), Some(false));
        assert!(timer.snapshot.reasons.is_empty());
        timer.observe_meeting(3500, &meeting_status(&[]));
        let epoch = timer.snapshot.presence_epoch;
        timer.begin_camera_check(3500);
        assert!(timer.observe_camera_presence(epoch, 3500, Some(false), 4000));
        assert!(timer.claim_presence_lock());
        assert!(!timer.claim_presence_lock());
        timer.tick(4500, Some(0.), Some(false));
        assert!(timer.claim_presence_lock());
        let mut config = timer.input.clone().unwrap();
        config.absence_lock_enabled = false;
        timer.configure(config, 5000).unwrap();
        assert!(!timer.claim_presence_lock());
    }
    #[test]
    fn post_break_camera_keeps_live_call_safety_without_recording_history() {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.camera_lock_enabled = false;
        timer.configure(config.clone(), 0).unwrap();
        assert!(!timer.snapshot.live_meeting_enabled);
        let old_epoch = timer.snapshot.presence_epoch;
        config.camera_lock_enabled = true;
        timer.configure(config.clone(), 100).unwrap();
        assert_ne!(timer.snapshot.presence_epoch, old_epoch);
        assert!(timer.meeting_probe_allowed());
        assert!(!timer.meeting_sample_allowed());
        timer.observe_meeting(200, &meeting_status(&["Zoom"]));
        assert!(
            timer
                .snapshot
                .live_meeting_status
                .as_ref()
                .unwrap()
                .in_meeting
        );
        assert!(timer.snapshot.meeting_spans.is_empty());
        assert!(timer.snapshot.meeting_applications.is_empty());
        config.camera_lock_enabled = false;
        timer.configure(config, 300).unwrap();
        assert!(!timer.snapshot.live_meeting_enabled);
        assert!(!timer.meeting_probe_allowed());
        assert!(timer.snapshot.live_meeting_status.is_none());
    }
    #[test]
    fn camera_lock_policy_change_invalidates_pending_presence_evidence() {
        let mut timer = enhanced_timer();
        let epoch = timer.snapshot.presence_epoch;
        let mut config = timer.input.clone().unwrap();
        config.camera_lock_enabled = true;
        timer.configure(config, 1200).unwrap();
        timer.observe_meeting(1300, &meeting_status(&[]));
        assert!(!timer.observe_camera_presence(epoch, 1000, Some(false), 1500));
    }
    fn input() -> TimerInput {
        TimerInput {
            total_ms: 2000.,
            remaining_ms: 2000.,
            manual_paused: false,
            break_active: false,
            exercising: false,
            expiry_pending: false,
            version: 0,
            break_seconds: 2.,
            strict_mode: true,
            idle_enabled: true,
            idle_threshold_seconds: 60.,
            meeting_enabled: false,
            meeting_history_enabled: false,
            camera_lock_enabled: true,
            enhanced_presence_enabled: false,
            absence_lock_enabled: false,
            auto_takeover: true,
        }
    }
    #[test]
    fn hidden_clock_expires_once() {
        let mut t = Timer::new(0);
        t.configure(input(), 0).unwrap();
        assert!(!t.tick(1000, Some(0.), Some(false)));
        assert!(t.tick(2000, Some(0.), Some(false)));
        assert!(!t.tick(3000, Some(0.), Some(false)));
        assert_eq!(t.snapshot.focus_by_date.values().sum::<f64>(), 2.);
    }
    #[test]
    fn sleep_does_not_credit_time_and_preserves_manual_pause() {
        let mut t = Timer::new(0);
        let mut i = input();
        i.manual_paused = true;
        t.configure(i, 0).unwrap();
        t.power(1, 500);
        t.tick(1000, Some(0.), Some(false));
        t.power(2, 120000);
        t.tick(120250, Some(0.), Some(false));
        assert_eq!(t.snapshot.remaining_ms, 2000.);
        assert!(t.snapshot.manual_paused);
    }
    #[test]
    fn strict_releases_on_absence_and_deadline() {
        let mut t = Timer::new(0);
        let mut i = input();
        i.break_active = true;
        t.configure(i.clone(), 0).unwrap();
        assert!(t.strict());
        t.tick(2000, Some(0.), Some(false));
        assert!(!t.strict());
        i.version = 1;
        t.configure(i, 3000).unwrap();
        t.power(3, 3100);
        t.tick(3200, Some(0.), Some(true));
        assert!(!t.strict());
        assert!(!t.snapshot.break_active);
    }
    #[test]
    fn queued_strict_focus_checks_actual_deadline_before_next_tick() {
        let mut timer = Timer::new(1000);
        let mut settings = input();
        settings.break_active = true;
        timer.configure(settings, 1000).unwrap();
        timer.tick(2750, Some(0.), Some(false));
        assert!(timer.strict());
        assert!(!timer.snapshot.break_elapsed);
        assert!(timer.strict_at(2999));
        assert!(!timer.strict_at(3000));
        assert!(!timer.strict_at(3001));
        // The queued decision must expire even before the next timer tick.
        assert!(!timer.snapshot.break_elapsed);
    }
    #[test]
    fn queued_strict_focus_rechecks_policy_and_cancellation() {
        let mut timer = Timer::new(0);
        assert!(!timer.strict_at(0));
        let mut settings = input();
        settings.break_active = true;
        timer.configure(settings.clone(), 0).unwrap();
        assert!(timer.strict_at(250));

        settings.version = 1;
        settings.strict_mode = false;
        timer.configure(settings.clone(), 300).unwrap();
        assert!(timer.snapshot.break_active);
        assert!(!timer.strict_at(500));

        settings.version = 2;
        settings.strict_mode = true;
        timer.configure(settings.clone(), 600).unwrap();
        assert!(timer.strict_at(750));
        settings.version = 3;
        settings.break_active = false;
        timer.configure(settings, 800).unwrap();
        assert!(!timer.strict_at(1000));
        assert_eq!(timer.snapshot.break_end_at, None);
    }
    #[test]
    fn queued_strict_focus_rechecks_absence_and_stays_cancelled_on_return() {
        for (leave, back) in [(1, 2), (3, 4)] {
            let mut timer = Timer::new(0);
            let mut settings = input();
            settings.break_active = true;
            timer.configure(settings, 0).unwrap();
            assert!(timer.strict_at(250));
            timer.power(leave, 300);
            assert!(!timer.strict_at(500));
            timer.power(back, 600);
            timer.tick(750, Some(0.), Some(false));
            assert!(!timer.strict_at(1000));
            assert_eq!(timer.snapshot.break_end_at, None);
        }
        for (idle, locked) in [(Some(61.), Some(false)), (None, None)] {
            let mut timer = Timer::new(0);
            let mut settings = input();
            settings.break_active = true;
            timer.configure(settings, 0).unwrap();
            assert!(timer.strict_at(250));
            timer.tick(300, idle, locked);
            assert!(!timer.strict_at(500));
            timer.tick(750, Some(0.), Some(false));
            assert!(!timer.strict_at(1000));
        }
    }
    #[test]
    fn unknown_and_long_gap_pause_clock() {
        let mut t = Timer::new(0);
        t.configure(input(), 0).unwrap();
        t.tick(1000, None, None);
        assert_eq!(t.snapshot.remaining_ms, 2000.);
        t.tick(100000, Some(20.), Some(false));
        assert!(t.snapshot.reasons.contains(&"unconfirmed".into()));
        assert_eq!(t.snapshot.remaining_ms, 2000.);
    }
    #[test]
    fn idle_and_stale_commands() {
        let mut t = Timer::new(0);
        let mut i = input();
        i.version = 2;
        t.configure(i, 0).unwrap();
        t.tick(1000, Some(61.), Some(false));
        assert_eq!(t.snapshot.remaining_ms, 2000.);
        assert!(t.configure(input(), 1000).is_err());
    }
    #[test]
    fn sleep_between_ticks_cancels_rest_and_retains_absence_epoch() {
        let mut t = Timer::new(0);
        let mut i = input();
        i.break_active = true;
        t.configure(i, 0).unwrap();
        t.power(1, 100);
        assert!(!t.strict());
        assert!(!t.snapshot.break_active);
        t.power(2, 300100);
        t.tick(300200, Some(0.), Some(false));
        assert!(!t.snapshot.break_active);
        assert!(!t.snapshot.break_elapsed);
        assert_eq!(t.snapshot.absent_since, Some(100));
        assert_eq!(t.snapshot.absence_epoch, 1);
        assert_eq!(t.snapshot.remaining_ms, 2000.);
    }
    #[test]
    fn lock_between_ticks_cancels_exercise_and_preserves_manual_pause() {
        let mut t = Timer::new(0);
        let mut i = input();
        i.exercising = true;
        i.manual_paused = true;
        t.configure(i, 0).unwrap();
        t.power(3, 100);
        t.power(4, 200);
        t.tick(300, Some(0.), Some(false));
        assert!(!t.snapshot.exercising);
        assert!(t.snapshot.manual_paused);
        assert_eq!(t.snapshot.absence_epoch, 1);
    }
}
