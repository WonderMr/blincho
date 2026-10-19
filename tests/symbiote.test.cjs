const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { React, transformer } = require('./support/syntheticDom.cjs');
const { renderToStaticMarkup } = require('react-dom/server');
const repo = path.resolve(__dirname, '..');
const cache = new Map();
const navigatorStub = { mediaDevices: undefined };
function load(relative) {
  const file = path.resolve(repo, relative);
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const transformed = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const names = [...transformed.matchAll(/export (?:const|function|class|async function) (\w+)/g)].map(match => match[1]);
  const source = transformed.replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g, (_, bindings, name) => {
    const named = bindings.match(/\{([\s\S]*?)\}/)?.[1], defaultName = bindings.split(',')[0].trim();
    return `${!defaultName.startsWith('{') ? `const ${defaultName}=require(${JSON.stringify(name)});` : ''}${named ? `const {${named.replace(/\s+as\s+/g, ':')}}=require(${JSON.stringify(name)});` : ''}`;
  }).replace(/export (const|function|class|async function) /g, '$1 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
  const requireLocal = name => name === 'react' ? React : name.startsWith('.')
    ? load(path.relative(repo, path.resolve(path.dirname(file), name) + (path.extname(name) ? '' : fs.existsSync(path.resolve(path.dirname(file), name) + '.ts') ? '.ts' : '.tsx')))
    : require(name);
  vm.runInNewContext(source, { module, require: requireLocal, console, window, navigator: navigatorStub, document, localStorage: window.localStorage }, { filename: file });
  return module.exports;
}
const { getSymbioteBuild, getSymbioteName, readSymbioteCapabilities, SYMBIOTE_PERKS } = load('src/utils/symbiote.ts');
const { DEFAULT_SETTINGS } = load('src/utils/storage.ts');
const { SymbioteIcon } = load('src/components/SymbioteIcon.tsx');
const { SymbioteBuildCard } = load('src/components/SymbioteBuildCard.tsx');
const all = { presence: true, lock: true, calls: true, input: true, mcp: true };
const none = { presence: false, lock: false, calls: false, input: false, mcp: false };
const translate = (key, variables = {}) => key.replace(/\{(\w+)\}/g, (_, name) => String(variables[name]));
const fromMask = mask => ({ ...DEFAULT_SETTINGS, enhancedPresenceEnabled: !!(mask & 1), cameraLockEnabled: !!(mask & 2),
  absenceLockEnabled: false, meetingHistoryEnabled: !!(mask & 4), inputActivityEnabled: !!(mask & 8), strictMode: !!(mask & 16), localMcpEnabled: !!(mask & 32) });

test('all 64 enabled-feature combinations have exact modules, distinct names and matching approved raster assets', () => {
  const names = new Set();
  for (let mask = 0; mask < 64; mask++) {
    const settings = fromMask(mask), before = JSON.stringify(settings);
    const build = getSymbioteBuild(settings, all);
    assert.equal(build.mask, mask);
    assert.equal(build.perks.length, mask.toString(2).replaceAll('0', '').length);
    assert.equal(JSON.stringify(settings), before, 'branding never changes consent or settings');
    names.add(getSymbioteName(mask, translate));
    for (const size of [40, 48, 128]) {
      const html = renderToStaticMarkup(React.createElement(SymbioteIcon, { mask, size }));
      assert(html.includes(`src="./symbiote/${mask.toString(16).padStart(2, '0')}.png"`));
      assert(html.includes(`data-symbiote-mask="${mask}"`));
      assert(!html.includes('<svg'), 'all surfaces use the same approved raster artwork');
    }
  }
  assert.equal(names.size, 64);
  assert.equal(getSymbioteName(0, translate), 'Блинчо');
  assert.equal(getSymbioteName(3, translate), 'Страж');
  assert.equal(getSymbioteName(12, translate), 'Аналитик');
  assert.equal(getSymbioteName(48, translate), 'Напарник');
  assert.equal(getSymbioteName(63, translate), 'Блинчиборг');
});

test('defaults, unsupported capabilities, stale child flags and pending camera consent cannot earn modules', () => {
  assert.equal(getSymbioteBuild(DEFAULT_SETTINGS, all).mask, 0, 'default call postponement is not call history');
  assert.equal(getSymbioteBuild({ ...DEFAULT_SETTINGS, absenceLockEnabled: true }, all).mask, 0);
  assert.equal(getSymbioteBuild({ ...fromMask(3), absenceLockEnabled: true }, all).perks.length, 2, 'lock policies count once');
  assert.equal(getSymbioteBuild(fromMask(63), all, true).mask, 60, 'camera request is not permission');
  assert.equal(getSymbioteBuild(fromMask(63), none).mask, 16, 'strict breaks also work in the browser');
  assert.equal(getSymbioteBuild(fromMask(8), { ...all, input: false }).mask, 0, 'unavailable or denied input is not active');
  assert.equal(getSymbioteBuild(fromMask(32), { ...all, mcp: false }).mask, 0);
  assert.equal(getSymbioteBuild({ ...DEFAULT_SETTINGS, cloudConnected: true }, all).mask, 0, 'no active cloud setting');
});

test('capability reads never request permissions, configure integrations or invoke the camera', () => {
  const oldApi = window.electronAPI, oldTauri = window.__TAURI__, oldMedia = navigatorStub.mediaDevices;
  const forbidden = () => { throw Error('Branding must be read-only'); };
  try {
    window.__TAURI__ = {};
    window.electronAPI = { meetingDetectionSupported: true, lockComputer: forbidden, configureLocalMcp: forbidden };
    navigatorStub.mediaDevices = { getUserMedia: forbidden };
    const supported = readSymbioteCapabilities(true);
    for (const key of Object.keys(all)) assert.equal(supported[key], true, key);
    assert.equal(readSymbioteCapabilities(false).input, false);
    window.__TAURI__ = undefined; window.electronAPI = undefined;
    for (const key of Object.keys(none)) assert.equal(readSymbioteCapabilities(true)[key], false, key);
  } finally { window.electronAPI = oldApi; window.__TAURI__ = oldTauri; navigatorStub.mediaDevices = oldMedia; }
});

test('all shipped portraits are distinct 256px PNGs with verified source and asset hashes', () => {
  const manifest = load('public/symbiote/manifest.json');
  const hashes = new Set();
  const layers = load('design/symbiote/layers.json');
  for (const source of ['base', 'master']) {
    const bytes = fs.readFileSync(path.join(repo, 'design/symbiote', layers[source]));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sources[source]);
  }
  assert.equal(manifest.variants.length, 64);
  for (let mask = 0; mask < 64; mask++) {
    const entry = manifest.variants[mask];
    assert.equal(entry.mask, mask);
    assert.deepEqual(entry.perks, Array.from(SYMBIOTE_PERKS.filter(perk => mask & perk.bit), perk => perk.id));
    const bytes = fs.readFileSync(path.join(repo, 'public/symbiote', entry.file));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 256); assert.equal(bytes.readUInt32BE(20), 256);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    hashes.add(entry.sha256);
  }
  assert.equal(hashes.size, 64);
});

test('document and notification icons share a bounded safe mask and reset to base', () => {
  const { getSymbioteIconPath, updateDocumentSymbioteIcon, getCurrentSymbioteIconPath } = load('src/utils/symbioteIcons.ts');
  const links = ['icon', 'apple-touch-icon'].map(rel => {
    const link = document.createElement('link'); link.setAttribute('rel', rel);
    document.documentElement.appendChild(link); return link;
  });
  try {
    for (const mask of [63, 1, 32, 16, 0]) {
      updateDocumentSymbioteIcon(mask);
      const expected = `./symbiote/${mask.toString(16).padStart(2, '0')}.png`;
      assert.equal(getCurrentSymbioteIconPath(), expected);
      for (const link of links) assert.equal(link.getAttribute('href'), expected);
    }
    for (const invalid of [-1, 64, NaN, Infinity, 1.5, '../secret']) {
      assert.equal(getSymbioteIconPath(invalid), './symbiote/00.png');
    }
  } finally { for (const link of links) link.parentNode.removeChild(link); }
});

test('every localized build name is complete, distinct and safe to interpolate in all 30 languages', () => {
  for (const file of fs.readdirSync(path.join(repo, 'src/i18n/locales')).filter(file => file.endsWith('.json'))) {
    const catalog = load('src/i18n/locales/' + file), names = new Set();
    const localized = (key, variables = {}) => {
      assert(Object.hasOwn(catalog, key), file + ': ' + key);
      return catalog[key].replace(/\{(\w+)\}/g, (_, name) => String(variables[name]));
    };
    for (let mask = 0; mask < 64; mask++) {
      const name = getSymbioteName(mask, localized);
      assert(name && !name.includes('undefined') && !/[{}\u2014\u2015]/.test(name), file + ': ' + mask);
      names.add(name);
    }
    assert.equal(names.size, 64, file + ' keeps all builds distinct');
  }
  const html = renderToStaticMarkup(React.createElement(SymbioteBuildCard, { build: getSymbioteBuild(fromMask(63), all) }));
  assert(html.includes('Блинчиборг')); assert(html.includes('Модули: 6 из 6'));
  assert(html.includes('Связь с помощником')); assert(!html.includes('облак'));
});

test('App updates both branding consumers immediately, persists choices and keeps timer progress', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness({}, false, true);
  let saved;
  try {
    await h.advance(10000); await h.call('Navbar', 'onOpenSettings');
    assert.equal(h.captured.Navbar.symbioteBuild.mask, 0);
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, strictMode: true });
    assert.equal(h.captured.Navbar.symbioteBuild.mask, 16);
    assert.equal(h.captured.SettingsModal.symbioteBuild.mask, 16);
    assert.equal(h.captured.TimerWidget.secondsRemaining, 1190);
    saved = JSON.parse(h.store.get('myeyes_settings_v1'));
    assert.equal(saved.strictMode, true); assert.equal(saved.localMcpEnabled, false);
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, strictMode: false });
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.equal(h.captured.Navbar.symbioteBuild.mask, 0);
    assert.equal(h.captured.SettingsModal.symbioteBuild.mask, 0);
  } finally { h.destroy(); }
  const restored = createHarness(saved, false, true);
  try { await restored.settle(); assert.equal(restored.captured.Navbar.symbioteBuild.mask, 16); }
  finally { restored.destroy(); }
});
