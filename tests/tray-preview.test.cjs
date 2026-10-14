const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { React, ReactDOMClient, ReactDOM, doc, transformer } = require('./support/syntheticDom.cjs');

function previewHarness(initial) {
  const filename = path.resolve(__dirname, '../src/components/TrayPreview.tsx');
  const transformed = transformer.transformSync(filename, fs.readFileSync(filename, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const source = transformed.replace(/^import[^\n]*\n/gm, '')
    .replace(/export default function /g, 'function ').replace(/export function /g, 'function ');
  const listeners = new Map(), invocations = [], warnings = [];
  doc.documentElement.dataset = {};
  const window = { __TAURI__: {
    core: { invoke: async command => { invocations.push(command); assert.equal(command, 'tray_preview_state'); return initial; } },
    event: { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } },
  }, matchMedia: () => ({ matches: false }), localStorage: {
    getItem() { throw Error('Preview must not read main storage'); },
    setItem() { throw Error('Preview must not write storage'); },
  } };
  const context = { React, useEffect: React.useEffect, useState: React.useState, document: doc, window,
    Date: class extends Date { static now() { return 100_000; } },
    console: { warn: (...args) => warnings.push(args) },
    setInterval() { throw Error('Preview must not start another timer'); },
  };
  vm.runInNewContext(source + '\nthis.Component=TrayPreview;this.countdown=previewCountdown;', context, { filename });
  const host = doc.createElement('div'), root = ReactDOMClient.createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 8; i++) { await Promise.resolve(); ReactDOM.flushSync(() => {}); }
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); ReactDOM.flushSync(() => {}); }
  };
  ReactDOM.flushSync(() => root.render(React.createElement(context.Component)));
  return { host, listeners, invocations, warnings, countdown: context.countdown, settle,
    emit(name, payload) { ReactDOM.flushSync(() => listeners.get(name)?.({ payload })); },
    destroy() { ReactDOM.flushSync(() => root.unmount()); } };
}

const timer = { remainingMs: 61_001, totalMs: 1_200_000, manualPaused: false, breakActive: false,
  exercising: false, expiryPending: false, reasons: [] };
const summary = { date: '2026-10-14', locale: 'es', title: 'Hoy', todayLabel: 'Hoy',
  nextBreakLabel: 'Próximo descanso', focusLabel: 'Tiempo de trabajo', breaksLabel: 'Descansos hoy',
  pausedLabel: 'Pausa', absentLabel: 'Sin actividad', breakLabel: 'Descanso', exerciseLabel: 'Ejercicio',
  readyLabel: 'Hora de descansar', focusValue: '65 min', breaksValue: '4', theme: 'light', colorPalette: 'ocean' };

test('preview displays native countdown and localized daily data using only its read endpoint', async () => {
  const h = previewHarness({ timer, summary });
  try {
    await h.settle();
    assert(h.host.textContent.includes('Próximo descanso01:02'));
    assert(h.host.textContent.includes('Tiempo de trabajo65 min'));
    assert(h.host.textContent.includes('Descansos hoy4'));
    assert.deepEqual(h.invocations, ['tray_preview_state']);
    assert.equal(h.listeners.size, 2);
    assert.equal(h.warnings.length, 0);
    h.emit('native-timer', { ...timer, manualPaused: true, remainingMs: 59_000 });
    assert(h.host.textContent.includes('Pausa00:59'));
    h.emit('tray-preview-summary', { ...summary, locale: 'ar', todayLabel: 'اليوم', focusValue: '٦٦ دقيقة' });
    assert(h.host.textContent.includes('٦٦ دقيقة'));
    assert.equal(doc.documentElement.dir, 'rtl');
    assert.equal(doc.documentElement.dataset.palette, 'ocean');
    assert.deepEqual(h.invocations, ['tray_preview_state'], 'native and summary events never mutate the timer');
  } finally { h.destroy(); }
  assert.equal(h.listeners.size, 0, 'unmount removes both native subscriptions');
});

test('preview clock clamps invalid values, rounds countdown up and uses the active break deadline', async () => {
  const h = previewHarness({ timer, summary });
  try {
    await h.settle();
    assert.equal(h.countdown({ ...timer, remainingMs: -1 }), '00:00');
    assert.equal(h.countdown({ ...timer, remainingMs: NaN }), '00:00');
    assert.equal(h.countdown({ ...timer, remainingMs: 1 }), '00:01');
    assert.equal(h.countdown({ ...timer, breakActive: true, breakEndAt: 119_001 }, 100_000), '00:20');
    assert.equal(h.countdown({ ...timer, breakActive: true, breakEndAt: 99_999 }, 100_000), '00:00');
  } finally { h.destroy(); }
});
