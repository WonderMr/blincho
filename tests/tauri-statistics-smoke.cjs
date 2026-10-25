// Real renderer/native persistence with synthetic history and a separate WebKit profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-statistics-smoke-'));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.resolve(__dirname, '../src-tauri/target/debug/blincho');
const source = path.join(directory, 'legacy.json');
const statistics = path.join(directory, 'profile/statistics-v1.json');
const date = new Date();
const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const historical = { date: '2025-01-01', breaksCompleted: 7, exercisesCompleted: 3, focusMinutes: 42,
  retainedField: 'fixture-history', padding: 'x'.repeat(404 * 1024) };
const fixture = { schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 20, breakSeconds: 20,
    idleDetectionEnabled: false, meetingDetectionEnabled: false, cameraLockEnabled: false,
    strictMode: false, soundEnabled: false, notificationsEnabled: false }),
  myeyes_stats_v1: JSON.stringify([historical]),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} };
fs.writeFileSync(source, JSON.stringify(fixture));
const env = { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
  BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, launchError, sequence = 0;
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function until(predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child?.exitCode !== null || child?.signalCode !== null) throw Error('Native app exited before completing persistence checks');
    try { const state = read(); if (predicate(state)) return state; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Statistics smoke timed out');
}
async function control(operation, args = {}) {
  const id = ++sequence, output = path.join(directory, 'response.json');
  fs.rmSync(output, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ operation, id, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  for (let i = 0; i < 100; i++) {
    try {
      const value = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (value.id === id) { assert.equal(value.ok, true, value.error); return value; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(50);
  }
  throw Error('Statistics control timed out: ' + operation);
}
async function launch() {
  fs.rmSync(path.join(directory, 'runtime-diagnostics.json'), { force: true });
  child = spawn(executable, ['--autostart'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  launchError = undefined; child.once('error', error => { launchError = error; });
  return until(value => value.renderer?.ready && value.timer.totalMs > 0 && fs.existsSync(statistics));
}
async function stop() {
  await control('quit');
  for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
  assert.equal(child.exitCode, 0, 'Quit waits for the final statistics commit');
  assert.equal(child.signalCode, null);
}
(async () => {
  try {
    await launch();
    assert.deepEqual(JSON.parse(fs.readFileSync(statistics, 'utf8'))[0], historical);
    await control('eval', { script: `(() => {
      window.__statisticsWrites=0;
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='myeyes_stats_v1')window.__statisticsWrites++;return original.call(this,key,value)};
    })()` });
    await sleep(11500);
    const marker = ++sequence;
    await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,statisticsProbe:${marker},writes:window.__statisticsWrites,legacy:localStorage.getItem('myeyes_stats_v1')}})` });
    const observed = await until(value => value.renderer?.statisticsProbe === marker);
    assert.equal(observed.renderer.writes, 0, 'Steady desktop work never writes statistics to WebKit');
    assert.equal(observed.renderer.legacy, null, 'The legacy statistics key was removed after migration');
    const focus = observed.timer.focusByDate[today];
    assert(focus >= 10, 'Native time advanced while hidden');
    await stop();
    const saved = JSON.parse(fs.readFileSync(statistics, 'utf8'));
    assert.deepEqual(saved.find(day => day.date === historical.date), historical);
    const finalFocus = saved.find(day => day.date === today).focusMinutes * 60;
    assert(finalFocus >= focus && finalFocus < focus + 3, 'Quit commits the latest native focus snapshot');
    assert(fs.statSync(statistics).size < Buffer.byteLength(fixture.entries.myeyes_stats_v1) + 10000);
    assert.deepEqual(fs.readdirSync(path.dirname(statistics)).filter(name => name.startsWith('.tmp')), []);
    fixture.entries.myeyes_stats_v1 = JSON.stringify([{ ...historical, breaksCompleted: 999 }]);
    fs.writeFileSync(source, JSON.stringify(fixture));
    await launch();
    const reopened = JSON.parse(fs.readFileSync(statistics, 'utf8'));
    assert.equal(reopened.find(day => day.date === historical.date).breaksCompleted, 7);
    assert(reopened.find(day => day.date === today).focusMinutes * 60 >= finalFocus);
    await stop();
    if (process.platform !== 'win32') {
      await launch();
      await control('rest');
      await until(value => value.timer.breakActive);
      fs.chmodSync(path.dirname(statistics), 0o500);
      try {
        await sleep(1200);
        await control('quit');
        async function inspectFailure() {
          const probe = ++sequence;
          await control('eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,quitErrorProbe:${probe},quitError:!!document.querySelector('[role="alertdialog"]'),breakVisible:!!document.querySelector('.fullscreen-break-takeover'),errorOnTop:(()=>{const dialog=document.querySelector('[role="alertdialog"]');if(!dialog)return false;const r=dialog.getBoundingClientRect();return dialog.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})(),buttons:[...document.querySelectorAll('[role="alertdialog"] button')].map(button=>button.textContent)}})` });
          return until(value => value.renderer?.quitErrorProbe === probe);
        }
        let failure;
        for (let i = 0; i < 50; i++) { failure = await inspectFailure(); if (failure.renderer.quitError) break; await sleep(100); }
        assert.equal(failure.renderer.quitError, true, 'A persistent save error is visible');
        assert.equal(failure.renderer.breakVisible, true, 'The save error coexists with an active break');
        assert.equal(failure.renderer.errorOnTop, true, 'The error dialog is above the break and receives pointer input');
        assert.deepEqual(failure.renderer.buttons, ['Retry saving', 'Quit without saving', 'Cancel']);
        assert.equal(child.exitCode, null);
        await control('eval', { script: `document.querySelectorAll('[role="alertdialog"] button')[0].click()` });
        for (let i = 0; i < 50; i++) { failure = await inspectFailure(); if (failure.renderer.quitError) break; await sleep(100); }
        assert.equal(failure.renderer.quitError, true, 'Retry preserves the explicit discard choice on a full disk');
        await control('eval', { script: `document.querySelectorAll('[role="alertdialog"] button')[1].click()` });
        for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
        assert.equal(child.exitCode, 0, 'Explicit discard can quit when saving remains impossible');
      } finally { fs.chmodSync(path.dirname(statistics), 0o700); }
    }
    console.log(JSON.stringify({ passed: true, profile: directory, legacyBytes: Buffer.byteLength(fixture.entries.myeyes_stats_v1),
      finalBytes: fs.statSync(statistics).size, webKitStatisticsWrites: 0, persistedFocusSeconds: finalFocus,
      checks: ['404 KiB migration', 'hidden work', 'no WebKit statistics writes', 'final Quit flush', 'restart preserves authoritative file', 'persistent failure exposes retry and explicit discard'] }));
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) { try { await stop(); } catch { child.kill('SIGTERM'); } }
  }
})().catch(error => { console.error(error); console.error('Isolated evidence: ' + directory); process.exitCode = 1; });
