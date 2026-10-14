// Runs the actual Cocoa/WKWebView app with an isolated WebKit data store and fixture history.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-tauri-smoke-'));
const source = path.join(directory, 'legacy.json');
const fixture = { schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 10, breakSeconds: 4, idleDetectionEnabled: false,
    meetingDetectionEnabled: false, cameraLockEnabled: false, strictMode: true, soundEnabled: false, notificationsEnabled: false }),
  myeyes_stats_v1: '[{"date":"2026-10-11","breaksCompleted":7,"exercisesCompleted":3,"focusMinutes":42,"techniqueCounts":{"blink":3},"completedEventIds":["legacy-break"]}]',
  myeyes_cvs_result_v1: '{"date":"2026-10-11","score":9,"maxScore":18,"level":"self-check","title":"Самопроверка симптомов","recommendations":[]}',
  'blincho-language-v1': '{"preference":"ru","acknowledged":true}'
} };
fs.writeFileSync(source, JSON.stringify(fixture));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(repo, process.argv.includes('--bundle-debug') ? 'release/tauri-macos-debug/Blincho.app/Contents/MacOS/blincho' : 'src-tauri/target/debug/blincho');
let child, id = 0;
const nativeEnvironment = { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source };
const loginItem = path.join(os.homedir(), 'Library/LaunchAgents/com.myeyes.app.plist');
const loginMarker = path.join(os.homedir(), 'Library/Application Support/com.myeyes.app/autostart-initialized-v1');
const readOptional = filename => { try { return fs.readFileSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const originalLoginItem = readOptional(loginItem), originalLoginMarker = readOptional(loginMarker);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(predicate, timeout = 20000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { last = read(); if (predicate(last)) return last; } catch {}
    if (child?.exitCode !== null) throw new Error('Native process exited before completing the check');
    await sleep(100);
  }
  throw new Error('Timed out. Last native state: ' + JSON.stringify(last));
}
async function control(operation, args = {}, allowFailure = false) {
  const request = { operation, id: ++id, ...args };
  const response = path.join(directory, 'response.json');
  try { fs.unlinkSync(response); } catch {}
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify(request));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { const value = JSON.parse(fs.readFileSync(response, 'utf8')); if (value.id === id || value.ok === false) {
      if (!allowFailure) assert.equal(value.ok, true, value.error); return value;
    } } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw new Error('Control timed out: ' + operation);
}
async function launch(args = []) {
  try { fs.unlinkSync(path.join(directory, 'runtime-diagnostics.json')); } catch {}
  child = spawn(executable, args, { env: nativeEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', error => console.error(error));
  return until(value => value.renderer?.ready && value.timer.totalMs > 0);
}
async function duplicate(args) {
  const primary = child;
  const second = spawn(executable, args, { env: nativeEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { second.kill(); reject(new Error('Duplicate did not exit')); }, 10000);
    second.once('error', error => { clearTimeout(timeout); reject(error); });
    second.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 0); assert.equal(primary.exitCode, null);
  const hidden = args.includes('--autostart');
  const state = await until(value => value.events.some(event => event.source === 'single-instance' && event.autostart === hidden)
    && value.visible === !hidden);
  assert.equal(state.pid, primary.pid);
}
async function stop() {
  await control('quit');
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await sleep(100);
  if (child.exitCode === null) child.kill();
}
async function inspectStorage() {
  const probe = Date.now();
  await control('eval', { script: "window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,probe:" + probe + ",stats:JSON.parse(localStorage.getItem('myeyes_stats_v1')),cvs:JSON.parse(localStorage.getItem('myeyes_cvs_result_v1')),dialog:!!document.querySelector('[role=dialog]'),text:document.body.innerText.slice(0,4000)}})" });
  return until(value => value.renderer?.probe === probe);
}
(async () => {
  console.log('Native smoke directory: ' + directory);
  const initial = await launch();
  assert.equal(initial.renderer.history.status, 'imported'); assert.equal(initial.renderer.history.entryCount, 4);
  const migrated = await inspectStorage();
  const day = migrated.renderer.stats.find(value => value.date === '2026-10-11');
  assert.equal(day.breaksCompleted, 7); assert.equal(day.focusMinutes, 42); assert.equal(migrated.renderer.cvs.score, 9);
  console.log('PASS: fixture history reaches the real React UI / WKWebView with original counts and survey.');
  const input = { totalMs: 10000, remainingMs: 10000, manualPaused: false, breakActive: false, exercising: false,
    expiryPending: false, version: read().timer.version + 1, breakSeconds: 4, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60 };
  await control('configure', { input }); await control('hide');
  const hidden = await until(value => value.visible === false);
  await sleep(1500);
  const progressed = read(); assert.equal(progressed.visible, false);
  assert(hidden.timer.remainingMs - progressed.timer.remainingMs >= 1000);
  console.log('PASS: actual hidden native window retains a running Rust timer.');
  const strict = await until(value => value.visible && value.strict && value.strictShieldCount > 0 && value.closable === false && value.minimizable === false, 15000);
  assert(strict.timer.breakActive); await control('close'); await sleep(300); assert.equal(read().visible, true);
  assert.equal((await control('hide', {}, true)).ok, false);
  const overlay = await inspectStorage(); assert.equal(overlay.renderer.dialog, true);
  console.log('PASS: native expiry presents the React break; close/hide/minimize guards are active.');
  await until(value => !value.strict && value.strictShieldCount === 0 && value.closable && value.minimizable && !value.timer.breakActive, 12000);
  let finishedOverlay;
  for (let attempt = 0; attempt < 30; attempt++) {
    finishedOverlay = await inspectStorage();
    if (!finishedOverlay.renderer.dialog) break;
    await sleep(100);
  }
  assert.equal(finishedOverlay.renderer.dialog, false);
  console.log('PASS: strict mode releases automatically after the real break deadline.');
  if (process.argv.includes('--long')) {
    const long = { ...input, totalMs: 360000, remainingMs: 360000, version: read().timer.version + 1 };
    await control('configure', { input: long }); await control('hide');
    const before = read();
    for (let step = 1; step <= 31; step++) { await sleep(10000); if (step % 6 === 0) console.log('Hidden native timer: ' + (step * 10) + ' seconds.'); }
    const after = read(); assert.equal(after.visible, false);
    assert(before.timer.remainingMs - after.timer.remainingMs > 300000);
    console.log('PASS: timer remains native and running after over five minutes with the WebView hidden.');
  }
  await control('meeting', {active:true});
  const beforeMeeting=read().timer.meetingPostponedEpoch;
  await control('configure',{input:{...input,strictMode:false,meetingEnabled:true,autoTakeover:true,totalMs:10000,remainingMs:1000,version:read().timer.version+1}});
  await control('hide');
  const deferred=await until(value=>value.timer.meetingPostponedEpoch>beforeMeeting && value.timer.remainingMs>295000 && !value.visible,8000);
  assert.equal(deferred.timer.breakActive,false);
  await control('meeting',{active:false});
  await control('configure',{input:{...input,version:read().timer.version+1}});
  console.log('PASS: native meeting postponement keeps the window hidden and adds five minutes without starting a break.');
  await control('rest'); await until(value => value.strict && value.timer.breakActive);
  const beforeInterruption = await inspectStorage();
  const completedBeforeInterruption = beforeInterruption.renderer.stats.reduce((sum, day) => sum + day.breaksCompleted, 0);
  const absenceEpoch = read().timer.absenceEpoch;
  await control('power-cycle');
  await until(value => value.timer.absenceEpoch > absenceEpoch && !value.strict && value.strictShieldCount === 0 && !value.timer.breakActive);
  let interrupted;
  for (let attempt = 0; attempt < 20; attempt++) { interrupted = await inspectStorage(); if (!interrupted.renderer.dialog) break; await sleep(100); }
  assert.equal(interrupted.renderer.dialog, false);
  assert.equal(interrupted.renderer.stats.reduce((sum, day) => sum + day.breaksCompleted, 0), completedBeforeInterruption, 'interrupted rest cannot be credited');
  console.log('PASS: modeled suspend/resume without a tick cancels the React break across the native bridge; this is not physical sleep.');

  await stop();
  fixture.entries.myeyes_stats_v1 = '[{"date":"2026-10-11","breaksCompleted":999,"exercisesCompleted":0,"focusMinutes":0}]';
  fs.writeFileSync(source, '{corrupted old export');
  const second = await launch(['--autostart']); assert.equal(second.renderer.history.status, 'already-imported');
  assert.equal(second.visible, false); assert.equal(second.autostart.startedHidden, true);
  assert.equal(second.autostart.managed, false);
  await sleep(1500);
  const loginProgress = read(); assert.equal(loginProgress.visible, false);
  assert(second.timer.remainingMs - loginProgress.timer.remainingMs >= 1000);
  console.log('PASS: login launch arguments initialize the real hidden WebView and running Rust timer.');
  await duplicate(['--autostart']);
  console.log('PASS: duplicate login launch exits and leaves the original timer hidden.');
  await duplicate([]);
  console.log('PASS: manual duplicate foregrounds the original process without a second timer.');
  const persisted = await inspectStorage(); assert.equal(persisted.renderer.stats.find(value => value.date === '2026-10-11').breaksCompleted, 7);
  console.log('PASS: restart preserves imported history and starts successfully even when the old export is corrupted.');
  await stop();
  assert.deepEqual(readOptional(loginItem), originalLoginItem);
  assert.deepEqual(readOptional(loginMarker), originalLoginMarker);
  assert.equal(fs.existsSync(path.join(directory, 'profile/autostart-initialized-v1')), false);
  console.log('PASS: isolated native test leaves real login registration and default marker unchanged.');
  const result = { status: 'passed', directory, checks: ['native hidden timer', 'native expiry and React overlay', 'strict window guards and release', 'history fidelity and idempotent restart', 'modeled suspend/resume bridge cancellation', 'healthy profile with corrupted legacy export', 'hidden login startup and running timer', 'single instance login and manual reopen', 'login registration isolation', 'native hidden meeting postponement'], longHidden: process.argv.includes('--long'), sleepWake: 'not tested by this script; requires a physical macOS sleep/wake cycle' };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); child?.kill(); process.exitCode = 1; });
