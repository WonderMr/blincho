const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('./app.test.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-sync-app-'));
const stub = path.join(directory, 'accountSync.ts');
fs.writeFileSync(stub, `export function useAccountSync(enabled, callbacks) {
  window.syncTest = { enabled, callbacks, stats: json => callbacks.stats(JSON.parse(json)), emit: event => callbacks.break(event, () => window.syncCurrent !== false) };
  return { status: enabled ? 'connected' : 'disconnected', account: enabled ? 'test' : null, error: null,
    connect: async () => {}, disconnect: () => {}, deleteAccount: async () => {}, settingsChanged: () => {},
    startBreak: async () => { window.syncPublished = (window.syncPublished || 0) + 1; if (window.syncPublishFails) throw Error('offline'); if (window.syncSchedule && enabled) { const at = Date.now(); const generation = callbacks.breakGeneration?.(); setTimeout(() => { void callbacks.break({ v: 1, id: 'c'.repeat(32), deviceId: 'd'.repeat(32), createdAt: at, startAt: at + 2500, endAt: at + 22500 }, () => window.syncCurrent !== false && generation === callbacks.breakGeneration?.()); }, 2500); } return enabled; } };
}`);
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
function harness(settings = {}) {
  window.syncCurrent = true; window.syncPublished = 0; window.syncPublishFails = false; window.syncSchedule = false;
  return createHarness({ syncEnabled: true, ...settings }, false, false, 1791712800000, { [path.join('src', 'utils', 'accountSync.ts')]: stub });
}
function event(h, seconds = 20) {
  return { v: 1, id: 'a'.repeat(32), deviceId: 'b'.repeat(32), createdAt: h.now - 3000, startAt: h.now - 500, endAt: h.now + seconds * 1000 };
}

test('unavailable browser sync capabilities leave connection controls retryable', async () => {
  const h = createHarness({ syncEnabled: true });
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await assert.rejects(() => h.captured.SettingsModal.accountSync.connect('login', 'test@example.test', 'test password', 'a'.repeat(43), ''));
    await h.settle();
    assert.equal(h.captured.SettingsModal.accountSync.status, 'error');
    assert.equal(h.captured.SettingsModal.accountSync.account, null);
    h.captured.SettingsModal.accountSync.disconnect(); await h.settle();
    assert.equal(h.captured.SettingsModal.accountSync.status, 'disconnected');
  } finally { h.destroy(); }
});

test('a shared break enforces strict UI and native lock locally without rebroadcast or remote opt-in changes', async () => {
  const h = harness({ strictMode: false });
  try {
    await h.settle(); const locks = []; h.desktopAPI.setStrictLock = flag => locks.push(flag);
    await window.syncTest.emit(event(h)); await h.settle();
    assert(h.active.has('BreakOverlay'));
    assert.equal(h.captured.BreakOverlay.strictMode, true);
    assert.equal(locks.at(-1), true);
    assert.equal(window.syncPublished, 0);
    await h.call('BreakOverlay', 'onClose'); await h.call('BreakOverlay', 'onPostpone', 5);
    await h.call('BreakOverlay', 'onOpenExercises');
    assert(h.active.has('BreakOverlay'));
    assert(!h.active.has('ExercisePlayer'));
    assert.equal(JSON.parse(h.store.get('myeyes_settings_v1')).strictMode, false);
    const done = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000); await done(h.monotonicNow); await h.settle();
    assert(!h.active.has('BreakOverlay'));
    assert.equal(locks.at(-1), false);
  } finally { h.destroy(); }
});

test('shared commands skip calls, absence, expired deadlines, disabled sync and revoked sessions', async () => {
  for (const reason of ['call', 'unknown-call', 'failed-call', 'absence', 'expired', 'disabled', 'revoked']) {
    const h = harness({ meetingDetectionEnabled: true, syncEnabled: reason !== 'disabled' });
    try {
      await h.settle();
      if (reason === 'call') h.desktopAPI.checkMeetingActive = async () => ({ inMeeting: true, supported: true });
      if (reason === 'unknown-call') h.desktopAPI.checkMeetingActive = async () => ({ inMeeting: false, supported: false });
      if (reason === 'failed-call') h.desktopAPI.checkMeetingActive = async () => { throw Error('unavailable'); };
      if (reason === 'absence') h.setIdle(90);
      if (reason === 'revoked') window.syncCurrent = false;
      await window.syncTest.emit(event(h, reason === 'expired' ? -1 : 20)); await h.settle();
      assert(!h.active.has('BreakOverlay'), reason);
    } finally { h.destroy(); }
  }
});

test('failed sync delivery still starts the local timer break', async () => {
  const h = harness();
  try {
    await h.settle(); window.syncPublishFails = true;
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    assert(h.active.has('BreakOverlay'));
    assert.equal(h.captured.BreakOverlay.strictMode, false);
    assert.equal(window.syncPublished, 1);
  } finally { h.destroy(); }
});

test('synced aggregate display never replaces local counters and clears at logout', async () => {
  const h = harness();
  try {
    await h.settle();
    const localBefore = h.store.get('myeyes_stats_v1');
    const date = h.allStats()[0]?.date || '2026-10-11';
    window.syncTest.stats(JSON.stringify([[{ date, breaksCompleted: 4, exercisesCompleted: 1, focusMinutes: 10, techniqueCounts: {} }]]));
    await h.settle();
    assert.equal(h.store.get('myeyes_stats_v1'), localBefore);
    await h.call('Navbar', 'onSelectTab', 'stats');
    assert.equal(h.captured.StatisticsView.allStats.find(day => day.date === date).breaksCompleted, 4);
    window.syncTest.stats('[]'); await h.settle();
    assert.equal(h.captured.StatisticsView.allStats.find(day => day.date === date)?.breaksCompleted ?? 0, 0);
  } finally { h.destroy(); }
});


test('reset cancels a shared callback already waiting for its meeting check', async () => {
  const h = harness({ meetingDetectionEnabled: true });
  try {
    await h.settle(); let resolveMeeting;
    h.desktopAPI.checkMeetingActive = () => new Promise(resolve => { resolveMeeting = resolve; });
    const pending = window.syncTest.emit(event(h)); await h.settle();
    assert.equal(typeof resolveMeeting, 'function');
    await h.call('TimerWidget', 'onReset');
    resolveMeeting({ inMeeting: false, supported: true }); await pending; await h.settle();
    assert(!h.active.has('BreakOverlay'));
    assert.equal(h.captured.TimerWidget.isRunning, false);
  } finally { h.destroy(); }
});

test('a late call postpones an expired local cycle while peers keep their running timer', async () => {
  for (const expired of [true, false]) {
    const h = harness({ meetingDetectionEnabled: true, timerPreset: 'custom', workMinutes: expired ? 1 / 60 : 20 });
    try {
      await h.settle(); let inMeeting = false;
      h.desktopAPI.checkMeetingActive = async () => ({ inMeeting, supported: true });
      window.syncSchedule = true;
      if (expired) { await h.advance(1000); assert.equal(window.syncPublished, 1); }
      inMeeting = true;
      if (expired) await h.advance(2500); else await window.syncTest.emit(event(h));
      await h.settle();
      assert(!h.active.has('BreakOverlay'));
      const remaining = h.captured.TimerWidget.secondsRemaining;
      assert(expired ? remaining >= 298 && remaining <= 300 : remaining > 1000);
      inMeeting = false; await h.advance(10_000);
      assert(h.captured.TimerWidget.secondsRemaining > 0);
      assert(!h.active.has('BreakOverlay'));
    } finally { h.destroy(); }
  }
});


test('a canceled shared delivery falls back locally and reset cancels that fallback', async () => {
  for (const reset of [false, true]) {
    const h = harness({ timerPreset: 'custom', workMinutes: 1 / 60, strictMode: false });
    try {
      await h.settle(); await h.advance(1000);
      assert.equal(window.syncPublished, 1);
      if (reset) await h.call('TimerWidget', 'onReset');
      window.syncCurrent = false;
      await h.advance(6500);
      assert.equal(h.active.has('BreakOverlay'), !reset);
      if (!reset) assert.equal(h.captured.BreakOverlay.strictMode, false);
    } finally { h.destroy(); }
  }
});

test('unknown late call status keeps the local expiry policy while peers skip the command', async () => {
  const h = harness({ meetingDetectionEnabled: true, timerPreset: 'custom', workMinutes: 1 / 60, strictMode: false });
  try {
    await h.settle(); window.syncSchedule = true;
    h.desktopAPI.checkMeetingActive = async () => ({ inMeeting: false, supported: false });
    await h.advance(3500);
    assert(h.active.has('BreakOverlay'));
    assert.equal(h.captured.BreakOverlay.strictMode, false);
    assert.equal(window.syncPublished, 1);
  } finally { h.destroy(); }
});


test('a known call arriving before local delivery fallback postpones the expired cycle', async () => {
  const h = harness({ meetingDetectionEnabled: true, timerPreset: 'custom', workMinutes: 1 / 60 });
  try {
    await h.settle(); let inMeeting = false;
    h.desktopAPI.checkMeetingActive = async () => ({ inMeeting, supported: true });
    await h.advance(1000); assert.equal(window.syncPublished, 1);
    inMeeting = true; await h.advance(6500);
    assert(!h.active.has('BreakOverlay'));
    assert(h.captured.TimerWidget.secondsRemaining >= 298);
  } finally { h.destroy(); }
});

test('reset and manual pause reject a shared break before scheduled delivery starts', async () => {
  for (const action of ['onReset', 'onTogglePlay']) {
    const h = harness({ timerPreset: 'custom', workMinutes: 1 / 60 });
    try {
      await h.settle(); window.syncSchedule = true;
      await h.advance(1000); assert.equal(window.syncPublished, 1);
      await h.call('TimerWidget', action);
      await h.advance(2500);
      assert(!h.active.has('BreakOverlay'), action);
      assert.equal(h.captured.TimerWidget.isRunning, false);
    } finally { h.destroy(); }
  }
});

test('a newly received remote command preserves an existing manual pause', async () => {
  const h = harness();
  try {
    await h.settle(); await h.call('TimerWidget', 'onTogglePlay');
    await window.syncTest.emit(event(h)); await h.settle();
    assert(!h.active.has('BreakOverlay'));
    assert.equal(h.captured.TimerWidget.isRunning, false);
  } finally { h.destroy(); }
});
