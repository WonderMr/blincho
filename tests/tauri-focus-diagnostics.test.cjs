const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { assertAppIdentity, startFocusDiagnostics, focusFailureEvidence, logFocusFailure }
  = require('./tauri-break-focus-smoke.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-focus-diagnostics-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handle = { child: { pid: 123, exitCode: null, signalCode: null, killed: false },
    processExit: null, exit: null, launchError: null, output: 'native output' };
  const app = { directory, handle, bundleIdentifier: 'com.blincho.unit', bundlePath: '/unit/Blincho.app',
    binary: '/unit/Blincho.app/Contents/MacOS/blincho' };
  const runtime = { pid: 123, visible: false, focused: false, nativeActivationPolicy: 1, dockVisible: false,
    timer: { tickCount: 10, breakActive: false, breakEndAt: 1000 } };
  const observer = { pid: 234, observedPID: 123, sample: 20, reportedAtMs: Date.now(), frontmostPID: 345,
    observedLookupFound: false, observedProcessIdentifier: null, observedTerminated: null,
    observedActivationPolicy: null, retainedProcessIdentifier: 123, retainedTerminated: false,
    retainedActivationPolicy: 1, workspaceContainsObservedPID: false };
  const write = (file, value) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  write('runtime-diagnostics.json', runtime);
  write('state.json', { ...observer, recentSamples: [observer] });
  return { directory, handle, app, runtime, observer, write };
}

test('a nil fresh lookup fails immediately and keeps its exact observation and native state', t => {
  const { app, runtime, observer } = fixture(t);
  assert.throws(() => assertAppIdentity(observer, app, runtime), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.equal(error.actual, false);
    assert.equal(error.expected, true);
    assert.equal(error.focusObservation.observer, observer);
    assert.deepEqual(error.focusObservation.runtime, { ...runtime, position: undefined, size: undefined,
      minimized: undefined, maximized: undefined, fullscreen: undefined, strict: undefined,
      strictShieldCount: undefined, timer: { ...runtime.timer, remainingMs: undefined,
        absenceEpoch: undefined, reasons: undefined, version: undefined } });
    assert.equal(error.focusObservation.child.pid, 123);
    return true;
  });
});

test('bounded history and one second after failure retain lookup recovery and child exit before cleanup', async t => {
  const { app, handle, runtime, observer, write } = fixture(t);
  let record;
  const context = startFocusDiagnostics(app, [{ directory: app.directory, pid: observer.pid }], 'fixture',
    (callback, interval) => { assert.equal(interval, 100); record = callback; return null; });
  for (let tick = 0; tick < 40; tick++) {
    write('runtime-diagnostics.json', { ...runtime, timer: { ...runtime.timer, tickCount: tick } });
    record();
  }
  let failure;
  try { assertAppIdentity(observer, app, runtime); } catch (error) { failure = error; }
  const waits = [];
  handle.output = 'x'.repeat(70_000);
  const report = await focusFailureEvidence(failure, context, [handle], async milliseconds => {
    waits.push(milliseconds);
    assert.equal(handle.child.killed, false, 'post-failure observations must precede cleanup');
    write('state.json', { ...observer, sample: observer.sample + waits.length,
      observedLookupFound: true, workspaceContainsObservedPID: true });
    if (waits.length === 2) {
      handle.child.exitCode = 7;
      handle.processExit = { code: 7, signal: null, atMs: Date.now() };
    }
  });
  assert.equal(report.error.message, failure.message, 'recovery cannot change the original failure');
  assert.equal(report.failedObservation.observer.observedLookupFound, false);
  assert.equal(report.atFailure.observers[0].state.observedLookupFound, false);
  assert.deepEqual(report.recentNativeSamples[0].samples, [observer]);
  assert.equal(report.runtimeAtFailure.timer.tickCount, 39);
  assert.equal(report.recentSamples.length, 32);
  assert.equal(report.recentSamples[0].runtime.timer.tickCount, 8);
  assert.equal(report.postFailureSamples.length, 10);
  assert.deepEqual(waits, Array(10).fill(100));
  assert.equal(report.postFailureSamples[0].observers[0].state.observedLookupFound, true);
  assert.equal(report.atFailure.children[0].exitCode, null);
  assert.equal(report.postFailureSamples[1].children[0].exitCode, 7);
  assert.equal(report.nativeOutput[0].output.length, 65_536);
  assert.equal(report.nativeOutput[0].outputTruncated, true);
  const logged = [];
  const originalError = console.error;
  try {
    console.error = value => logged.push(value);
    logFocusFailure(report, '/unit/failure-artifacts');
  } finally { console.error = originalError; }
  assert.match(logged[0], /Native focus failure evidence:/);
  const summary = JSON.parse(logged[1]);
  assert.equal(summary.failedObservation.observer.observedLookupFound, false);
  assert.equal(summary.recentSamples.length, 10);
  assert.equal(summary.postFailureSamples.length, 10);
  assert.equal(summary.nativeOutput, undefined);
  assert.equal(summary.runtimeAtFailure, undefined);
});

test('diagnostic file reads are bounded without weakening the failed test', async t => {
  const { directory, app, handle } = fixture(t);
  fs.writeFileSync(path.join(directory, 'runtime-diagnostics.json'), 'x'.repeat(131_073));
  const report = await focusFailureEvidence(new Error('original failure'),
    { app, fixtures: [], name: 'bounds', recentSamples: [] }, [handle], async () => {});
  assert.equal(report.error.message, 'original failure');
  assert.match(report.runtimeAtFailure.diagnosticReadError, /131072 byte limit/);
  assert.equal(report.postFailureSamples.length, 10);
});

test('a failed native compile writes only text evidence at the CI upload location and stays failed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-focus-main-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, 'tauri-break-focus-smoke.cjs'), 'utf8');
  const stderr = [];
  const sandbox = {
    __dirname, Buffer, module: { exports: {} },
    process: { platform: 'darwin', arch: 'x64', env: { RUNNER_TEMP: directory } },
    setInterval, clearInterval, clearTimeout,
    setTimeout(callback) { return setImmediate(callback); },
    console: { log() {}, error(value) { stderr.push(value); } },
    require(name) {
      if (name !== 'node:child_process') return require(name);
      return { spawn() { assert.fail('helper test must not start an app'); },
        spawnSync() { return { status: 1, stderr: 'fixture compile failure' }; } };
    },
  };
  vm.runInNewContext(source + '\nthis.runFocusSmoke = main;', sandbox);
  await assert.rejects(sandbox.runFocusSmoke(), /fixture compile failure/);
  const [base] = fs.readdirSync(directory);
  assert.match(base, /^blincho-break-focus-/);
  const output = path.join(directory, base, 'failure-artifacts');
  assert.deepEqual(fs.readdirSync(output), ['failure.json']);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'failure.json'), 'utf8'));
  assert.match(report.error.message, /fixture compile failure/);
  assert.equal(report.postFailureSamples.length, 10);
  assert.match(stderr[0], /Native focus failure evidence:/);
  for (const file of ['ci.yml', 'release.yml']) {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8');
    assert(workflow.includes('${{ runner.temp }}/blincho-break-focus-*/failure-artifacts/*'));
  }
});
