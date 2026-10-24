const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

test('switching locale preserves the running deadline, statistics and stored timer settings', async () => {
  const h = createHarness();
  try {
    await h.settle(); await h.advance(12000);
    const before = h.captured.TimerWidget.secondsRemaining;
    const settings = h.store.get('myeyes_settings_v1');
    const history = h.store.get('myeyes_stats_v1');
    for (const language of Object.keys(require('../src-tauri/locales.json'))) {
      await h.setLanguage(language);
      assert.equal(h.captured.TimerWidget.secondsRemaining, before);
      assert.equal(h.captured.TimerWidget.phase, 'work');
      assert.equal(h.store.get('myeyes_settings_v1'), settings);
      assert.equal(h.store.get('myeyes_stats_v1'), history);
    }
    await h.advance(3000);
    assert.equal(h.captured.TimerWidget.secondsRemaining, before - 3);
  } finally { h.destroy(); }
});

test('locale changes cannot resume manual, locked or suspended sessions or credit their breaks', async () => {
  for (const phase of ['manual','locked','suspended']) {
    const h = createHarness();
    try {
      await h.settle(); await h.advance(3000);
      if (phase === 'manual') await h.call('TimerWidget','onTogglePlay');
      else await h.power(phase === 'locked' ? 'lock-screen' : 'suspend');
      const before = h.captured.TimerWidget.secondsRemaining;
      await h.setLanguage('hy'); await h.advance(30000); await h.setLanguage('fa');
      assert.equal(h.captured.TimerWidget.phase, phase);
      assert.equal(h.captured.TimerWidget.secondsRemaining, before);
      assert.equal(h.stats().breaksCompleted, 0);
    } finally { h.destroy(); }
  }
});

test('language switching during strict rest preserves its owner and fresh-return requirement', async () => {
  const h = createHarness({strictMode:true});
  try {
    await h.settle(); await h.call('TimerWidget','onTriggerInstantBreak');
    const close = h.captured.BreakOverlay.onElapsed;
    h.setIdle(20); await h.advance(20000); await h.setLanguage('ja');
    assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(h.captured.BreakOverlay.initialSeconds, 20);
    await close(h.monotonicNow); await h.settle();
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.stats().breaksCompleted, 0);
    await h.setLanguage('en'); await h.advance(16000);
    h.setIdle(0); await h.emit('mousemove'); await h.advance(1000);
    assert.equal(h.stats().breaksCompleted, 0, 'language change cannot certify a completed rest');
  } finally { h.destroy(); }
});
