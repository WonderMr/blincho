const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('an early native completion still fails immediately and retains countdown evidence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-camera-diagnostics-unit-'));
  const source = fs.readFileSync(path.join(__dirname, 'tauri-camera-completion-smoke.cjs'), 'utf8');
  const version = require('../package.json').version;
  let clock = 1_700_000_000_000;
  let response, nativeDeadline, activeReads = 0, child;
  const errors = [];
  const runtime = { pid: 12345, strict: true, strictShieldCount: 1,
    updates: { currentVersion: version }, renderer: { ready: true },
    timer: { totalMs: 3_600_000, breakActive: false, breakElapsed: false, reasons: [], absenceEpoch: 0 } };
  const filesystem = Object.create(fs);
  filesystem.readFileSync = (file, ...args) => {
    if (path.basename(String(file)) === 'runtime-diagnostics.json') {
      const snapshot = JSON.parse(JSON.stringify(runtime));
      if (runtime.timer.breakActive && ++activeReads === 1) runtime.timer.breakActive = false;
      return JSON.stringify(snapshot);
    }
    if (path.basename(String(file)) === 'response.json') return JSON.stringify(response);
    return fs.readFileSync(file, ...args);
  };
  filesystem.renameSync = (from, to) => {
    if (path.basename(String(to)) === 'control.json') {
      const command = JSON.parse(fs.readFileSync(from, 'utf8'));
      response = { id: command.id, ok: true };
      if (command.operation === 'eval') {
        const marker = command.script.match(/completionMarker:(\d+)/);
        if (marker) runtime.renderer = { ready: true, completionMarker: Number(marker[1]),
          settings: { cameraLockEnabled: true, strictMode: true },
          probe: { installed: true, acquisitions: 0 }, dialog: true };
      } else if (command.operation === 'rest') {
        nativeDeadline = clock + 3000;
        runtime.timer.breakActive = true;
        runtime.timer.breakEndAt = nativeDeadline;
      } else if (command.operation === 'quit') {
        child.exitCode = 0;
        child.emit('close', 0, null);
      }
    }
    return fs.renameSync(from, to);
  };
  class Clock extends Date { static now() { return clock; } }
  const sandbox = { __dirname, module: { exports: {} }, Date: Clock,
    performance: { now: () => 500 },
    process: { env: { BLINCHO_PROTOTYPE_EXECUTABLE: 'fixture-native' }, platform: 'darwin', arch: 'x64' },
    setTimeout(callback, milliseconds) { clock += milliseconds; return setImmediate(callback); },
    console: { log() {}, error(value) { errors.push(String(value)); } },
    require(name) {
      if (name === 'node:fs') return filesystem;
      if (name === 'node:child_process') return { spawn(file) {
        assert.equal(file, 'fixture-native');
        child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null,
          stdout: Object.assign(new EventEmitter(), { destroy() {} }),
          stderr: Object.assign(new EventEmitter(), { destroy() {} }), unref() {} });
        return child;
      } };
      return require(name);
    } };
  try {
    vm.runInNewContext(source + '\nthis.runScenario = scenario;', sandbox);
    await assert.rejects(sandbox.runScenario(base, { name: 'strict-outside-return', strictMode: true,
      returnOutsideRenderer: true }), /Camera capture must follow the native countdown/);
    const output = path.join(base, 'failure-artifacts');
    assert.deepEqual(fs.readdirSync(output).sort(), ['strict-outside-return-failure.json', 'strict-outside-return-native.log']);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'strict-outside-return-failure.json'), 'utf8'));
    assert.equal(report.countdown.nativeDeadline, nativeDeadline);
    assert.equal(report.countdown.startSnapshot.timer.breakActive, true);
    assert.equal(report.countdown.completionSnapshot.timer.breakActive, false);
    assert(report.countdown.completionObservedAt < nativeDeadline, 'retention cannot wait away an early transition');
    assert.equal(report.countdown.completionObservedMonotonicAt, 500);
    assert.deepEqual(report.runtime.timer.reasons, []);
    assert.equal(report.runtime.timer.absenceEpoch, 0);
    assert.equal(report.rendererProbe.probe.acquisitions, 0);
    assert.equal(child.exitCode, 0, 'failure evidence must survive clean fixture shutdown');
    assert(errors.some(value => value.includes('Camera completion failure:')));
    for (const file of ['ci.yml', 'release.yml']) {
      const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8');
      assert(workflow.includes('${{ runner.temp }}/blincho-camera-completion-*/failure-artifacts/*'));
    }
    assert(source.includes('process.env.RUNNER_TEMP || os.tmpdir()'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
