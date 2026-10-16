const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

// Leave room inside the lifecycle test's 25-second limit after its 20-second
// subprocess timeout. One deadline covers both process exit and directory locks.
const CLEANUP_TIMEOUT_MS = 3000;
const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EMFILE', 'ENFILE']);

async function cleanupCameraFixture({ pids, directories }, {
  timeoutMs = CLEANUP_TIMEOUT_MS,
  pollIntervalMs = 25,
  kill = process.kill,
  remove = fs.rmSync,
} = {}) {
  const pending = new Set(pids);
  for (const pid of pending) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      throw Error(`Invalid camera lifecycle fixture PID: ${pid}`);
    }
  }
  const deadline = performance.now() + timeoutMs;
  const pause = () => sleep(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())));
  for (const pid of pending) {
    try { kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code === 'ESRCH') pending.delete(pid); else throw error; }
  }
  // SIGKILL requests termination; it does not wait for the target to release its
  // cwd and file handles. In particular, Windows can still reject rmdir here.
  while (pending.size) {
    for (const pid of pending) {
      try { kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') pending.delete(pid); else throw error; }
    }
    if (!pending.size) break;
    if (performance.now() >= deadline) {
      throw Error(`Camera lifecycle fixture cleanup timed out waiting for PIDs: ${[...pending].join(', ')}`);
    }
    await pause();
  }
  for (const directory of directories) {
    while (true) {
      try { remove(directory, { recursive: true, force: true }); break; }
      catch (error) {
        if (!RETRYABLE_REMOVE_ERRORS.has(error.code) || performance.now() >= deadline) throw error;
        await pause();
      }
    }
  }
}

module.exports = { CLEANUP_TIMEOUT_MS, cleanupCameraFixture };
