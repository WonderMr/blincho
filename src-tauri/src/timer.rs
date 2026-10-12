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
            if let Some(date) = Local.timestamp_millis_opt(now - active as i64).single() {
                *self
                    .snapshot
                    .focus_by_date
                    .entry(date.format("%Y-%m-%d").to_string())
                    .or_default() += active / 1000.;
            }
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
}

#[cfg(test)]
mod tests {
    use super::*;
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
