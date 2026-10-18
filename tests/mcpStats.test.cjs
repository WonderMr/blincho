const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { validStatsArguments, dataRange, queryStats } = require('../electron/mcpStats.cjs');

const repo = path.resolve(__dirname, '..'), build = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-mcp-stats-'));
const config = path.join(build, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [path.join(repo, 'src/utils/mcpStats.ts')],
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true,
    rootDir: path.join(repo, 'src'), outDir: build } }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { buildMcpStats } = require(path.join(build, 'utils/mcpStats.js'));
test.after(() => fs.rmSync(build, { recursive: true, force: true }));
const day = (date, values = {}) => ({ date, breaksCompleted: 0, exercisesCompleted: 0, focusMinutes: 0, ...values });
const at = (date, time) => new Date(`${date}T${time}:00`).getTime();
const history = () => buildMcpStats([
  day('2020-01-01', { focusMinutes: 60 }),
  day('2020-01-06', { focusMinutes: 30, breaksCompleted: 2, activity: [
    { start: at('2020-01-06', '09:00'), end: at('2020-01-06', '10:00'), state: 'work' },
    { start: at('2020-01-06', '10:00'), end: at('2020-01-06', '10:30'), state: 'locked' },
  ] }), day('2020-01-08', { focusMinutes: 45, exercisesCompleted: 1 }),
  day('2020-01-13', { focusMinutes: 15 }),
], at('2020-02-01', '12:00'));

test('projection shares only aggregates and distinguishes old totals from activity coverage', () => {
  const stats = buildMcpStats([day('2020-01-06', { completedEventIds: ['private'], techniqueCounts: { private: 1 },
    meetings: [{ start: 1, end: 2, app: 'private-call' }], activity: [
      { start: at('2020-01-06', '09:00'), end: at('2020-01-06', '11:00'), state: 'work' },
    ] }), day('2020-01-01', { focusMinutes: 90 })], at('2020-01-06', '10:00'));
  assert.equal(stats.days[0].date, '2020-01-01');
  assert.equal(stats.days[0].recordedMinutes, 0);
  assert.equal(stats.days[1].workMinutes, 60, 'Do not credit a span beyond now');
  assert.equal(stats.activityStartDate, '2020-01-06');
  assert.equal(JSON.stringify(stats).includes('private'), false);
  assert.deepEqual(Object.keys(stats.days[1]).sort(), ['date', 'breaksCompleted', 'exercisesCompleted', 'focusMinutes',
    'workMinutes', 'awayMinutes', 'pauseMinutes', 'restMinutes', 'recordedMinutes'].sort());
});

test('range boundaries and daily totals preserve missing dates and zero recorded days', () => {
  const stats = history();
  assert.deepEqual(dataRange(stats), { timeZone: stats.timeZone, dataStartDate: '2020-01-01', dataEndDate: '2020-01-13',
    activityStartDate: '2020-01-06', recordedDays: 4 });
  const result = queryStats(stats, { startDate: '2020-01-02', endDate: '2020-01-12' });
  assert.equal(result.calendarDays, 11); assert.equal(result.recordedDays, 2);
  assert.equal(result.totals.focusMinutes, 75); assert.equal(result.totals.workMinutes, 60);
  assert.equal(result.totals.awayMinutes, 30);
  assert.deepEqual(result.periods.map(period => period.startDate), ['2020-01-06', '2020-01-08']);
  assert.equal(queryStats(stats, { startDate: '2020-01-08', endDate: '2020-01-08' }).totals.focusMinutes, 45);
  assert.equal(queryStats(stats, { startDate: '2020-01-02', endDate: '2020-01-02' }).recordedDays, 0);
});

test('Monday weeks clip requested bounds and totals cover every page', () => {
  const result = queryStats(history(), { startDate: '2020-01-01', endDate: '2020-01-13', groupBy: 'week', limit: 1, offset: 1 });
  assert.equal(result.totals.focusMinutes, 150); assert.equal(result.totalPeriods, 3);
  assert.equal(result.hasMore, true); assert.equal(result.recordedDays, 4);
  assert.deepEqual(result.periods.map(period => [period.startDate, period.endDate, period.calendarDays, period.recordedDays]),
    [['2020-01-06', '2020-01-12', 7, 2]]);
  const last = queryStats(history(), { groupBy: 'week', offset: 2 });
  assert.equal(last.periods[0].endDate, '2020-01-13'); assert.equal(last.hasMore, false);
  assert.deepEqual(queryStats(history(), { offset: 999 }).periods, []);
});

test('empty history reports unknown boundaries; explicit ranges still count calendar days', () => {
  const stats = buildMcpStats([]);
  const empty = queryStats(stats, {});
  assert.equal(empty.dataStartDate, null); assert.equal(empty.activityStartDate, null);
  assert.equal(empty.startDate, null); assert.equal(empty.calendarDays, 0);
  assert.deepEqual(empty.periods, []); assert.equal(empty.totals.focusMinutes, 0);
  assert.equal(queryStats(stats, { startDate: '2024-02-28', endDate: '2024-03-01' }).calendarDays, 3);
  assert.equal(queryStats(stats, { startDate: '2024-02-29' }).calendarDays, 1);
  assert.equal(queryStats(stats, { endDate: '2024-02-29' }).calendarDays, 1);
});

test('strict arguments reject impossible dates, inversions, unknown keys and unsafe pagination', () => {
  for (const args of [null, [], { startDate: '2023-02-29' }, { endDate: '2026-02-30' }, { startDate: '0000-01-01' },
    { startDate: '2026-10-1' }, { startDate: 1 }, { groupBy: 'month' }, { limit: 0 }, { limit: 367 },
    { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { command: 'read' },
    { startDate: '2026-02-02', endDate: '2026-02-01' }]) assert.equal(validStatsArguments(args), false, JSON.stringify(args));
  for (const args of [{}, { startDate: '0001-01-01', endDate: '9999-12-31' }, { startDate: '2024-02-29', limit: 366 }])
    assert.equal(validStatsArguments(args), true);
  assert.equal(queryStats(history(), { startDate: '2021-01-01' }).invalidArguments, true);
});

test('date grouping handles year boundaries and DST using calendar dates', () => {
  const stats = buildMcpStats([day('2020-12-31', { focusMinutes: 1 }), day('2021-01-01', { focusMinutes: 2 }),
    day('2021-01-04', { focusMinutes: 4 })]);
  const result = queryStats(stats, { groupBy: 'week' });
  assert.equal(result.totalPeriods, 2); assert.equal(result.periods[0].totals.focusMinutes, 3);
  assert.equal(queryStats(history(), { startDate: '2026-03-28', endDate: '2026-03-30' }).calendarDays, 3);
  const edges = buildMcpStats([day('0001-01-01'), day('9999-12-31')]);
  const periods = queryStats(edges, { groupBy: 'week' }).periods;
  assert.equal(periods[0].startDate, '0001-01-01'); assert.equal(periods.at(-1).endDate, '9999-12-31');
});

test('malformed snapshot is unavailable instead of silently losing saved history', () => {
  for (const stats of [undefined, {}, { ...history(), activityStartDate: '2019-01-01' },
    { ...history(), private: 'secret' },
    { ...history(), days: [{ ...history().days[0], private: 'secret' }] },
    { ...history(), days: [history().days[0], history().days[0]] },
    { ...history(), days: [{ ...history().days[0], focusMinutes: Infinity }] }]) assert.equal(dataRange(stats), null);
});

test('overflowing aggregates fail explicitly instead of returning rounded counters or null minutes', () => {
  for (const values of [{ focusMinutes: Number.MAX_VALUE }, { breaksCompleted: Number.MAX_SAFE_INTEGER }]) {
    const stats = buildMcpStats([day('2020-01-01', values), day('2020-01-02', values)]);
    assert.equal(dataRange(stats)?.recordedDays, 2);
    assert.equal(typeof queryStats(stats, {}).error, 'string');
  }
});


test('malformed saved records do not poison the public projection or mutate history', () => {
  const saved = [day('2020-02-30'), day('0000-01-01'), day('2020-01-06', {
    breaksCompleted: 2.9, exercisesCompleted: 1.9, focusMinutes: 30,
  }), day('2020-01-06', { breaksCompleted: 50, focusMinutes: 999 }),
  day('2020-01-08', { breaksCompleted: -1, exercisesCompleted: Infinity, focusMinutes: NaN })];
  const before = structuredClone(saved), stats = buildMcpStats(saved);
  assert.deepEqual(saved, before, 'Only the MCP projection is normalized');
  assert.deepEqual(stats.days.map(day => day.date), ['2020-01-06', '2020-01-08']);
  assert.equal(dataRange(stats).recordedDays, 2);
  assert.equal(queryStats(stats, {}).totals.focusMinutes, 30);
  assert.equal(queryStats(stats, {}).totals.breaksCompleted, 2);
  assert.equal(stats.days[0].exercisesCompleted, 1);
  assert.equal(stats.days[1].breaksCompleted, 0);
  assert.equal(stats.days[1].exercisesCompleted, 0);
  assert.equal(stats.days[1].focusMinutes, 0);
  const capped = buildMcpStats([day('2020-01-01', { breaksCompleted: Number.MAX_VALUE })]);
  assert.equal(capped.days[0].breaksCompleted, Number.MAX_SAFE_INTEGER);
  assert.notEqual(dataRange(capped), null);
});
