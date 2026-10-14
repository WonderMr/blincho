// Runs the bundled detector in the real system WebView, without acquiring a
// camera or locking the desktop. The native test profile rejects lock requests.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-camera-smoke-'));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.join(root, 'src-tauri/target', ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const modelChunk = fs.readdirSync(path.join(root, 'dist/assets')).find(file => /^cameraModel-.*\.js$/.test(file));
assert(modelChunk, 'Bundled detector chunk exists');
const source = path.join(directory, 'legacy.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ workMinutes: 60, meetingDetectionEnabled: false, idleDetectionEnabled: false, soundEnabled: false, notificationsEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const child = spawn(executable, [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory, BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let output = '', launchError, sequence = 0, closed = false;
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); child.on('error', error => { launchError = error; });
child.once('close', () => { closed = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Camera smoke exited: ' + output);
    try { const value = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'))); if (predicate(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Camera smoke timed out: ' + output);
}
async function control(operation, args = {}) {
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ id: ++sequence, operation, ...args }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
}
async function evaluate(script) { await control('eval', { script }); }
async function waitForClose(timeout) {
  const deadline = Date.now() + timeout;
  while (!closed && Date.now() < deadline) await sleep(50);
  return closed;
}
function terminateTree(signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 1000, windowsHide: true }); }
    catch { child.kill(signal); }
  } else {
    // AppImage wrappers and their native children share our dedicated group.
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
async function stop() {
  try {
    if (launchError) return;
    // Target the native test profile first. quit may exit before response.json
    // is written, so wait for close, including any descendant-owned pipes.
    await control('quit');
    if (!await waitForClose(5000)) throw Error('Camera smoke did not quit within 5 seconds: ' + output);
    assert.equal(child.exitCode, 0, 'Camera smoke exited during shutdown: ' + output);
  } finally {
    try {
      if (!closed) {
        terminateTree('SIGTERM');
        if (!await waitForClose(1000)) { terminateTree('SIGKILL'); await waitForClose(1000); }
      }
    } finally {
      // A surviving descendant can retain wrapper pipes after its exit. Bound
      // our own event-loop lifetime even when process-tree cleanup fails.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
  }
}
(async () => {
  try {
    await until(value => value.renderer?.ready && value.timer.totalMs > 0);
    await evaluate(`(async()=>{let detector;const errors=[];const originalError=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' ').slice(0,500));if(errors.length>8)errors.shift();originalError.apply(console,args)};
    let webglRequests=0;const prototypes=[HTMLCanvasElement.prototype,...(typeof OffscreenCanvas==='function'?[OffscreenCanvas.prototype]:[])];const originals=prototypes.map(prototype=>prototype.getContext);prototypes.forEach((prototype,index)=>{prototype.getContext=function(kind,...args){if(String(kind).toLowerCase().includes('webgl')){webglRequests++;throw Error('Camera detection must not initialize WebGL')}return originals[index].call(this,kind,...args)}});try{
      const module=await import('./assets/${modelChunk}'); detector=await Object.values(module)[0]();
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;
      const ctx=canvas.getContext('2d');const gradient=ctx.createLinearGradient(0,0,320,240);gradient.addColorStop(0,'#263342');gradient.addColorStop(1,'#a8bbc9');ctx.fillStyle=gradient;ctx.fillRect(0,0,320,240);
      const result=await detector.detect(canvas);if(!Array.isArray(result.detections))throw Error('Invalid real model result');
      let lockRejected=false;try{await window.electronAPI.lockComputer()}catch(error){lockRejected=String(error).includes('test profile')}
      document.querySelector('.nav-settings-button').click();
      await new Promise(resolve=>setTimeout(resolve,100));
      const toggle=document.getElementById('camera-lock-enabled');
      await window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,cameraSmoke:{passed:true,detections:result.detections.length,webglRequests,cameraAPI:typeof navigator.mediaDevices?.getUserMedia==='function',lockAPI:typeof window.electronAPI.lockComputer==='function',lockRejected,defaultDisabled:JSON.parse(localStorage.getItem('myeyes_settings_v1')||'{}').cameraLockEnabled!==true,toggleReady:!!toggle&&!toggle.checked&&!toggle.disabled}}});
    }catch(error){await window.__TAURI__.core.invoke('renderer_report',{report:{ready:true,cameraSmoke:{passed:false,error:String(error),stack:error?.stack,webglRequests,errors}}})}finally{prototypes.forEach((prototype,index)=>{prototype.getContext=originals[index]});console.error=originalError;detector?.close()}})()`);
    const probe = (await until(value => value.renderer?.cameraSmoke)).renderer.cameraSmoke;
    assert.equal(probe.passed, true, JSON.stringify(probe)); assert.equal(probe.webglRequests, 0); assert.equal(probe.cameraAPI, true); assert.equal(probe.lockAPI, true); assert.equal(probe.lockRejected, true); assert.equal(probe.defaultDisabled, true); assert.equal(probe.toggleReady, true);
    console.log(JSON.stringify({ ...probe, executable, profile: directory, limitation: 'Actual camera hardware and physical locking were not invoked.' }, null, 2));
  } finally {
    try { await stop(); } catch (error) { console.error(error); process.exitCode = 1; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
