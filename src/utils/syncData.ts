import { AppSettings, DayStats } from '../types';
import { MEDICAL_TECHNIQUES } from '../data/medicalTechniques';
import { normalizeTimerSettings } from './timerSession';

export type SyncSettings = Pick<AppSettings, 'timerPreset' | 'workMinutes' | 'breakSeconds' | 'soundEnabled' | 'soundVolume' | 'theme' | 'colorPalette'>;

export interface SyncDayStats {
  date: string;
  breaksCompleted: number;
  exercisesCompleted: number;
  focusMinutes: number;
  techniqueCounts: Record<string, number>;
}

export const MAX_SYNC_DAYS = 10_000;
const MAX_DAILY_COUNT = 1_000_000;
const MAX_DAILY_FOCUS_MINUTES = 24 * 60;
const SETTING_KEYS = ['timerPreset', 'workMinutes', 'breakSeconds', 'soundEnabled', 'soundVolume', 'theme', 'colorPalette'];
const STAT_KEYS = ['date', 'breaksCompleted', 'exercisesCompleted', 'focusMinutes', 'techniqueCounts'];
const TECHNIQUE_IDS = new Set(MEDICAL_TECHNIQUES.map(technique => technique.id));

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function count(value: unknown): value is number {
  return bounded(value, 0, MAX_DAILY_COUNT) && Number.isInteger(value);
}

function parseSyncSettings(value: unknown): SyncSettings {
  if (!record(value) || Object.keys(value).length !== SETTING_KEYS.length ||
      Object.keys(value).some(key => !SETTING_KEYS.includes(key)) ||
      (value.timerPreset !== '20-20-20' && value.timerPreset !== 'pomodoro' && value.timerPreset !== 'custom') ||
      !bounded(value.workMinutes, 1 / 60, 480) || !bounded(value.breakSeconds, 1, 1800) ||
      typeof value.soundEnabled !== 'boolean' || !bounded(value.soundVolume, 0, 100) ||
      (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') ||
      (value.colorPalette !== 'sage' && value.colorPalette !== 'ocean' && value.colorPalette !== 'lavender')) {
    throw new Error('Invalid synchronized settings.');
  }
  return {
    timerPreset: value.timerPreset, workMinutes: value.workMinutes, breakSeconds: value.breakSeconds,
    soundEnabled: value.soundEnabled, soundVolume: value.soundVolume, theme: value.theme, colorPalette: value.colorPalette,
  };
}

export function projectSyncSettings(settings: AppSettings): SyncSettings {
  return parseSyncSettings({
    timerPreset: settings.timerPreset, workMinutes: settings.workMinutes, breakSeconds: settings.breakSeconds,
    soundEnabled: settings.soundEnabled, soundVolume: settings.soundVolume, theme: settings.theme, colorPalette: settings.colorPalette,
  });
}

export function applySyncSettings(current: AppSettings, value: unknown): AppSettings {
  const incoming = parseSyncSettings(value);
  const normalized = normalizeTimerSettings({ ...current, ...incoming });
  // Project once more so normalization never changes this device's permissions or consent.
  return { ...current, ...projectSyncSettings(normalized) };
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateSyncStats(value: unknown): SyncDayStats[] {
  if (!Array.isArray(value) || value.length > MAX_SYNC_DAYS) throw new Error('Invalid synchronized statistics.');
  const dates = new Set<string>();
  return Array.from(value, day => {
    if (!record(day) || Object.keys(day).some(key => !STAT_KEYS.includes(key)) || !validDate(day.date) ||
        dates.has(day.date) || !count(day.breaksCompleted) || !count(day.exercisesCompleted) ||
        !bounded(day.focusMinutes, 0, MAX_DAILY_FOCUS_MINUTES) ||
        (day.techniqueCounts !== undefined && !record(day.techniqueCounts))) throw new Error('Invalid synchronized statistics.');
    const techniqueCounts: Record<string, number> = {};
    for (const [id, amount] of Object.entries(day.techniqueCounts ?? {})) {
      if (!TECHNIQUE_IDS.has(id) || !count(amount)) throw new Error('Invalid synchronized statistics.');
      techniqueCounts[id] = amount;
    }
    dates.add(day.date);
    return { date: day.date, breaksCompleted: day.breaksCompleted, exercisesCompleted: day.exercisesCompleted, focusMinutes: day.focusMinutes, techniqueCounts };
  }).sort((left, right) => left.date.localeCompare(right.date));
}

export function projectSyncStats(stats: DayStats[]): SyncDayStats[] {
  if (stats.length > MAX_SYNC_DAYS) throw new Error('Too many synchronized statistics days.');
  return validateSyncStats(stats.map(day => ({
    date: day.date, breaksCompleted: day.breaksCompleted, exercisesCompleted: day.exercisesCompleted, focusMinutes: day.focusMinutes,
    techniqueCounts: Object.fromEntries(Object.entries(day.techniqueCounts ?? {}).filter(([id]) => TECHNIQUE_IDS.has(id))),
  })));
}

function add(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw new Error('Synchronized statistics exceed the supported range.');
  return sum;
}

// Always derive from local history and the latest snapshot for each distinct device.
// Persisting these combined totals as local history would count remote devices twice.
export function mergeSyncStats(local: DayStats[], remoteSnapshots: DayStats[][]): DayStats[] {
  projectSyncStats(local);
  const byDate = new Map(local.map(day => [day.date, { ...day, techniqueCounts: { ...day.techniqueCounts } }]));
  for (const snapshot of remoteSnapshots) {
    for (const remote of validateSyncStats(snapshot)) {
      const current = byDate.get(remote.date);
      if (!current) {
        byDate.set(remote.date, { ...remote, techniqueCounts: { ...remote.techniqueCounts } });
        continue;
      }
      current.breaksCompleted = add(current.breaksCompleted, remote.breaksCompleted);
      current.exercisesCompleted = add(current.exercisesCompleted, remote.exercisesCompleted);
      current.focusMinutes = add(current.focusMinutes, remote.focusMinutes);
      for (const [id, amount] of Object.entries(remote.techniqueCounts)) current.techniqueCounts[id] = add(current.techniqueCounts[id] ?? 0, amount);
    }
  }
  if (byDate.size > MAX_SYNC_DAYS) throw new Error('Too many synchronized statistics days.');
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}
