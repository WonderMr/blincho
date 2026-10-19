//! Anonymous event totals. Native event payloads never leave the collector.
use chrono::Local;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
#[path = "input_activity_linux.rs"]
mod backend;
#[cfg(target_os = "windows")]
#[path = "input_activity_windows.rs"]
mod backend;
#[cfg(target_os = "macos")]
#[path = "input_activity_macos.rs"]
mod backend;

pub struct Shared {
    running: AtomicBool,
    status: AtomicU8,
    counts: [AtomicU64; 4],
}
impl Shared {
    pub fn count(&self, kind: usize) {
        if self.running.load(Ordering::Relaxed) && kind < 4 {
            self.counts[kind].fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    start: i64,
    key_presses: u64,
    clicks: u64,
    scrolls: u64,
    mouse_moves: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    source: String,
    status: &'static str,
    buckets: Vec<Bucket>,
}
pub struct InputActivity {
    enabled: bool,
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
    source: String,
    generation: u64,
    buckets: BTreeMap<i64, Bucket>,
    last_sample: Instant,
    collecting: bool,
}
impl Default for InputActivity {
    fn default() -> Self {
        Self {
            enabled: false,
            shared: Arc::new(Shared {
                running: AtomicBool::new(false),
                status: AtomicU8::new(0),
                counts: std::array::from_fn(|_| AtomicU64::new(0)),
            }),
            worker: None,
            source: String::new(),
            generation: 0,
            buckets: BTreeMap::new(),
            last_sample: Instant::now(),
            collecting: false,
        }
    }
}
impl InputActivity {
    pub fn configure(&mut self, enabled: bool, prompt: bool, isolated: bool) -> Snapshot {
        if !enabled && self.enabled {
            self.shared.running.store(false, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            self.sample(self.collecting);
            let final_snapshot = self.snapshot();
            self.stop();
            self.enabled = false;
            self.buckets.clear();
            self.source.clear();
            return if final_snapshot.status == "active" {
                final_snapshot
            } else {
                self.snapshot()
            };
        }
        if self.enabled == enabled && (!prompt || self.shared.status.load(Ordering::Acquire) == 1) {
            return self.snapshot();
        }
        self.stop();
        self.enabled = enabled;
        self.generation += 1;
        self.source = format!(
            "{}-{}-{}",
            std::process::id(),
            Local::now().timestamp_millis(),
            self.generation
        );
        self.buckets.clear();
        if !enabled {
            return self.snapshot();
        }
        if isolated {
            self.shared.status.store(3, Ordering::Release);
            return self.snapshot();
        }
        let permission = backend::permission(prompt);
        if permission != 1 {
            self.shared.status.store(permission, Ordering::Release);
            return self.snapshot();
        }
        self.shared.running.store(true, Ordering::Release);
        let shared = Arc::clone(&self.shared);
        let (sender, receiver) = mpsc::channel();
        self.worker = Some(thread::spawn(move || {
            backend::run(&shared, sender);
            if shared.running() {
                shared.status.store(4, Ordering::Release);
            }
        }));
        match receiver.recv_timeout(Duration::from_secs(3)) {
            Ok(true) => self.shared.status.store(1, Ordering::Release),
            _ => {
                self.shared.running.store(false, Ordering::Release);
                self.shared.status.store(4, Ordering::Release);
            }
        }
        self.last_sample = Instant::now();
        self.snapshot()
    }
    pub fn sample(&mut self, collect: bool) {
        self.collecting = collect;
        let delta: [u64; 4] =
            std::array::from_fn(|i| self.shared.counts[i].swap(0, Ordering::AcqRel));
        let gap = self.last_sample.elapsed();
        self.last_sample = Instant::now();
        if !self.enabled
            || !collect
            || gap > Duration::from_secs(5)
            || self.shared.status.load(Ordering::Acquire) != 1
        {
            return;
        }
        let now = Local::now().timestamp_millis();
        let start = now.div_euclid(300_000) * 300_000;
        let bucket = self.buckets.entry(start).or_insert_with(|| Bucket {
            start,
            ..Bucket::default()
        });
        bucket.key_presses = bucket.key_presses.saturating_add(delta[0]);
        bucket.clicks = bucket.clicks.saturating_add(delta[1]);
        bucket.scrolls = bucket.scrolls.saturating_add(delta[2]);
        bucket.mouse_moves = bucket.mouse_moves.saturating_add(delta[3]);
        // The renderer persists totals. Bound the replay buffer to eight days.
        self.buckets
            .retain(|start, _| *start >= now - 8 * 86_400_000);
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            source: self.source.clone(),
            status: match self.shared.status.load(Ordering::Acquire) {
                1 => "active",
                2 => "permissionRequired",
                3 => "unsupported",
                4 => "unavailable",
                _ => "disabled",
            },
            buckets: self.buckets.values().cloned().collect(),
        }
    }
    pub fn stop(&mut self) {
        self.shared.running.store(false, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        for count in &self.shared.counts {
            count.store(0, Ordering::Relaxed);
        }
        self.shared.status.store(0, Ordering::Release);
    }
}
impl Drop for InputActivity {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opt_in_and_isolated_profiles_never_start_real_collectors() {
        let mut monitor = InputActivity::default();
        assert_eq!(monitor.configure(false, false, true).status, "disabled");
        assert!(monitor.snapshot().buckets.is_empty());
        assert!(monitor.snapshot().source.is_empty());
        assert_eq!(monitor.configure(true, true, true).status, "unsupported");
        assert!(monitor.worker.is_none());
        assert_eq!(monitor.configure(false, false, true).status, "disabled");
    }
    #[test]
    fn only_four_counts_and_aggregate_time_cross_the_privacy_boundary() {
        let mut monitor = InputActivity::default();
        monitor.enabled = true;
        monitor.shared.running.store(true, Ordering::Release);
        monitor.shared.status.store(1, Ordering::Release);
        for kind in 0..4 {
            monitor.shared.count(kind);
        }
        monitor.sample(true);
        monitor.sample(true);
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.buckets.len(), 1);
        let bucket = &snapshot.buckets[0];
        assert_eq!(
            (
                bucket.key_presses,
                bucket.clicks,
                bucket.scrolls,
                bucket.mouse_moves
            ),
            (1, 1, 1, 1)
        );
        let value = serde_json::to_value(bucket).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(bucket.start % 300_000, 0);
        monitor.shared.count(0);
        monitor.sample(false);
        monitor.sample(true);
        assert_eq!(monitor.snapshot().buckets[0].key_presses, 1);
        monitor.shared.count(0);
        monitor.last_sample = Instant::now() - Duration::from_secs(6);
        monitor.sample(true);
        assert_eq!(monitor.snapshot().buckets[0].key_presses, 1);
        monitor.stop();
        monitor.shared.count(0);
        assert_eq!(monitor.shared.counts[0].load(Ordering::Relaxed), 0);
    }
    #[test]
    fn disabling_delivers_final_cumulative_totals_once_before_resetting_the_source() {
        let mut monitor = InputActivity::default();
        monitor.enabled = true;
        monitor.source = "first".into();
        monitor.collecting = true;
        monitor.shared.running.store(true, Ordering::Release);
        monitor.shared.status.store(1, Ordering::Release);
        monitor.shared.count(0);
        let final_snapshot = monitor.configure(false, false, true);
        assert_eq!(final_snapshot.status, "active");
        assert_eq!(final_snapshot.source, "first");
        assert_eq!(final_snapshot.buckets[0].key_presses, 1);
        assert_eq!(monitor.configure(false, false, true).status, "disabled");
    }
}
