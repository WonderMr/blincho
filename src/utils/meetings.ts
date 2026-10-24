import type { DayStats, MeetingSpan } from '../types';
import { dayBounds, localDayKey } from './activity';

export const MEETING_APPLICATIONS = [
  'Zoom', 'Microsoft Teams', 'Webex', 'Skype', 'Discord', 'FaceTime',
  'Google Chrome', 'Chromium', 'Safari', 'Firefox', 'Microsoft Edge', 'Brave', 'Vivaldi', 'unknown',
] as const;

const applicationNames = new Map<string, string>(MEETING_APPLICATIONS.map(app => [app.toLowerCase(), app]));
const MAX_SPAN_MS = 31 * 86400000;
const MAX_TIMESTAMP = Date.UTC(10000, 0, 1);

// Keep only known application names, never imported titles, URLs or file paths.
export function normalizeMeetingApplication(value: unknown): string {
  return typeof value === 'string' ? applicationNames.get(value.trim().toLowerCase()) ?? 'unknown' : 'unknown';
}

export function normalizeMeetingApplications(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeMeetingApplication))];
}

function safeSpan(value: unknown): MeetingSpan | null {
  if (!value || typeof value !== 'object') return null;
  const span = value as Partial<MeetingSpan>;
  if (typeof span.start !== 'number' || typeof span.end !== 'number' ||
    !Number.isFinite(span.start) || !Number.isFinite(span.end) || span.start < 0 ||
    span.end >= MAX_TIMESTAMP || span.end <= span.start || span.end - span.start > MAX_SPAN_MS) return null;
  return { start: span.start, end: span.end, app: normalizeMeetingApplication(span.app) };
}

function validDayBounds(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const bounds = dayBounds(date);
  return Number.isFinite(bounds.start) && Number.isFinite(bounds.end) && bounds.end > bounds.start &&
    localDayKey(new Date(bounds.start)) === date ? bounds : null;
}

function mergeApplicationSpans(spans: MeetingSpan[]): MeetingSpan[] {
  const apps = new Map<string, MeetingSpan[]>();
  for (const span of spans) {
    const entries = apps.get(span.app) ?? [];
    entries.push(span);
    apps.set(span.app, entries);
  }
  const merged: MeetingSpan[] = [];
  for (const entries of apps.values()) {
    entries.sort((a, b) => a.start - b.start || a.end - b.end);
    let previous: MeetingSpan | undefined;
    for (const span of entries) {
      if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
      else { previous = { ...span }; merged.push(previous); }
    }
  }
  return merged.sort((a, b) => a.start - b.start || a.end - b.end || a.app.localeCompare(b.app));
}

// Samples from the same application form one observed call while touching.
// Different applications retain their attribution even when their times overlap.
export function normalizeMeetings(value: unknown, date: string): MeetingSpan[] {
  const bounds = validDayBounds(date);
  if (!bounds || !Array.isArray(value)) return [];
  const spans: MeetingSpan[] = [];
  for (const valueSpan of value) {
    const span = safeSpan(valueSpan);
    if (!span) continue;
    const start = Math.max(bounds.start, span.start), end = Math.min(bounds.end, span.end);
    if (end > start) spans.push({ start, end, app: span.app });
  }
  return mergeApplicationSpans(spans);
}

export function splitMeetingsByDay(spans: MeetingSpan[]): Map<string, MeetingSpan[]> {
  const days = new Map<string, MeetingSpan[]>();
  for (const value of spans) {
    const span = safeSpan(value);
    if (!span) continue;
    let cursor = span.start;
    while (cursor < span.end) {
      const date = localDayKey(new Date(cursor));
      const bounds = validDayBounds(date);
      if (!bounds) break;
      const end = Math.min(span.end, bounds.end);
      if (end <= cursor) break;
      const entries = days.get(date) ?? [];
      entries.push({ start: cursor, end, app: span.app });
      days.set(date, entries);
      cursor = end;
    }
  }
  for (const [date, entries] of days) days.set(date, normalizeMeetings(entries, date));
  return days;
}

function elapsedMinutes(spans: MeetingSpan[]): number {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  let end = -Infinity, duration = 0;
  for (const span of ordered) {
    duration += Math.max(0, span.end - Math.max(span.start, end));
    end = Math.max(end, span.end);
  }
  return duration / 60000;
}

function callMetrics(spans: MeetingSpan[]) {
  const duration = spans.reduce((total, span) => total + (span.end - span.start) / 60000, 0);
  return {
    callCount: spans.length,
    totalMinutes: elapsedMinutes(spans),
    averageCallMinutes: spans.length ? duration / spans.length : 0,
    longestCallMinutes: spans.reduce((longest, span) => Math.max(longest, (span.end - span.start) / 60000), 0),
  };
}

function summarizeSpans(spans: MeetingSpan[]) {
  const apps = new Map<string, MeetingSpan[]>();
  for (const span of spans) {
    const entries = apps.get(span.app) ?? [];
    entries.push(span);
    apps.set(span.app, entries);
  }
  return {
    ...callMetrics(spans),
    firstCallAt: spans.length ? spans.reduce((first, span) => Math.min(first, span.start), Infinity) : null,
    lastCallAt: spans.length ? spans.reduce((last, span) => Math.max(last, span.end), -Infinity) : null,
    applications: [...apps].map(([app, entries]) => ({ app, ...callMetrics(entries) }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes || a.app.localeCompare(b.app)),
  };
}

export function analyzeDayMeetings(day: DayStats, now = Date.now()) {
  const bounds = validDayBounds(day.date);
  const start = bounds?.start ?? 0, end = bounds?.end ?? 0;
  const observedEnd = Number.isFinite(now) ? Math.min(end, Math.max(start, now)) : start;
  const spans = normalizeMeetings(day.meetings, day.date)
    .map(span => ({ ...span, end: Math.min(span.end, observedEnd) })).filter(span => span.end > span.start);
  return { start, end, observedEnd, spans, ...summarizeSpans(spans) };
}

export function summarizeWeekMeetings(stats: DayStats[], referenceDate: string, now = Date.now()) {
  const reference = validDayBounds(referenceDate);
  const dayKeys = new Set<string>();
  if (reference) {
    const date = new Date(reference.start);
    date.setHours(12, 0, 0, 0);
    for (let index = 0; index < 7; index += 1) {
      dayKeys.add(localDayKey(date));
      date.setDate(date.getDate() - 1);
    }
  }
  const history = new Map<string, MeetingSpan[]>();
  for (const day of stats) {
    if (!dayKeys.has(day.date)) continue;
    const spans = analyzeDayMeetings(day, now).spans;
    history.set(day.date, [...(history.get(day.date) ?? []), ...spans]);
  }
  const meetingDays = [...history].filter(([date, spans]) => normalizeMeetings(spans, date).length > 0).length;
  const spans = mergeApplicationSpans([...history.values()].flat());
  const summary = summarizeSpans(spans);
  return {
    calendarDays: 7, meetingDays, spans, ...summary,
    averageMinutesPerDay: summary.totalMinutes / 7,
    averageMinutesPerMeetingDay: meetingDays ? summary.totalMinutes / meetingDays : 0,
  };
}
