const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { cleanupCameraFixture } = require('./support/cameraLifecycleCleanup.cjs');

const missingProcess = () => Object.assign(Error('No such process'), { code: 'ESRCH' });

test('fixture cleanup waits for every recorded PID to exit before removing either directory', async () => {
  const signals = [], removed = [];
  let probes = 0;
  await cleanupCameraFixture({ pids: [111, 222, 111], directories: ['/fixture/profile', '/fixture/root'] }, {
    timeoutMs: 1000, pollIntervalMs: 1,
    kill(pid, signal) {
      signals.push([pid, signal]);
      if (signal === 0 && (pid === 222 || ++probes >= 3)) throw missingProcess();
    },
    remove(directory, options) {
      assert.equal(probes, 3, 'the last process must exit before deletion starts');
      assert.deepEqual(options, { recursive: true, force: true });
      removed.push(directory);
    },
  });
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGKILL'), [[111, 'SIGKILL'], [222, 'SIGKILL']]);
  assert.deepEqual(removed, ['/fixture/profile', '/fixture/root']);
});

test('fixture cleanup accepts only positive recorded PIDs other than its own process', async () => {
  for (const pid of [0, -1, NaN, process.pid]) {
    await assert.rejects(cleanupCameraFixture({ pids: [pid], directories: ['/fixture/root'] }, {
      kill() { assert.fail('invalid PIDs must not be signalled'); },
      remove() { assert.fail('invalid records must not delete paths'); },
    }), /Invalid camera lifecycle fixture PID/);
  }
});

test('fixture cleanup removes a dummy Node process working directory only after exit', { timeout: 5000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-camera-cleanup-'));
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], {
    cwd: directory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  try {
    assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
    child.disconnect();
    const exited = once(child, 'exit');
    await cleanupCameraFixture({ pids: [child.pid], directories: [directory] });
    await exited;
    assert(child.exitCode !== null || child.signalCode !== null, 'the dummy child has exited');
    assert.equal(fs.existsSync(directory), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fixture cleanup bounds a process that remains alive and does not delete its directories', async () => {
  const started = performance.now();
  await assert.rejects(cleanupCameraFixture({ pids: [111], directories: ['/fixture/root'] }, {
    timeoutMs: 40, pollIntervalMs: 5,
    kill() {},
    remove() { assert.fail('a live process must keep its directory'); },
  }), /cleanup timed out waiting for PIDs: 111/);
  assert(performance.now() - started < 2000, 'cleanup has a bounded failure path');
});

test('fixture cleanup retries a temporary Windows directory lock after the process exits', async () => {
  let attempts = 0;
  await cleanupCameraFixture({ pids: [111], directories: ['/fixture/root'] }, {
    timeoutMs: 1000, pollIntervalMs: 1,
    kill() { throw missingProcess(); },
    remove() { if (++attempts < 3) throw Object.assign(Error('Locked'), { code: 'EBUSY' }); },
  });
  assert.equal(attempts, 3);
});

test('fixture cleanup preserves a persistent directory lock as a bounded test failure', async () => {
  const error = Object.assign(Error('Directory still locked'), { code: 'EBUSY' });
  const started = performance.now();
  let attempts = 0;
  await assert.rejects(cleanupCameraFixture({ pids: [], directories: ['/fixture/root'] }, {
    timeoutMs: 40, pollIntervalMs: 5,
    remove() { attempts++; throw error; },
  }), actual => actual === error);
  assert(attempts > 1);
  assert(performance.now() - started < 2000, 'persistent filesystem errors cannot hang cleanup');
});

test('fixture cleanup preserves unexpected process and filesystem failures', async () => {
  const signalError = Object.assign(Error('Cannot signal PID'), { code: 'EPERM' });
  await assert.rejects(cleanupCameraFixture({ pids: [111], directories: ['/fixture/root'] }, {
    kill() { throw signalError; },
    remove() { assert.fail('failed termination must not delete paths'); },
  }), actual => actual === signalError);
  const removeError = Object.assign(Error('Cannot read path'), { code: 'EIO' });
  let attempts = 0;
  await assert.rejects(cleanupCameraFixture({ pids: [], directories: ['/fixture/root'] }, {
    remove() { attempts++; throw removeError; },
  }), actual => actual === removeError);
  assert.equal(attempts, 1);
});
