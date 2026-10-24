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

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function releaseReaders(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      // macOS can report EPERM while an exited group leader is a zombie.
      // Keep polling within the deadline; EPERM never proves disappearance.
      if (error.code !== 'EPERM') throw error;
    }
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, deadline - performance.now())));
  }
}

// processGroup requires a child spawned with detached:true on Unix. The group
// belongs to that launch, including AppImage's wrapper and native child.
async function stopOwnedNativeProcess(child, { processGroup = false, timeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid === process.pid) return;
  const signal = name => {
    // Once the tracked leader exits, a numeric PGID cannot prove ownership.
    if (exited(child)) return;
    try {
      if (processGroup) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  if (processGroup) {
    try {
      signal('SIGTERM');
      if (!await waitForGroupExit(child.pid, timeoutMs)) {
        if (exited(child)) throw new Error('Owned process group survived launcher exit; group ownership lost');
        signal('SIGKILL');
        if (!await waitForGroupExit(child.pid, timeoutMs)) throw new Error('Owned process group did not exit after forced shutdown');
      }
      if (!await waitForClose(child, timeoutMs)) {
        releaseReaders(child);
        if (!exited(child)) throw new Error('Owned native launcher did not close');
      }
      return;
    } catch (error) { releaseReaders(child); throw error; }
  }
  signal('SIGTERM');
  if (await waitForClose(child, timeoutMs)) return;
  signal('SIGKILL');
  if (await waitForClose(child, timeoutMs)) return;
  releaseReaders(child);
  // A toolkit service outside our group may retain inherited pipe handles.
  // Once the launched process exited, release our readers without targeting
  // unrelated desktop services.
  if (child.exitCode !== null || child.signalCode !== null) return;
  throw new Error('Owned native process did not close after forced shutdown');
}

module.exports = { stopOwnedNativeProcess };
