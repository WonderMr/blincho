const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLocalMcp } = require('../electron/localMcp.cjs');

const snapshot = (status = {}) => ({ status: { isRunning: true, isBreakActive: false, strictMode: false,
  breakElapsed: false, isIdlePaused: false, exercising: false, timerVersion: 1, breakEventId: null, ...status }, settings: { localMcpEnabled: true },
  todayStats: { date: '2026-10-16', breaksCompleted: 2, exercisesCompleted: 1, focusMinutes: 30 } });
function request(state, message, headers = {}, method = 'POST', raw) {
  return new Promise((resolve, reject) => {
    const req = http.request(state.url, { method, headers: { Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const body = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null }); });
    });
    req.on('error', reject); req.end(raw ?? JSON.stringify(message));
  });
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const call = name => rpc('tools/call', { name, arguments: {} });

test('local MCP is off by default, initializes and lists only bounded app tools', async () => {
  const server = createLocalMcp({ preferredPort: 0 });
  try {
    assert.equal(server.state().enabled, false); assert.equal(server.state().token, null);
    const state = await server.configure(true);
    assert.equal(state.running, true); assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/); assert.equal(state.token.length, 64);
    const initialized = await request(state, rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    assert.equal(initialized.status, 200); assert.equal(initialized.body.result.protocolVersion, '2025-11-25');
    assert.deepEqual(initialized.body.result.capabilities, { tools: {} });
    assert.equal((await request(state, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = (await request(state, rpc('tools/list'))).body.result.tools;
    assert.deepEqual(list.map(tool => tool.name), ['get_status', 'get_settings', 'get_today_stats', 'get_data_range', 'get_stats', 'start_break', 'pause_timer', 'resume_timer', 'skip_break']);
    assert(list.every(tool => tool.inputSchema.additionalProperties === false));
    server.publish(snapshot());
    const stats = (await request(state, call('get_today_stats'))).body.result;
    assert.deepEqual(JSON.parse(stats.content[0].text), snapshot().todayStats);
    assert.equal((await request(state, rpc('ping'))).body.result.constructor, Object);
  } finally { await server.shutdown(); }
});

test('auth, origin, host, protocol and HTTP boundaries reject unwanted access', async () => {
  const server = createLocalMcp({ preferredPort: 0 });
  try {
    const state = await server.configure(true);
    for (const [headers, status] of [
      [{ Authorization: '' }, 401], [{ Authorization: 'Bearer wrong' }, 401], [{ Origin: 'https://example.com' }, 403],
      [{ Origin: 'null' }, 403], [{ Host: 'attacker.example' }, 403], [{ 'MCP-Protocol-Version': 'future' }, 400],
      [{ 'Content-Type': 'text/plain' }, 415],
    ]) assert.equal((await request(state, rpc('ping'), headers)).status, status);
    assert.equal((await request(state, rpc('ping'), {}, 'GET')).status, 405);
    assert.equal((await request(state, rpc('ping'), {}, 'DELETE')).status, 405);
    assert.equal((await request(state, null, {}, 'POST', '{invalid')).body.error.code, -32700);
    assert.equal((await request(state, [rpc('ping')])).body.error.code, -32600);
    assert.equal((await request(state, rpc('unsupported'))).body.error.code, -32601);
    assert.equal((await request(state, call('toString'))).body.error.code, -32602);
    assert.equal((await request(state, rpc('tools/call', { name: 'start_break', arguments: { shell: 'command' } }))).body.error.code, -32602);
    const huge = await request(state, null, {}, 'POST', JSON.stringify({ padding: 'x'.repeat(70000) }));
    assert.equal(huge.status, 413);
  } finally { await server.shutdown(); }
});

test('historical MCP tools validate range arguments, paginate aggregates and keep large histories available', async () => {
  let now = 1000;
  const server = createLocalMcp({ preferredPort: 0, now: () => now });
  const days = Array.from({ length: 1000 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
    breaksCompleted: 1, exercisesCompleted: 0, focusMinutes: 30, workMinutes: 20,
    awayMinutes: 5, pauseMinutes: 0, restMinutes: 1, recordedMinutes: 26 }));
  const value = { ...snapshot(), stats: { timeZone: 'Europe/Madrid', activityStartDate: days[20].date, days } };
  const read = async (state, name, args = {}) => (await request(state, rpc('tools/call', { name, arguments: args }))).body;
  try {
    const state = await server.configure(true);
    assert.equal((await read(state, 'get_stats')).result.isError, true);
    server.publish(snapshot());
    assert.equal((await read(state, 'get_data_range')).result.isError, true, 'Missing aggregate history is unavailable');
    assert(Buffer.byteLength(JSON.stringify(value)) > 32768);
    server.publish(value);
    const range = JSON.parse((await read(state, 'get_data_range')).result.content[0].text);
    assert.equal(range.dataStartDate, '2020-01-01'); assert.equal(range.recordedDays, 1000);
    assert.equal(range.activityStartDate, days[20].date);
    const result = JSON.parse((await read(state, 'get_stats', { startDate: '2020-01-01', endDate: '2020-01-14', groupBy: 'week', limit: 1 })).result.content[0].text);
    assert.equal(result.totals.focusMinutes, 420); assert.equal(result.recordedDays, 14);
    assert.equal(result.totalPeriods, 3); assert.equal(result.hasMore, true);
    assert.equal(result.periods[0].endDate, '2020-01-05');
    for (const args of [null, { startDate: '2020-02-30' }, { groupBy: 'month' }, { limit: 0 },
      { startDate: '2021-01-02', endDate: '2020-01-01' }, { startDate: '2029-01-01' }, { activity: true }])
      assert.equal((await read(state, 'get_stats', args)).error.code, -32602);
    assert.equal((await read(state, 'get_data_range', { startDate: '2020-01-01' })).error.code, -32602);
    assert.equal(server.takeCommands().length, 0);
    assert.equal((await read(state, 'get_status')).result.isError, undefined, 'Large history must not stop timer snapshots');
    now += 10001;
    assert.equal((await read(state, 'get_stats')).result.isError, true);
    assert.equal((await read(state, 'get_data_range')).result.isError, true);
  } finally { await server.shutdown(); }
});

test('commands are queued with freshness and strict mode, presence and camera gates', async () => {
  let now = 1000; const server = createLocalMcp({ preferredPort: 0, now: () => now });
  try {
    const state = await server.configure(true);
    assert.equal((await request(state, call('pause_timer'))).body.result.isError, true);
    server.publish(snapshot());
    const result = (await request(state, call('pause_timer'))).body.result;
    assert.equal(JSON.parse(result.content[0].text).queued, true);
    assert.deepEqual(server.takeCommands(), [{ name: 'pause_timer', timerVersion: 1, breakEventId: null }]); assert.deepEqual(server.takeCommands(), []);
    for (const status of [{ isIdlePaused: true }, { exercising: true }, { isBreakActive: true }]) {
      server.publish(snapshot(status)); assert.equal((await request(state, call('start_break'))).body.result.isError, true);
    }
    for (const status of [{ isBreakActive: false }, { isBreakActive: true, strictMode: true }, { isBreakActive: true, cameraChecking: true }]) {
      server.publish(snapshot(status)); assert.equal((await request(state, call('skip_break'))).body.result.isError, true);
    }
    server.publish(snapshot({ isBreakActive: true }));
    assert.equal((await request(state, call('skip_break'))).body.result.isError, undefined);
    now += 5001; assert.deepEqual(server.takeCommands(), []);
    now += 5000; assert.equal((await request(state, call('resume_timer'))).body.result.isError, true);
    server.publish(snapshot());
    server.publish(snapshot({ cameraChecking: true }));
    for (const name of ['start_break', 'pause_timer', 'resume_timer', 'skip_break']) {
      assert.equal((await request(state, call(name))).body.result.isError, true);
    }
    server.publish(snapshot());
    for (let i = 0; i < 16; i++) assert.equal((await request(state, call('pause_timer'))).body.result.isError, undefined);
    assert.equal((await request(state, call('pause_timer'))).body.result.isError, true);
  } finally { await server.shutdown(); }
});

test('disable closes listener, discards commands, revokes token, and rapid changes keep last intent', async () => {
  const server = createLocalMcp({ preferredPort: 0 });
  try {
    const first = await server.configure(true); server.publish(snapshot()); await request(first, call('start_break'));
    const stopped = await server.configure(false);
    assert.equal(stopped.running, false); assert.equal(stopped.url, null); assert.equal(stopped.token, null);
    assert.deepEqual(server.takeCommands(), []);
    await assert.rejects(request(first, rpc('ping')), /ECONNREFUSED|socket hang up/);
    const second = await server.configure(true); assert.notEqual(second.token, first.token);
    assert.equal((await request({ ...second, token: first.token }, rpc('ping'))).status, 401);
    await Promise.all([server.configure(false), server.configure(true), server.configure(false)]);
    assert.equal(server.state().running, false); assert.equal(server.state().enabled, false);
  } finally { await server.shutdown(); }
});

test('MCP app bridge preserves work deadline and routes commands through normal app controls', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness(); let enabled = false, queued = [], latest, configurations = [];
  const command = name => ({ name, timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId });
  h.electronAPI.configureLocalMcp = async flag => { configurations.push(flag); enabled = flag; return { enabled, running: enabled }; };
  h.electronAPI.publishLocalMcp = async value => { latest = value; };
  h.electronAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
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

test('rapid disable and re-enable rotates the token without reviving a revoked listener', async () => {
  const server = createLocalMcp({ preferredPort: 0 });
  try {
    const first = await server.configure(true);
    await Promise.all([server.configure(false), server.configure(true)]);
    const current = server.state();
    assert.equal(current.running, true);
    assert.equal(current.token?.length, 64);
    assert.notEqual(current.token, first.token);
    assert.equal((await request({ ...current, token: first.token }, rpc('ping'))).status, 401);
    assert.equal((await request({ ...current, token: '' }, rpc('ping'))).status, 401);
    assert.equal((await request(current, rpc('ping'))).status, 200);
  } finally { await server.shutdown(); }
});

test('MCP app bridge cannot skip strict breaks or act after disabling', async () => {
  const { createHarness } = require('./app.test.cjs');
  const h = createHarness({ strictMode: true }); let queued = [], latest;
  const command = name => ({ name, timerVersion: latest.status.timerVersion, breakEventId: latest.status.breakEventId });
  h.electronAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.electronAPI.publishLocalMcp = async value => { latest = value; };
  h.electronAPI.takeLocalMcpCommands = async () => { const result = queued; queued = []; return result; };
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
    h.electronAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
    h.electronAPI.publishLocalMcp = async value => { latest = value; };
    h.electronAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
    try {
      await h.settle(); await h.call('Navbar', 'onOpenSettings');
      await h.call('SettingsModal', 'onUpdateSettings', { ...h.captured.SettingsModal.settings, localMcpEnabled: true });
      const presence = new Promise(resolve => { resolvePresence = resolve; });
      h.electronAPI.getSystemIdleTime = () => pending ? presence : Promise.resolve(0);
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
  h.electronAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.electronAPI.publishLocalMcp = async value => { latest = value; };
  h.electronAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
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
  h.electronAPI.configureLocalMcp = async enabled => ({ enabled, running: enabled });
  h.electronAPI.publishLocalMcp = async value => { latest = value; };
  h.electronAPI.takeLocalMcpCommands = async () => { const next = queued; queued = []; return next; };
  h.electronAPI.lockComputer = async () => false;
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
