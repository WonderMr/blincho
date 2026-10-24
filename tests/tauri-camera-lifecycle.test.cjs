const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { cleanupCameraFixture } = require('./support/cameraLifecycleCleanup.cjs');

// Include fixture startup under the full suite's CPU load, then the smoke's
// unchanged 5-second quit and 1-second termination windows. A hung smoke still fails.
const FIXTURE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 25_000;

async function runFixture(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-camera-lifecycle-'));
  const events = path.join(directory, 'events.jsonl');
  try {
    fs.mkdirSync(path.join(directory, 'tests'));
    fs.mkdirSync(path.join(directory, 'dist/assets'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'tauri-camera-smoke.cjs'), path.join(directory, 'tests/tauri-camera-smoke.cjs'));
    fs.writeFileSync(path.join(directory, 'dist/assets/cameraModel-fixture.js'), '// Native boundary fixture, no detector or camera is launched.');
    fs.writeFileSync(path.join(directory, 'preload.cjs'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      const cp = require('node:child_process');
      const originalSpawn = cp.spawn;
      if (process.env.BLINCHO_LIFECYCLE_MODE === 'windows-fallback') {
        const hostTmpdir = os.tmpdir(); os.tmpdir = () => hostTmpdir;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        cp.execFileSync = (command, args, options) => {
          const events = path.join(process.env.BLINCHO_LIFECYCLE_FIXTURE, 'events.jsonl');
          const records = fs.readFileSync(events, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
          assert.equal(command, 'taskkill');
          assert.deepEqual(args, ['/PID', String(records.find(value => value.event === 'wrapper-start').pid), '/T', '/F']);
          assert.equal(options.timeout, 1000); assert.equal(options.stdio, 'ignore'); assert.equal(options.windowsHide, true);
          fs.appendFileSync(events, JSON.stringify({ event: 'windows-taskkill', pid: process.pid }) + '\\n');
          for (const event of ['native-start', 'wrapper-start']) {
            try { process.kill(records.find(value => value.event === event).pid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        };
      }
      cp.spawn = (file, args, options) => {
        if (file !== 'fixture-native' || args.length) throw Error('Unexpected native launch');
        assert.equal(options.env.BLINCHO_SMOKE_MEETINGS, '1', 'Camera smoke must model supported call detection independently of host audio services');
        if (process.env.BLINCHO_LIFECYCLE_MODE === 'windows-fallback') assert.equal(options.detached, false);
        fs.writeFileSync(path.join(process.env.BLINCHO_LIFECYCLE_FIXTURE, 'profile.txt'), options.env.BLINCHO_PROTOTYPE_TEST_DIR);
        return process.env.BLINCHO_LIFECYCLE_MODE === 'launch-error'
          ? originalSpawn(path.join(process.env.BLINCHO_LIFECYCLE_FIXTURE, 'missing-native'), args, options)
          : originalSpawn(process.execPath, [path.join(process.env.BLINCHO_LIFECYCLE_FIXTURE, 'wrapper.cjs')], { ...options, windowsHide: true });
      };
    `);
    fs.writeFileSync(path.join(directory, 'wrapper.cjs'), `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const directory = process.env.BLINCHO_LIFECYCLE_FIXTURE;
      const record = event => fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ event, pid: process.pid }) + '\\n');
      record('wrapper-start');
      const native = spawn(process.execPath, [path.join(directory, 'native.cjs')], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      native.on('exit', code => { record('wrapper-native-exit'); process.exit(code ?? 1); });
      process.on('SIGTERM', () => { record('wrapper-sigterm'); process.exit(0); });
    `);
    fs.writeFileSync(path.join(directory, 'native.cjs'), `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const directory = process.env.BLINCHO_LIFECYCLE_FIXTURE;
      const profile = process.env.BLINCHO_PROTOTYPE_TEST_DIR;
      const mode = process.env.BLINCHO_LIFECYCLE_MODE;
      const ignoresQuit = mode === 'ignore-quit' || mode === 'windows-fallback';
      const record = event => fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ event, pid: process.pid }) + '\\n');
      record('native-start');
      const write = cameraSmoke => fs.writeFileSync(path.join(profile, 'runtime-diagnostics.json'), JSON.stringify({ renderer: { ready: true, cameraSmoke }, timer: { totalMs: 1 } }));
      write();
      process.on('SIGTERM', () => { record('native-sigterm'); if (!ignoresQuit) process.exit(0); });
      setInterval(() => {
        const file = path.join(profile, 'control.json');
        if (!fs.existsSync(file)) return;
        const command = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.rmSync(file);
        if (command.operation === 'eval') {
          record('native-eval');
          if (command.script.includes('cameraCachePrepared:true')) { fs.writeFileSync(path.join(profile, 'runtime-diagnostics.json'), JSON.stringify({ renderer: { ready: true, cameraCachePrepared: true }, timer: { totalMs: 1 } })); return; }
          if (command.script === 'location.reload()') { write(); return; }
          write({ passed: true, detections: 0, webglRequests: 0, cameraAPI: true, lockAPI: true, lockRejected: true, defaultDisabled: mode !== 'assertion-error', toggleReady: true });
        } else if (command.operation === 'quit') {
          record('native-quit');
          if (mode === 'retained-pipe') {
            const descendant = spawn(process.execPath, [path.join(directory, 'retained-pipe.cjs')], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
            fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ event: 'retained-pipe-start', pid: descendant.pid }) + '\\n');
          }
          if (!ignoresQuit) process.exit(0); // Deliberately omit response.json, matching the native quit race.
        } else throw Error('Unexpected test operation');
      }, 20);
    `);
    fs.writeFileSync(path.join(directory, 'retained-pipe.cjs'), 'setInterval(() => {}, 1000);');
    const result = spawnSync(process.execPath, ['--require', path.join(directory, 'preload.cjs'), path.join(directory, 'tests/tauri-camera-smoke.cjs')], {
      cwd: directory, encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS,
      env: { ...process.env, BLINCHO_PROTOTYPE_EXECUTABLE: 'fixture-native', BLINCHO_LIFECYCLE_FIXTURE: directory, BLINCHO_LIFECYCLE_MODE: mode },
    });
    return { ...result, events: fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line).event) : [] };
  } finally {
    // A pre-fix timeout intentionally leaves the native child holding the pipes.
    // Clean only PIDs recorded by this fixture, including that failure path.
    const pids = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid) : [];
    const profile = path.join(directory, 'profile.txt');
    const directories = fs.existsSync(profile) ? [fs.readFileSync(profile, 'utf8'), directory] : [directory];
    await cleanupCameraFixture({ pids, directories });
  }
}

test('camera smoke quits the native child before terminating its pipe-owning wrapper', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('graceful');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, ['wrapper-start', 'native-start', 'native-eval', 'native-eval', 'native-eval', 'native-quit', 'wrapper-native-exit']);
  assert.match(result.stdout, /"lockRejected": true/);
  assert.match(result.stdout, /"webglRequests": 0/);
});

test('camera smoke preserves assertion failures and gracefully cleans the native child', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('assertion-error');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.deepEqual(result.events, ['wrapper-start', 'native-start', 'native-eval', 'native-eval', 'native-eval', 'native-quit', 'wrapper-native-exit']);
});

test('camera smoke bounds an ignored quit and cleans a native child retaining wrapper pipes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('ignore-quit');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Camera smoke did not quit/);
  assert(result.events.includes('native-quit'));
  if (process.platform !== 'win32') {
    assert(result.events.indexOf('native-quit') < result.events.indexOf('wrapper-sigterm'));
    assert(result.events.includes('native-sigterm'));
  }
});

test('camera smoke reports failed native launch without leaving subprocess pipes open', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('launch-error');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(result.events, []);
});

test('camera smoke closes its pipes when a descendant escapes wrapper process-tree cleanup', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('retained-pipe');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Camera smoke did not quit/);
  assert.deepEqual(result.events, ['wrapper-start', 'native-start', 'native-eval', 'native-eval', 'native-eval', 'native-quit', 'retained-pipe-start', 'wrapper-native-exit']);
});

test('camera smoke Windows fallback requests quit before a bounded taskkill tree command', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runFixture('windows-fallback');
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Camera smoke did not quit/);
  assert(result.events.indexOf('native-quit') >= 0);
  assert(result.events.indexOf('native-quit') < result.events.indexOf('windows-taskkill'));
  assert(!result.events.includes('wrapper-sigterm'));
});
