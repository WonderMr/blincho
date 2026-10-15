// Explicit macOS native smoke: normal companion windows, isolated profiles,
// real countdowns and NSWorkspace focus observations. Run sequentially.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', 'blincho');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = new Set();
let sequence = 0;
let probe = 0;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeControl(file, request) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(request), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { child, launchError: null, output: '', exit: null };
  processes.add(handle);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    handle.output += chunk.toString();
    // Preserve the original native output both live and in the failure artifact.
    (stream === child.stderr ? process.stderr : process.stdout).write(chunk);
  });
  child.once('error', error => { handle.launchError = error; });
  handle.closed = new Promise(resolve => child.once('close', (code, signal) => {
    handle.exit = { code, signal }; resolve(handle.exit);
  }));
  return handle;
}
function alive(handle) {
  if (handle.launchError) throw handle.launchError;
  if (handle.exit || handle.child.exitCode !== null || handle.child.signalCode !== null) {
    throw new Error('Native process exited: ' + JSON.stringify(handle.exit) + '\n' + handle.output);
  }
}
async function waitForExit(handle, timeout = 5_000) {
  let timer;
  try {
    return await Promise.race([handle.closed, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function cleanup(handle) {
  if (!handle.exit && handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill();
  if (!await waitForExit(handle, 3_000)) {
    handle.child.kill('SIGKILL');
    if (!await waitForExit(handle, 3_000)) {
      handle.child.unref();
      throw new Error('Native process did not exit after forced cleanup');
    }
  }
  processes.delete(handle);
}
async function until(read, predicate, handles, timeout = 15_000, description = 'native state') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    handles.forEach(alive);
    last = read();
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error('Focus smoke timed out waiting for ' + description + ': ' + JSON.stringify(last));
}
async function control(app, operation, args = {}, expectedError = null) {
  const id = ++sequence;
  const response = path.join(app.directory, 'response.json');
  fs.rmSync(response, { force: true });
  writeControl(path.join(app.directory, 'control.json'), { id, operation, ...args });
  const value = await until(() => readJSON(response), reply => reply.id === id,
    [app.handle], 10_000, 'control ' + operation + ' request ' + id);
  assert.equal(value.ok, expectedError === null, value.error);
  if (expectedError !== null) assert.equal(value.error, expectedError);
  return value;
}
function fixtureState(fixture) {
  const state = readJSON(path.join(fixture.directory, 'state.json'));
  if (state && Date.now() - state.reportedAtMs > 1500) throw new Error('Companion focus observation is stale');
  return state;
}
async function activate(fixture) {
  const id = ++sequence;
  const response = path.join(fixture.directory, 'response.json');
  const before = fixtureState(fixture)?.sample || 0;
  fs.rmSync(response, { force: true });
  writeControl(path.join(fixture.directory, 'activate'), { id });
  await until(() => readJSON(response), reply => reply.id === id && reply.ok === true,
    [fixture.handle], 5_000, 'companion activate request ' + id);
  return until(() => fixtureState(fixture), state => state.sample > before && state.frontmostPID === fixture.pid,
    [fixture.handle], 5_000, 'actual companion frontmost PID');
}
function assertAppIdentity(state, app) {
  assert.equal(state.observedLookupFound, true, 'External application lookup must remain available');
  assert.equal(state.observedProcessIdentifier, app.handle.child.pid, 'External observation must match the child PID');
  assert.equal(state.observedTerminated, false, 'Observed application must remain alive');
  assert.equal(state.observedBundleIdentifier, app.bundleIdentifier, 'External bundle identity must match the isolated app');
  assert.equal(state.observedBundlePath, app.bundlePath, 'External bundle path must match the isolated app');
  assert.equal(state.observedExecutablePath, app.binary, 'External executable path must match the copied binary');
}
async function observeApp(fixture, app) {
  const pid = app.handle.child.pid;
  const id = ++sequence;
  const response = path.join(fixture.directory, 'response.json');
  fs.rmSync(response, { force: true });
  writeControl(path.join(fixture.directory, 'observe-app'), { id, pid });
  await until(() => readJSON(response), reply => reply.id === id && reply.ok === true,
    [fixture.handle], 5_000, 'observe native activation policy');
  const state = await until(() => fixtureState(fixture), state => state.observedPID === pid
    && Number.isInteger(state.observedActivationPolicy), [fixture.handle], 5_000, 'native activation policy available');
  assertAppIdentity(state, app);
  return state;
}
async function dockPolicy(fixture, app, expected, description) {
  const state = await until(() => fixtureState(fixture), state => state.observedPID === app.handle.child.pid
    && state.observedActivationPolicy === expected, [fixture.handle, app.handle], 5_000, description);
  assertAppIdentity(state, app);
}
async function inspectRenderer(app, after = '') {
  const marker = ++probe;
  await control(app, 'eval', { script: `(async()=>{${after};await window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,focusProbe:${marker},dialog:!!document.querySelector('[role=dialog]'),dockCycleMs:window.__blinchoDockCycleMs??null}})})().catch(error=>window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,focusProbe:${marker},error:String(error)}}))` });
  const value = await until(app.read, state => state.renderer?.focusProbe === marker,
    [app.handle], 5_000, 'renderer probe ' + marker);
  assert.equal(value.renderer.error, undefined, value.renderer.error);
  return value;
}
const sameGeometry = (value, baseline) => Math.abs(value.position.x - baseline.position.x) <= 2
  && Math.abs(value.position.y - baseline.position.y) <= 2
  && value.size.width === baseline.size.width && value.size.height === baseline.size.height;

async function startFixture(base, compiled, name) {
  const directory = path.join(base, name);
  const bundle = path.join(directory, name + '.app', 'Contents');
  fs.mkdirSync(path.join(bundle, 'MacOS'), { recursive: true });
  const binary = path.join(bundle, 'MacOS', 'focus-fixture');
  fs.copyFileSync(compiled, binary);
  fs.chmodSync(binary, 0o700);
  fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>focus-fixture</string><key>CFBundleIdentifier</key><string>com.blincho.focusfixture.${path.basename(base)}.${name}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const handle = launch(binary, [directory, 'Blincho focus smoke ' + name]);
  const state = await until(() => readJSON(path.join(directory, 'state.json')),
    value => value.pid > 0 && value.windowNumber > 0 && value.visible,
    [handle], 10_000, 'companion launch');
  assert.equal(state.pid, handle.child.pid);
  return { handle, directory, pid: state.pid, windowNumber: state.windowNumber };
}
async function stopFixture(fixture) {
  writeControl(path.join(fixture.directory, 'stop'), { id: ++sequence });
  const exit = await waitForExit(fixture.handle);
  assert(exit, 'Companion app must exit after stop');
  assert.equal(exit.code, 0, fixture.handle.output);
  assert.equal(exit.signal, null);
  processes.delete(fixture.handle);
}
async function stopApp(app) {
  try { await control(app, 'quit'); }
  catch (error) {
    // A quit acknowledgment can race process exit. Only successful observed
    // exit can replace it; native control errors otherwise remain failures.
    const exit = await waitForExit(app.handle, 1_000);
    if (!exit || exit.code !== 0 || exit.signal !== null) throw error;
  }
  const exit = await waitForExit(app.handle);
  assert(exit, 'Blincho must exit after quit');
  assert.equal(exit.code, 0, app.handle.output);
  assert.equal(exit.signal, null);
  processes.delete(app.handle);
}

async function scenario(base, previous, third, { name, mode, strictMode, breakSeconds, chooseThird = false, explicitShow = false, startupHidden = false, releaseAndHide = false }) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(base, name + '-')));
  // Launch the unchanged Cargo binary with the same AppKit bundle registration
  // as an installed app, and keep every scenario's identity isolated.
  const bundlePath = path.join(directory, 'Blincho.app');
  const contents = path.join(bundlePath, 'Contents');
  const binary = path.join(contents, 'MacOS', 'blincho');
  const bundleIdentifier = 'com.blincho.focussmoke.' + path.basename(directory);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(executable, binary);
  fs.chmodSync(binary, 0o700);
  assert(fs.readFileSync(executable).equals(fs.readFileSync(binary)), 'Focus smoke must use the unchanged compiled executable');
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>blincho</string><key>CFBundleIdentifier</key><string>${bundleIdentifier}</string><key>CFBundleName</key><string>Blincho</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  const source = path.join(directory, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
    myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds,
      strictMode, idleDetectionEnabled: false, meetingDetectionEnabled: false, cameraLockEnabled: false,
      autoTakeoverModal: true, soundEnabled: false, notificationsEnabled: false }),
    'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
  } }));
  const startupFocus = startupHidden ? await activate(previous) : null;
  const handle = launch(binary, startupHidden ? ['--autostart'] : [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
    BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' } });
  const app = { handle, directory, bundlePath, bundleIdentifier, binary,
    read: () => readJSON(path.join(directory, 'runtime-diagnostics.json')) };
  const initial = await until(app.read, value => value.renderer?.ready && value.timer.totalMs > 0,
    [handle], 30_000, 'Blincho renderer launch');
  assert.equal(initial.pid, handle.child.pid);
  await observeApp(previous, app);
  await dockPolicy(previous, app, startupHidden ? 1 : 0, 'startup Dock policy must match window visibility');
  if (startupHidden) {
    assert.equal(initial.visible, false, 'Autostart must keep the main window hidden');
    const startupState = fixtureState(previous);
    assert.equal(startupState.frontmostPID, previous.pid, `Hidden startup must preserve work focus (Blincho PID ${initial.pid})`);
    assert(!startupState.focusChanges.some(change => change.atMs >= startupFocus.reportedAtMs && change.pid === initial.pid),
      'Hidden startup must not activate Blincho during launch');
    await control(app, 'show');
    await dockPolicy(previous, app, 0, 'opening an autostart app must restore Dock');
    await control(app, 'minimize');
    await dockPolicy(previous, app, 0, 'native minimized window remains in Dock');
    await control(app, 'hide');
    await dockPolicy(previous, app, 1, 'explicit hide while minimized must remove Dock');
    await control(app, 'show');
    await dockPolicy(previous, app, 0, 'show after hiding a minimized window must restore Dock');
    await control(app, 'hide');
    await dockPolicy(previous, app, 1, 'rapid reopen must start from tray state');
    const rapid = await inspectRenderer(app, `const started=performance.now();for(const operation of ['show','hide']){await window.__TAURI__.core.invoke('desktop_command',{operation})}window.__blinchoDockCycleMs=performance.now()-started`);
    assert(rapid.renderer.dockCycleMs < 1000, 'Rapid show/hide must run within one second');
    await dockPolicy(previous, app, 1, 'rapid show/hide must end without Dock');
    await until(app.read, value => !value.visible && !value.focused,
      [handle], 5_000, 'rapid reopen/hide ends with hidden native window');
    await control(app, 'show');
    await dockPolicy(previous, app, 0, 'tray reopen after rapid hide must restore Dock');
  }
  await control(app, 'power-event', { code: 99 }, 'Invalid power code');
  await control(app, 'unmaximize');
  await control(app, 'resize', { width: 780, height: 620 });
  const monitorState = await until(app.read, value => value.monitors?.length > 0,
    [handle], 10_000, 'native monitor enumeration after startup');
  const monitor = monitorState.monitors[0];
  assert(monitor, 'Native monitor enumeration is required');
  await control(app, 'move', { ...monitor.workArea.position, scale: monitor.scaleFactor });
  await until(app.read, value => value.visible && !value.minimized && !value.maximized && !value.fullscreen,
    [handle], 5_000, 'normal baseline');
  await sleep(600);
  const baseline = app.read();
  if (mode === 'tray') await control(app, 'hide');
  if (mode === 'minimized') await control(app, 'minimize');
  await dockPolicy(previous, app, mode === 'tray' ? 1 : 0, 'tray app must leave Dock; minimized window stays in Dock');
  await activate(previous);
  await until(app.read, value => !value.focused && (mode === 'tray' ? !value.visible
    : mode === 'minimized' ? value.minimized : value.visible && !value.minimized),
    [handle, previous.handle], 5_000, 'pre-break ' + mode);
  await sleep(600); // Let native window-session tracking observe the prior state.
  const input = { totalMs: 10_000, remainingMs: 2_000, manualPaused: false, breakActive: false,
    exercising: false, expiryPending: false, version: app.read().timer.version + 1,
    breakSeconds, strictMode, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: false, autoTakeover: true };
  const focusTrace = [];
  let lastFocusTick = -1;
  await control(app, 'configure', { input });
  const started = await until(app.read, value => value.visible && value.timer.breakActive
    && (!strictMode || value.strict && value.strictShieldCount > 0),
    [handle, previous.handle, third.handle], 10_000, 'automatic break');
  const observedStart = Date.now();
  // The native strict shield temporarily uses Accessory to cover other apps'
  // fullscreen Spaces. Ordinary window/Dock policy must return after cleanup.
  await dockPolicy(previous, app, strictMode ? 1 : 0, 'break presentation must use its native activation policy');
  assert(started.timer.breakEndAt > observedStart, 'The automatic break must have a real native deadline');
  if (!releaseAndHide) assert(started.timer.breakEndAt - observedStart >= breakSeconds * 1000 - 1500,
    'The smoke must observe the configured countdown, without shortening it');
  if (!releaseAndHide) await until(() => {
    const focus = fixtureState(previous), runtime = app.read();
    if (runtime?.timer.tickCount !== lastFocusTick && focusTrace.length < 60) {
      lastFocusTick = runtime?.timer.tickCount;
      focusTrace.push({ at: Date.now(), tick: lastFocusTick, breakActive: runtime?.timer.breakActive,
        deadline: runtime?.timer.breakEndAt, strict: runtime?.strict, shields: runtime?.strictShieldCount,
        visible: runtime?.visible, minimized: runtime?.minimized, focused: runtime?.focused,
        foregroundPID: focus?.frontmostPID, activationPolicy: focus?.observedActivationPolicy });
    }
    return { focus, runtime, expectedPID: initial.pid, breakEndAt: started.timer.breakEndAt, focusTrace };
  },
    value => value.focus?.frontmostPID === initial.pid && value.runtime?.timer.breakActive,
    [handle, previous.handle], 5_000, 'Blincho frontmost during break');
  assert.equal((await inspectRenderer(app)).renderer.dialog, true, 'The real renderer must show the break');
  if (releaseAndHide) {
    const release = await control(app, 'release-and-hide', { input: { ...input, breakActive: true, strictMode: false,
      remainingMs: app.read().timer.remainingMs, version: app.read().timer.version + 1 } });
    assert(release.guardPrecondition.shieldCount > 0, 'The hide must interrupt an existing native guard');
    assert(release.guardPrecondition.deadline > release.guardPrecondition.observedAt,
      'The hide must be accepted before the original native break deadline');
    await dockPolicy(previous, app, 1, 'accepted hide must survive native strict teardown');
    await until(app.read, value => !value.visible && !value.strict && value.strictShieldCount === 0,
      [handle], 5_000, 'strict teardown preserves explicit tray state');
    await control(app, 'fullscreen', { active: false });
    await dockPolicy(previous, app, 1, 'repeated native teardown must not restore a hidden Dock icon');
    await control(app, 'release-and-hide', { input: { ...input, breakActive: true, strictMode: false,
      remainingMs: app.read().timer.remainingMs, version: app.read().timer.version + 1 } }, 'No active strict guard');
    await dockPolicy(previous, app, 1, 'rejected inactive-guard control must preserve tray state');
    await stopApp(app);
    const result = { name, status: 'passed', mode, profile: directory, blinchoPID: initial.pid,
      scope: 'Accepted hide before strict teardown, then repeated teardown; countdown/focus covered by other scenarios' };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log('PASS: ' + name);
    return result;
  }
  let expected = previous;
  if (explicitShow) await control(app, 'show');
  if (chooseThird) {
    assert.equal(strictMode, false);
    await activate(third);
    await until(app.read, value => value.timer.breakActive && !value.focused,
      [handle, third.handle], 5_000, 'third work app chosen during non-strict break');
    expected = third;
  }
  const expectedPID = explicitShow ? initial.pid : expected.pid;
  const restored = value => !value.timer.breakActive && value.focused === explicitShow && !value.strict
    && value.strictShieldCount === 0 && !value.fullscreen && !value.maximized
    && (mode === 'tray' && !explicitShow ? !value.visible && !value.minimized
      : mode === 'minimized' ? value.minimized : value.visible && !value.minimized);
  const expectedPolicy = mode === 'tray' && !explicitShow ? 1 : 0;
  await until(app.read, value => restored(value) && value.nativeActivationPolicy === expectedPolicy
    && value.dockVisible === (expectedPolicy === 0), [handle, previous.handle, third.handle], breakSeconds * 1000 + 10_000,
    'original presentation after break completion');
  await dockPolicy(previous, app, expectedPolicy, 'Dock must return to original window state');
  assert(Date.now() - observedStart >= breakSeconds * 1000 - 1500, 'Break must complete through the real countdown');
  await until(() => fixtureState(expected), value => value.frontmostPID === expectedPID,
    [handle, expected.handle], 5_000, 'expected work app frontmost after completion');
  assert.equal((await inspectRenderer(app)).renderer.dialog, false, 'Renderer cleanup must remove the overlay');
  async function staysRestored(label) {
    const startTick = app.read().timer.tickCount;
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
      [handle, previous.handle, expected.handle].forEach(alive);
      const state = app.read();
      assert(restored(state), label + ': ' + JSON.stringify(state));
      assert.equal(fixtureState(expected).frontmostPID, expectedPID, label + ': actual frontmost PID');
      const observed = fixtureState(previous);
      assertAppIdentity(observed, app);
      const policyContext = label + ': ' + JSON.stringify({ nativeActivationPolicy: state.nativeActivationPolicy,
        dockVisible: state.dockVisible, observer: observed });
      assert.equal(observed.observedActivationPolicy, expectedPolicy, policyContext + ': Dock activation policy');
      assert.equal(state.nativeActivationPolicy, expectedPolicy, policyContext + ': actual AppKit activation policy');
      assert.equal(state.dockVisible, expectedPolicy === 0, policyContext + ': Dock visibility intent');
      await sleep(100);
    }
    assert(app.read().timer.tickCount >= startTick + 4, 'Following native timer ticks must have been observed');
  }
  await staysRestored('Final cleanup and subsequent timer ticks preserve restoration');
  await control(app, 'fullscreen', { active: false });
  await control(app, 'fullscreen', { active: false });
  await inspectRenderer(app, `for(let repeat=0;repeat<2;repeat++){for(const operation of ['strict','alwaysOnTop']){await window.__TAURI__.core.invoke('desktop_command',{operation,flag:false})}}`);
  await staysRestored('Duplicate release must not reopen or refocus');
  await control(app, 'show');
  await until(app.read, value => value.visible && !value.minimized && !value.fullscreen && sameGeometry(value, baseline),
    [handle], 5_000, 'manual reopen restores original position and size');
  const reopened = app.read();
  await dockPolicy(previous, app, 0, 'manually reopened app must return to Dock');
  assert(sameGeometry(reopened, baseline), 'Manual reopen must retain the original normal frame');
  await stopApp(app);
  const result = { name, status: 'passed', mode, strictMode, breakSeconds, profile: directory,
    blinchoPID: initial.pid, priorPID: previous.pid, expectedFrontmostPID: expectedPID,
    baseline: { position: baseline.position, size: baseline.size },
    reopened: { position: reopened.position, size: reopened.size }, focusTrace };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PASS: ' + name);
  return result;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('SKIP: Native break focus smoke requires macOS');
    return;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-break-focus-'));
  console.log('Native focus smoke artifacts: ' + base);
  let primaryError = null;
  try {
    const compiled = path.join(base, 'focus-fixture');
    const compile = spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-mmacosx-version-min=14.0',
      path.join(__dirname, 'native/macos-focus-fixture.m'), '-framework', 'AppKit', '-o', compiled],
    { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
    if (compile.stderr) process.stderr.write(compile.stderr);
    const previous = await startFixture(base, compiled, 'previous-work-app');
    const third = await startFixture(base, compiled, 'new-work-app');
    const scenarios = [];
    const cases = [
      { name: 'strict-tray-20-seconds', mode: 'tray', strictMode: true, breakSeconds: 20 },
      { name: 'strict-visible-unfocused', mode: 'visible', strictMode: true, breakSeconds: 4 },
      { name: 'strict-minimized', mode: 'minimized', strictMode: true, breakSeconds: 4 },
      { name: 'non-strict-preserves-new-work-app', mode: 'tray', strictMode: false, breakSeconds: 6, chooseThird: true },
      { name: 'explicit-show-keeps-open', mode: 'tray', strictMode: false, breakSeconds: 4, explicitShow: true },
      { name: 'hidden-startup-dock', mode: 'tray', strictMode: false, breakSeconds: 4, startupHidden: true },
      // This interrupts a live guard and exits early; full countdown is checked above.
      { name: 'hide-during-strict-release', mode: 'tray', strictMode: true, breakSeconds: 20, releaseAndHide: true },
    ];
    const selected = process.env.BLINCHO_FOCUS_SMOKE_CASE;
    assert(!selected || cases.some(options => options.name === selected), 'Unknown native focus smoke case');
    for (const options of cases.filter(options => !selected || options.name === selected)) {
      scenarios.push(await scenario(base, previous, third, options));
    }
    await stopFixture(third);
    await stopFixture(previous);
    const result = { status: 'passed', platform: process.platform, architecture: process.arch, scenarios,
      artifacts: base, focus: 'Actual NSWorkspace frontmost PID; no Accessibility or synthetic input',
      presence: 'Modeled idle and unlocked state in unique isolated profiles' };
    fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    primaryError = error;
    try {
      fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify({ error: error.stack,
        nativeOutput: [...processes].map(handle => ({ pid: handle.child.pid, output: handle.output })) }, null, 2));
    } catch (artifactError) { console.error('Failure artifact: ' + artifactError.message); }
  }
  const failures = [];
  for (const handle of processes) {
    try { await cleanup(handle); } catch (error) { failures.push(error.message); }
  }
  if (primaryError) {
    if (failures.length) console.error(failures.join('\n'));
    throw primaryError;
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
