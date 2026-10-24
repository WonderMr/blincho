const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('./app.test.cjs');
const repo = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-resume-race-'));
const fixture = path.join(directory, 'bridge.ts');
// Exercise the real command queue while exposing its frame callback to this harness.
fs.writeFileSync(fixture, fs.readFileSync(path.join(repo, 'src/utils/tauriBridge.ts'), 'utf8')
  .replace('frames.add(callback); return () => frames.delete(callback);',
    'window.testNativeFrame = callback; frames.add(callback); return () => { window.testNativeFrame = undefined; frames.delete(callback); };'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

for (const mode of ['expiry', 'notification-only', 'reset', 'settings']) test(`meeting suspension remains authoritative during pending ${mode} IPC`, async () => {
  const previous = window.__TAURI__;
  let tick = 10, resolvePause;
  let native = { totalMs: 1200000, remainingMs: 600000, manualPaused: false, breakActive: false,
    exercising: false, expiryPending: false, version: 0, reasons: [], absentSince: null,
    absenceEpoch: 0, idleSeconds: 0, locked: false, suspended: false, breakElapsed: false,
    focusByDate: {}, meetingResumedEpoch: 1, meetingResumeToken: 7, meetingRemindersPaused: false,
    meetingBreakCancellable: false, meetingBreakCancelledEpoch: 0 };
  window.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'configure_timer') {
      assert(args.input.version >= native.version, 'queued settings must use a current version');
      native = { ...native, ...args.input, tickCount: ++tick };
      if (!args.input.meetingEnabled) native = { ...native, meetingRemindersPaused: false, meetingResumeToken: null };
      return { ...native };
    }
    if (command === 'timer_snapshot') return { ...native, tickCount: ++tick };
    if (command === 'set_meeting_reminders_paused') {
      assert.equal(args.token, 7); assert.equal(args.paused, true);
      native = { ...native, remainingMs: native.remainingMs || 300000, expiryPending: false,
        meetingRemindersPaused: true, meetingResumeToken: 8, version: native.version + 1, tickCount: ++tick };
      const response = { ...native };
      return new Promise(resolve => { resolvePause = () => resolve(response); });
    }
  } } };
  const h = createHarness({ strictMode: mode !== 'notification-only', autoTakeoverModal: false, meetingDetectionEnabled: true, notificationsEnabled: mode === 'notification-only' }, false, false,
    1791712800000, { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture });
  try {
    await h.settle();
    native = { ...native, version: 1, remainingMs: 600000, tickCount: ++tick };
    window.testNativeFrame({ ...native }); await h.settle();
    const noticesBefore = h.notifications;
    let resolveIdle;
    if (mode === 'expiry' || mode === 'notification-only') {
      let reads = 0;
      h.desktopAPI.getSystemIdleTime = () => ++reads === 2 ? new Promise(resolve => { resolveIdle = resolve; }) : Promise.resolve(0);
      native = { ...native, remainingMs: 0, expiryPending: true, meetingWarningRequired: true, meetingWarningReady: true, tickCount: ++tick };
      window.testNativeFrame({ ...native }); await h.settle();
      assert(resolveIdle, 'expiry reached its final presence query');
    }
    const button = h.host.querySelector('[data-meeting-control]').querySelector('button');
    button[Object.keys(button).find(key => key.startsWith('__reactProps'))].onClick();
    await h.settle(); assert(resolvePause, 'native pause accepted with reply pending');
    if (mode === 'expiry' || mode === 'notification-only') {
      resolveIdle(0); await h.settle();
      assert(!h.active.has('BreakOverlay'));
      assert.equal(h.notifications, noticesBefore, 'pending pause suppresses every expiry outcome');
      assert.equal(h.captured.TimerWidget.secondsRemaining, 0, 'pending pause cannot restart a work cycle');
    }
    if (mode === 'reset') await h.call('TimerWidget', 'onReset');
    if (mode === 'settings') {
      await h.call('Navbar', 'onOpenSettings');
      await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, meetingDetectionEnabled: false });
    }
    resolvePause(); await h.settle();
    assert(!h.active.has('BreakOverlay'));
    assert.equal(native.breakActive, false);
    if (mode === 'settings') {
      assert.equal(native.meetingEnabled, false); assert.equal(native.meetingRemindersPaused, false); assert.equal(native.meetingResumeToken, null);
    } else {
      assert.equal(native.meetingRemindersPaused, true);
      if (mode === 'reset') { assert.equal(native.manualPaused, true); assert.equal(native.remainingMs, 1200000); assert.equal(native.version, 3); }
    }
  } finally {
    h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

for (const edit of ['camera', 'reset', 'pause']) test(`warning deferral preserves pending ${edit} changes`, async () => {
  const previous = window.__TAURI__;
  let tick = 10, resolveDefer, rejectModel;
  let native = { totalMs: 1200000, remainingMs: 600000, manualPaused: false, breakActive: false,
    exercising: false, expiryPending: false, version: 0, reasons: [], absentSince: null,
    absenceEpoch: 0, idleSeconds: 0, locked: false, suspended: false, breakElapsed: false,
    focusByDate: {}, meetingWarningRequired: true, meetingWarningReady: false };
  window.__TAURI__ = { core: { invoke: async (command, args) => {
    if (command === 'configure_timer') {
      assert(args.input.version >= native.version, 'settings must use the accepted native version');
      const changed = args.input.version !== native.version;
      native = { ...native, ...args.input, remainingMs: changed ? args.input.remainingMs : native.remainingMs,
        expiryPending: changed ? args.input.expiryPending : native.expiryPending, tickCount: ++tick };
      return { ...native };
    }
    if (command === 'timer_snapshot') return { ...native, tickCount: ++tick };
    if (command === 'defer_meeting_break') {
      assert.equal(args.version, 1); assert.equal(args.warningEpoch, 1); assert.equal(args.minutes, 10);
      native = { ...native, remainingMs: 600000, expiryPending: false, version: 2,
        meetingWarningEndAt: null, tickCount: ++tick };
      const response = { ...native };
      return new Promise(resolve => { resolveDefer = () => resolve(response); });
    }
  } } };
  const h = createHarness({ strictMode: true, meetingDetectionEnabled: true, cameraLockEnabled: edit === 'camera',
    notificationsEnabled: false }, false, false, 1791712800000,
    { [path.join('src', 'utils', 'tauriBridge.ts')]: fixture },
    { prepare: () => new Promise((_resolve, reject) => { rejectModel = reject; }) });
  try {
    await h.settle();
    native = { ...native, remainingMs: 0, expiryPending: true, version: 1,
      meetingWarningEpoch: 1, meetingWarningEndAt: h.now + 30000, tickCount: ++tick };
    window.testNativeFrame({ ...native }); await h.settle();
    const action = h.call('MeetingBreakWarning', 'onDefer', 10);
    await h.settle(); assert(resolveDefer, 'native accepted deferral with its reply pending');
    if (edit === 'camera') { assert(rejectModel); rejectModel(Error('offline')); await h.settle(); }
    if (edit === 'reset') await h.call('TimerWidget', 'onReset');
    if (edit === 'pause') await h.call('TimerWidget', 'onTogglePlay');
    resolveDefer(); await action; await h.settle();
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.warnings.some(args => args.some(value => String(value).includes('settings must use'))), false);
    if (edit === 'camera') {
      assert.equal(JSON.parse(h.store.get('myeyes_settings_v1')).cameraLockEnabled, false);
      assert.equal(native.cameraLockEnabled, false);
      assert.equal(native.remainingMs, 600000, 'settings rollback preserves the native deferral');
    } else {
      assert.equal(native.manualPaused, true);
      if (edit === 'reset') assert.equal(native.remainingMs, 1200000);
    }
  } finally {
    h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});
