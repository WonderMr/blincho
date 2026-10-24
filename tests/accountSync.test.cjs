const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createProtocolServer } = require('./support/syncProtocolServer.cjs');
// Operators with the private backend checked out can also run the same client
// suite against its real factory by supplying an absolute server.cjs path.
const createSyncServer = process.env.BLINCHO_BACKEND_SOURCE
  ? require(path.resolve(process.env.BLINCHO_BACKEND_SOURCE)).createSyncServer : createProtocolServer;

const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const build = fs.mkdtempSync(path.join(cache, 'sync-client-test-'));
const config = path.join(build, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [path.join(root, 'src/utils/accountSync.ts'), path.join(root, 'src/utils/storage.ts')],
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, esModuleInterop: true, rootDir: path.join(root, 'src'), outDir: build } }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-p', config], { stdio: 'inherit' });
const { AccountSyncSession, validateSharedBreak } = require(path.join(build, 'utils/accountSync.js'));
const { generateRecoveryKey, deriveSyncKey, encryptSync, decryptSync } = require(path.join(build, 'utils/syncCrypto.js'));
const { applySyncSettings, mergeSyncStats, projectSyncSettings } = require(path.join(build, 'utils/syncData.js'));
const { DEFAULT_SETTINGS, loadSettings } = require(path.join(build, 'utils/storage.js'));
process.on('exit', () => fs.rmSync(build, { recursive: true, force: true }));
const invitation = 'test-registration-code-for-local-only';
const password = 'test password for account sync';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = performance.now() + 7000;
  while (!check()) { assert(performance.now() < end, 'condition timed out'); await sleep(30); }
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear(), key: i => [...values.keys()][i] ?? null, get length() { return values.size; } };
}
function device(url, store, settings = {}, stats = []) {
  const state = { settings: { ...DEFAULT_SETTINGS, ...settings }, stats, remote: [], breaks: [], statuses: [], applied: 0 };
  const requests = [];
  const client = new AccountSyncSession({ snapshot: () => ({ settings: state.settings, stats: state.stats }),
    settings: value => { state.settings = applySyncSettings(state.settings, value); state.applied++; },
    stats: values => { state.remote = values; }, break: event => { state.breaks.push({ event, at: Date.now() }); }, status: value => state.statuses.push(value),
  }, store, url, async (input, init) => { requests.push({ input, body: init?.body }); return fetch(input, init); });
  return { client, state, requests };
}

test('sync is default off and malformed stored preferences cannot opt in', () => {
  const previous = global.localStorage; global.localStorage = storage();
  try {
    assert.equal(loadSettings().syncEnabled, false);
    for (const value of [null, 1, 'true', {}, []]) {
      global.localStorage.setItem('myeyes_settings_v1', JSON.stringify({ syncEnabled: value }));
      assert.equal(loadSettings().syncEnabled, false);
    }
  } finally { global.localStorage = previous; }
});

test('both document and Tauri CSP permit only the intended sync service', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const nativePolicy = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).app.security.csp;
  for (const csp of [policy, nativePolicy]) {
    const sources = csp.split(';').map(directive => directive.trim()).find(directive => directive.startsWith('connect-src ')).split(/\s+/).slice(1);
    assert(sources.includes('https://back.blincho.app'));
    assert(!sources.includes('*') && !sources.includes('https:') && !sources.includes('http:'));
  }
});

test('break messages reject stale, malformed, future and excessive locks', () => {
  const now = Date.now();
  const event = { v: 1, id: 'a'.repeat(32), deviceId: 'b'.repeat(32), createdAt: now, startAt: now + 2500, endAt: now + 22_500 };
  assert.deepEqual(validateSharedBreak(event, now), event);
  for (const patch of [{ endAt: now }, { startAt: now + 6000 }, { endAt: now + 1_900_000 }, { createdAt: now - 700000 }, { id: '../lock' }, { extra: 1 }, { startAt: NaN }]) {
    assert.throws(() => validateSharedBreak({ ...event, ...patch }, now));
  }
});

test('a successful but expired relay acknowledgement rejects so App can fall back locally', async () => {
  const accountId = 'c'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  const originalNow = Date.now;
  let now = originalNow(), callbacks = 0;
  const client = new AccountSyncSession({ snapshot: () => ({ settings: DEFAULT_SETTINGS, stats: [] }), settings() {}, stats() {},
    break() { callbacks++; }, status() {} }, storage(), 'http://127.0.0.1:47832', async (url, init) => {
      let payload = {};
      if (url.endsWith('/v1/login')) payload = { accountId, token: 'a'.repeat(43), keyCheck };
      else if (url.endsWith('/v1/state')) payload = { documents: [] };
      else if (init.method === 'PUT') payload = { revision: 1 };
      else if (url.includes('/v1/events?')) payload = { instance: 'test', events: [], cursor: 0 };
      else if (url.endsWith('/v1/events')) { now += 4000; payload = { seq: 1 }; }
      return new Response(JSON.stringify(payload), { status: 200 });
    });
  try {
    Date.now = () => now;
    await client.connect('login', 'owner@example.test', password, secret, '');
    await assert.rejects(() => client.publishBreak(1), /delivery expired/);
    assert.equal(callbacks, 0);
  } finally { client.close(); Date.now = originalNow; }
});

test('two account devices converge encrypted settings and snapshots, schedule one shared break, and retain local consent', async () => {
  const server = createSyncServer({ registrationCode: invitation, limits: { authEmailRate: 100, authIpRate: 100 } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const secret = generateRecoveryKey();
  const localA = [{ date: '2026-10-20', breaksCompleted: 2, exercisesCompleted: 1, focusMinutes: 5, techniqueCounts: {}, meetings: [{ start: 1, end: 2, app: 'private' }] }];
  const localB = [{ date: '2026-10-20', breaksCompleted: 1, exercisesCompleted: 0, focusMinutes: 3, techniqueCounts: {} }];
  const aStore = storage(), bStore = storage();
  const a = device(url, aStore, { colorPalette: 'ocean' }, localA);
  const b = device(url, bStore, { cameraLockEnabled: true, strictMode: true, meetingHistoryEnabled: true }, localB);
  const clients = [a.client, b.client];
  let token;
  try {
    await a.client.connect('register', 'owner@example.test', password, secret, invitation);
    await a.client.tick();
    await b.client.connect('login', 'owner@example.test', password, secret, '');
    await until(() => b.state.settings.colorPalette === 'ocean');
    assert.equal(b.state.settings.cameraLockEnabled, true);
    assert.equal(b.state.settings.strictMode, true);
    assert.equal(b.state.settings.meetingHistoryEnabled, true);
    assert.equal(mergeSyncStats(b.state.stats, b.state.remote)[0].focusMinutes, 8);
    assert.equal(mergeSyncStats(b.state.stats, b.state.remote)[0].breaksCompleted, 3);
    assert.equal(b.state.remote[0][0].meetings, undefined);
    const before = JSON.stringify(b.state.stats);
    await b.client.tick();
    assert.equal(mergeSyncStats(b.state.stats, b.state.remote)[0].focusMinutes, 8);
    assert.equal(JSON.stringify(b.state.stats), before, 'display merging never rewrites local counters');

    const login = await fetch(url + '/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password }) }).then(r => r.json());
    token = login.token;
    const state = await fetch(url + '/v1/state', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    const key = await deriveSyncKey(secret, login.accountId);
    for (const doc of state.documents) {
      const value = await decryptSync(key, login.accountId, doc.id === 'settings' ? 'settings' : doc.id.replace('_', '-'), doc.envelope);
      assert(!JSON.stringify(value).includes('private'));
    }
    assert(!JSON.stringify(a.requests).includes(secret), 'recovery secret never reaches the server');
    assert(!JSON.stringify(b.requests).includes(secret));
    const settingsWrites = target => target.requests.filter(r => r.input.endsWith('/v1/state/settings') && r.body).length;
    const beforePrivacy = settingsWrites(a);
    a.state.settings = { ...a.state.settings, cameraLockEnabled: true };
    a.client.settingsChanged(a.state.settings); await a.client.tick();
    assert.equal(settingsWrites(a), beforePrivacy, 'privacy-only local changes never publish stale preferences');
    b.state.settings = { ...b.state.settings, colorPalette: 'lavender' }; b.client.settingsChanged(b.state.settings);
    await b.client.tick(); await until(() => settingsWrites(b) > 0);
    a.state.settings = { ...a.state.settings, soundVolume: 40 }; a.client.settingsChanged(a.state.settings);
    await a.client.tick(); await until(() => a.state.settings.colorPalette === 'lavender');
    assert.equal(a.state.settings.soundVolume, 40, 'local changed field survives merging with remote fields');
    const mergedState = await fetch(url + '/v1/state', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    const prefs = await decryptSync(key, login.accountId, 'settings', mergedState.documents.find(doc => doc.id === 'settings').envelope);
    assert.equal(prefs.colorPalette, 'lavender'); assert.equal(prefs.soundVolume, 40);
    await a.client.publishBreak(2);
    await a.client.publishBreak(2);
    await until(() => a.state.breaks.length && b.state.breaks.length);
    assert.equal(a.state.breaks.length, 1);
    assert.equal(b.state.breaks.length, 1);
    assert.equal(a.state.breaks[0].event.id, b.state.breaks[0].event.id);
    assert.equal(a.state.breaks[0].event.endAt, b.state.breaks[0].event.endAt);
    assert(Math.abs(a.state.breaks[0].at - b.state.breaks[0].at) < 1200);
    assert(a.state.breaks[0].at >= a.state.breaks[0].event.startAt - 20);
    const wrong = device(url, storage()); clients.push(wrong.client);
    await assert.rejects(() => wrong.client.connect('login', 'owner@example.test', password, generateRecoveryKey(), ''), /key mismatch/);
    wrong.client.close();
    assert.equal(wrong.state.remote.length, 0);
    assert.equal(wrong.state.applied, 0);

    b.client.close();
    const reconnected = device(url, bStore, {}, localB); clients.push(reconnected.client);
    await reconnected.client.connect('login', 'owner@example.test', password, secret, '');
    await reconnected.client.tick();
    await sleep(100);
    assert.equal(reconnected.state.breaks.length, 0, 'a remembered command is not replayed after reconnect');
    assert.equal(mergeSyncStats(reconnected.state.stats, reconnected.state.remote)[0].focusMinutes, 8);

    await a.client.publishBreak(2);
    await until(() => a.requests.filter(r => r.input.endsWith('/v1/events') && r.body).length >= 2);
    a.client.close();
    await sleep(2600);
    assert.equal(a.state.breaks.length, 1, 'logout cancels queued remote locks');
    await reconnected.client.deleteAccount(password);
  } finally {
    for (const client of clients) client.close();
    if (token) await fetch(url + '/v1/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('authorization expiry cancels scheduled shared commands and prevents further publishing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const accountId = 'c'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  let revoked = false, breaks = 0;
  const client = new AccountSyncSession({ snapshot: () => ({ settings: DEFAULT_SETTINGS, stats: [] }), settings() {}, stats() {}, break() { breaks++; }, status() {} }, storage(), 'http://127.0.0.1:47832', async (url, init) => {
    if (revoked) return new Response('{}', { status: 401 });
    let payload = {};
    if (url.endsWith('/v1/login')) payload = { accountId, token: 'a'.repeat(43), keyCheck };
    else if (url.endsWith('/v1/state')) payload = { documents: [] };
    else if (init.method === 'PUT') payload = { revision: 1 };
    else if (url.includes('/v1/events?')) payload = { instance: 'test', events: [], cursor: 0 };
    else if (url.endsWith('/v1/events')) payload = { seq: 1 };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  try {
    await client.connect('login', 'owner@example.test', password, secret, '');
    await new Promise(setImmediate);
    await client.publishBreak(5);
    revoked = true;
    await client.tick();
    t.mock.timers.tick(3000);
    await new Promise(setImmediate);
    assert.equal(breaks, 0, 'an expired or revoked server session cannot execute a queued command');
    await assert.rejects(() => client.publishBreak(5));
  } finally { client.close(); }
});


test('an undecryptable event does not block later commands or preference writes', async () => {
  const accountId = 'c'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  const now = Date.now();
  const valid = await encryptSync(key, accountId, 'break', { v: 1, id: 'e'.repeat(32), deviceId: 'f'.repeat(32), createdAt: now, startAt: now + 5000, endAt: now + 15000 });
  const bad = { ...valid, ciphertext: (valid.ciphertext[0] === 'A' ? 'B' : 'A') + valid.ciphertext.slice(1) };
  const statuses = [], requests = [];
  const client = new AccountSyncSession({ snapshot: () => ({ settings: DEFAULT_SETTINGS, stats: [] }), settings() {}, stats() {}, break() {}, status(value) { statuses.push(value); } }, storage(), 'http://127.0.0.1:47832', async (url, init) => {
    requests.push(url);
    let payload = {};
    if (url.endsWith('/v1/login')) payload = { accountId, token: 'a'.repeat(43), keyCheck };
    else if (url.endsWith('/v1/state')) payload = { documents: [] };
    else if (init.method === 'PUT') payload = { revision: 1 };
    else if (url.endsWith('/v1/events?after=0')) payload = { instance: 'test', events: [{ seq: 1, envelope: bad }, { seq: 2, envelope: valid }], cursor: 2 };
    else if (url.endsWith('/v1/events?after=2')) payload = { instance: 'test', events: [], cursor: 2 };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  try {
    await client.connect('login', 'owner@example.test', password, secret, '');
    await until(() => statuses.length >= 2);
    assert.equal(statuses.at(-1), 'connected');
    assert(requests.some(url => url.endsWith('/v1/state/settings')));
    await client.tick();
    assert(requests.some(url => url.endsWith('/v1/events?after=2')));
  } finally { client.close(); }
});

test('a reset during publish invalidates both the local delivery and a concurrent self-event poll', async () => {
  const accountId = 'c'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  let generation = 1, callbacks = 0, envelope, finishPost;
  const client = new AccountSyncSession({
    snapshot: () => ({ settings: DEFAULT_SETTINGS, stats: [] }), settings() {}, stats() {},
    breakGeneration: () => generation, break() { callbacks++; }, status() {},
  }, storage(), 'http://127.0.0.1:47832', async (url, init) => {
    let payload = {};
    if (url.endsWith('/v1/login')) payload = { accountId, token: 'a'.repeat(43), keyCheck };
    else if (url.endsWith('/v1/state')) payload = { documents: [] };
    else if (init.method === 'PUT') payload = { revision: 1 };
    else if (url.includes('/v1/events?')) payload = { instance: 'test', cursor: envelope ? 1 : 0, events: envelope ? [{ seq: 1, envelope }] : [] };
    else if (url.endsWith('/v1/events')) {
      envelope = JSON.parse(init.body).envelope;
      await new Promise(resolve => { finishPost = resolve; });
      payload = { seq: 1 };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  let publishing;
  try {
    await client.connect('login', 'owner@example.test', password, secret, '');
    publishing = client.publishBreak(20);
    await until(() => !!finishPost);
    // Reset then resume still advances the generation, even when not paused now.
    generation += 2;
    await client.tick();
    finishPost(); await publishing;
    await sleep(2700);
    assert.equal(callbacks, 0);
  } finally {
    finishPost?.();
    await publishing?.catch(() => {});
    client.close();
  }
});


test('unreadable peer statistics do not block valid totals, settings or this device uploads', async () => {
  const accountId = 'c'.repeat(32), deviceId = 'd'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  const day = { date: '2026-10-20', breaksCompleted: 1, exercisesCompleted: 0, focusMinutes: 5, techniqueCounts: {} };
  const documents = [
    { id: 'settings', revision: 3, envelope: await encryptSync(key, accountId, 'settings', projectSyncSettings({ ...DEFAULT_SETTINGS, colorPalette: 'ocean' })) },
    { id: `stats_${deviceId}`, revision: 4, envelope: { v: 2 } },
    { id: `stats_${'e'.repeat(32)}`, revision: 7, envelope: { v: 2 } },
    { id: `stats_${'f'.repeat(32)}`, revision: 8, envelope: await encryptSync(key, accountId, `stats-${'f'.repeat(32)}`, [{ ...day, futureField: 1 }]) },
    { id: `stats_${'b'.repeat(32)}`, revision: 9, envelope: await encryptSync(key, accountId, `stats-${'b'.repeat(32)}`, [day]) },
  ];
  const store = storage(); store.setItem(`blincho_sync_device_${accountId}`, deviceId);
  const state = { settings: { ...DEFAULT_SETTINGS }, stats: [{ ...day, focusMinutes: 2 }], remote: [] };
  const statuses = [], writes = [];
  const originalNow = Date.now;
  let now = originalNow();
  const client = new AccountSyncSession({ snapshot: () => state,
    settings(value) { state.settings = applySyncSettings(state.settings, value); },
    stats(value) { state.remote = value; }, break() {}, status(value) { statuses.push(value); },
  }, store, 'http://127.0.0.1:47832', async (url, init) => {
    let payload = {};
    if (url.endsWith('/v1/login')) payload = { accountId, token: 'a'.repeat(43), keyCheck };
    else if (url.endsWith('/v1/state')) payload = { documents };
    else if (url.includes('/v1/events?')) payload = { instance: 'test', events: [], cursor: 0 };
    else if (init.method === 'PUT') {
      const id = url.split('/').at(-1), doc = documents.find(doc => doc.id === id), body = JSON.parse(init.body);
      assert.equal(body.baseRevision, doc.revision, 'retain revisions for skipped documents');
      doc.revision++; doc.envelope = body.envelope; writes.push({ id, body });
      payload = { revision: doc.revision };
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  try {
    Date.now = () => now;
    await client.connect('login', 'owner@example.test', password, secret, '');
    await until(() => statuses.length >= 2);
    assert.deepEqual(state.remote, [[day]], 'only the readable peer contributes totals');
    assert.equal(state.settings.colorPalette, 'ocean');
    assert(writes.some(write => write.id === `stats_${deviceId}` && write.body.baseRevision === 4));
    state.settings = { ...state.settings, soundVolume: 40 };
    state.stats = [{ ...day, focusMinutes: 3 }];
    client.settingsChanged(state.settings); now += 31_000;
    await client.tick();
    assert.equal(statuses.at(-1), 'connected');
    assert(!statuses.includes('error'));
    const settingsWrite = writes.find(write => write.id === 'settings');
    assert(settingsWrite);
    assert.equal((await decryptSync(key, accountId, 'settings', settingsWrite.body.envelope)).soundVolume, 40);
    const statsWrite = writes.filter(write => write.id === `stats_${deviceId}`).at(-1);
    assert.equal((await decryptSync(key, accountId, `stats-${deviceId}`, statsWrite.body.envelope))[0].focusMinutes, 3);
  } finally { client.close(); Date.now = originalNow; }
});

test('an unreadable account settings document still rejects connection', async () => {
  const accountId = 'c'.repeat(32), secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const keyCheck = await encryptSync(key, accountId, 'key-check', { check: 'blincho-sync-v1' });
  let uploads = 0;
  const client = new AccountSyncSession({ snapshot: () => ({ settings: DEFAULT_SETTINGS, stats: [] }), settings() {}, stats() {}, break() {}, status() {} },
    storage(), 'http://127.0.0.1:47832', async (url, init) => {
      if (init.method === 'PUT') uploads++;
      const payload = url.endsWith('/v1/login') ? { accountId, token: 'a'.repeat(43), keyCheck }
        : url.endsWith('/v1/state') ? { documents: [{ id: 'settings', revision: 1, envelope: { v: 2 } }] } : {};
      return new Response(JSON.stringify(payload), { status: 200 });
    });
  try {
    await assert.rejects(() => client.connect('login', 'owner@example.test', password, secret, ''));
    assert.equal(uploads, 0);
  } finally { client.close(); }
});
