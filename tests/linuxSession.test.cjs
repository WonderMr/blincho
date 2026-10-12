const test = require('node:test');
const assert = require('node:assert/strict');
const { createLinuxSessionProbe, parseSessionState } = require('../electron/linuxSession.cjs');

function fakeClock() {
  let time = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    schedule(fn, delay) { const id = {}; timers.set(id, { at: time + delay, fn }); return id; },
    cancel(id) { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
    get pending() { return timers.size; },
  };
  return clock;
}

test('logind lock and inactive sessions pause; unlocked active session recovers', () => {
  for (const active of ['yes', 'no']) for (const locked of ['yes', 'no']) {
    assert.deepEqual(parseSessionState(`LockedHint=${locked}\nActive=${active}\n`), { locked: active === 'no' || locked === 'yes' });
  }
});

test('missing, duplicate or malformed session properties are never presence', () => {
  for (const output of ['', undefined, 'Active=yes', 'Active=yes\nLockedHint=false', 'Active=yes\nLockedHint=no\nActive=no', 'Active=yes\nLockedHint=no\nwarning']) {
    assert.throws(() => parseSessionState(output), /unconfirmed/);
  }
});

test('probe shares concurrent reads, uses bounded shell-free arguments, never caches old presence', async () => {
  const calls = [];
  const clock = fakeClock();
  const probe = createLinuxSessionProbe({ ...clock, env: { XDG_SESSION_ID: 'c2' }, execute: (...args) => calls.push(args) });
  const reads = Array.from({ length: 100 }, () => probe.sample());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'loginctl');
  assert.deepEqual(calls[0][1], ['show-session', 'c2', '--property=Active', '--property=LockedHint', '--no-pager']);
  assert.equal(calls[0][2].timeout, 1000);
  assert.equal(calls[0][2].maxBuffer, 4096);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].env.LC_ALL, 'C');
  calls[0][3](null, 'Active=yes\nLockedHint=no');
  assert((await Promise.all(reads)).every(state => !state.locked));
  const next = probe.sample();
  assert.equal(calls.length, 1);
  clock.advance(250);
  assert.equal(calls.length, 2);
  calls[1][3](null, 'Active=yes\nLockedHint=yes');
  assert.equal((await next).locked, true);
});

test('missing or unsafe session ids use logind auto, never arbitrary command arguments', async () => {
  for (const id of [undefined, '--help', 'a b', 'a;echo bad', 'x'.repeat(129)]) {
    let args;
    const probe = createLinuxSessionProbe({ env: { XDG_SESSION_ID: id }, execute: (_file, values, _options, callback) => { args = values; callback(null, 'Active=yes\nLockedHint=no'); } });
    await probe.sample();
    assert.equal(args[1], 'auto');
  }
});

test('absence invalidates old reads without clearing a newer in-flight read', async () => {
  const callbacks = [];
  const clock = fakeClock();
  const probe = createLinuxSessionProbe({ ...clock, execute: (_file, _args, _options, callback) => callbacks.push(callback), env: {} });
  const old = probe.sample();
  const rejected = assert.rejects(old, /stale/);
  probe.invalidate();
  const fresh = probe.sample();
  callbacks[0](null, 'Active=yes\nLockedHint=no');
  await rejected;
  assert.equal(probe.sample(), fresh);
  clock.advance(250);
  callbacks[1](null, 'Active=yes\nLockedHint=yes');
  assert.equal((await fresh).locked, true);
});

test('missing loginctl, timeout and malformed output reject; subsequent samples recover', async () => {
  for (const error of [Object.assign(new Error('not found'), { code: 'ENOENT' }), Object.assign(new Error('timeout'), { killed: true }), null]) {
    let failed = true;
    const clock = fakeClock();
    const probe = createLinuxSessionProbe({ ...clock, env: {}, execute: (_file, _args, _options, callback) => failed ? callback(error, '') : callback(null, 'Active=yes\nLockedHint=no') });
    await assert.rejects(probe.sample(), /unavailable|unconfirmed/);
    failed = false;
    const recovery = probe.sample();
    clock.advance(250);
    assert.equal((await recovery).locked, false);
  }
});

test('input bursts launch at most once per 250 ms and observe locks during the wait', async () => {
  const clock = fakeClock();
  const launched = [];
  let locked = false;
  const probe = createLinuxSessionProbe({ ...clock, env: {}, execute: (_file, _args, _options, callback) => {
    launched.push(clock.now());
    callback(null, `Active=yes\nLockedHint=${locked ? 'yes' : 'no'}`);
  } });
  assert.equal((await probe.sample()).locked, false);
  const burst = Array.from({ length: 100 }, () => probe.sample());
  assert.equal(clock.pending, 1);
  assert.equal(launched.length, 1);
  clock.advance(249);
  assert.equal(launched.length, 1);
  locked = true;
  clock.advance(1);
  assert((await Promise.all(burst)).every(state => state.locked));
  assert.deepEqual(launched, [0, 250]);
  const next = probe.sample();
  clock.advance(250);
  assert.equal((await next).locked, true);
  assert.deepEqual(launched, [0, 250, 500]);
});

test('invalidation cancels a rate-limited wait and fresh recovery keeps the rate limit', async () => {
  const clock = fakeClock();
  const launched = [];
  const probe = createLinuxSessionProbe({ ...clock, env: {}, execute: (_file, _args, _options, callback) => {
    launched.push(clock.now()); callback(null, 'Active=yes\nLockedHint=no');
  } });
  await probe.sample();
  const stale = assert.rejects(probe.sample(), /stale/);
  probe.invalidate();
  await stale;
  assert.equal(clock.pending, 0);
  const fresh = probe.sample();
  clock.advance(249);
  assert.equal(launched.length, 1);
  clock.advance(1);
  assert.equal((await fresh).locked, false);
  assert.deepEqual(launched, [0, 250]);
});
