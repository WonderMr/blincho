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
  path.join(repo, 'src/utils/tauriBridge.ts'),
], compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true,
  rootDir: path.join(repo, 'src'), outDir: build } }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const meetings = require(path.join(build, 'utils/meetings.js'));
const storage = require(path.join(build, 'utils/storage.js'));
const { importHistorySnapshot } = require(path.join(build, 'utils/historyTransfer.js'));
const detector = require(path.join(build, 'utils/detector.js'));
const bridge = require(path.join(build, 'utils/tauriBridge.js'));
const { normalizeTimerSettings } = require(path.join(build, 'utils/timerSession.js'));
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
const nativeFixture = path.join(build, 'native-meeting-bridge.ts');
fs.writeFileSync(nativeFixture, `
    import { TimerSession } from './timerSession';
    export class NativeTimerSession extends TimerSession {
      advance(now: number) { this.lastUpdated = now; return false; }
      drainActivity() { super.drainActivity(); return []; }
    }
    export function deferNativeMeetingBreak(version: number, warningEpoch: number, minutes: number | null) {
      return window.testDeferMeetingBreak(version, warningEpoch, minutes);
    }
    export function setNativeMeetingRemindersPaused(token: number, paused: boolean) { return window.testSetMeetingRemindersPaused(token, paused); }
    export function hasNativeTimer() { return true; }
    export function readNativeTimer() { return window.testReadNativeTimer ? window.testReadNativeTimer() : Promise.resolve(null); }
    let commandQueue = Promise.resolve();
    let historyEnabled: boolean | undefined;
    let historyEpoch = 0;
    export function synchronizeNativeTimer(_session: unknown, settings: { meetingHistoryEnabled: boolean }, onConfigured?: (snapshot: unknown) => void) {
      const enabled = settings.meetingHistoryEnabled;
      commandQueue = commandQueue.then(async () => {
        if (historyEnabled !== undefined && historyEnabled !== enabled) historyEpoch++;
        historyEnabled = enabled;
        const snapshot = window.testConfigureTimer ? await window.testConfigureTimer(enabled) : { meetingHistoryEpoch: historyEpoch };
        onConfigured?.(snapshot);
      }).catch(() => {});
    }
    export function clearNativeMeetingHistory() {
      const cleared = commandQueue.then(() => window.testClearMeetingHistory());
      commandQueue = cleared.then(() => {}).catch(() => {});
      return cleared;
    }
    export function subscribeNativeTimer(callback: unknown) { window.testNativeFrame = callback; return () => { window.testNativeFrame = null; }; }
  `);
test.after(() => fs.rmSync(build, { recursive: true, force: true }));

test('new and legacy profiles require explicit call-history consent independently of postponement', () => {
  values.clear();
  assert.equal(storage.DEFAULT_SETTINGS.meetingHistoryEnabled, false);
  assert.equal(storage.loadSettings().meetingHistoryEnabled, false);
  localStorage.setItem('myeyes_settings_v1', JSON.stringify({ meetingDetectionEnabled: true }));
  assert.equal(storage.loadSettings().meetingDetectionEnabled, true);
  assert.equal(storage.loadSettings().meetingHistoryEnabled, false);
  for (const invalid of [undefined, null, 1, 'true']) {
    assert.equal(normalizeTimerSettings({ ...storage.DEFAULT_SETTINGS, meetingHistoryEnabled: invalid }).meetingHistoryEnabled, false);
  }
  const explicit = normalizeTimerSettings({ ...storage.DEFAULT_SETTINGS, meetingDetectionEnabled: false, meetingHistoryEnabled: true });
  assert.equal(explicit.meetingHistoryEnabled, true);
  assert.equal(explicit.meetingDetectionEnabled, false);
  storage.saveSettings(explicit);
  assert.equal(storage.loadSettings().meetingHistoryEnabled, true);
});

test('clearing removes only call fields and honestly returns parsing or storage failures', () => {
  values.clear();
  const other = day('2026-10-12', { meetings: [call('2026-10-12', 9, 0, 10, 0)], focusMinutes: 3,
    breaksCompleted: 2, exercisesCompleted: 1, activity: [{ start: 1, end: 2, state: 'work' }],
    completedEventIds: ['kept'], techniqueCounts: { kept: 1 }, customField: 'preserved' });
  localStorage.setItem('myeyes_stats_v1', JSON.stringify([other]));
  localStorage.setItem('myeyes_cvs_result_v1', 'preserved');
  assert.equal(storage.clearMeetingHistory(), true);
  const { meetings: _discarded, ...expected } = other;
  assert.deepEqual(JSON.parse(localStorage.getItem('myeyes_stats_v1')), [expected]);
  assert.equal(localStorage.getItem('myeyes_cvs_result_v1'), 'preserved');
  localStorage.setItem('myeyes_stats_v1', 'invalid');
  assert.equal(storage.clearMeetingHistory(), false);
  assert.equal(localStorage.getItem('myeyes_stats_v1'), 'invalid');
  localStorage.setItem('myeyes_stats_v1', JSON.stringify([other]));
  const setItem = localStorage.setItem;
  localStorage.setItem = () => { throw Error('quota fixture'); };
  try { assert.equal(storage.clearMeetingHistory(), false); }
  finally { localStorage.setItem = setItem; }
  assert.deepEqual(JSON.parse(localStorage.getItem('myeyes_stats_v1')), [other]);
});

test('bridge sends independent history consent and queues native clear after settings', async () => {
  const previous = global.window, commands = [], acknowledgements = [];
  const snapshot = { tickCount: 10, meetingHistoryEpoch: 1, meetingSpans: [] };
  global.window = { __TAURI__: { core: { invoke: async (name, args) => { commands.push({ name, args }); return snapshot; } } } };
  try {
    const { TimerSession } = require(path.join(build, 'utils/timerSession.js'));
    bridge.synchronizeNativeTimer(new TimerSession(1200, Date.now()), { ...storage.DEFAULT_SETTINGS,
      meetingDetectionEnabled: false, meetingHistoryEnabled: true }, value => acknowledgements.push(value));
    assert.deepEqual(await bridge.clearNativeMeetingHistory(), snapshot);
    assert.deepEqual(acknowledgements, [snapshot], 'successful configure acknowledges its returned snapshot');
    assert.deepEqual(commands.map(command => command.name), ['configure_timer', 'clear_meeting_history']);
    assert.equal(commands[0].args.input.meetingEnabled, false);
    assert.equal(commands[0].args.input.meetingHistoryEnabled, true);
    window.__TAURI__.core.invoke = async () => { throw Error('native clear fixture'); };
    bridge.synchronizeNativeTimer(new TimerSession(1200, Date.now()), storage.DEFAULT_SETTINGS, value => acknowledgements.push(value));
    await assert.rejects(bridge.clearNativeMeetingHistory(), /native clear fixture/);
    assert.deepEqual(acknowledgements, [snapshot], 'rejected configure cannot acknowledge consent');
  } finally { global.window = previous; }
});

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

test('Vivaldi call attribution survives normalization without retaining private titles', () => {
  assert.deepEqual(meetings.normalizeMeetingApplications(['Vivaldi', 'vivaldi', 'Vivaldi private lesson']), ['Vivaldi', 'unknown']);
  const date = '2026-10-12';
  const span = { ...call(date, 9, 0, 10, 0), app: 'Vivaldi', title: 'Private Preply lesson' };
  assert.deepEqual(meetings.normalizeMeetings([span], date), [{ start: span.start, end: span.end, app: 'Vivaldi' }]);
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
    global.window = { desktopAPI: { checkMeetingActive: async () => ({ inMeeting: true, supported: true }) } };
    assert.deepEqual(await detector.detectActiveMeeting(), { inMeeting: true, supported: true });
    window.desktopAPI.checkMeetingActive = async () => ({ inMeeting: true, applications: ['Zoom', 'private title'] });
    assert.deepEqual((await detector.detectActiveMeeting()).applications, ['Zoom', 'unknown']);
    window.desktopAPI.checkMeetingActive = async () => ({ inMeeting: false, applications: ['Zoom'] });
    assert.deepEqual((await detector.detectActiveMeeting()).applications, []);
  } finally { if (previous === undefined) delete global.window; else global.window = previous; }
});

test('native media resumption announces once per epoch and respects notification settings and manual pause', async () => {
  const { createHarness } = require('./app.test.cjs');
  for (const enabled of [true, false]) {
    const previous = window.__TAURI__;
    window.__TAURI__ = { core: { invoke: async () => undefined } };
    const h = createHarness({ meetingDetectionEnabled: true, notificationsEnabled: enabled }, false, false,
      at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
    try {
      await h.settle();
      const frame = { totalMs: 1200000, remainingMs: 600000, manualPaused: true, breakActive: false, exercising: false,
        expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
        suspended: false, breakElapsed: false, focusByDate: {}, meetingResumedEpoch: 1 };
      window.testNativeFrame({ ...frame, tickCount: 1 });
      await h.settle();
      assert.equal(h.notifications, enabled ? 1 : 0);
      assert.equal(h.captured.TimerWidget.phase, 'manual');
      assert.equal(h.captured.TimerWidget.secondsRemaining, 600);
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.match(h.host.textContent, /Камера и микрофон не используются 5 минут/);
      window.testNativeFrame({ ...frame, tickCount: 2 });
      await h.settle();
      assert.equal(h.notifications, enabled ? 1 : 0, 'repeated frames cannot notify twice');
      window.testNativeFrame({ ...frame, tickCount: 3, meetingResumedEpoch: 2 });
      await h.settle();
      assert.equal(h.notifications, enabled ? 2 : 0, 'a new inactive episode can notify again');
    } finally {
      h.destroy();
      if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
      delete window.testNativeFrame;
    }
  }
});

test('renderer expiry leaves meeting postponement and notification ownership with the native timer', async () => {
  const { createHarness } = require('./app.test.cjs');
  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ meetingDetectionEnabled: true }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
  try {
    await h.settle();
    let probes = 0;
    h.desktopAPI.checkMeetingActive = async () => { probes++; return { inMeeting: true, supported: true }; };
    const frame = { totalMs: 1200000, remainingMs: 0, manualPaused: false, breakActive: false, exercising: false,
      expiryPending: true, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {} };
    window.testNativeFrame({ ...frame, tickCount: 1 });
    await h.settle();
    assert.equal(probes, 1, 'renderer reached meeting expiry before the heartbeat');
    assert.equal(h.captured.TimerWidget.secondsRemaining, 0, 'renderer must not invent its own postponement');
    assert.equal(h.notifications, 0);
    window.testNativeFrame({ ...frame, tickCount: 2, remainingMs: 300000, expiryPending: false, version: 2, meetingPostponedEpoch: 1 });
    await h.settle();
    assert.equal(h.notifications, 1);
    window.testNativeFrame({ ...frame, tickCount: 3, version: 3, meetingPostponedEpoch: 1, meetingResumedEpoch: 1 });
    await h.settle();
    assert.equal(h.captured.TimerWidget.secondsRemaining, 0, 'the already due break is reclaimed at resumption');
    assert.equal(h.notifications, 2, 'one postponement notice and one resumption notice');
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame;
  }
});

test('strict meeting warning appears before takeover and dispatches versioned duration or until-end actions', async () => {
  const { createHarness } = require('./app.test.cjs');
  for (const minutes of [5, 10, 15, null]) {
    const previous = window.__TAURI__;
    window.__TAURI__ = { core: { invoke: async () => undefined } };
    const h = createHarness({ strictMode: true, meetingDetectionEnabled: true }, false, false,
      at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
    try {
      await h.settle();
      await h.call('Navbar', 'onOpenSettings');
      assert.equal(h.active.has('SettingsModal'), true);
      const frame = { totalMs: 1200000, remainingMs: 0, manualPaused: false, breakActive: false, exercising: false,
        expiryPending: true, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
        suspended: false, breakElapsed: false, focusByDate: {}, meetingWarningRequired: true,
        meetingWarningReady: false, meetingWarningEndAt: h.now + 30000, meetingWarningEpoch: 1 };
      window.testNativeFrame({ ...frame, tickCount: 1 });
      await h.settle();
      assert.equal(h.active.has('MeetingBreakWarning'), true);
      assert.equal(h.active.has('SettingsModal'), false, 'warning exclusively owns modal focus');
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.equal(h.notifications, 1);
      window.testNativeFrame({ ...frame, tickCount: 2 });
      await h.settle();
      assert.equal(h.notifications, 1, 'warning alert is deduplicated');
      const calls = [];
      window.testDeferMeetingBreak = async (...args) => {
        calls.push(args);
        return { ...frame, tickCount: 3, version: 2, expiryPending: false, remainingMs: (minutes ?? 5) * 60000,
          meetingWarningEndAt: null, meetingRemindersPaused: minutes === null, meetingResumeToken: minutes === null ? 9 : null };
      };
      await h.call('MeetingBreakWarning', 'onDefer', minutes);
      assert.deepEqual(calls, [[1, 1, minutes]]);
      assert.equal(h.active.has('MeetingBreakWarning'), false);
      assert.equal(h.active.has('SettingsModal'), true, 'settings return after the warning action');
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.equal(h.captured.TimerWidget.secondsRemaining, (minutes ?? 5) * 60);
      if (minutes === null) assert.match(h.host.textContent, /Напоминания приостановлены до конца встречи/);
    } finally {
      h.destroy();
      if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
      delete window.testNativeFrame; delete window.testDeferMeetingBreak;
    }
  }
});

test('native snapshot expiry gate blocks takeover during warning and permits it only after native completion', async () => {
  const { createHarness } = require('./app.test.cjs');
  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ strictMode: true, meetingDetectionEnabled: true }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
  try {
    await h.settle();
    let tick = 1;
    let current = { totalMs: 1200000, remainingMs: 0, manualPaused: false, breakActive: false, exercising: false,
      expiryPending: true, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, meetingWarningRequired: true,
      meetingWarningReady: false, meetingWarningEndAt: h.now + 30000, meetingWarningEpoch: 1 };
    window.testReadNativeTimer = async () => ({ ...current, tickCount: ++tick });
    window.testNativeFrame({ ...current, tickCount: tick });
    await h.settle();
    assert(tick > 1, 'expiry consumed a native snapshot rather than the null fallback');
    assert.equal(h.active.has('MeetingBreakWarning'), true);
    assert.equal(h.active.has('BreakOverlay'), false, 'pending native warning prevents fullscreen');
    current = { ...current, meetingWarningReady: true, meetingWarningEndAt: null };
    window.testNativeFrame({ ...current, tickCount: ++tick });
    await h.settle();
    assert.equal(h.active.has('MeetingBreakWarning'), false);
    assert.equal(h.active.has('BreakOverlay'), true, 'ready native warning allows the strict break');
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testReadNativeTimer;
  }
});

test('resumption control stays available during a muted meeting, including without strict mode', async () => {
  const { createHarness } = require('./app.test.cjs');
  for (const strictMode of [false, true]) {
    const previous = window.__TAURI__;
    window.__TAURI__ = { core: { invoke: async () => undefined } };
    const h = createHarness({ strictMode, meetingDetectionEnabled: true, notificationsEnabled: false }, false, false,
      at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
    try {
      await h.settle();
      const frame = { totalMs: 1200000, remainingMs: 600000, manualPaused: true, breakActive: false, exercising: false,
        expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
        suspended: false, breakElapsed: false, focusByDate: {}, meetingResumedEpoch: 1, meetingResumeToken: 7,
        liveMeetingStatus: { inMeeting: false, supported: true, applications: [] } };
      window.testNativeFrame({ ...frame, tickCount: 1 });
      await h.settle();
      const panel = () => h.host.querySelector('[data-meeting-control]');
      assert(panel(), 'control exists before the work deadline');
      await h.advance(20000);
      assert(panel(), 'control outlives transient notifications');
      const calls = [];
      window.testSetMeetingRemindersPaused = async (token, paused) => {
        calls.push([token, paused]);
        return { ...frame, tickCount: paused ? 2 : 4, version: paused ? 2 : 3,
          meetingRemindersPaused: paused, meetingResumeToken: paused ? 8 : null };
      };
      { const button = panel().querySelector('button'); button[Object.keys(button).find(key => key.startsWith('__reactProps'))].onClick(); } await h.settle();
      assert.deepEqual(calls, [[7, true]]);
      assert.equal(h.captured.TimerWidget.phase, 'manual');
      assert.match(panel().textContent, /Вернуть напоминания/);
      window.testNativeFrame({ ...frame, tickCount: 3, version: 2, meetingRemindersPaused: true, meetingResumeToken: 8 });
      await h.settle();
      { const button = panel().querySelector('button'); button[Object.keys(button).find(key => key.startsWith('__reactProps'))].onClick(); } await h.settle();
      assert.deepEqual(calls, [[7, true], [8, false]]);
      assert.equal(panel(), null);
      assert.equal(h.active.has('BreakOverlay'), false);
    } finally {
      h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
      delete window.testNativeFrame; delete window.testSetMeetingRemindersPaused;
    }
  }
});

test('meeting undo cancels a begun strict break without completion credit or keeping its shields', async () => {
  const { createHarness } = require('./app.test.cjs');
  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ strictMode: true, meetingDetectionEnabled: true }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
  try {
    await h.settle();
    const strictCommands = []; h.desktopAPI.setStrictLock = enabled => strictCommands.push(enabled);
    let tick = 0;
    let current = { totalMs: 1200000, remainingMs: 0, manualPaused: false, breakActive: false, exercising: false,
      expiryPending: true, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, meetingResumedEpoch: 1, meetingResumeToken: 7,
      meetingWarningRequired: true, meetingWarningReady: true, meetingBreakCancelledEpoch: 0 };
    window.testReadNativeTimer = async () => ({ ...current, tickCount: ++tick });
    window.testNativeFrame({ ...current, tickCount: ++tick }); await h.settle();
    assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(h.captured.BreakOverlay.onPauseMeeting, undefined, 'requires native association, not just a stale token');
    current = { ...current, version: 2, expiryPending: false, breakActive: true, meetingBreakCancellable: true };
    window.testNativeFrame({ ...current, tickCount: ++tick }); await h.settle();
    assert.equal(typeof h.captured.BreakOverlay.onPauseMeeting, 'function');
    window.testSetMeetingRemindersPaused = async (token, paused) => {
      assert.equal(token, 7); assert.equal(paused, true);
      current = { ...current, version: 3, breakActive: false, remainingMs: 300000,
        meetingBreakCancelledEpoch: 1, meetingBreakCancellable: false, meetingRemindersPaused: true, meetingResumeToken: 8 };
      return { ...current, tickCount: ++tick };
    };
    await h.call('BreakOverlay', 'onPauseMeeting');
    assert.equal(h.active.has('BreakOverlay'), false);
    assert(h.host.querySelector('[data-meeting-control]'));
    assert.equal(h.captured.TimerWidget.secondsRemaining, 300);
    await h.advance(30000);
    assert.equal(h.stats().breaksCompleted, 0, 'cancelled break never receives a completion record');
    assert(strictCommands.includes(false), 'native presentation is released');
  } finally {
    h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testReadNativeTimer; delete window.testSetMeetingRemindersPaused;
  }
});

test('meeting end clears temporary controls, restores running reminders once and preserves manual pause', async () => {
  const { createHarness } = require('./app.test.cjs');
  for (const manualPaused of [false, true]) for (const enabled of [false, true]) {
    const previous = window.__TAURI__; window.__TAURI__ = { core: { invoke: async () => undefined } };
    const h = createHarness({ strictMode: true, meetingDetectionEnabled: true, notificationsEnabled: enabled }, false, false,
      at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
    try {
      await h.settle();
      const frame = { totalMs: 1200000, remainingMs: 600000, manualPaused, breakActive: false, exercising: false,
        expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
        suspended: false, breakElapsed: false, focusByDate: {}, meetingResumeToken: 8, meetingRemindersPaused: true,
        meetingPauseEndedEpoch: 0, liveMeetingStatus: { inMeeting: true, supported: true, applications: ['Zoom'] } };
      window.testNativeFrame({ ...frame, tickCount: 1 }); await h.settle();
      assert(h.host.querySelector('[data-meeting-control]'));
      const ended = { ...frame, tickCount: 2, version: 2, meetingResumeToken: null, meetingRemindersPaused: false,
        meetingPauseEndedEpoch: 1, liveMeetingStatus: { inMeeting: false, supported: true, applications: [] } };
      window.testNativeFrame(ended); await h.settle();
      assert.equal(h.host.querySelector('[data-meeting-control]'), null);
      assert.equal(h.captured.TimerWidget.phase, manualPaused ? 'manual' : 'work');
      assert.equal(h.notifications, !manualPaused && enabled ? 1 : 0);
      if (!manualPaused) assert.match(h.host.textContent, /Встреча завершена.*возобновлены/);
      window.testNativeFrame({ ...ended, tickCount: 3 }); await h.settle();
      window.testNativeFrame({ ...frame, tickCount: 2 }); await h.settle();
      assert.equal(h.host.querySelector('[data-meeting-control]'), null, 'late pause response cannot restore an ended meeting');
      assert.equal(h.notifications, !manualPaused && enabled ? 1 : 0);
      assert.equal(h.active.has('BreakOverlay'), false);
    } finally {
      h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
      delete window.testNativeFrame;
    }
  }
});

test('a delayed until-end warning reply cannot replace the newer automatic restoration notice', async () => {
  const { createHarness } = require('./app.test.cjs');
  const previous = window.__TAURI__; window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ strictMode: true, meetingDetectionEnabled: true, notificationsEnabled: false }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: nativeFixture });
  try {
    await h.settle();
    const frame = { totalMs: 1200000, remainingMs: 0, manualPaused: false, breakActive: false, exercising: false,
      expiryPending: true, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, meetingWarningRequired: true, meetingWarningReady: false,
      meetingWarningEndAt: h.now + 30000, meetingWarningEpoch: 1, tickCount: 1 };
    window.testNativeFrame(frame); await h.settle();
    let resolve;
    window.testDeferMeetingBreak = () => new Promise(done => { resolve = done; });
    const pending = h.call('MeetingBreakWarning', 'onDefer', null); await h.settle();
    window.testNativeFrame({ ...frame, remainingMs: 300000, expiryPending: false, version: 3, tickCount: 3,
      meetingWarningRequired: false, meetingWarningEndAt: null, meetingPauseEndedEpoch: 1,
      meetingResumeToken: null, meetingRemindersPaused: false }); await h.settle();
    resolve({ ...frame, remainingMs: 300000, expiryPending: false, version: 2, tickCount: 2,
      meetingWarningEndAt: null, meetingResumeToken: 8, meetingRemindersPaused: true }); await pending;
    assert.match(h.host.textContent, /Встреча завершена.*возобновлены/);
    assert.doesNotMatch(h.host.textContent, /Напоминания приостановлены до конца встречи/);
    assert.equal(h.host.querySelector('[data-meeting-control]'), null);
  } finally {
    h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testDeferMeetingBreak;
  }
});

test('App persists native call samples during manual pause, preserves overlap and flushes on unmount', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts');

  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ meetingDetectionEnabled: false, meetingHistoryEnabled: true, strictMode: true }, false, false, at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  let destroyed = false;
  try {
    await h.settle();
    assert.equal(typeof window.testNativeFrame, 'function', 'The native fixture is loaded using the platform path separator');
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

test('App consent boundaries discard pending samples, reject old epochs and never backfill cumulative calls', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts');
  const previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ meetingHistoryEnabled: true, meetingDetectionEnabled: false }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  try {
    await h.settle();
    const start = h.now;
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 0, meetingApplications: ['Zoom'] };
    await h.advance(1000);
    window.testNativeFrame({ ...frame, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] });
    await h.settle();
    assert.equal(h.stats().meetings, undefined, 'short manually paused sample is still pending');
    await h.call('Navbar', 'onSelectTab', 'stats');
    await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(false); await h.settle();
    await h.advance(5000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingHistoryEpoch: 1, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] });
    await h.settle();
    assert.equal(h.stats().meetings, undefined, 'opt-out discards pending samples');
    const enabledAt = h.now;
    h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(true); await h.settle();
    await h.advance(5000);
    window.testNativeFrame({ ...frame, tickCount: 3, meetingHistoryEpoch: 1, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] });
    await h.settle();
    assert.equal(h.stats().meetings, undefined, 'delayed old epoch cannot restore samples');
    window.testNativeFrame({ ...frame, tickCount: 4, meetingHistoryEpoch: 2, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] });
    await h.settle();
    assert.equal(h.stats().meetings[0].start, enabledAt, 'cumulative samples are clipped to fresh opt-in');
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.enabled, true);
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.supported, true);
    await h.call('Navbar', 'onOpenSettings');
    assert.equal(h.captured.SettingsModal.settings.meetingDetectionEnabled, false, 'recording does not enable postponement');
  } finally { h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous; delete window.testNativeFrame; }
});

for (const acknowledgeReenable of [false, true]) test(`App rollback cannot restore discarded calls from delayed off frames ${acknowledgeReenable ? 'after' : 'before'} re-enable acknowledgement`, async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts'), previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  let enabled = true, epoch = 0;
  const pending = [];
  window.testConfigureTimer = consent => {
    if (consent === enabled) return Promise.resolve({ meetingHistoryEpoch: epoch });
    enabled = consent; epoch++;
    return new Promise(resolve => pending.push({ enabled: consent, epoch, resolve }));
  };
  const h = createHarness({ meetingHistoryEnabled: true, meetingDetectionEnabled: false }, false, false,
    at('2026-10-14', 9), { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  let destroyed = false;
  try {
    await h.settle();
    const start = h.now;
    const preserved = [{ start: start - 60000, end: start - 30000, app: 'Microsoft Teams' }];
    h.store.set('myeyes_stats_v1', JSON.stringify([day('2026-10-14', { meetings: preserved, focusMinutes: 3 })]));
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 0, meetingApplications: ['Zoom'] };
    await h.advance(1000);
    const discarded = [{ start, end: h.now, app: 'Zoom' }];
    window.testNativeFrame({ ...frame, meetingSpans: discarded }); await h.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(h.stats().meetings)), preserved, 'short sample remains pending alongside existing history');
    await h.call('Navbar', 'onSelectTab', 'stats');
    await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(false); await h.settle();
    assert.equal(pending[0].enabled, false, 'native off configuration remains in flight');
    await h.shiftWall(-10000);
    await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(true); await h.settle();
    window.testNativeFrame({ ...frame, tickCount: 2, meetingHistoryEpoch: 1, meetingSpans: discarded }); await h.settle();
    if (acknowledgeReenable) {
      pending.shift().resolve({ ...frame, tickCount: 2, meetingHistoryEpoch: 1, meetingSpans: discarded }); await h.settle();
      assert.equal(pending[0].enabled, true, 're-enable waits behind native opt-out');
      const reenabled = { ...frame, tickCount: 3, meetingHistoryEpoch: 2, meetingSpans: [], meetingApplications: [] };
      pending.shift().resolve(reenabled); await h.settle();
      window.testNativeFrame(reenabled); await h.settle();
    }
    h.destroy(); destroyed = true;
    assert.deepEqual(JSON.parse(JSON.stringify(h.stats().meetings)), preserved,
      acknowledgeReenable ? 'acknowledged fresh native epoch cannot preserve a discarded delayed frame on unmount' : 'unacknowledged re-enable cannot persist a delayed off frame on unmount');
  } finally {
    if (!destroyed) h.destroy();
    window.testConfigureTimer = () => Promise.resolve({ meetingHistoryEpoch: epoch, meetingSpans: [] });
    for (const request of pending) request.resolve({ meetingHistoryEpoch: request.epoch, meetingSpans: [] });
    await h.settle();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testConfigureTimer;
  }
});

test('App rejects configure acknowledgement from an earlier consent generation and waits for the current one', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts'), previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  let enabled = true, epoch = 0;
  const pending = [];
  window.testConfigureTimer = consent => {
    if (consent === enabled) return Promise.resolve({ meetingHistoryEpoch: epoch });
    enabled = consent; epoch++;
    return new Promise(resolve => pending.push({ enabled: consent, epoch, resolve }));
  };
  const h = createHarness({ meetingHistoryEnabled: true }, false, false, at('2026-10-14', 9),
    { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  let destroyed = false;
  try {
    await h.settle();
    await h.call('Navbar', 'onSelectTab', 'stats');
    const toggle = async value => { await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(value); await h.settle(); };
    await toggle(false); await toggle(true);
    pending.shift().resolve({ meetingHistoryEpoch: 1 }); await h.settle();
    assert.equal(pending[0].epoch, 2);
    await toggle(false); await toggle(true);
    pending.shift().resolve({ meetingHistoryEpoch: 2 }); await h.settle();
    assert.equal(pending[0].epoch, 3, 'latest opt-out is still pending');
    const start = h.now;
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 2, meetingApplications: ['Zoom'] };
    await h.advance(1000);
    window.testNativeFrame({ ...frame, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] }); await h.settle();
    pending.shift().resolve({ meetingHistoryEpoch: 3 }); await h.settle();
    assert.equal(pending[0].epoch, 4);
    pending.shift().resolve({ meetingHistoryEpoch: 4 }); await h.settle();
    const freshStart = h.now;
    await h.advance(1000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingHistoryEpoch: 4,
      meetingSpans: [{ start: freshStart, end: h.now, app: 'Zoom' }] }); await h.settle();
    h.destroy(); destroyed = true;
    assert.equal(h.stats().meetings[0].start, freshStart, 'only the current-generation acknowledged sample is persisted');
  } finally {
    if (!destroyed) h.destroy();
    for (const request of pending) request.resolve({ meetingHistoryEpoch: request.epoch });
    await h.settle();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testConfigureTimer;
  }
});

test('App cannot record calls after configure failure until the current consent is acknowledged', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts'), previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  window.testConfigureTimer = async () => { throw Error('configure fixture'); };
  const h = createHarness({ meetingHistoryEnabled: true }, false, false, at('2026-10-14', 9),
    { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  let destroyed = false;
  try {
    await h.settle();
    const start = h.now;
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 0, meetingApplications: ['Zoom'] };
    await h.advance(1000);
    window.testNativeFrame({ ...frame, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] }); await h.settle();
    await h.call('Navbar', 'onSelectTab', 'stats');
    window.testConfigureTimer = async () => ({ meetingHistoryEpoch: 0 });
    await h.call('TimerWidget', 'onTogglePlay');
    const freshStart = h.now;
    await h.advance(1000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingSpans: [{ start: freshStart, end: h.now, app: 'Zoom' }] }); await h.settle();
    h.destroy(); destroyed = true;
    assert.equal(h.stats().meetings[0].start, freshStart, 'failed configuration never unlocks recording');
  } finally {
    if (!destroyed) h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testConfigureTimer;
  }
});

test('App clear queued behind current consent acknowledgement preserves the clear boundary and resumes recording', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts'), previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  let enabled = true, epoch = 0, resolveClear, clearCalls = 0;
  const pending = [];
  window.testConfigureTimer = consent => {
    if (consent === enabled) return Promise.resolve({ meetingHistoryEpoch: epoch });
    enabled = consent; epoch++;
    return new Promise(resolve => pending.push({ epoch, resolve }));
  };
  window.testClearMeetingHistory = () => { clearCalls++; return new Promise(resolve => { resolveClear = resolve; }); };
  const h = createHarness({ meetingHistoryEnabled: true }, false, false, at('2026-10-14', 9),
    { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  let destroyed = false;
  try {
    await h.settle();
    await h.call('Navbar', 'onSelectTab', 'stats');
    await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(false); await h.settle();
    pending.shift().resolve({ meetingHistoryEpoch: 1 }); await h.settle();
    await h.captured.StatisticsView.meetingHistoryControls.onEnabledChange(true); await h.settle();
    assert.equal(pending[0].epoch, 2);
    const deleting = h.captured.StatisticsView.meetingHistoryControls.onDelete(); await h.settle();
    assert.equal(clearCalls, 0, 'clear waits for the current consent configuration');
    pending.shift().resolve({ meetingHistoryEpoch: 2 }); await h.settle();
    assert.equal(clearCalls, 1, 'matching configure acknowledgement arrives while clearing');
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 3,
      meetingSpans: [], meetingApplications: [] };
    epoch = 3;
    resolveClear(frame); await deleting; await h.settle();
    const start = h.now;
    await h.advance(1000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingHistoryEpoch: 2,
      meetingSpans: [{ start, end: h.now, app: 'Microsoft Teams' }] }); await h.settle();
    window.testNativeFrame({ ...frame, tickCount: 3,
      meetingSpans: [{ start, end: h.now, app: 'Zoom' }] }); await h.settle();
    h.destroy(); destroyed = true;
    assert.equal(h.stats().meetings.length, 1);
    assert.equal(h.stats().meetings[0].app, 'Zoom', 'clear epoch rejects older frames and recording resumes');
  } finally {
    if (!destroyed) h.destroy();
    for (const request of pending) request.resolve({ meetingHistoryEpoch: request.epoch });
    await h.settle();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testConfigureTimer; delete window.testClearMeetingHistory;
  }
});

test('App native clear precedes local deletion, rejects stale frames and exposes failures without losing other statistics', async () => {
  const { createHarness } = require('./app.test.cjs');
  const fixture = path.join(build, 'native-meeting-bridge.ts'), previous = window.__TAURI__;
  window.__TAURI__ = { core: { invoke: async () => undefined } };
  const h = createHarness({ meetingHistoryEnabled: true }, false, false, at('2026-10-14', 9),
    { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  try {
    await h.settle();
    const start = h.now;
    const frame = { totalMs: 1200000, remainingMs: 1200000, manualPaused: true, breakActive: false, exercising: false,
      expiryPending: false, version: 1, reasons: [], absentSince: null, absenceEpoch: 0, idleSeconds: 0, locked: false,
      suspended: false, breakElapsed: false, focusByDate: {}, tickCount: 1, meetingHistoryEpoch: 0,
      meetingApplications: ['Zoom'] };
    await h.advance(5000);
    const oldSpans = [{ start, end: h.now, app: 'Zoom' }];
    window.testNativeFrame({ ...frame, meetingSpans: oldSpans, activitySpans: [{ start, end: h.now, state: 'manual' }] }); await h.settle();
    await h.call('Navbar', 'onSelectTab', 'stats');
    const persisted = h.store.get('myeyes_stats_v1');
    window.testClearMeetingHistory = async () => { throw Error('clear IPC fixture'); };
    await h.captured.StatisticsView.meetingHistoryControls.onDelete(); await h.settle();
    assert.equal(h.store.get('myeyes_stats_v1'), persisted, 'native clear failure does not delete local history');
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.feedback, 'failed');
    let resolveClear;
    window.testClearMeetingHistory = () => new Promise(resolve => { resolveClear = resolve; });
    const deleting = h.captured.StatisticsView.meetingHistoryControls.onDelete(); await h.settle();
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.pending, true);
    assert.equal(h.store.get('myeyes_stats_v1'), persisted, 'local deletion waits for native invalidation');
    await h.advance(1000);
    window.testNativeFrame({ ...frame, tickCount: 2, meetingSpans: [{ start, end: h.now, app: 'Zoom' }] }); await h.settle();
    resolveClear({ ...frame, tickCount: 3, meetingHistoryEpoch: 1, meetingSpans: [], meetingApplications: [] });
    await deleting; await h.settle();
    assert.equal(h.stats().meetings, undefined);
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.feedback, 'deleted');
    assert.equal(h.captured.StatisticsView.meetingHistoryControls.enabled, true, 'deletion preserves consent setting');
    const cleared = h.store.get('myeyes_stats_v1');
    window.testNativeFrame({ ...frame, tickCount: 2, meetingSpans: oldSpans }); await h.settle();
    window.testNativeFrame({ ...frame, tickCount: 4, meetingSpans: oldSpans }); await h.settle();
    assert.equal(h.store.get('myeyes_stats_v1'), cleared, 'old frame or replay cannot restore deleted calls');
    assert.equal(h.captured.StatisticsView.meetingApplications.length, 0);
    assert.equal(h.stats().focusMinutes, 0);
    assert(h.stats().activity?.length > 0, 'other timer history remains');
    await h.advance(5000);
    window.testNativeFrame({ ...frame, tickCount: 5, meetingHistoryEpoch: 1,
      meetingSpans: [{ start: h.now - 5000, end: h.now, app: 'Zoom' }] }); await h.settle();
    assert.equal(h.stats().meetings[0].start, h.now - 5000, 'fresh call observation resumes after clear');
  } finally { h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    delete window.testNativeFrame; delete window.testClearMeetingHistory; }
});
