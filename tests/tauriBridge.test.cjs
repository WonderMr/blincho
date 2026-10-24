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
