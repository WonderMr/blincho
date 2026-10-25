import { AppSettings, DayStats, CVSSurveyResult, ActivitySpan, MeetingSpan } from '../types';
import { normalizeActivity, splitActivityByDay } from './activity';
import { normalizeMeetings, splitMeetingsByDay } from './meetings';
import { normalizeTimerSettings } from './timerSession';
import { mergeInputActivity, normalizeInputActivity } from './inputActivity';
import type { InputActivitySnapshot } from './inputActivity';
import { CVS_SURVEY_QUESTIONS } from '../data/cvsQuestions';
import { readStatistics, writeStatistics, statisticsWriteResult } from './statisticsPersistence';

const STORAGE_KEYS = {
  SETTINGS: 'myeyes_settings_v1',
  CVS_RESULT: 'myeyes_cvs_result_v1',
};

export const DEFAULT_SETTINGS: AppSettings = {
  timerPreset: '20-20-20',
  workMinutes: 20,
  breakSeconds: 20,
  soundEnabled: true,
  soundVolume: 80,
  notificationsEnabled: true,
  autoTakeoverModal: true,
  theme: 'system',
  colorPalette: 'sage',
  idleDetectionEnabled: true,
  idleAction: 'pause',
  idleThresholdMinutes: 1,
  strictModeIgnoreIdle: false,
  meetingDetectionEnabled: true,
  meetingHistoryEnabled: false,
  cameraLockEnabled: false,
  enhancedPresenceEnabled: false,
  absenceLockEnabled: false,
  inputActivityEnabled: false,
  localMcpEnabled: false,
  strictMode: false,
};

export function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeTimerSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    const value = JSON.stringify(settings);
    if (localStorage.getItem(STORAGE_KEYS.SETTINGS) !== value) localStorage.setItem(STORAGE_KEYS.SETTINGS, value);
  } catch (err) {
    console.warn('Blincho: Failed to save settings to localStorage:', err);
  }
}

function emptyDay(date: string): DayStats {
  return { date, breaksCompleted: 0, exercisesCompleted: 0, focusMinutes: 0, techniqueCounts: {}, completedEventIds: [] };
}

export function loadAllStats(): DayStats[] {
  try {
    const parsed: unknown = JSON.parse(readStatistics() || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((stat): stat is DayStats => !!stat && typeof stat.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(stat.date) &&
      [stat.breaksCompleted, stat.exercisesCompleted, stat.focusMinutes].every(value =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0))
      .map(stat => ({ ...stat,
        ...(stat.activity !== undefined ? { activity: normalizeActivity(stat.activity, stat.date) } : {}),
        ...(stat.meetings !== undefined ? { meetings: normalizeMeetings(stat.meetings, stat.date) } : {}),
        ...(stat.inputActivity !== undefined ? { inputActivity: normalizeInputActivity(stat.inputActivity, stat.date) } : {}),
        ...(stat.inputActivityCursor ? { inputActivityCursor: {
          source: typeof stat.inputActivityCursor.source === 'string' ? stat.inputActivityCursor.source.slice(0, 100) : '',
          buckets: normalizeInputActivity(stat.inputActivityCursor.buckets, stat.date),
        } } : {}),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export function loadTodayStats(stats: DayStats[] = loadAllStats()): DayStats {
  const today = getTodayDateString();
  return stats.find(stat => stat.date === today) || emptyDay(today);
}

// Remove call records only. Keep activity, totals, completion IDs and other data.
// Return the write outcome so the UI never announces a deletion that failed.
export function clearMeetingHistory(): boolean | Promise<boolean> {
  try {
    const raw = readStatistics();
    if (!raw) return true;
    const stats: unknown = JSON.parse(raw);
    if (!Array.isArray(stats)) return false;
    const cleared = stats.map(day => {
      if (!day || typeof day !== 'object' || Array.isArray(day)) return day;
      const { meetings: _meetings, ...rest } = day;
      return rest;
    });
    writeStatistics(JSON.stringify(cleared));
    return statisticsWriteResult();
  } catch (error) {
    console.warn('Blincho: Failed to clear call history:', error);
    return false;
  }
}

function updateDay(date: string, update: (stat: DayStats, stats: DayStats[]) => void): DayStats {
  const stats = loadAllStats();
  let stat = stats.find(item => item.date === date);
  if (!stat) {
    stat = emptyDay(date);
    stats.push(stat);
    stats.sort((a, b) => a.date.localeCompare(b.date));
  }
  update(stat, stats);
  try {
    // Keep the full daily history so long streaks and earned achievements survive.
    writeStatistics(JSON.stringify(stats));
  } catch (err) {
    console.warn('Blincho: Failed to save statistics:', err);
  }
  return stat;
}

function claimEvent(stat: DayStats, stats: DayStats[], eventId?: string): boolean {
  if (!eventId) return true;
  if (stats.some(day => day.completedEventIds?.includes(eventId))) return false;
  if (!Array.isArray(stat.completedEventIds)) stat.completedEventIds = [];
  if (stat.completedEventIds.includes(eventId)) return false;
  stat.completedEventIds.push(eventId);
  return true;
}

export function recordFocusSeconds(seconds: number, date = getTodayDateString()): DayStats {
  return updateDay(date, stat => {
    if (Number.isFinite(seconds) && seconds > 0) stat.focusMinutes += seconds / 60;
  });
}

export function recordActivitySpans(spans: ActivitySpan[]): void {
  recordTimerProgress([], spans);
}

export function recordInputActivity(snapshot: InputActivitySnapshot): boolean | Promise<boolean> {
  if (snapshot.status !== 'active' || typeof snapshot.source !== 'string' || !snapshot.source || snapshot.source.length > 100 || !Array.isArray(snapshot.buckets)) return false;
  const stats = loadAllStats();
  const history = new Map(stats.map(day => [day.date, day]));
  const dates = new Set(snapshot.buckets.filter(bucket => Number.isFinite(bucket?.start)).map(bucket => {
    const date = new Date(bucket.start);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }));
  for (const date of dates) {
    const incoming = normalizeInputActivity(snapshot.buckets, date);
    if (!incoming.length) continue;
    const day = history.get(date) ?? emptyDay(date);
    const previous = day.inputActivityCursor?.source === snapshot.source ? day.inputActivityCursor.buckets : [];
    day.inputActivity = mergeInputActivity(day.inputActivity ?? [], incoming, previous);
    // Keep the maximum watermark if a delayed snapshot arrives after a newer one.
    const buckets = normalizeInputActivity([...previous, ...incoming], date);
    day.inputActivityCursor = { source: snapshot.source, buckets };
    history.set(date, day);
  }
  try {
    writeStatistics(JSON.stringify([...history.values()].sort((a, b) => a.date.localeCompare(b.date))));
    return statisticsWriteResult();
  } catch (error) { console.warn('Blincho: Input activity storage failed:', error); return false; }
}

export function clearInputActivity(): boolean | Promise<boolean> {
  try {
    const stats = loadAllStats().map(({ inputActivity: _counts, inputActivityCursor: _cursor, ...day }) => day);
    writeStatistics(JSON.stringify(stats));
    return statisticsWriteResult();
  } catch (error) { console.warn('Blincho: Input activity deletion failed:', error); return false; }
}

// Focus totals and timeline observations share one snapshot and one write,
// including heartbeats that cross local midnight.
export function recordTimerProgress(focus: [string, number][], spans: ActivitySpan[], meetingSpans: MeetingSpan[] = []): void {
  const activity = splitActivityByDay(spans);
  const meetings = splitMeetingsByDay(meetingSpans);
  const validFocus = focus.filter(([date, seconds]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(seconds) && seconds > 0);
  if (!validFocus.length && !activity.size && !meetings.size) return;
  const stats = loadAllStats();
  const history = new Map(stats.map(day => [day.date, day]));
  const getDay = (date: string) => {
    let day = history.get(date);
    if (!day) { day = emptyDay(date); history.set(date, day); }
    return day;
  };
  for (const [date, seconds] of validFocus) getDay(date).focusMinutes += seconds / 60;
  for (const [date, entries] of activity) {
    const day = getDay(date);
    day.activity = normalizeActivity([...(day.activity ?? []), ...entries], date);
  }
  for (const [date, entries] of meetings) {
    const day = getDay(date);
    day.meetings = normalizeMeetings([...(day.meetings ?? []), ...entries], date);
  }
  try {
    writeStatistics(JSON.stringify([...history.values()].sort((a, b) => a.date.localeCompare(b.date))));
  } catch (error) { console.warn('Blincho: Failed to save timer progress:', error); }
}

export function recordBreakCompleted(workMinutesGained = 0, eventId?: string): DayStats {
  return updateDay(getTodayDateString(), (stat, stats) => {
    if (!claimEvent(stat, stats, eventId)) return;
    stat.breaksCompleted += 1;
    if (Number.isFinite(workMinutesGained) && workMinutesGained > 0) stat.focusMinutes += workMinutesGained;
  });
}

export function recordExerciseCompleted(techniqueId?: string, eventId?: string): DayStats {
  return updateDay(getTodayDateString(), (stat, stats) => {
    if (!claimEvent(stat, stats, eventId)) return;
    stat.exercisesCompleted += 1;
    if (techniqueId) {
      if (!stat.techniqueCounts || typeof stat.techniqueCounts !== 'object') stat.techniqueCounts = {};
      stat.techniqueCounts[techniqueId] = (stat.techniqueCounts[techniqueId] || 0) + 1;
    }
  });
}

export function loadCVSResult(): CVSSurveyResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CVS_RESULT);
    if (raw) {
      const result = JSON.parse(raw);
      if (!result || typeof result.score !== 'number' || !Number.isFinite(result.score) || typeof result.date !== 'string') return null;
      // Old records have no details. Ignore malformed details without losing their saved total.
      const validAnswers = result.answers && typeof result.answers === 'object' && !Array.isArray(result.answers) &&
        CVS_SURVEY_QUESTIONS.every(question => question.options.some(option => option.score === result.answers[question.id]));
      if (validAnswers) {
        result.answers = Object.fromEntries(CVS_SURVEY_QUESTIONS.map(question => [question.id, result.answers[question.id]]));
      } else {
        delete result.answers;
      }
      if (result.level === 'self-check') return result;
      return { ...result, level: 'self-check', title: 'Самопроверка симптомов', recommendations: [
        'Результат отражает ваши ответы и не устанавливает диагноз.',
        'Если симптомы сохраняются, мешают работе или усиливаются, обсудите их с офтальмологом.'
      ] };
    }
  } catch {
    // fallback
  }
  return null;
}

export function saveCVSResult(res: CVSSurveyResult): boolean {
  try {
    localStorage.setItem(STORAGE_KEYS.CVS_RESULT, JSON.stringify(res));
    return true;
  } catch {
    return false;
  }
}
