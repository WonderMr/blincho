const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'myeyes-timers-'));
const config = path.join(buildDirectory, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({
  files: ['src/utils/timerSession.ts', 'src/utils/storage.ts', 'src/utils/notifications.ts'].map(file => path.join(repository, file)),
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    skipLibCheck: true, rootDir: path.join(repository, 'src'), outDir: buildDirectory },
}));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { TimerSession, presetDurations, normalizeTimerSettings } = require(path.join(buildDirectory, 'utils/timerSession.js'));
const storage = require(path.join(buildDirectory, 'utils/storage.js'));
const saved = new Map();
global.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };

const session = new TimerSession(1200, 0);
session.setReason('idle', false, 500);
assert.equal(session.lastUpdated, 0, 'an unchanged pause reason must not discard elapsed time');
session.advance(1000);
assert.equal(session.remainingMs, 1199000);
session.manualPaused = true;
session.setReason('locked', true, 1000);
session.setReason('suspended', true, 1000);
session.setReason('suspended', false, 200000);
assert.equal(session.present, false, 'resume must not clear lock');
session.setReason('locked', false, 200000);
assert.equal(session.counting, false, 'unlock must preserve manual pause');
session.restart(1200, 200000);
assert.equal(session.manualPaused, true);
session.manualPaused = false;
session.postpone(300, 200000);
session.advance(201000);
assert.equal(session.remainingMs, 299000);
assert.equal(session.drainFocus().reduce((sum, [, value]) => sum + value, 0), 2);

const absent = new TimerSession(1200, 0);
absent.setReason('idle', true, 1000, -840000);
absent.advance(30000);
assert.equal(absent.remainingMs, 1200000);
assert.deepEqual(absent.drainFocus(), []);
const delayed = new TimerSession(1200, 0);
delayed.advance(200000);
assert.equal(delayed.remainingMs, 1200000, 'a heartbeat gap cannot earn focus');
const expiry = new TimerSession(1, 0);
assert.equal(expiry.advance(1000), true);
assert.equal(expiry.advance(2000), false, 'expiry is claimed once');
expiry.setReason('locked', true, 2000);
expiry.setReason('locked', false, 3000);
assert.equal(expiry.advance(4000), true, 'an interrupted expiry can be claimed after actual return');
const midnight = new Date(2026, 9, 12, 0, 0, 0).getTime();
const daily = new TimerSession(10, midnight - 1000);
daily.advance(midnight + 1000);
assert.deepEqual(daily.drainFocus(), [['2026-10-11', 1], ['2026-10-12', 1]]);
const valid = normalizeTimerSettings({ ...storage.DEFAULT_SETTINGS, timerPreset: 'unknown', workMinutes: NaN, breakSeconds: -10, idleThresholdMinutes: -5, soundVolume: 1000 });
assert.equal(valid.timerPreset, '20-20-20');
assert.equal(valid.workMinutes, 20);
assert.equal(valid.breakSeconds, 20);
assert.equal(valid.idleThresholdMinutes, 1);
assert.equal(valid.soundVolume, 80);
assert.deepEqual(presetDurations('pomodoro', 20, 20), { workSeconds: 1500, breakSeconds: 300 });
assert.deepEqual(presetDurations('20-20-20', 30, 300), { workSeconds: 1200, breakSeconds: 20 });

storage.recordFocusSeconds(5);
storage.recordBreakCompleted(0, 'break-once');
storage.recordBreakCompleted(0, 'break-once');
storage.recordExerciseCompleted('donald-korb-blinking', 'exercise-once');
storage.recordExerciseCompleted('donald-korb-blinking', 'exercise-once');
assert.equal(storage.loadTodayStats().breaksCompleted, 1);
assert.equal(storage.loadTodayStats().exercisesCompleted, 1);
assert.equal(storage.loadTodayStats().techniqueCounts['donald-korb-blinking'], 1);
assert.equal(storage.loadTodayStats().focusMinutes, 5 / 60, 'instant breaks do not credit planned work minutes');
for (let day = 1; day <= 35; day++) {
  const date = new Date(2026, 7, day);
  storage.recordFocusSeconds(60, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
}
assert.equal(storage.loadAllStats().length, 36, 'history must not truncate a streak after 30 days');
saved.set('myeyes_cvs_result_v1', JSON.stringify({ score: 9, date: '2026-10-11', maxScore: 18, level: 'high', title: 'Old diagnostic label', recommendations: [] }));
assert.equal(storage.loadCVSResult().level, 'self-check');
assert.equal(storage.loadCVSResult().score, 9);
assert.equal(storage.loadCVSResult().title, 'Самопроверка симптомов');
saved.set('myeyes_cvs_result_v1', JSON.stringify({ score: 9, date: '2026-10-11', maxScore: 18, level: 'self-check', title: 'Самопроверка симптомов', recommendations: ['Current neutral guidance'] }));
assert.deepEqual(storage.loadCVSResult().recommendations, ['Current neutral guidance']);
const notifications = require(path.join(buildDirectory, 'utils/notifications.js'));
global.window = { electronAPI: { showNotification() { throw new Error('notification IPC failed'); }, flashWindow() { throw new Error('flash IPC failed'); } } };
const originalWarn = console.warn;
let notificationWarnings = 0;
console.warn = () => { notificationWarnings += 1; };
try {
  assert.doesNotThrow(() => notifications.showEyeBreakNotification('Break', 'Rest'));
  assert.equal(notificationWarnings, 2, 'each failed notification command is reported independently');
} finally { console.warn = originalWarn; }
console.log('Passed timer/session regressions and idempotent daily statistics.');
