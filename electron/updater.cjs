const fs = require('node:fs');
const path = require('node:path');
const { availableMacVersion, fetchReleaseManifest } = require('./manualUpdates.cjs');

const POLICIES = new Set(['ask', 'auto', 'off']);
const MANUAL_DOWNLOAD_URL = 'https://blincho.app/#download';
const INITIAL_DELAY = 60_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validVersion(value) {
  return typeof value === 'string' && value.length <= 100 && VERSION_PATTERN.test(value);
}

function readBoundedJson(fileSystem, file, limit) {
  const buffer = fileSystem.readFileSync(file);
  if (buffer.length > limit) throw new Error('Oversized configuration');
  return JSON.parse(buffer.toString('utf8'));
}

function resolveUpdateSupport({ app, platform = process.platform, arch = process.arch, env = process.env,
  resourcesPath = process.resourcesPath, execPath = process.execPath, fileSystem = fs }) {
  const unsupported = supportReason => ({ supported: false, checkSupported: false, supportReason });
  if (!app.isPackaged) return unsupported('development');
  let metadata;
  try { metadata = readBoundedJson(fileSystem, path.join(app.getAppPath(), 'electron', 'update-support.json'), 4096); }
  catch { return unsupported('missing-config'); }
  if (!metadata || typeof metadata !== 'object' || metadata.schemaVersion !== 1 || metadata.platform !== platform || metadata.arch !== arch || !['x64', 'arm64'].includes(arch)) {
    return unsupported('missing-config');
  }
  if (platform === 'darwin') {
    if (metadata.signed !== true || metadata.packageType !== 'mac-signed') return { supported: false, checkSupported: true, supportReason: 'unsigned-mac' };
  } else if (platform === 'win32') {
    // An unpacked directory and a portable executable are never an installed NSIS app.
    if (metadata.packageType !== 'nsis' || env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR ||
        !fileSystem.existsSync(path.join(path.dirname(execPath), 'Uninstall Blincho.exe'))) return unsupported('unsupported-package');
  } else if (platform === 'linux') {
    if (metadata.packageType !== 'appimage' || typeof env.APPIMAGE !== 'string' || !path.isAbsolute(env.APPIMAGE) ||
        !fileSystem.existsSync(env.APPIMAGE)) return unsupported('unsupported-package');
  } else return unsupported('unsupported-package');
  if (!resourcesPath || !fileSystem.existsSync(path.join(resourcesPath, 'app-update.yml'))) return unsupported('missing-config');
  return { supported: true, checkSupported: true, supportReason: null };
}

function createUpdateController({ app, platform = process.platform, arch = process.arch, env = process.env,
  resourcesPath = process.resourcesPath, execPath = process.execPath, fileSystem = fs,
  updaterFactory = () => require('electron-updater').autoUpdater,
  schedule = setTimeout, cancel = clearTimeout, now = () => new Date().toISOString(),
  onState = () => {}, support: suppliedSupport, manifestLoader = fetchReleaseManifest }) {
  const support = suppliedSupport || resolveUpdateSupport({ app, platform, arch, env, resourcesPath, execPath, fileSystem });
  const checkSupported = support.supported || support.checkSupported === true;
  const notificationOnly = platform === 'darwin' && checkSupported && !support.supported;
  const preferencePath = path.join(app.getPath('userData'), 'update-preferences.json');
  let preferences = { schemaVersion: 1, policy: 'ask', skippedVersion: null };
  let preferenceError = false;
  try {
    const stored = readBoundedJson(fileSystem, preferencePath, 4096);
    if (stored.schemaVersion !== 1 || !POLICIES.has(stored.policy) || (stored.skippedVersion !== null && !validVersion(stored.skippedVersion))) {
      throw new Error('Invalid update preferences');
    }
    preferences = { schemaVersion: 1, policy: stored.policy, skippedVersion: stored.skippedVersion };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Corrupt/unreadable preferences cannot imply consent for automatic updates.
      preferences.policy = 'off';
      preferenceError = true;
    }
  }
  // An old automatic-install preference cannot promise installation in a manual package.
  if (notificationOnly && preferences.policy === 'auto') preferences.policy = 'ask';
  const version = app.getVersion?.();
  let state = {
    policy: preferences.policy, status: preferenceError ? 'error' : 'idle', ...support, checkSupported,
    currentVersion: validVersion(version) ? version : '0.0.0', availableVersion: null,
    skippedVersion: preferences.skippedVersion, progress: null, lastCheckedAt: null,
    errorCode: preferenceError ? 'preferences-failed' : null, installOnQuit: false,
    manualCheck: false, manualDownloadUrl: MANUAL_DOWNLOAD_URL,
  };
  let engine = null;
  let generation = 0;
  let operation = null;
  let availableToken = null;
  let consentVersion = null;
  let timer = null;
  let started = false;
  let quitting = false;
  let handoffStarted = false;
  let quitFallback = null;
  let finishRequestedQuit = null;

  const getUpdateState = () => ({ ...state });
  function publish(patch = {}) {
    state = { ...state, ...patch };
    try { onState(getUpdateState()); } catch { /* A closing renderer cannot disrupt update policy. */ }
    return getUpdateState();
  }
  function disarm() {
    consentVersion = null;
    if (engine) {
      engine.autoDownload = false;
      engine.autoInstallOnAppQuit = false;
      engine.autoRunAppAfterInstall = false;
    }
    state.installOnQuit = false;
  }
  function revoke() {
    generation += 1;
    disarm();
    try { operation?.token?.cancel(); } catch { /* Generation also rejects a late result. */ }
    try { availableToken?.cancel(); } catch { /* No pending network is also a valid state. */ }
    availableToken = null;
  }
  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function scheduleCheck(delay = CHECK_INTERVAL) {
    clearTimer();
    if (!started || quitting || !state.checkSupported || state.policy === 'off') return;
    timer = schedule(() => {
      timer = null;
      void runCheck(false).finally(() => scheduleCheck());
    }, delay);
    timer?.unref?.();
  }
  function savePreferences(next) {
    const temporary = `${preferencePath}.tmp`;
    try {
      fileSystem.mkdirSync(path.dirname(preferencePath), { recursive: true });
      fileSystem.writeFileSync(temporary, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600 });
      fileSystem.renameSync(temporary, preferencePath);
      preferences = next;
      return true;
    } catch {
      revoke();
      clearTimer();
      publish({ policy: 'off', status: 'error', errorCode: 'preferences-failed', availableVersion: null, progress: null });
      try { fileSystem.unlinkSync(temporary); } catch { /* Best effort cleanup. */ }
      return false;
    }
  }
  function getEngine() {
    if (engine) return engine;
    const instance = updaterFactory();
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = false;
    instance.autoRunAppAfterInstall = false;
    instance.disableWebInstaller = true;
    instance.allowPrerelease = false;
    instance.allowDowngrade = false;
    const { CancellationError } = require('builder-util-runtime');
    const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
    class CancellableFeedProvider extends GenericProvider {
      httpRequest(url, headers) {
        const check = operation;
        // GenericProvider retries metadata requests without a token by default.
        // Bind every attempt to this check so revocation also stops HTTP retries.
        if (check?.kind !== 'check' || check.generation !== generation || check.token.cancelled) {
          return Promise.reject(new CancellationError());
        }
        return super.httpRequest(url, headers, check.token);
      }
    }
    // The renderer and preferences never supply a URL or provider configuration.
    instance.setFeedURL({ provider: 'custom', updateProvider: CancellableFeedProvider,
      url: `https://blincho.app/updates/${platform}/${arch}/` });
    instance.on('error', () => {
      // Check/download promises report only bounded public codes. Native handoff
      // errors must still allow the quit the user has already requested.
      if (handoffStarted) finishRequestedQuit?.();
    });
    instance.on('download-progress', progress => {
      if (operation?.kind !== 'download' || operation.generation !== generation || consentVersion !== state.availableVersion || quitting) return;
      if (typeof progress?.percent !== 'number' || !Number.isFinite(progress.percent)) return;
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      if (state.progress !== percent) publish({ progress: percent });
    });
    engine = instance;
    return engine;
  }

  function setUpdatePolicy(policy) {
    if (!POLICIES.has(policy) || quitting || (notificationOnly && policy === 'auto')) return publish({ errorCode: 'invalid-request' });
    // Even selecting the same policy revokes pending one-time consent.
    revoke();
    clearTimer();
    if (!savePreferences({ ...preferences, policy })) return getUpdateState();
    publish({ policy, status: 'idle', availableVersion: null, progress: null, errorCode: null, manualCheck: false });
    scheduleCheck(INITIAL_DELAY);
    return getUpdateState();
  }

  function runCheck(manual) {
    if (quitting || (!manual && state.policy === 'off')) return Promise.resolve(getUpdateState());
    if (operation) return operation.promise;
    if (state.status === 'ready') return Promise.resolve(getUpdateState());
    if (!state.checkSupported) return Promise.resolve(manual ? publish({ status: 'manual', manualCheck: true, errorCode: null }) : getUpdateState());
    if (notificationOnly) return runNotificationCheck(manual);
    disarm();
    const { CancellationToken } = require('builder-util-runtime');
    const current = { kind: 'check', generation, token: new CancellationToken(), promise: null };
    operation = current;
    publish({ status: 'checking', manualCheck: manual, availableVersion: null, progress: null, errorCode: null });
    current.promise = (async () => {
      try {
        const result = await getEngine().checkForUpdates();
        if (current.generation !== generation || quitting) {
          result?.cancellationToken?.cancel();
          return getUpdateState();
        }
        if (!result || typeof result.isUpdateAvailable !== 'boolean') throw new Error('Invalid update result');
        const checkedAt = now();
        if (!result.isUpdateAvailable) return publish({ status: 'up-to-date', lastCheckedAt: checkedAt });
        const nextVersion = result.updateInfo?.version;
        if (!validVersion(nextVersion) || nextVersion === state.currentVersion || !result.cancellationToken || typeof result.cancellationToken.cancel !== 'function') {
          throw new Error('Invalid update metadata');
        }
        availableToken = result.cancellationToken;
        const skipped = !manual && nextVersion === preferences.skippedVersion;
        publish({ status: skipped ? 'idle' : 'available', availableVersion: skipped ? null : nextVersion, lastCheckedAt: checkedAt });
        if (skipped) { availableToken.cancel(); availableToken = null; }
      } catch {
        if (current.generation === generation && !quitting) publish({ status: 'error', errorCode: 'check-failed' });
      } finally {
        if (operation === current) operation = null;
      }
      // Auto policy is the durable opt-in. A revoked or stale check cannot download.
      if (current.generation === generation && !quitting && state.policy === 'auto' && state.status === 'available') {
        void downloadUpdate(state.availableVersion);
      }
      return getUpdateState();
    })();
    return current.promise;
  }

  function runNotificationCheck(manual) {
    const abort = new AbortController();
    const current = { kind: 'check', generation, token: { cancel: () => abort.abort() }, promise: null };
    operation = current;
    publish({ status: 'checking', manualCheck: manual, availableVersion: null, errorCode: null });
    // Start in a microtask so even a synchronous loader failure clears the operation.
    current.promise = Promise.resolve().then(async () => {
      try {
        if (current.generation !== generation || quitting) return getUpdateState();
        const manifest = await manifestLoader({ signal: abort.signal, version: state.currentVersion });
        if (current.generation !== generation || quitting) return getUpdateState();
        const nextVersion = availableMacVersion(manifest, state.currentVersion, arch);
        const skipped = !manual && nextVersion && nextVersion === preferences.skippedVersion;
        return publish({ status: skipped ? 'idle' : nextVersion ? 'available' : 'up-to-date',
          availableVersion: skipped ? null : nextVersion, lastCheckedAt: now() });
      } catch {
        if (current.generation === generation && !quitting) publish({ status: 'error', errorCode: 'check-failed' });
        return getUpdateState();
      } finally {
        if (operation === current) operation = null;
      }
    });
    return current.promise;
  }

  function downloadUpdate(versionToDownload) {
    if (operation?.kind === 'download' && operation.generation === generation && versionToDownload === consentVersion) return operation.promise;
    if (state.status === 'ready' && versionToDownload === consentVersion) return Promise.resolve(getUpdateState());
    if (quitting || operation || !state.supported || !validVersion(versionToDownload) || versionToDownload !== state.availableVersion ||
        !availableToken || state.status !== 'available' || (state.policy === 'off' && !state.manualCheck)) {
      return Promise.resolve(publish({ errorCode: 'invalid-request' }));
    }
    consentVersion = versionToDownload;
    const current = { kind: 'download', generation, token: availableToken, promise: null };
    operation = current;
    availableToken = null;
    publish({ status: 'downloading', progress: 0, errorCode: null });
    current.promise = (async () => {
      try {
        await getEngine().downloadUpdate(current.token);
        if (current.generation !== generation || quitting || consentVersion !== versionToDownload) return getUpdateState();
        // No native installer is staged here, including Squirrel.Mac. Handoff
        // happens only from beforeQuit after a real application quit request.
        return publish({ status: 'ready', progress: 100, installOnQuit: true });
      } catch {
        if (current.generation === generation && !quitting) {
          disarm();
          return publish({ status: 'error', progress: null, errorCode: 'download-failed' });
        }
        return getUpdateState();
      } finally {
        if (operation === current) operation = null;
      }
    })();
    return current.promise;
  }

  function skipUpdate(versionToSkip) {
    if (quitting || !validVersion(versionToSkip) || versionToSkip !== state.availableVersion) return publish({ errorCode: 'invalid-request' });
    revoke();
    if (!savePreferences({ ...preferences, skippedVersion: versionToSkip })) return getUpdateState();
    return publish({ skippedVersion: versionToSkip, status: 'idle', availableVersion: null, progress: null, errorCode: null });
  }

  function beforeQuit(event) {
    clearTimer();
    quitting = true;
    if (handoffStarted) {
      if (quitFallback !== null) cancel(quitFallback);
      finishRequestedQuit = null;
      return;
    }
    if (!engine || !state.installOnQuit || state.status !== 'ready' || consentVersion !== state.availableVersion) {
      revoke();
      return;
    }
    handoffStarted = true;
    event.preventDefault();
    let finished = false;
    finishRequestedQuit = () => {
      if (finished) return;
      finished = true;
      if (quitFallback !== null) cancel(quitFallback);
      // This is only a continuation of an explicit quit that was already pending.
      app.quit();
    };
    quitFallback = schedule(finishRequestedQuit, 10_000);
    quitFallback?.unref?.();
    try { engine.quitAndInstall(true, false); }
    catch { finishRequestedQuit(); }
  }

  function start() {
    if (started || quitting) return;
    started = true;
    scheduleCheck(INITIAL_DELAY);
  }
  function dispose() {
    quitting = true;
    clearTimer();
    if (quitFallback !== null) cancel(quitFallback);
    revoke();
  }
  return { getUpdateState, setUpdatePolicy, checkForUpdates: () => runCheck(true), downloadUpdate, skipUpdate, start, beforeQuit, dispose };
}

function registerUpdateIpc({ ipcMain, requireMainRenderer, getController, openDownload }) {
  for (const [channel, method] of [
    ['get-update-state', 'getUpdateState'], ['set-update-policy', 'setUpdatePolicy'],
    ['check-for-updates', 'checkForUpdates'], ['download-update', 'downloadUpdate'], ['skip-update', 'skipUpdate'],
  ]) {
    ipcMain.handle(channel, (event, value) => {
      requireMainRenderer(event);
      return getController()[method](value);
    });
  }
  ipcMain.handle('open-update-download', async event => {
    requireMainRenderer(event);
    try { await openDownload(); return true; }
    catch { return false; }
  });
}

module.exports = { createUpdateController, resolveUpdateSupport, registerUpdateIpc };
