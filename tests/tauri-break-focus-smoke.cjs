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
async function inspectRenderer(app, after = '') {
  const marker = ++probe;
  await control(app, 'eval', { script: `(async()=>{${after};await window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,focusProbe:${marker},dialog:!!document.querySelector('[role=dialog]')}})})().catch(error=>window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,focusProbe:${marker},error:String(error)}}))` });
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

async function scenario(base, previous, third, { name, mode, strictMode, breakSeconds, chooseThird = false, explicitShow = false }) {
  const directory = fs.mkdtempSync(path.join(base, name + '-'));
  const source = path.join(directory, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
    myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds,
      strictMode, idleDetectionEnabled: false, meetingDetectionEnabled: false,
      autoTakeoverModal: true, soundEnabled: false, notificationsEnabled: false }),
    'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
  } }));
  const handle = launch(executable, [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
    BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' } });
  const app = { handle, directory, read: () => readJSON(path.join(directory, 'runtime-diagnostics.json')) };
  const initial = await until(app.read, value => value.renderer?.ready && value.timer.totalMs > 0,
    [handle], 30_000, 'Blincho renderer launch');
  assert.equal(initial.pid, handle.child.pid);
  await control(app, 'power-event', { code: 99 }, 'Invalid power code');
  await control(app, 'unmaximize');
  await control(app, 'resize', { width: 780, height: 620 });
  const monitor = initial.monitors?.[0];
  assert(monitor, 'Native monitor enumeration is required');
  await control(app, 'move', { ...monitor.workArea.position, scale: monitor.scaleFactor });
  await until(app.read, value => value.visible && !value.minimized && !value.maximized && !value.fullscreen,
    [handle], 5_000, 'normal baseline');
  await sleep(600);
  const baseline = app.read();
  if (mode === 'tray') await control(app, 'hide');
  if (mode === 'minimized') await control(app, 'minimize');
  await activate(previous);
  await until(app.read, value => !value.focused && (mode === 'tray' ? !value.visible
    : mode === 'minimized' ? value.minimized : value.visible && !value.minimized),
    [handle, previous.handle], 5_000, 'pre-break ' + mode);
  await sleep(600); // Let native window-session tracking observe the prior state.
  const input = { totalMs: 10_000, remainingMs: 2_000, manualPaused: false, breakActive: false,
    exercising: false, expiryPending: false, version: app.read().timer.version + 1,
    breakSeconds, strictMode, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: false, autoTakeover: true };
  await control(app, 'configure', { input });
  const started = await until(app.read, value => value.visible && value.timer.breakActive
    && (!strictMode || value.strict && value.strictShieldCount > 0),
    [handle, previous.handle, third.handle], 10_000, 'automatic break');
  const observedStart = Date.now();
  assert(started.timer.breakEndAt > observedStart, 'The automatic break must have a real native deadline');
  assert(started.timer.breakEndAt - observedStart >= breakSeconds * 1000 - 1500,
    'The smoke must observe the configured countdown, without shortening it');
  await until(() => fixtureState(previous), value => value.frontmostPID === initial.pid,
    [handle, previous.handle], 5_000, 'Blincho frontmost during break');
  assert.equal((await inspectRenderer(app)).renderer.dialog, true, 'The real renderer must show the break');
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
  await until(app.read, restored, [handle, previous.handle, third.handle], breakSeconds * 1000 + 10_000,
    'original presentation after break completion');
  assert(Date.now() - observedStart >= breakSeconds * 1000 - 1500, 'Break must complete through the real countdown');
  await until(() => fixtureState(expected), value => value.frontmostPID === expectedPID,
    [handle, expected.handle], 5_000, 'expected work app frontmost after completion');
  assert.equal((await inspectRenderer(app)).renderer.dialog, false, 'Renderer cleanup must remove the overlay');
  async function staysRestored(label) {
    const startTick = app.read().timer.tickCount;
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
      [handle, expected.handle].forEach(alive);
      const state = app.read();
      assert(restored(state), label + ': ' + JSON.stringify(state));
      assert.equal(fixtureState(expected).frontmostPID, expectedPID, label + ': actual frontmost PID');
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
  assert(sameGeometry(reopened, baseline), 'Manual reopen must retain the original normal frame');
  await stopApp(app);
  const result = { name, status: 'passed', mode, strictMode, breakSeconds, profile: directory,
    blinchoPID: initial.pid, priorPID: previous.pid, expectedFrontmostPID: expectedPID,
    baseline: { position: baseline.position, size: baseline.size },
    reopened: { position: reopened.position, size: reopened.size } };
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
