const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-activity-'));
const config = path.join(build, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [path.join(repo, 'src/utils/activity.ts'), path.join(repo, 'src/utils/storage.ts')],
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true,
    rootDir: path.join(repo, 'src'), outDir: build } }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { dayBounds, normalizeActivity, analyzeDayActivity, summarizeWeek } = require(path.join(build, 'utils/activity.js'));
const { TimerSession } = require(path.join(build, 'utils/timerSession.js'));
const storage = require(path.join(build, 'utils/storage.js'));
const values = new Map();
global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const day = (date, values = {}) => ({ date, focusMinutes: 0, breaksCompleted: 0, exercisesCompleted: 0, ...values });
const at = (date, hour, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
test.after(() => fs.rmSync(build, { recursive: true, force: true }));

test('old aggregate records retain totals while the timeline remains unknown', () => {
  const date = '2026-10-12';
  const result = analyzeDayActivity(day(date, { focusMinutes: 120 }), at('2026-10-14', 12));
  assert.equal(result.workMinutes, 0);
  assert.equal(result.recordedMinutes, 0);
  assert.equal(result.sessionCount, 0);
  assert.deepEqual(result.segments, [{ ...dayBounds(date), state: 'unknown' }]);
});

test('daily durations, session average and gaps reflect actual intervals', () => {
  const date = '2026-10-12';
  const result = analyzeDayActivity(day(date, { activity: [
    { start: at(date, 9), end: at(date, 10), state: 'work' },
    { start: at(date, 10), end: at(date, 10, 30), state: 'idle' },
    { start: at(date, 10, 30), end: at(date, 11), state: 'work' },
    { start: at(date, 11), end: at(date, 11, 10), state: 'manual' },
    { start: at(date, 11, 10), end: at(date, 11, 15), state: 'break' },
  ] }), at('2026-10-14', 12));
  assert.equal(result.workMinutes, 90); assert.equal(result.awayMinutes, 30);
  assert.equal(result.pauseMinutes, 10); assert.equal(result.restMinutes, 5);
  assert.equal(result.sessionCount, 2); assert.equal(result.averageSessionMinutes, 45);
  assert.equal(result.longestSessionMinutes, 60); assert.equal(result.firstActiveAt, at(date, 9));
  assert.equal(result.recordedMinutes, 135);
});

test('repeated and malformed snapshots cannot double count; midnight splits into local days', () => {
  values.clear();
  const spans = [{ start: at('2026-10-12', 23, 59), end: at('2026-10-13', 0, 1), state: 'work' }];
  storage.recordActivitySpans(spans); storage.recordActivitySpans(spans);
  assert.equal(storage.loadAllStats().length, 2);
  for (const saved of storage.loadAllStats()) assert.equal(analyzeDayActivity(saved, at('2026-10-14', 12)).workMinutes, 1);
  assert.deepEqual(normalizeActivity([null, { start: 1, end: Infinity, state: 'work' }, { start: 1, end: 2, state: 'bad' }], '2026-10-12'), []);
  storage.recordActivitySpans([{ start: at('2026-10-13', 0), end: at('2026-10-13', 0, 2), state: 'work' }]);
  assert.equal(analyzeDayActivity(storage.loadAllStats()[1], at('2026-10-14', 12)).workMinutes, 2);
});

test('calendar and used-day averages include missing days and exclude old days', () => {
  const result = summarizeWeek([day('2026-10-14', { focusMinutes: 120, breaksCompleted: 4 }),
    day('2026-10-12', { focusMinutes: 60, breaksCompleted: 2 }), day('2026-10-13'),
    day('2026-09-01', { focusMinutes: 900 })], '2026-10-14');
  assert.equal(result.usedDays, 2); assert.equal(result.totalFocusMinutes, 180);
  assert.equal(result.averageFocusMinutes, 180 / 7); assert.equal(result.averageFocusMinutesPerUsedDay, 90);
  assert.equal(result.averageBreaks, 6 / 7); assert.equal(result.averageBreaksPerUsedDay, 3);
  assert.equal(summarizeWeek([], '2026-10-14').averageFocusMinutesPerUsedDay, 0);
});

test('today has future shading and no duration is credited ahead of now', () => {
  const date = '2026-10-14', now = at(date, 10);
  const result = analyzeDayActivity(day(date, { activity: [{ start: at(date, 9), end: at(date, 11), state: 'work' }] }), now);
  assert.equal(result.workMinutes, 60);
  assert.deepEqual(result.segments.at(-1), { start: now, end: dayBounds(date).end, state: 'future' });
});

test('spring and autumn DST days use real local day lengths', () => {
  const original = process.env.TZ; process.env.TZ = 'Europe/Madrid';
  try {
    assert.equal((dayBounds('2026-03-29').end - dayBounds('2026-03-29').start) / 3600000, 23);
    assert.equal((dayBounds('2026-10-25').end - dayBounds('2026-10-25').start) / 3600000, 25);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});

test('browser timer logs work, manual pause, absence and uncertain gaps separately', () => {
  const session = new TimerSession(1200, 0);
  session.advance(1000); session.manualPaused = true;
  session.advance(2000); session.setReason('locked', true, 2000);
  session.advance(20000); session.setReason('locked', false, 20000);
  session.advance(30000);
  assert.deepEqual(session.drainActivity().map(span => span.state), ['work', 'manual', 'locked', 'unconfirmed']);
  assert.equal(session.drainFocus().reduce((sum, [, value]) => sum + value, 0), 1);
});
