// Measures the real macOS WKWebView with fixture settings and an isolated profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

assert.equal(process.platform, 'darwin', 'This check requires macOS');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-layout-smoke-'));
const source = path.join(directory, 'history.json');
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ cameraLockEnabled: false, idleDetectionEnabled: true, meetingDetectionEnabled: true, strictMode: true,
    workMinutes: 20, breakSeconds: 20, soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': '{"preference":"en","acknowledged":true}',
  myeyes_stats_v1: JSON.stringify([{ date, breaksCompleted: 11, exercisesCompleted: 4, focusMinutes: 656,
    inputActivity: [9, 12, 15].map(hour => ({ start: new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime(), keyPresses: 1234, clicks: 567, scrolls: 89, mouseMoves: 12345 })) },
    { date: '2025-05-01', breaksCompleted: 2, exercisesCompleted: 0, focusMinutes: 45 }]),
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
async function measure(expectedPage, expectedLanguage) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const marker = ++sequence;
    await control('eval', { script: `(() => {
      const main = document.querySelector('.main-content'), nav = document.querySelector('.nav-bar');
      const pages = {timer:'.hero-dashboard-grid',library:'.library-view',survey:'.survey-view',ergonomics:'.ergonomics-view',stats:'.statistics-view'};
      const page = Object.keys(pages).find(name => main.querySelector(':scope > ' + pages[name]));
      const describe = element => { const rect = element.getBoundingClientRect(); return {
        left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,
        clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,scrollTop:element.scrollTop }; };
      const settings=nav.querySelector('.nav-settings-button'), actions=nav.querySelector('.nav-actions');
      const sound=actions.querySelector('.btn-icon'), naturalSettings=settings.cloneNode(true);
      Object.assign(naturalSettings.style,{position:'fixed',visibility:'hidden',width:'max-content',maxWidth:'none',minWidth:'0',flex:'none',whiteSpace:'nowrap'});
      actions.append(naturalSettings);
      const settingsNaturalWidth=naturalSettings.getBoundingClientRect().width;
      naturalSettings.remove();
      const breakButton=nav.querySelector('.nav-break-button');
      const dateSelect=document.querySelector('.statistics-date-trigger');
      let dateControl=null;
      if(dateSelect){
        const style=getComputedStyle(dateSelect),text=document.createElement('span');
        text.textContent=dateSelect.querySelector('span').textContent;
        Object.assign(text.style,{position:'fixed',visibility:'hidden',whiteSpace:'pre',font:style.font,letterSpacing:style.letterSpacing});
        document.body.append(text);
        const textWidth=text.getBoundingClientRect().width;
        text.remove();
        // clientWidth rounds fractional CSS pixels, which can falsely report
        // clipping for an intrinsically sized translated label.
        dateControl={...describe(dateSelect),textWidth,availableTextWidth:dateSelect.getBoundingClientRect().width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth)-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-dateSelect.querySelector('svg').getBoundingClientRect().width-parseFloat(style.columnGap)};
      }
      window.scrollTo(0,99999);
      main.scrollTop = main.scrollHeight;
      window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,marker:${marker},layout:{
        page,language:document.documentElement.lang,direction:document.documentElement.dir,width:innerWidth,height:innerHeight,availableHeight:screen.availHeight,rootRange:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight,
        rootScrollTop:scrollY,titlebarBottom:document.querySelector('.mac-titlebar-drag').getBoundingClientRect().bottom,
        main:describe(main),nav:describe(nav),lastBottom:main.lastElementChild.getBoundingClientRect().bottom,
        navControls:[...nav.querySelectorAll('button')].filter(element=>element.getBoundingClientRect().width>0).map(describe),
        utilities:{settings:describe(settings),sound:describe(sound),row:describe(actions),settingsNaturalWidth,gap:parseFloat(getComputedStyle(actions).columnGap)||0,breakButton:breakButton?describe(breakButton):null},
        statistics:[...document.querySelectorAll('.statistics-metric,.statistics-daily-metric')].map(describe),
        dateControl,
        dialog:!!document.querySelector('[role=dialog]')}}});
      main.scrollTop=0;
    })()` });
    const layout = (await until(value => value.renderer?.marker === marker)).renderer.layout;
    if (layout.page === expectedPage && (!expectedLanguage || layout.language.split('-')[0] === expectedLanguage)) return layout;
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
  assert(layout.nav.scrollWidth <= layout.nav.clientWidth, 'Sidebar must not scroll horizontally');
  assert(layout.main.scrollWidth <= layout.main.clientWidth, 'Main content must not scroll horizontally');
  for (const button of layout.navControls) {
    assert(button.left >= layout.nav.left && button.right <= layout.nav.right, 'Every sidebar control stays inside the sidebar');
    assert(button.width >= 44 && button.height >= 44, 'Sidebar controls retain usable hit targets');
    assert(button.scrollWidth <= button.clientWidth, 'Complete translated button labels fit inside their controls');
    assert(button.scrollHeight <= button.clientHeight, 'Translated sidebar labels are not clipped vertically');
  }
  const {settings,sound,row,settingsNaturalWidth,gap,breakButton}=layout.utilities;
  const canShareRow=settingsNaturalWidth+sound.width+gap<=row.width+.01;
  const shareRow=Math.abs((settings.top+settings.bottom-sound.top-sound.bottom)/2)<=1;
  assert.equal(shareRow,canShareRow,'Settings and sound share a row exactly when their full labels and controls fit');
  if(!shareRow) assert(settings.bottom<=sound.top+1,'Wrapped utilities form separate non-overlapping rows');
  if(breakButton) {
    assert(Math.abs(breakButton.width-row.width)<=1,'The separate instant-break action fills the utility width');
    assert(breakButton.bottom<=Math.min(settings.top,sound.top)+1||breakButton.top>=Math.max(settings.bottom,sound.bottom)-1,'The instant-break action does not overlap Settings or sound');
  }
  for (const item of layout.statistics) assert(item.scrollWidth <= item.clientWidth, 'Statistics values and dates fit their columns');
  if (layout.page === 'stats') {
    assert(layout.dateControl?.height >= 44, 'The date control retains a 44px hit target');
    assert(layout.dateControl.textWidth<=layout.dateControl.availableTextWidth+.01,'The complete selected date fits before the dropdown indicator');
  }
}
(async () => {
  const results = [];
  let failure, reopenStatus;
  try {
    await until(value => value.renderer?.ready && value.timer.totalMs > 0);
    for (const [width, height] of [[1040, 760], [1280, 900], [1440, 1000], [1040, 760], [780, 620], [875, 620], [1040, 760]]) {
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
    const languages = fs.readdirSync(path.resolve(__dirname, '../src/i18n/locales')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    for (const width of [780, 1040, 1440]) {
      await control('resize', { width, height: 760 });
      for (const language of languages) {
        await control('eval', { script: `localStorage.setItem('blincho-language-v1',JSON.stringify({preference:${JSON.stringify(language)},acknowledged:true}));window.dispatchEvent(new StorageEvent('storage',{key:'blincho-language-v1'}));` });
        for (let tab=0;tab<5;tab++) {
          await control('eval', {script:`document.querySelectorAll('.nav-tabs button')[${tab}].click();`});
          const layout=await measure(['timer','library','survey','ergonomics','stats'][tab],language);checkShell(layout);
          results.push({scope:'translated-page',...layout});
        }
      }
    }
    const dragMarker = ++sequence;
    await control('eval', { script: `(() => {
      const api = window.__TAURI__.window, original = api.Window.prototype.startDragging;
      let starts = 0, scrollbarSpacer;
      api.Window.prototype.startDragging = async () => { starts++; };
      const press = (element,x,y,button=0) => element.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button,clientX:x,clientY:y}));
      const middle = element => {const r=element.getBoundingClientRect();return [(r.left+r.right)/2,(r.top+r.bottom)/2];};
      try {
        const nav=document.querySelector('.nav-bar'), main=document.querySelector('.main-content'), titlebar=document.querySelector('.mac-titlebar-drag');
        scrollbarSpacer=document.createElement('div');scrollbarSpacer.style.height=(main.clientHeight+1)+'px';scrollbarSpacer.setAttribute('aria-hidden','true');main.append(scrollbarSpacer);
        if(main.scrollHeight<=main.clientHeight) throw new Error('Scrollbar fixture needs vertical overflow');
        const nr=nav.getBoundingClientRect(), mr=main.getBoundingClientRect();
        press(nav,nr.left+5,nr.top+100); press(main,mr.left+12,mr.top+2); press(titlebar,200,15);
        const freeStarts=starts;
        for (const element of [document.querySelector('.nav-tabs button'),document.querySelector('.statistics-date-trigger')]) press(element,...middle(element));
        const heading=document.querySelector('.view-header h2'), range=document.createRange(); range.selectNodeContents(heading);
        const text=range.getClientRects()[0];press(heading,text.left+3,text.top+3);
        press(main,mr.right-1,mr.top+100); press(nav,nr.left+5,nr.top+100,2);
        const afterProtected=starts, selection=document.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        if(selection.isCollapsed) throw new Error('Native selection fixture did not select text');
        const selectedText=selection.toString();
        press(main,mr.left+12,mr.top+2); press(nav,nr.left+5,nr.top+100); press(titlebar,200,15);
        const selectedFreeStarts=starts, selectionPreserved=selection.toString()===selectedText;
        press(heading,text.left+3,text.top+3);
        window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,marker:${dragMarker},drag:{freeStarts,afterProtected,selectedFreeStarts,selectedAfterText:starts,selectionPreserved}}});
        selection.removeAllRanges();
      } finally { api.Window.prototype.startDragging=original;scrollbarSpacer?.remove();document.getSelection()?.removeAllRanges(); }
    })()` });
    const drag = (await until(value => value.renderer?.marker === dragMarker)).renderer.drag;
    assert.equal(drag.freeStarts,3,'Sidebar, page margin and titlebar route to native drag');
    assert.equal(drag.afterProtected,3,'Controls, text, scrollbar and secondary clicks retain their behavior');
    assert.equal(drag.selectedFreeStarts,6,'An existing text selection does not block free space or titlebar dragging');
    assert.equal(drag.selectedAfterText,6,'Pressing selected text preserves text interaction');
    assert.equal(drag.selectionPreserved,true,'Dragging free space retains the selected text');
    results.push({scope:'real-dom-drag-routing',...drag});
    // Poll actual DOM state from Node: animation frames may stop while this
    // native test window is backgrounded. Every sample reports a fresh marker.
    const sampleDate = async (script, ready) => {
      const deadline = Date.now() + 10000;
      let state;
      do {
        const marker = ++sequence;
        await control('eval', { script: `(() => {
          let state;
          try { state = (() => { ${script} })(); }
          catch (error) { state = { error: String(error) }; }
          window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,marker:${marker},dateState:state}});
        })()` });
        state = (await until(value => value.renderer?.marker === marker)).renderer.dateState;
        assert(!state.error, state.error);
        if (ready(state)) return state;
        await sleep(100);
      } while (Date.now() < deadline);
      throw Error('Date picker did not settle: ' + JSON.stringify(state));
    };
    await control('eval', { script: "document.querySelector('.statistics-date-trigger').click();" });
    const dateChoices = await sampleDate(`
      const trigger=document.querySelector('.statistics-date-trigger');
      const panel=document.querySelector('.statistics-date-choices');
      const choices=[...(panel?.querySelectorAll('button') ?? [])];
      const older=choices.find(button=>button.dataset.date==='2025-05-01');
      const rect=panel?.getBoundingClientRect();
      return {open:trigger.getAttribute('aria-expanded'),count:choices.length,
        visible:!!rect&&rect.width>0&&rect.height>0,
        focus:document.activeElement?.dataset.date,olderLabel:older?.textContent};
    `, state => state.open === 'true' && state.focus === date);
    assert.equal(dateChoices.open,'true');assert(dateChoices.visible);assert.equal(dateChoices.count,8);
    assert.equal(dateChoices.focus,date,'Opening the list focuses the selected day');
    assert(dateChoices.olderLabel, 'Saved historical date is present');
    await control('eval',{script:`document.querySelector('.statistics-date-choices button[data-date="2025-05-01"]').click();`});
    const dateSelection = await sampleDate(`
      const trigger=document.querySelector('.statistics-date-trigger');
      return {label:trigger.querySelector('span').textContent,closed:!document.querySelector('.statistics-date-choices'),
        recentSelected:document.querySelectorAll('.statistics-day-button[aria-pressed="true"]').length,
        focused:document.activeElement===trigger};
    `, state => state.closed && state.focused && state.label === dateChoices.olderLabel);
    assert.equal(dateSelection.label,dateChoices.olderLabel);assert(dateSelection.closed&&dateSelection.focused);
    assert.equal(dateSelection.recentSelected,0,'An older saved date does not select a recent-day button');
    results.push({scope:'in-app-date-choices',...dateChoices,...dateSelection});
    await control('eval',{script:"document.querySelectorAll('.statistics-day-button')[6].click();"});
    await control('eval',{script:"document.querySelector('.statistics-date-trigger').focus();"});
    const focusedDate=await measure('stats');checkShell(focusedDate);
    results.push({scope:'focused-date-control',...focusedDate});
    const hidden = await control('hide'); assert(hidden.ok);
    const reopened = await control('show', {}, true);
    reopenStatus = 'passed';
    if (reopened.ok) {
      const reopenedLayout = await measure('stats');
      checkShell(reopenedLayout);
      results.push({ scope: 'reopened', ...reopenedLayout });
    }
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
  if (failure) {
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({status:'failed',error:failure.message,results,reopenStatus},null,2));
    console.error('Evidence: '+path.join(directory,'result.json'));
    throw failure;
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', results, reopenStatus }, null, 2));
  console.log('PASS: native viewport sizing, adaptive Settings/sound rows, all five pages in 30 languages at three widths, unclipped sidebar controls and statistics.');
  console.log('Reopen: ' + reopenStatus + '. Evidence: ' + path.join(directory, 'result.json'));
})().catch(error => { console.error(error); process.exitCode = 1; });
