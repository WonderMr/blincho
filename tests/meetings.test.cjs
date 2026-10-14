const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-meetings-'));
const config = path.join(build, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [
  path.join(repo, 'src/utils/meetings.ts'), path.join(repo, 'src/utils/storage.ts'),
  path.join(repo, 'src/utils/historyTransfer.ts'), path.join(repo, 'src/utils/detector.ts'),
  path.join(repo, 'src/utils/notifications.ts'),
], compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true,
  rootDir: path.join(repo, 'src'), outDir: build } }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const meetings = require(path.join(build, 'utils/meetings.js'));
const storage = require(path.join(build, 'utils/storage.js'));
const { importHistorySnapshot } = require(path.join(build, 'utils/historyTransfer.js'));
const detector = require(path.join(build, 'utils/detector.js'));
const values = new Map(); let writes = 0;
global.localStorage = {
  get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
  getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); },
  removeItem: key => values.delete(key),
};
const day = (date, entries = {}) => ({ date, focusMinutes: 0, breaksCompleted: 0, exercisesCompleted: 0, ...entries });
const at = (date, hour, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
const call = (date, startHour, startMinute, endHour, endMinute, app = 'Zoom') => ({
  start: at(date, startHour, startMinute), end: at(date, endHour, endMinute), app,
});
test.after(() => fs.rmSync(build, { recursive: true, force: true }));

test('samples merge and deduplicate within each app while preserving app changes and real gaps', () => {
  const date = '2026-10-12';
  const spans = [call(date, 9, 0, 9, 15), call(date, 9, 10, 9, 30), call(date, 9, 30, 10, 0),
    call(date, 9, 0, 9, 15), call(date, 10, 0, 10, 30, 'Microsoft Teams'), call(date, 11, 0, 11, 15)];
  const result = meetings.analyzeDayMeetings(day(date, { meetings: spans }), at('2026-10-14', 12));
  assert.deepEqual(result.spans, [call(date, 9, 0, 10, 0), call(date, 10, 0, 10, 30, 'Microsoft Teams'), call(date, 11, 0, 11, 15)]);
  assert.equal(result.callCount, 3); assert.equal(result.totalMinutes, 105);
  assert.equal(result.averageCallMinutes, 35); assert.equal(result.longestCallMinutes, 60);
  assert.equal(result.firstCallAt, at(date, 9)); assert.equal(result.lastCallAt, at(date, 11, 15));
});

test('simultaneous apps retain their own time and call count while elapsed time uses the union', () => {
  const date = '2026-10-12';
  const result = meetings.analyzeDayMeetings(day(date, { meetings: [
    call(date, 9, 0, 10, 0), call(date, 9, 30, 10, 30, 'Microsoft Teams'), call(date, 9, 45, 10, 0, 'Safari'),
  ] }), at('2026-10-14', 12));
  assert.equal(result.callCount, 3); assert.equal(result.totalMinutes, 90);
  assert.equal(result.averageCallMinutes, 45); assert.equal(result.longestCallMinutes, 60);
  assert.equal(result.applications.find(app => app.app === 'Zoom').totalMinutes, 60);
  assert.equal(result.applications.find(app => app.app === 'Microsoft Teams').callCount, 1);
  assert.equal(result.applications.find(app => app.app === 'Safari').totalMinutes, 15);
});

test('one atomic progress write preserves meetings without focus and deduplicates replay after restart', () => {
  values.clear(); writes = 0;
  const date = '2026-10-12', spans = [call(date, 9, 0, 10, 0)];
  storage.recordTimerProgress([[date, 60]], [{ start: at(date, 9), end: at(date, 9, 1), state: 'work' }], spans);
  assert.equal(writes, 1);
  const persisted = localStorage.getItem('myeyes_stats_v1');
  values.clear(); localStorage.setItem('myeyes_stats_v1', persisted); writes = 0;
  storage.recordTimerProgress([], [], [...spans, call(date, 9, 30, 10, 30, 'Microsoft Teams')]);
  assert.equal(writes, 1);
  const saved = storage.loadAllStats()[0];
  assert.equal(saved.focusMinutes, 1); assert.equal(saved.activity.length, 1);
  const result = meetings.analyzeDayMeetings(saved, at('2026-10-14', 12));
  assert.equal(result.callCount, 2); assert.equal(result.totalMinutes, 90);
});

test('midnight is split into local dates and weekly analysis rejoins the same app continuation', () => {
  values.clear();
  const span = { start: at('2026-10-12', 23, 59), end: at('2026-10-13', 0, 1), app: 'Zoom' };
  storage.recordTimerProgress([], [], [span, span]);
  const saved = storage.loadAllStats();
  assert.deepEqual(saved.map(day => day.date), ['2026-10-12', '2026-10-13']);
  for (const entry of saved) {
    const result = meetings.analyzeDayMeetings(entry, at('2026-10-14', 12));
    assert.equal(result.callCount, 1); assert.equal(result.totalMinutes, 1);
  }
  const result = meetings.summarizeWeekMeetings(saved, '2026-10-14', at('2026-10-14', 12));
  assert.equal(result.callCount, 1); assert.equal(result.totalMinutes, 2);
  assert.equal(result.averageCallMinutes, 2); assert.equal(result.meetingDays, 2);
});

test('spring, autumn and skipped midnight observations retain actual elapsed duration', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Madrid';
    for (const [date, expected] of [['2026-03-29', 23 * 60], ['2026-10-25', 25 * 60]]) {
      const { dayBounds } = require(path.join(build, 'utils/activity.js'));
      const bounds = dayBounds(date);
      const span = { ...bounds, app: 'FaceTime' };
      const result = meetings.analyzeDayMeetings(day(date, { meetings: [span] }), bounds.end);
      assert.equal(result.totalMinutes, expected);
      assert.equal([...meetings.splitMeetingsByDay([span]).values()].flat().length, 1);
    }
    process.env.TZ = 'Africa/Cairo';
    const span = { start: at('2026-04-24', 23, 59), end: at('2026-04-25', 0, 1), app: 'Skype' };
    const split = meetings.splitMeetingsByDay([span]);
    assert.equal(split.size, 2);
    for (const [date, entries] of split) assert.equal(meetings.analyzeDayMeetings(day(date, { meetings: entries }), span.end).totalMinutes, 1);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('unsafe application attribution is reduced to unknown and invalid ranges cannot enter history', () => {
  const date = '2026-10-12';
  const unsafe = { ...call(date, 9, 0, 10, 0), app: 'https://private.example/team?token=secret', title: 'Private meeting title', path: '/Users/private' };
  const sanitized = meetings.normalizeMeetings([unsafe], date);
  assert.deepEqual(sanitized, [{ start: unsafe.start, end: unsafe.end, app: 'unknown' }]);
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);
  assert.deepEqual(meetings.normalizeMeetings([null, { start: 1, end: Infinity, app: 'Zoom' },
    { start: -1, end: 2, app: 'Zoom' }, { start: 1, end: 1 + 32 * 86400000, app: 'Zoom' },
    { start: '1', end: 2, app: 'Zoom' }], date), []);
  assert.deepEqual(meetings.normalizeMeetings([unsafe], '2026-02-31'), []);
  assert.equal(meetings.splitMeetingsByDay([{ start: 1, end: Number.MAX_VALUE, app: 'Zoom' }]).size, 0);
  assert.deepEqual(meetings.normalizeMeetingApplications(['zoom', 'Zoom', '/private/path']), ['Zoom', 'unknown']);
  values.clear(); localStorage.setItem('myeyes_stats_v1', JSON.stringify([day(date, { meetings: [unsafe] })]));
  storage.recordTimerProgress([[date, 60]], []);
  assert.equal(localStorage.getItem('myeyes_stats_v1').includes('Private meeting'), false);
  assert.equal(localStorage.getItem('myeyes_stats_v1').includes('private.example'), false);
});

test('legacy aggregate history has no invented meetings and history transfer preserves the optional field', () => {
  const date = '2026-10-12', legacy = day(date, { focusMinutes: 120, breaksCompleted: 4 });
  values.clear(); localStorage.setItem('myeyes_stats_v1', JSON.stringify([legacy]));
  assert.equal(storage.loadAllStats()[0].meetings, undefined);
  const result = meetings.analyzeDayMeetings(legacy, at('2026-10-14', 12));
  assert.equal(result.callCount, 0); assert.equal(result.totalMinutes, 0);
  const entries = JSON.stringify([day(date, { meetings: [call(date, 9, 0, 10, 0)] })]);
  values.clear();
  assert.equal(importHistorySnapshot(localStorage, { schemaVersion: 1, exportedAt: '2026-10-14T12:00:00Z', entries: { myeyes_stats_v1: entries } }).status, 'imported');
  assert.equal(localStorage.getItem('myeyes_stats_v1'), entries);
  assert.equal(storage.loadAllStats()[0].meetings.length, 1);
});

test('future time is clipped and the week excludes older records without inflating duplicate daily records', () => {
  const date = '2026-10-14', entry = day(date, { meetings: [call(date, 9, 0, 11, 0)] });
  assert.equal(meetings.analyzeDayMeetings(entry, at(date, 10)).totalMinutes, 60);
  const result = meetings.summarizeWeekMeetings([entry, entry, day('2026-09-01', { meetings: [call('2026-09-01', 9, 0, 17, 0)] })], date, at(date, 10));
  assert.equal(result.callCount, 1); assert.equal(result.totalMinutes, 60); assert.equal(result.meetingDays, 1);
  assert.equal(result.averageMinutesPerDay, 60 / 7); assert.equal(result.averageMinutesPerMeetingDay, 60);
  assert.equal(meetings.summarizeWeekMeetings([], date).averageMinutesPerMeetingDay, 0);
});

test('detector preserves boolean-only responses and sanitizes optional applications for active and stopped calls', async () => {
  const previous = global.window;
  try {
    global.window = { electronAPI: { checkMeetingActive: async () => ({ inMeeting: true, supported: true }) } };
    assert.deepEqual(await detector.detectActiveMeeting(), { inMeeting: true, supported: true });
    window.electronAPI.checkMeetingActive = async () => ({ inMeeting: true, applications: ['Zoom', 'private title'] });
    assert.deepEqual((await detector.detectActiveMeeting()).applications, ['Zoom', 'unknown']);
    window.electronAPI.checkMeetingActive = async () => ({ inMeeting: false, applications: ['Zoom'] });
    assert.deepEqual((await detector.detectActiveMeeting()).applications, []);
  } finally { if (previous === undefined) delete global.window; else global.window = previous; }
});

test('App persists native call samples during manual pause, preserves overlap and flushes on unmount', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts');
  fs.writeFileSync(fixture, `
    import { TimerSession } from './timerSession';
    export class NativeTimerSession extends TimerSession {
      advance(now: number) { this.lastUpdated = now; return false; }
      drainActivity() { super.drainActivity(); return []; }
    }
    export function hasNativeTimer() { return true; }
    export function readNativeTimer() { return Promise.resolve(null); }
    export function synchronizeNativeTimer() {}
    export function subscribeNativeTimer(callback: unknown) { window.testNativeFrame = callback; return () => { window.testNativeFrame = null; }; }
  `);
  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ meetingDetectionEnabled: true, strictMode: true }, false, false, at('2026-10-14', 9), { 'src/utils/tauriBridge.ts': fixture });
  let destroyed = false;
  try {
    await h.settle();
    const start = h.now;
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingSpans: [], meetingApplications: [] };
    await h.advance(5000);
    const spans = [{ start, end: h.now, app: 'Zoom' }, { start, end: h.now, app: 'Microsoft Teams' }];
    window.testNativeFrame({ ...frame, meetingSpans: spans, meetingApplications: ['Zoom', 'Microsoft Teams'] });
    await h.settle();
    assert.equal(h.stats().focusMinutes, 0);
    assert.equal(h.stats().meetings.length, 2);
    await h.call('Navbar', 'onSelectTab', 'stats');
    assert.deepEqual(Array.from(h.captured.StatisticsView.meetingApplications), ['Zoom', 'Microsoft Teams']);
    await h.advance(1000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingSpans: spans, meetingApplications: [] });
    await h.settle();
    assert.equal(h.captured.StatisticsView.meetingApplications.length, 0);
    assert.equal(h.stats().meetings.length, 2);
    window.testNativeFrame({ ...frame, tickCount: 3, meetingSpans: [{ start, end: h.now, app: 'Zoom' }], meetingApplications: ['Zoom'] });
    await h.settle();
    h.destroy(); destroyed = true;
    const saved = h.stats();
    assert.equal(saved.meetings.find(span => span.app === 'Zoom').end, start + 6000);
    assert.equal(saved.meetings.find(span => span.app === 'Microsoft Teams').end, start + 5000);
    assert.equal(saved.focusMinutes, 0);
  } finally {
    if (!destroyed) h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame;
  }
});
