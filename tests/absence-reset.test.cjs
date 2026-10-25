const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

test('native return keeps progress made after a long lock and restores the pre-lock countdown on undo', async () => {
  for (const preset of ['20-20-20', 'pomodoro', 'custom']) for (const activeBreak of [false, true]) for (const entry of ['poll', 'focus']) {
    const previous = window.__TAURI__;
    let snapshot;
    let ticks = 0;
    const configured = [];
    window.__TAURI__ = { core: { async invoke(command, args) {
      if (command === 'configure_timer') {
        configured.push({ ...args.input });
        if (!snapshot) snapshot = { ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0,
          absentSince: null, idleSeconds: 0, locked: false, suspended: false, breakElapsed: false };
        else if (args.input.version >= snapshot.version) Object.assign(snapshot, args.input);
      }
      if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks };
    } } };
    const h = createHarness({ timerPreset: preset, workMinutes: 7, meetingDetectionEnabled: true });
    try {
      await h.settle();
      const total = h.captured.TimerWidget.totalSeconds;
      if (activeBreak) await h.call('TimerWidget', 'onTriggerInstantBreak');
      const beforeReturn = configured.length;
      snapshot = { ...snapshot, breakActive: false, remainingMs: total * 1000 - 10_000, version: snapshot.version + 1,
        absenceEpoch: 1, absentSince: h.now + 1000, meetingPostponedEpoch: 1,
        absenceReset: { epoch: 1, remainingMs: 60_000 } };
      if (entry === 'focus') {
        await h.shiftWall(320_000);
        await h.emit('focus');
      } else await h.jump(320_000);
      assert.equal(h.captured.TimerWidget.secondsRemaining, total - 10,
        'a delayed renderer must retain work already counted after unlock');
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.equal(h.captured.TimerWidget.statusLabel, 'Рабочий цикл');
      assert.equal(h.stats().breaksCompleted, 0);
      assert(configured.slice(beforeReturn).every(input => input.remainingMs !== total * 1000),
        'native reset must not cause a second renderer reset');
      await h.undo();
      assert.equal(h.captured.TimerWidget.secondsRemaining, 60,
        'undo restores the countdown from before the native reset');
    } finally {
      h.destroy();
      if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    }
  }
});

test('a long lock restarts the configured work interval and preserves manual pause', async () => {
  for (const paused of [false, true]) {
    const h = createHarness({ timerPreset: 'custom', workMinutes: 7, idleDetectionEnabled: false });
    try {
      await h.advance(10_000);
      if (paused) await h.call('TimerWidget', 'onTogglePlay');
      await h.power('lock-screen');
      await h.jump(301_000);
      await h.power('unlock-screen');
      await h.settle();
      assert.equal(h.captured.TimerWidget.secondsRemaining, 420);
      assert.equal(h.captured.TimerWidget.phase, paused ? 'manual' : 'work');
      assert.equal(h.stats().breaksCompleted, 0);
    } finally { h.destroy(); }
  }
});


test('native presence IPC failure cancels timer actions without an unhandled rejection', async () => {
  const previous = window.__TAURI__;
  let snapshot, ticks = 0, fail = false;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = { ...args.input, reasons: fail ? ['unconfirmed'] : [],
      focusByDate: {}, absenceEpoch: 0, absentSince: null, idleSeconds: 0,
      locked: false, suspended: false, breakElapsed: false };
    if (command === 'timer_snapshot' && fail) throw Error('native presence IPC unavailable');
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks };
  } } };
  const h = createHarness();
  try {
    await h.settle();
    fail = true;
    await assert.doesNotReject(() => h.call('TimerWidget', 'onTriggerInstantBreak'));
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.captured.TimerWidget.isIdlePaused, true);
    assert(h.warnings.some(args => args.some(value => String(value).includes('Native presence query failed'))));
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('a failed first return snapshot cannot overwrite a native reset behind an active break', async () => {
  const previous = window.__TAURI__;
  let snapshot, ticks = 0, fail = false;
  const configured = [];
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') {
      configured.push({ ...args.input });
      if (!snapshot) snapshot = { ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0,
        absentSince: null, idleSeconds: 0, locked: false, suspended: false, breakElapsed: false };
      else if (args.input.version >= snapshot.version) Object.assign(snapshot, args.input);
    }
    if (command === 'timer_snapshot' && fail) throw Error('first return snapshot unavailable');
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks };
  } } };
  const h = createHarness();
  try {
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const beforeReturn = configured.length;
    snapshot = { ...snapshot, breakActive: false, remainingMs: 1_190_000, version: snapshot.version + 1,
      absenceEpoch: 1, absentSince: h.now + 1000, absenceReset: { epoch: 1, remainingMs: 60_000 } };
    await h.shiftWall(320_000);
    fail = true;
    await h.emit('focus');
    assert.equal(configured.length, beforeReturn, 'failed reads must not configure an unreconciled timer');
    assert.equal(snapshot.remainingMs, 1_190_000);
    fail = false;
    await h.emit('focus');
    assert.equal(h.captured.TimerWidget.secondsRemaining, 1190);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.captured.TimerWidget.isIdlePaused, false);
    await h.undo();
    assert.equal(h.captured.TimerWidget.secondsRemaining, 60);
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});
