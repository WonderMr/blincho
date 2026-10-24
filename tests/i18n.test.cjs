const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const repo = path.resolve(__dirname, '..');
const STORAGE_KEY = 'blincho-language-v1';

function runtimeHarness({ languages = [], language = '', storage = new Map(), storageError = false, bridge, dom = true, timers } = {}) {
  const events = new Map(), nativeUpdates = [];
  const window = {
    localStorage: {
      getItem(key) { if (storageError) throw Error('Storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageError) throw Error('Storage denied'); storage.set(key, value); },
    },
    addEventListener(name, listener) { events.set(name, listener); },
    ...(bridge ? { desktopAPI: { getPreferredLanguages: bridge, setLocale: value => { nativeUpdates.push(value); return Promise.resolve(); } } } : {}),
  };
  const navigator = { languages, language };
  const document = { documentElement: {} };
  const filename = path.join(repo, 'src/i18n/runtime.ts');
  const transformed = transformSync(filename, fs.readFileSync(filename, 'utf8')).code;
  const exports = [...transformed.matchAll(/export\s+(?:const|function)\s+(\w+)/g)].map(match => match[1]);
  const source = transformed.replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];/g, 'const $1 = require("$2");')
    .replace(/export (const|function) /g, '$1 ') + `\nObject.assign(module.exports,{${exports.join(',')}});`;
  const catalogs = {
    en: { 'Осталось {count}': '{count} remaining', 'Только английский': 'English fallback', 'Пусто': 'Empty fallback' },
    es: { 'Осталось {count}': 'Quedan {count}', 'Пусто': '' },
    ar: { 'Осталось {count}': 'متبقي {count}' },
    ru: { 'Осталось {count}': 'Осталось {count}' },
  };
  const module = { exports: {} };
  const context = {
    module, console, Intl, setTimeout: timers?.setTimeout || setTimeout, clearTimeout: timers?.clearTimeout || clearTimeout,
    require: name => catalogs[path.basename(name, '.json')] || {},
    ...(dom ? { window, navigator, document } : {}),
  };
  vm.runInNewContext(source, context, { filename });
  return { runtime: module.exports, window, navigator, document, storage, events, nativeUpdates };
}

test('language matching follows the entire ordered preference list and regional tags', () => {
  const { runtime } = runtimeHarness();
  assert.equal(runtime.SUPPORTED_LANGUAGES.length, 30);
  for (const [preferences, expected] of [
    [['xx-ZZ', 'fr-CA', 'de-DE'], 'fr'], [['es-MX'], 'es'], [['pt-PT'], 'pt'],
    [['zh-Hans-CN'], 'zh'], [['zh-TW'], 'zh'], [['EN_us'], 'en'], [['uk-UA'], 'uk'],
    [['hy-AM'], 'hy'], [['bn-BD'], 'bn'], [['ur-PK'], 'ur'], [['he-IL'], 'he'], [['fa_IR'], 'fa'], [['ta-IN'], 'ta'], [['te-IN'], 'te'], [['xx', 'zz'], 'en'], [[], 'en'], [[null, 123, 'ko-KR'], 'ko'],
  ]) assert.equal(runtime.resolveLocale(preferences), expected);
});

test('browser preferences initialize offline; selected/English/source fallbacks interpolate safely', async () => {
  const h = runtimeHarness({ languages: ['unknown', 'es-MX', 'ru'] });
  assert.equal(h.runtime.getLocale(), 'es');
  assert.equal(h.runtime.hasLanguageDecision(), false);
  assert.equal(h.runtime.getLanguagePreference(), 'auto');
  await h.runtime.initializeLanguage();
  assert.equal(h.document.documentElement.lang, 'es');
  assert.equal(h.runtime.t('Осталось {count}', { count: 12 }), 'Quedan 12');
  assert.equal(h.runtime.t('Только английский'), 'English fallback');
  assert.equal(h.runtime.t('Пусто'), 'Empty fallback');
  assert.equal(h.runtime.t('Неизвестно {value}', { value: '$& <tag>' }), 'Неизвестно $& <tag>');
  assert.equal(h.runtime.t('Осталось {count}'), 'Quedan {count}');
  assert.equal(h.runtime.t('toString'), 'toString');
});

test('manual and automatic decisions persist separately from timer/history data', async () => {
  const storage = new Map([['myeyes-storage', '{"timer":123,"history":[1]}']]);
  const h = runtimeHarness({ languages: ['fr-FR'], storage });
  await h.runtime.initializeLanguage();
  assert.equal(storage.has(STORAGE_KEY), false, 'automatic detection is not a recorded user decision');
  h.runtime.setLanguagePreference('ar');
  assert.equal(h.document.documentElement.dir, 'rtl');
  assert.equal(h.document.documentElement.lang, 'ar');
  assert.equal(h.runtime.hasLanguageDecision(), true);
  const restored = runtimeHarness({ languages: ['es'], storage });
  assert.equal(restored.runtime.getLocale(), 'ar');
  assert.equal(restored.runtime.hasLanguageDecision(), true);
  restored.runtime.setLanguagePreference('auto');
  assert.equal(restored.runtime.getLocale(), 'es');
  const automatic = runtimeHarness({ languages: ['de'], storage });
  assert.equal(automatic.runtime.getLanguagePreference(), 'auto');
  assert.equal(automatic.runtime.getLocale(), 'de');
  assert.equal(automatic.runtime.hasLanguageDecision(), true);
  assert.equal(storage.get('myeyes-storage'), '{"timer":123,"history":[1]}');
  assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), { preference: 'auto', acknowledged: true });
});

test('suggestion acknowledgement publishes even if effective locale stays unchanged', () => {
  const h = runtimeHarness({ languages: ['fr'] });
  let updates = 0;
  const unsubscribe = h.runtime.subscribeLanguage(() => updates++);
  h.runtime.acceptLanguageSuggestion();
  assert.equal(h.runtime.getLocale(), 'fr');
  assert.equal(h.runtime.getLanguagePreference(), 'fr');
  assert.equal(h.runtime.hasLanguageDecision(), true);
  assert.equal(updates, 1);
  unsubscribe(); h.runtime.setLanguagePreference('en');
  assert.equal(updates, 1);
  assert.equal(h.document.documentElement.dir, 'ltr');
});

test('all thirty locales persist, restore direction and synchronize with native menus', async () => {
  const locales = require('../src-tauri/locales.json');
  const initial = runtimeHarness();
  assert.deepEqual(Array.from(initial.runtime.SUPPORTED_LANGUAGES, item => item.code).sort(), Object.keys(locales).sort());
  for (const language of initial.runtime.SUPPORTED_LANGUAGES) {
    const storage = new Map();
    const h = runtimeHarness({ languages: ['en'], storage, bridge: () => Promise.resolve(['en']) });
    await h.runtime.initializeLanguage();
    h.runtime.setLanguagePreference(language.code);
    assert.equal(h.document.documentElement.lang, language.locale);
    assert.equal(h.document.documentElement.dir, ['ar','fa','ur','he'].includes(language.code) ? 'rtl' : 'ltr');
    assert.equal(h.nativeUpdates.at(-1), language.code);
    assert.equal(runtimeHarness({ languages: ['en'], storage }).runtime.getLocale(), language.code);
    assert.equal(h.runtime.resolveLocale([language.locale]), language.code);
  }
});

test('system preferences outrank browser and manual choice wins an asynchronous detection race', async () => {
  let resolve;
  const h = runtimeHarness({ languages: ['es'], bridge: () => new Promise(done => { resolve = done; }) });
  const initialized = h.runtime.initializeLanguage();
  await Promise.resolve();
  h.runtime.setLanguagePreference('uk');
  resolve(['unsupported', 'pt-BR', 'de']);
  await initialized;
  assert.equal(h.runtime.getLocale(), 'uk');
  assert.equal(h.runtime.getSuggestedLocale(), 'pt');
  h.runtime.setLanguagePreference('auto');
  assert.equal(h.runtime.getLocale(), 'pt');
  assert.equal(h.document.documentElement.lang, 'pt-BR');
  assert.equal(h.nativeUpdates.at(-1), 'pt');
  assert.equal(h.runtime.initializeLanguage(), initialized, 'initialization is idempotent');
});

test('detection failures, blocked/corrupt storage and missing DOM have safe defaults', async () => {
  for (const storageValue of ['malformed', '{"preference":"evil","acknowledged":true}', 'null']) {
    const h = runtimeHarness({ storage: new Map([[STORAGE_KEY, storageValue]]) });
    assert.equal(h.runtime.getLocale(), 'en');
    assert.equal(h.runtime.hasLanguageDecision(), false);
  }
  const denied = runtimeHarness({ storageError: true, languages: ['ja'] });
  assert.doesNotThrow(() => denied.runtime.setLanguagePreference('ko'));
  assert.equal(denied.runtime.getLocale(), 'ko');
  assert.throws(() => denied.runtime.setLanguagePreference('__proto__'), /Unsupported/);
  const broken = runtimeHarness({ languages: ['hi'], bridge: () => Promise.reject(Error('IPC failed')) });
  await broken.runtime.initializeLanguage();
  assert.equal(broken.runtime.getLocale(), 'hi');
  const absent = runtimeHarness({ dom: false });
  await absent.runtime.initializeLanguage();
  assert.equal(absent.runtime.getLocale(), 'en');
  assert.equal(absent.runtime.t('Только английский'), 'English fallback');
});

test('unresponsive native bridge has a bounded startup wait', async () => {
  let timeout;
  const h = runtimeHarness({ languages: ['it'], bridge: () => new Promise(() => {}), timers: {
    setTimeout(callback, ms) { assert.equal(ms, 1500); timeout = callback; return 1; }, clearTimeout() {},
  } });
  const initialized = h.runtime.initializeLanguage();
  timeout(); await initialized;
  assert.equal(h.runtime.getLocale(), 'it');
});

test('browser language and cross-window storage changes notify live subscribers', async () => {
  const h = runtimeHarness({ languages: ['en'] });
  await h.runtime.initializeLanguage();
  h.navigator.languages = ['pl-PL']; h.events.get('languagechange')();
  assert.equal(h.runtime.getLocale(), 'pl');
  h.storage.set(STORAGE_KEY, JSON.stringify({ preference: 'zh', acknowledged: true }));
  h.events.get('storage')({ key: STORAGE_KEY });
  assert.equal(h.runtime.getLocale(), 'zh');
  assert.equal(h.document.documentElement.lang, 'zh-CN');
  assert.equal(h.runtime.formatNumber(1234.5), new Intl.NumberFormat('zh-CN').format(1234.5));
  assert.equal(h.runtime.formatDate(0, { timeZone: 'UTC', year: 'numeric' }), new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric' }).format(0));
});

test('translated numeric values use the chosen locale and date-only history keeps its local day', () => {
  const { runtime } = runtimeHarness({ languages: ['ar'] });
  assert.equal(runtime.t('Осталось {count}', { count: 1234 }), `متبقي ${new Intl.NumberFormat('ar').format(1234)}`);
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    runtime.setLanguagePreference('en');
    assert.equal(runtime.formatDate('2026-10-12'), '10/12/2026');
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('invalid legacy dates do not crash the history or self-check view', () => {
  const { runtime } = runtimeHarness();
  for (const date of ['broken', '', new Date(NaN), NaN]) assert.equal(runtime.formatDate(date), '-');
});
