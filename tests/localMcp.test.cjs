const test = require('node:test');
const assert = require('node:assert/strict');

test('MCP app bridge preserves work deadline and routes commands through normal app controls', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness(); let enabled = false, queued = [], latest, configurations = [];
  const command = name => ({ name, timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId });
  h.desktopAPI.configureLocalMcp = async flag => { configurations.push(flag); enabled = flag; return { enabled, running: enabled }; };
  h.desktopAPI.publishLocalMcp = async value => { latest = value; };
  h.desktopAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
  try {
    await h.settle(); await h.advance(10000); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
    assert.equal(h.captured.TimerWidget.secondsRemaining, 1190); assert.equal(enabled, true);
    queued = [command('pause_timer'), command('pause_timer')]; await h.advance(1000);
    assert.equal(h.captured.TimerWidget.phase, 'manual', 'repeated pause is idempotent');
    queued = [command('resume_timer')]; await h.advance(1000); assert.equal(h.captured.TimerWidget.phase, 'work');
    queued = [command('start_break')]; await h.advance(1000); assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(latest.todayStats.meetings, undefined); assert.equal(latest.todayStats.activity, undefined);
    assert(latest.stats.days.length > 0);
    assert(latest.stats.days.every(day => day.activity === undefined && day.meetings === undefined && day.completedEventIds === undefined));
    queued = [command('skip_break')]; await h.advance(1000); assert.equal(h.active.has('BreakOverlay'), false);
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: false });
    assert.equal(enabled, false); assert.equal(configurations.at(-1), false);
  } finally { h.destroy(); }
});

test('MCP app bridge cannot skip strict breaks or act after disabling', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness({ strictMode: true }); let queued = [], latest;
  const command = name => ({ name, timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId });
  h.desktopAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.desktopAPI.publishLocalMcp = async value => { latest = value; };
  h.desktopAPI.takeLocalMcpCommands = async () => { const result = queued; queued = []; return result; };
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
    queued = [command('start_break')]; await h.advance(1000);
    queued = [command('skip_break'), command('pause_timer')]; await h.advance(1000);
    assert.equal(h.active.has('BreakOverlay'), true); assert.equal(h.captured.TimerWidget.phase, 'break');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: false });
    queued = [command('skip_break')]; await h.advance(1000); assert.equal(h.active.has('BreakOverlay'), true);
  } finally { h.destroy(); }
});

test('disabling MCP cancels a drained action awaiting presence, including rapid re-enable', async () => {
  const { createHarness } = require('./app.test.cjs');
  for (const reenable of [false, true]) {
    const h = createHarness(); let queued = [], latest, resolvePresence, pending = true;
    h.desktopAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
    h.desktopAPI.publishLocalMcp = async value => { latest = value; };
    h.desktopAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
    try {
      await h.settle(); await h.call('Navbar', 'onOpenSettings');
      await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
      const presence = new Promise(resolve => { resolvePresence = resolve; });
      h.desktopAPI.getSystemIdleTime = () => pending ? presence : Promise.resolve(0);
      queued = [{ name: 'pause_timer', timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId }];
      await h.advance(500); assert.equal(queued.length, 0, 'command is already drained');
      await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: false });
      if (reenable) await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
      pending = false; resolvePresence(0); await h.settle();
      assert.equal(h.captured.TimerWidget.phase, 'work', 'revoked command cannot pause after delayed presence resolves');
    } finally { pending = false; resolvePresence?.(0); h.destroy(); }
  }
});

test('a queued skip cannot close a replacement break', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness(); let queued = [], latest;
  h.desktopAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.desktopAPI.publishLocalMcp = async value => { latest = value; };
  h.desktopAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
    await h.call('TimerWidget', 'onTriggerInstantBreak'); await h.advance(500);
    queued = [{ name: 'skip_break', timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId }];
    await h.call('BreakOverlay', 'onClose'); await h.call('TimerWidget', 'onTriggerInstantBreak');
    assert.equal(h.active.has('BreakOverlay'), true);
    await h.advance(500); assert.equal(h.active.has('BreakOverlay'), true, 'replacement owns a different event and version');
  } finally { h.destroy(); }
});

test('MCP actions cannot cancel a pending end-of-break camera decision', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness({ cameraLockEnabled: true }); let queued = [], latest, resolveCamera, cameraSignal;
  h.desktopAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.desktopAPI.publishLocalMcp = async value => { latest = value; };
  h.desktopAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
  h.desktopAPI.lockComputer = async () => false;
  h.setCameraCheck(signal => { cameraSignal = signal; return new Promise(resolve => { resolveCamera = resolve; }); });
  try {
    await h.settle(); await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    h.setIdle(20); await h.advance(20000); await h.call('BreakOverlay', 'onElapsed', h.monotonicNow); await h.advance(500);
    assert.equal(latest.status.cameraChecking, true);
    queued = ['pause_timer', 'resume_timer', 'start_break', 'skip_break'].map(name => ({ name, timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId }));
    await h.advance(500);
    assert.equal(cameraSignal.aborted, false); assert.equal(h.captured.TimerWidget.phase, 'work');
    assert.equal(h.active.has('BreakOverlay'), false);
    resolveCamera('present'); await h.settle();
  } finally { resolveCamera?.('unavailable'); h.destroy(); }
});
