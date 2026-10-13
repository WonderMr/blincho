const test = require('node:test');
// This opens isolated native windows and runs explicitly, like tauri-smoke.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

test('native strict shields cover displays, other-app fullscreen and restore their lifecycle', { skip: process.platform !== 'darwin' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-strict-native-'));
  const executable = path.join(directory, 'strict-test');
  let fixture;
  try {
    const compile = spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=14.0',
      path.join(__dirname, 'native/macos-strict.m'), path.join(__dirname, '../src-tauri/native/macos.m'),
      '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', executable], { encoding: 'utf8', timeout: 30000 });
    assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.match(run.stdout, /PASS: native strict shields/);
    fixture = spawn(executable, ['--fullscreen-fixture', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
    let fixtureError = '';
    fixture.stderr.on('data', chunk => { fixtureError += chunk; });
    fixture.on('error', error => { fixtureError += error.message; });
    const ready = path.join(directory, 'ready.json');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < deadline && fixture.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(fs.existsSync(ready), 'Native fullscreen fixture did not enter its Space: ' + fixtureError);
    const { windowNumber } = JSON.parse(fs.readFileSync(ready, 'utf8'));
    const overFullscreen = spawnSync(executable, [], {
      env: { ...process.env, BLINCHO_FULLSCREEN_WINDOW_NUMBER: String(windowNumber) }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(overFullscreen.status, 0, overFullscreen.stderr || overFullscreen.error?.message);
    assert.match(overFullscreen.stdout, /PASS: native strict shields/);
  } finally {
    if (fixture?.exitCode === null) {
      fs.writeFileSync(path.join(directory, 'stop'), 'stop');
      await new Promise(resolve => {
        const timeout = setTimeout(() => { fixture.kill('SIGKILL'); resolve(); }, 3000);
        fixture.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
