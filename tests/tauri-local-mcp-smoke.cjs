// Exercises the real native bridge, settings switch and HTTP endpoint in a disposable profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'blincho-local-mcp-'));
const source = path.join(directory, 'history.json');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ localMcpEnabled: false, cameraLockEnabled: false, idleDetectionEnabled: false,
    meetingDetectionEnabled: false, soundEnabled: false, notificationsEnabled: false, strictMode: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }));
const executable = process.env.BLINCHO_PROTOTYPE_EXECUTABLE || path.resolve(__dirname, '../src-tauri/target',
  ...(process.env.RUST_TARGET ? [process.env.RUST_TARGET] : []), 'debug', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const child = spawn(executable, [], { env: { ...process.env, BLINCHO_PROTOTYPE_TEST_DIR: directory,
  BLINCHO_PROTOTYPE_HISTORY_SOURCE: source, BLINCHO_SMOKE_PRESENCE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', launchError, sequence = 0;
child.stderr.on('data', value => { stderr += value; }); child.on('error', error => { launchError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error('Native app exited: ' + stderr);
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Native MCP check timed out: ' + stderr);
}
const diagnostics = () => JSON.parse(fs.readFileSync(path.join(directory, 'runtime-diagnostics.json'), 'utf8'));
async function control(operation, extra = {}) {
  const id = ++sequence;
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ operation, id, ...extra }));
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const value = await until(() => JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8')), value => value.id === id);
  assert.equal(value.ok, true, value.error);
}
async function evaluate(expression) {
  const id = ++sequence;
  await control('eval', { script: `(async()=>{try {const result=await (${expression}); await window.__TAURI__.core.invoke('renderer_report',{report:{mcpSmoke:{id:${id},result}}});}catch(error){await window.__TAURI__.core.invoke('renderer_report',{report:{mcpSmoke:{id:${id},error:String(error)}}});}})();` });
  const value = await until(diagnostics, value => value.renderer?.mcpSmoke?.id === id);
  assert.equal(value.renderer.mcpSmoke.error, undefined, value.renderer.mcpSmoke.error);
  return value.renderer.mcpSmoke.result;
}
function rpc(state, method, params) {
  return new Promise((resolve, reject) => {
    const req = http.request(state.url, { method: 'POST', headers: { Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}
async function main() {
  try {
    await until(diagnostics, value => value.renderer?.ready && value.timer.totalMs > 0);
    assert.equal((await evaluate(`window.electronAPI.getLocalMcpState()`)).running, false);
    await evaluate(`(()=>{document.querySelector('.nav-settings-button').click();return true;})()`);
    await evaluate(`new Promise(resolve=>{const check=()=>{const input=document.querySelector('#local-mcp-enabled');if(input){if(input.checked)throw Error('MCP defaults on');input.click();resolve(true);}else setTimeout(check,50);};check();})`);
    const state = await evaluate(`new Promise(resolve=>{const check=async()=>{const state=await window.electronAPI.getLocalMcpState();if(state.running)resolve(state);else setTimeout(check,50);};check();})`);
    assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal((await rpc(state, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-smoke', version: '1' } })).result.protocolVersion, '2025-11-25');
    const ready = await until(async () => rpc(state, 'tools/call', { name: 'get_status', arguments: {} }), value => !value.result?.isError);
    assert.equal(typeof JSON.parse(ready.result.content[0].text).secondsRemaining, 'number');
    const totals = await rpc(state, 'tools/call', { name: 'get_today_stats', arguments: {} });
    assert.deepEqual(Object.keys(JSON.parse(totals.result.content[0].text)).sort(), ['breaksCompleted', 'date', 'exercisesCompleted', 'focusMinutes']);
    const readStatus = async () => {
      const value = await rpc(state, 'tools/call', { name: 'get_status', arguments: {} });
      assert.equal(value.result.isError, undefined); return JSON.parse(value.result.content[0].text);
    };
    for (const [name, expected] of [['pause_timer', value => !value.isRunning], ['resume_timer', value => value.isRunning],
      ['start_break', value => value.isBreakActive], ['skip_break', value => !value.isBreakActive]]) {
      const result = await rpc(state, 'tools/call', { name, arguments: {} });
      assert.equal(result.result.isError, undefined, name);
      await until(readStatus, expected);
    }
    const ui = await evaluate(`(()=>{const section=document.querySelector('#local-mcp-title').closest('section');return {checked:document.querySelector('#local-mcp-enabled').checked, text:section.textContent, clipped:section.scrollWidth>section.clientWidth};})()`);
    assert.equal(ui.checked, true); assert.equal(ui.clipped, false); assert.match(ui.text, /MCP/);
    await evaluate(`(()=>{document.querySelector('#local-mcp-enabled').click();return true;})()`);
    await evaluate(`new Promise(resolve=>{const check=async()=>{const state=await window.electronAPI.getLocalMcpState();if(!state.running)resolve(true);else setTimeout(check,50);};check();})`);
    await assert.rejects(rpc(state, 'ping', {}), /ECONNREFUSED|socket hang up/);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('myeyes_settings_v1')).localMcpEnabled`), false);
    console.log('PASS: native settings toggle, local MCP initialize/status/totals/actions, credential bridge, unclipped section, persisted disable and closed listener.');
  } finally {
    if (child.exitCode === null) { try { await control('quit'); } catch { child.kill('SIGTERM'); } }
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1000)]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
