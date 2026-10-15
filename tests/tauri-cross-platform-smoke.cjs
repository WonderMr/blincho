// Launch the real native app and renderer in a dedicated test profile. CI runs
// this on macOS, Windows and Linux; Linux supplies Xvfb, DBus and a window manager.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const breakSeconds = Number(process.env.BLINCHO_BREAK_SMOKE_SECONDS || 4);
assert(Number.isFinite(breakSeconds) && breakSeconds >= 1 && breakSeconds <= 120);
const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'blincho-native-smoke-'));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target', ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 10, breakSeconds, idleDetectionEnabled: false, meetingDetectionEnabled: false, cameraLockEnabled: false, strictMode: false, soundEnabled: false, notificationsEnabled: false }),
  myeyes_stats_v1: JSON.stringify([{ date: '2026-10-11', breaksCompleted: 7, exercisesCompleted: 3, focusMinutes: 42, techniqueCounts: { blink: 3 }, completedEventIds: ['legacy-break'] }]),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const env = { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' };
let child;
let sequence = 0;
let launchError;
let launchCount = 0;
const lifecycle = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
const childStatus = () => child ? { pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed } : null;
// Retain only this fresh smoke profile's fixed diagnostic files. WebView caches,
// raw browser storage, command lines and the host environment are never copied.
function failureEvidence(error, windowsProcess, print = true) {
  const listing = [];
  function list(relative = '', depth = 0) {
    if (listing.length >= 160 || depth > 3) return;
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      if (!relative && entry.name === 'failure-artifacts') continue;
      if (listing.length >= 160) break;
      const name = path.join(relative, entry.name);
      const info = fs.lstatSync(path.join(directory, name));
      listing.push({ path: name, type: info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file', bytes: info.size });
      if (info.isDirectory()) list(name, depth + 1);
    }
  }
  try { list(); } catch (failure) { listing.push({ error: failure.message }); }
  const output = path.join(directory, 'failure-artifacts');
  fs.mkdirSync(output, { recursive: true });
  const copies = [];
  const canonicalDirectory = fs.realpathSync(directory);
  for (const [relative, limit] of [['startup-trace.jsonl', 16_384], ['runtime-diagnostics.json', 131_072], ['legacy.json', 16_384], ['profile/update-preferences.json', 16_384]]) {
    const file = path.join(directory, relative);
    let descriptor;
    try {
      if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(canonicalDirectory + path.sep)) throw new Error('Not a regular isolated profile file');
      descriptor = fs.openSync(file, 'r');
      const bytes = Buffer.alloc(limit + 1);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > limit) throw new Error(`Exceeds ${limit} byte diagnostic limit`);
      fs.writeFileSync(path.join(output, relative.replaceAll('/', '-')), bytes.subarray(0, length));
      copies.push({ path: relative, bytes: length });
    } catch (failure) { copies.push({ path: relative, omitted: failure.message }); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  const report = { error: { name: error.name, message: error.message }, platform: process.platform, architecture: process.arch,
    profile: directory, child: childStatus(), lifecycle, copies, windowsProcess, listingLimit: 160, listingDepth: 3 };
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'profile-listing.json'), JSON.stringify(listing, null, 2));
  if (!print) return;
  console.error(`Native smoke failure evidence: ${output}`);
  console.error(JSON.stringify(report));
  console.error(`Native smoke profile listing: ${JSON.stringify(listing)}`);
  const trace = path.join(output, 'startup-trace.jsonl');
  console.error(`Native startup trace:\n${fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '(not written)'}`);
}
function windowsProcessEvidence() {
  if (process.platform !== 'win32' || !Number.isSafeInteger(child?.pid)) return null;
  // Query only the launched PID and its direct children, without command lines.
  const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid} OR ParentProcessId = ${child.pid}' | Select-Object ProcessId,ParentProcessId,Name,ExecutionState,Status | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 65_536 });
  return { status: result.status, signal: result.signal, error: result.error?.message, output: result.stdout, stderr: result.stderr };
}
async function until(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Native app exited: code=${child.exitCode} signal=${child.signalCode}`);
    try { last = read(); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`Native smoke timed out: ${JSON.stringify(last)}`);
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
  throw new Error(`Native control timed out: ${operation}`);
}
async function launch(args = []) {
  fs.rmSync(path.join(directory, 'runtime-diagnostics.json'), { force: true });
  launchError = undefined;
  child = spawn(executable, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const attempt = ++launchCount;
  lifecycle.push({ event: 'spawn', attempt, pid: child.pid ?? null, at: new Date().toISOString() });
  child.once('error', error => { launchError = error; lifecycle.push({ event: 'error', attempt, code: error.code, message: error.message }); });
  child.once('exit', (code, signal) => { lifecycle.push({ event: 'exit', attempt, code, signal, at: new Date().toISOString() }); });
  return until(value => value.renderer?.ready && value.timer.totalMs > 0);
}
async function inspectRenderer() {
  const probe = Date.now();
  await control('eval', { script: `window.__TAURI__.core.invoke('desktop_info').then(info=>window.__TAURI__.core.invoke('renderer_report',{report:{platform:info.platform,ready:true,probe:${probe},stats:JSON.parse(localStorage.getItem('myeyes_stats_v1')),dialog:!!document.querySelector('[role=dialog]'),text:document.body.innerText}}))` });
  return until(value => value.renderer?.probe === probe);
}
async function stop() {
  // quit exits inside the native control handler and can race its response write.
  try { await control('quit'); } catch (error) { if (child.exitCode === null) throw error; }
  for (let count = 0; count < 50 && child.exitCode === null; count += 1) await sleep(100);
  if (child.exitCode === null) throw new Error('Native app did not quit');
  assert.equal(child.exitCode, 0);
  child = undefined;
}
(async () => {
  console.log(`Native smoke profile: ${directory}`);
  const initial = await launch();
  assert.equal(initial.renderer.history.status, 'imported');
  assert.equal(initial.renderer.history.entryCount, 3);
  assert.equal(initial.autostart.managed, false);
  assert.equal(initial.updates.supported, false);
  assert.equal(initial.updates.installOnQuit, false);
  const history = await inspectRenderer();
  assert.equal(history.renderer.stats.find(day => day.date === '2026-10-11').breaksCompleted, 7);
  assert.equal(history.renderer.stats.find(day => day.date === '2026-10-11').focusMinutes, 42);
  assert.ok(history.renderer.text.includes('Blincho'));
  assert.equal(history.renderer.platform, process.platform);
  const input = { totalMs: 10_000, remainingMs: 10_000, manualPaused: false, breakActive: false, exercising: false, expiryPending: false, version: read().timer.version + 1, breakSeconds, strictMode: false, idleEnabled: false, idleThresholdSeconds: 60, autoTakeover: true };
  await control('configure', { input });
  await control('hide');
  const hidden = await until(value => value.visible === false);
  await sleep(1500);
  const progressed = read();
  assert.equal(progressed.visible, false);
  assert.ok(hidden.timer.remainingMs - progressed.timer.remainingMs >= 1000);
  await until(value => value.visible && value.timer.breakActive, 15_000);
  const overlay = await inspectRenderer();
  assert.equal(overlay.renderer.dialog, true);
  await until(value => !value.timer.breakActive, breakSeconds * 1000 + 8000);
  // Visibility and native focus can settle on different event-loop turns.
  // Wait for both instead of retaining an earlier hidden-but-focused snapshot.
  const restored = await until(value => value.visible === false && value.focused === false && !value.timer.breakActive, 10_000);
  await sleep(300);
  const stableRestored = read();
  assert.equal(stableRestored.visible, false, 'Tray restoration remains stable after native cleanup');
  assert.equal(stableRestored.focused, false, 'Native focus stays released after cleanup');
  assert.equal(restored.visible, false, 'A break that began from the tray must return to the tray');
  assert.equal(restored.focused, false, 'A completed tray break must release native window focus');
  await sleep(1000);
  const laterRestored = read();
  assert.equal(laterRestored.visible, false, 'Later timer ticks must not reopen the restored tray window');
  assert.equal(laterRestored.focused, false, 'Later timer ticks must not refocus the restored tray window');
  await stop();
  fs.writeFileSync(source, '{corrupted old history');
  const restart = await launch(['--autostart']);
  assert.equal(restart.renderer.history.status, 'already-imported');
  assert.equal(restart.visible, false);
  assert.equal(restart.autostart.startedHidden, true);
  if (process.platform === 'win32') {
    assert.equal(restart.focused, false);
    assert.deepEqual(restart.position, initial.position, 'hidden WebView warmup restores the window position');
  }
  await sleep(1500);
  const loginProgress = read();
  assert.equal(loginProgress.visible, false);
  assert.ok(restart.timer.remainingMs - loginProgress.timer.remainingMs >= 1000);
  const persisted = await inspectRenderer();
  assert.equal(persisted.renderer.stats.find(day => day.date === '2026-10-11').breaksCompleted, 7);
  await control('show');
  const reopened = await until(value => value.visible);
  if (process.platform === 'win32') assert.deepEqual(reopened.position, initial.position);
  await stop();
  const result = { status: 'passed', platform: process.platform, architecture: process.arch, breakSeconds, checks: ['native renderer launch', 'history import fidelity', 'hidden Rust timer', 'timer expiry and React break', 'break restores tray visibility and focus', 'hidden autostart launch', 'history survives restart'], profile: directory, presence: 'modeled idle and unlocked state in isolated test profile; physical idle, lock and sleep are not tested' };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(async error => {
  console.error(error);
  process.exitCode = 1;
  let windowsProcess;
  try { windowsProcess = windowsProcessEvidence(); } catch (failure) { windowsProcess = { error: failure.message }; }
  // Capture before termination, then record the resulting exit/signal as well.
  try { failureEvidence(error, windowsProcess); } catch (failure) { console.error(`Native failure evidence: ${failure.message}`); }
  child?.kill();
  for (let count = 0; count < 10 && child?.exitCode === null && child?.signalCode === null; count += 1) await sleep(100);
  console.error(`Native child after termination: ${JSON.stringify(childStatus())}`);
  try { failureEvidence(error, windowsProcess, false); } catch (failure) { console.error(`Native failure evidence: ${failure.message}`); }
});
