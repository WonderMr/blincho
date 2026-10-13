// Actual startup, bridge, import and recovery UI source with a synthetic DOM and isolated stores.
// Native windows, Electron profiles and OS behavior are outside this test boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const { renderToStaticMarkup } = require('react-dom/server');
const { React, ReactDOMClient, ReactDOM, doc } = require('./support/syntheticDom.cjs');
const repo = path.resolve(__dirname, '..');
const marker = 'myeyes_tauri_import_v1', pending = 'myeyes_tauri_import_pending_v1';
const snapshot = { schemaVersion: 1, exportedAt: '2026-10-12T12:00:00Z', entries: {
  myeyes_settings_v1: '{"workMinutes":30}', myeyes_stats_v1: '[{"date":"2026-10-11","breaksCompleted":4}]',
  'blincho-language-v1': '{"preference":"es","acknowledged":true}',
} };

function createStore(initial = []) {
  const map = new Map(initial), changes = [];
  let failRead = false, failChoiceWrite = false, failNextHistoryWrite = false;
  return {
    map, changes,
    get length() { if (failRead) throw Error('Storage unavailable'); return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem(key) { if (failRead) throw Error('Storage unavailable'); return map.get(key) ?? null; },
    setItem(key, value) {
      if (failChoiceWrite && key === 'blincho-tauri-history-choice-v1') throw Error('Choice storage unavailable');
      if (failNextHistoryWrite && key === 'myeyes_stats_v1') { failNextHistoryWrite = false; throw Error('Import quota exceeded'); }
      changes.push(['set', key]); map.set(key, value);
    },
    removeItem(key) { changes.push(['remove', key]); map.delete(key); },
    denyReads(value) { failRead = value; },
    denyChoiceWrite(value) { failChoiceWrite = value; },
    failHistoryWrite() { failNextHistoryWrite = true; },
  };
}

function harness({ store = createStore(), source = () => Promise.resolve(snapshot), runtime = 'tauri', platform = 'darwin', listenFailure, timers } = {}) {
  const cache = new Map(), calls = [], native = new Map(), listenCounts = new Map(), windowEvents = new Map();
  let readSource = source, appMounts = 0, rootCount = 0, root;
  const host = doc.createElement('div'); doc.body.appendChild(host);
  doc.documentElement.dataset = {};
  doc._listeners = new Map();
  doc.getElementById = id => id === 'root' ? host : null;
  window.localStorage = store;
  window.matchMedia = () => ({ matches: false });
  window.addEventListener = (name, callback) => {
    if (!windowEvents.has(name)) windowEvents.set(name, new Set());
    windowEvents.get(name).add(callback);
  };
  window.dispatchEvent = event => { for (const callback of windowEvents.get(event.type) || []) callback(event); };
  window.__TAURI__ = runtime === 'tauri' ? {
    core: { async invoke(command, args) {
      calls.push([command, args]);
      if (command === 'legacy_history') return readSource();
      if (command === 'preferred_languages') return ['en-US'];
      if (command === 'desktop_info') return { platform, meetingDetectionSupported: platform !== 'linux' };
    } },
    event: { async listen(name, callback) {
      listenCounts.set(name, (listenCounts.get(name) || 0) + 1);
      if (listenFailure?.(name)) throw Error('Subscription failed');
      if (!native.has(name)) native.set(name, new Set());
      native.get(name).add(callback);
      return () => native.get(name).delete(callback);
    } },
    window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },
  } : undefined;
  window.electronAPI = runtime === 'electron' ? { isElectron: true, exportLegacyHistory: async () => {} } : undefined;
  function SyntheticApp() {
    React.useEffect(() => {
      appMounts++;
      if (!store.getItem('myeyes_settings_v1')) store.setItem('myeyes_settings_v1', '{"workMinutes":20}');
    }, []);
    return React.createElement('div', { 'data-testid': 'app' }, 'normal app');
  }
  function load(file) {
    if (file.endsWith('.css')) return {};
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env.PROD', 'false').replaceAll('import.meta.env.BASE_URL', "'/'");
    let source = transformSync(file, code, { jsx: { runtime: 'classic' } }).code;
    const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
    source = source.replace(/import\s+["'][^"']+\.css["'];/g, '').replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g, (_all, binding, name) => {
      const named = binding.match(/\{([\s\S]*?)\}/)?.[1], defaultName = binding.split(',')[0].trim();
      return (!defaultName.startsWith('{') ? `const ${defaultName}=require(${JSON.stringify(name)}).default ?? require(${JSON.stringify(name)});` : '') +
        (named ? `const {${named.replace(/\s+as\s+/g, ':')}}=require(${JSON.stringify(name)});` : '');
    }).replace(/import\s+["'][^"']+\.css["'];/g, '').replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
    const requireLocal = name => {
      if (name === 'react') return React;
      if (name === 'react-dom/client') return { createRoot(element) {
        rootCount++; root = ReactDOMClient.createRoot(element);
        return { render: value => ReactDOM.flushSync(() => root.render(value)) };
      } };
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name === './App') return SyntheticApp;
      const base = path.resolve(path.dirname(file), name);
      return load(path.extname(base) ? base : fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
    };
    vm.runInNewContext(source, {
      module, exports: module.exports, require: requireLocal, React, window, document: doc, localStorage: store,
      navigator: { languages: ['en-US'], language: 'en-US' }, StorageEvent: class { constructor(type, values) { this.type = type; Object.assign(this, values); } },
      console: { error() {}, warn() {}, log() {} }, setTimeout: timers?.setTimeout || setTimeout,
      clearTimeout: timers?.clearTimeout || clearTimeout, TextEncoder, Error,
    }, { filename: file });
    return module.exports;
  }
  async function settle() {
    for (let index = 0; index < 40; index++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    ReactDOM.flushSync(() => {});
  }
  return {
    store, host, calls, native, listenCounts, windowEvents, load,
    get appMounts() { return appMounts; }, get rootCount() { return rootCount; },
    setSource(value) { readSource = value; }, settle,
    async start() { load(path.join(repo, 'src/main.tsx')); await settle(); },
    async click(label, twice = false) {
      const button = host.querySelectorAll('button').find(node => node.textContent === label);
      assert(button, `button ${label}`);
      const props = button[Object.keys(button).find(key => key.startsWith('__reactProps'))];
      ReactDOM.flushSync(() => { props.onClick(); if (twice) props.onClick(); });
      await settle();
    },
    destroy() { if (root) ReactDOM.flushSync(() => root.unmount()); doc.body.removeChild(host); window.__TAURI__ = undefined; window.electronAPI = undefined; },
  };
}

test('source failure reaches localized recovery before App writes, and repaired retry imports once without extra subscriptions', async () => {
  const oldSource = structuredClone(snapshot), original = JSON.stringify(oldSource);
  const h = harness({ source: async () => { throw Error('<img src=x onerror=alert(1)> source failed'); } });
  try {
    await h.start();
    assert(h.host.textContent.includes('Could not import history'));
    assert(h.host.textContent.includes('Close the old Blincho app (Electron)'));
    assert.equal(h.host.querySelectorAll('img').length, 0, 'untrusted source detail is text');
    assert.equal(h.appMounts, 0); assert.equal(h.rootCount, 1); assert.deepEqual(h.store.changes, []);
    assert.equal(h.store.getItem(marker), null); assert.equal(h.store.getItem(pending), null);
    const bridge = h.load(path.join(repo, 'src/utils/tauriBridge.ts'));
    await Promise.all([bridge.initializeTauriBridge(), bridge.initializeTauriBridge()]);
    let frames = 0;
    const unsubscribe = bridge.subscribeNativeTimer(() => frames++);
    h.setSource(async () => oldSource);
    await h.click('Retry import', true);
    assert(h.appMounts > 0); assert.equal(h.rootCount, 1);
    assert.equal(h.store.getItem('myeyes_stats_v1'), snapshot.entries.myeyes_stats_v1);
    assert.equal(h.store.getItem('blincho-language-v1'), snapshot.entries['blincho-language-v1']);
    assert(h.store.getItem(marker)); assert.equal(h.store.getItem(pending), null);
    assert.equal(h.calls.filter(([name]) => name === 'legacy_history').length, 2);
    assert.deepEqual([...h.listenCounts], [['native-timer', 1], ['update-state', 1], ['trigger-break', 1]]);
    assert.equal(doc._listeners.get('click').size, 1); assert.equal(doc._listeners.get('mousedown').size, 1);
    for (const callback of h.native.get('native-timer')) callback({ payload: { tickCount: 1 } });
    assert.equal(frames, 1); unsubscribe();
    assert.equal(h.windowEvents.get('languagechange').size, 1); assert.equal(h.windowEvents.get('storage').size, 1);
    assert.equal(JSON.stringify(oldSource), original, 'original legacy snapshot is untouched');
  } finally { h.destroy(); }
});

test('Continue persists a scoped decision before App mounts and future startup preserves new history without reading a broken source', async () => {
  const store = createStore(), h = harness({ store, source: async () => { throw Error('Source unavailable'); } });
  let choiceKey;
  try {
    await h.start(); assert.equal(h.appMounts, 0);
    choiceKey = h.load(path.join(repo, 'src/utils/historyRecovery.ts')).HISTORY_CHOICE_KEY;
    await h.click('Continue without history');
    assert(h.appMounts > 0);
    assert.equal(store.changes[0][1], choiceKey, 'choice commits before App defaults');
    assert.deepEqual(JSON.parse(store.getItem(choiceKey)), { schemaVersion: 1, source: 'electron-legacy-history', choice: 'continue-without-history' });
    assert.equal(store.getItem(marker), null); assert.equal(store.getItem(pending), null);
    store.setItem('myeyes_stats_v1', '[{"date":"2026-10-12","breaksCompleted":1}]');
  } finally { h.destroy(); }
  const restarted = harness({ store, source: async () => { throw Error('Still unavailable'); } });
  try {
    await restarted.start(); assert(restarted.appMounts > 0);
    assert.equal(restarted.calls.filter(([name]) => name === 'legacy_history').length, 0);
    assert.equal(store.getItem('myeyes_stats_v1'), '[{"date":"2026-10-12","breaksCompleted":1}]');
  } finally { restarted.destroy(); }
});

test('a failed Continue write leaves recovery open and App unmounted', async () => {
  const store = createStore(); store.denyChoiceWrite(true);
  const h = harness({ store, source: async () => { throw Error('Source unavailable'); } });
  try {
    await h.start(); await h.click('Continue without history');
    assert.equal(h.appMounts, 0); assert.deepEqual(store.changes, []);
    assert(h.host.textContent.includes('Choice storage unavailable'));
    store.denyChoiceWrite(false); await h.click('Continue without history'); assert(h.appMounts > 0);
  } finally { h.destroy(); }
});

test('healthy imported and existing profiles open without reading legacy source or modifying history', async () => {
  for (const initial of [
    [[marker, '{}'], ['myeyes_stats_v1', 'healthy']],
    [['myeyes_stats_v1', 'healthy']],
  ]) {
    const h = harness({ store: createStore(initial), source: async () => { throw Error('Broken old source'); } });
    try {
      await h.start(); assert(h.appMounts > 0);
      assert.equal(h.calls.filter(([name]) => name === 'legacy_history').length, 0);
      assert.equal(h.store.getItem('myeyes_stats_v1'), 'healthy');
    } finally { h.destroy(); }
  }
});

test('unreadable or invalid sources preserve an interrupted import journal until a valid retry', async () => {
  for (const failedSource of [
    async () => { throw Error('Source read failed'); },
    async () => ({ ...snapshot, entries: { myeyes_stats_v1: 'invalid JSON' } }),
  ]) {
    const initial = [[pending, '["myeyes_settings_v1"]'], ['myeyes_settings_v1', '{"partial":true}']];
    const store = createStore(initial), h = harness({ store, source: failedSource });
    try {
      await h.start(); assert.equal(h.appMounts, 0); assert.deepEqual([...store.map], initial); assert.deepEqual(store.changes, []);
      h.setSource(async () => snapshot); await h.click('Retry import');
      assert(h.appMounts > 0); assert.equal(store.getItem(pending), null); assert(store.getItem(marker));
    } finally { h.destroy(); }
  }
});

test('storage read failure shows recovery and a repaired retry can open the app', async () => {
  const store = createStore(); store.denyReads(true);
  const h = harness({ store });
  try {
    await h.start(); assert.equal(h.appMounts, 0); assert.deepEqual(store.changes, []);
    assert(h.host.textContent.includes('Storage unavailable'));
    store.denyReads(false); await h.click('Retry import'); assert(h.appMounts > 0);
  } finally { h.destroy(); }
});

test('a failed import write rolls back its transaction and a repaired retry imports before App mounts', async () => {
  const store = createStore([['unrelated', 'preserved']]); store.failHistoryWrite();
  const h = harness({ store });
  try {
    await h.start(); assert.equal(h.appMounts, 0);
    assert(h.host.textContent.includes('Import quota exceeded'));
    assert.deepEqual([...store.map], [['unrelated', 'preserved']]);
    assert.equal(store.getItem(marker), null); assert.equal(store.getItem(pending), null);
    await h.click('Retry import'); assert(h.appMounts > 0);
    assert.equal(store.getItem('myeyes_stats_v1'), snapshot.entries.myeyes_stats_v1);
  } finally { h.destroy(); }
});

test('an invalid pending journal stays unchanged on import failure and explicit Continue prevents a later journal rollback of new history', async () => {
  const initial = [[pending, '{invalid journal}']], store = createStore(initial), h = harness({ store });
  try {
    await h.start(); assert.equal(h.appMounts, 0); assert.deepEqual([...store.map], initial); assert.deepEqual(store.changes, []);
    await h.click('Continue without history'); assert(h.appMounts > 0);
    store.setItem('myeyes_stats_v1', 'new history');
  } finally { h.destroy(); }
  const restarted = harness({ store });
  try {
    await restarted.start(); assert(restarted.appMounts > 0);
    assert.equal(store.getItem('myeyes_stats_v1'), 'new history'); assert.equal(store.getItem(pending), '{invalid journal}');
    assert.equal(restarted.calls.filter(([name]) => name === 'legacy_history').length, 0);
  } finally { restarted.destroy(); }
});

test('bridge setup cleans up partial listeners and successful repeated initialization registers exactly once', async () => {
  let fail = true;
  const h = harness({ listenFailure: name => name === 'update-state' && fail });
  try {
    const bridge = h.load(path.join(repo, 'src/utils/tauriBridge.ts'));
    await assert.rejects(bridge.initializeTauriBridge(), /Subscription failed/);
    assert.equal(h.native.get('native-timer').size, 0);
    fail = false; await Promise.all([bridge.initializeTauriBridge(), bridge.initializeTauriBridge()]);
    for (const name of ['native-timer', 'update-state', 'trigger-break']) assert.equal(h.native.get(name).size, 1);
    assert.equal(doc._listeners.get('click').size, 1); assert.equal(doc._listeners.get('mousedown').size, 1);
  } finally { h.destroy(); }
});

test('recovery controls and bounded escaped details render in all 30 languages', () => {
  const h = harness();
  try {
    const { HistoryRecovery } = h.load(path.join(repo, 'src/components/HistoryRecovery.tsx'));
    const runtime = h.load(path.join(repo, 'src/i18n/runtime.ts'));
    const { historyErrorDetail } = h.load(path.join(repo, 'src/utils/historyRecovery.ts'));
    const error = '<script>alert(1)</script>' + '\u2014 \u2015 \u2013 ' + 'x'.repeat(1000);
    assert.equal(Array.from(historyErrorDetail(error)).length, 600);
    for (const language of runtime.SUPPORTED_LANGUAGES) {
      runtime.setLanguagePreference(language.code);
      const html = renderToStaticMarkup(React.createElement(HistoryRecovery, { error, onRetry: async () => {}, onContinue: async () => {} }));
      assert(html.includes(runtime.t('Повторить перенос')), language.code);
      assert(html.includes(runtime.t('Продолжить без истории')), language.code);
      assert(html.includes('Electron'), language.code);
      assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'));
      assert(!/[\u2014\u2015]|\s\u2013\s/.test(html), language.code);
    }
  } finally { h.destroy(); }
});

test('web and Electron startup still mounts App without invoking Tauri history or installing native listeners', async () => {
  for (const runtime of ['web', 'electron']) {
    const h = harness({ runtime });
    try {
      await h.start(); assert(h.appMounts > 0); assert.equal(h.rootCount, 1);
      assert.equal(h.calls.length, 0); assert.equal(h.listenCounts.size, 0);
      assert.equal(h.store.getItem('blincho-tauri-history-choice-v1'), null);
    } finally { h.destroy(); }
  }
});

test('legacy export scheduling is restricted to macOS Electron and coalesces startup requests', async () => {
  const scheduled = new Map(); let next = 0, exports = 0;
  const h = harness({ runtime: 'electron', timers: {
    setTimeout(callback, delay) { const id = ++next; scheduled.set(id, { callback, delay }); return id; },
    clearTimeout: id => scheduled.delete(id),
  } });
  try {
    const bridge = h.load(path.join(repo, 'src/utils/tauriBridge.ts'));
    for (const platform of [undefined, 'linux', 'win32']) {
      window.electronAPI.platform = platform; bridge.scheduleLegacyHistoryExport(); assert.equal(scheduled.size, 0);
    }
    window.electronAPI.platform = 'darwin'; window.electronAPI.exportLegacyHistory = async () => { exports++; };
    await h.start(); assert.equal(scheduled.size, 1); assert.equal([...scheduled.values()][0].delay, 300);
    [...scheduled.values()][0].callback(); await h.settle(); assert.equal(exports, 1);
    scheduled.clear(); window.__TAURI__ = {}; bridge.scheduleLegacyHistoryExport(); assert.equal(scheduled.size, 0);
  } finally { h.destroy(); }
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`Tauri bridge uses native ${platform} identity and capabilities`, async () => {
    const h = harness({ platform });
    try {
      const bridge = h.load(path.join(repo, 'src/utils/tauriBridge.ts'));
      await bridge.initializeTauriBridge();
      assert.equal(doc.documentElement.dataset.platform, platform);
      assert.equal(doc.documentElement.dataset.runtime, 'tauri');
      assert.equal(window.electronAPI.platform, platform);
      assert.equal(window.electronAPI.meetingDetectionSupported, platform !== 'linux');
    } finally { h.destroy(); }
  });
}
