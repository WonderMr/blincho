const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-input-'));
fs.writeFileSync(path.join(build, 'tsconfig.json'), JSON.stringify({ files: [path.join(repo, 'src/utils/storage.ts')], compilerOptions: {
  target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, rootDir: path.join(repo, 'src'), outDir: build,
} }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-p', path.join(build, 'tsconfig.json')], { stdio: 'inherit' });
const storage = require(path.join(build, 'utils/storage.js'));
const { normalizeInputActivity } = require(path.join(build, 'utils/inputActivity.js'));
const values = new Map();
global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const at = date => new Date(`${date}T12:00:00`).getTime();
const bucket = (start, count = 1) => ({ start, keyPresses: count, clicks: count * 2, scrolls: 0, mouseMoves: count * 5 });
const snapshot = (buckets, source = 'test-source') => ({ source, status: 'active', buckets });
test.after(() => fs.rmSync(build, { recursive: true, force: true }));
test.beforeEach(() => values.clear());

test('persisted cumulative buckets survive replay, reordering and a renderer reload without double counting', () => {
  const start = at('2026-10-19');
  assert(storage.recordInputActivity(snapshot([bucket(start, 3)])));
  storage.recordInputActivity(snapshot([bucket(start, 3)]));
  storage.recordInputActivity(snapshot([bucket(start, 2)]));
  storage.recordInputActivity(snapshot([bucket(start, 4)]));
  assert.equal(storage.loadAllStats()[0].inputActivity[0].keyPresses, 4);
  storage.recordInputActivity(snapshot([bucket(start, 2)], 'new-opt-in'));
  assert.equal(storage.loadAllStats()[0].inputActivity[0].keyPresses, 6);
});
test('separate local days and failed storage retries preserve exact totals', () => {
  const incoming = snapshot([bucket(at('2026-10-18'), 3), bucket(at('2026-10-19'), 4)]);
  const write = global.localStorage.setItem;
  global.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(storage.recordInputActivity(incoming), false);
  global.localStorage.setItem = write;
  assert(storage.recordInputActivity(incoming));
  assert.deepEqual(storage.loadAllStats().map(day => day.inputActivity[0].keyPresses), [3, 4]);
});
test('normalization admits only bucket time and count fields, rejects malformed events and unknown periods', () => {
  const start = at('2026-10-19');
  assert.deepEqual(normalizeInputActivity([{ ...bucket(start), key: 'secret', application: 'private', x: 10 }], '2026-10-19'), [bucket(start)]);
  assert.deepEqual(normalizeInputActivity([null, bucket(start + 1), bucket(start, -1), { ...bucket(start), clicks: Infinity }, bucket(start, 0.5)], '2026-10-19'), []);
  assert.deepEqual(normalizeInputActivity([bucket(start)], 'invalid'), []);
  assert.equal(storage.recordInputActivity({ ...snapshot([bucket(start)]), status: 'permissionRequired' }), false);
  assert.equal(storage.loadAllStats().length, 0);
});
test('deleting input counts preserves focus, breaks and call history', () => {
  storage.recordInputActivity(snapshot([bucket(at('2026-10-19'))]));
  const raw = JSON.parse(values.get('myeyes_stats_v1'));
  raw[0].focusMinutes = 12; raw[0].breaksCompleted = 2;
  raw[0].meetings = [{ start: at('2026-10-19'), end: at('2026-10-19') + 1000, app: 'Zoom' }];
  values.set('myeyes_stats_v1', JSON.stringify(raw));
  assert(storage.clearInputActivity());
  const saved = storage.loadAllStats()[0];
  assert.equal(saved.inputActivity, undefined); assert.equal(saved.inputActivityCursor, undefined);
  assert.equal(saved.focusMinutes, 12); assert.equal(saved.breaksCompleted, 2); assert.equal(saved.meetings.length, 1);
});
