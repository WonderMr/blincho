import type { DayStats } from '../types';
import { analyzeDayActivity } from './activity';

export interface McpDayStats {
  date: string;
  breaksCompleted: number;
  exercisesCompleted: number;
  focusMinutes: number;
  workMinutes: number;
  awayMinutes: number;
  pauseMinutes: number;
  restMinutes: number;
  recordedMinutes: number;
}

export interface McpStats {
  timeZone: string;
  activityStartDate: string | null;
  days: McpDayStats[];
}

function validMcpDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function completionCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(nonNegativeFinite(value)));
}

// Only daily aggregates cross the desktop bridge. Never pass through the saved
// records: they also contain call names, event IDs and detailed activity spans.
export function buildMcpStats(history: DayStats[], now = Date.now()): McpStats {
  let activityStartDate: string | null = null;
  const seen = new Set<string>();
  const days = history.filter(day => {
    if (!validMcpDate(day.date) || seen.has(day.date)) return false;
    // Match loadTodayStats: the first saved record for a date is authoritative.
    seen.add(day.date);
    return true;
  }).map(day => {
    const activity = analyzeDayActivity(day, now);
    if (activity.segments.some(span => span.state !== 'unknown' && span.state !== 'future') &&
      (activityStartDate === null || day.date < activityStartDate)) activityStartDate = day.date;
    return {
      date: day.date, breaksCompleted: completionCount(day.breaksCompleted), exercisesCompleted: completionCount(day.exercisesCompleted),
      focusMinutes: nonNegativeFinite(day.focusMinutes), workMinutes: nonNegativeFinite(activity.workMinutes), awayMinutes: nonNegativeFinite(activity.awayMinutes),
      pauseMinutes: nonNegativeFinite(activity.pauseMinutes), restMinutes: nonNegativeFinite(activity.restMinutes), recordedMinutes: nonNegativeFinite(activity.recordedMinutes),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, activityStartDate, days };
}
