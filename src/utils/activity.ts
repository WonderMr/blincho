import type { ActivitySpan, ActivityState, DayStats } from '../types';

const STATES = new Set<ActivityState>(['work', 'idle', 'locked', 'suspended', 'hidden', 'unconfirmed', 'manual', 'break', 'exercise']);
export type TimelineSpan = Omit<ActivitySpan, 'state'> & { state: ActivityState | 'unknown' | 'future' };

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayBounds(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

// Stored spans are ordered and do not overlap. Invalid or duplicated imports
// cannot inflate duration; the earlier observation wins an overlap.
export function normalizeActivity(value: unknown, date: string): ActivitySpan[] {
  if (!Array.isArray(value)) return [];
  const bounds = dayBounds(date);
  if (!Number.isFinite(bounds.start)) return [];
  const spans: ActivitySpan[] = value.filter(span => span && Number.isFinite(span.start) && Number.isFinite(span.end) &&
    span.end > span.start && STATES.has(span.state)).map(span => ({
      start: Math.max(bounds.start, span.start), end: Math.min(bounds.end, span.end), state: span.state as ActivityState,
    })).filter(span => span.end > span.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: ActivitySpan[] = [];
  for (const span of spans) {
    const previous = result[result.length - 1];
    const start = Math.max(span.start, previous?.end ?? bounds.start);
    if (span.end <= start) continue;
    if (previous?.state === span.state && previous.end === start) previous.end = span.end;
    else result.push({ ...span, start });
  }
  return result;
}

export function splitActivityByDay(spans: ActivitySpan[]): Map<string, ActivitySpan[]> {
  const days = new Map<string, ActivitySpan[]>();
  for (const span of spans) {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end <= span.start || !STATES.has(span.state)) continue;
    // Observations cover at most a day of absence, avoiding unbounded imports.
    if (span.end - span.start > 31 * 86400000) continue;
    let cursor = span.start;
    while (cursor < span.end) {
      const date = localDayKey(new Date(cursor));
      const end = Math.min(span.end, dayBounds(date).end);
      if (end <= cursor) break;
      const entries = days.get(date) ?? [];
      entries.push({ start: cursor, end, state: span.state });
      days.set(date, entries);
      cursor = end;
    }
  }
  return days;
}

export function analyzeDayActivity(day: DayStats, now = Date.now()) {
  const { start, end } = dayBounds(day.date);
  const observedEnd = Math.min(end, Math.max(start, now));
  const saved = normalizeActivity(day.activity, day.date);
  const segments: TimelineSpan[] = [];
  let cursor = start;
  for (const span of saved) {
    if (span.start >= observedEnd) break;
    if (span.start > cursor) segments.push({ start: cursor, end: span.start, state: 'unknown' });
    const clipped = { ...span, end: Math.min(span.end, observedEnd) };
    if (clipped.end > clipped.start) segments.push(clipped);
    cursor = clipped.end;
  }
  if (cursor < observedEnd) segments.push({ start: cursor, end: observedEnd, state: 'unknown' });
  if (observedEnd < end) segments.push({ start: observedEnd, end, state: 'future' });
  const minutes = (states: string[]) => segments.filter(span => states.includes(span.state))
    .reduce((sum, span) => sum + (span.end - span.start) / 60000, 0);
  const work = segments.filter(span => span.state === 'work');
  const workMinutes = minutes(['work']);
  return {
    start, end, observedEnd, segments, workMinutes,
    awayMinutes: minutes(['idle', 'locked', 'suspended']),
    pauseMinutes: minutes(['manual']), restMinutes: minutes(['break', 'exercise']),
    recordedMinutes: minutes([...STATES].filter(state => state !== 'unconfirmed' && state !== 'hidden')),
    sessionCount: work.length, averageSessionMinutes: work.length ? workMinutes / work.length : 0,
    longestSessionMinutes: Math.max(0, ...work.map(span => (span.end - span.start) / 60000)),
    firstActiveAt: work[0]?.start ?? null, lastActiveAt: work[work.length - 1]?.end ?? null,
  };
}

export function summarizeWeek(stats: DayStats[], referenceDate: string) {
  const history = new Map(stats.map(day => [day.date, day]));
  const reference = new Date(`${referenceDate}T12:00:00`);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(reference);
    date.setDate(date.getDate() - index);
    return history.get(localDayKey(date));
  }).filter((day): day is DayStats => !!day);
  const usedDays = days.filter(day => day.focusMinutes > 0 || day.breaksCompleted > 0 || day.exercisesCompleted > 0 ||
    normalizeActivity(day.activity, day.date).some(span => span.state === 'work' || span.state === 'exercise')).length;
  const totalFocusMinutes = days.reduce((sum, day) => sum + day.focusMinutes, 0);
  const totalBreaks = days.reduce((sum, day) => sum + day.breaksCompleted, 0);
  const totalExercises = days.reduce((sum, day) => sum + day.exercisesCompleted, 0);
  return {
    calendarDays: 7, usedDays, totalFocusMinutes, totalBreaks, totalExercises,
    averageFocusMinutes: totalFocusMinutes / 7,
    averageFocusMinutesPerUsedDay: usedDays ? totalFocusMinutes / usedDays : 0,
    averageBreaks: totalBreaks / 7, averageBreaksPerUsedDay: usedDays ? totalBreaks / usedDays : 0,
    averageExercises: totalExercises / 7,
  };
}
