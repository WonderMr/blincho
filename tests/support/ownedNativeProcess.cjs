function closed(child) {
  return (child.exitCode !== null || child.signalCode !== null)
    && [child.stdout, child.stderr].every(stream => !stream || stream.destroyed);
}

function waitForClose(child, timeoutMs) {
  if (closed(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); child.removeListener('close', onClose); resolve(value); };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

// processGroup requires a child spawned with detached:true on Unix. The group
// belongs to that launch, including AppImage's wrapper and native child.
async function stopOwnedNativeProcess(child, { processGroup = false, timeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid === process.pid) return;
  const signal = name => {
    try {
      if (processGroup) process.kill(-child.pid, name);
      else if (child.exitCode === null && child.signalCode === null) child.kill(name);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  if (await waitForClose(child, timeoutMs)) return;
  signal('SIGKILL');
  if (await waitForClose(child, timeoutMs)) return;
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  // A toolkit service outside our group may retain inherited pipe handles.
  // Once the launched process exited, release our readers without targeting
  // unrelated desktop services.
  if (child.exitCode !== null || child.signalCode !== null) return;
  throw new Error('Owned native process did not close after forced shutdown');
}

module.exports = { stopOwnedNativeProcess };
