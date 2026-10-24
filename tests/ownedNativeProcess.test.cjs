const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stopOwnedNativeProcess } = require('./support/ownedNativeProcess.cjs');

test('an owned live group can force a TERM-ignoring launcher to close without affecting other groups', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const wrapper = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    process.send(child.pid);setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const message = once(wrapper, 'message');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const [descendant] = await message;
    assert(Number.isSafeInteger(descendant) && descendant > 0);
    await stopOwnedNativeProcess(wrapper, { processGroup: true, timeoutMs: 1000 });
    assert.equal(wrapper.signalCode, 'SIGKILL', 'escalation uses the still-owned leader');
    assert.equal(wrapper.stderr.destroyed, true);
    assert.equal(wrapper.stdout.destroyed, true);
    let descendantAlive = true;
    for (let i = 0; i < 100 && descendantAlive; i++) {
      try { process.kill(descendant, 0); }
      catch (error) { if (error.code === 'ESRCH') descendantAlive = false; else throw error; }
      if (descendantAlive) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(descendantAlive, false, 'native descendant must exit');
    assert.equal(unrelated.exitCode, null, 'other process groups remain running');
    assert.equal(unrelated.signalCode, null);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      try { process.kill(-wrapper.pid, 'SIGKILL'); } catch { /* Preserve the test failure and continue cleanup. */ }
    }
    wrapper.stdout.destroy(); wrapper.stderr.destroy(); wrapper.unref();
    await stopOwnedNativeProcess(unrelated);
  }
});

test('direct native process shutdown waits for closure and is safe to repeat', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  await stopOwnedNativeProcess(child);
  assert(child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.stderr.destroyed, true);
  await stopOwnedNativeProcess(child);
});


test('group cleanup reports lost ownership when an independent descendant survives launcher closure', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-g-'));
  const socketPath = path.join(directory, 'control.sock');
  const server = createServer(); server.listen(socketPath); await once(server, 'listening');
  const connected = once(server, 'connection');
  const descendantSource = `
    process.on('SIGTERM',()=>{});
    const socket=require('node:net').createConnection(process.argv[1],()=>socket.write('ready'));
    socket.on('data',()=>process.exit(0));
    setTimeout(()=>process.exit(0),7000);
  `;
  const wrapper = spawn(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantSource)},process.argv[1]],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `, socketPath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let control;
  const originalKill = process.kill, signals = [];
  try {
    [control] = await connected; await once(control, 'data');
    process.kill = (pid, signal) => {
      if (pid === -wrapper.pid && signal !== 0) signals.push({ signal, leaderExited: wrapper.exitCode !== null || wrapper.signalCode !== null });
      return originalKill(pid, signal);
    };
    await assert.rejects(stopOwnedNativeProcess(wrapper, { processGroup: true, timeoutMs: 100 }), /group ownership lost/);
    assert.equal(wrapper.signalCode, 'SIGTERM');
    assert.deepEqual(signals, [{ signal: 'SIGTERM', leaderExited: false }]);
    assert.equal(control.destroyed, false, 'the independent descendant still owns its control channel');
    assert(wrapper.stdout.destroyed && wrapper.stderr.destroyed, 'failure releases inherited readers');
  } finally {
    process.kill = originalKill;
    if (control && !control.destroyed) {
      const closed = once(control, 'close'); control.end('exit'); await closed;
    }
    try { await stopOwnedNativeProcess(wrapper); } catch { /* Continue fixture cleanup. */ }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an already closed launcher cannot signal a potentially reused process group', { skip: process.platform === 'win32' }, async () => {
  const originalKill = process.kill, signals = [];
  const child = { pid: 2000000000, exitCode: 0, signalCode: null, stdout: { destroyed: true, destroy() {} }, stderr: { destroyed: true, destroy() {} }, unref() {} };
  try {
    process.kill = (pid, signal) => { signals.push({ pid, signal }); };
    await assert.rejects(stopOwnedNativeProcess(child, { processGroup: true, timeoutMs: 1 }), /group ownership lost/);
    assert(signals.length > 0);
    assert(signals.every(({ pid, signal }) => pid === -child.pid && signal === 0), 'only existence probes are permitted after ownership is lost');
  } finally { process.kill = originalKill; }
});

test('group disappearance retries inaccessible probes but requires eventual absence', { timeout: 3000 }, async () => {
  const originalKill = process.kill, signals = [];
  const child = { pid: 2000000000, exitCode: 0, signalCode: null, stdout: { destroyed: true, destroy() {} }, stderr: { destroyed: true, destroy() {} }, unref() {} };
  let probes = 0;
  try {
    process.kill = (pid, signal) => {
      signals.push({ pid, signal });
      const error = new Error('probe'); error.code = ++probes < 3 ? 'EPERM' : 'ESRCH'; throw error;
    };
    await stopOwnedNativeProcess(child, { processGroup: true, timeoutMs: 1000 });
    assert.equal(probes, 3, 'only ESRCH confirms group disappearance');
    process.kill = (pid, signal) => {
      signals.push({ pid, signal });
      const error = new Error('probe'); error.code = 'EPERM'; throw error;
    };
    await assert.rejects(stopOwnedNativeProcess(child, { processGroup: true, timeoutMs: 30 }), /group ownership lost/);
    assert(signals.every(({ pid, signal }) => pid === -child.pid && signal === 0), 'inaccessible groups must never receive a signal after leader exit');
  } finally { process.kill = originalKill; }
});
