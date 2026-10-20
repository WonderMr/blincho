const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
const repo = path.resolve(__dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function createSettingsHarness({ media, native = false, nativeReady = Promise.resolve({}), onPending, meetingSupported = true, platform = 'darwin' } = {}) {
  const cache = new Map(), store = new Map(); const navigator = { mediaDevices: media };
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  window.localStorage = localStorage; window.electronAPI = { isElectron: true, platform, meetingDetectionSupported: meetingSupported, lockComputer() { throw Error('Permission must not lock'); } };
  localStorage.setItem('blincho-language-v1', JSON.stringify({ preference: 'ru', acknowledged: true }));
  let settings, updates = 0, closed = 0, nativeReads = 0, alive = true; const pending = [];
  function load(relative) {
    const file = path.resolve(repo, relative); if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8')); if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
    const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
    source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
      .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");').replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
      .replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
    const requireLocal = name => name === 'react' ? React : name === 'lucide-react' ? new Proxy({}, { get: () => () => null }) :
      name.endsWith('/soundSynth') ? { soundSynth: { enabled: false, playZenBowl() {} } } : name.endsWith('/notifications') ? { requestNotificationPermission: async () => false, showEyeBreakNotification() {} } :
      name.endsWith('/tauriBridge') ? { hasNativeTimer: () => native, readNativeTimer: () => { nativeReads++; assert.equal(settings.cameraLockEnabled, true, 'native input enabled before queue is awaited'); return nativeReady; } } :
      name.startsWith('.') ? load(path.relative(repo, path.resolve(path.dirname(file), name) + (path.extname(name) ? '' : fs.existsSync(path.resolve(path.dirname(file), name) + '.ts') ? '.ts' : '.tsx'))) : require(name);
    vm.runInNewContext(source, { module, require: requireLocal, console, window, navigator, document: doc, HTMLElement: DOMNode, localStorage, AbortController }, { filename: file }); return module.exports;
  }
  const { SettingsModal } = load('src/components/SettingsModal.tsx'); settings = { ...load('src/utils/storage.ts').DEFAULT_SETTINGS };
  const host = doc.createElement('div'); doc.body.appendChild(host); const root = ReactDOMClient.createRoot(host);
  const element = () => React.createElement(SettingsModal, { settings, onUpdateSettings(value) { settings = value; updates++; if (alive) render(element()); },
    onCameraAccessPendingChange(value) { pending.push(value); onPending?.(value); }, onClose() { closed++; render(null); } });
  const render = element => ReactDOM.flushSync(() => root.render(element));
  const find = (id, node = host) => { if (node.getAttribute('id') === id) return node; for (const child of node.childNodes) { const found = find(id, child); if (found) return found; } };
  const props = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
  const change = (id, value) => ReactDOM.flushSync(() => props(find(id)).onChange({ target: { checked: value, value } }));
  render(element());
  return { host, pending, change, props, find, get settings() { return settings; }, get updates() { return updates; }, get closed() { return closed; }, get nativeReads() { return nativeReads; },
    async settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); ReactDOM.flushSync(() => {}); } await new Promise(resolve => setImmediate(resolve)); ReactDOM.flushSync(() => {}); },
    close(kind) { ReactDOM.flushSync(() => { if (kind === 'escape') doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
      else if (kind === 'backdrop') { const node = host.firstChild; props(node).onClick({ target: node, currentTarget: node }); }
      else props(host.querySelectorAll('button')[0]).onClick(); }); },
    destroy() { alive = false; ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); } };
}

test('manual enable requests permission immediately, shows feedback and stops tracks; saved opt-in requires no new probe on render', async () => {
  let calls = 0, stopped = 0; const h = createSettingsHarness({ media: { getUserMedia: async constraints => {
    calls++; assert.equal(h.pending.at(-1), true, 'expiry gated before media request'); assert.equal(constraints.audio, false);
    return { getTracks: () => [{ stop() { stopped++; } }] };
  } } });
  try {
    assert.equal(h.settings.cameraLockEnabled, false); assert.equal(calls, 0);
    assert(h.host.textContent.includes('При включении проверяется доступ к камере'));
    assert(h.host.textContent.includes('На macOS: Системные настройки'));
    h.change('camera-lock-enabled', true); assert(h.host.textContent.includes('Запрашиваем доступ к камере…'));
    await h.settle(); assert.equal(calls, 1); assert.equal(stopped, 1); assert.equal(h.settings.cameraLockEnabled, true);
    assert(h.host.textContent.includes('Доступ к камере разрешён.')); assert.deepEqual(h.pending, [true, false]);
    h.change('sound-volume', 35); await h.settle(); assert.equal(calls, 1, 'render with saved enable does not repeat the probe');
  } finally { h.destroy(); }
});

test('Linux native configuration completes before capture; denial preserves concurrent setting edits and keeps off', async () => {
  const native = deferred(), media = deferred(); let calls = 0, ready = false;
  const h = createSettingsHarness({ native: true, nativeReady: native.promise, media: { getUserMedia: () => { assert.equal(ready, true); calls++; return media.promise; } } });
  try {
    h.change('camera-lock-enabled', true); await h.settle(); assert.equal(h.nativeReads, 1); assert.equal(calls, 0);
    h.change('sound-volume', 35); ready = true; native.resolve({}); await h.settle(); assert.equal(calls, 1);
    h.change('work-minutes', '30'); media.reject({ name: 'NotAllowedError' }); await h.settle();
    assert.equal(h.settings.cameraLockEnabled, false); assert.equal(h.settings.soundVolume, 35); assert.equal(h.settings.workMinutes, 30); assert.equal(h.settings.timerPreset, 'custom');
    assert(h.host.textContent.includes('Доступ к камере не разрешён')); assert.deepEqual(h.pending, [true, false]);
  } finally { h.destroy(); }
});

test('unavailable camera and native configuration failure leave off with explanatory feedback', async () => {
  for (const failedNative of [false, true]) {
    let calls = 0;
    const h = createSettingsHarness({ native: failedNative, nativeReady: failedNative ? Promise.reject(Error('native unavailable')) : Promise.resolve({}), media: { getUserMedia: async () => { calls++; throw { name: 'NotFoundError' }; } } });
    try { h.change('camera-lock-enabled', true); await h.settle(); assert.equal(h.settings.cameraLockEnabled, false); assert.equal(calls, failedNative ? 0 : 1); assert(h.host.textContent.includes('Камера недоступна. Проверьте подключение')); }
    finally { h.destroy(); }
  }
});

test('toggle cancellation keeps off, shows feedback and ignores a late successful stream', async () => {
  const media = deferred(); let stopped = 0;
  const h = createSettingsHarness({ media: { getUserMedia: () => media.promise } });
  try {
    h.change('camera-lock-enabled', true); await h.settle(); h.change('sound-volume', 40); h.change('camera-lock-enabled', false);
    assert.equal(h.settings.cameraLockEnabled, false); assert.equal(h.settings.soundVolume, 40); assert(h.host.textContent.includes('Доступ к камере не разрешён'));
    const updates = h.updates; media.resolve({ getTracks: () => [{ stop() { stopped++; } }] }); await h.settle();
    assert.equal(stopped, 1); assert.equal(h.updates, updates); assert.equal(h.settings.cameraLockEnabled, false); assert.deepEqual(h.pending, [true, false]);
  } finally { h.destroy(); }
});

test('every modal close path and unmount roll back off; late streams stop without changing latest settings', async () => {
  for (const close of ['button', 'escape', 'backdrop', 'unmount']) {
    const media = deferred(); let stopped = 0; const h = createSettingsHarness({ media: { getUserMedia: () => media.promise } }); let destroyed = false;
    try {
      h.change('camera-lock-enabled', true); await h.settle(); h.change('sound-volume', 45);
      if (close === 'unmount') { h.destroy(); destroyed = true; } else h.close(close);
      assert.equal(h.settings.cameraLockEnabled, false); assert.equal(h.settings.soundVolume, 45); const updates = h.updates;
      media.resolve({ getTracks: () => [{ stop() { stopped++; } }] }); await h.settle();
      assert.equal(stopped, 1); assert.equal(h.updates, updates); assert.equal(h.settings.cameraLockEnabled, false); assert.deepEqual(h.pending, [true, false]);
      if (close !== 'unmount') assert.equal(h.closed, 1);
    } finally { if (!destroyed) h.destroy(); }
  }
});

test('cancel then reenable ignores the old response and only accepts the replacement permission request', async () => {
  const streams = [deferred(), deferred()]; let calls = 0, stopped = 0;
  const h = createSettingsHarness({ media: { getUserMedia: () => streams[calls++].promise } });
  try {
    h.change('camera-lock-enabled', true); await h.settle(); h.change('camera-lock-enabled', false); h.change('camera-lock-enabled', true); await h.settle(); assert.equal(calls, 2);
    streams[0].resolve({ getTracks: () => [{ stop() { stopped++; } }] }); await h.settle(); assert(h.host.textContent.includes('Запрашиваем доступ к камере…')); assert.equal(h.pending.at(-1), true);
    streams[1].reject({ name: 'NotAllowedError' }); await h.settle(); assert.equal(stopped, 1); assert.equal(h.settings.cameraLockEnabled, false); assert.equal(h.pending.at(-1), false);
  } finally { h.destroy(); }
});


test('camera locking is explicitly unavailable without call detection, including legacy Windows and Linux', async () => {
  for (const platform of ['win32', 'linux']) {
    let calls = 0;
    const h = createSettingsHarness({ platform, meetingSupported: false,
      media: { getUserMedia: async () => { calls++; return { getTracks: () => [] }; } } });
    try {
      assert.equal(h.props(h.find('camera-lock-enabled')).disabled, true);
      assert.equal(h.props(h.find('camera-lock-enabled')).checked, false);
      assert(h.host.textContent.includes('Детекция встреч недоступна'));
      h.change('camera-lock-enabled', true);
      await h.settle();
      assert.equal(calls, 0, 'unsupported configuration cannot request camera permission');
      assert.equal(h.settings.cameraLockEnabled, false);
    } finally { h.destroy(); }
  }
});
