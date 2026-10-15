const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');
const { doc } = require('./support/syntheticDom.cjs');
const item = id => ({ id, steps: [] });

test('summary and its descendants preserve Space and KeyR defaults without changing the main timer', async () => {
  const h = createHarness();
  try {
    await h.settle(); await h.advance(5000);
    const summary = doc.createElement('summary'), child = doc.createElement('span'); summary.appendChild(child);
    let prevented = 0;
    for (const target of [summary, child]) for (const code of ['Space', 'KeyR']) {
      await h.emit('keydown', { code, target, preventDefault() { prevented++; } });
      assert.equal(h.captured.TimerWidget.secondsRemaining, 1195);
      assert.equal(h.captured.TimerWidget.isRunning, true);
    }
    assert.equal(prevented, 0, 'browser receives the native summary default action');
    await h.emit('keydown', { code: 'Space', preventDefault() { prevented++; } });
    assert.equal(prevented, 1); assert.equal(h.captured.TimerWidget.isRunning, false, 'background shortcut remains active');
    await h.emit('keydown', { code: 'KeyR', preventDefault() { prevented++; } });
    assert.equal(prevented, 2); assert.equal(h.captured.TimerWidget.secondsRemaining, 1200);
  } finally { h.destroy(); }
});

for (const mode of ['single', 'routine']) test(`${mode} exercise starts from the first idle-return click after a fresh IPC result`, async () => {
  const h = createHarness();
  try {
    await h.settle(); await h.call('Navbar', 'onSelectTab', 'library'); h.setIdle(60); await h.advance(1000);
    assert.equal(h.captured.Navbar.statusTone, 'absence');
    let resolveIdle;
    h.electronAPI.getSystemIdleTime = () => new Promise(resolve => { resolveIdle = resolve; });
    await h.emit('mousedown'); assert(resolveIdle);
    const start = mode === 'single' ? h.captured.ExerciseLibrary.onSelectTechnique(item('first')) : h.captured.ExerciseLibrary.onStartFullRoutine();
    await h.captured.ExerciseLibrary.onSelectTechnique(item('duplicate'));
    await h.settle(); assert.equal(h.active.has('ExercisePlayer'), false);
    h.electronAPI.getSystemIdleTime = async () => 0; resolveIdle(60); await start; await h.settle();
    assert.equal(h.active.has('ExercisePlayer'), true);
    assert.equal(h.captured.ExercisePlayer.technique.id, mode === 'single' ? 'first' : 'donald-korb-blinking');
    assert.equal(h.captured.ExercisePlayer.routine?.length, mode === 'single' ? undefined : 4);
    await h.call('ExercisePlayer', 'onClose'); assert.equal(h.active.has('ExercisePlayer'), false);
  } finally { h.destroy(); }
});

for (const mode of ['single', 'routine']) test(`${mode} exercise refreshes presence after an invalid pre-click query`, async () => {
  const h = createHarness();
  try {
    await h.settle(); await h.call('Navbar', 'onSelectTab', 'library'); h.setIdle(60); await h.advance(1000);
    let resolveOld, freshQueries = 0;
    h.electronAPI.getSystemIdleTime = () => new Promise(resolve => { resolveOld = resolve; });
    await h.emit('mousedown'); assert(resolveOld, 'a pre-click query is in flight');
    const start = mode === 'single' ? h.captured.ExerciseLibrary.onSelectTechnique(item('fresh')) : h.captured.ExerciseLibrary.onStartFullRoutine();
    await h.settle(); assert.equal(h.active.has('ExercisePlayer'), false);
    h.electronAPI.getSystemIdleTime = async () => { freshQueries++; return 0; };
    resolveOld(NaN); await start; await h.settle();
    assert(freshQueries > 0, 'the failed old query cannot consume the requested fresh sample');
    assert.equal(h.active.has('ExercisePlayer'), true);
    assert.equal(h.captured.ExercisePlayer.technique.id, mode === 'single' ? 'fresh' : 'donald-korb-blinking');
  } finally { h.destroy(); }
});

for (const failure of ['idle', 'invalid', 'unmount']) test(`pending exercise start is canceled after ${failure}`, async () => {
  const h = createHarness(); let destroyed = false;
  try {
    await h.settle(); await h.call('Navbar', 'onSelectTab', 'library');
    let resolveIdle;
    h.electronAPI.getSystemIdleTime = () => new Promise(resolve => { resolveIdle = resolve; });
    const start = h.captured.ExerciseLibrary.onSelectTechnique(item('blocked')); await h.settle(); assert(resolveIdle);
    if (failure === 'unmount') { h.destroy(); destroyed = true; }
    resolveIdle(failure === 'idle' ? 60 : failure === 'invalid' ? NaN : 0); await start; await h.settle();
    assert.equal(h.active.has('ExercisePlayer'), false); assert.equal(h.stats().exercisesCompleted, 0);
  } finally { if (!destroyed) h.destroy(); }
});
