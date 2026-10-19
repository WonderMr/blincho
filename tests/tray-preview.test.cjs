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
  const helpers = transformer.transformSync('symbioteIcons.ts', fs.readFileSync(path.resolve(__dirname, '../src/utils/symbioteIcons.ts'), 'utf8')).code.replace(/export /g, '');
  const context = { React, useEffect: React.useEffect, useState: React.useState, document: doc, window,
    Date: class extends Date { static now() { return 100_000; } },
    console: { warn: (...args) => warnings.push(args) },
    setInterval() { throw Error('Preview must not start another timer'); },
  };
  vm.runInNewContext(helpers + '\n' + source + '\nthis.Component=TrayPreview;this.countdown=previewCountdown;', context, { filename });
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
  readyLabel: 'Hora de descansar', focusValue: '65 min', breaksValue: '4', theme: 'light', colorPalette: 'ocean', symbioteMask: 63, buildName: 'Blinchiborg' };
const callSummary = { ...summary, meetingLabel: 'Llamada', meetingInactiveLabel: 'Sin llamada activa',
  meetingUnknownLabel: 'Estado de llamada desconocido', meetingDisabledLabel: 'Detección de llamadas desactivada',
  unknownMeetingAppLabel: 'Aplicación desconocida' };
const activeCall = { inMeeting: true, supported: true, applications: ['Zoom', 'Microsoft Teams'] };

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
    assert.equal(h.host.querySelector('img').getAttribute('src'), './symbiote/3f.png');
    assert(h.host.textContent.includes('Blinchiborg'));
    h.emit('native-timer', { ...timer, manualPaused: true, remainingMs: 59_000 });
    assert(h.host.textContent.includes('Pausa00:59'));
    h.emit('tray-preview-summary', { ...summary, locale: 'ar', symbioteMask: 16, buildName: 'حارس', todayLabel: 'اليوم', focusValue: '٦٦ دقيقة' });
    assert(h.host.textContent.includes('٦٦ دقيقة'));
    assert.equal(doc.documentElement.dir, 'rtl');
    assert.equal(h.host.querySelector('img').getAttribute('src'), './symbiote/10.png');
    assert(h.host.textContent.includes('حارس'));
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

test('preview shows live call apps independently of recorded history and timer phase', async () => {
  const h = previewHarness({ timer: { ...timer, liveMeetingEnabled: true, liveMeetingStatus: activeCall,
    meetingSpans: [], meetingApplications: [] }, summary: callSummary });
  try {
    await h.settle();
    const row = h.host.querySelector('[data-meeting-state="active"]');
    assert(row, 'the transient native status must be visible even without recorded calls');
    assert.equal(row.textContent, 'Llamada: Zoom, Microsoft Teams');
    assert.equal(row.getAttribute('title'), row.textContent, 'the full app names remain available when the row truncates');
    assert(h.host.textContent.includes('Próximo descanso01:02'));
    for (const [phase, label] of [
      [{ manualPaused: true }, 'Pausa'], [{ reasons: ['locked'] }, 'Sin actividad'],
      [{ breakActive: true, breakEndAt: 120_000 }, 'Descanso'], [{ exercising: true }, 'Ejercicio'],
      [{ expiryPending: true }, 'Hora de descansar'],
    ]) {
      h.emit('native-timer', { ...timer, ...phase, liveMeetingEnabled: true, liveMeetingStatus: activeCall });
      assert(h.host.textContent.includes(label), `call status does not replace ${label}`);
      assert.equal(h.host.querySelector('[data-meeting-state="active"]').textContent, 'Llamada: Zoom, Microsoft Teams');
    }
    assert.deepEqual(h.invocations, ['tray_preview_state'], 'the preview cannot probe, configure or persist calls');
    assert.equal(h.warnings.length, 0);
  } finally { h.destroy(); }
});

test('preview distinguishes disabled, unknown, unsupported and inactive call detection', async () => {
  const h = previewHarness({ timer, summary: callSummary });
  try {
    await h.settle();
    const cases = [
      [{ liveMeetingEnabled: false, liveMeetingStatus: activeCall }, 'disabled', callSummary.meetingDisabledLabel],
      [{ liveMeetingEnabled: true, liveMeetingStatus: null }, 'unknown', callSummary.meetingUnknownLabel],
      [{ liveMeetingEnabled: true, liveMeetingStatus: { ...activeCall, supported: false } }, 'unknown', callSummary.meetingUnknownLabel],
      [{ liveMeetingEnabled: true, liveMeetingStatus: { ...activeCall, inMeeting: false } }, 'inactive', callSummary.meetingInactiveLabel],
      [{}, 'disabled', callSummary.meetingDisabledLabel],
    ];
    for (const [status, state, label] of cases) {
      h.emit('native-timer', { ...timer, ...status });
      const row = h.host.querySelector(`[data-meeting-state="${state}"]`);
      assert(row, state);
      assert.equal(row.textContent, label);
      assert(h.host.textContent.includes('Próximo descanso01:02'));
      assert(!row.textContent.includes('Zoom'), 'inactive or unavailable detection must not show stale apps');
    }
  } finally { h.destroy(); }
});

test('live call events replace app names and use localized unknown-app fallback with RTL isolation', async () => {
  const h = previewHarness({ timer: { ...timer, liveMeetingEnabled: true, liveMeetingStatus: activeCall }, summary: callSummary });
  try {
    await h.settle();
    h.emit('native-timer', { ...timer, liveMeetingEnabled: true,
      liveMeetingStatus: { ...activeCall, applications: [] } });
    assert.equal(h.host.querySelector('[data-meeting-state="active"]').textContent, 'Llamada: Aplicación desconocida');
    for (const applications of [['unknown'], ['Zoom', 'unknown']]) {
      h.emit('native-timer', { ...timer, liveMeetingEnabled: true,
        liveMeetingStatus: { ...activeCall, applications } });
      assert.equal(h.host.querySelector('[data-meeting-state="active"]').textContent,
        applications.length === 1 ? 'Llamada: Aplicación desconocida' : 'Llamada: Zoom, Aplicación desconocida');
    }
    h.emit('tray-preview-summary', { ...callSummary, locale: 'he', meetingLabel: 'שיחה' });
    h.emit('native-timer', { ...timer, liveMeetingEnabled: true,
      liveMeetingStatus: { ...activeCall, applications: ['FaceTime'] } });
    assert.equal(doc.documentElement.dir, 'rtl');
    assert.equal(h.host.querySelector('[data-meeting-state="active"]').textContent, 'שיחה: FaceTime');
    assert.equal(h.host.querySelector('bdi').textContent, 'FaceTime');
    assert(!h.host.textContent.includes('Zoom'));
    assert.deepEqual(h.invocations, ['tray_preview_state']);
  } finally { h.destroy(); }
});
