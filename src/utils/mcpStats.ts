import type { DayStats } from '../types';
import { analyzeDayActivity, normalizeActivity } from './activity';

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

// Only daily aggregates cross the desktop bridge. Never pass through the saved
// records: they also contain call names, event IDs and detailed activity spans.
export function buildMcpStats(history: DayStats[], now = Date.now()): McpStats {
  let activityStartDate: string | null = null;
  const days = history.map(day => {
    const activity = analyzeDayActivity(day, now);
    if (normalizeActivity(day.activity, day.date).some(span => span.start < now) &&
      (activityStartDate === null || day.date < activityStartDate)) activityStartDate = day.date;
    return {
      date: day.date, breaksCompleted: day.breaksCompleted, exercisesCompleted: day.exercisesCompleted,
      focusMinutes: day.focusMinutes, workMinutes: activity.workMinutes, awayMinutes: activity.awayMinutes,
      pauseMinutes: activity.pauseMinutes, restMinutes: activity.restMinutes, recordedMinutes: activity.recordedMinutes,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, activityStartDate, days };
}
