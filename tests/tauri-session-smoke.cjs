// Explicit native smoke test. Uses an isolated profile and modeled power events;
// it never locks or sleeps the user's computer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-session-smoke-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: false, strictMode: false,
    soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const env = { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' };
const child = spawn(executable, [], { env, stdio: ['ignore', 'inherit', 'inherit'] });
let launchError;
child.once('error', error => { launchError = error; });
let sequence = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('Native app exited: ' + child.exitCode);
    try { last = read(); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error('Session smoke timed out: ' + JSON.stringify(last));
}
async function control(operation, args = {}) {
  const id = ++sequence;
  const response = path.join(directory, 'response.json');
  fs.rmSync(response, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (value.id === id || value.ok === false) { assert.equal(value.ok, true, value.error); return value; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw new Error('Control timed out: ' + operation);
}
const samePosition = (value, expected) => Math.abs(value.position.x - expected.x) <= 2 && Math.abs(value.position.y - expected.y) <= 2;
(async () => {
  console.log('Session smoke profile: ' + directory);
  const initial = await until(value => value.renderer?.ready && value.timer.totalMs > 0);
  const target = initial.monitors.at(-1);
  assert(target, 'Native monitor enumeration must be available');
  const desired = { x: target.workArea.position.x + 40, y: target.workArea.position.y + 50, scale: target.scaleFactor };
  await control('move', desired);
  const placed = await until(value => samePosition(value, desired));
  await sleep(600); // Cache actual normal bounds before modeling OS relocation.
  const originalSize = placed.size;

  await control('hide');
  await until(value => !value.visible);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked);
  const drift = { x: desired.x + 100, y: desired.y + 100, scale: target.scaleFactor };
  await control('move', drift);
  await until(value => samePosition(value, drift));
  await control('power-event', { code: 4 });
  const hidden = await until(value => !value.timer.locked && !value.visible && samePosition(value, desired));
  assert.equal(hidden.focused, false);
  assert.deepEqual(hidden.size, originalSize);
  console.log('PASS: hidden tray state, original monitor placement and size survive modeled lock/unlock.');

  await control('power-event', { code: 3 });
  await control('power-event', { code: 1 });
  await control('move', drift);
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.timer.suspended);
  await sleep(800);
  assert(samePosition(read(), drift), 'Unlock during sleep must not restore early');
  assert.equal(read().visible, false);
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && !value.visible && samePosition(value, desired));
  console.log('PASS: overlapping lock and sleep keep one snapshot until both absences end.');

  await control('show');
  await until(value => value.visible && samePosition(value, desired));
  await sleep(600);
  await control('power-event', { code: 1 });
  await control('move', drift);
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && value.visible && samePosition(value, desired));
  console.log('PASS: visible window resumes at its original placement.');

  await control('power-event', { code: 3 });
  await control('move', drift);
  await control('power-event', { code: 4 });
  await control('hide');
  await until(value => !value.timer.locked && !value.visible && samePosition(value, desired));
  await sleep(1000);
  assert.equal(read().visible, false);
  await control('show');
  await until(value => value.visible && samePosition(value, desired));
  console.log('PASS: explicit hide during delayed restoration supersedes earlier visibility.');

  await control('minimize');
  await until(value => value.minimized);
  await control('power-event', { code: 3 });
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.minimized);
  await sleep(1000);
  assert.equal(read().minimized, true);
  await control('show');
  await until(value => value.visible && !value.minimized && samePosition(value, desired));
  console.log('PASS: a minimized window stays minimized; explicit reopen remains available.');

  await control('fullscreen', { active: true });
  await until(value => value.size.width > originalSize.width || value.size.height > originalSize.height);
  await control('power-event', { code: 3 });
  await control('move', drift);
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && samePosition(value, desired) && value.size.width === originalSize.width && value.size.height === originalSize.height);
  console.log('PASS: interrupted break fullscreen restores the original normal frame.');

  await control('maximize');
  await until(value => value.maximized);
  await sleep(600);
  await control('hide');
  await until(value => !value.visible);
  await control('power-event', { code: 1 });
  await control('move', drift);
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && !value.visible);
  await sleep(1200);
  assert.equal(read().visible, false, 'restoring a maximized window cannot show it from tray');
  await control('show');
  await until(value => value.visible && value.maximized);
  await control('unmaximize');
  await until(value => value.visible && !value.maximized && samePosition(value, desired));
  console.log('PASS: a maximized tray window stays hidden and retains its normal frame for explicit reopen.');

  const result = { status: 'passed', platform: process.platform, monitors: initial.monitors.length,
    checks: ['tray visibility and focus', 'monitor placement and size', 'overlapping lock and sleep', 'visible resume', 'explicit hide during restoration', 'minimized resume and manual reopen', 'interrupted fullscreen restoration', 'hidden maximized window and normal frame'],
    profile: directory, presence: 'modeled power events; physical lock, sleep and cable disconnection are not tested' };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  await control('quit');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); child.kill(); process.exitCode = 1; });
