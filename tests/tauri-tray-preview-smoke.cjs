// Actual isolated WKWebView/WebView2/GTK runtime with modeled tray events.
// The same native handler processes real events. No normal Blincho profile is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { loadNotificationAreaProof, callIndicatorReady, assertCallIndicator, assertCallRestored } = require('./support/windowsNotificationArea.cjs');
const notificationAreaProof = loadNotificationAreaProof();
let nativeIconRejectionObserved = false;
let nativeTooltipRejectionObserved = false;
function assertNativeTooltip(tray, expected = null) {
  if (tray.nativeTooltipError !== null) {
    assert(notificationAreaProof, 'Tooltip failures require the same-machine native SDK proof');
    assert.match(tray.nativeTooltipError, /^tray icon error: Unspecified error \(os error -2147467259\)$/);
    nativeTooltipRejectionObserved = true;
    return;
  }
  assert.equal(tray.nativeTooltipApplied, true);
  assert.equal(tray.nativeTooltip, expected, 'A rich preview must not compete with the operating system tooltip');
}
function assertIndicator(tray, active) {
  assertCallIndicator(tray, active, notificationAreaProof);
  if (tray.callIndicatorError !== null) nativeIconRejectionObserved = true;
}
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-tray-preview-smoke-'));
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: true, meetingHistoryEnabled: false, cameraLockEnabled: false, strictMode: false,
    soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const child = spawn(executable, ['--autostart'], { env: { ...process.env,
  BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1', BLINCHO_SMOKE_MEETINGS: '1',
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
  if (process.platform !== 'linux') {
    assertNativeTooltip(preview);
  }
  assert.equal(initial.visible, false, 'isolated autostart keeps main hidden');
  assert(initial.monitors.length > 0, 'Native preview smoke requires an unlocked desktop with available monitors');
  const anchor = initial.monitors[0].position;
  const hover = kind => control('tray-preview', { kind, x: anchor.x + 100, y: anchor.y });
  await control('meeting', { active: true, applications: ['Zoom'] });
  const call = await until(value => value.timer.liveMeetingEnabled && value.timer.liveMeetingStatus?.inMeeting &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Zoom'));
  assertIndicator(call.trayPreview, true);
  assert.deepEqual(call.timer.liveMeetingStatus.applications, ['Zoom']);
  assert.deepEqual(call.timer.meetingSpans, [], 'Live tray calls must not opt into history');
  assert.equal(call.visible, false, 'A live call cannot open the main window');
  const callUpdates = call.trayPreview.callIndicatorUpdates;
  const callAttempts = call.trayPreview.callIndicatorAttempts;
  await sleep(1100);
  assert.equal(read().trayPreview.callIndicatorUpdates, callUpdates, 'Stable calls do not repeatedly replace the icon');
  assert.equal(read().trayPreview.callIndicatorAttempts, callAttempts, 'Stable calls do not retry a rejected icon before its cooldown');
  const beforeCallHover = read();
  if (process.platform === 'darwin') assert.notEqual(beforeCallHover.trayPreview.native.frontmostPid,
    beforeCallHover.pid, 'A call icon update must not activate the hidden application');
  await hover('enter');
  if (process.platform !== 'linux') {
    const callPopup = await until(value => value.trayPreview.visible);
    assertNativeTooltip(callPopup.trayPreview);
    assert.equal(callPopup.trayPreview.focused, false);
    if (process.platform === 'darwin') assert.equal(callPopup.trayPreview.native.frontmostPid,
      beforeCallHover.trayPreview.native.frontmostPid, 'Active-call hover preserves the foreground application');
    const scale = callPopup.trayPreview.scaleFactor;
    if (scale) assert.equal(Math.round(callPopup.trayPreview.innerSize.height / scale), 232);
    if (process.platform === 'darwin' && process.argv.includes('--screenshot')) {
      await sleep(500);
      const capture = spawnSync('/usr/sbin/screencapture', ['-x', '-l', String(callPopup.trayPreview.native.windowNumber), path.join(directory, 'tray-active-call.png')], { encoding: 'utf8' });
      console.log('Active call screenshot: ' + (capture.status === 0 ? path.join(directory, 'tray-active-call.png') : capture.stderr.trim()));
    }
    await hover('leave');
  } else {
    assert(call.trayPreview.fallbackRows.some(row => row.includes('Zoom')), 'Linux tray menu includes the active call app');
  }
  await control('meeting', { active: false, applications: [] });
  const inactive = await until(value => value.timer.liveMeetingStatus?.inMeeting === false &&
    callIndicatorReady(value.trayPreview, false, notificationAreaProof) &&
    value.trayPreview.callStatus === value.trayPreview.summary.meetingInactiveLabel);
  assertCallRestored(call.trayPreview, inactive.trayPreview, notificationAreaProof);
  assert.deepEqual(inactive.timer.meetingSpans, []);
  await control('meeting', { active: true, applications: ['Google Chrome'] });
  const live = await until(value => value.timer.liveMeetingStatus?.inMeeting &&
    callIndicatorReady(value.trayPreview, true, notificationAreaProof) && value.trayPreview.tooltip.includes('Google Chrome'));
  assertIndicator(live.trayPreview, true);
  assert(live.trayPreview.callIndicatorAttempts > inactive.trayPreview.callIndicatorAttempts,
    'A new call attempts icon application immediately after the prior call ended');
  const disabledInput = { totalMs: 3_600_000, remainingMs: live.timer.remainingMs, manualPaused: false,
    breakActive: false, exercising: false, expiryPending: false, version: live.timer.version + 1,
    breakSeconds: 20, strictMode: false, idleEnabled: false, idleThresholdSeconds: 60,
    meetingEnabled: false, meetingHistoryEnabled: false, autoTakeover: true };
  await control('configure', { input: disabledInput });
  const disabled = await until(value => !value.timer.liveMeetingEnabled && value.timer.liveMeetingStatus === null &&
    callIndicatorReady(value.trayPreview, false, notificationAreaProof) && value.trayPreview.callStatus === value.trayPreview.summary.meetingDisabledLabel);
  assertCallRestored(live.trayPreview, disabled.trayPreview, notificationAreaProof);
  assert.deepEqual(disabled.timer.meetingSpans, [], 'Disabling detection cannot create history');
  await control('meeting', { active: false, applications: [] });
  console.log('PASS: live call app status, end and disable work with history off and without focus or repeated icon attempts.');
  if (process.platform === 'linux') {
    await until(value => value.trayPreview.fallbackRows.length === 4 && value.trayPreview.fallbackRows[0].includes('Next break'));
    await hover('enter');
    assert.equal(read().trayPreview.visible, null, 'Linux backend has no hover window');
    assert.equal(read().visible, false);
    console.log('PASS: Linux exposes localized live countdown, focus and break count in disabled tray menu rows.');
  } else {
    await hover('enter');
    const shown = await until(value => value.trayPreview.visible === true);
    assertNativeTooltip(shown.trayPreview);
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
    if (process.platform === 'darwin') {
      await control('minimize');
      await until(value => value.minimized);
      await hover('enter');
      await until(value => value.trayPreview.visible && value.minimized);
      await control('reopen');
      await until(value => value.visible && !value.minimized && value.focused && value.trayPreview.dockVisible);
      await hover('leave');
      await until(value => !value.trayPreview.visible);
      console.log('PASS: modeled Dock reopen restores the real minimized main window while its preview is visible.');
    }
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

    const setNativeLocale = async locale => {
      await control('eval', { script: `window.__TAURI__.core.invoke('set_locale', { locale: ${JSON.stringify(locale)} })
        .then(() => window.__TAURI__.core.invoke('renderer_report', { report: { ready: true, tooltipLocale: ${JSON.stringify(locale)} } }))` });
      return until(value => value.renderer?.tooltipLocale === locale);
    };
    assertNativeTooltip((await setNativeLocale('fr')).trayPreview);
    assertNativeTooltip((await setNativeLocale('en')).trayPreview);
    await sleep(1200);
    assertNativeTooltip(read().trayPreview);
    const pausedInput = { ...input, version: read().timer.version + 1, breakActive: false, strictMode: false, manualPaused: true };
    await control('configure', { input: pausedInput });
    await until(value => value.timer.manualPaused && value.trayPreview.tooltip.includes('Timer manually paused'));
    const pausedTooltip = read().trayPreview.tooltip;
    await sleep(1200);
    assert.equal(read().trayPreview.tooltip, pausedTooltip, 'Paused summary stays unchanged during window loss');
    await control('tray-preview', { kind: 'destroy' });
    await until(value => value.trayPreview.visible === null);
    const pausedFallback = await until(value => value.trayPreview.nativeTooltipError !== null || value.trayPreview.nativeTooltip === pausedTooltip);
    assertNativeTooltip(pausedFallback.trayPreview, pausedTooltip);
    await setNativeLocale('fr');
    // Renderer acknowledgments and native diagnostics are collected separately.
    // Wait for the actual tooltip apply rather than a mixed transition snapshot.
    const fallbackTitle = await until(value => value.trayPreview.nativeTooltipError !== null ||
      typeof value.trayPreview.nativeTooltip === 'string');
    if (fallbackTitle.trayPreview.nativeTooltipError === null) {
      assert.equal(typeof fallbackTitle.trayPreview.nativeTooltip, 'string');
      assert(fallbackTitle.trayPreview.nativeTooltip.length > 0, 'Missing preview retains the localized OS fallback');
      assertNativeTooltip(fallbackTitle.trayPreview, fallbackTitle.trayPreview.nativeTooltip);
    } else assertNativeTooltip(fallbackTitle.trayPreview);
    await setNativeLocale('en');
    await control('tray-preview', { kind: 'initialize' });
    const restoredPreview = await until(value => value.trayPreview.visible === false &&
      (value.trayPreview.nativeTooltipError !== null || value.trayPreview.nativeTooltip === null));
    assertNativeTooltip(restoredPreview.trayPreview);
    await hover('enter');
    assertNativeTooltip((await until(value => value.trayPreview.visible)).trayPreview);
    await hover('leave');
    await until(value => value.trayPreview.visible === false);
    console.log('PASS: only one hover summary survives timer ticks and locale updates; a missing preview retains text fallback and recovery clears it.');
  }
  const notificationArea = nativeIconRejectionObserved
    ? 'unavailable: same-machine native SDK proof confirmed ARM64 CI NIM_ADD rejection; visible icon remains unverified'
    : 'native call icon and restoration successfully applied';
  console.log('Notification area: ' + notificationArea);
  const nativeTooltip = process.platform === 'linux' ? 'not applicable: live menu rows replace unsupported hover and tooltips'
    : nativeTooltipRejectionObserved ? 'unverified: independently proven unavailable notification area'
    : 'suppression and fallback successfully applied';
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, platform: process.platform,
    notificationArea, nativeTooltip, final: read() }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child.exitCode === null && child.signalCode === null && !launchError) {
    try { await control('quit'); } catch { child.kill(); }
  }
  await Promise.race([childClosed, sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
