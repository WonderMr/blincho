const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');

test('Tauri desktop bridge invokes lock_computer and preserves success and failure with CRLF source', async () => {
  const file = path.join(__dirname, '../src/utils/tauriBridge.ts');
  const raw = fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n').replace(/^import .*;\r?\n/gm, '');
  const code = transformSync(file, raw).code.replace(/\bexport /g, '') + '\nmodule.exports = { initializeTauriBridge };';
  const calls = [];
  let failure = null;
  const window = { __TAURI__: { core: { async invoke(command) {
    calls.push(command);
    if (command === 'desktop_info') return { platform: 'darwin', meetingDetectionSupported: true };
    if (failure) throw failure;
    return true;
  } }, event: { listen: async () => () => {} } } };
  const context = { window, document: { documentElement: { dataset: {} }, addEventListener() {} },
    TimerSession: class {}, installWindowDrag() {}, module: { exports: {} }, setTimeout, clearTimeout, console };
  vm.runInNewContext(code, context);
  await context.module.exports.initializeTauriBridge();
  calls.length = 0;
  assert.equal(await window.desktopAPI.lockComputer(), true);
  assert.deepEqual(calls, ['lock_computer']);
  failure = new Error('Native lock failure');
  await assert.rejects(window.desktopAPI.lockComputer(), error => error === failure);
});

function quitBridge(flushStatistics) {
  const file = path.join(__dirname, '../src/utils/tauriBridge.ts');
  const raw = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
  const code = transformSync(file, raw).code.replace(/\bexport /g, '') +
    '\nmodule.exports = { initializeTauriBridge, subscribeNativeQuit, requestNativeQuit };';
  const calls = [], listeners = new Map(), warnings = [];
  const context = { window: { __TAURI__: {
    core: { async invoke(command) { calls.push(command); if (command === 'desktop_info') return { platform: 'darwin' }; } },
    event: { async listen(name, callback) { listeners.set(name, callback); return () => listeners.delete(name); } },
  } }, document: { documentElement: { dataset: {} }, addEventListener() {} },
    TimerSession: class {}, installWindowDrag() {}, flushStatistics, module: { exports: {} },
    console: { warn: (...args) => warnings.push(args) },
  };
  vm.runInNewContext(code, context);
  return { ...context.module.exports, calls, listeners, warnings };
}

test('native Quit prepares once and awaits durable statistics before authorizing exit', async () => {
  let complete, saves = 0;
  const h = quitBridge(() => { saves++; return new Promise(resolve => { complete = resolve; }); });
  await h.initializeTauriBridge();
  const prepared = []; h.subscribeNativeQuit(value => { prepared.push(value); });
  h.listeners.get('statistics-before-quit')(); h.listeners.get('statistics-before-quit')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prepared, [true]); assert.equal(saves, 1);
  assert(!h.calls.includes('statistics_finish_quit'));
  complete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(command => command === 'statistics_finish_quit').length, 1);
});

test('a failed Quit flush resumes the renderer and can be retried without losing the exit guard', async () => {
  let fail = true;
  const h = quitBridge(async () => { if (fail) throw Error('disk full'); });
  await h.initializeTauriBridge();
  const prepared = []; h.subscribeNativeQuit(value => { prepared.push(value); });
  h.listeners.get('statistics-before-quit')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prepared, [true, false]);
  assert(!h.calls.includes('statistics_finish_quit')); assert.equal(h.warnings.length, 1);
  fail = false;
  h.listeners.get('statistics-before-quit')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prepared, [true, false, true]);
  assert.equal(h.calls.filter(command => command === 'statistics_finish_quit').length, 1);
});

test('explicit Quit without saving can exit despite a persistent disk failure', async () => {
  let saves = 0;
  const h = quitBridge(async () => { saves++; throw Error('disk stays full'); });
  await h.initializeTauriBridge();
  const prepared = []; h.subscribeNativeQuit(value => { prepared.push(value); });
  await assert.rejects(h.requestNativeQuit(), /disk stays full/);
  assert.equal(saves, 1); assert.deepEqual(prepared, [true, false]);
  await h.requestNativeQuit(true);
  assert.equal(saves, 1, 'discard is an explicit choice and does not loop over the failing save');
  assert.equal(h.calls.filter(command => command === 'statistics_finish_quit').length, 1);
});
