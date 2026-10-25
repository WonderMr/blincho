use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// Keep the established renderer policy for every absence, including lock and sleep.
const ABSENCE_RESET_MS: i64 = 180_000;
const MEETING_MEDIA_INACTIVE_MS: i64 = 300_000;
const MEETING_END_CONFIRM_MS: i64 = 5000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerInput {
    pub total_ms: f64,
    pub remaining_ms: f64,
    pub manual_paused: bool,
    pub break_active: bool,
    #[serde(default)]
    pub meeting_break_token: Option<u64>,
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
pub struct AbsenceReset {
    pub epoch: u64,
    pub remaining_ms: f64,
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
    pub absence_reset: Option<AbsenceReset>,
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
    pub meeting_resumed_epoch: u64,
    pub meeting_resume_token: Option<u64>,
    pub meeting_break_cancellable: bool,
    pub meeting_break_cancelled_epoch: u64,
    pub meeting_warning_epoch: u64,
    pub meeting_warning_end_at: Option<i64>,
    pub meeting_warning_ready: bool,
    pub meeting_warning_required: bool,
    pub meeting_reminders_paused: bool,
    pub meeting_pause_ended_epoch: u64,
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
    meeting_seen: bool,
    media_inactive_since: Option<i64>,
    last_media_at: Option<i64>,
    meeting_resumed: bool,
    meeting_breaks_blocked: bool,
    meeting_postponement_pending: bool,
    meeting_break_context: bool,
    meeting_warning_version: Option<u64>,
    meeting_action_epoch: u64,
    meeting_break_token: Option<u64>,
    meeting_end_since: Option<i64>,
}
impl Timer {
    #[cfg(any(target_os = "linux", test))]
    pub fn camera_lock_enabled(&self) -> bool {
        self.input
            .as_ref()
            .is_some_and(|input| input.camera_lock_enabled || input.enhanced_presence_enabled)
    }
    /// Create an unconfigured timer with empty history and no active meeting controls.
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
            meeting_seen: false,
            media_inactive_since: None,
            last_media_at: None,
            meeting_resumed: false,
            meeting_breaks_blocked: false,
            meeting_postponement_pending: false,
            meeting_break_context: false,
            meeting_warning_version: None,
            meeting_action_epoch: 0,
            meeting_break_token: None,
            meeting_end_since: None,
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
                absence_reset: None,
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
                meeting_resumed_epoch: 0,
                meeting_resume_token: None,
                meeting_break_cancellable: false,
                meeting_break_cancelled_epoch: 0,
                meeting_warning_epoch: 0,
                meeting_warning_end_at: None,
                meeting_warning_ready: false,
                meeting_warning_required: false,
                meeting_reminders_paused: false,
                meeting_pause_ended_epoch: 0,
                presence_epoch: 0,
            },
        }
    }
    /// Validate and apply renderer state, rejecting stale timer versions and stale tokens when
    /// starting a meeting-associated break.
    ///
    /// Returns an error for invalid input or stale commands. The now argument is a timestamp in
    /// milliseconds.
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
        if input.break_active
            && !self.snapshot.break_active
            && input.meeting_break_token.is_some()
            && (input.meeting_break_token != self.snapshot.meeting_resume_token
                || self.snapshot.meeting_reminders_paused
                || self.meeting_blocks_break()
                || !self.meeting_warning_allows_break()
                || !input.meeting_enabled)
        {
            return Err("Stale meeting break command".into());
        }
        let clears_unclaimed_meeting_token = !input.meeting_enabled
            && self.snapshot.meeting_resume_token.is_some()
            && !self.snapshot.break_active;
        self.observe_activity(self.last_at, now, self.activity_state());
        if self
            .input
            .as_ref()
            .is_some_and(|old| old.meeting_enabled != input.meeting_enabled)
        {
            self.reset_meeting_media();
        }
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
            self.clear_meeting_warning();
            self.meeting_break_context = false;
            self.snapshot.meeting_warning_required = false;
            self.meeting_postponement_pending = false;
            self.snapshot.remaining_ms = input.remaining_ms;
            self.snapshot.expiry_pending = input.expiry_pending;
            self.snapshot.version = input.version;
        }
        if input.break_active && !self.snapshot.break_active {
            self.meeting_break_token = input.meeting_break_token.filter(|token| {
                Some(*token) == self.snapshot.meeting_resume_token
                    && !self.snapshot.meeting_reminders_paused
                    && input.meeting_enabled
            });
            self.break_end = Some(now + (input.break_seconds * 1000.) as i64);
            self.snapshot.break_end_at = self.break_end;
            self.snapshot.break_elapsed = false;
        } else if !input.break_active {
            self.meeting_break_token = None;
            self.break_end = None;
            self.snapshot.break_end_at = None;
            self.snapshot.break_elapsed = false;
        }
        self.snapshot.total_ms = input.total_ms;
        self.snapshot.manual_paused = input.manual_paused;
        self.snapshot.break_active = input.break_active && self.snapshot.reasons.is_empty();
        self.snapshot.exercising = input.exercising && self.snapshot.reasons.is_empty();
        if !input.strict_mode || !input.meeting_enabled {
            self.clear_meeting_warning();
            self.snapshot.meeting_warning_required = false;
        } else if self.snapshot.meeting_resume_token.is_some()
            && !self.snapshot.meeting_reminders_paused
        {
            self.snapshot.meeting_warning_required = true;
        }
        if !input.meeting_enabled {
            if clears_unclaimed_meeting_token {
                self.snapshot.meeting_break_cancelled_epoch += 1;
            }
            self.snapshot.meeting_reminders_paused = false;
            self.snapshot.meeting_resume_token = None;
            self.meeting_break_token = None;
        }
        self.snapshot.meeting_break_cancellable = self.meeting_break_token.is_some()
            && self.meeting_break_token == self.snapshot.meeting_resume_token
            && self.snapshot.break_active;
        self.snapshot.live_meeting_enabled = input.meeting_enabled
            || input.meeting_history_enabled
            || input.enhanced_presence_enabled
            || input.camera_lock_enabled;
        self.input = Some(input);
        self.last_at = now;
        Ok(())
    }
    /// Postpone a still-current due break for five minutes and record that meeting postponement
    /// may later be reclaimed.
    ///
    /// Return false without mutation when the version or timer state no longer permits
    /// postponement. The now argument is in milliseconds.
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
        self.clear_meeting_warning();
        self.snapshot.remaining_ms = 300_000.;
        self.snapshot.expiry_pending = false;
        self.snapshot.version += 1;
        if !self.snapshot.meeting_reminders_paused {
            self.snapshot.meeting_postponed_epoch += 1;
        }
        self.meeting_postponement_pending = true;
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
    /// Clear pending break presentation and meeting warnings, recording a new absence boundary
    /// when requested.
    fn cancel_for_absence(&mut self, now: i64, new_absence: bool) {
        self.clear_meeting_warning();
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
        if !was_present
            && self.input.is_some()
            && self
                .snapshot
                .absent_since
                .is_some_and(|since| now.saturating_sub(since) >= ABSENCE_RESET_MS)
        {
            // The native clock must restart even while the renderer is suspended.
            // Retain the previous countdown so the renderer can offer its existing undo.
            self.snapshot.absence_reset = Some(AbsenceReset {
                epoch: self.snapshot.absence_epoch,
                remaining_ms: self.snapshot.remaining_ms,
            });
            self.snapshot.remaining_ms = self.snapshot.total_ms;
            self.snapshot.expiry_pending = false;
            self.snapshot.version += 1;
            self.meeting_postponement_pending = false;
            self.meeting_break_context = false;
            self.snapshot.meeting_warning_required = false;
            self.clear_meeting_warning();
            if let Some(input) = &mut self.input {
                input.remaining_ms = self.snapshot.remaining_ms;
                input.expiry_pending = false;
                input.version = self.snapshot.version;
                input.break_active = false;
                input.exercising = false;
            }
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

    /// Apply a current meeting sample to break policy and live status, extending normalized
    /// history only when its separate opt-in permits it.
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
        self.observe_meeting_media(now, status);
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
            capture_active: status.capture_active,
            capture_supported: status.capture_supported,
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

    /// Close the current observation boundary, clear transient meeting state, and invalidate
    /// in-flight probes.
    fn end_meeting_observation(&mut self, now: i64, explicit_boundary: bool) {
        if explicit_boundary && self.meeting_sample_allowed() {
            self.extend_meeting_to(now);
        }
        self.last_meeting_at = None;
        self.meeting_clock_floor = self.meeting_clock_floor.max(now);
        self.snapshot.meeting_applications.clear();
        self.snapshot.live_meeting_status = None;
        self.reset_meeting_media();
        self.meeting_epoch = self.meeting_epoch.wrapping_add(1);
    }

    /// Report whether meeting detection or an explicit reminder pause currently blocks breaks.
    pub fn meeting_blocks_break(&self) -> bool {
        self.snapshot.meeting_reminders_paused || self.meeting_breaks_blocked
    }

    /// Clear accumulated meeting and capture evidence, postponement tracking, and warning
    /// state.
    fn reset_meeting_media(&mut self) {
        self.meeting_seen = false;
        self.media_inactive_since = None;
        self.last_media_at = None;
        self.meeting_resumed = false;
        self.meeting_breaks_blocked = false;
        self.meeting_postponement_pending = false;
        self.meeting_break_context = false;
        self.snapshot.meeting_warning_required = false;
        self.clear_meeting_warning();
        self.meeting_end_since = None;
    }

    /// Revoke a media-based release before a queued automatic break can claim it.
    /// Preserve an already started break and its explicit meeting undo control.
    fn revoke_meeting_resumption(&mut self) {
        if self.meeting_resumed
            && !self.snapshot.break_active
            && self.snapshot.meeting_resume_token.is_some()
        {
            self.snapshot.meeting_resume_token = None;
            self.snapshot.meeting_break_cancellable = false;
            self.snapshot.meeting_break_cancelled_epoch += 1;
            self.snapshot.version += 1;
            self.snapshot.tick_count += 1;
            self.clear_meeting_warning();
            if let Some(input) = &mut self.input {
                input.version = self.snapshot.version;
            }
        }
        self.meeting_resumed = false;
    }

    /// Update meeting break policy from consecutive samples, releasing capture postponement
    /// after five inactive minutes and confirming meeting end after five seconds.
    ///
    /// Unknown capture never counts as inactive. Observation gaps over five seconds, clock
    /// rollback and policy boundaries reset accumulated evidence. All timestamps are
    /// milliseconds.
    fn observe_meeting_media(&mut self, now: i64, status: &crate::platform::MeetingStatus) {
        if self
            .input
            .as_ref()
            .is_none_or(|input| !input.meeting_enabled)
        {
            self.reset_meeting_media();
            return;
        }
        if self
            .last_media_at
            .is_some_and(|at| !(0..=5000).contains(&(now - at)))
        {
            self.media_inactive_since = None;
            self.revoke_meeting_resumption();
            self.meeting_end_since = None;
        }
        self.last_media_at = Some(now);
        // Meeting status is independent from device capture. In particular,
        // a muted WebRTC PeerConnection or Zoom session remains an active call.
        let has_meeting = self.meeting_seen
            || self.meeting_break_context
            || self.snapshot.meeting_resume_token.is_some()
            || self.snapshot.meeting_reminders_paused;
        if has_meeting && status.supported && !status.in_meeting {
            self.media_inactive_since = None;
            let since = *self.meeting_end_since.get_or_insert(now);
            if now - since >= MEETING_END_CONFIRM_MS {
                self.finish_meeting();
                return;
            }
        } else {
            self.meeting_end_since = None;
        }
        self.meeting_seen |= status.supported && status.in_meeting;
        self.meeting_break_context |= status.supported && status.in_meeting;
        self.snapshot.meeting_warning_required = (self.meeting_break_context
            || self.snapshot.meeting_resume_token.is_some())
            && self.input.as_ref().is_some_and(|input| input.strict_mode);
        if self.snapshot.meeting_reminders_paused {
            self.media_inactive_since = None;
            self.meeting_breaks_blocked = true;
            return;
        }
        if self.meeting_end_since.is_some() {
            self.meeting_breaks_blocked = self.meeting_seen && !self.meeting_resumed;
            return;
        }
        if !status.capture_supported {
            // Runtimes without a device-use probe retain their existing call
            // policy. An unknown sample from a capable probe is different.
            self.media_inactive_since = None;
            self.revoke_meeting_resumption();
            self.meeting_seen = status.supported && status.in_meeting;
            self.meeting_breaks_blocked = self.meeting_seen;
            return;
        }
        let both_off = status.supported && status.capture_active == Some(false);
        if !both_off {
            self.media_inactive_since = None;
            self.revoke_meeting_resumption();
        } else if self.meeting_seen {
            let since = *self.media_inactive_since.get_or_insert(now);
            if now - since >= MEETING_MEDIA_INACTIVE_MS && !self.meeting_resumed {
                self.meeting_resumed = true;
                self.snapshot.meeting_resumed_epoch += 1;
                if !self.snapshot.break_active {
                    self.rotate_meeting_action();
                }
                self.reclaim_meeting_postponement();
            }
        }
        if self.meeting_resumed && status.supported && !status.in_meeting {
            self.meeting_seen = false;
        }
        self.meeting_breaks_blocked = self.meeting_seen && !self.meeting_resumed;
    }

    /// End the confirmed meeting override, reclaim an eligible due break, and invalidate
    /// meeting actions while preserving manual timer pause.
    fn finish_meeting(&mut self) {
        let was_paused = self.snapshot.meeting_reminders_paused;
        let clears_unclaimed_meeting_token =
            self.snapshot.meeting_resume_token.is_some() && !self.snapshot.break_active;
        let version = self.snapshot.version;
        // Reclaim only an already due meeting postponement, never a normal
        // work countdown or the independent manual timer pause.
        self.reclaim_meeting_postponement();
        if self.snapshot.version == version {
            self.snapshot.version += 1;
        }
        if let Some(input) = &mut self.input {
            input.version = self.snapshot.version;
            input.remaining_ms = self.snapshot.remaining_ms;
            input.expiry_pending = self.snapshot.expiry_pending;
            input.meeting_break_token = None;
        }
        if clears_unclaimed_meeting_token {
            self.snapshot.meeting_break_cancelled_epoch += 1;
        }
        self.snapshot.meeting_reminders_paused = false;
        self.snapshot.meeting_resume_token = None;
        self.snapshot.meeting_break_cancellable = false;
        self.meeting_break_token = None;
        self.reset_meeting_media();
        if was_paused {
            self.snapshot.meeting_pause_ended_epoch += 1;
        }
        self.snapshot.tick_count += 1;
    }

    /// Restore a postponed due break only when work can resume, then consume the postponement
    /// marker.
    fn reclaim_meeting_postponement(&mut self) {
        if self.meeting_postponement_pending
            && !self.snapshot.manual_paused
            && !self.snapshot.break_active
            && !self.snapshot.exercising
            && self.snapshot.reasons.is_empty()
        {
            self.snapshot.remaining_ms = 0.;
            self.snapshot.expiry_pending = true;
            self.snapshot.version += 1;
            if let Some(input) = &mut self.input {
                input.remaining_ms = 0.;
                input.expiry_pending = true;
                input.version = self.snapshot.version;
            }
        }
        self.meeting_postponement_pending = false;
    }

    /// Clear the warning deadline, readiness flag, and associated timer version.
    fn clear_meeting_warning(&mut self) {
        self.snapshot.meeting_warning_end_at = None;
        self.snapshot.meeting_warning_ready = false;
        self.meeting_warning_version = None;
    }

    /// Allow takeover when no meeting warning is required or its grace period has completed.
    pub fn meeting_warning_allows_break(&self) -> bool {
        !self.snapshot.meeting_warning_required || self.snapshot.meeting_warning_ready
    }

    /// Start or advance one 30-second warning for an eligible due meeting break; return true
    /// while takeover must wait.
    ///
    /// The deadline is tied to the timer version and uses milliseconds; repeated checks never
    /// extend the same warning.
    pub fn hold_for_meeting_warning(&mut self, now: i64) -> bool {
        if !self.snapshot.meeting_warning_required
            || self.snapshot.meeting_reminders_paused
            || !self.snapshot.expiry_pending
            || self.snapshot.manual_paused
            || self.snapshot.break_active
            || self.snapshot.exercising
            || !self.snapshot.reasons.is_empty()
        {
            return false;
        }
        if self.meeting_warning_version == Some(self.snapshot.version) {
            if self
                .snapshot
                .meeting_warning_end_at
                .is_some_and(|end| now < end)
            {
                return true;
            }
            self.snapshot.meeting_warning_end_at = None;
            self.snapshot.meeting_warning_ready = true;
            return false;
        }
        self.meeting_warning_version = Some(self.snapshot.version);
        self.snapshot.meeting_warning_ready = false;
        self.snapshot.meeting_warning_end_at = Some(now + 30_000);
        self.snapshot.meeting_warning_epoch += 1;
        true
    }

    /// Validate the current warning and defer it by 5, 10, or 15 minutes, or pause reminders
    /// until meeting end when minutes is None.
    ///
    /// Returns an error for an expired or stale warning, ineligible timer state, or unsupported
    /// duration. The now argument is a timestamp in milliseconds.
    pub fn defer_meeting_warning(
        &mut self,
        version: u64,
        warning_epoch: u64,
        minutes: Option<u8>,
        now: i64,
    ) -> Result<(), String> {
        if self.snapshot.version != version
            || self.snapshot.meeting_warning_epoch != warning_epoch
            || self.meeting_warning_version != Some(version)
            || !self
                .snapshot
                .meeting_warning_end_at
                .is_some_and(|end| now < end)
            || !self.snapshot.expiry_pending
            || self.snapshot.manual_paused
            || self.snapshot.break_active
            || self.snapshot.exercising
            || !self.snapshot.reasons.is_empty()
            || self
                .input
                .as_ref()
                .is_none_or(|input| !input.strict_mode || !input.meeting_enabled)
        {
            return Err("Meeting warning is no longer current".into());
        }
        if minutes.is_some_and(|minutes| ![5, 10, 15].contains(&minutes)) {
            return Err("Invalid meeting postponement duration".into());
        }
        self.clear_meeting_warning();
        self.snapshot.meeting_reminders_paused = minutes.is_none();
        self.meeting_end_since = None;
        if minutes.is_none() {
            self.rotate_meeting_action();
            self.meeting_breaks_blocked = true;
        }
        self.meeting_postponement_pending = minutes.is_none();
        self.snapshot.remaining_ms = f64::from(minutes.unwrap_or(5)) * 60_000.;
        self.snapshot.expiry_pending = false;
        self.snapshot.version += 1;
        self.snapshot.tick_count += 1;
        if let Some(input) = &mut self.input {
            input.remaining_ms = self.snapshot.remaining_ms;
            input.expiry_pending = false;
            input.version = self.snapshot.version;
        }
        self.last_at = now;
        Ok(())
    }

    /// Issue a new meeting action token so previously rendered controls become stale.
    fn rotate_meeting_action(&mut self) {
        self.meeting_action_epoch += 1;
        self.snapshot.meeting_resume_token = Some(self.meeting_action_epoch);
    }

    /// Apply a current meeting action to pause or resume reminders, cancelling only its
    /// associated break; dismissing an unpaused control preserves the countdown.
    ///
    /// Returns an error for stale tokens, disabled detection, exercises or an unrelated active
    /// break. A pause leaves manual timer pause unchanged and lasts until supported meeting-end
    /// confirmation. The now argument is in milliseconds.
    pub fn set_meeting_reminders_paused(
        &mut self,
        token: u64,
        paused: bool,
        now: i64,
    ) -> Result<(), String> {
        if self.snapshot.meeting_resume_token != Some(token)
            || (self.snapshot.meeting_reminders_paused && paused)
            || self
                .input
                .as_ref()
                .is_none_or(|input| !input.meeting_enabled)
            || (self.snapshot.break_active && self.meeting_break_token != Some(token))
            || self.snapshot.exercising
        {
            return Err("Meeting reminder action is no longer current".into());
        }
        if !paused && !self.snapshot.meeting_reminders_paused {
            // Dismissing the resumption control is not a postponement.
            if !self.snapshot.break_active {
                self.snapshot.meeting_break_cancelled_epoch += 1;
            }
            self.snapshot.meeting_resume_token = None;
            self.meeting_break_token = None;
            self.snapshot.meeting_break_cancellable = false;
            self.snapshot.tick_count += 1;
            return Ok(());
        }
        self.clear_meeting_warning();
        let was_due = self.snapshot.expiry_pending || self.snapshot.break_active;
        self.meeting_end_since = None;
        if paused && self.snapshot.break_active {
            self.snapshot.break_active = false;
            self.snapshot.break_elapsed = false;
            self.snapshot.break_end_at = None;
            self.break_end = None;
            self.snapshot.meeting_break_cancelled_epoch += 1;
        }
        self.meeting_break_token = None;
        self.snapshot.meeting_break_cancellable = false;
        self.snapshot.meeting_reminders_paused = paused;
        self.meeting_breaks_blocked = paused;
        self.meeting_postponement_pending = paused && was_due;
        self.media_inactive_since = None;
        self.meeting_seen = false;
        self.meeting_resumed = !paused;
        self.snapshot.expiry_pending = false;
        if self.snapshot.remaining_ms <= 0. {
            self.snapshot.remaining_ms = 300_000.;
        }
        self.snapshot.version += 1;
        self.snapshot.tick_count += 1;
        if paused {
            self.rotate_meeting_action();
        } else {
            self.snapshot.meeting_resume_token = None;
        }
        if let Some(input) = &mut self.input {
            input.remaining_ms = self.snapshot.remaining_ms;
            input.expiry_pending = false;
            input.break_active = self.snapshot.break_active;
            input.meeting_break_token = None;
            input.version = self.snapshot.version;
        }
        self.last_at = now;
        Ok(())
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
    /// Build a supported Zoom observation with the requested tri-state capture result.
    fn media_status(active: Option<bool>) -> crate::platform::MeetingStatus {
        let mut status = meeting_status(&["Zoom"]);
        status.capture_active = active;
        status.capture_supported = true;
        status
    }
    /// Advance a present, unlocked timer and apply one meeting observation at the same
    /// timestamp.
    fn media_sample(timer: &mut Timer, now: i64, status: &crate::platform::MeetingStatus) {
        timer.tick(now, Some(0.), Some(false));
        timer.observe_meeting(now, status);
    }
    /// Feed observations at intervals of at most one second through the requested endpoint.
    fn media_until(
        timer: &mut Timer,
        from: i64,
        until: i64,
        status: &crate::platform::MeetingStatus,
    ) {
        let mut now = from;
        while now < until {
            now = (now + 1000).min(until);
            media_sample(timer, now, status);
        }
    }
    /// Verify that five inactive minutes release meeting blocking once without overriding
    /// manual pause or raw call status.
    #[test]
    fn five_minutes_of_confirmed_media_inactivity_releases_only_postponement() {
        let mut timer = live_meeting_timer();
        let off = media_status(Some(false));
        media_sample(&mut timer, 0, &off);
        media_until(&mut timer, 0, 299_999, &off);
        assert!(timer.meeting_blocks_break());
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 0);
        media_sample(&mut timer, 300_000, &off);
        assert!(!timer.meeting_blocks_break());
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
        assert!(timer.snapshot.manual_paused);
        assert_eq!(timer.snapshot.remaining_ms, 2000.);
        assert!(!timer.snapshot.expiry_pending);
        assert!(
            timer
                .snapshot
                .live_meeting_status
                .as_ref()
                .unwrap()
                .in_meeting
        );
        media_until(&mut timer, 300_000, 610_000, &off);
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
    }
    /// Reject queued automatic breaks when active or unknown capture revokes resumption.
    #[test]
    fn resumed_capture_revokes_queued_meeting_breaks() {
        for active in [Some(true), None] {
            let mut timer = strict_warning_timer();
            timer.rotate_meeting_action();
            media_until(&mut timer, 2000, 32000, &media_status(Some(false)));
            assert!(!timer.hold_for_meeting_warning(32000));
            let mut queued = timer.input.clone().unwrap();
            queued.version += 1;
            queued.break_active = true;
            queued.expiry_pending = false;
            queued.meeting_break_token = timer.snapshot.meeting_resume_token;
            media_sample(&mut timer, 32001, &media_status(active));
            assert!(timer.meeting_blocks_break());
            assert!(timer.snapshot.meeting_resume_token.is_none());
            assert!(!timer.snapshot.meeting_warning_ready);
            assert_eq!(timer.snapshot.meeting_break_cancelled_epoch, 1);
            assert!(timer.configure(queued, 32002).is_err());
            assert!(!timer.strict());
            let mut manual = timer.input.clone().unwrap();
            manual.version += 1;
            manual.break_active = true;
            manual.meeting_break_token = None;
            timer.configure(manual, 32003).unwrap();
            assert!(timer.strict(), "explicit manual breaks remain available");
        }
    }
    /// Signal cancellation only when meeting-end, dismissal or disable clears an unclaimed token.
    #[test]
    fn every_unclaimed_meeting_token_invalidation_cancels_queued_breaks() {
        for cause in 0..3 {
            for claimed in [false, true] {
                let mut timer = strict_warning_timer();
                timer.rotate_meeting_action();
                media_until(&mut timer, 2000, 32000, &media_status(Some(false)));
                assert!(!timer.hold_for_meeting_warning(32000));
                let token = timer.snapshot.meeting_resume_token.unwrap();
                let mut queued = timer.input.clone().unwrap();
                queued.version += 1;
                queued.break_active = true;
                queued.expiry_pending = false;
                queued.meeting_break_token = Some(token);
                if claimed {
                    timer.configure(queued.clone(), 32000).unwrap();
                }
                match cause {
                    0 => timer.finish_meeting(),
                    1 => timer
                        .set_meeting_reminders_paused(token, false, 32001)
                        .unwrap(),
                    _ => {
                        let mut disabled = timer.input.clone().unwrap();
                        disabled.meeting_enabled = false;
                        disabled.version += 1;
                        timer.configure(disabled, 32001).unwrap();
                    }
                }
                assert!(timer.snapshot.meeting_resume_token.is_none());
                assert_eq!(
                    timer.snapshot.meeting_break_cancelled_epoch,
                    u64::from(!claimed)
                );
                if !claimed {
                    assert!(timer.configure(queued, 32002).is_err());
                    assert!(!timer.snapshot.break_active);
                } else {
                    assert!(
                        timer.snapshot.break_active,
                        "an accepted break still completes natively"
                    );
                }
                let cancelled = timer.snapshot.meeting_break_cancelled_epoch;
                timer.finish_meeting();
                assert_eq!(
                    timer.snapshot.meeting_break_cancelled_epoch, cancelled,
                    "clearing no token cannot repeat cancellation"
                );
            }
        }
    }
    /// Verify that media resumption immediately restores an already due break while preserving
    /// meeting history.
    #[test]
    fn media_resume_reclaims_an_already_due_break_without_waiting_another_postponement() {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.meeting_enabled = true;
        config.meeting_history_enabled = true;
        timer.configure(config, 0).unwrap();
        media_sample(&mut timer, 1000, &media_status(Some(true)));
        media_sample(&mut timer, 2000, &media_status(Some(true)));
        assert!(timer.postpone_meeting(timer.snapshot.version, 2000));
        let off = media_status(Some(false));
        media_sample(&mut timer, 3000, &off);
        media_until(&mut timer, 3000, 302000, &off);
        assert!(timer.postpone_meeting(timer.snapshot.version, 302000));
        media_sample(&mut timer, 303000, &off);
        assert_eq!(timer.snapshot.remaining_ms, 0.);
        assert!(timer.snapshot.expiry_pending);
        assert!(!timer.meeting_blocks_break());
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
        assert_eq!(timer.snapshot.meeting_applications, ["Zoom"]);
        assert!(!timer.snapshot.meeting_spans.is_empty());
    }
    /// Verify that active, unknown, or failed samples restart the full inactivity interval.
    #[test]
    fn media_activation_unknown_and_failed_observations_require_a_new_full_interval() {
        for interruption in [
            media_status(Some(true)),
            media_status(None),
            crate::platform::MeetingStatus::inactive(false),
        ] {
            let mut timer = live_meeting_timer();
            let off = media_status(Some(false));
            media_sample(&mut timer, 0, &off);
            media_until(&mut timer, 0, 299000, &off);
            media_sample(&mut timer, 300000, &interruption);
            media_sample(&mut timer, 301000, &off);
            media_until(&mut timer, 301000, 600000, &off);
            assert_eq!(timer.snapshot.meeting_resumed_epoch, 0);
            media_sample(&mut timer, 601000, &off);
            assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
            media_sample(&mut timer, 602000, &media_status(Some(true)));
            assert!(timer.meeting_blocks_break());
            media_sample(&mut timer, 603000, &off);
            media_until(&mut timer, 603000, 903000, &off);
            assert_eq!(timer.snapshot.meeting_resumed_epoch, 2);
        }
    }
    /// Verify that five seconds of confirmed meeting absence end blocking without a capture
    /// inactivity resumption event.
    #[test]
    fn supported_meeting_end_is_confirmed_independently_of_capture_inactivity() {
        let mut timer = live_meeting_timer();
        media_sample(&mut timer, 0, &media_status(Some(true)));
        let mut off = crate::platform::MeetingStatus::inactive(true);
        off.capture_active = Some(false);
        off.capture_supported = true;
        media_sample(&mut timer, 1000, &off);
        media_until(&mut timer, 1000, 5999, &off);
        assert!(timer.meeting_blocks_break());
        media_sample(&mut timer, 6000, &off);
        assert!(!timer.meeting_blocks_break());
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 0);
        assert!(timer.snapshot.meeting_resume_token.is_none());
    }
    /// Verify that releasing meeting blocking does not make an ordinary work countdown expire
    /// early.
    #[test]
    fn media_resume_preserves_a_normal_work_cycle() {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.meeting_enabled = true;
        config.remaining_ms = 1_200_000.;
        config.total_ms = 1_200_000.;
        timer.configure(config, 0).unwrap();
        let off = media_status(Some(false));
        media_sample(&mut timer, 0, &off);
        media_until(&mut timer, 0, 300000, &off);
        assert_eq!(timer.snapshot.remaining_ms, 900_000.);
        assert!(!timer.snapshot.expiry_pending);
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
    }
    /// Verify that uncertain capture or lost call evidence cannot complete the inactivity
    /// release interval.
    #[test]
    fn unknown_capture_and_lost_call_heuristic_cannot_release_a_pending_call() {
        for supported in [true, false] {
            let mut timer = live_meeting_timer();
            let off = media_status(Some(false));
            media_sample(&mut timer, 0, &off);
            media_until(&mut timer, 0, 299000, &off);
            let unknown = crate::platform::MeetingStatus {
                capture_supported: true,
                ..crate::platform::MeetingStatus::inactive(supported)
            };
            media_sample(&mut timer, 300000, &unknown);
            assert!(timer.meeting_blocks_break());
            assert_eq!(timer.snapshot.meeting_resumed_epoch, 0);
            media_sample(&mut timer, 301000, &off);
            media_until(&mut timer, 301000, 600000, &off);
            assert!(timer.meeting_blocks_break());
            media_sample(&mut timer, 601000, &off);
            assert!(!timer.meeting_blocks_break());
            assert_eq!(timer.snapshot.meeting_resumed_epoch, 1);
        }
    }
    /// Verify that sleep, lock, policy changes, observation gaps, and clock rollback invalidate
    /// accumulated inactivity.
    #[test]
    fn media_inactivity_cannot_cross_power_policy_or_clock_boundaries() {
        for boundary in 0..5 {
            let mut timer = live_meeting_timer();
            let off = media_status(Some(false));
            media_sample(&mut timer, 0, &off);
            media_until(&mut timer, 0, 299000, &off);
            let restart = match boundary {
                0 | 1 => {
                    timer.power(if boundary == 0 { 1 } else { 3 }, 299000);
                    timer.power(if boundary == 0 { 2 } else { 4 }, 300000);
                    300000
                }
                2 => {
                    let mut config = timer.input.clone().unwrap();
                    config.meeting_enabled = false;
                    timer.configure(config.clone(), 299000).unwrap();
                    config.meeting_enabled = true;
                    timer.configure(config, 300000).unwrap();
                    300000
                }
                3 => 310000,
                _ => 298000,
            };
            media_sample(&mut timer, restart, &off);
            media_until(&mut timer, restart, restart + 299000, &off);
            assert_eq!(
                timer.snapshot.meeting_resumed_epoch, 0,
                "boundary {boundary}"
            );
        }
    }
    /// Build a due strict meeting break with simulated media release and an active warning.
    fn strict_warning_timer() -> Timer {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.meeting_enabled = true;
        timer.configure(config, 0).unwrap();
        let mut status = meeting_status(&["Zoom"]);
        status.capture_supported = true;
        status.capture_active = Some(false);
        media_sample(&mut timer, 0, &status);
        media_sample(&mut timer, 2000, &status);
        // Model the media-inactivity release while retaining the raw call.
        timer.meeting_resumed = true;
        timer.meeting_breaks_blocked = false;
        assert!(timer.hold_for_meeting_warning(2000));
        timer
    }
    /// Verify that one complete 30-second warning precedes takeover without restarting after
    /// expiry.
    #[test]
    fn strict_meeting_warning_grants_one_full_grace_before_takeover() {
        let mut timer = strict_warning_timer();
        assert!(!timer.meeting_warning_allows_break());
        assert_eq!(timer.snapshot.meeting_warning_end_at, Some(32000));
        for at in 2001..32000 {
            assert!(timer.hold_for_meeting_warning(at));
        }
        assert_eq!(timer.snapshot.meeting_warning_epoch, 1);
        assert!(!timer.hold_for_meeting_warning(32000));
        assert!(timer.meeting_warning_allows_break());
        assert!(!timer.hold_for_meeting_warning(33000));
        assert_eq!(timer.snapshot.meeting_warning_epoch, 1);
    }
    /// Verify warning identity and allowed delays, rejecting stale actions and preserving an
    /// explicit postponement.
    #[test]
    fn meeting_warning_actions_validate_duration_identity_and_preserve_explicit_delay() {
        for minutes in [5, 10, 15] {
            let mut timer = strict_warning_timer();
            let version = timer.snapshot.version;
            let epoch = timer.snapshot.meeting_warning_epoch;
            assert!(timer
                .defer_meeting_warning(version, epoch, Some(7), 3000)
                .is_err());
            assert!(timer
                .defer_meeting_warning(version + 1, epoch, Some(minutes), 3000)
                .is_err());
            assert!(timer
                .defer_meeting_warning(version, epoch + 1, Some(minutes), 3000)
                .is_err());
            timer
                .defer_meeting_warning(version, epoch, Some(minutes), 3000)
                .unwrap();
            assert_eq!(timer.snapshot.remaining_ms, f64::from(minutes) * 60000.);
            assert!(!timer.snapshot.expiry_pending);
            assert!(timer.input.as_ref().unwrap().strict_mode);
            assert!(!timer.meeting_postponement_pending);
            assert!(timer.snapshot.meeting_warning_end_at.is_none());
            assert!(timer
                .defer_meeting_warning(version, epoch, Some(minutes), 3001)
                .is_err());
            timer.reclaim_meeting_postponement();
            assert_eq!(timer.snapshot.remaining_ms, f64::from(minutes) * 60000.);
        }
    }
    /// Verify that reminder pause survives muted or unknown calls until confirmed meeting end
    /// while focus accounting continues.
    #[test]
    fn meeting_pause_waits_for_confirmed_end_and_keeps_strict_mode_and_focus() {
        let mut timer = strict_warning_timer();
        timer
            .defer_meeting_warning(
                timer.snapshot.version,
                timer.snapshot.meeting_warning_epoch,
                None,
                3000,
            )
            .unwrap();
        let active = media_status(Some(false));
        media_until(&mut timer, 3000, 310000, &active);
        assert!(timer.snapshot.meeting_reminders_paused);
        assert!(timer.meeting_blocks_break());
        assert_eq!(timer.snapshot.meeting_resumed_epoch, 0);
        assert!(!timer.hold_for_meeting_warning(310000));
        assert!(timer.snapshot.focus_by_date.values().sum::<f64>() > 0.);
        let mut unknown = crate::platform::MeetingStatus::inactive(false);
        unknown.capture_supported = true;
        media_sample(&mut timer, 311000, &unknown);
        assert!(timer.snapshot.meeting_reminders_paused);
        let mut ended = crate::platform::MeetingStatus::inactive(true);
        ended.capture_supported = true;
        ended.capture_active = Some(false);
        media_sample(&mut timer, 312000, &ended);
        media_until(&mut timer, 312000, 316999, &ended);
        assert!(timer.snapshot.meeting_reminders_paused);
        media_sample(&mut timer, 317000, &ended);
        assert!(!timer.snapshot.meeting_reminders_paused);
        assert!(!timer.meeting_blocks_break());
        assert!(timer.snapshot.meeting_resume_token.is_none());
        assert_eq!(timer.snapshot.meeting_pause_ended_epoch, 1);
        assert!(timer.input.as_ref().unwrap().strict_mode);
    }

    /// Verify that absence, timer pause or reset, and relevant policy changes invalidate
    /// warning actions.
    #[test]
    fn warning_cancels_on_pause_absence_reset_and_policy_change() {
        for cause in 0..5 {
            let mut timer = strict_warning_timer();
            let version = timer.snapshot.version;
            let epoch = timer.snapshot.meeting_warning_epoch;
            if cause == 0 {
                timer.power(3, 3000);
            } else {
                let mut config = timer.input.clone().unwrap();
                match cause {
                    1 => {
                        config.manual_paused = true;
                        config.version += 1;
                    }
                    2 => {
                        config.strict_mode = false;
                    }
                    3 => {
                        config.meeting_enabled = false;
                    }
                    _ => {
                        config.remaining_ms = 2000.;
                        config.expiry_pending = false;
                        config.version += 1;
                    }
                }
                timer.configure(config, 3000).unwrap();
            }
            assert!(timer.snapshot.meeting_warning_end_at.is_none());
            assert!(timer
                .defer_meeting_warning(version, epoch, Some(5), 3001)
                .is_err());
        }
    }
    /// Verify that a due timer without meeting context never creates a meeting warning.
    #[test]
    fn warning_is_not_created_without_a_strict_meeting_context() {
        for strict in [false, true] {
            let mut timer = Timer::new(0);
            let mut config = input();
            config.strict_mode = strict;
            config.meeting_enabled = true;
            timer.configure(config, 0).unwrap();
            timer.tick(2000, Some(0.), Some(false));
            assert!(!timer.hold_for_meeting_warning(2000));
            assert!(timer.meeting_warning_allows_break());
        }
    }
    /// Verify current-token pause and resume before expiry in both modes without changing
    /// manual pause or strict policy.
    #[test]
    fn resumed_meeting_control_works_before_expiry_in_both_modes_and_preserves_manual_pause() {
        for strict in [false, true] {
            for manual in [false, true] {
                let mut timer = Timer::new(0);
                let mut config = input();
                config.strict_mode = strict;
                config.manual_paused = manual;
                config.meeting_enabled = true;
                config.total_ms = 1_200_000.;
                config.remaining_ms = 1_200_000.;
                timer.configure(config, 0).unwrap();
                let off = media_status(Some(false));
                media_sample(&mut timer, 0, &off);
                media_until(&mut timer, 0, 300000, &off);
                let token = timer.snapshot.meeting_resume_token.unwrap();
                assert!(!timer.snapshot.expiry_pending);
                let remaining = timer.snapshot.remaining_ms;
                timer
                    .set_meeting_reminders_paused(token, true, 300000)
                    .unwrap();
                assert_eq!(timer.snapshot.remaining_ms, remaining);
                assert_eq!(timer.snapshot.manual_paused, manual);
                assert!(timer.meeting_blocks_break());
                assert!(timer
                    .set_meeting_reminders_paused(token, true, 300001)
                    .is_err());
                let muted = media_status(Some(false));
                media_until(&mut timer, 300000, 610000, &muted);
                media_sample(
                    &mut timer,
                    611000,
                    &crate::platform::MeetingStatus::inactive(false),
                );
                assert!(timer.meeting_blocks_break());
                assert!(timer.snapshot.meeting_reminders_paused);
                timer.clear_meeting_history(611001);
                assert!(
                    timer.meeting_blocks_break(),
                    "history deletion cannot undo manual suspension"
                );
                let current = timer.snapshot.meeting_resume_token.unwrap();
                timer
                    .set_meeting_reminders_paused(current, false, 612000)
                    .unwrap();
                assert!(!timer.snapshot.meeting_reminders_paused);
                assert!(timer.snapshot.meeting_resume_token.is_none());
                assert_eq!(timer.snapshot.manual_paused, manual);
                assert_eq!(timer.input.as_ref().unwrap().strict_mode, strict);
            }
        }
    }
    /// Verify that reminder pause cancels only the token-associated break and removes its
    /// deadline.
    #[test]
    fn resumed_meeting_control_cancels_only_its_associated_break_and_clears_deadline() {
        for associated in [false, true] {
            let mut timer = live_meeting_timer();
            let off = media_status(Some(false));
            media_sample(&mut timer, 0, &off);
            media_until(&mut timer, 0, 300000, &off);
            let token = timer.snapshot.meeting_resume_token.unwrap();
            let mut config = timer.input.clone().unwrap();
            config.manual_paused = false;
            config.remaining_ms = 0.;
            config.expiry_pending = true;
            config.version += 1;
            timer.configure(config, 300000).unwrap();
            assert!(timer.hold_for_meeting_warning(300000));
            media_until(&mut timer, 300000, 330000, &off);
            assert!(!timer.hold_for_meeting_warning(330000));
            let mut config = timer.input.clone().unwrap();
            config.break_active = true;
            config.break_seconds = 120.;
            config.version += 1;
            config.meeting_break_token = associated.then_some(token);
            timer.configure(config, 331000).unwrap();
            media_sample(&mut timer, 331500, &media_status(Some(true)));
            assert_eq!(timer.snapshot.meeting_resume_token, Some(token));
            assert_eq!(timer.snapshot.meeting_break_cancellable, associated);
            let result = timer.set_meeting_reminders_paused(token, true, 332000);
            assert_eq!(result.is_ok(), associated);
            if associated {
                assert!(!timer.snapshot.break_active);
                assert!(!timer.strict());
                assert!(timer.snapshot.break_end_at.is_none());
                assert_eq!(timer.snapshot.meeting_break_cancelled_epoch, 1);
                timer.tick(500000, Some(0.), Some(false));
                assert!(!timer.snapshot.break_elapsed);
                let mut config = timer.input.clone().unwrap();
                config.meeting_enabled = false;
                timer.configure(config, 500001).unwrap();
                assert!(timer.snapshot.meeting_resume_token.is_none());
                assert!(timer
                    .set_meeting_reminders_paused(token, true, 500002)
                    .is_err());
            } else {
                assert!(timer.strict(), "ordinary strict breaks remain locked");
            }
        }
    }
    /// Verify that an invalidated meeting token rejects a queued break even when its timer
    /// version matches.
    #[test]
    fn paused_meeting_rejects_a_queued_break_even_at_the_same_timer_version() {
        let mut timer = live_meeting_timer();
        let off = media_status(Some(false));
        media_sample(&mut timer, 0, &off);
        media_until(&mut timer, 0, 300000, &off);
        let token = timer.snapshot.meeting_resume_token.unwrap();
        timer
            .set_meeting_reminders_paused(token, true, 300001)
            .unwrap();
        let mut config = timer.input.clone().unwrap();
        config.break_active = true;
        config.meeting_break_token = Some(token);
        assert!(timer.configure(config, 300002).is_err());
        assert!(!timer.snapshot.break_active);
        assert!(timer.snapshot.meeting_reminders_paused);
    }
    /// Verify that dismissing the resumption control preserves both the due break and its
    /// warning deadline.
    #[test]
    fn dismissing_resumption_control_preserves_due_break_and_warning() {
        let mut timer = live_meeting_timer();
        let off = media_status(Some(false));
        media_sample(&mut timer, 0, &off);
        media_until(&mut timer, 0, 300000, &off);
        let token = timer.snapshot.meeting_resume_token.unwrap();
        let mut config = timer.input.clone().unwrap();
        config.manual_paused = false;
        config.remaining_ms = 0.;
        config.expiry_pending = true;
        config.version += 1;
        timer.configure(config, 300001).unwrap();
        assert!(
            timer.snapshot.meeting_warning_required,
            "muted heuristic loss preserves resumption warning context"
        );
        assert!(timer.hold_for_meeting_warning(300001));
        let end = timer.snapshot.meeting_warning_end_at;
        timer
            .set_meeting_reminders_paused(token, false, 300002)
            .unwrap();
        assert!(timer.snapshot.expiry_pending);
        assert_eq!(timer.snapshot.remaining_ms, 0.);
        assert_eq!(timer.snapshot.meeting_warning_end_at, end);
        assert!(timer.snapshot.meeting_resume_token.is_none());
    }
    /// Verify that confirmed meeting end clears the override once, invalidates its token, and
    /// preserves manual timer pause.
    #[test]
    fn meeting_override_ends_automatically_and_preserves_manual_timer_pause() {
        for manual in [false, true] {
            let mut timer = strict_warning_timer();
            timer
                .defer_meeting_warning(
                    timer.snapshot.version,
                    timer.snapshot.meeting_warning_epoch,
                    None,
                    3000,
                )
                .unwrap();
            if manual {
                let mut config = timer.input.clone().unwrap();
                config.manual_paused = true;
                config.version += 1;
                timer.configure(config, 3000).unwrap();
            }
            let muted = media_status(Some(false));
            media_until(&mut timer, 3000, 310000, &muted);
            assert!(
                timer.snapshot.meeting_reminders_paused,
                "camera/microphone inactivity cannot end an active meeting"
            );
            let token = timer.snapshot.meeting_resume_token.unwrap();
            let mut ended = crate::platform::MeetingStatus::inactive(true);
            ended.capture_supported = true;
            ended.capture_active = Some(false);
            media_sample(&mut timer, 311000, &ended);
            media_until(&mut timer, 311000, 315999, &ended);
            assert!(
                timer.snapshot.meeting_reminders_paused,
                "meeting end is debounced"
            );
            media_sample(&mut timer, 316000, &ended);
            assert!(!timer.snapshot.meeting_reminders_paused);
            assert!(!timer.meeting_blocks_break());
            assert_eq!(timer.snapshot.manual_paused, manual);
            assert_eq!(timer.input.as_ref().unwrap().manual_paused, manual);
            assert!(timer.snapshot.meeting_resume_token.is_none());
            assert!(!timer.snapshot.meeting_warning_required);
            assert_eq!(timer.snapshot.meeting_pause_ended_epoch, 1);
            assert!(timer
                .set_meeting_reminders_paused(token, true, 316001)
                .is_err());
            if !manual {
                assert!(timer.snapshot.expiry_pending);
            }
            media_until(&mut timer, 316000, 630000, &ended);
            assert_eq!(
                timer.snapshot.meeting_pause_ended_epoch, 1,
                "one restoration per meeting"
            );
        }
    }
    /// Verify that confirmed meeting end preserves a running work countdown regardless of
    /// capture state.
    #[test]
    fn meeting_end_preserves_a_not_yet_due_work_cycle_with_any_capture_state() {
        for capture in [None, Some(false), Some(true)] {
            let mut timer = Timer::new(0);
            let mut config = input();
            config.meeting_enabled = true;
            config.total_ms = 1_200_000.;
            config.remaining_ms = 1_200_000.;
            timer.configure(config, 0).unwrap();
            let muted = media_status(Some(false));
            media_sample(&mut timer, 0, &muted);
            media_until(&mut timer, 0, 300000, &muted);
            timer
                .set_meeting_reminders_paused(
                    timer.snapshot.meeting_resume_token.unwrap(),
                    true,
                    300000,
                )
                .unwrap();
            let mut ended = crate::platform::MeetingStatus::inactive(true);
            ended.capture_supported = true;
            ended.capture_active = capture;
            media_sample(&mut timer, 301000, &ended);
            media_until(&mut timer, 301000, 306000, &ended);
            assert!(!timer.snapshot.meeting_reminders_paused);
            assert_eq!(timer.snapshot.remaining_ms, 894_000.);
            assert!(
                !timer.snapshot.expiry_pending,
                "a meeting override does not invent an overdue break"
            );
            assert_eq!(
                timer.input.as_ref().unwrap().remaining_ms,
                timer.snapshot.remaining_ms
            );
        }
    }
    /// Verify that failed or positive probes, timing discontinuities, history deletion, and
    /// sleep restart meeting-end confirmation.
    #[test]
    fn meeting_end_needs_continuous_supported_negatives_after_each_boundary() {
        for cause in 0..6 {
            let mut timer = strict_warning_timer();
            timer
                .defer_meeting_warning(
                    timer.snapshot.version,
                    timer.snapshot.meeting_warning_epoch,
                    None,
                    3000,
                )
                .unwrap();
            let ended = crate::platform::MeetingStatus::inactive(true);
            media_sample(&mut timer, 4000, &ended);
            media_until(&mut timer, 4000, 8000, &ended);
            let next = match cause {
                0 => {
                    media_sample(
                        &mut timer,
                        9000,
                        &crate::platform::MeetingStatus::inactive(false),
                    );
                    10000
                }
                1 => {
                    media_sample(&mut timer, 9000, &media_status(Some(false)));
                    10000
                }
                2 => {
                    media_sample(&mut timer, 19000, &ended);
                    20000
                }
                3 => {
                    media_sample(&mut timer, 7000, &ended);
                    9000
                }
                4 => {
                    timer.clear_meeting_history(8001);
                    9000
                }
                _ => {
                    timer.power(1, 8001);
                    timer.power(2, 9000);
                    10000
                }
            };
            media_sample(&mut timer, next, &ended);
            media_until(&mut timer, next, next + 4999, &ended);
            assert!(
                timer.snapshot.meeting_reminders_paused,
                "boundary {cause} must restart confirmation"
            );
            media_sample(&mut timer, next + 5000, &ended);
            assert!(
                !timer.snapshot.meeting_reminders_paused,
                "boundary {cause} eventually restores"
            );
        }
    }
    /// Build a supported meeting fixture from application names with no capture-probe support.
    fn meeting_status(applications: &[&str]) -> crate::platform::MeetingStatus {
        crate::platform::MeetingStatus {
            capture_active: None,
            capture_supported: false,
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
    /// Verify that live status separates unsupported and inactive probes while discarding
    /// private metadata.
    #[test]
    fn live_status_distinguishes_unknown_and_inactive_without_private_metadata() {
        let mut timer = live_meeting_timer();
        timer.observe_meeting(
            250,
            &crate::platform::MeetingStatus {
                capture_active: None,
                capture_supported: false,
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
    /// Verify that private titles and URLs become unknown attribution while later recognized
    /// applications remain identifiable.
    #[test]
    fn unknown_attribution_is_preserved_without_accepting_private_metadata() {
        let mut timer = meeting_timer();
        let status = crate::platform::MeetingStatus {
            capture_active: None,
            capture_supported: false,
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
    /// Build a short strict timer configuration with meeting features disabled and no token
    /// associating a break with a meeting.
    fn input() -> TimerInput {
        TimerInput {
            total_ms: 2000.,
            remaining_ms: 2000.,
            manual_paused: false,
            break_active: false,
            meeting_break_token: None,
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
    fn long_lock_restarts_without_a_renderer_and_rejects_old_commands() {
        for idle_enabled in [false, true] {
            let mut timer = Timer::new(0);
            let mut config = input();
            config.total_ms = 1_200_000.;
            config.remaining_ms = 60_000.;
            config.idle_enabled = idle_enabled;
            timer.configure(config.clone(), 0).unwrap();
            timer.power(3, 1000);
            timer.power(4, 301_001);
            timer.tick(301_251, Some(0.), Some(false));
            assert_eq!(timer.snapshot.remaining_ms, 1_200_000.);
            let reset = timer.snapshot.absence_reset.as_ref().unwrap();
            assert_eq!(reset.epoch, 1);
            assert_eq!(reset.remaining_ms, 60_000.);
            assert!(!timer.snapshot.expiry_pending);
            assert_eq!(timer.snapshot.focus_by_date.values().sum::<f64>(), 0.);
            assert!(timer.configure(config, 301_252).is_err());
            timer.tick(302_251, Some(0.), Some(false));
            assert_eq!(timer.snapshot.remaining_ms, 1_199_000.);
            assert_eq!(timer.snapshot.focus_by_date.values().sum::<f64>(), 1.);
        }
    }
    #[test]
    fn long_nested_lock_waits_for_presence_and_preserves_manual_pause() {
        let mut timer = Timer::new(0);
        let mut config = input();
        config.total_ms = 1_500_000.;
        config.remaining_ms = 42_000.;
        config.manual_paused = true;
        timer.configure(config, 0).unwrap();
        timer.power(3, 1000);
        timer.power(1, 2000);
        timer.power(2, 301_000);
        timer.tick(301_250, Some(0.), Some(true));
        assert_eq!(timer.snapshot.remaining_ms, 42_000.);
        timer.power(4, 302_000);
        timer.tick(302_250, Some(60.), Some(false));
        assert_eq!(timer.snapshot.remaining_ms, 42_000.);
        timer.tick(303_250, Some(0.), Some(false));
        assert_eq!(timer.snapshot.remaining_ms, 1_500_000.);
        assert!(timer.snapshot.manual_paused);
        timer.tick(304_250, Some(0.), Some(false));
        assert_eq!(timer.snapshot.remaining_ms, 1_500_000.);
    }
    #[test]
    fn absence_reset_keeps_the_existing_three_minute_boundary() {
        for duration in [179_999, 180_000, 300_000, 300_001] {
            let mut timer = Timer::new(0);
            let mut config = input();
            config.total_ms = 1_200_000.;
            config.remaining_ms = 60_000.;
            timer.configure(config, 0).unwrap();
            timer.power(3, 1000);
            timer.power(4, 1000 + duration);
            timer.tick(1000 + duration, Some(0.), Some(false));
            let expected = if duration >= 180_000 {
                1_200_000.
            } else {
                60_000.
            };
            assert_eq!(timer.snapshot.remaining_ms, expected, "duration {duration}");
        }
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
