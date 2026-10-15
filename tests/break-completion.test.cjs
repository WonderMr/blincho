const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

test('native break deadline plays one completion chime before the overlay can tick', async () => {
  const previous = window.__TAURI__;
  let snapshot, ticks = 0;
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = {
      ...args.input, tickCount: ++ticks, reasons: [], focusByDate: {},
      absenceEpoch: 0, absentSince: null, idleSeconds: 0, locked: false, suspended: false,
      breakElapsed: false, breakEndAt: null,
    };
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks };
  } } };
  const h = createHarness({ soundEnabled: true });
  try {
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    assert.equal(h.metrics.completionChimes, 0);
    snapshot = { ...snapshot, breakElapsed: true, breakEndAt: h.now };
    await h.advance(1000);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.metrics.completionChimes, 1, 'native completion owns the signal even without an overlay tick');
    await elapsed(h.monotonicNow);
    await h.advance(1000);
    assert.equal(h.metrics.completionChimes, 1, 'late renderer callbacks cannot repeat the native signal');
  } finally {
    h.destroy();
    if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
  }
});

test('renderer completion signals once; cancellation and old callbacks stay silent', async () => {
  const h = createHarness({ soundEnabled: true });
  try {
    await h.settle();
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const cancelled = h.captured.BreakOverlay.onElapsed;
    await h.call('BreakOverlay', 'onClose');
    await cancelled(h.monotonicNow);
    assert.equal(h.metrics.completionChimes, 0);
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    await cancelled(h.monotonicNow);
    assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(h.metrics.completionChimes, 0);
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000);
    await elapsed(h.monotonicNow);
    await elapsed(h.monotonicNow);
    await h.settle();
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.metrics.completionChimes, 1);
  } finally { h.destroy(); }
});

test('absence, postponement and unmount cancel completion sound', async () => {
  for (const cancel of ['locked', 'suspended', 'idle', 'postpone', 'unmount']) {
    const h = createHarness({ soundEnabled: true });
    let destroyed = false;
    try {
      await h.settle();
      await h.call('TimerWidget', 'onTriggerInstantBreak');
      const elapsed = h.captured.BreakOverlay.onElapsed;
      if (cancel === 'locked') await h.power('lock-screen');
      if (cancel === 'suspended') await h.power('suspend');
      if (cancel === 'idle') { h.setIdle(60); await h.advance(1000); }
      if (cancel === 'postpone') await h.call('BreakOverlay', 'onPostpone', 5);
      if (cancel === 'unmount') { h.destroy(); destroyed = true; }
      await elapsed(h.monotonicNow);
      await h.settle();
      assert.equal(h.metrics.completionChimes, 0, cancel);
    } finally { if (!destroyed) h.destroy(); }
  }
});
