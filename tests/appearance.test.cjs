const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { transformSync } = require('rolldown/utils');

function harness() {
  const filename = path.resolve(__dirname, '../src/utils/appearance.ts');
  const transformed = transformSync(filename, fs.readFileSync(filename, 'utf8')).code;
  const names = [...transformed.matchAll(/export function (\w+)/g)].map(match => match[1]);
  const events = new Set(), attributes = {}, style = {}, removed = [];
  const media = { matches: false, addEventListener: (name, callback) => events.add(callback), removeEventListener: (name, callback) => events.delete(callback) };
  const context = { window: { matchMedia: () => media }, document: { documentElement: { setAttribute: (key, value) => attributes[key] = value, style, classList: { remove: (...names) => removed.push(...names) } } } };
  vm.createContext(context);
  vm.runInContext(transformed.replace(/^import[^\n]*\n/gm, '').replace(/export function /g, 'function ') + `\nthis.api={${names.join(',')}}`, context);
  return { ...context.api, attributes, style, removed, events, setSystem(dark) { media.matches = dark; for (const callback of events) callback(); } };
}

test('system appearance follows changes, preserves palette, and unsubscribes', () => {
  const h = harness(); let redraws = 0;
  const unsubscribe = h.subscribeAppearance(() => redraws++);
  const stop = h.watchAppearance('system', 'lavender');
  assert.equal(h.attributes['data-appearance'], 'light');
  h.setSystem(true);
  assert.equal(h.attributes['data-appearance'], 'dark');
  assert.equal(h.attributes['data-palette'], 'lavender');
  assert.equal(h.style.colorScheme, 'dark');
  assert.equal(redraws, 2);
  stop(); unsubscribe();
  assert.equal(h.events.size, 0);
  h.setSystem(false);
  assert.equal(h.attributes['data-appearance'], 'dark');
  h.applyAppearance('light', 'sage');
  assert.equal(redraws, 2, 'unmounted canvas no longer receives changes');
  assert(h.removed.includes('theme-forest'));
});

test('explicit modes ignore system appearance and can be replaced by system mode', () => {
  for (const mode of ['light', 'dark']) {
    const h = harness(), stop = h.watchAppearance(mode, 'ocean');
    h.setSystem(true); h.setSystem(false);
    assert.equal(h.attributes['data-appearance'], mode);
    assert.equal(h.events.size, 0);
    stop(); const cleanup = h.watchAppearance('system', 'ocean');
    assert.equal(h.events.size, 1);
    h.setSystem(true); assert.equal(h.attributes['data-appearance'], 'dark');
    cleanup();
  }
});

test('legacy dark themes migrate, new defaults follow system, invalid data normalizes', () => {
  const h = harness();
  for (const theme of ['midnight', 'oled', 'forest']) {
    assert.equal(h.normalizeAppearance({ theme }).theme, 'dark');
    assert.equal(h.normalizeAppearance({ theme }).colorPalette, theme === 'forest' ? 'sage' : 'ocean');
  }
  assert.equal(h.normalizeAppearance({}).theme, 'system');
  assert.equal(h.normalizeAppearance({ theme: 'invalid', colorPalette: null }).colorPalette, 'sage');
  for (const theme of ['system', 'light', 'dark']) for (const colorPalette of ['sage', 'ocean', 'lavender']) {
    const result = h.normalizeAppearance({ theme, colorPalette });
    assert.equal(result.theme, theme); assert.equal(result.colorPalette, colorPalette);
  }
});

test('all appearance choices persist without restarting work or an active break', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness();
  try {
    await h.advance(10000); await h.call('Navbar', 'onOpenSettings');
    for (const theme of ['light', 'dark', 'system']) for (const colorPalette of ['sage', 'ocean', 'lavender']) {
      await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, theme, colorPalette });
      assert.equal(h.captured.TimerWidget.secondsRemaining, 1190);
      const saved = JSON.parse(h.store.get('myeyes_settings_v1'));
      assert.equal(saved.theme, theme); assert.equal(saved.colorPalette, colorPalette);
    }
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    const elapsed = h.captured.BreakOverlay.onElapsed;
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, theme: 'dark', colorPalette: 'lavender' });
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.equal(h.stats().breaksCompleted, 0);
    h.setIdle(20); await h.advance(20000); await elapsed(h.monotonicNow); await h.settle();
    h.setIdle(0); await h.advance(2000);
    assert.equal(h.stats().breaksCompleted, 1, 'the original break remains eligible after its full duration and return');
  } finally { h.destroy(); }
});
