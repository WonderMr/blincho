const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, 'tauri-cross-platform-smoke.cjs'), 'utf8');

async function fixture(mode, inspect) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-startup-diagnostics-unit-'));
  const stderr = [];
  const sleeps = [];
  const processes = [];
  let clock = 0;
  let profile;
  const processFixture = { env: { RUNNER_TEMP: directory, BLINCHO_PROTOTYPE_EXECUTABLE: 'fixture-native' }, platform: mode === 'windows' ? 'win32' : 'linux', arch: process.arch };
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false,
    kill() { this.killed = true; if (this.exitCode === null && this.signalCode === null) { this.signalCode = 'SIGTERM'; this.emit('exit', null, this.signalCode); } return true; },
  });
  class Clock extends Date { static now() { clock += 100; return clock; } }
  try {
    const sandbox = {
      __dirname, Buffer, Date: Clock, process: processFixture,
      setTimeout(callback, milliseconds) { sleeps.push(milliseconds); return setImmediate(callback); },
      console: { log() {}, error(value) { stderr.push(String(value)); } },
      require(name) {
        if (name !== 'node:child_process') return require(name);
        return {
          spawn(file, args, options) {
            assert.equal(file, 'fixture-native');
            assert.deepEqual(Array.from(args), []);
            profile = options.env.BLINCHO_PROTOTYPE_TEST_DIR;
            assert.equal(path.dirname(profile), directory);
            assert.match(path.basename(profile), /^blincho-native-smoke-/);
            fs.writeFileSync(path.join(profile, 'startup-trace.jsonl'), '{"stage":"window-build-start"}\n');
            fs.mkdirSync(path.join(profile, 'profile'));
            fs.writeFileSync(path.join(profile, 'profile/update-preferences.json'), '{"channel":"stable"}');
            fs.writeFileSync(path.join(profile, 'profile/unrelated-private.json'), 'do not retain this content');
            if (mode === 'launch-error') queueMicrotask(() => { child.pid = undefined; child.exitCode = -2; child.emit('error', Object.assign(new Error('fixture ENOENT'), { code: 'ENOENT' })); });
            if (mode === 'signal') queueMicrotask(() => { child.signalCode = 'SIGSEGV'; child.emit('exit', null, 'SIGSEGV'); });
            if (mode === 'bounds') {
              fs.writeFileSync(path.join(profile, 'runtime-diagnostics.json'), 'x'.repeat(131_073));
              fs.writeFileSync(path.join(profile, 'legacy.json'), 'x'.repeat(16_385));
              fs.rmSync(path.join(profile, 'startup-trace.jsonl'));
              const privateFile = path.join(directory, 'outside-profile-secret');
              fs.writeFileSync(privateFile, 'do not retain outside content');
              fs.symlinkSync(privateFile, path.join(profile, 'startup-trace.jsonl'));
            }
            return child;
          },
          spawnSync(command, args, options) {
            assert.equal(mode, 'windows');
            assert.equal(command, 'powershell.exe');
            assert.match(args.at(-1), /ProcessId = 123 OR ParentProcessId = 123/);
            assert.doesNotMatch(args.at(-1), /CommandLine|Environment|ExecutablePath/i);
            assert.equal(options.timeout, 3000);
            assert.equal(options.maxBuffer, 65_536);
            processes.push(command);
            return { status: 0, signal: null, stdout: '{"ProcessId":123,"Name":"blincho.exe"}', stderr: '' };
          },
        };
      },
    };
    await vm.runInNewContext(source, sandbox, { filename: 'tauri-cross-platform-smoke.cjs' });
    const output = path.join(profile, 'failure-artifacts');
    const report = JSON.parse(fs.readFileSync(path.join(output, 'failure.json'), 'utf8'));
    assert.equal(processFixture.exitCode, 1, 'diagnostics cannot turn a smoke failure into success');
    assert.match(stderr.join('\n'), /Native smoke failure evidence:/);
    assert.match(stderr.join('\n'), /Native smoke profile listing:/);
    assert.equal(fs.existsSync(path.join(output, 'profile-unrelated-private.json')), false);
    await inspect({ child, report, output, sleeps, stderr: stderr.join('\n'), processes });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('native startup timeout preserves the 30-second gate, trace and bounded profile evidence', async () => {
  await fixture('timeout', ({ child, report, output, sleeps, stderr }) => {
    assert.match(report.error.message, /Native smoke timed out: undefined/);
    assert.equal(sleeps.length, 299, 'fake clock reaches the unchanged 30-second default deadline');
    assert(sleeps.every(value => value === 100));
    assert.equal(child.killed, true);
    assert.equal(report.child.signalCode, 'SIGTERM');
    assert.match(stderr, /window-build-start/);
    assert.equal(fs.readFileSync(path.join(output, 'profile-update-preferences.json'), 'utf8'), '{"channel":"stable"}');
  });
});

test('native launch error is retained with its child event and remains a failure', async () => {
  await fixture('launch-error', ({ report }) => {
    assert.equal(report.error.message, 'fixture ENOENT');
    assert.equal(report.lifecycle.find(value => value.event === 'error').code, 'ENOENT');
    assert.equal(report.child.exitCode, -2);
  });
});

test('signal termination fails readiness immediately and records the signal', async () => {
  await fixture('signal', ({ report, sleeps }) => {
    assert.match(report.error.message, /code=null signal=SIGSEGV/);
    assert.equal(report.child.signalCode, 'SIGSEGV');
    assert.equal(report.lifecycle.find(value => value.event === 'exit').signal, 'SIGSEGV');
    assert(sleeps.length <= 1);
  });
});

test('Windows failure process evidence uses a bounded PID-only query', async () => {
  await fixture('windows', ({ report, processes }) => {
    assert.deepEqual(processes, ['powershell.exe']);
    assert.equal(report.windowsProcess.status, 0);
    assert.match(report.windowsProcess.output, /blincho.exe/);
  });
});

test('failure artifacts omit oversized files and links outside the isolated profile', { skip: process.platform === 'win32' }, async () => {
  await fixture('bounds', ({ report, output }) => {
    assert.match(report.copies.find(value => value.path === 'runtime-diagnostics.json').omitted, /131072 byte/);
    assert.match(report.copies.find(value => value.path === 'legacy.json').omitted, /16384 byte/);
    assert.match(report.copies.find(value => value.path === 'startup-trace.jsonl').omitted, /regular isolated/);
    assert.equal(fs.existsSync(path.join(output, 'runtime-diagnostics.json')), false);
    assert.equal(fs.existsSync(path.join(output, 'startup-trace.jsonl')), false);
  });
});
