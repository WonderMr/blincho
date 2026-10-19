const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const repo = path.resolve(__dirname, '..');
const assetUrl = 'https://blincho.test/camera/';

function loadAdapter(tf, loadGraphModel, setWasmPaths) {
  const file = path.join(repo, 'src/utils/cameraModel.ts');
  const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/\r\n/g, '\n').replace(/^import .*;\n/gm, '').replace('export async function', 'async function');
  const module = { exports: {} };
  vm.runInNewContext(code + '\nmodule.exports = {loadPersonDetector};', { module, tf, loadGraphModel, setWasmPaths, URL, document: { baseURI: 'https://blincho.test/index.html' } }, { filename: file });
  return module.exports.loadPersonDetector;
}
function adapterHarness({ inference = async () => scoreTensor(), loadError, backendReady = true } = {}) {
  const calls = []; let disposed = 0; const tensors = new Set();
  const tensor = () => { const value = { dispose() { tensors.delete(value); } }; tensors.add(value); return value; };
  const tf = {
    env: () => ({ set: (...args) => calls.push(['flag', ...args]) }), async setBackend(name) { calls.push(['backend', name]); return backendReady; }, async ready() { calls.push(['ready']); },
    browser: { fromPixels: image => { calls.push(['pixels', image]); return tensor(); } },
    expandDims: () => tensor(), tidy(fn) { const prior = new Set(tensors); const value = fn(); for (const item of tensors) if (!prior.has(item) && item !== value) item.dispose(); return value; },
    dispose(value) { if (Array.isArray(value)) value.forEach(item => item.dispose()); else value?.dispose(); },
  };
  const graph = { async executeAsync(...args) { calls.push(['execute', ...args]); return inference(); }, dispose() { disposed++; } };
  async function loadGraphModel(url) { calls.push(['model', url]); if (loadError) throw loadError; return graph; }
  return { load: loadAdapter(tf, loadGraphModel, prefix => calls.push(['paths', prefix])), calls, tensors, get disposed() { return disposed; } };
}
function scoreTensor(person = 0, other = 0.9, dataError) {
  const values = new Array(1917 * 90).fill(0); values[0] = person; values[1] = other;
  let disposed = 0;
  return { dtype: 'float32', shape: [1, 1917, 90], async data() { if (dataError) throw dataError; return values; }, dispose() { disposed++; }, get disposed() { return disposed; } };
}

test('adapter selects local WASM assets and keeps only person scores at the original threshold', async () => {
  const canvas = {}; const output = scoreTensor(0.35);
  const h = adapterHarness({ inference: async () => output }); const detector = await h.load();
  assert.deepEqual(h.calls.slice(0, 5), [['flag', 'WASM_HAS_MULTITHREAD_SUPPORT', false], ['paths', assetUrl], ['backend', 'wasm'], ['ready'], ['model', `${assetUrl}model.json`]]);
  assert.deepEqual(JSON.parse(JSON.stringify(await detector.detect(canvas))), { detections: [{ categories: [{ categoryName: 'person', score: 0.35 }] }] });
  assert.equal(h.calls.at(-1)[2], 'Postprocessor/Slice'); assert.equal(h.tensors.size, 0); assert.equal(output.disposed, 1);
  detector.close(); detector.close(); assert.equal(h.disposed, 1); await assert.rejects(detector.detect(canvas), /closed/);
  const chair = adapterHarness({ inference: async () => scoreTensor(0.34, 0.99) }); const onlyChair = await chair.load();
  assert.equal((await onlyChair.detect(canvas)).detections.length, 0); onlyChair.close();
});
test('close defers disposal until pending inference settles, including failed inference', async () => {
  for (const fails of [false, true]) {
    let finish;
    const h = adapterHarness({ inference: () => new Promise((resolve, reject) => { finish = () => fails ? reject(Error('inference failed')) : resolve(scoreTensor()); }) });
    const detector = await h.load(); const pending = detector.detect({});
    detector.close(); detector.close(); assert.equal(h.disposed, 0); assert.equal(h.tensors.size, 1); finish();
    if (fails) await assert.rejects(pending, /inference failed/); else await pending;
    assert.equal(h.tensors.size, 0); assert.equal(h.disposed, 1); detector.close(); assert.equal(h.disposed, 1);
  }
});
test('score read/shape failures reclaim inputs and outputs without establishing absence', async () => {
  for (const output of [scoreTensor(0, 0, Error('score read failed')), { ...scoreTensor(), shape: [1, 1, 90] }, { ...scoreTensor(), async data() { return []; } }, scoreTensor(NaN), scoreTensor(2)]) {
    const h = adapterHarness({ inference: async () => output }); const detector = await h.load();
    await assert.rejects(detector.detect({}), /score/); assert.equal(h.tensors.size, 0); detector.close(); assert.equal(h.disposed, 1);
  }
});
test('model loading failure preserves its error and failed WASM initialization never loads a model', async () => {
  const error = Error('model unavailable'); const h = adapterHarness({ loadError: error });
  await assert.rejects(h.load(), value => value === error); assert.equal(h.disposed, 0); assert.equal(h.tensors.size, 0);
  const failed = adapterHarness({ backendReady: false }); await assert.rejects(failed.load(), /WASM runtime unavailable/);
  assert(!failed.calls.some(call => call[0] === 'model')); assert.equal(failed.disposed, 0);
});
test('rejected graph execution reclaims real TensorFlow input tensors', async () => {
  const tf = require('@tensorflow/tfjs-core'); require('@tensorflow/tfjs-backend-cpu'); require('@tensorflow/tfjs-backend-wasm');
  await tf.setBackend('cpu'); const before = tf.memory(); const error = Error('graph execution rejected'); let disposed = 0;
  const graph = { async executeAsync(input) { assert.deepEqual(input.shape, [1, 240, 320, 3]); throw error; }, dispose() { disposed++; } };
  const load = loadAdapter({ ...tf, async setBackend() { return true; } }, async () => graph, () => {});
  const detector = await load(); const canvas = { width: 320, height: 240, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(320 * 240 * 4) }) }) };
  await assert.rejects(detector.detect(canvas), value => value === error); detector.close();
  assert.equal(disposed, 1); assert.equal(tf.memory().numTensors, before.numTensors); assert.equal(tf.memory().numBytes, before.numBytes);
});

function asyncCameraHarness() {
  const file = path.join(repo, 'src/utils/cameraPresence.ts');
  const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/^import .*;\n/gm, '').replace(/export (const|function) /g, '$1 ');
  const module = { exports: {} }; const timers = new Map(); let id = 0, now = 0, closed = 0, calls = 0, settleInference;
  vm.runInNewContext(code + '\nmodule.exports={createCameraPresenceChecker};', { module, trackCameraStream: () => () => {}, console: { warn() {} }, setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimeout: key => timers.delete(key) });
  const track = { readyState: 'live', muted: false, stop() { this.readyState = 'ended'; } };
  const pixels = Uint8ClampedArray.from([20, 40, 60, 255, 90, 120, 140, 255]);
  let frameTime = 0;
  const check = module.exports.createCameraPresenceChecker({
    mediaDevices: () => ({ async getUserMedia() { return { getTracks: () => [track], getVideoTracks: () => [track] }; } }),
    createVideo: () => ({ readyState: 4, videoWidth: 320, videoHeight: 240, get currentTime() { return ++frameTime; }, async play() {}, pause() {} }),
    createCanvas: () => ({ getContext: () => ({ drawImage() { pixels[0]++; }, getImageData: () => ({ data: pixels }) }) }),
    async loadDetector() { return { detect: () => { calls++; return new Promise(resolve => { settleInference = resolve; }); }, close() { closed++; } }; },
    now: () => now,
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { check, settle, track, get closed() { return closed; }, get calls() { return calls; },
    finish: result => settleInference(result), async frame() { await settle(); const entry = [...timers].find(([, timer]) => timer.delay === 400); assert(entry); timers.delete(entry[0]); now += 400; entry[1].fn(); await settle(); },
  };
}
test('cancellation discards an async absence result and closes the detector once', async () => {
  const h = asyncCameraHarness(); const abort = new AbortController(); const pending = h.check(abort.signal);
  await h.frame(); assert.equal(h.calls, 1); abort.abort(); assert.equal(await pending, 'unavailable');
  assert.equal(h.closed, 1); h.finish({ detections: [] }); await h.settle(); assert.equal(h.calls, 1); assert.equal(h.closed, 1);
});
test('async detections preserve the person boundary and require three healthy empty frames', async () => {
  const h = asyncCameraHarness(); const pending = h.check();
  await h.frame(); h.finish({ detections: [{ categories: [{ categoryName: 'person', score: 0.34 }] }] }); await h.settle();
  await h.frame(); h.finish({ detections: [] }); await h.settle();
  await h.frame(); h.finish({ detections: [] }); assert.equal(await pending, 'absent'); assert.equal(h.calls, 3); assert.equal(h.closed, 1);
  const person = asyncCameraHarness(); const present = person.check(); await person.frame();
  person.finish({ detections: [{ categories: [{ categoryName: 'person', score: 0.35 }] }] }); assert.equal(await present, 'present'); assert.equal(person.closed, 1);
});

test('a track ending or muting during the third async inference cannot establish absence', async () => {
  for (const failed of ['ended', 'muted']) {
    const h = asyncCameraHarness(); const pending = h.check();
    for (let i = 0; i < 2; i++) { await h.frame(); h.finish({ detections: [] }); await h.settle(); }
    await h.frame(); if (failed === 'ended') h.track.readyState = 'ended'; else h.track.muted = true;
    h.finish({ detections: [] }); assert.equal(await pending, 'unavailable'); assert.equal(h.calls, 3); assert.equal(h.closed, 1);
  }
});

test('bundled portable WASM executes the actual offline model without WebGL or camera access', { timeout: 30_000 }, async () => {
  const tf = require('@tensorflow/tfjs-core');
  const { loadGraphModel } = require('@tensorflow/tfjs-converter');
  const wasm = require('@tensorflow/tfjs-backend-wasm');
  const originalFetch = global.fetch; const requests = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'public/camera/model.json'), 'utf8'));
  const allowed = new Set(['model.json', ...manifest.weightsManifest.flatMap(group => group.paths)]);
  global.fetch = async (url, options) => {
    assert.equal(options?.method ?? 'GET', 'GET');
    assert(String(url).startsWith(assetUrl), `only local bundled assets may be read: ${url}`);
    const name = String(url).slice(assetUrl.length); assert(allowed.has(name)); requests.push(name);
    return new Response(fs.readFileSync(path.join(repo, 'public/camera', name)), { status: 200 });
  };
  // Exercise the portable binary used when a native webview lacks SIMD.
  tf.env().set('WASM_HAS_SIMD_SUPPORT', false);
  let detector;
  try {
    const load = loadAdapter(tf, loadGraphModel, prefix => { assert.equal(prefix, assetUrl); wasm.setWasmPaths(path.join(repo, 'public/camera') + path.sep); });
    detector = await load(); assert.equal(tf.getBackend(), 'wasm'); assert.equal(tf.findBackend('webgl'), null);
    const width = 320, height = 240, pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = (i / 4) % 255; pixels[i + 1] = 80; pixels[i + 2] = 160; pixels[i + 3] = 255; }
    const canvas = { width, height, getContext(type) { assert.equal(type, '2d', 'inference cannot request WebGL'); return { getImageData: () => ({ data: pixels }) }; } };
    const result = await detector.detect(canvas); assert(Array.isArray(result.detections)); assert.equal(result.detections.length, 0);
    assert.equal(tf.getBackend(), 'wasm'); assert.deepEqual(requests.sort(), [...allowed].sort());
    detector.close(); detector.close(); detector = undefined; assert.equal(tf.memory().numTensors, 0);
  } finally { detector?.close(); global.fetch = originalFetch; }
});
