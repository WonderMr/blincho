// Native and renderer integration with an isolated profile and modeled calls.
// Actual meeting app detection remains covered by platform parser tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-meetings-smoke-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: true, strictMode: true,
    soundEnabled: false, notificationsEnabled: false }),
  myeyes_stats_v1: JSON.stringify([{ date: '2026-10-11', breaksCompleted: 7, exercisesCompleted: 3, focusMinutes: 42 }]),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const env = { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
  BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1', BLINCHO_SMOKE_MEETINGS: '1' };
let child, launchError, sequence = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Meeting smoke app exited prematurely');
    try { last = read(); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw Error('Meeting smoke timed out: ' + JSON.stringify(last));
}
async function control(operation, args = {}) {
  const id = ++sequence;
  const response = path.join(directory, 'response.json');
  fs.rmSync(response, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (value.id === id) { assert.equal(value.ok, true, value.error); return value; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (launchError) throw launchError;
    await sleep(100);
  }
  throw Error('Meeting control timed out: ' + operation);
}
async function launch() {
  fs.rmSync(path.join(directory, 'runtime-diagnostics.json'), { force: true });
  launchError = undefined;
  child = spawn(executable, ['--autostart'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', error => { launchError = error; });
  return until(value => value.renderer?.ready && value.timer.totalMs > 0);
}
async function inspect() {
  const marker = ++sequence;
  await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,meetingProbe:${marker},stats:JSON.parse(localStorage.getItem('myeyes_stats_v1')||'[]'),historyEnabled:JSON.parse(localStorage.getItem('myeyes_settings_v1')||'{}').meetingHistoryEnabled===true,historyToggle:document.querySelector('#statistics-meeting-history-enabled')?{checked:document.querySelector('#statistics-meeting-history-enabled').checked,disabled:document.querySelector('#statistics-meeting-history-enabled').disabled}:null,deleteConfirmation:!!document.querySelector('#statistics-meeting-history-confirm-delete'),activeElementId:document.activeElement?.id||'',callsText:document.querySelector('.statistics-meetings')?.textContent||'',callRows:document.querySelectorAll('.statistics-meeting-list tbody tr').length,horizontalOverflow:document.querySelector('.statistics-meetings')?document.querySelector('.statistics-meetings').scrollWidth-document.querySelector('.statistics-meetings').clientWidth:0}})` });
  return until(value => value.renderer?.meetingProbe === marker);
}
async function stop() {
  try { await control('quit'); } catch (error) { if (child.exitCode !== 0 || child.signalCode !== null) throw error; }
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  assert.equal(child.exitCode, 0, 'App must exit successfully');
}
const savedCalls = value => value.renderer.stats.flatMap(day => day.meetings ?? []);
const canonicalCalls = spans => spans.map(({ start, end, app }) => ({ start, end, app }))
  .sort((a, b) => a.start - b.start || a.app.localeCompare(b.app));
async function inspectUntil(predicate) {
  let state;
  for (let i = 0; i < 25; i++) {
    state = await inspect();
    if (predicate(state)) return state;
    await sleep(200);
  }
  throw Error('Renderer meeting state did not commit: ' + JSON.stringify(state.renderer));
}
async function selectStatistics() {
  await control('eval', { script: `document.querySelectorAll('.nav-tabs button')[4].click()` });
  return inspectUntil(value => value.renderer.historyToggle !== null);
}
async function click(id) {
  await control('eval', { script: `document.getElementById(${JSON.stringify(id)}).click()` });
}
(async () => {
  console.log('Meeting smoke profile: ' + directory);
  const initial = await launch();
  await control('meeting', { active: true, applications: ['Zoom'] });
  await sleep(1200);
  assert.deepEqual(read().timer.meetingSpans, [], 'A legacy profile with no history opt-in must not record calls');
  const defaultOff = await selectStatistics();
  assert.equal(defaultOff.renderer.historyEnabled, false);
  assert.equal(defaultOff.renderer.historyToggle.checked, false);
  assert.equal(defaultOff.renderer.historyToggle.disabled, false, 'Isolated modeled detection supports explicit opt-in');
  assert.deepEqual(savedCalls(defaultOff), []);
  await control('meeting', { active: false, applications: [] });
  await click('statistics-meeting-history-enabled');
  await inspectUntil(value => value.renderer.historyEnabled);
  const optedIn = await until(value => value.timer.meetingHistoryEpoch > initial.timer.meetingHistoryEpoch);
  const input = { totalMs: 3600000, remainingMs: 3600000, manualPaused: true,
    breakActive: false, exercising: false, expiryPending: false, version: optedIn.timer.version + 1,
    breakSeconds: 20, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: true, meetingHistoryEnabled: true, autoTakeover: true };
  await control('configure', { input });
  await control('meeting', { active: true, applications: ['Zoom'] });
  const started = Date.now();
  const zoom = await until(value => !value.visible && value.timer.manualPaused &&
    value.timer.meetingSpans.some(span => span.app === 'Zoom' && span.end - span.start >= 1500));
  assert(zoom.timer.meetingSpans.every(span => span.start >= started - 1000), 'First detection must not backfill startup time');
  assert(zoom.timer.meetingApplications.includes('Zoom'));
  await control('meeting', { active: true, applications: ['Google Chrome'] });
  await until(value => value.timer.meetingSpans.some(span => span.app === 'Google Chrome' && span.end - span.start >= 1500));
  await control('meeting', { active: false, applications: [] });
  const ended = await until(value => value.timer.meetingApplications.length === 0);
  const expectedCalls = canonicalCalls(ended.timer.meetingSpans);
  const finalEnd = Math.max(...ended.timer.meetingSpans.map(span => span.end));
  await sleep(1200);
  assert.equal(Math.max(...read().timer.meetingSpans.map(span => span.end)), finalEnd, 'Ended calls cannot keep growing');
  assert.equal(read().visible, false, 'Call recording cannot show a hidden window');
  let persisted;
  for (let i = 0; i < 15; i++) {
    persisted = await inspect();
    if (JSON.stringify(canonicalCalls(savedCalls(persisted))) === JSON.stringify(expectedCalls)) break;
    await sleep(500);
  }
  assert(savedCalls(persisted).some(span => span.app === 'Zoom'));
  assert(savedCalls(persisted).some(span => span.app === 'Google Chrome'));
  assert.deepEqual(canonicalCalls(savedCalls(persisted)), expectedCalls, 'Persisted calls include the final native start and end timestamps');
  assert.equal(persisted.renderer.stats.find(day => day.date === '2026-10-11').focusMinutes, 42, 'Legacy totals survive');
  console.log('PASS: hidden calls retain app transitions, end timestamps and local history during manual pause and strict mode.');
  await control('show');
  await until(value => value.visible);
  await control('eval', { script: `document.querySelectorAll('.nav-tabs button')[4].click()` });
  let rendered;
  for (let i = 0; i < 20; i++) {
    rendered = await inspect();
    if (rendered.renderer.callRows >= 2) break;
    await sleep(100);
  }
  assert(rendered.renderer.callRows >= 2, 'Statistics must render both calls');
  assert(rendered.renderer.callsText.includes('Zoom') && rendered.renderer.callsText.includes('Google Chrome'));
  assert.equal(rendered.renderer.horizontalOverflow, 0, 'Call details fit the native viewport');
  const beforeRestart = savedCalls(rendered);
  await click('statistics-meeting-history-enabled');
  await inspectUntil(value => !value.renderer.historyEnabled);
  await control('meeting', { active: true, applications: ['Zoom'] });
  await sleep(1200);
  assert.equal(Math.max(...read().timer.meetingSpans.map(span => span.end)), finalEnd, 'Opt-out stops future recording without deleting past calls');
  await control('meeting', { active: false, applications: [] });
  await stop();
  await launch();
  const restarted = await inspect();
  assert.deepEqual(savedCalls(restarted), beforeRestart, 'Calls persist exactly after restart without backfilling downtime');
  assert.deepEqual(restarted.timer.meetingSpans, [], 'A restarted native process starts with no fabricated old calls');
  assert.equal(restarted.renderer.historyEnabled, false, 'Opt-out survives restart');
  await control('show');
  await until(value => value.visible);
  await selectStatistics();
  await click('statistics-meeting-history-enabled');
  await inspectUntil(value => value.renderer.historyEnabled);
  await control('meeting', { active: true, applications: ['Discord'] });
  await until(value => value.timer.meetingSpans.some(span => span.app === 'Discord' && span.end - span.start >= 1500));
  await control('meeting', { active: false, applications: [] });
  const deletionNative = await until(value => value.timer.meetingApplications.length === 0);
  const deletionCalls = canonicalCalls(deletionNative.timer.meetingSpans);
  const beforeDeletion = await inspectUntil(value => JSON.stringify(canonicalCalls(savedCalls(value).filter(span => span.app === 'Discord'))) === JSON.stringify(deletionCalls));
  assert(beforeDeletion.timer.meetingSpans.length > 0, 'Deletion is tested with a populated native buffer');
  const callsBeforeDeletion = savedCalls(beforeDeletion);
  await click('statistics-meeting-history-delete');
  const confirmation = await inspectUntil(value => value.renderer.deleteConfirmation);
  assert.deepEqual(savedCalls(confirmation), callsBeforeDeletion, 'Opening confirmation cannot delete history');
  await click('statistics-meeting-history-confirm-delete');
  const cleared = await inspectUntil(value => savedCalls(value).length === 0);
  assert.deepEqual(cleared.timer.meetingSpans, [], 'Native retained spans are cleared too');
  const focusedFeedback = await inspectUntil(value => value.renderer.activeElementId === 'statistics-meeting-history-feedback');
  assert.equal(focusedFeedback.renderer.activeElementId, 'statistics-meeting-history-feedback', 'Successful deletion restores keyboard focus to visible feedback');
  const legacy = cleared.renderer.stats.find(day => day.date === '2026-10-11');
  assert.equal(legacy.focusMinutes, 42); assert.equal(legacy.breaksCompleted, 7); assert.equal(legacy.exercisesCompleted, 3);
  await sleep(1200);
  assert.deepEqual(savedCalls(await inspect()), [], 'Old frames cannot restore deleted calls');
  await stop();
  await launch();
  const afterClearRestart = await inspect();
  assert.deepEqual(savedCalls(afterClearRestart), [], 'Deleted call history stays deleted after restart');
  assert.equal(afterClearRestart.renderer.stats.find(day => day.date === '2026-10-11').focusMinutes, 42);
  await stop();
  const result = { passed: true, platform: process.platform, profile: directory,
    checks: ['legacy default off', 'explicit UI opt-in', 'native hidden heartbeat', 'manual pause and strict recording', 'app attribution and transitions', 'call end', 'renderer storage', 'statistics app rows', 'opt-out without deletion', 'restart persistence', 'explicit delete confirmation', 'native and local deletion', 'no stale replay after clearing'],
    limitation: 'Meeting and presence signals are modeled; actual app detection is tested separately by platform parsers.' };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill();
    for (let i = 0; i < 30 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
