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
    pub tick_count: u64,
    pub meeting_postponed_epoch: u64,
}
pub struct Timer {
    pub input: Option<TimerInput>,
    pub snapshot: Snapshot,
    last_at: i64,
    break_end: Option<i64>,
    unconfirmed: bool,
    observed_lock: bool,
}
impl Timer {
    pub fn new(now: i64) -> Self {
        Self {
            input: None,
            last_at: now,
            break_end: None,
            unconfirmed: false,
            observed_lock: false,
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
                tick_count: 0,
                meeting_postponed_epoch: 0,
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
                .is_none_or(|input| !input.meeting_enabled || input.strict_mode)
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
        self.observe_activity(self.last_at, now, self.activity_state());
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
        let previous_state = self.activity_state();
        let elapsed = (now - self.last_at).max(0) as f64;
        let was_present = self.snapshot.reasons.is_empty();
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
            if input.idle_enabled && self.snapshot.idle_seconds >= input.idle_threshold_seconds {
                reasons.push("idle".into());
            }
        }
        self.snapshot.reasons = reasons;
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
    pub fn strict(&self) -> bool {
        self.snapshot.break_active
            && !self.snapshot.break_elapsed
            && self.snapshot.reasons.is_empty()
            && !self.snapshot.locked
            && !self.snapshot.suspended
            && !self.unconfirmed
            && self.input.as_ref().is_some_and(|input| input.strict_mode)
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
        let end = start + duration_ms as i64;
        while cursor < end {
            let Some(date) = Local.timestamp_millis_opt(cursor).single() else {
                break;
            };
            let Some(next_date) = date.date_naive().succ_opt() else {
                break;
            };
            let Some(midnight) = Local
                .from_local_datetime(&next_date.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
            else {
                break;
            };
            let segment_end = end.min(midnight.timestamp_millis());
            if segment_end <= cursor {
                break;
            }
            *self
                .snapshot
                .focus_by_date
                .entry(date.format("%Y-%m-%d").to_string())
                .or_default() += (segment_end - cursor) as f64 / 1000.;
            cursor = segment_end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
