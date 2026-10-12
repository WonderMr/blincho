const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-storage-performance-'));
const config = path.join(directory, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({
  files: [path.join(repository, 'src/utils/storage.ts')],
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    skipLibCheck: true, rootDir: path.join(repository, 'src'), outDir: directory },
}));
try {
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
  const storage = require(path.join(directory, 'utils/storage.js'));
  const today = storage.getTodayDateString();
  const previous = '2025-01-01';
  const makeDay = (date, eventIds = []) => ({ date, breaksCompleted: 1, exercisesCompleted: 0, focusMinutes: 2, techniqueCounts: {}, completedEventIds: eventIds });
  const values = new Map([['myeyes_stats_v1', JSON.stringify([makeDay(today), makeDay(previous, ['old-event'])])]]);
  let reads = 0;
  global.localStorage = {
    getItem(key) { if (key === 'myeyes_stats_v1') reads++; return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };

  const snapshot = storage.loadAllStats();
  reads = 0;
  assert.equal(storage.loadTodayStats(snapshot).date, today);
  assert.equal(reads, 0, 'one existing snapshot serves today and history without another storage read');
  storage.recordBreakCompleted(0, 'old-event');
  assert.equal(reads, 1, 'cross-day idempotence uses the update snapshot');
  assert.equal(storage.loadTodayStats().breaksCompleted, 1, 'a historical event cannot be credited on a new day');

  reads = 0;
  storage.recordExerciseCompleted('donald-korb-blinking', 'new-event');
  assert.equal(reads, 1, 'new exercise completion reads history once');
  const saved = JSON.parse(values.get('myeyes_stats_v1'));
  assert.deepEqual(saved.map(day => day.date), [previous, today], 'existing unsorted persisted history is sorted');
  assert.equal(saved[1].exercisesCompleted, 1);
  assert.equal(saved[1].techniqueCounts['donald-korb-blinking'], 1);
  storage.recordExerciseCompleted('donald-korb-blinking', 'new-event');
  assert.equal(storage.loadTodayStats().exercisesCompleted, 1, 'replayed completion stays idempotent');

  storage.recordFocusSeconds(30, '2024-12-31');
  assert.deepEqual(storage.loadAllStats().map(day => day.date), ['2024-12-31', previous, today], 'inserting an older day preserves ascending history order');
  assert.equal(storage.loadAllStats()[0].focusMinutes, 0.5);
  console.log('Passed shared statistics snapshot, single-read credit, cross-day idempotence and history ordering regressions.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
