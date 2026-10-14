// Actual isolated WKWebView/WebView2/GTK runtime with modeled tray events.
// The same native handler processes real events. No normal Blincho profile is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-tray-preview-smoke-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: false, strictMode: false,
    soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const child = spawn(executable, ['--autostart'], { env: { ...process.env,
  BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1',
}, stdio: ['ignore', 'inherit', 'inherit'] });
let launchError;
child.once('error', error => { launchError = error; });
const childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;
function alive() {
  if (launchError) throw launchError;
  if (child.exitCode !== null || child.signalCode !== null) throw Error('Preview native process exited');
}
function read() {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function until(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    alive(); last = read();
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw Error('Tray preview smoke timed out: ' + JSON.stringify(last));
}
async function control(operation, args = {}) {
  const id = ++sequence;
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    alive();
    try {
      const response = JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8'));
      if (response.id === id) { assert.equal(response.ok, true, response.error); return; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Preview control timed out: ' + operation);
}

(async () => {
  console.log('Tray preview smoke profile: ' + directory);
  const initial = await until(value => value.renderer?.ready && value.timer.totalMs > 0 && value.trayPreview?.summary);
  const preview = initial.trayPreview;
  assert.equal(initial.visible, false, 'isolated autostart keeps main hidden');
  assert(initial.monitors.length > 0, 'Native preview smoke requires an unlocked desktop with available monitors');
  const anchor = initial.monitors[0].position;
  const hover = kind => control('tray-preview', { kind, x: anchor.x + 100, y: anchor.y });
  if (process.platform === 'linux') {
    await until(value => value.trayPreview.fallbackRows.length === 3 && value.trayPreview.fallbackRows[0].includes('Next break'));
    await hover('enter');
    assert.equal(read().trayPreview.visible, null, 'Linux backend has no hover window');
    assert.equal(read().visible, false);
    console.log('PASS: Linux exposes localized live countdown, focus and break count in disabled tray menu rows.');
  } else {
    await hover('enter');
    const shown = await until(value => value.trayPreview.visible === true);
    assert.equal(shown.trayPreview.focused, false);
    assert.equal(shown.visible, false);
    assert.equal(shown.focused, false);
    assert.deepEqual(shown.position, initial.position);
    assert.deepEqual(shown.innerSize, initial.innerSize);
    if (process.platform === 'darwin') {
      assert.equal(shown.trayPreview.native.frontmostPid, preview.native.frontmostPid, 'AppKit orderFrontRegardless preserves foreground app');
      assert.notEqual(shown.trayPreview.native.frontmostPid, shown.pid, 'hover never activates Blincho');
      assert.equal(shown.trayPreview.dockVisible, preview.dockVisible, 'hover preserves Dock state');
      if (process.argv.includes('--screenshot')) {
        await sleep(500);
        const result = spawnSync('/usr/sbin/screencapture', ['-x', '-l', String(shown.trayPreview.native.windowNumber), path.join(directory, 'tray-preview.png')], { encoding: 'utf8' });
        console.log('Preview screenshot: ' + (result.status === 0 ? path.join(directory, 'tray-preview.png') : result.stderr.trim()));
      }
    }
    await hover('move');
    assert.equal((await until(value => value.trayPreview.visible)).trayPreview.focused, false);
    await hover('leave');
    await until(value => value.trayPreview.visible === false);
    await hover('enter'); await until(value => value.trayPreview.visible);
    await hover('click'); await until(value => value.trayPreview.visible === false);
    await hover('move'); await sleep(500);
    assert.equal(read().trayPreview.visible, false, 'menu click suppresses later move until a fresh enter');
    console.log('PASS: native hover/move show without focus, leave/click hide and main placement/Dock state stay intact.');

    await control('show');
    const configured = await until(value => value.visible && value.focused);
    const input = { totalMs: 3_600_000, remainingMs: 3_600_000, manualPaused: false,
      breakActive: true, exercising: false, expiryPending: false, version: configured.timer.version + 1,
      breakSeconds: 20, strictMode: true, idleEnabled: false, idleThresholdSeconds: 60,
      meetingEnabled: false, autoTakeover: true };
    await control('configure', { input });
    const strict = await until(value => value.strict && (process.platform !== 'darwin' || value.strictShieldCount > 0));
    await hover('enter'); await sleep(500);
    const guarded = read();
    assert.equal(guarded.trayPreview.visible, false, 'hover cannot cover an active strict break');
    assert.equal(guarded.strict, true);
    if (process.platform === 'darwin') assert.equal(guarded.strictShieldCount, strict.strictShieldCount);
    await control('configure', { input: { ...input, version: input.version + 1, breakActive: false, strictMode: false } });
    await until(value => !value.strict && value.strictShieldCount === 0);
    await control('hide');
    console.log('PASS: strict break guard suppresses preview and retains its shield/focus behavior.');
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, platform: process.platform, final: read() }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child.exitCode === null && child.signalCode === null && !launchError) {
    try { await control('quit'); } catch { child.kill(); }
  }
  await Promise.race([childClosed, sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
