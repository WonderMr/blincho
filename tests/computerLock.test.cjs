const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const { createComputerLocker } = require('../electron/lockComputer.cjs');

function lockerHarness(platform, { output = '', error = null, states = [true], env = {} } = {}) {
  const calls = [];
  let time = 0, probes = 0;
  const sample = () => { const state = states[Math.min(probes++, states.length - 1)]; if (state instanceof Error) throw state; return state; };
  const lock = createComputerLocker({ platform, env, now: () => time, wait: async ms => { time += ms; },
    execute: (file, args, options, callback) => {
      calls.push({ file, args, options });
      if (error) return callback(error);
      if (platform === 'linux' && args[0] === 'show-session') {
        try { const value = sample(); callback(null, value === true ? 'LockedHint=yes' : value === false ? 'LockedHint=no' : ''); }
        catch (failure) { callback(failure); }
      } else callback(null, output);
    },
    confirmed: async () => sample(),
  });
  return { lock, calls, get probes() { return probes; } };
}

test('macOS uses the direct session-lock API and requires native lock confirmation', async () => {
  const h = lockerHarness('darwin', { output: 'locked\n' });
  assert.equal(await h.lock(), true);
  const call = h.calls[0];
  assert.equal(call.file, '/usr/bin/osascript');
  assert.deepEqual(call.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert(call.args[3].includes('SACLockScreenImmediate'));
  assert(call.args[3].includes('CGSSessionScreenIsLocked === true'));
  assert(!call.args[3].includes('displaysleepnow'));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.timeout, 6000);
  assert.equal(h.probes, 0);
  for (const output of ['', 'requested', 'false']) await assert.rejects(lockerHarness('darwin', { output }).lock(), /could not be confirmed/);
});

test('Windows invokes the BOOL API directly and waits for confirmed lock state', async () => {
  const h = lockerHarness('win32', { states: [false, new Error('Unknown state'), true] });
  assert.equal(await h.lock(), true);
  const call = h.calls[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert(call.args[3].includes('extern bool LockWorkStation()'));
  assert(call.args[3].includes('GetLastWin32Error()'));
  assert(!call.args[3].includes('rundll32'));
  assert.equal(h.probes, 3);
});

test('the macOS command script confirms a real lock and rejects missing API or ignored requests', async () => {
  const h = lockerHarness('darwin', { output: 'locked' });
  await h.lock();
  const script = h.calls[0].args[3];
  function run({ available = true, states = [{ CGSSessionScreenIsLocked: false }, { CGSSessionScreenIsLocked: true }] } = {}) {
    let requests = 0, probes = 0, waits = 0;
    const context = {
      ObjC: { import() {}, bindFunction(name, signature) { assert.equal(name, 'SACLockScreenImmediate'); assert.equal(JSON.stringify(signature), '["void",[]]'); }, deepUnwrap: value => value },
      $: { NSBundle: { bundleWithPath: () => ({ isNil: () => !available, load: available }) },
        SACLockScreenImmediate: () => { requests++; },
        CGSessionCopyCurrentDictionary: () => states[Math.min(probes++, states.length - 1)],
        NSThread: { sleepForTimeInterval: seconds => { assert.equal(seconds, 0.05); waits++; } },
      },
    };
    return { execute: () => vm.runInNewContext(script, context), get requests() { return requests; }, get probes() { return probes; }, get waits() { return waits; } };
  }
  const success = run();
  assert.equal(success.execute(), 'locked');
  assert.equal(success.requests, 1); assert.equal(success.probes, 2); assert.equal(success.waits, 1);
  const missing = run({ available: false });
  assert.throws(missing.execute, /API is unavailable/); assert.equal(missing.requests, 0);
  for (const state of [null, {}, { CGSSessionScreenIsLocked: false }, { CGSSessionOnConsoleKey: false }]) {
    const ignored = run({ states: [state] });
    assert.throws(ignored.execute, /could not be confirmed/);
    assert.equal(ignored.requests, 1); assert.equal(ignored.probes, 60);
  }
});

test('Linux locks only the current validated session and confirms the result', async () => {
  for (const [session, expected] of [['c2', ['c2']], [undefined, []], ['--all', []], ['a;reboot', []], ['x'.repeat(129), []]]) {
    const h = lockerHarness('linux', { env: { XDG_SESSION_ID: session }, states: [false, true] });
    assert.equal(await h.lock(), true);
    assert.equal(h.calls[0].file, '/usr/bin/loginctl');
    assert.deepEqual(h.calls[0].args, ['lock-session', ...expected]);
    assert.equal(h.calls[0].options.shell, false);
    assert.deepEqual(h.calls[1].args, ['show-session', expected[0] || 'auto', '--property=LockedHint', '--no-pager']);
    assert.equal(h.calls[1].options.timeout, 1000);
    assert.equal(h.probes, 2);
  }
});

test('native failures, unsupported platforms, unsafe Windows paths and test profiles reject', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const failure = new Error('Native request failed');
    const h = lockerHarness(platform, { error: failure });
    await assert.rejects(h.lock(), error => error === failure);
    assert.equal(h.probes, 0);
    for (const directory of ['/test-profile', '']) {
      const isolated = lockerHarness(platform, { env: { BLINCHO_PROTOTYPE_TEST_DIR: directory } });
      await assert.rejects(isolated.lock(), /disabled in test profiles/);
      assert.equal(isolated.calls.length, 0);
    }
  }
  const unsupported = lockerHarness('unknown');
  await assert.rejects(unsupported.lock(), /unavailable on this platform/);
  assert.equal(unsupported.calls.length, 0);
  for (const root of ['relative', 'C:\\..\\evil', 'C:\\Windows\nmalicious']) {
    const h = lockerHarness('win32', { env: { SystemRoot: root } });
    await assert.rejects(h.lock(), /Invalid Windows system directory/);
    assert.equal(h.calls.length, 0);
  }
});

test('accepted commands cannot report success without a lock confirmation', async () => {
  for (const platform of ['win32', 'linux']) for (const state of [false, undefined, new Error('Unknown state')]) {
    const h = lockerHarness(platform, { states: [state] });
    await assert.rejects(h.lock(), /could not be confirmed/);
    assert.equal(h.calls.length, platform === 'linux' ? 61 : 1);
    assert.equal(h.probes, 60);
  }
});

test('concurrent requests share one native command and a failed request can be retried', async () => {
  const callbacks = [];
  const lock = createComputerLocker({ platform: 'darwin', env: {}, execute: (_file, _args, _options, callback) => callbacks.push(callback) });
  const first = lock(), second = lock();
  assert.equal(first, second);
  assert.equal(callbacks.length, 1);
  const rejected = assert.rejects(first, /Failure/);
  callbacks[0](new Error('Failure'));
  await rejected;
  const retry = lock();
  assert.equal(callbacks.length, 2);
  callbacks[1](null, 'locked');
  assert.equal(await retry, true);
});

test('lock IPC accepts only the main renderer and rejects suspended or quitting sessions', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function requireMainRenderer(');
  const guard = source.slice(start, source.indexOf('\nfunction ', start + 1));
  const handlerStart = source.indexOf("ipcMain.handle('lock-computer',");
  const handlerSource = source.slice(handlerStart, source.indexOf('\n});', handlerStart) + 4);
  const mainFrame = {}, webContents = { mainFrame };
  let handler, calls = 0;
  const context = { mainWindow: { isDestroyed: () => false, webContents }, suspended: false, isQuitting: false,
    ipcMain: { handle: (_name, callback) => { handler = callback; } }, lockComputer: async () => { calls++; return true; } };
  vm.runInNewContext(guard + '\n' + handlerSource, context);
  for (const event of [{}, { sender: {}, senderFrame: mainFrame }, { sender: webContents, senderFrame: {} }]) assert.throws(() => handler(event), /main renderer/);
  assert.equal(calls, 0);
  const trusted = { sender: webContents, senderFrame: mainFrame };
  assert.equal(await handler(trusted), true);
  assert.equal(calls, 1);
  context.suspended = true;
  assert.throws(() => handler(trusted), /suspended/);
  context.suspended = false; context.isQuitting = true;
  assert.throws(() => handler(trusted), /suspended/);
  assert.equal(calls, 1);
});

test('Electron preload exposes a zero-argument trusted lock invoke and preserves failures', async () => {
  let bridge, call;
  const failure = new Error('Denied');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => { call = args; return Promise.reject(failure); } } }),
    process: { platform: 'darwin' }, window: { addEventListener() {} },
  });
  await assert.rejects(bridge.lockComputer('ignored'), error => error === failure);
  assert.deepEqual(call, ['lock-computer']);
});

test('Tauri compatibility bridge invokes lock_computer and preserves success and failure', async () => {
  const file = path.join(__dirname, '../src/utils/tauriBridge.ts');
  const raw = fs.readFileSync(file, 'utf8').replace(/^import .*;\n/gm, '');
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
    TimerSession: class {}, module: { exports: {} }, setTimeout, clearTimeout, console };
  vm.runInNewContext(code, context);
  await context.module.exports.initializeTauriBridge();
  assert.equal(await window.electronAPI.lockComputer(), true);
  assert.deepEqual(calls, ['desktop_info', 'lock_computer']);
  failure = new Error('Native lock failure');
  await assert.rejects(window.electronAPI.lockComputer(), error => error === failure);
});
