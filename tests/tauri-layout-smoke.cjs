// Measures the real macOS WKWebView with fixture settings and an isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'This check requires macOS');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-layout-smoke-'));
const source = path.join(directory, 'history.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ idleDetectionEnabled: true, meetingDetectionEnabled: true, cameraLockEnabled: false, strictMode: true,
    workMinutes: 20, breakSeconds: 20, soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': '{"preference":"en","acknowledged":true}',
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.resolve(__dirname, '../src-tauri/target/debug/blincho');
assert(fs.existsSync(executable), 'Build the native app before running layout checks');
const child = spawn(executable, [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
  BLINCHO_PROTOTYPE_HISTORY_SOURCE: source }, stdio: ['ignore', 'inherit', 'inherit'] });
let launchError;
child.once('error', error => { launchError = error; });
const alive = () => !launchError && child.exitCode === null && !child.signalCode;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
let sequence = 0;
async function until(predicate) {
  const started = Date.now(); let last;
  while (Date.now() - started < 20000) {
    if (launchError) throw launchError;
    try { last = read(); if (predicate(last)) return last; } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (!alive()) throw Error('Native app exited before completing layout checks');
    await sleep(100);
  }
  throw Error('Timed out waiting for layout state: ' + JSON.stringify(last?.renderer));
}
async function control(operation, args = {}, allowFailure = false) {
  const id = ++sequence, output = path.join(directory, 'response.json');
  fs.rmSync(output, { force: true });
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ operation, id, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (response.id === id || response.ok === false) {
        if (!allowFailure) assert.equal(response.ok, true, response.error);
        return response;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Test control timed out: ' + operation);
}
async function measure(expectedPage) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const marker = ++sequence;
    await control('eval', { script: `(() => {
      const main = document.querySelector('.main-content'), nav = document.querySelector('.nav-bar');
      const pages = {timer:'.hero-dashboard-grid',library:'.library-view',survey:'.survey-view',ergonomics:'.ergonomics-view',stats:'.statistics-view'};
      const page = Object.keys(pages).find(name => main.querySelector(':scope > ' + pages[name]));
      const describe = element => { const rect = element.getBoundingClientRect(); return {
        top:rect.top,bottom:rect.bottom,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,scrollTop:element.scrollTop }; };
      window.scrollTo(0,99999);
      main.scrollTop = main.scrollHeight;
      window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,marker:${marker},layout:{
        page,width:innerWidth,height:innerHeight,availableHeight:screen.availHeight,rootRange:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight,
        rootScrollTop:scrollY,titlebarBottom:document.querySelector('.mac-titlebar-drag').getBoundingClientRect().bottom,
        main:describe(main),nav:describe(nav),lastBottom:main.lastElementChild.getBoundingClientRect().bottom,
        dialog:!!document.querySelector('[role=dialog]')}}});
      main.scrollTop=0;
    })()` });
    const layout = (await until(value => value.renderer?.marker === marker)).renderer.layout;
    if (layout.page === expectedPage) return layout;
    await sleep(50);
  }
  throw Error('Selected page did not commit: ' + expectedPage);
}
function checkShell(layout) {
  assert.equal(layout.rootRange, 0, 'The document must fit the native viewport');
  assert.equal(layout.rootScrollTop, 0, 'Window scrolling must not move the titlebar');
  assert(Math.abs(layout.nav.top - layout.titlebarBottom) <= 1, 'Sidebar starts below the titlebar');
  assert(Math.abs(layout.nav.bottom - layout.height) <= 1, 'Sidebar follows the resized viewport');
  assert(Math.abs(layout.main.bottom - layout.height) <= 1, 'Main pane follows the resized viewport');
  assert(layout.lastBottom <= layout.main.bottom + 1, 'The last content item remains reachable');
}
(async () => {
  const results = [];
  let failure, reopenStatus;
  try {
    await until(value => value.renderer?.ready && value.timer.totalMs > 0);
    for (const [width, height] of [[1040, 760], [1280, 900], [1440, 1000], [1040, 760], [780, 620], [1040, 760]]) {
      await control('resize', { width, height });
      const layout = await measure('timer'); checkShell(layout);
      assert.equal(layout.width, width);
      // AppKit clamps windows taller than the screen's available work area.
      assert.equal(layout.height, Math.min(height, layout.availableHeight));
      if (width >= 1040) assert(layout.main.scrollHeight <= layout.main.clientHeight + 1, 'Roomy Timer needs no scrollbar');
      results.push({ scope: 'timer', ...layout });
    }
    for (let tab = 1; tab <= 4; tab++) {
      await control('eval', { script: `document.querySelectorAll('.nav-tabs button')[${tab}].click();` });
      // A native eval acknowledgement does not prove that React committed the new page.
      const committed = await measure(['timer', 'library', 'survey', 'ergonomics', 'stats'][tab]); checkShell(committed);
      if (tab === 1) assert(committed.main.scrollTop > 0, 'The long exercise library must scroll');
      results.push({ scope: 'tab-' + tab, ...committed });
    }
    const hidden = await control('hide'); assert(hidden.ok);
    const reopened = await control('show', {}, true);
    reopenStatus = 'passed';
    if (reopened.ok) checkShell(await measure('stats'));
    else {
      assert.equal(reopened.error, 'Presence is not confirmed');
      reopenStatus = 'not_run: real macOS presence is not confirmed';
    }
  } catch (error) {
    failure = error;
  } finally {
    if (alive()) {
      try { await control('quit'); }
      catch (error) { failure ??= error; }
      finally {
        for (let attempt = 0; attempt < 50 && alive(); attempt++) await sleep(100);
        if (alive()) child.kill();
        for (let attempt = 0; attempt < 50 && alive(); attempt++) await sleep(100);
        if (alive()) child.kill('SIGKILL');
        for (let attempt = 0; attempt < 20 && alive(); attempt++) await sleep(100);
        if (alive()) failure ??= Error('Native layout test process did not exit');
      }
    }
  }
  if (failure) throw failure;
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', results, reopenStatus }, null, 2));
  console.log('PASS: native viewport sizing, Timer, resize/restore and scrolling on all five pages.');
  console.log('Reopen: ' + reopenStatus + '. Evidence: ' + path.join(directory, 'result.json'));
})().catch(error => { console.error(error); process.exitCode = 1; });
