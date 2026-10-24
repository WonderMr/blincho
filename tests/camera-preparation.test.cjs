const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');
const now = 1791712800000;

test('startup prepares a model only for an existing desktop camera opt-in', async () => {
  for (const [enabled, browser, expected] of [[false, false, 0], [true, true, 0], [true, false, 1]]) {
    let calls = 0;
    const h = createHarness({ cameraLockEnabled: enabled }, false, browser, now, {}, { prepare: async () => { calls++; } });
    try { await h.settle(); assert.equal(calls, expected); }
    finally { h.destroy(); }
  }
});

test('failed preparation of saved camera opt-in disables camera features and preserves other settings', async () => {
  const h = createHarness({ cameraLockEnabled: true, enhancedPresenceEnabled: true, soundVolume: 45 }, false, false, now, {}, {
    prepare: async () => { throw Error('offline with empty model cache'); },
  });
  try {
    await h.settle();
    const saved = JSON.parse(h.store.get('myeyes_settings_v1'));
    assert.equal(saved.cameraLockEnabled, false); assert.equal(saved.enhancedPresenceEnabled, false); assert.equal(saved.soundVolume, 45);
    assert(h.host.textContent.includes('Не удалось загрузить модель камеры'));
  } finally { h.destroy(); }
});

test('disabling the last camera opt-in aborts startup preparation and ignores its late failure', async () => {
  let reject, signal;
  const h = createHarness({ cameraLockEnabled: true }, false, false, now, {}, { prepare: s => {
    signal = s; return new Promise((_resolve, no) => { reject = no; });
  } });
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: false, soundVolume: 45 });
    assert.equal(signal.aborted, true); reject(Error('late failure')); await h.settle();
    const saved = JSON.parse(h.store.get('myeyes_settings_v1'));
    assert.equal(saved.cameraLockEnabled, false); assert.equal(saved.soundVolume, 45);
    assert(!h.host.textContent.includes('Не удалось загрузить модель камеры'));
  } finally { h.destroy(); }
});
