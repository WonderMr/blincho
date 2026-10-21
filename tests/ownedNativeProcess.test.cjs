const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { stopOwnedNativeProcess } = require('./support/ownedNativeProcess.cjs');

test('AppImage-style child retaining stderr is terminated with its owned detached group', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const wrapper = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    process.send(child.pid);setInterval(()=>{},1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const message = once(wrapper, 'message');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const [descendant] = await message;
    assert(Number.isSafeInteger(descendant) && descendant > 0);
    let didClose = false;
    wrapper.once('close', () => { didClose = true; });
    wrapper.kill();
    await once(wrapper, 'exit');
    assert.equal(didClose, false, 'the native descendant still retains the wrapper pipes');
    await stopOwnedNativeProcess(wrapper, { processGroup: true, timeoutMs: 1000 });
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
    try { process.kill(-wrapper.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
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
