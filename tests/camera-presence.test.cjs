const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const { createHarness } = require('./app.test.cjs');
const repo = path.resolve(__dirname, '..');

function cameraHarness({ results = [[], [], []], black = false, cameraError, modelError, frozen = false, repeatedPixels = false, muted = false, missing = false, late = false } = {}) {
  const file = path.join(repo, 'src/utils/cameraPresence.ts');
  const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/export (const|function) /g, '$1 ');
  const module = { exports: {} }; const timers = new Map(); let next = 0, now = 0, time = 0, stopped = 0, closed = 0, detections = 0, acquisitions = 0, release;
  vm.runInNewContext(code + '\nmodule.exports={createCameraPresenceChecker,isUsableCameraFrame};', {
    module, console: { warn() {} }, setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
  }, { filename: file });
  const track = { readyState: 'live', muted, stop() { stopped++; this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const pixels = Uint8ClampedArray.from(black ? [0, 0, 0, 255, 0, 0, 0, 255] : [20, 40, 60, 255, 90, 120, 140, 255]);
  const check = module.exports.createCameraPresenceChecker({
    mediaDevices: () => missing ? undefined : { async getUserMedia(constraints) { acquisitions++; assert.equal(constraints.audio, false); if (cameraError) throw cameraError; if (late) await new Promise(resolve => { release = resolve; }); return stream; } },
    createVideo: () => ({ readyState: 4, videoWidth: 640, videoHeight: 480, get currentTime() { if (!frozen) time++; return time; }, async play() {}, pause() {} }),
    createCanvas: () => ({ getContext: () => ({ drawImage() { if (!black && !repeatedPixels) pixels[0]++; }, getImageData: () => ({ data: pixels }) }) }),
    async loadDetector() { if (modelError) throw modelError; return { detect() { const categories = results[detections++] ?? []; return { detections: categories.length ? [{ categories }] : [] }; }, close() { closed++; } }; },
    now: () => now,
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const frame = async () => { await settle(); const entry = [...timers].find(([, v]) => v.delay === 400); assert(entry); timers.delete(entry[0]); now += 400; entry[1].fn(); await settle(); };
  return { check, frame, settle, track, get stopped() { return stopped; }, get closed() { return closed; }, get detections() { return detections; }, get acquisitions() { return acquisitions; }, release: () => release(), async timeout() { await settle(); const entry = [...timers].find(([, v]) => v.delay === 15000); assert(entry); timers.delete(entry[0]); entry[1].fn(); await settle(); } };
}

test('three distinct healthy empty frames establish absence and release camera/model', async () => {
  const h = cameraHarness(); const pending = h.check(); await h.frame(); await h.frame(); await h.frame();
  assert.equal(await pending, 'absent'); assert.equal(h.detections, 3); assert(h.stopped > 0); assert.equal(h.closed, 1);
});
test('any detected person keeps the computer available even after empty frames', async () => {
  const h = cameraHarness({ results: [[], [{ categoryName: 'person', score: 0.9 }]] }); const pending = h.check(); await h.frame(); await h.frame();
  assert.equal(await pending, 'present'); assert.equal(h.closed, 1); assert(h.stopped > 0);
});
test('missing/denied camera, model failure, black/covered and muted camera never establish absence', async () => {
  for (const options of [{ missing: true }, { cameraError: Error('permission denied') }, { modelError: Error('WASM unavailable') }, { black: true }, { muted: true }]) {
    const h = cameraHarness(options); const pending = h.check(); await h.settle(); if (options.black) await h.frame();
    assert.equal(await pending, 'unavailable'); assert.equal(h.detections, 0); if (!options.missing && !options.cameraError) assert(h.stopped > 0);
  }
});
test('frozen video cannot be counted as three consecutive frames', async () => {
  const h = cameraHarness({ frozen: true }); const pending = h.check(); for (let i = 0; i < 10; i++) await h.frame();
  assert.equal(await pending, 'unavailable'); assert.equal(h.detections, 1); assert.equal(h.closed, 1);
});
test('repeated image content with advancing video timestamps cannot establish absence', async () => {
  const h = cameraHarness({ repeatedPixels: true }); const pending = h.check(); await h.frame(); await h.frame();
  assert.equal(await pending, 'unavailable'); assert.equal(h.detections, 1); assert.equal(h.closed, 1); assert(h.stopped > 0);
});
test('timeout stops a camera stream that arrives after the check has already ended', async () => {
  const h = cameraHarness({ late: true }); const pending = h.check(); await h.timeout(); assert.equal(await pending, 'unavailable');
  h.release(); await h.settle(); assert(h.stopped > 0); assert.equal(h.detections, 0);
});
test('cancellation closes resources and overlapping queries share one camera session', async () => {
  const h = cameraHarness(); const abort = new AbortController(); const pending = h.check(abort.signal); assert.equal(h.check(), pending);
  await h.settle(); abort.abort(); assert.equal(await pending, 'unavailable'); assert(h.stopped > 0); assert.equal(h.closed, 1); assert.equal(h.acquisitions, 1);
});

// App integration mocks only the camera boundary. It exercises timer state, lock
// requests, cancellation and fallback through the existing renderer harness.
test('camera absence at work expiry locks once, pauses timing and never credits a break', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let locks = 0, cameras = 0;
  h.electronAPI.lockComputer = async () => { locks++; await h.power('lock-screen'); return true; };
  h.setCameraCheck(async () => { cameras++; return 'absent'; });
  await h.settle(); await h.advance(1000); await h.advance(1000);
  assert.equal(cameras, 1); assert.equal(locks, 1); assert.equal(h.active.has('BreakOverlay'), false); assert.equal(h.captured.TimerWidget.phase, 'locked'); assert.equal(h.stats().breaksCompleted, 0); h.destroy();
});
test('present/unavailable camera and disabled option preserve the ordinary break', async () => {
  for (const [enabled, result] of [[true, 'present'], [true, 'unavailable'], [false, 'absent']]) {
    const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60, cameraLockEnabled: enabled }); let locks = 0, cameras = 0;
    h.electronAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(async () => { cameras++; return result; });
    await h.settle(); await h.advance(1000); assert.equal(locks, 0); assert.equal(cameras, Number(enabled)); assert.equal(h.active.has('BreakOverlay'), true); h.destroy();
  }
});
test('manual pause or disabled setting invalidates an in-flight camera decision', async () => {
  for (const action of ['pause', 'disable']) {
    const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let resolve, locks = 0;
    h.electronAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(() => new Promise(done => { resolve = done; }));
    await h.settle(); await h.advance(1000); assert(resolve);
    if (action === 'pause') await h.call('TimerWidget', 'onTogglePlay');
    else { await h.call('Navbar', 'onOpenSettings'); await h.call('SettingsModal', 'onUpdateSettings', { ...h.settings, cameraLockEnabled: false }); }
    resolve('absent'); await h.settle(); assert.equal(locks, 0); h.destroy();
  }
});
test('lock failure proceeds to a regular break without claiming the screen is locked', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); h.electronAPI.lockComputer = async () => { throw Error('lock failed'); }; h.setCameraCheck(async () => 'absent');
  await h.settle(); await h.advance(1000); assert.equal(h.active.has('BreakOverlay'), true); assert.equal(h.captured.TimerWidget.phase, 'break'); assert(h.warnings.some(args => args[0].includes('lock failed'))); h.destroy();
});
test('disable then reenable during post-camera presence sampling cancels the old absence decision', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let release, locks = 0;
  h.electronAPI.lockComputer = async () => { locks++; return true; };
  h.setCameraCheck(async () => { h.electronAPI.getPowerState = () => new Promise(resolve => { release = resolve; }); return 'absent'; });
  await h.settle(); await h.advance(1000); assert(release);
  await h.call('Navbar', 'onOpenSettings');
  await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: false });
  await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, cameraLockEnabled: true });
  h.electronAPI.getPowerState = async () => ({ suspended: false, locked: false });
  release({ suspended: false, locked: false }); await h.settle();
  assert.equal(locks, 0); h.destroy();
});
test('new input cancels an in-flight camera absence decision', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60 }); let resolve, locks = 0;
  h.electronAPI.lockComputer = async () => { locks++; return true; }; h.setCameraCheck(() => new Promise(done => { resolve = done; }));
  await h.settle(); await h.advance(1000); assert(resolve);
  await h.emit('mousemove'); resolve('absent'); await h.settle();
  assert.equal(locks, 0); assert.equal(h.active.has('BreakOverlay'), true); h.destroy();
});
