const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { React, ReactDOMClient, ReactDOM, doc, DOMNode, transformer } = require('./support/syntheticDom.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;
const repo = path.resolve(__dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness({ permission = 'default', enabled = false, request = async () => 'granted' } = {}) {
  const cache = new Map(), store = new Map(); let settings, updates = 0, requests = 0, delivered = 0, gesture = false;
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  localStorage.setItem('blincho-language-v1', JSON.stringify({ preference: 'ru', acknowledged: true }));
  const BrowserNotification = class {
    static permission = permission;
    static requestPermission() { assert(gesture, 'browser permission is requested synchronously from the user gesture'); requests++; return request(); }
    constructor() { delivered++; }
  };
  window.localStorage = localStorage; window.electronAPI = undefined; window.Notification = BrowserNotification;
  function load(relative) {
    const file = path.resolve(repo, relative); if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8')); if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports);
    let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
    const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(match => match[1]);
    source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
      .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");').replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
      .replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
    const requireLocal = name => name === 'react' ? React : name === 'lucide-react' ? new Proxy({}, { get: () => () => null }) :
      name.endsWith('/soundSynth') ? { soundSynth: { enabled: false, playZenBowl() {} } } :
        name.startsWith('.') ? load(path.relative(repo, path.resolve(path.dirname(file), name) + (path.extname(name) ? '' : fs.existsSync(path.resolve(path.dirname(file), name) + '.ts') ? '.ts' : '.tsx'))) : require(name);
    vm.runInNewContext(source, { module, require: requireLocal, console, window, Notification: BrowserNotification, navigator: {}, document: doc, HTMLElement: DOMNode, localStorage, AbortController }, { filename: file }); return module.exports;
  }
  const { SettingsModal } = load('src/components/SettingsModal.tsx'); settings = { ...load('src/utils/storage.ts').DEFAULT_SETTINGS, notificationsEnabled: enabled };
  const host = doc.createElement('div'); doc.body.appendChild(host); const root = ReactDOMClient.createRoot(host);
  const render = element => React.act(() => ReactDOM.flushSync(() => root.render(element)));
  const element = () => React.createElement(SettingsModal, { settings, onUpdateSettings(value) { settings = value; updates++; render(element()); }, onClose() { render(null); } });
  const props = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
  const find = id => host.querySelector(`[id="${id}"]`);
  const invoke = callback => { gesture = true; try { React.act(() => { ReactDOM.flushSync(callback); }); } finally { gesture = false; } };
  render(element());
  return { host, find, props, get settings() { return settings; }, get updates() { return updates; }, get requests() { return requests; }, get delivered() { return delivered; },
    get checked() { return props(find('notifications-enabled')).checked; }, setPermission(value) { BrowserNotification.permission = value; },
    change(id, value) { invoke(() => props(find(id)).onChange({ target: { checked: value, value } })); },
    test() { invoke(() => props(host.querySelectorAll('button').find(node => node.textContent === 'Проверить')).onClick()); },
    close() { invoke(() => props(host.querySelectorAll('button')[0]).onClick()); },
    async settle() { await React.act(async () => { await new Promise(resolve => setImmediate(resolve)); }); },
    destroy() { render(null); React.act(() => root.unmount()); doc.body.removeChild(host); delete window.Notification; } };
}

test('browser enabling requests permission from its gesture, persists only a grant and preserves concurrent edits', async () => {
  const pending = deferred(), h = harness({ request: () => pending.promise });
  try {
    h.change('notifications-enabled', true); assert.equal(h.requests, 1); assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, true);
    assert(h.host.textContent.includes('Проверка…')); h.change('work-minutes', '30'); h.setPermission('granted'); pending.resolve('granted'); await h.settle();
    assert.equal(h.settings.notificationsEnabled, true); assert.equal(h.checked, true); assert.equal(h.settings.workMinutes, 30);
    h.test(); await h.settle(); assert.equal(h.delivered, 1, 'the real notification dispatcher admits delivery after permission'); assert.equal(h.requests, 1);
  } finally { h.destroy(); }
});

for (const outcome of ['granted', 'denied', 'default']) test(`test then enable shares one permission request and applies a ${outcome} result`, async () => {
  const pending = deferred(), h = harness({ request: () => pending.promise });
  try {
    h.test(); assert.equal(h.requests, 1); assert.equal(h.checked, false); assert.equal(h.delivered, 0);
    h.change('notifications-enabled', true); assert.equal(h.requests, 1); assert.equal(h.checked, true);
    assert.equal(h.settings.notificationsEnabled, false); h.change('work-minutes', '30');
    h.setPermission(outcome); pending.resolve(outcome); await h.settle();
    assert.equal(h.requests, 1); assert.equal(h.settings.notificationsEnabled, outcome === 'granted');
    assert.equal(h.checked, outcome === 'granted'); assert.equal(h.settings.workMinutes, 30);
    assert.equal(h.delivered, outcome === 'granted' ? 1 : 0);
    assert(h.host.textContent.includes(outcome === 'granted' ? 'Уведомление отправлено' : 'Разрешение не получено'));
  } finally { h.destroy(); }
});

for (const action of ['off', 'close', 'unmount']) test(`${action} cancels both intents of a pending test then enable`, async () => {
  const pending = deferred(), h = harness({ request: () => pending.promise }); let destroyed = false;
  try {
    h.test(); h.change('notifications-enabled', true); assert.equal(h.requests, 1);
    if (action === 'off') h.change('notifications-enabled', false);
    if (action === 'close') h.close();
    if (action === 'unmount') { h.destroy(); destroyed = true; }
    const updates = h.updates; h.setPermission('granted'); pending.resolve('granted'); await h.settle();
    assert.equal(h.updates, updates); assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.delivered, 0);
  } finally { if (!destroyed) h.destroy(); }
});

test('a canceled shared request cannot save or send after a replacement starts', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const h = harness({ request: () => (++calls === 1 ? first : second).promise });
  try {
    h.test(); h.change('notifications-enabled', true); h.change('notifications-enabled', false);
    h.change('notifications-enabled', true); assert.equal(h.requests, 2);
    h.setPermission('granted'); first.resolve('granted'); await h.settle();
    assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, true); assert.equal(h.delivered, 0);
    assert(h.host.textContent.includes('Проверка…'));
    h.setPermission('denied'); second.resolve('denied'); await h.settle();
    assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, false); assert.equal(h.delivered, 0);
  } finally { h.destroy(); }
});

for (const outcome of ['denied', 'default']) test(`${outcome} permission keeps notifications off and explains the result`, async () => {
  const h = harness({ request: async () => { h.setPermission(outcome); return outcome; } });
  try {
    h.change('notifications-enabled', true); await h.settle(); assert.equal(h.requests, 1); assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, false);
    assert(h.host.textContent.includes('Разрешение не получено')); assert.equal(h.delivered, 0);
  } finally { h.destroy(); }
});

for (const permission of ['denied', 'default']) test(`saved enable with ${permission} browser permission is displayed inactive`, () => {
  const h = harness({ permission, enabled: true }); try { assert.equal(h.checked, false); assert.equal(h.requests, 0); } finally { h.destroy(); }
});

test('off cancels pending enable and late results cannot overwrite a replacement request', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const h = harness({ request: () => (++calls === 1 ? first : second).promise });
  try {
    h.change('notifications-enabled', true); h.change('notifications-enabled', false); assert.equal(h.checked, false);
    h.change('notifications-enabled', true); assert.equal(h.requests, 2); first.resolve('granted'); await h.settle();
    assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, true); assert(h.host.textContent.includes('Проверка…'));
    h.setPermission('denied'); second.resolve('denied'); await h.settle(); assert.equal(h.checked, false); assert.equal(h.settings.notificationsEnabled, false);
  } finally { h.destroy(); }
});

for (const action of ['off', 'close', 'unmount']) test(`${action} prevents a late permission grant from saving an enable`, async () => {
  const pending = deferred(), h = harness({ request: () => pending.promise }); let destroyed = false;
  try {
    h.change('notifications-enabled', true);
    if (action === 'off') h.change('notifications-enabled', false);
    if (action === 'close') h.close();
    if (action === 'unmount') { h.destroy(); destroyed = true; }
    const updates = h.updates; h.setPermission('granted'); pending.resolve('granted'); await h.settle();
    assert.equal(h.updates, updates); assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.delivered, 0);
  } finally { if (!destroyed) h.destroy(); }
});

test('permission rejection is reported and a canceled test cannot dispatch late', async () => {
  const rejected = deferred(), h = harness({ request: () => rejected.promise });
  try {
    h.change('notifications-enabled', true); rejected.reject(Error('permission failed')); await h.settle();
    assert.equal(h.settings.notificationsEnabled, false); assert.equal(h.checked, false); assert(h.host.textContent.includes('Не удалось отправить уведомление'));
  } finally { h.destroy(); }
  const pending = deferred(), testing = harness({ request: () => pending.promise });
  try {
    testing.test(); testing.change('notifications-enabled', false); testing.setPermission('granted'); pending.resolve('granted'); await testing.settle();
    assert.equal(testing.delivered, 0); assert.equal(testing.settings.notificationsEnabled, false);
  } finally { testing.destroy(); }
});
