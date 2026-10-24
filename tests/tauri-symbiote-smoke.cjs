// Explicit native branding smoke. Uses an isolated profile and no camera/input permissions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { loadNotificationAreaProof, callIndicatorReady } = require('./support/windowsNotificationArea.cjs');
const proof = loadNotificationAreaProof();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-symbiote-'));
const source = path.join(directory, 'history.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ idleDetectionEnabled: false, meetingDetectionEnabled: true,
    soundEnabled: false, notificationsEnabled: false, strictMode: false, localMcpEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }), { mode: 0o600 });
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.resolve(__dirname, '../src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const child = spawn(executable, ['--autostart'], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
  BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1', BLINCHO_SMOKE_MEETINGS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let output = '', launchError, sequence = 0;
child.stderr.on('data', value => { output += value; }); child.once('error', error => { launchError = error; });
const closed = new Promise(resolve => child.once('close', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const diagnostics = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error('Native application exited: ' + output);
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Native branding check timed out: ' + JSON.stringify(diagnostics()) + '\n' + output);
}
async function control(operation, extra = {}) {
  const id = ++sequence;
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ operation, id, ...extra }), { mode: 0o600 });
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const result = await until(() => JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8')), value => value.id === id);
  assert.equal(result.ok, true, result.error);
}
async function evaluate(expression) {
  const id = ++sequence;
  await control('eval', { script: `(async()=>{try{const result=await (${expression});await window.__TAURI__.core.invoke('renderer_report',{report:{symbioteSmoke:{id:${id},result}}});}catch(error){await window.__TAURI__.core.invoke('renderer_report',{report:{symbioteSmoke:{id:${id},error:String(error)}}});}})();` });
  const value = await until(diagnostics, value => value.renderer?.symbioteSmoke?.id === id);
  assert.equal(value.renderer.symbioteSmoke.error, undefined);
  return value.renderer.symbioteSmoke.result;
}
async function applied(mask, active) {
  return until(diagnostics, value => value.symbioteAppearance?.applied === mask &&
    value.trayPreview?.requestedBuildMask === mask && (proof || value.trayPreview.appliedBuildMask === mask) &&
    callIndicatorReady(value.trayPreview, active, proof));
}
(async () => {
  console.log('Native branding profile: ' + directory);
  const initial = await until(diagnostics, value => value.renderer?.ready && value.trayPreview?.summary && value.symbioteAppearance?.applied === 0);
  assert.equal(initial.visible, false);
  await control('meeting', { active: true, applications: ['Zoom'] });
  await applied(0, true);
  const before = diagnostics();
  assert.equal(await evaluate(`(async()=>{for(let mask=0;mask<64;mask++)await window.desktopAPI.setSymbioteBuild(mask);return true;})()`), true);
  const full = await applied(63, true);
  assert(full.symbioteAppearance.updates >= initial.symbioteAppearance.updates + 63);
  assert.equal(full.symbioteAppearance.error, null);
  assert.equal(full.visible, false); assert.equal(full.focused, false);
  assert.equal(full.dockVisible, initial.dockVisible);
  assert.equal(full.nativeActivationPolicy, initial.nativeActivationPolicy);
  if (process.platform === 'darwin') assert.equal(full.trayPreview.native.frontmostPid, before.trayPreview.native.frontmostPid);
  for (const invalid of [-1, 64, 1.5, '63']) {
    assert.equal(await evaluate(`window.desktopAPI.setSymbioteBuild(${JSON.stringify(invalid)}).then(()=>false,()=>true)`), true);
  }
  assert.equal(await evaluate(`window.__TAURI__.core.invoke('set_symbiote_build',{selection:{mask:1,path:'/tmp/icon.png'}}).then(()=>false,()=>true)`), true);
  await evaluate(`(async()=>{await Promise.all([1,32,16,63,0,31,2,48].map(mask=>window.desktopAPI.setSymbioteBuild(mask)));await window.desktopAPI.setSymbioteBuild(63);return true;})()`);
  await applied(63, true);
  await control('meeting', { active: false, applications: [] });
  await applied(63, false);
  await evaluate(`window.desktopAPI.setSymbioteBuild(0).then(()=>true)`);
  await applied(0, false);
  await evaluate(`new Promise((resolve,reject)=>{document.querySelector('.nav-settings-button').click();let attempts=0;const check=()=>{const strict=document.querySelector('#strict-mode');if(strict){strict.click();resolve(true);}else if(++attempts>100)reject(Error('Settings unavailable'));else setTimeout(check,20)};check();})`);
  await applied(16, false);
  const branded = await until(diagnostics, value => value.trayPreview.summary.symbioteMask === 16);
  assert.equal(branded.trayPreview.summary.buildName, 'Break Master');
  const ui = await evaluate(`(()=>({icons:[...document.querySelectorAll('.symbiote-icon')].map(icon=>icon.getAttribute('src')),favicon:document.querySelector('link[rel="icon"]').getAttribute('href'),name:document.querySelector('.symbiote-build-name').textContent}))()`);
  assert.deepEqual(ui.icons, ['./symbiote/10.png', './symbiote/10.png']);
  assert.equal(ui.favicon, './symbiote/10.png'); assert.equal(ui.name, 'Break Master');
  await evaluate(`(()=>{const select=document.querySelector('.language-select');select.value='he';select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  const rtl = await until(diagnostics, value => value.trayPreview.summary.locale === 'he');
  assert.equal(rtl.trayPreview.summary.symbioteMask, 16);
  assert.equal(await evaluate(`document.documentElement.dir`), 'rtl');
  assert.equal(await evaluate(`document.querySelector('.symbiote-build-name').textContent`), rtl.trayPreview.summary.buildName);
  await control('show');
  const shown = await until(diagnostics, value => value.visible && value.focused && value.symbioteAppearance.applied === 16);
  if (process.platform === 'darwin') assert.equal(shown.dockVisible, true);
  console.log('PASS: all 64 native portraits, rapid requests, call badge restoration, invalid IPC, hidden/focus/Dock policy, settings-driven UI/favicon and localized RTL summary.');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, platform: process.platform, final: shown }, null, 2), { mode: 0o600 });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child.exitCode === null && child.signalCode === null && !launchError) {
    try { await control('quit'); } catch { child.kill(); }
  }
  let timeout;
  await Promise.race([closed, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
