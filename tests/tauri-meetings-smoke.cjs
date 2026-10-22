// Native and renderer integration with an isolated profile and modeled calls.
// Actual meeting app detection remains covered by platform parser tests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { loadNotificationAreaProof, callIndicatorReady, assertCallIndicator, assertCallRestored } = require('./support/windowsNotificationArea.cjs');
const notificationAreaProof = loadNotificationAreaProof();
let nativeIconRejectionObserved = false;
function assertIndicator(tray, active) {
  assertCallIndicator(tray, active, notificationAreaProof);
  if (tray.callIndicatorError !== null) nativeIconRejectionObserved = true;
}
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-meetings-smoke-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: true, cameraLockEnabled: false, strictMode: true,
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
async function control(operation, args = {}, expectedError = null) {
  const id = ++sequence;
  const response = path.join(directory, 'response.json');
  fs.rmSync(response, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (value.id === id) {
        assert.equal(value.ok, expectedError === null, value.error);
        if (expectedError !== null) assert.equal(value.error, expectedError);
        return value;
      }
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
  await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,meetingProbe:${marker},stats:JSON.parse(localStorage.getItem('myeyes_stats_v1')||'[]'),breakDialog:!!document.querySelector('.fullscreen-break-takeover[role="dialog"]'),historyEnabled:JSON.parse(localStorage.getItem('myeyes_settings_v1')||'{}').meetingHistoryEnabled===true,historyToggle:document.querySelector('#statistics-meeting-history-enabled')?{checked:document.querySelector('#statistics-meeting-history-enabled').checked,disabled:document.querySelector('#statistics-meeting-history-enabled').disabled}:null,deleteConfirmation:!!document.querySelector('#statistics-meeting-history-confirm-delete'),activeElementId:document.activeElement?.id||'',callsText:document.querySelector('.statistics-meetings')?.textContent||'',callRows:document.querySelectorAll('.statistics-meeting-list tbody tr').length,horizontalOverflow:document.querySelector('.statistics-meetings')?document.querySelector('.statistics-meetings').scrollWidth-document.querySelector('.statistics-meetings').clientWidth:0}})` });
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
/**
 * Verify repeated call postponement without focus or shields, then automatic
 * strict takeover after confirmed call end and cleanup of native presentation.
 */
async function verifyStrictMeetingExpiry() {
  const before = read();
  const input = { totalMs: 3600000, remainingMs: 1000, manualPaused: false,
    breakActive: false, exercising: false, expiryPending: false, version: before.timer.version + 1,
    breakSeconds: 20, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: true, meetingHistoryEnabled: false, autoTakeover: true };
  // The native heartbeat and renderer can both claim expiry. Either path must
  // publish the same five-minute timer without acquiring break presentation.
  /** Recognize a newly committed five-minute postponement without a pending expiry. */
  const isPostponed = (value, version) => value.timer.version > version &&
    value.timer.remainingMs > 295000 && value.timer.remainingMs <= 300000 &&
    !value.timer.expiryPending;
  await control('configure', { input });
  const postponed = await until(value => isPostponed(value, input.version));
  assert(postponed.timer.remainingMs > 295000 && postponed.timer.remainingMs <= 300000,
    'An active call must postpone strict expiry for five minutes');
  assert.equal(postponed.timer.expiryPending, false);
  assert.equal(postponed.timer.breakActive, false);
  assert.equal(postponed.strict, false);
  assert.equal(postponed.visible, false, 'Strict meeting postponement cannot show the hidden window');
  assert.equal(postponed.focused, false, 'Strict meeting postponement cannot steal focus');
  assert.equal(postponed.strictShieldCount, 0, 'Strict meeting postponement cannot acquire native shields');
  await sleep(1200);
  const stable = read();
  assert.equal(stable.timer.breakActive, false);
  assert.equal(stable.visible, false);
  assert.equal(stable.focused, false);
  assert.equal(stable.strict, false);
  // Accelerate only the work deadline. The real native postponement must still be five minutes.
  const repeatedVersion = stable.timer.version + 1;
  await control('configure', { input: { ...input, version: repeatedVersion } });
  const repeated = await until(value => isPostponed(value, repeatedVersion));
  assert(repeated.timer.remainingMs > 295000 && repeated.timer.remainingMs <= 300000);
  assert.equal(repeated.timer.breakActive, false);
  assert.equal(repeated.visible, false);
  assert.equal(repeated.focused, false);
  assert.equal(repeated.strict, false);
  await control('meeting', { active: false, applications: [] });
  await until(value => value.timer.liveMeetingStatus?.inMeeting === false);
  // Keep the due postponement intact while call end is confirmed. The native
  // timer must reclaim it automatically, without a synthetic expiry command.
  const strictBreak = await until(value => value.timer.breakActive && value.strict && value.visible &&
    (process.platform !== 'darwin' || value.strictShieldCount > 0));
  assert.equal(strictBreak.closable, false, 'A resumed strict break must keep its native close guard');
  // Tauri's Linux backend always reports minimizable, so verify its command guard directly.
  if (process.platform !== 'linux') assert.equal(strictBreak.minimizable, false);
  await control('minimize', {}, 'Strict break active');
  await until(value => value.timer.breakActive && value.strict && value.visible && !value.minimized);
  await inspectUntil(value => value.renderer.breakDialog);
  const restored = await until(value => !value.timer.breakActive && !value.strict &&
    !value.visible && !value.focused && value.strictShieldCount === 0 && !value.fullscreen, 30000);
  assert.equal(restored.timer.meetingPostponedEpoch, repeated.timer.meetingPostponedEpoch,
    'An ended call cannot postpone the next strict break');
  console.log('PASS: active calls repeatedly postpone hidden strict expiry, then call end restores strict presentation and cleanup.');
}
(async () => {
  console.log('Meeting smoke profile: ' + directory);
  const initial = await launch();
  await control('meeting', { active: true, applications: ['Zoom'] });
  const liveDefaultOff = await until(value => value.timer.liveMeetingEnabled && value.timer.liveMeetingStatus?.inMeeting &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Zoom'));
  assertIndicator(liveDefaultOff.trayPreview, true);
  assert.deepEqual(liveDefaultOff.timer.liveMeetingStatus.applications, ['Zoom']);
  assert.equal(liveDefaultOff.visible, false, 'Live calls cannot show the hidden window');
  assert.equal(liveDefaultOff.focused, false, 'Live calls cannot steal focus');
  await sleep(1200);
  assert.deepEqual(read().timer.meetingSpans, [], 'A legacy profile with no history opt-in must not record calls');
  assert.equal(read().trayPreview.callIndicatorAttempts, liveDefaultOff.trayPreview.callIndicatorAttempts,
    'Stable calls cannot retry rejected icons before the cooldown');
  assert.equal(read().trayPreview.callIndicatorUpdates, liveDefaultOff.trayPreview.callIndicatorUpdates,
    'Stable calls cannot repeatedly replace icons');
  await verifyStrictMeetingExpiry();
  const defaultOff = await selectStatistics();
  assert.equal(defaultOff.renderer.historyEnabled, false);
  assert.equal(defaultOff.renderer.historyToggle.checked, false);
  assert.equal(defaultOff.renderer.historyToggle.disabled, false, 'Isolated modeled detection supports explicit opt-in');
  assert.deepEqual(savedCalls(defaultOff), []);
  await control('meeting', { active: false, applications: [] });
  const inactiveDefaultOff = await until(value => value.timer.liveMeetingStatus?.inMeeting === false &&
    callIndicatorReady(value.trayPreview, false, notificationAreaProof) &&
    value.trayPreview.callStatus === value.trayPreview.summary.meetingInactiveLabel);
  assertCallRestored(liveDefaultOff.trayPreview, inactiveDefaultOff.trayPreview, notificationAreaProof);
  // Detection and history remain independent even when the host cannot show icons.
  await control('meeting', { active: true, applications: ['Google Chrome'] });
  const beforeDisable = await until(value => value.timer.liveMeetingStatus?.inMeeting &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Google Chrome'));
  assertIndicator(beforeDisable.trayPreview, true);
  assert(beforeDisable.trayPreview.callIndicatorAttempts > inactiveDefaultOff.trayPreview.callIndicatorAttempts,
    'A new call immediately attempts icon application after call end');
  const detectionInput = { totalMs: 3600000, remainingMs: beforeDisable.timer.remainingMs, manualPaused: false,
    breakActive: false, exercising: false, expiryPending: false, version: beforeDisable.timer.version + 1,
    breakSeconds: 20, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: false, meetingHistoryEnabled: false, autoTakeover: true };
  await control('configure', { input: detectionInput });
  const disabled = await until(value => !value.timer.liveMeetingEnabled && value.timer.liveMeetingStatus === null &&
    callIndicatorReady(value.trayPreview, false, notificationAreaProof) &&
    value.trayPreview.callStatus === value.trayPreview.summary.meetingDisabledLabel);
  assertCallRestored(beforeDisable.trayPreview, disabled.trayPreview, notificationAreaProof);
  assert.deepEqual(disabled.timer.meetingSpans, [], 'Disabling live detection cannot opt into history');
  await control('meeting', { active: false, applications: [] });
  await control('configure', { input: { ...detectionInput, meetingEnabled: true, version: disabled.timer.version + 1 } });
  await until(value => value.timer.liveMeetingEnabled && value.timer.liveMeetingStatus?.inMeeting === false);
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
    value.timer.meetingSpans.some(span => span.app === 'Zoom' && span.end - span.start >= 1500) &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Zoom'));
  assertIndicator(zoom.trayPreview, true);
  assert(zoom.timer.meetingSpans.every(span => span.start >= started - 1000), 'First detection must not backfill startup time');
  assert(zoom.timer.meetingApplications.includes('Zoom'));
  await control('meeting', { active: true, applications: ['Google Chrome'] });
  const chrome = await until(value => value.timer.meetingSpans.some(span => span.app === 'Google Chrome' && span.end - span.start >= 1500) &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Google Chrome'));
  assertIndicator(chrome.trayPreview, true);
  if (zoom.trayPreview.callIndicatorActive) {
    assert.equal(chrome.trayPreview.callIndicatorUpdates, zoom.trayPreview.callIndicatorUpdates,
      'Changing call apps keeps the already applied badge');
  }
  await control('meeting', { active: false, applications: [] });
  const ended = await until(value => value.timer.meetingApplications.length === 0 &&
    value.timer.liveMeetingStatus?.inMeeting === false && callIndicatorReady(value.trayPreview, false, notificationAreaProof));
  assertCallRestored(chrome.trayPreview, ended.trayPreview, notificationAreaProof);
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
  const optedOutCall = await until(value => value.timer.liveMeetingStatus?.inMeeting &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Zoom'));
  assertIndicator(optedOutCall.trayPreview, true);
  await sleep(1200);
  assert.equal(Math.max(...read().timer.meetingSpans.map(span => span.end)), finalEnd, 'Opt-out stops future recording without deleting past calls');
  await control('meeting', { active: false, applications: [] });
  const optedOutEnd = await until(value => value.timer.liveMeetingStatus?.inMeeting === false &&
    callIndicatorReady(value.trayPreview, false, notificationAreaProof));
  assertCallRestored(optedOutCall.trayPreview, optedOutEnd.trayPreview, notificationAreaProof);
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
    notificationArea: nativeIconRejectionObserved
      ? 'unavailable: same-machine native SDK proof confirmed ARM64 CI NIM_ADD rejection; visible icon remains unverified'
      : 'native call icon and restoration successfully applied',
    checks: ['live call tray with history off', 'repeated hidden strict expiry postponement', 'call end resumes strict presentation and cleanup', 'inactive and disabled detection', 'native icon success or independently proven rejection diagnostics', 'legacy default off', 'explicit UI opt-in', 'native hidden heartbeat', 'manual pause and strict recording', 'app attribution and transitions', 'call end', 'renderer storage', 'statistics app rows', 'opt-out without deletion', 'restart persistence', 'explicit delete confirmation', 'native and local deletion', 'no stale replay after clearing'],
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
