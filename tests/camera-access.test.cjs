const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const { createHarness } = require('./app.test.cjs');
const repo = path.resolve(__dirname, '..');
const file = path.join(repo, 'src/utils/cameraAccess.ts');
const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/^import .*;\n/gm, '').replace(/export (const|function) /g, '$1 ');
const moduleScope = { exports: {} };
vm.runInNewContext(code + '\nmodule.exports={createCameraAccessRequester};', { module: moduleScope, trackCameraStream: () => () => {} });
const { createCameraAccessRequester } = moduleScope.exports;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('permission probe waits for native configuration, acquires video only and releases every track without sampling frames', async () => {
  const native = deferred(); let acquired = 0, stopped = 0;
  const request = createCameraAccessRequester({ mediaDevices: () => ({ getUserMedia: async constraints => {
    assert.equal(constraints.video, true); assert.equal(constraints.audio, false); acquired++;
    return { getTracks: () => [{ stop() { stopped++; } }, { stop() { stopped++; } }] };
  } }) });
  const pending = request(new AbortController().signal, () => native.promise);
  await settle(); assert.equal(acquired, 0);
  native.resolve(); assert.equal(await pending, 'granted'); assert.equal(acquired, 1); assert.equal(stopped, 2);
});

test('permission probe reports acquired ownership and releases it even after cancellation', async () => {
  const media = deferred(), events = []; const controller = new AbortController();
  const request = createCameraAccessRequester({
    mediaDevices: () => ({ getUserMedia: () => media.promise }),
    trackStream: () => { events.push('active'); return () => events.push('inactive'); },
  });
  const pending = request(controller.signal); await settle();
  assert.deepEqual(events, []); controller.abort(); assert.equal(await pending, 'cancelled');
  media.resolve({ getTracks: () => [{ stop() { events.push('stopped'); } }] }); await settle();
  assert.deepEqual(events, ['active', 'stopped', 'inactive']);
});

test('missing devices, permission denial and configuration/camera errors fail closed', async () => {
  const signal = new AbortController().signal;
  assert.equal(await createCameraAccessRequester({ mediaDevices: () => undefined })(signal), 'unavailable');
  for (const [name, expected] of [['NotAllowedError', 'denied'], ['PermissionDeniedError', 'denied'], ['NotFoundError', 'unavailable'], ['NotReadableError', 'unavailable']]) {
    const request = createCameraAccessRequester({ mediaDevices: () => ({ getUserMedia: async () => { throw { name }; } }) });
    assert.equal(await request(signal), expected);
  }
  let acquired = false;
  const request = createCameraAccessRequester({ mediaDevices: () => ({ getUserMedia: async () => { acquired = true; } }) });
  assert.equal(await request(signal, async () => { throw Error('configure failed'); }), 'unavailable'); assert.equal(acquired, false);
});

test('cancel before configuration never opens camera; cancel during the prompt releases a late stream', async () => {
  let acquired = 0, stopped = 0;
  const native = deferred(), media = deferred();
  const request = createCameraAccessRequester({ mediaDevices: () => ({ getUserMedia: () => { acquired++; return media.promise; } }) });
  const first = new AbortController(); first.abort(); assert.equal(await request(first.signal), 'cancelled');
  const before = new AbortController(), waiting = request(before.signal, () => native.promise);
  before.abort(); assert.equal(await waiting, 'cancelled'); native.resolve(); await settle(); assert.equal(acquired, 0);
  const during = new AbortController(), prompting = request(during.signal); await settle(); assert.equal(acquired, 1);
  during.abort(); assert.equal(await prompting, 'cancelled');
  media.resolve({ getTracks: () => [{ stop() { stopped++; } }, { stop() { stopped++; } }] }); await settle(); assert.equal(stopped, 2);
});

test('default-off expiry skips camera detection and locking', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let checks = 0, locks = 0;
  try {
    h.desktopAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(async () => { checks++; return 'absent'; });
    await h.settle(); await h.advance(1000);
    assert.equal(checks, 0); assert.equal(locks, 0); assert.equal(h.active.has('BreakOverlay'), true);
  } finally { h.destroy(); }
});

test('pending permission blocks the timed-end camera check and persists off through concurrent changes until successful completion', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let checks = 0, locks = 0;
  try {
    h.desktopAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(async () => { checks++; return 'absent'; });
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onCameraAccessPendingChange', true);
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: true });
    assert.equal(h.captured.SettingsModal.settings.cameraLockEnabled, true, 'runtime native grant is enabled');
    assert.equal(JSON.parse(h.store.get('myeyes_settings_v1')).cameraLockEnabled, false, 'temporary grant survives restart as off');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, soundVolume: 35 });
    assert.equal(JSON.parse(h.store.get('myeyes_settings_v1')).cameraLockEnabled, false);
    await h.advance(1000);
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000); await elapsed(h.monotonicNow); await h.settle();
    assert.equal(checks, 0); assert.equal(locks, 0);
    await h.call('SettingsModal', 'onCameraAccessPendingChange', false);
    const saved = JSON.parse(h.store.get('myeyes_settings_v1')); assert.equal(saved.cameraLockEnabled, true); assert.equal(saved.soundVolume, 35);
  } finally { h.destroy(); }
});

test('starting a permission prompt cancels an old absence decision even when it returns after permission clears', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60, cameraLockEnabled: true }); const camera = deferred(); let signal, locks = 0;
  try {
    h.desktopAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(value => { signal = value; return camera.promise; });
    await h.settle(); await h.advance(1000);
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.advance(20_000); await elapsed(h.monotonicNow); await h.settle(); assert(signal);
    await h.call('Navbar', 'onOpenSettings'); await h.call('SettingsModal', 'onCameraAccessPendingChange', true); assert.equal(signal.aborted, true);
    await h.call('SettingsModal', 'onCameraAccessPendingChange', false);
    camera.resolve('absent'); await h.settle(); assert.equal(locks, 0); assert.equal(h.active.has('BreakOverlay'), false);
  } finally { h.destroy(); }
});

test('denial rollback persists off and preserves unrelated latest settings', async () => {
  const h = createHarness();
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings'); await h.call('SettingsModal', 'onCameraAccessPendingChange', true);
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: true, soundVolume: 25 });
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: false });
    await h.call('SettingsModal', 'onCameraAccessPendingChange', false);
    const saved = JSON.parse(h.store.get('myeyes_settings_v1')); assert.equal(saved.cameraLockEnabled, false); assert.equal(saved.soundVolume, 25);
  } finally { h.destroy(); }
});

test('permission cleanup after App unmount still revokes the native camera grant with latest settings', async () => {
  const h = createHarness(); const configured = []; const original = window.__TAURI__; let destroyed = false;
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings'); await h.call('SettingsModal', 'onCameraAccessPendingChange', true);
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: true, idleThresholdMinutes: 3 });
    const controls = h.captured.SettingsModal;
    h.destroy(); destroyed = true;
    window.__TAURI__ = { core: { async invoke(command, args) {
      assert.equal(command, 'configure_timer'); configured.push(args.input); return {};
    } } };
    // The mocked Settings boundary delivers the same rollback order as its real unmount cleanup.
    controls.onUpdateSettings({ ...controls.settings, cameraLockEnabled: false });
    controls.onCameraAccessPendingChange(false); await h.settle();
    assert.equal(configured.length, 1); assert.equal(configured[0].cameraLockEnabled, false);
    assert.equal(configured[0].idleThresholdSeconds, 180);
    assert.equal(JSON.parse(h.store.get('myeyes_settings_v1')).cameraLockEnabled, false);
  } finally { window.__TAURI__ = original; if (!destroyed) h.destroy(); }
});
