const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

// Actual App/React orchestration; desktop APIs and time are simulated.
function recordPresentation(h) {
  const calls = [];
  for (const name of ['setBreakFullscreen', 'bringToFront', 'setStrictLock', 'setAlwaysOnTop']) {
    h.electronAPI[name] = value => calls.push([name, value]);
  }
  return calls;
}

test('automatic deadline requests desktop presentation once in normal and strict modes', async () => {
  for (const strictMode of [false, true]) {
    const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05, strictMode });
    try {
      await h.settle();
      const calls = recordPresentation(h);
      await h.advance(4000);
      assert(h.active.has('BreakOverlay'));
      assert.equal(calls.filter(([name]) => name === 'bringToFront').length, 1);
      assert.equal(calls.find(([name]) => name === 'bringToFront')[1].alwaysOnTop, strictMode);
      assert(calls.some(([name, value]) => name === 'setBreakFullscreen' && value === true));
      assert(calls.some(([name, value]) => name === 'setStrictLock' && value === strictMode));
      await h.advance(3000);
      assert.equal(calls.filter(([name]) => name === 'bringToFront').length, 1);
      assert.equal(h.stats().breaksCompleted, 0);
    } finally { h.destroy(); }
  }
});

test('sampled lock without a native event holds the deadline until a fresh unlocked sample', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05 });
  try {
    await h.settle();
    let locked = true;
    h.electronAPI.getPowerState = async () => ({ suspended: false, locked });
    const calls = recordPresentation(h);
    await h.advance(30000);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(calls.filter(([name]) => name === 'bringToFront').length, 0);
    assert.equal(h.stats().breaksCompleted, 0);
    locked = false;
    await h.advance(4000);
    assert(h.active.has('BreakOverlay'));
    assert.equal(calls.filter(([name]) => name === 'bringToFront').length, 1);
  } finally { h.destroy(); }
});

test('failed session probe cancels a strict rest and stale completion cannot credit it', async () => {
  const h = createHarness({ strictMode: true });
  try {
    await h.settle();
    const calls = recordPresentation(h);
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    h.electronAPI.getPowerState = async () => { throw new Error('session unavailable'); };
    await h.advance(30000);
    assert.equal(h.active.has('BreakOverlay'), false);
    assert(calls.some(([name, value]) => name === 'setBreakFullscreen' && value === false));
    assert(calls.some(([name, value]) => name === 'setStrictLock' && value === false));
    h.electronAPI.getPowerState = async () => ({ suspended: false, locked: false });
    await h.advance(2000);
    await elapsed();
    await h.settle();
    assert.equal(h.stats().breaksCompleted, 0);
  } finally { h.destroy(); }
});
