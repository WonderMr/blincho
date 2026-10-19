const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

async function beginAndElapse(h) {
  await h.settle();
  await h.call('TimerWidget', 'onTriggerInstantBreak');
  const elapsed = h.captured.BreakOverlay.onElapsed;
  await h.advance(20_000);
  await elapsed(h.monotonicNow);
  await h.settle();
  return elapsed;
}

test('leaving during a break checks camera at completion and locks exactly once', async () => {
  const h = createHarness({ cameraLockEnabled: true, strictMode: true });
  let checks = 0, locks = 0;
  h.setCameraCheck(async () => { checks++; return 'absent'; });
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    const elapsed = await beginAndElapse(h);
    assert.equal(checks, 1, 'instant breaks also check for absence at their deadline');
    assert.equal(locks, 1);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.captured.TimerWidget.phase, 'locked');
    assert.equal(h.stats().breaksCompleted, 0);
    await elapsed(h.monotonicNow);
    await h.advance(1000);
    assert.equal(locks, 1, 'late overlay callback cannot repeat the lock');
    assert.equal(h.metrics.completionChimes, 1);
  } finally { h.destroy(); }
});

test('scheduled break opens without camera access and samples only at its timed end', async () => {
  const h = createHarness({ cameraLockEnabled: true, timerPreset: 'custom', workMinutes: 1 / 60 });
  let checks = 0, locks = 0;
  h.setCameraCheck(async () => { checks++; return 'absent'; });
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    await h.settle();
    await h.advance(1000);
    assert.equal(checks, 0, 'work expiry cannot open the camera');
    assert.equal(locks, 0);
    assert.equal(h.active.has('BreakOverlay'), true);
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000);
    await elapsed(h.monotonicNow);
    await h.settle();
    assert.equal(checks, 1);
    assert.equal(locks, 1);
    assert.equal(h.captured.TimerWidget.phase, 'locked');
  } finally { h.destroy(); }
});

test('native deadline checks the camera even when the renderer countdown has not ticked', async () => {
  const previous = window.__TAURI__;
  let snapshot, ticks = 0, checks = 0, locks = 0;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = {
      ...args.input, tickCount: ++ticks, reasons: [], focusByDate: {},
      absenceEpoch: 0, absentSince: null, idleSeconds: 0, locked: false, suspended: false,
      breakElapsed: false, breakEndAt: null,
    };
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks };
  } } };
  const h = createHarness({ cameraLockEnabled: true });
  h.setCameraCheck(async () => { checks++; return 'absent'; });
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    snapshot = { ...snapshot, breakElapsed: true, breakEndAt: h.now };
    await h.advance(1000);
    assert.equal(checks, 1);
    assert.equal(locks, 1);
    await elapsed(h.monotonicNow);
    await h.settle();
    assert.equal(checks, 1);
    assert.equal(locks, 1);
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('delayed native configuration keeps renderer expiry from ending a strict break early', async () => {
  const previous = window.__TAURI__;
  const start = 1791712800000;
  let h, snapshot, ticks = 0, acceptBreak, nativeDeadline, checks = 0, locks = 0;
  const strictCalls = [];
  const copy = () => ({ ...snapshot, tickCount: ++ticks });
  const configure = input => {
    snapshot = {
      ...input, reasons: [], focusByDate: {}, absenceEpoch: 0, absentSince: null,
      idleSeconds: 0, locked: false, suspended: false, breakElapsed: false,
      breakEndAt: input.breakActive ? h.now + input.breakSeconds * 1000 : null,
    };
    if (input.breakActive) nativeDeadline = snapshot.breakEndAt;
    return copy();
  };
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') {
      if (args.input.breakActive && nativeDeadline === undefined) {
        return new Promise(resolve => { acceptBreak = () => resolve(configure(args.input)); });
      }
      return configure(args.input);
    }
    if (command === 'timer_snapshot') {
      if (snapshot.breakActive && h.now >= snapshot.breakEndAt) snapshot.breakElapsed = true;
      return copy();
    }
  } } };
  try {
    h = createHarness({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 3,
      cameraLockEnabled: true, strictMode: true, idleDetectionEnabled: false }, false, false, start);
    h.setCameraCheck(async () => { checks++; return 'absent'; });
    h.electronAPI.lockComputer = async () => { locks++; return true; };
    h.electronAPI.setStrictLock = active => strictCalls.push(active);
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    assert.equal(h.captured.BreakOverlay.waitForNativeCompletion, true, 'App keeps the visual overlay under native authority');
    assert.equal(typeof acceptBreak, 'function', 'native configuration is still waiting');
    await h.advance(200);
    acceptBreak();
    await h.settle();
    assert.equal(nativeDeadline, start + 3200, 'modeled IPC delay moves the native deadline');
    await h.advance(2800);
    assert.equal(h.now, start + 3000, 'the renderer countdown has reached zero');
    assert.equal(snapshot.breakElapsed, false);
    await elapsed(h.monotonicNow);
    await h.settle();
    assert.equal(h.active.has('BreakOverlay'), true, 'renderer expiry must wait for native completion');
    assert.equal(snapshot.breakActive, true, 'renderer expiry must not clear the native break');
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.equal(strictCalls.at(-1), true, 'strict lock stays active until the native deadline');
    assert.equal(checks, 0, 'an early renderer callback cannot start the camera');
    assert.equal(locks, 0);
    assert.equal(h.metrics.completionChimes, 0);
    await h.advance(100);
    await h.emit('mousemove');
    assert.equal(h.stats().breaksCompleted, 0, 'input before native expiry cannot credit the break');
    h.setIdle(20);
    await h.advance(900);
    assert.equal(h.active.has('BreakOverlay'), false, 'native expiry closes the break');
    assert.equal(strictCalls.at(-1), false);
    assert.equal(checks, 1, 'native expiry starts one camera check');
    assert.equal(locks, 1);
    assert.equal(h.metrics.completionChimes, 1);
    await elapsed(h.monotonicNow);
    await h.advance(1000);
    assert.equal(checks, 1, 'a duplicate renderer callback cannot repeat native completion');
    assert.equal(locks, 1);
    assert.equal(h.stats().breaksCompleted, 0);
  } finally {
    h?.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('an expired native frame from an old version cannot finish a replacement break', async () => {
  const previous = window.__TAURI__;
  let snapshot, nextFrame, ticks = 0, checks = 0;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = {
      ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0, absentSince: null,
      idleSeconds: 0, locked: false, suspended: false, breakElapsed: false, breakEndAt: null,
    };
    const frame = command === 'timer_snapshot' && nextFrame ? nextFrame : snapshot;
    nextFrame = undefined;
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...frame, tickCount: ++ticks };
  } } };
  const h = createHarness({ cameraLockEnabled: true });
  h.setCameraCheck(async () => { checks++; return 'present'; });
  h.electronAPI.lockComputer = async () => false;
  try {
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const oldElapsed = h.captured.BreakOverlay.onElapsed;
    const oldFrame = { ...snapshot, breakElapsed: true, breakEndAt: h.now };
    await h.call('BreakOverlay', 'onClose');
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    assert(snapshot.version > oldFrame.version);
    nextFrame = oldFrame;
    await h.advance(1000);
    await oldElapsed(h.monotonicNow);
    await h.settle();
    assert.equal(h.active.has('BreakOverlay'), true, 'new tick count cannot authorize an old break version');
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.equal(checks, 0);
    assert.equal(h.metrics.completionChimes, 0);
    assert.equal(h.stats().breaksCompleted, 0);
    snapshot = { ...snapshot, breakElapsed: true, breakEndAt: h.now };
    await h.advance(1000);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(checks, 1);
    assert.equal(h.metrics.completionChimes, 1);
    await oldElapsed(h.monotonicNow);
    await elapsed(h.monotonicNow);
    nextFrame = oldFrame;
    await h.advance(1000);
    assert.equal(checks, 1, 'stale native and renderer callbacks cannot repeat completion');
    assert.equal(h.metrics.completionChimes, 1);
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('present, unavailable and opted-out camera leave the completed break in normal work', async () => {
  for (const [enabled, result] of [[true, 'present'], [true, 'unavailable'], [false, 'absent']]) {
    const h = createHarness({ cameraLockEnabled: enabled });
    let checks = 0, locks = 0;
    h.setCameraCheck(async () => { checks++; return result; });
    h.electronAPI.lockComputer = async () => { locks++; return true; };
    try {
      await beginAndElapse(h);
      assert.equal(checks, Number(enabled));
      assert.equal(locks, 0);
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.equal(h.captured.TimerWidget.phase, 'work');
    } finally { h.destroy(); }
  }
});

test('new input, pause, reset, settings changes and power changes cancel a late completion decision', async () => {
  for (const action of ['input', 'pause', 'reset', 'disable', 'permission', 'locked', 'suspended', 'new-break', 'exercise', 'unmount']) {
    const h = createHarness({ cameraLockEnabled: true });
    let resolveCamera, signal, locks = 0, destroyed = false;
    h.setCameraCheck(value => { signal = value; return new Promise(resolve => { resolveCamera = resolve; }); });
    h.electronAPI.lockComputer = async () => { locks++; return true; };
    try {
      await beginAndElapse(h);
      assert(resolveCamera, action);
      if (action === 'input') await h.emit('mousemove');
      if (action === 'pause') await h.call('TimerWidget', 'onTogglePlay');
      if (action === 'reset') await h.call('TimerWidget', 'onReset');
      if (action === 'disable' || action === 'permission') {
        await h.call('Navbar', 'onOpenSettings');
        if (action === 'disable') await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: false });
        else await h.call('SettingsModal', 'onCameraAccessPendingChange', true);
      }
      if (action === 'locked') await h.power('lock-screen');
      if (action === 'suspended') await h.power('suspend');
      if (action === 'new-break') await h.call('TimerWidget', 'onTriggerInstantBreak');
      if (action === 'exercise') {
        await h.call('Navbar', 'onSelectTab', 'library');
        await h.call('ExerciseLibrary', 'onStartFullRoutine');
      }
      if (action === 'unmount') { h.destroy(); destroyed = true; }
      assert.equal(signal.aborted, true, action + ' releases the camera immediately');
      resolveCamera('absent');
      await h.settle();
      assert.equal(locks, 0, action);
    } finally { if (!destroyed) h.destroy(); }
  }
});

test('false or rejected lock after completion keeps work usable and reports failure', async () => {
  for (const rejects of [false, true]) {
    const h = createHarness({ cameraLockEnabled: true });
    h.setCameraCheck(async () => 'absent');
    h.electronAPI.lockComputer = async () => { if (rejects) throw Error('lock failed'); return false; };
    try {
      await beginAndElapse(h);
      assert.equal(h.captured.TimerWidget.phase, 'work');
      assert.equal(h.active.has('BreakOverlay'), false);
      assert(h.warnings.length > 0);
      assert(h.host.textContent.includes('Не удалось заблокировать компьютер.'));
    } finally { h.destroy(); }
  }
});

test('stationary mouse event from fullscreen exit does not cancel the camera check', async () => {
  const h = createHarness({ cameraLockEnabled: true, strictMode: true });
  let resolveCamera, signal, locks = 0;
  h.setCameraCheck(value => { signal = value; return new Promise(resolve => { resolveCamera = resolve; }); });
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    await beginAndElapse(h);
    await h.emit('mousemove', { movementX: 0, movementY: 0 });
    assert.equal(signal.aborted, false, 'window transition is not evidence of user input');
    resolveCamera('absent');
    await h.settle();
    assert.equal(locks, 1);
  } finally { h.destroy(); }
});

test('fresh system input in another app cancels absence without a renderer event', async () => {
  for (const { idle, returned, description } of [
    { idle: 22, returned: false, description: 'absence continues' },
    { idle: 0, returned: true, description: 'return just before the final query' },
    { idle: 1.5, returned: true, description: 'return half a second after capture starts' },
    { idle: 1, returned: true, description: 'rounded idle after an early return' },
  ]) {
    const h = createHarness({ cameraLockEnabled: true });
    let resolveCamera, locks = 0;
    h.setCameraCheck(() => new Promise(resolve => { resolveCamera = resolve; }));
    h.electronAPI.lockComputer = async () => { locks++; return true; };
    try {
      await beginAndElapse(h);
      h.setIdle(idle);
      await h.advance(2000);
      resolveCamera('absent');
      await h.settle();
      assert.equal(locks, returned ? 0 : 1, description);
    } finally { h.destroy(); }
  }
});

test('delayed final idle query cannot hide input after camera capture began', async () => {
  const h = createHarness({ cameraLockEnabled: true });
  let resolveCamera, resolveFinalIdle, idleCalls = 0, locks = 0;
  h.setCameraCheck(() => new Promise(resolve => { resolveCamera = resolve; }));
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    await beginAndElapse(h);
    await h.advance(1200);
    h.electronAPI.getSystemIdleTime = async () => ++idleCalls === 2
      ? new Promise(resolve => { resolveFinalIdle = resolve; }) : 20;
    resolveCamera('absent');
    await h.settle();
    assert.equal(typeof resolveFinalIdle, 'function', 'final idle query is pending');
    await h.advance(2000);
    resolveFinalIdle(1.5);
    await h.settle();
    assert.equal(locks, 0, 'input during the delayed query invalidates camera absence');
  } finally { h.destroy(); }
});

test('enhanced native presence credits a completed break once after confirmed later input', async () => {
  const previous = window.__TAURI__;
  let h, snapshot, ticks = 0, idleSeconds = 20;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = {
      ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0, absentSince: null,
      locked: false, suspended: false, breakElapsed: false,
      breakEndAt: args.input.breakActive ? h.now + args.input.breakSeconds * 1000 : null,
    };
    if (command === 'configure_timer' || command === 'timer_snapshot') {
      if (snapshot.breakActive && h.now >= snapshot.breakEndAt) snapshot.breakElapsed = true;
      return { ...snapshot, idleSeconds, tickCount: ++ticks };
    }
    if (command === 'presence_check_begin') return null;
  } } };
  try {
    h = createHarness({ enhancedPresenceEnabled: true });
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000);
    assert.equal(h.active.has('BreakOverlay'), false, 'native deadline closes the break');
    assert.equal(h.stats().breaksCompleted, 0, 'elapsed time alone does not prove resumed input');
    await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 0, 'stale idle cannot credit the break');
    idleSeconds = 0;
    await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 1, 'native input after the deadline credits the pending break');
    await elapsed(h.monotonicNow);
    await h.emit('mousemove');
    await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 1, 'later native samples and renderer callbacks cannot credit twice');
    assert.equal(h.idleCalls, 0, 'enhanced presence uses native snapshot idle rather than the legacy query');
  } finally {
    h?.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('enhanced native presence does not credit stale, invalid or late input', async () => {
  for (const sample of ['stale', 'negative', 'non-finite', 'late']) {
    const previous = window.__TAURI__;
    let h, snapshot, ticks = 0, idleSeconds = 20;
    window.__TAURI__ = { core: { async invoke(command, args) {
      if (command === 'configure_timer') snapshot = {
        ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0, absentSince: null,
        locked: false, suspended: false, breakElapsed: false,
        breakEndAt: args.input.breakActive ? h.now + args.input.breakSeconds * 1000 : null,
      };
      if (command === 'configure_timer' || command === 'timer_snapshot') {
        if (snapshot.breakActive && h.now >= snapshot.breakEndAt) snapshot.breakElapsed = true;
        return { ...snapshot, idleSeconds, tickCount: ++ticks };
      }
      if (command === 'presence_check_begin') return null;
    } } };
    try {
      h = createHarness({ enhancedPresenceEnabled: true });
      await h.settle();
      await h.call('TimerWidget', 'onTriggerInstantBreak');
      await h.advance(20_000);
      if (sample === 'late') await h.advance(16_000);
      idleSeconds = sample === 'negative' ? -1 : sample === 'non-finite' ? NaN : sample === 'late' ? 0 : 20;
      await h.advance(2000);
      assert.equal(h.stats().breaksCompleted, 0, sample);
    } finally {
      h?.destroy();
      if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    }
  }
});

test('slow enhanced native reads cannot turn input before the deadline into completion credit', async () => {
  const previous = window.__TAURI__;
  let h, snapshot, ticks = 0, idleSeconds = 20, holdNext = false, resolveHeld;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = {
      ...args.input, reasons: [], focusByDate: {}, absenceEpoch: 0, absentSince: null,
      locked: false, suspended: false, breakElapsed: false,
      breakEndAt: args.input.breakActive ? h.now + args.input.breakSeconds * 1000 : null,
    };
    if (command === 'configure_timer' || command === 'timer_snapshot') {
      if (snapshot.breakActive && h.now >= snapshot.breakEndAt) snapshot.breakElapsed = true;
      const frame = { ...snapshot, idleSeconds, tickCount: ++ticks };
      if (command === 'timer_snapshot' && holdNext) {
        holdNext = false;
        return new Promise(resolve => { resolveHeld = () => resolve(frame); });
      }
      return frame;
    }
    if (command === 'presence_check_begin') return null;
  } } };
  try {
    h = createHarness({ enhancedPresenceEnabled: true });
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    await h.advance(20_000);
    await h.advance(500);
    idleSeconds = 0;
    holdNext = true;
    await h.emit('mousemove');
    assert.equal(typeof resolveHeld, 'function', 'the enhanced presence sample is waiting for native IPC');
    await h.advance(1500);
    idleSeconds = 20;
    resolveHeld();
    await h.settle();
    assert.equal(h.stats().breaksCompleted, 0, 'query-start time and rounded idle cannot prove later input');
    await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 0, 'stale subsequent reads still cannot credit the break');
    idleSeconds = 0;
    await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 1, 'a later fresh sample can still confirm the pending break');
  } finally {
    h?.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});
