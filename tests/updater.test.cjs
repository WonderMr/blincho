const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createUpdateController, resolveUpdateSupport, registerUpdateIpc } = require('../electron/updater.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function update(version = '1.5.0') {
  return { isUpdateAvailable: true, updateInfo: { version }, cancellationToken: { cancelled: false, cancel() { this.cancelled = true; } } };
}
class FakeUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.downloads = 0; this.installs = []; this.result = update(); }
  setFeedURL(feed) { this.feed = feed; }
  checkForUpdates() { this.checks++; return this.checkResult?.promise || Promise.resolve(this.result); }
  downloadUpdate(token) { this.downloads++; this.token = token; return this.downloadResult?.promise || Promise.resolve(['/fixture/update']); }
  quitAndInstall(...args) { this.installs.push(args); }
}
function harness(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-updater-'));
  if (!options.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timers = new Map();
  const snapshots = [];
  const engine = options.engine || new FakeUpdater();
  let quits = 0;
  const app = { isPackaged: true, getVersion: () => '1.4.0', getPath: () => directory, getAppPath: () => '/fixture/app', quit() { quits++; controller.beforeQuit({ preventDefault() {} }); } };
  const controller = createUpdateController({
    app, platform: 'win32', arch: 'x64', support: { supported: true, supportReason: null }, updaterFactory: () => engine,
    schedule: (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id), now: () => '2026-10-12T00:00:00.000Z', onState: state => snapshots.push(state), ...options,
  });
  t.after(() => controller.dispose());
  return { controller, engine, app, directory, timers, snapshots, get quits() { return quits; },
    tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); },
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    quit() { let prevented = 0; controller.beforeQuit({ preventDefault() { prevented++; } }); return prevented; },
  };
}

test('default ask schedules checks and never downloads, stages, installs or quits without consent', async t => {
  const h = harness(t);
  assert.equal(h.controller.getUpdateState().policy, 'ask');
  h.controller.start(); h.controller.start();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 60_000);
  h.tick(); await h.flush();
  assert.equal(h.engine.checks, 1);
  assert.equal(h.engine.downloads, 0);
  assert.equal(h.controller.getUpdateState().status, 'available');
  assert.equal(h.controller.getUpdateState().manualCheck, false);
  assert.equal(h.engine.autoDownload, false);
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  assert.equal(h.engine.autoRunAppAfterInstall, false);
  assert.equal(h.engine.feed.provider, 'custom');
  assert.equal(typeof h.engine.feed.updateProvider, 'function');
  assert.equal(h.engine.feed.url, 'https://blincho.app/updates/win32/x64/');
  assert.equal(h.quit(), 0);
  assert.deepEqual(h.engine.installs, []);
  assert.equal(h.quits, 0);
});

test('explicit version consent downloads once, arms only actual quit, and never requests relaunch', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates();
  h.engine.downloadResult = deferred();
  const first = h.controller.downloadUpdate('1.5.0');
  const second = h.controller.downloadUpdate('1.5.0');
  assert.equal(first, second);
  assert.equal(h.engine.downloads, 1);
  assert.equal(h.controller.getUpdateState().installOnQuit, false);
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  h.engine.downloadResult.resolve([]);
  await first;
  assert.equal(h.controller.getUpdateState().installOnQuit, true);
  assert.equal(h.engine.installs.length, 0);
  assert.equal(h.quits, 0);
  assert.equal(h.quit(), 1);
  assert.deepEqual(h.engine.installs, [[true, false]]);
  assert.equal(h.quit(), 0);
  assert.deepEqual(h.engine.installs, [[true, false]]);
  assert.equal(h.timers.size, 0);
});

test('auto requires durable opt-in, downloads after check, and stays quiet until actual quit', async t => {
  const h = harness(t);
  h.controller.setUpdatePolicy('auto');
  h.controller.start(); h.tick(); await h.flush();
  assert.equal(h.engine.downloads, 1);
  assert.equal(h.controller.getUpdateState().status, 'ready');
  assert.equal(h.engine.autoInstallOnAppQuit, false);
  assert.equal(h.engine.installs.length, 0);
  assert.equal(h.quits, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory, 'update-preferences.json'))).policy, 'auto');
});

test('off cancels background schedules; explicit manual check and one-time download remain possible', async t => {
  const h = harness(t);
  h.controller.start();
  h.controller.setUpdatePolicy('off');
  assert.equal(h.timers.size, 0);
  assert.equal(h.engine.checks, 0);
  await h.controller.checkForUpdates();
  assert.equal(h.controller.getUpdateState().manualCheck, true);
  await h.controller.downloadUpdate('1.5.0');
  assert.equal(h.controller.getUpdateState().installOnQuit, true);
  h.controller.setUpdatePolicy('off');
  assert.equal(h.controller.getUpdateState().installOnQuit, false);
  assert.equal(h.quit(), 0);
  assert.equal(h.engine.installs.length, 0);
});

test('off cancels metadata HTTP and prevents the pinned provider from starting retries', async t => {
  const { AppUpdater } = require('electron-updater/out/AppUpdater');
  const engine = new AppUpdater(undefined, { version: '1.4.0', isPackaged: true, whenReady: () => Promise.resolve() });
  engine.logger = null;
  engine.stagingUserIdPromise = { value: Promise.resolve('00000000-0000-4000-8000-000000000000') };
  const requests = [];
  const first = deferred();
  engine.httpExecutor = { request(options, token) {
    requests.push({ options, token });
    return requests.length === 1 ? first.promise : Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  } };
  const h = harness(t, { engine });
  h.controller.start(); h.tick();
  while (!requests.length) await new Promise(setImmediate);
  const checking = h.controller.checkForUpdates();
  h.controller.setUpdatePolicy('off');
  first.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  await checking;
  assert.equal(requests.length, 1, 'no metadata retry starts after consent is revoked');
  assert.equal(requests[0].token?.cancelled, true, 'the in-flight HTTP token is cancelled');
  assert.equal(h.controller.getUpdateState().policy, 'off');
  assert.equal(h.controller.getUpdateState().status, 'idle');
  assert.equal(h.timers.size, 0);
});

for (const policy of ['ask', 'auto', 'off']) {
  test(`changing to ${policy} during check rejects stale results and cannot grant download consent`, async t => {
    const h = harness(t);
    h.controller.setUpdatePolicy('auto');
    h.engine.checkResult = deferred();
    const inFlight = h.controller.checkForUpdates();
    assert.equal(h.controller.checkForUpdates(), inFlight);
    h.controller.setUpdatePolicy(policy);
    const old = update(); h.engine.checkResult.resolve(old); await inFlight;
    assert.equal(old.cancellationToken.cancelled, true);
    assert.equal(h.controller.getUpdateState().status, 'idle');
    assert.equal(h.controller.getUpdateState().policy, policy);
    assert.equal(h.engine.downloads, 0);
    assert.equal(h.engine.installs.length, 0);
  });
  test(`changing to ${policy} during download cancels token and ignores completion, progress and error`, async t => {
    const h = harness(t);
    await h.controller.checkForUpdates();
    h.engine.downloadResult = deferred();
    const downloading = h.controller.downloadUpdate('1.5.0');
    h.controller.setUpdatePolicy(policy);
    assert.equal(h.engine.token.cancelled, true);
    h.engine.emit('download-progress', { percent: 99 });
    h.engine.emit('error', new Error('secret URL/private/path'));
    h.engine.downloadResult.resolve([]); await downloading;
    assert.equal(h.controller.getUpdateState().status, 'idle');
    assert.equal(h.controller.getUpdateState().progress, null);
    assert.equal(h.controller.getUpdateState().installOnQuit, false);
    assert.equal(h.quit(), 0);
    assert.equal(h.engine.installs.length, 0);
  });
}

test('revocation after ready prevents install and new process inherits only policy and skip, never one-time consent', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates(); await h.controller.downloadUpdate('1.5.0');
  h.controller.setUpdatePolicy('off');
  const fresh = harness(t, { directory: h.directory });
  fresh.controller.start();
  assert.equal(fresh.controller.getUpdateState().policy, 'off');
  assert.equal(fresh.controller.getUpdateState().installOnQuit, false);
  assert.equal(fresh.timers.size, 0);
  assert.equal(h.quit(), 0); assert.equal(fresh.quit(), 0);
  assert.equal(h.engine.installs.length, 0); assert.equal(fresh.engine.installs.length, 0);
});

test('ask restarts without one-time consent even if updater has cached downloaded files', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates(); await h.controller.downloadUpdate('1.5.0');
  const fresh = harness(t, { directory: h.directory, engine: h.engine });
  assert.equal(fresh.controller.getUpdateState().policy, 'ask');
  assert.equal(fresh.controller.getUpdateState().installOnQuit, false);
  assert.equal(fresh.quit(), 0);
  assert.equal(h.engine.installs.length, 0);
});

test('skip during download cancels consent and ignores a late rejection', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates(); h.engine.downloadResult = deferred();
  const download = h.controller.downloadUpdate('1.5.0');
  h.controller.skipUpdate('1.5.0');
  assert.equal(h.engine.token.cancelled, true);
  h.engine.downloadResult.reject(new Error('late download failure')); await download;
  assert.equal(h.controller.getUpdateState().status, 'idle');
  assert.equal(h.controller.getUpdateState().skippedVersion, '1.5.0');
  assert.equal(h.controller.getUpdateState().errorCode, null);
  assert.equal(h.quit(), 0);
});

test('a stale failed check cannot overwrite the newer off policy', async t => {
  const h = harness(t);
  h.engine.checkResult = deferred(); const check = h.controller.checkForUpdates();
  h.controller.setUpdatePolicy('off');
  h.engine.checkResult.reject(new Error('late network failure')); await check;
  assert.equal(h.controller.getUpdateState().policy, 'off');
  assert.equal(h.controller.getUpdateState().status, 'idle');
  assert.equal(h.controller.getUpdateState().errorCode, null);
});

test('skipped version persists atomically, suppresses background auto download but permits explicit manual check', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates();
  h.controller.skipUpdate('1.5.0'); h.controller.setUpdatePolicy('auto');
  const saved = JSON.parse(fs.readFileSync(path.join(h.directory, 'update-preferences.json'), 'utf8'));
  assert.deepEqual(saved, { schemaVersion: 1, policy: 'auto', skippedVersion: '1.5.0' });
  assert.equal(fs.existsSync(path.join(h.directory, 'update-preferences.json.tmp')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.directory, 'update-preferences.json')).mode & 0o777, 0o600);
  const fresh = harness(t, { directory: h.directory });
  fresh.controller.start(); fresh.tick(); await fresh.flush();
  assert.equal(fresh.controller.getUpdateState().status, 'idle');
  assert.equal(fresh.engine.downloads, 0);
  await fresh.controller.checkForUpdates(); await fresh.flush();
  assert.equal(fresh.controller.getUpdateState().status, 'ready');
  assert.equal(fresh.engine.downloads, 1);
});

test('check errors, malformed feed versions and download errors expose bounded codes without raw data', async t => {
  const h = harness(t);
  h.engine.checkResult = deferred();
  const check = h.controller.checkForUpdates();
  h.engine.emit('error', new Error('https://example.test/private-token'));
  h.engine.checkResult.reject(new Error('/private/token')); await check;
  assert.equal(h.controller.getUpdateState().errorCode, 'check-failed');
  assert(!JSON.stringify(h.controller.getUpdateState()).includes('private'));
  h.engine.checkResult = null;
  h.engine.result = update('x'.repeat(10_000)); await h.controller.checkForUpdates();
  assert.equal(h.controller.getUpdateState().availableVersion, null);
  assert.equal(h.controller.getUpdateState().errorCode, 'check-failed');
  h.engine.result = update(); await h.controller.checkForUpdates();
  h.engine.downloadResult = deferred(); const download = h.controller.downloadUpdate('1.5.0');
  h.engine.downloadResult.reject(new Error('secret')); await download;
  assert.equal(h.controller.getUpdateState().errorCode, 'download-failed');
  assert.equal(h.controller.getUpdateState().installOnQuit, false);
  assert.equal(h.quit(), 0);
});

test('bad inputs and stale version consent cannot start a download or write preferences', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates();
  for (const input of [null, {}, '', '1.6.0', 'x'.repeat(1000)]) {
    assert.equal((await h.controller.downloadUpdate(input)).errorCode, 'invalid-request');
    assert.equal(h.controller.skipUpdate(input).errorCode, 'invalid-request');
    assert.equal(h.controller.setUpdatePolicy(input).errorCode, 'invalid-request');
  }
  assert.equal(h.engine.downloads, 0);
  assert.equal(fs.existsSync(path.join(h.directory, 'update-preferences.json')), false);
});

test('progress is finite, bounded and rounded; returned state is a detached serializable snapshot', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates();
  h.engine.downloadResult = deferred(); const pending = h.controller.downloadUpdate('1.5.0');
  for (const [value, expected] of [[22.7, 23], [Infinity, 23], [NaN, 23], [-5, 0], [500, 100]]) {
    h.engine.emit('download-progress', { percent: value });
    assert.equal(h.controller.getUpdateState().progress, expected);
  }
  const snapshot = h.controller.getUpdateState(); snapshot.policy = 'auto';
  assert.equal(h.controller.getUpdateState().policy, 'ask');
  assert.deepEqual(JSON.parse(JSON.stringify(h.controller.getUpdateState())), h.controller.getUpdateState());
  h.engine.downloadResult.resolve([]); await pending;
});

test('unreadable or corrupted settings fail closed, atomic write failure does not grant auto consent', async t => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.directory, 'update-preferences.json'), '{broken');
  const corrupt = harness(t, { directory: h.directory });
  corrupt.controller.start();
  assert.equal(corrupt.controller.getUpdateState().policy, 'off');
  assert.equal(corrupt.controller.getUpdateState().errorCode, 'preferences-failed');
  assert.equal(corrupt.timers.size, 0);
  const unwritable = harness(t, { fileSystem: { ...fs, renameSync() { throw new Error('disk full'); } } });
  assert.equal(unwritable.controller.setUpdatePolicy('auto').policy, 'off');
  assert.equal(unwritable.controller.getUpdateState().errorCode, 'preferences-failed');
  assert.equal(unwritable.engine.downloads, 0);
});

test('requested quit cancels in-flight download and cannot install its late result', async t => {
  const h = harness(t);
  await h.controller.checkForUpdates(); h.engine.downloadResult = deferred();
  const downloading = h.controller.downloadUpdate('1.5.0');
  assert.equal(h.quit(), 0);
  assert.equal(h.engine.token.cancelled, true);
  h.engine.downloadResult.resolve([]); await downloading;
  assert.equal(h.controller.getUpdateState().installOnQuit, false);
  assert.equal(h.engine.installs.length, 0);
});

for (const failure of ['throw', 'error', 'timeout']) test(`installer ${failure} permits requested quit and never loops or relaunches`, async t => {
  const h = harness(t);
  await h.controller.checkForUpdates(); await h.controller.downloadUpdate('1.5.0');
  if (failure === 'throw') h.engine.quitAndInstall = () => { throw new Error('installer failed'); };
  if (failure === 'error') h.engine.quitAndInstall = () => h.engine.emit('error', new Error('installer failed'));
  assert.equal(h.quit(), 1);
  if (failure === 'timeout') h.tick();
  assert.equal(h.quits, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.quit(), 0);
  assert.equal(h.quits, 1);
});

test('unsupported packages make no updater instance or network request and expose the fixed manual fallback', async t => {
  let constructed = 0;
  const h = harness(t, { support: { supported: false, supportReason: 'unsigned-mac' }, updaterFactory() { constructed++; throw new Error('never'); } });
  h.controller.start(); h.controller.setUpdatePolicy('auto');
  assert.equal(h.timers.size, 0);
  const state = await h.controller.checkForUpdates();
  assert.equal(state.status, 'manual');
  assert.equal(state.manualDownloadUrl, 'https://blincho.app/#download');
  await h.controller.downloadUpdate('1.5.0');
  assert.equal(constructed, 0);
});

test('support requires matching build metadata, signed mac, installed NSIS or a running AppImage', () => {
  function support(platform, metadata, extra = {}) {
    const paths = new Set(['/resources/app-update.yml', '/installed/Uninstall Blincho.exe', '/installed/Blincho.AppImage'].map(value => path.normalize(value)));
    return resolveUpdateSupport({ app: { isPackaged: true, getAppPath: () => '/app' }, platform, arch: 'x64',
      resourcesPath: '/resources', execPath: '/installed/Blincho.exe', env: {},
      fileSystem: { readFileSync: () => Buffer.from(JSON.stringify({ schemaVersion: 1, platform, arch: 'x64', ...metadata })), existsSync: value => paths.has(path.normalize(value)) }, ...extra });
  }
  assert.equal(support('darwin', { packageType: 'mac-signed', signed: true }).supported, true);
  assert.equal(support('darwin', { packageType: 'mac-signed', signed: false }).supportReason, 'unsigned-mac');
  assert.equal(support('darwin', { packageType: 'manual', signed: false }).supported, false);
  assert.equal(support('win32', { packageType: 'nsis' }).supported, true);
  assert.equal(support('win32', { packageType: 'nsis' }, { env: { PORTABLE_EXECUTABLE_FILE: '/temp/Blincho.exe' } }).supported, false);
  assert.equal(support('win32', { packageType: 'nsis' }, { execPath: '/unpacked/Blincho.exe' }).supported, false);
  assert.equal(support('win32', { packageType: 'manual' }).supported, false);
  assert.equal(support('linux', { packageType: 'appimage' }, { env: { APPIMAGE: '/installed/Blincho.AppImage' } }).supported, true);
  assert.equal(support('linux', { packageType: 'appimage' }).supported, false);
  assert.equal(support('linux', { packageType: 'manual' }, { env: { APPIMAGE: '/installed/Blincho.AppImage' } }).supported, false);
  assert.equal(support('darwin', { packageType: 'mac-signed', signed: true, arch: 'arm64' }).supportReason, 'missing-config');
  assert.equal(support('darwin', { packageType: 'mac-signed', signed: true }, { resourcesPath: '/absent' }).supported, false);
  assert.equal(support('darwin', {}, { app: { isPackaged: false } }).supportReason, 'development');
});

test('all updater IPC is guarded before controller access, and manual browser action ignores renderer URLs', async () => {
  const handlers = new Map(); const calls = []; const accepted = {};
  const controller = Object.fromEntries(['getUpdateState', 'setUpdatePolicy', 'checkForUpdates', 'downloadUpdate', 'skipUpdate'].map(method => [method, value => calls.push([method, value])]));
  let opened = 0;
  registerUpdateIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    requireMainRenderer(event) { if (event !== accepted) throw new Error('Main frame only'); },
    getController: () => controller, openDownload: () => { opened++; },
  });
  assert.equal(handlers.size, 6);
  for (const [name, callback] of handlers) {
    if (name === 'open-update-download') await assert.rejects(callback({}, 'file:///private'), /Main frame/);
    else assert.throws(() => callback({}, 'bad'), /Main frame/);
  }
  assert.equal(calls.length, 0); assert.equal(opened, 0);
  assert.equal(await handlers.get('open-update-download')(accepted, 'file:///private'), true);
  assert.equal(opened, 1);
  handlers.get('set-update-policy')(accepted, 'off');
  assert.deepEqual(calls, [['setUpdatePolicy', 'off']]);
});

test('preload exposes only narrow update calls and subscriptions discard Electron events and clean up', () => {
  const ipcRenderer = new EventEmitter(); const calls = [];
  ipcRenderer.invoke = (...args) => { calls.push(args); return Promise.resolve({}); };
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer }),
    process: { platform: 'darwin' }, window: { addEventListener() {} },
  });
  api.getUpdateState(); api.setUpdatePolicy('ask'); api.checkForUpdates(); api.downloadUpdate('1.5.0'); api.skipUpdate('1.5.0'); api.openUpdateDownload();
  assert.deepEqual(calls, [['get-update-state'], ['set-update-policy', 'ask'], ['check-for-updates'], ['download-update', '1.5.0'], ['skip-update', '1.5.0'], ['open-update-download']]);
  let received; const remove = api.onUpdateState(state => { received = state; });
  const state = { policy: 'ask' }; ipcRenderer.emit('update-state', { sender: 'secret' }, state);
  assert.equal(received, state); remove(); assert.equal(ipcRenderer.listenerCount('update-state'), 0);
  assert.equal(api.quitAndInstall, undefined); assert.equal(api.setFeedURL, undefined);
});

test('pinned MacUpdater keeps Squirrel unstaged until actual quit and does not relaunch', async t => {
  // Exercise the dependency's real public check/download/quit methods. Only OS,
  // HTTP server and feed/download boundaries are fake; there is no network I/O.
  const source = require.resolve('electron-updater/out/MacUpdater.js');
  const realRequire = createRequire(source);
  const native = new EventEmitter(); let staged = 0, relaunched = 0;
  native.setFeedURL = () => {};
  native.checkForUpdates = () => { staged++; };
  native.quitAndInstall = () => { relaunched++; };
  const fakeServer = new EventEmitter();
  fakeServer.address = () => ({ port: 12345 }); fakeServer.listen = (_port, _host, ready) => ready();
  fakeServer.close = callback => { callback?.(); fakeServer.emit('close'); };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports, Buffer, URL, process,
    require: name => name === 'electron' ? { autoUpdater: native } : name === 'http' ? { createServer: () => fakeServer } : realRequire(name),
  });
  let h;
  const engine = new module.exports.MacUpdater(undefined, {
    version: '1.4.0', isPackaged: true, whenReady: () => Promise.resolve(), quit: () => h.app.quit(),
  });
  engine.logger = null;
  engine.getUpdateInfoAndProvider = async () => ({ info: { version: '1.5.0', files: [{ url: 'Blincho.zip', sha512: 'fixture' }] }, provider: {} });
  engine.doDownloadUpdate = async () => engine.updateDownloaded({ url: new URL('https://blincho.app/updates/darwin/x64/Blincho.zip'), info: { size: 1 } }, { version: '1.5.0', downloadedFile: '/fixture.zip' });
  h = harness(t, { platform: 'darwin', engine });
  await h.controller.checkForUpdates();
  assert.equal(staged, 0);
  await h.controller.downloadUpdate('1.5.0');
  assert.equal(h.controller.getUpdateState().status, 'ready');
  assert.equal(staged, 0);
  assert.equal(relaunched, 0);
  assert.equal(h.quit(), 1);
  assert.equal(staged, 1);
  native.emit('update-downloaded');
  assert.equal(h.quits, 1);
  assert.equal(relaunched, 0);
  assert.equal(h.quit(), 0);
  assert.equal(staged, 1);
});

test('pinned BaseUpdater installs silently without forced restart only after actual quit', async t => {
  const source = require.resolve('electron-updater/out/BaseUpdater.js');
  const realRequire = createRequire(source);
  const native = new EventEmitter(); const installed = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, exports: module.exports, process, setImmediate,
    require: name => name === 'electron' ? { autoUpdater: native } : realRequire(name),
  });
  let h;
  const engine = new module.exports.BaseUpdater(undefined, {
    version: '1.4.0', isPackaged: true, whenReady: () => Promise.resolve(), quit: () => h.app.quit(),
    onQuit() { throw new Error('No implicit installer registration'); },
  });
  engine.logger = null;
  engine.getUpdateInfoAndProvider = async () => ({ info: { version: '1.5.0', files: [{ url: 'Blincho.exe', sha512: 'fixture' }] }, provider: {} });
  engine.doDownloadUpdate = async () => {
    engine.downloadedUpdateHelper = { file: '/fixture/update.exe', downloadedFileInfo: { isAdminRightsRequired: false } };
    engine.addQuitHandler();
    return ['/fixture/update.exe'];
  };
  engine.doInstall = options => { installed.push(options); return true; };
  h = harness(t, { engine });
  await h.controller.checkForUpdates(); await h.controller.downloadUpdate('1.5.0');
  assert.equal(installed.length, 0);
  assert.equal(h.quit(), 1);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].isSilent, true);
  assert.equal(installed[0].isForceRunAfter, false);
  await new Promise(setImmediate);
  assert.equal(h.quits, 1);
  assert.equal(h.quit(), 0);
  assert.equal(installed.length, 1);
});
