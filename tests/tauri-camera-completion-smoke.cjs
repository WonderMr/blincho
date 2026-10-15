// Real macOS WebView, native countdown and bundled local detector. Synthetic
// video and a mocked lock bridge keep camera hardware and desktop locking out.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const expectedVersion = require('../package.json').version;
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', 'blincho');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeControl(app, operation, args = {}) {
  const id = ++sequence;
  const file = path.join(app.directory, 'control.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id, operation, ...args }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return id;
}
function alive(app) {
  if (app.launchError) throw app.launchError;
  if (app.closed || app.child.exitCode !== null || app.child.signalCode !== null) {
    throw Error('Camera completion process exited: ' + JSON.stringify(app.exit) + '\n' + app.output);
  }
}
async function until(app, read, predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    alive(app);
    last = read();
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw Error('Camera completion timed out waiting for ' + description + ': ' + JSON.stringify(last) + '\n' + app.output);
}
async function control(app, operation, args = {}) {
  const id = writeControl(app, operation, args);
  const reply = await until(app, () => readJSON(path.join(app.directory, 'response.json')),
    value => value.id === id, 'control ' + operation, 10_000);
  assert.equal(reply.ok, true, reply.error);
}
async function inspect(app) {
  const marker = ++sequence;
  await control(app, 'eval', { script: `window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,completionMarker:${marker},probe:window.cameraCompletionProbe,settings:JSON.parse(localStorage.getItem('myeyes_settings_v1')),dialog:!!document.querySelector('.fullscreen-break-takeover')}})` });
  return (await until(app, app.read, value => value.renderer?.completionMarker === marker,
    'renderer completion probe', 5_000)).renderer;
}
async function waitForClose(app, timeout) {
  const deadline = Date.now() + timeout;
  while (!app.closed && Date.now() < deadline) await sleep(50);
  return app.closed;
}
function terminateTree(app, signal) {
  if (!app.child.pid) return;
  try { process.kill(-app.child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stop(app) {
  try {
    if (app.launchError) return;
    // Quit can exit before writing its acknowledgment. Observe close, which
    // also waits for the child's output pipes, instead of waiting for a reply.
    if (!app.closed) writeControl(app, 'quit');
    assert(await waitForClose(app, 5_000), 'Native app must quit within five seconds');
    assert.equal(app.child.exitCode, 0, app.output);
    assert.equal(app.child.signalCode, null);
  } finally {
    try {
      if (!app.closed) {
        terminateTree(app, 'SIGTERM');
        if (!await waitForClose(app, 1_000)) {
          terminateTree(app, 'SIGKILL');
          assert(await waitForClose(app, 1_000), 'Native process tree must close after forced cleanup');
        }
      }
    } finally {
      app.child.stdout?.destroy(); app.child.stderr?.destroy(); app.child.unref();
      fs.writeFileSync(path.join(app.directory, 'native.log'), app.output);
    }
  }
}

function installProbe(returnOutsideRenderer) {
  return `(()=>{window.cameraCompletionProbe={acquisitions:0,stops:0,frames:0,locks:0,frameHashes:[],stationaryEvents:0,inputEvents:[],inputEventsAfterAcquisition:0,idleReads:[]};
    const probe=window.cameraCompletionProbe;
    try{
      const idleStartedAt=performance.now(),fakeVideos=new WeakMap();
      const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'srcObject');
      for(const type of ['mousemove','mousedown','keydown','touchstart'])window.addEventListener(type,event=>{
        const stationary=event.type==='mousemove'&&event.movementX===0&&event.movementY===0;
        if(stationary&&probe.acquisitions>probe.stops)probe.stationaryEvents++;
        else if(!stationary){
          if(probe.acquisitions>0)probe.inputEventsAfterAcquisition++;
          if(probe.inputEvents.length<20)probe.inputEvents.push({type:event.type,at:performance.now(),trusted:event.isTrusted});
        }
      });
      Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{configurable:true,get(){return fakeVideos.get(this)||descriptor.get.call(this)},set(value){
        if(value?.blinchoSynthetic){fakeVideos.set(this,value);this.blinchoSynthetic=true;
          Object.defineProperties(this,{videoWidth:{get:()=>640},videoHeight:{get:()=>480},readyState:{get:()=>4},currentTime:{get:()=>performance.now()/1000}});
          this.play=async()=>{};this.pause=()=>{};
        }else{fakeVideos.delete(this);descriptor.set.call(this,value)}
      }});
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
        if(!image?.blinchoSynthetic)return draw.call(this,image,...args);
        const gradient=this.createLinearGradient(0,0,this.canvas.width,this.canvas.height);
        gradient.addColorStop(0,'#273746');gradient.addColorStop(1,'#d4d8dc');this.fillStyle=gradient;
        this.fillRect(0,0,this.canvas.width,this.canvas.height);this.fillStyle='#e0e2e4';
        this.fillRect((++probe.frames*11)%200,20,10,10);
        const pixels=this.getImageData(0,0,this.canvas.width,this.canvas.height).data;
        let hash=2166136261;for(const value of pixels)hash=Math.imul(hash^value,16777619);
        probe.frameHashes.push(hash>>>0);
        if(${returnOutsideRenderer}&&probe.frames===3){probe.returnedAt=performance.now();probe.inputEventsAtReturn=probe.inputEvents.length}
      };
      // Replace MediaDevices with a plain object. Patching its native method
      // alone is unreliable in WKWebView and could invoke the physical camera.
      Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
        probe.acquisitions++;probe.acquiredAt=performance.now();
        setTimeout(()=>{window.dispatchEvent(new MouseEvent('mousemove',{movementX:0,movementY:0}));probe.dispatchedStationary=true},100);
        const track={readyState:'live',muted:false,stop(){if(this.readyState==='live')probe.stops++;this.readyState='ended';probe.trackState=this.readyState;probe.stoppedAt=performance.now()}};
        return{blinchoSynthetic:true,getTracks:()=>[track],getVideoTracks:()=>[track]}
      }}});
      window.electronAPI.getSystemIdleTime=async()=>{
        const idle=probe.returnedAt===undefined?20+(performance.now()-idleStartedAt)/1000:(performance.now()-probe.returnedAt)/1000;
        if(probe.idleReads.length<100)probe.idleReads.push({at:performance.now(),idle});return idle;
      };
      window.electronAPI.lockComputer=async()=>{probe.locks++;probe.lockedAt=performance.now();return false};
      probe.installed=true;
    }catch(error){probe.error=String(error)}
  })()`;
}

async function scenario(base, { name, strictMode, returnOutsideRenderer = false }) {
  const directory = fs.mkdtempSync(path.join(base, name + '-'));
  const source = path.join(directory, 'legacy.json');
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
    myeyes_settings_v1: JSON.stringify({ timerPreset: 'custom', workMinutes: 60, breakSeconds: 3,
      cameraLockEnabled: true, strictMode, idleDetectionEnabled: false, meetingDetectionEnabled: false,
      soundEnabled: false, notificationsEnabled: false, autoTakeoverModal: true }),
    'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
  } }), { mode: 0o600 });
  const child = spawn(executable, [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
    BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const app = { child, directory, output: '', closed: false, exit: null, launchError: null,
    read: () => readJSON(path.join(directory, 'runtime-diagnostics.json')) };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    app.output += data.toString();
  });
  child.once('error', error => { app.launchError = error; });
  child.once('close', (code, signal) => { app.closed = true; app.exit = { code, signal }; });
  let result, primaryError;
  try {
    const initial = await until(app, app.read, value => value.renderer?.ready && value.timer.totalMs > 0,
      'native renderer readiness');
    assert.equal(initial.pid, child.pid);
    assert.equal(initial.updates.currentVersion, expectedVersion, 'Executable version must match package.json');
    await control(app, 'eval', { script: installProbe(returnOutsideRenderer) });
    const setup = await inspect(app);
    assert.equal(setup.probe.installed, true, JSON.stringify(setup));
    assert.equal(setup.settings.cameraLockEnabled, true);
    assert.equal(setup.settings.strictMode, strictMode);
    await control(app, 'rest');
    const started = await until(app, app.read, value => value.timer.breakActive
      && (!strictMode || (value.strict && value.strictShieldCount > 0)), 'native break', 10_000);
    const deadline = started.timer.breakEndAt;
    assert(deadline > Date.now(), 'Native countdown must still be active');
    await until(app, app.read, value => !value.timer.breakActive, 'real native break completion', 10_000);
    assert(Date.now() >= deadline, 'Camera capture must follow the native countdown');
    const end = Date.now() + 25_000;
    let observed;
    do {
      observed = await inspect(app);
      if (observed.probe.stops === 1) break;
      await sleep(150);
    } while (Date.now() < end);
    assert.equal(observed.probe.acquisitions, 1, JSON.stringify(observed));
    assert.equal(observed.probe.frames, 3, 'Bundled local detector must sample three frames');
    assert.equal(new Set(observed.probe.frameHashes).size, 3, 'Every captured frame must have distinct pixels');
    assert.equal(observed.probe.stops, 1, 'Synthetic camera track must be released');
    assert.equal(observed.probe.trackState, 'ended');
    assert.equal(observed.probe.dispatchedStationary, true, 'Stationary mousemove must occur during capture');
    assert(observed.probe.stationaryEvents >= 1, 'Capture must survive the stationary mousemove');
    assert.equal(observed.dialog, false, 'Completed break overlay must be removed');
    // Track cleanup precedes the final presence/idle reads. Observe subsequent
    // native ticks to prove the decision and its one-shot behavior have settled.
    const tick = app.read().timer.tickCount;
    await until(app, app.read, value => value.timer.tickCount >= tick + 4, 'subsequent native timer ticks', 5_000);
    observed = await inspect(app);
    assert.equal(app.read().strict, false, 'Completed break must release the native strict guard');
    assert.equal(app.read().strictShieldCount, 0, 'Completed break must remove native strict shields');
    assert.equal(observed.probe.acquisitions, 1, 'Later native ticks must not reopen the camera');
    assert.equal(observed.probe.locks, returnOutsideRenderer ? 0 : 1, JSON.stringify(observed));
    if (returnOutsideRenderer) {
      assert(observed.probe.returnedAt > observed.probe.acquiredAt + 1000, 'System input must occur after capture began');
      // Input during the preceding break cannot cancel a future camera check.
      // Only input after acquisition could mask this final system-idle guard.
      assert.equal(observed.probe.inputEventsAfterAcquisition, 0,
        'No renderer activity during capture may cancel the outside-return case');
      assert(observed.probe.idleReads.some(read => read.at >= observed.probe.returnedAt && read.idle < 1),
        'Fresh system idle must be read after the external return');
    }
    result = { name, status: 'passed', strictMode, returnOutsideRenderer, version: initial.updates.currentVersion,
      executable, profile: directory, pid: child.pid, nativeBreakDeadline: deadline, probe: observed.probe,
      realWKWebView: true, realNativeTimer: true, realLocalDetector: true };
  } catch (error) {
    primaryError = error;
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack,
      exit: app.exit, runtime: app.read() }, null, 2));
  } finally {
    try { await stop(app); }
    catch (error) {
      fs.writeFileSync(path.join(directory, 'shutdown-failure.json'), JSON.stringify({ error: error.stack, exit: app.exit }, null, 2));
      if (!primaryError) primaryError = error;
    }
  }
  if (primaryError) throw primaryError;
  result.shutdown = { closed: app.closed, exitCode: child.exitCode, signal: child.signalCode };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PASS: ' + name);
  return result;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('SKIP: Native camera completion smoke requires macOS');
    return;
  }
  const artifactRoot = process.env.BLINCHO_CAMERA_COMPLETION_ARTIFACTS || os.tmpdir();
  fs.mkdirSync(artifactRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(artifactRoot, 'blincho-camera-completion-'));
  console.log('Native camera completion artifacts: ' + base);
  const scenarios = [];
  for (const options of [
    { name: 'normal-completion', strictMode: false },
    { name: 'strict-completion', strictMode: true },
    { name: 'strict-outside-return', strictMode: true, returnOutsideRenderer: true },
  ]) scenarios.push(await scenario(base, options));
  const result = { status: 'passed', version: expectedVersion, platform: process.platform, architecture: process.arch,
    scenarios, artifacts: base,
    limitation: 'Synthetic camera video, modeled system idle and a mocked lock bridge. No physical camera or operating-system lock was invoked.' };
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
