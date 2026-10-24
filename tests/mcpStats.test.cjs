const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

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

test('malformed saved records do not poison the public projection or mutate history', () => {
  const saved = [day('2020-02-30'), day('0000-01-01'), day('2020-01-06', {
    breaksCompleted: 2.9, exercisesCompleted: 1.9, focusMinutes: 30,
  }), day('2020-01-06', { breaksCompleted: 50, focusMinutes: 999 }),
  day('2020-01-08', { breaksCompleted: -1, exercisesCompleted: Infinity, focusMinutes: NaN })];
  const before = structuredClone(saved), stats = buildMcpStats(saved);
  assert.deepEqual(saved, before, 'Only the MCP projection is normalized');
  assert.deepEqual(stats.days.map(day => day.date), ['2020-01-06', '2020-01-08']);
  assert.equal(stats.days.length, 2);
  assert.equal(stats.days.reduce((total, day) => total + day.focusMinutes, 0), 30);
  assert.equal(stats.days.reduce((total, day) => total + day.breaksCompleted, 0), 2);
  assert.equal(stats.days[0].exercisesCompleted, 1);
  assert.equal(stats.days[1].breaksCompleted, 0);
  assert.equal(stats.days[1].exercisesCompleted, 0);
  assert.equal(stats.days[1].focusMinutes, 0);
  const capped = buildMcpStats([day('2020-01-01', { breaksCompleted: Number.MAX_VALUE })]);
  assert.equal(capped.days[0].breaksCompleted, Number.MAX_SAFE_INTEGER);
  assert.equal(capped.days.length, 1);
});
