const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-statistics-'));
fs.writeFileSync(path.join(build, 'tsconfig.json'), JSON.stringify({
  files: [path.join(repo, 'src/utils/storage.ts')],
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true,
    rootDir: path.join(repo, 'src'), outDir: build },
}));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
  '-p', path.join(build, 'tsconfig.json')], { stdio: 'inherit' });
test.after(() => fs.rmSync(build, { recursive: true, force: true }));
const key = 'myeyes_stats_v1';
const day = '2026-10-25';
const fixture = [{ date: day, focusMinutes: 2, breaksCompleted: 1, exercisesCompleted: 0,
  meetings: [{ start: new Date(`${day}T10:00:00`).getTime(), end: new Date(`${day}T10:01:00`).getTime(), app: 'zoom' }] }];
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ legacy = JSON.stringify(fixture), saved = null } = {}) {
  const values = new Map(legacy === null ? [] : [[key, legacy]]);
  const calls = [], timers = new Map(), cache = new Map(), warnings = [];
  const metrics = { writes: 0, reads: 0, removes: 0 };
  let nextTimer = 0;
  const h = { saved, calls, timers, values, metrics, warnings, save: async value => { h.saved = value; } };
  const localStorage = {
    getItem(name) { metrics.reads++; return values.get(name) ?? null; },
    setItem(name, value) { metrics.writes++; values.set(name, value); },
    removeItem(name) { metrics.removes++; values.delete(name); },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports,
      require: name => load(path.resolve(path.dirname(file), name + (path.extname(name) ? '' : '.js'))), localStorage,
      console: { warn: (...args) => warnings.push(args) },
      setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: id => timers.delete(id),
    }, { filename: file });
    return module.exports;
  }
  h.persistence = load(path.join(build, 'utils/statisticsPersistence.js'));
  h.storage = load(path.join(build, 'utils/storage.js'));
  h.invoke = async (command, args) => {
    calls.push([command, args?.value]);
    if (command === 'statistics_load') return h.saved;
    if (command === 'statistics_save') return h.save(args.value);
    throw Error(`Unexpected command ${command}`);
  };
  h.initialize = () => h.persistence.initializeStatisticsPersistence(h.invoke);
  h.runTimer = async () => {
    const [id, callback] = timers.entries().next().value ?? [];
    assert(callback, 'one bounded save/retry timer is scheduled');
    timers.delete(id); callback(); await tick();
  };
  return h;
}

test('migration preserves exact legacy bytes and removes the key only after durable success', async () => {
  const legacy = JSON.stringify([...fixture, { arbitraryFutureField: 'preserved' }]);
  const h = harness({ legacy });
  let complete;
  h.save = value => new Promise(resolve => { complete = () => { h.saved = value; resolve(); }; });
  const pending = h.initialize(); await tick();
  assert.equal(h.values.get(key), legacy);
  assert.equal(h.metrics.removes, 0);
  complete(); await pending;
  assert.equal(h.saved, legacy);
  assert.equal(h.persistence.readStatistics(), legacy);
  assert.equal(h.values.has(key), false);
  assert.equal(h.metrics.writes, 0);
});

test('failed migration remains repeatable without changing the legacy source', async () => {
  const h = harness(); const original = h.values.get(key);
  h.save = async () => { throw Error('disk full'); };
  await assert.rejects(h.initialize(), /disk full/);
  assert.equal(h.values.get(key), original);
  h.save = async value => { h.saved = value; };
  await h.initialize();
  assert.equal(h.saved, original); assert.equal(h.values.has(key), false);
});

test('interrupted cleanup retries using the authoritative native file', async () => {
  const saved = JSON.stringify([{ ...fixture[0], focusMinutes: 123 }]);
  const h = harness({ saved, legacy: 'corrupt obsolete data' });
  await h.initialize();
  assert.equal(h.persistence.readStatistics(), saved);
  assert.deepEqual(h.calls.map(([command]) => command), ['statistics_load', 'statistics_save']);
  assert.equal(h.values.has(key), false);
});

test('a visible replacement without durable acknowledgement cannot bypass migration cleanup on retry', async () => {
  const h = harness(); const original = h.values.get(key);
  h.save = async value => { h.saved = value; throw Error('directory sync failed'); };
  await assert.rejects(h.initialize(), /directory sync failed/);
  assert.equal(h.saved, original); assert.equal(h.values.get(key), original);
  await assert.rejects(h.initialize(), /directory sync failed/);
  assert.equal(h.values.get(key), original);
  assert.equal(h.calls.filter(([command]) => command === 'statistics_save').length, 2);
  h.save = async value => { h.saved = value; };
  await h.initialize(); assert.equal(h.values.has(key), false);
});

test('corrupt native data or an unreadable native file blocks startup without overwriting either source', async () => {
  for (const saved of ['broken', '{}']) {
    const h = harness({ saved }); const original = h.values.get(key);
    await assert.rejects(h.initialize());
    assert.equal(h.saved, saved); assert.equal(h.values.get(key), original);
    assert.equal(h.calls.some(([command]) => command === 'statistics_save'), false);
  }
  const h = harness(); h.invoke = async () => { throw Error('unreadable'); };
  await assert.rejects(h.initialize(), /unreadable/);
  assert(h.values.has(key));
});

test('an empty profile and repeated initialization produce one durable empty snapshot', async () => {
  const h = harness({ legacy: null });
  await Promise.all([h.initialize(), h.initialize()]); await h.initialize();
  assert.equal(h.saved, '[]'); assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test('an invalid native response never removes the legacy statistics', async () => {
  const h = harness(); h.invoke = async () => undefined;
  await assert.rejects(h.initialize(), /Invalid native statistics response/);
  assert(h.values.has(key)); assert.equal(h.metrics.removes, 0);
});

test('an hour of 4Hz frames retains the newest snapshot with bounded pending work and zero WebKit writes', async () => {
  const h = harness(); await h.initialize();
  const before = { ...h.metrics }, calls = h.calls.length;
  for (let second = 0; second < 3600; second++) {
    for (let frame = 0; frame < 4; frame++) h.persistence.writeStatistics(JSON.stringify([{ ...fixture[0], focusMinutes: (second + (frame + 1) / 4) / 60 }]));
    assert.equal(h.timers.size, 1);
    if ((second + 1) % 5 === 0) await h.runTimer();
  }
  await h.persistence.flushStatistics();
  assert.equal(JSON.parse(h.saved)[0].focusMinutes, 60);
  assert.equal(h.calls.length - calls, 720);
  assert.deepEqual(h.metrics, before);
  assert.equal(h.timers.size, 0);
});

test('failed commits keep dirty statistics and retry without further activity', async () => {
  const h = harness(); await h.initialize(); const original = h.saved;
  h.persistence.writeStatistics('[{"focusMinutes":7}]');
  h.save = async () => { throw Error('disk full'); };
  await assert.rejects(h.persistence.flushStatistics(), /disk full/);
  assert.equal(h.saved, original);
  assert.equal(JSON.parse(h.persistence.readStatistics())[0].focusMinutes, 7);
  assert.equal(h.timers.size, 1);
  h.save = async value => { h.saved = value; };
  await h.runTimer();
  assert.equal(h.saved, '[{"focusMinutes":7}]'); assert.equal(h.timers.size, 0);
});

test('slow commits coalesce later frames and deletion waits until the new revision is durable', async () => {
  const h = harness(); await h.initialize();
  const pending = [];
  h.save = value => new Promise(resolve => pending.push(() => { h.saved = value; resolve(); }));
  h.storage.recordFocusSeconds(1, day);
  const firstFlush = h.persistence.flushStatistics(); await tick();
  for (let i = 0; i < 100; i++) h.storage.recordFocusSeconds(1, day);
  let deleted = false;
  const deletion = Promise.resolve(h.storage.clearMeetingHistory()).then(ok => { assert.equal(ok, true); deleted = true; });
  await tick(); assert.equal(pending.length, 1); assert.equal(deleted, false);
  pending.shift()(); await tick();
  assert.equal(pending.length, 1); assert.equal(deleted, false);
  pending.shift()(); await Promise.all([firstFlush, deletion]);
  const final = JSON.parse(h.saved)[0];
  assert.equal(final.meetings, undefined);
  assert(Math.abs(final.focusMinutes - (2 + 101 / 60)) < 1e-10);
  assert.equal(h.values.has(key), false); assert.equal(h.metrics.writes, 0);
});

test('failed deletion never reports durable success and later retry cannot resurrect calls', async () => {
  const h = harness(); await h.initialize();
  h.save = async () => { throw Error('read-only disk'); };
  assert.equal(await h.storage.clearMeetingHistory(), false);
  assert(JSON.parse(h.saved)[0].meetings.length);
  h.save = async value => { h.saved = value; };
  await h.runTimer();
  assert.equal(JSON.parse(h.saved)[0].meetings, undefined);
});

test('a mutation between commit completion and queue cleanup still gets its own durable acknowledgement', async () => {
  const h = harness(); await h.initialize();
  let complete;
  h.save = value => new Promise(resolve => { complete = () => { h.saved = value; resolve(); }; });
  h.persistence.writeStatistics('[1]'); const first = h.persistence.flushStatistics();
  await tick(); complete();
  let second;
  queueMicrotask(() => {
    h.save = async value => { h.saved = value; };
    h.persistence.writeStatistics('[2]'); second = h.persistence.statisticsWriteResult();
  });
  await first; await tick(); assert.equal(await second, true);
  assert.equal(h.saved, '[2]'); assert.equal(h.timers.size, 0);
});

test('duplicate input and activity snapshots, completion IDs and identical settings skip writes', async () => {
  const h = harness({ legacy: '[]' }); await h.initialize();
  const start = new Date(`${day}T10:00:00`).getTime();
  const snapshot = { status: 'active', source: 'process-1', buckets: [{ start, keyPresses: 5, clicks: 2, scrolls: 0, mouseMoves: 1 }] };
  assert.equal(await h.storage.recordInputActivity(snapshot), true);
  h.storage.recordTimerProgress([], [{ start, end: start + 1000, state: 'manual' }]);
  await h.persistence.flushStatistics(); const count = h.calls.length;
  assert.equal(await h.storage.recordInputActivity(snapshot), true);
  h.storage.recordTimerProgress([], [{ start, end: start + 1000, state: 'manual' }]);
  await h.persistence.flushStatistics();
  assert.equal(h.calls.length, count);
  h.storage.saveSettings(h.storage.DEFAULT_SETTINGS); const writes = h.metrics.writes;
  h.storage.saveSettings(h.storage.DEFAULT_SETTINGS); assert.equal(h.metrics.writes, writes);
  assert.equal(await h.storage.clearInputActivity(), true);
  assert.equal(JSON.parse(h.saved)[0].inputActivity, undefined);
});

test('midnight progress preserves both days, historical data and fractional totals through reopen', async () => {
  const h = harness(); await h.initialize();
  const start = new Date('2026-10-25T23:59:59.500').getTime();
  h.storage.recordTimerProgress([[day, .5], ['2026-10-26', .75]], [{ start, end: start + 1250, state: 'work' }]);
  await h.persistence.flushStatistics();
  const reopened = harness({ saved: h.saved, legacy: null }); await reopened.initialize();
  const history = reopened.storage.loadAllStats();
  assert.equal(history.length, 2);
  assert(Math.abs(history[0].focusMinutes - (2 + .5 / 60)) < 1e-10);
  assert.equal(history[1].focusMinutes, .75 / 60);
  assert.equal(history[0].activity[0].end - history[0].activity[0].start, 500);
  assert.equal(history[1].activity[0].end - history[1].activity[0].start, 750);
  assert.equal(history[0].breaksCompleted, 1);
});

test('browser storage keeps synchronous results and skips duplicate snapshots', () => {
  const h = harness();
  assert.equal(h.storage.clearMeetingHistory(), true); const writes = h.metrics.writes;
  assert.equal(h.storage.clearMeetingHistory(), true); assert.equal(h.metrics.writes, writes);
  assert.equal(h.calls.length, 0);
});
