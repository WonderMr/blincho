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
const childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
async function waitForExit(timeout = 5_000) {
  let timer;
  try {
    return await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })]);
  } finally { clearTimeout(timer); }
}
function checkChild() {
  if (launchError) throw launchError;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Native app exited: ' + (child.exitCode ?? child.signalCode));
  }
}
let sequence = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    checkChild();
    try { last = read(); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error('Session smoke timed out: ' + JSON.stringify(last));
}
async function control(operation, args = {}, expectedError = null) {
  const id = ++sequence;
  const response = path.join(directory, 'response.json');
  fs.rmSync(response, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (value.id === id) {
        assert.equal(value.id, id, 'Control response must belong to the current request');
        assert.equal(value.ok, expectedError === null, value.error);
        if (expectedError !== null) assert.equal(value.error, expectedError);
        return value;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    checkChild();
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
  await control('power-event', { code: 99 }, 'Invalid power code');
  await control('power-event', { code: 4 });
  console.log('PASS: native errors retain their request id and valid controls continue afterward.');
  // A runner's work area can be smaller than the default frame. Start with an
  // actual normal window, then measure its outer bounds on the target monitor.
  await control('unmaximize');
  await control('resize', { width: 780, height: 620 });
  await until(value => value.visible && !value.maximized && !value.minimized && !value.fullscreen);
  const origin = { ...target.workArea.position, scale: target.scaleFactor };
  await control('move', origin);
  await until(value => value.visible && samePosition(value, origin));
  await sleep(600);
  const normal = read();
  assert.equal(normal.maximized, false);
  const requested = {
    x: origin.x + Math.min(40, Math.max(0, target.workArea.size.width - normal.size.width)),
    y: origin.y + Math.min(50, Math.max(0, target.workArea.size.height - normal.size.height)),
    scale: target.scaleFactor,
  };
  await control('move', requested);
  await until(value => value.visible && samePosition(value, requested));
  await sleep(600); // Cache the stable native normal frame before modeling relocation.
  const placed = read();
  assert(samePosition(placed, requested), 'The native baseline must remain at its reachable target');
  const desired = { ...placed.position, scale: target.scaleFactor };
  const originalSize = placed.size;
  const originalInnerSize = placed.innerSize;
  assert(originalInnerSize?.width > 0 && originalInnerSize?.height > 0, 'The native baseline must report a positive content size');
  const drift = { x: desired.x + 100, y: desired.y + 100, scale: target.scaleFactor };
  const originalFrame = value => samePosition(value, desired)
    && value.size.width === originalSize.width && value.size.height === originalSize.height
    && value.minimized === false && value.maximized === false && value.fullscreen === false;
  const assertBackground = value => {
    assert.equal(value.visible, false);
    assert.equal(value.focused, false);
    // GTK can omit outer-frame decorations while the window is unmapped.
    // Content size must stay stable; reopening still checks the full frame.
    assert.deepEqual(value.innerSize, originalInnerSize);
    assert.equal(value.minimized, false);
    assert.equal(value.maximized, false);
    assert.equal(value.fullscreen, false);
  };
  assert(originalFrame(placed), 'The baseline must be a normal, nonminimized frame');

  await control('hide');
  await until(value => !value.visible && !value.focused);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked && !value.visible);
  await control('move', drift);
  // GTK stores a requested position for an unmapped window without updating
  // its observed outer frame. Hidden state is checked now, placement on reopen.
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && !value.visible);
  await sleep(1000);
  assertBackground(read());
  await control('show');
  await until(value => value.visible && originalFrame(value));
  console.log('PASS: hidden tray state, original monitor placement and size survive modeled lock/unlock.');

  await control('hide');
  await until(value => !value.visible && !value.focused);
  await sleep(600);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked && !value.visible);
  await control('power-event', { code: 1 });
  await control('move', drift);
  await sleep(600);
  const hiddenAbsence = await until(value => value.timer.locked && value.timer.suspended && !value.visible);
  assertBackground(hiddenAbsence);
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.timer.suspended);
  await sleep(800);
  const stillHidden = read();
  assert.equal(stillHidden.timer.locked, false);
  assert.equal(stillHidden.timer.suspended, true);
  assert(samePosition(stillHidden, hiddenAbsence.position), 'Unlock during sleep must preserve the observed hidden frame');
  assertBackground(stillHidden);
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && !value.visible);
  await sleep(1000);
  assertBackground(read());
  await control('show');
  await until(value => value.visible && originalFrame(value));
  console.log('PASS: overlapping lock and sleep retain hidden state and restore placement on reopen.');

  await sleep(600);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked && value.visible);
  await control('move', drift);
  const visibleAbsence = await until(value => value.timer.locked && value.visible && !samePosition(value, desired));
  assert.deepEqual(visibleAbsence.size, originalSize);
  // Begin the second reason after observable drift. Recapturing here would
  // replace the original snapshot and fail the final restoration assertion.
  await control('power-event', { code: 1 });
  await until(value => value.timer.locked && value.timer.suspended);
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.timer.suspended);
  await sleep(800);
  const stillAbsent = read();
  assert.equal(stillAbsent.timer.locked, false);
  assert.equal(stillAbsent.timer.suspended, true);
  assert(samePosition(stillAbsent, visibleAbsence.position), 'Unlock during sleep must not restore the visible frame early');
  assert.equal(stillAbsent.visible, true);
  assert.deepEqual(stillAbsent.size, originalSize);
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && !value.timer.locked && value.visible && originalFrame(value));
  console.log('PASS: overlapping lock and sleep keep one original snapshot until both absences end.');

  await sleep(600);
  await control('power-event', { code: 1 });
  await until(value => value.timer.suspended && value.visible);
  await control('move', drift);
  await until(value => value.timer.suspended && value.visible && !samePosition(value, desired));
  await control('power-event', { code: 2 });
  await until(value => !value.timer.suspended && value.visible && originalFrame(value));
  console.log('PASS: visible window resumes at its original placement.');

  await control('power-event', { code: 3 });
  await until(value => value.timer.locked && value.visible);
  await control('move', drift);
  await until(value => value.timer.locked && value.visible && !samePosition(value, desired));
  await control('power-event', { code: 4 });
  await control('hide');
  await until(value => !value.timer.locked && !value.visible);
  await sleep(1000);
  assertBackground(read());
  await control('show');
  await until(value => value.visible && originalFrame(value));
  console.log('PASS: explicit hide during delayed restoration supersedes earlier visibility.');

  await control('minimize');
  await until(value => value.minimized);
  await control('power-event', { code: 3 });
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.minimized);
  await sleep(1000);
  assert.equal(read().minimized, true);
  await control('show');
  await until(value => value.visible && originalFrame(value));
  console.log('PASS: a minimized window stays minimized; explicit reopen remains available.');

  await control('fullscreen', { active: true });
  await until(value => value.size.width > originalSize.width || value.size.height > originalSize.height);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked);
  await control('move', drift);
  await until(value => value.timer.locked && value.visible && !samePosition(value, desired));
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked && value.visible && originalFrame(value));
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
  await until(value => value.visible && originalFrame(value));
  console.log('PASS: a maximized tray window stays hidden and retains its normal frame for explicit reopen.');

  await control('eval', { script: `(()=>{const start=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Do now');if(!start)throw Error('Exercise action unavailable');start.click()})()` });
  await until(value => value.timer.exercising && !value.timer.breakActive);
  await control('hide');
  await until(value => !value.visible && value.timer.exercising);
  await control('tray-rest');
  await until(value => value.visible && value.timer.exercising && !value.timer.breakActive);
  await control('eval', { script: `(()=>{const close=document.querySelector('button[aria-label="Close exercise"]');if(!close)throw Error('Exercise close unavailable');close.click()})()` });
  await until(value => value.visible && !value.timer.exercising && !value.timer.breakActive);
  await sleep(600);
  await control('power-event', { code: 3 });
  await until(value => value.timer.locked);
  await control('move', drift);
  await control('power-event', { code: 4 });
  await until(value => !value.timer.locked);
  await sleep(1200);
  const afterIgnoredTrayBreak = read();
  assert.equal(afterIgnoredTrayBreak.visible, true, 'A tray break rejected during an exercise must not leave a hidden restore snapshot');
  assert(originalFrame(afterIgnoredTrayBreak), 'Later lock must preserve the current visible normal frame');
  console.log('PASS: a rejected tray break during an exercise cannot replace a later lock snapshot.');

  const result = { status: 'passed', platform: process.platform, monitors: initial.monitors.length,
    checks: ['native error response correlation', 'tray visibility and focus', 'monitor placement and size', 'hidden overlapping lock and sleep', 'visible overlapping lock and sleep', 'visible resume', 'explicit hide during restoration', 'minimized resume and manual reopen', 'interrupted fullscreen restoration', 'hidden maximized window and normal frame', 'ignored tray break during exercise', 'bounded successful child exit'],
    profile: directory, presence: 'modeled power events; physical lock, sleep and cable disconnection are not tested' };
  try { await control('quit'); } catch (error) {
    // Some native loops exit before their response file can be written. Only
    // an already observed successful exit can replace the quit acknowledgment.
    if (child.exitCode !== 0 || child.signalCode !== null) throw error;
  }
  const exit = await waitForExit();
  assert(exit, 'Native app must exit after quit');
  assert.equal(exit.code, 0, 'Native app must exit successfully');
  assert.equal(exit.signal, null);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  child.kill();
  if (!await waitForExit(3_000)) {
    child.kill('SIGKILL');
    if (!await waitForExit(3_000)) {
      console.error('Native app did not exit after forced cleanup');
      child.unref();
    }
  }
});
