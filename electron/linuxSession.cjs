const { execFile } = require('child_process');
const { performance } = require('node:perf_hooks');
const MIN_PROBE_INTERVAL_MS = 250;

// Electron emits lock/unlock events only on macOS and Windows. On Linux,
// logind provides the desktop's lock hint and whether our session is active.
// https://www.freedesktop.org/software/systemd/man/latest/loginctl.html
function parseSessionState(output) {
  const properties = new Map();
  for (const line of String(output).trim().split(/\r?\n/)) {
    const match = /^(Active|LockedHint)=(yes|no)$/.exec(line);
    if (!match || properties.has(match[1])) throw new Error('Linux session state is unconfirmed');
    properties.set(match[1], match[2]);
  }
  if (properties.size !== 2) throw new Error('Linux session state is unconfirmed');
  return { locked: properties.get('LockedHint') === 'yes' || properties.get('Active') !== 'yes' };
}

function createLinuxSessionProbe({ execute = execFile, env = process.env, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
  const session = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(env.XDG_SESSION_ID || '') ? env.XDG_SESSION_ID : 'auto';
  let generation = 0;
  let pending = null;
  let lastStartedAt = -Infinity;
  return {
    invalidate() {
      generation += 1;
      if (pending) {
        if (pending.timer !== null) cancel(pending.timer);
        pending.finish(new Error('Linux session sample is stale'));
      }
    },
    sample() {
      if (pending) return pending.promise;
      const expectedGeneration = generation;
      let resolveRequest, rejectRequest;
      const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
      const request = { promise, timer: null, done: false, finish(error, value) {
        if (request.done) return;
        request.done = true;
        if (pending === request) pending = null;
        if (error) rejectRequest(error);
        else resolveRequest(value);
      } };
      pending = request;
      const launch = () => {
        request.timer = null;
        if (request.done) return;
        if (expectedGeneration !== generation) return request.finish(new Error('Linux session sample is stale'));
        lastStartedAt = now();
        try {
          execute('loginctl', ['show-session', session, '--property=Active', '--property=LockedHint', '--no-pager'],
            { timeout: 1000, maxBuffer: 4096, encoding: 'utf8', env: { ...env, LC_ALL: 'C', SYSTEMD_COLORS: '0' } },
            (error, stdout) => {
              if (expectedGeneration !== generation) return request.finish(new Error('Linux session sample is stale'));
              if (error) return request.finish(new Error('Linux session state is unavailable'));
              try { request.finish(null, parseSessionState(stdout)); }
              catch (parseError) { request.finish(parseError); }
            });
        } catch {
          request.finish(new Error('Linux session state is unavailable'));
        }
      };
      // Input bursts share a waiting probe. Always query fresh state after the
      // wait; caching an unlocked result could erase a lock before completion.
      const delay = Math.max(0, MIN_PROBE_INTERVAL_MS - (now() - lastStartedAt));
      if (delay > 0) request.timer = schedule(launch, delay);
      else launch();
      return promise;
    },
  };
}

module.exports = { createLinuxSessionProbe, parseSessionState };
