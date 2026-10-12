import { AppSettings, TimerPreset } from '../types';
import { normalizeAppearance } from './appearance';

export type PresenceReason = 'idle' | 'suspended' | 'locked' | 'hidden' | 'unconfirmed';

export function presetDurations(preset: TimerPreset, workMinutes: number, breakSeconds: number) {
  if (preset === '20-20-20') return { workSeconds: 1200, breakSeconds: 20 };
  if (preset === 'pomodoro') return { workSeconds: 1500, breakSeconds: 300 };
  return { workSeconds: workMinutes * 60, breakSeconds };
}

export function normalizeTimerSettings(settings: AppSettings): AppSettings {
  const bounded = (value: number, minimum: number, maximum: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
  const boolean = (value: boolean, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
  const preset = ['20-20-20', 'pomodoro', 'custom'].includes(settings.timerPreset) ? settings.timerPreset : '20-20-20';
  const duration = presetDurations(preset, bounded(settings.workMinutes, 1 / 60, 480, 20), bounded(settings.breakSeconds, 1, 1800, 20));
  return {
    ...settings, timerPreset: preset, workMinutes: duration.workSeconds / 60, breakSeconds: duration.breakSeconds,
    ...normalizeAppearance(settings),
    idleAction: settings.idleAction === 'reset' ? 'reset' : 'pause',
    idleThresholdMinutes: bounded(settings.idleThresholdMinutes, 0.5, 60, 1),
    soundVolume: bounded(settings.soundVolume, 0, 100, 80),
    soundEnabled: boolean(settings.soundEnabled, true), notificationsEnabled: boolean(settings.notificationsEnabled, true),
    autoTakeoverModal: boolean(settings.autoTakeoverModal, true), idleDetectionEnabled: boolean(settings.idleDetectionEnabled, true),
    meetingDetectionEnabled: boolean(settings.meetingDetectionEnabled, true), strictMode: boolean(settings.strictMode, false),
    strictModeIgnoreIdle: false,
  };
}

export function localDateAt(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// This model owns elapsed time. React effects only sample it and publish snapshots.
export class TimerSession {
  totalMs: number;
  remainingMs: number;
  manualPaused = false;
  breakActive = false;
  exercising = false;
  expiryPending = false;
  version = 0;
  reasons = new Set<PresenceReason>();
  absentSince: number | null = null;
  lastUpdated: number;
  private focusByDate = new Map<string, number>();

  constructor(seconds: number, now: number) {
    this.totalMs = this.remainingMs = seconds * 1000;
    this.lastUpdated = now;
  }

  get present() { return this.reasons.size === 0; }
  get counting() { return this.present && !this.manualPaused && !this.breakActive && !this.exercising; }

  advance(now: number): boolean {
    const start = this.lastUpdated;
    const elapsed = Math.max(0, now - start);
    this.lastUpdated = now;
    // A delayed heartbeat cannot prove presence during sleep or a suspended tab.
    if (elapsed > 5000) return false;
    if (this.counting) {
      const activeMs = Math.min(elapsed, this.remainingMs);
      this.remainingMs = Math.max(0, this.remainingMs - elapsed);
      this.addFocus(start, activeMs);
      if (this.remainingMs === 0 && !this.expiryPending) {
        this.expiryPending = true;
        return true;
      }
    }
    return false;
  }

  setReason(reason: PresenceReason, active: boolean, now: number, startedAt = now) {
    if (this.reasons.has(reason) === active) return;
    if (active) {
      if (this.present) this.advance(Math.max(this.lastUpdated, Math.min(now, startedAt)));
      this.reasons.add(reason);
      this.expiryPending = false;
      this.version += 1;
      this.absentSince = this.absentSince === null ? startedAt : Math.min(this.absentSince, startedAt);
    } else {
      this.reasons.delete(reason);
    }
    this.lastUpdated = now;
  }

  restart(seconds: number, now: number) {
    this.totalMs = this.remainingMs = seconds * 1000;
    this.lastUpdated = now;
    this.expiryPending = false;
    this.version += 1;
  }

  postpone(seconds: number, now: number) {
    this.remainingMs = seconds * 1000;
    this.lastUpdated = now;
    this.expiryPending = false;
    this.version += 1;
  }

  drainFocus(): [string, number][] {
    const result = [...this.focusByDate].map(([date, ms]): [string, number] => [date, ms / 1000]);
    this.focusByDate.clear();
    return result;
  }

  ingestNativeFocus(date: string, seconds: number): void {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(seconds) && seconds > 0) {
      this.focusByDate.set(date, (this.focusByDate.get(date) || 0) + seconds * 1000);
    }
  }

  private addFocus(start: number, durationMs: number) {
    let cursor = start;
    const end = start + durationMs;
    while (cursor < end) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const segmentEnd = Math.min(end, midnight.getTime());
      const date = localDateAt(cursor);
      this.focusByDate.set(date, (this.focusByDate.get(date) || 0) + segmentEnd - cursor);
      cursor = segmentEnd;
    }
  }
}
