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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
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
async function inspect() {
  const marker = ++sequence;
  await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,warningProbe:${marker},warning:!!document.getElementById('meeting-warning-title'),breakDialog:!!document.querySelector('.fullscreen-break-takeover'),buttons:Array.from(document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button')).map(b=>b.textContent),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})` });
  return until(state => state.renderer?.warningProbe === marker);
}
async function prepareWarning() {
  await control('meeting', { active: true, applications: ['Zoom'] });
  const state = read();
  await control('configure', { input: { totalMs: 60000, remainingMs: 5000, version: state.timer.version + 1,
    manualPaused: false, breakActive: false, exercising: false, expiryPending: false,
    breakSeconds: 20, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: true, meetingHistoryEnabled: false, autoTakeover: true } });
  await until(value => value.timer.liveMeetingStatus?.inMeeting);
  await control('meeting', { active: false });
  await until(value => value.timer.meetingWarningEndAt > Date.now());
  let visible;
  for (let tries = 0; tries < 20; tries++) {
    visible = await inspect();
    if (visible.renderer.warning) break;
    await sleep(100);
  }
  assert(visible.renderer.warning, 'the in-app panel works with OS notifications disabled');
  assert.equal(visible.renderer.breakDialog, false);
  assert.equal(visible.strictShieldCount, 0, 'strict shields cannot precede the warning deadline');
  assert.equal(visible.renderer.buttons.length, 4);
  assert(visible.renderer.overflow <= 1, 'warning fits the native viewport');
  return visible;
}
(async () => {
  await until(value => value.renderer?.ready && value.timer.totalMs > 0);
  await prepareWarning();
  await control('eval', { script: `document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button')[1].click()` });
  let state = await until(value => !value.timer.expiryPending && value.timer.remainingMs > 590000);
  assert.equal(state.timer.meetingRemindersPaused, false);
  assert.equal(state.strictShieldCount, 0);
  await prepareWarning();
  await control('meeting', { active: true, applications: ['Zoom'] });
  await control('eval', { script: `document.querySelectorAll('[aria-labelledby="meeting-warning-title"] button')[3].click()` });
  state = await until(value => value.timer.meetingRemindersPaused);
  assert.equal(state.timer.meetingWarningEndAt, null);
  assert.equal(state.strictShieldCount, 0);
  await control('meeting', { active: false });
  state = await until(value => value.timer.meetingPauseEndedEpoch === 1);
  assert.equal(state.timer.meetingRemindersPaused, false);
  assert.equal(state.strictShieldCount, 0);
  await control('quit');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  assert.equal(child.exitCode, 0);
  const result = { passed: true, profile: directory, checks: ['real WKWebView warning', 'no early strict shields',
    'notification-off panel', 'duration buttons', 'native10-minute postpone', 'pause until meeting end', 'native end resumption', 'no overflow'],
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
