// Exercise the real native warning and its React controls in an isolated profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-meeting-warning-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 1, breakSeconds: 20,
    strictMode: true, meetingDetectionEnabled: true, idleDetectionEnabled: false,
    cameraLockEnabled: false, enhancedPresenceEnabled: false, soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target/release/blincho');
const child = spawn(executable, ['--autostart'], { env: { ...process.env,
  BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source,
  BLINCHO_SMOKE_PRESENCE: '1', BLINCHO_SMOKE_MEETINGS: '1' }, stdio: ['ignore', 'inherit', 'inherit'] });
let launchError, sequence = 0;
child.once('error', error => { launchError = error; });
/** Yield to the native app and renderer for the requested milliseconds. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Read the isolated app's latest diagnostics, propagating missing or partial-file errors. */
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
/** Poll diagnostics until predicate matches; tolerate partial writes and fail on exit or timeout. */
async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Native warning app exited');
    try { state = read(); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (state && predicate(state)) return state;
    await sleep(100);
  }
  throw Error('Warning smoke timed out: ' + JSON.stringify(state));
}
/** Atomically submit a numbered test command and require its matching successful response. */
async function control(operation, args = {}) {
  const id = ++sequence;
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  for (let tries = 0; tries < 100; tries++) {
    try {
      const reply = JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8'));
      if (reply.id === id) { assert(reply.ok, reply.error); return reply; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Control timed out: ' + operation);
}
/** Request a fresh renderer probe and wait for its unique marker in native diagnostics. */
async function inspect() {
  const marker = ++sequence;
  await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,warningProbe:${marker},control:!!document.querySelector("[data-meeting-control]"),breakControl:!!document.querySelector("[data-meeting-break-control]"),warning:!!document.getElementById('meeting-warning-title'),settings:!!document.getElementById('settings-dialog-title'),modalCount:document.querySelectorAll('[aria-modal="true"]').length,warningKeyboard:window.__meetingWarningKeyboard,breakDialog:!!document.querySelector('.fullscreen-break-takeover'),buttons:Array.from(document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button')).map(b=>b.textContent),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})` });
  return until(state => state.renderer?.warningProbe === marker);
}
/** Set a new timer version with strict meeting detection while retaining the requested manual pause. */
async function configure(remainingMs, manualPaused = false) {
  const state = read();
  await control('configure', { input: { totalMs: 1200000, remainingMs, version: state.timer.version + 1,
    manualPaused, breakActive: false, exercising: false, expiryPending: false,
    breakSeconds: 60, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: true, meetingHistoryEnabled: false, autoTakeover: true } });
}
/** Force expiry and verify the four warning actions appear before any native strict shield. */
async function prepareWarning() {
  await configure(1000);
  await until(value => value.timer.meetingWarningEndAt > Date.now());
  let state;
  for (let i = 0; i < 30; i++) { state = await inspect(); if (state.renderer.warning) break; await sleep(100); }
  assert(state.renderer.warning, 'warning works with OS notifications disabled');
  assert(!state.renderer.breakDialog && state.strictShieldCount === 0, 'warning precedes strict takeover');
  assert.equal(state.renderer.buttons.length, 4);
  assert(state.renderer.overflow <= 1);
}
(async () => {
  await until(value => value.renderer?.ready && value.timer.totalMs > 0);
  await control('meeting', { active: true, applications: ['Zoom'], captureSupported: true, captureActive: false });
  await configure(900000);
  console.log('Waiting for real five-minute media-inactivity policy in isolated profile');
  let state = await until(value => value.timer.meetingResumedEpoch >= 1 && value.timer.meetingResumeToken, 325000);
  state = await inspect();
  assert(state.renderer.control && state.timer.remainingMs > 500000, 'persistent undo exists before expiry');
  await control('eval', { script: `document.querySelector('.nav-settings-button').click()` });
  state = await inspect();
  assert(state.renderer.settings, 'settings are open before the warning');
  await prepareWarning();
  await control('eval', { script: `(() => {
    const buttons = document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button');
    buttons[buttons.length - 1].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const forward = document.activeElement === buttons[0];
    buttons[0].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    window.__meetingWarningKeyboard = { forward, backward: document.activeElement === buttons[buttons.length - 1] };
  })()` });
  state = await inspect();
  assert(!state.renderer.settings && state.renderer.modalCount === 1, 'warning suspends settings focus trap');
  assert(state.renderer.warningKeyboard.forward && state.renderer.warningKeyboard.backward, 'warning retains both keyboard focus directions');
  await control('eval', { script: `document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button')[1].click()` });
  state = await until(value => !value.timer.expiryPending && value.timer.remainingMs > 590000);
  assert(!state.timer.meetingRemindersPaused && state.strictShieldCount === 0);
  await prepareWarning();
  await until(value => value.timer.breakActive, 45000);
  for (let i = 0; i < 30; i++) { state = await inspect(); if (state.renderer.breakControl) break; await sleep(100); }
  assert(state.renderer.breakControl && state.timer.meetingBreakCancellable, 'meeting undo remains on strict break');
  assert(!state.renderer.settings && state.renderer.modalCount === 1, 'strict break retains exclusive modal focus');
  await control('eval', { script: `document.querySelector('[data-meeting-break-control] button').click()` });
  state = await until(value => !value.timer.breakActive && value.timer.meetingRemindersPaused && value.strictShieldCount === 0);
  state = await inspect();
  assert(!state.renderer.breakDialog && state.renderer.control && state.timer.breakEndAt === null);
  await sleep(6500);
  state = read();
  assert(state.timer.meetingRemindersPaused, 'active muted meeting retains user override');
  await configure(600000);
  const endedEpoch = state.timer.meetingPauseEndedEpoch;
  await control('meeting', { active: false, captureSupported: true, captureActive: false });
  state = await until(value => !value.timer.meetingRemindersPaused && value.timer.meetingPauseEndedEpoch > endedEpoch);
  assert(!state.timer.manualPaused && state.timer.meetingResumeToken === null, 'running reminders restore automatically at meeting end');
  state = await inspect();
  assert(!state.renderer.control && !state.renderer.breakDialog, 'normal work countdown continues without a premature break');
  // Repeat the warning pause with a manually paused timer, so end cannot enable it.
  await control('meeting', { active: true, applications: ['Zoom'] });
  await configure(600000, true);
  await until(value => value.timer.liveMeetingStatus?.inMeeting);
  const manualVersion = read().timer.version;
  await control('meeting', { active: false });
  state = await until(value => value.timer.version > manualVersion && !value.timer.liveMeetingStatus?.inMeeting);
  assert(state.timer.manualPaused && !state.timer.breakActive, 'manual timer pause survives meeting end');
  await control('quit');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  assert.equal(child.exitCode, 0);
  const result = { passed: true, profile: directory, checks: ['real five-minute resumption', 'persistent undo before expiry',
    'warning before strict takeover', 'warning keyboard focus over settings', 'native 10-minute postpone', 'strict break cancellation', 'native shields released',
    'active muted meeting retains override', 'automatic restoration after meeting end', 'manual pause preserved at end', 'no overflow'],
    limitation: 'Call and presence signals are modeled. Actual meeting-app behavior is checked by the user.' };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
