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

test('scheduled break samples again when a person leaves after the initial camera check', async () => {
  const h = createHarness({ cameraLockEnabled: true, timerPreset: 'custom', workMinutes: 1 / 60 });
  let checks = 0, locks = 0;
  h.setCameraCheck(async () => ++checks === 1 ? 'present' : 'absent');
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  try {
    await h.settle();
    await h.advance(1000);
    assert.equal(checks, 1);
    assert.equal(h.active.has('BreakOverlay'), true);
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000);
    await elapsed(h.monotonicNow);
    await h.settle();
    assert.equal(checks, 2);
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
