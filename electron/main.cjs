const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, powerMonitor, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { performance } = require('node:perf_hooks');
const { createLinuxSessionProbe } = require('./linuxSession.cjs');
const { locales, isLocale, resolveLocale } = require('./locales.cjs');
const { createUpdateController, registerUpdateIpc } = require('./updater.cjs');

// Keep the existing profile across the MyEyes → Blincho rename, including
// Chromium localStorage and the single-instance lock. Configure before ready.
const legacyProfilePath = path.join(app.getPath('appData'), 'myeyes');
fs.mkdirSync(legacyProfilePath, { recursive: true });
app.setName('Blincho');
app.setPath('userData', legacyProfilePath);
app.setPath('sessionData', legacyProfilePath);
if (process.platform === 'win32') app.setAppUserModelId('com.myeyes.app');
if (process.platform === 'linux') app.setDesktopName('com.myeyes.app.desktop');

const appIconPath = path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let nativeLocale = 'en';
let updateController = null;

function preferredSystemLanguages() {
  try {
    const languages = app.getPreferredSystemLanguages();
    return Array.isArray(languages) ? languages.filter(value => typeof value === 'string' && value.length <= 80).slice(0, 50) : [];
  } catch { return []; }
}

function requireMainRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('IPC is restricted to the main renderer');
  }
}

function updateNativeLanguage() {
  const text = locales[nativeLocale];
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(text.title);
  const quit = () => { isStrictLockActive = false; app.quit(); };
  const actions = [
    { label: text.show, click: () => showMainWindow() },
    { label: text.breakNow, click: () => triggerBreakFromTray() },
    { type: 'separator' },
    { label: text.quit, click: quit },
  ];
  if (tray) {
    tray.setToolTip(text.title);
    tray.setContextMenu(Menu.buildFromTemplate(actions));
  }
  const appItems = process.platform === 'darwin' ? [
    { label: text.about, role: 'about' }, { type: 'separator' },
    ...actions.slice(0, 2), { type: 'separator' },
    { label: text.hide, role: 'hide' }, { label: text.hideOthers, role: 'hideOthers' },
    { label: text.showAll, role: 'unhide' }, { type: 'separator' },
    { label: text.quit, role: 'quit' },
  ] : actions;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Blincho', submenu: appItems },
    { label: text.edit, submenu: [
      { label: text.undo, role: 'undo' }, { label: text.redo, role: 'redo' }, { type: 'separator' },
      { label: text.cut, role: 'cut' }, { label: text.copy, role: 'copy' }, { label: text.paste, role: 'paste' },
      { label: text.selectAll, role: 'selectAll' },
    ] },
    { label: text.window, submenu: [
      { label: text.minimize, role: 'minimize' }, { label: text.zoom, role: 'zoom' },
      ...(process.platform === 'darwin' ? [{ type: 'separator' }, { label: text.front, role: 'front' }] : []),
    ] },
  ]));
}

let isStrictLockActive = false;
let suspended = false;
let locked = false;
let linuxPresenceConfirmed = process.platform !== 'linux';
let linuxProbeFailureReported = false;
let powerGeneration = 0;
const linuxSession = process.platform === 'linux' ? createLinuxSessionProbe({ execute: execFile, env: process.env, now: () => performance.now() }) : null;
let breakWindowState = null;
let fullscreenGeneration = 0;
const diagnosticEvents = [];
let diagnosticsWarningReported = false;

function recordRuntimeEvent(event) {
  try {
    const windowExists = !!mainWindow && !mainWindow.isDestroyed();
    const snapshot = {
      suspended, locked, strictLockActive: isStrictLockActive, quitting: isQuitting,
      windowExists,
      windowVisible: windowExists ? mainWindow.isVisible() : false,
      fullscreen: windowExists ? mainWindow.isFullScreen() : false,
      alwaysOnTop: windowExists ? mainWindow.isAlwaysOnTop() : false,
    };
    const recordedAt = new Date().toISOString();
    diagnosticEvents.push({ event, recordedAt, ...snapshot });
    if (diagnosticEvents.length > 60) diagnosticEvents.splice(0, diagnosticEvents.length - 60);
    const directory = app.getPath('userData');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'runtime-diagnostics.json');
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, recordedAt, current: snapshot, events: diagnosticEvents }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!diagnosticsWarningReported) {
      diagnosticsWarningReported = true;
      console.warn('Blincho: Local runtime diagnostics unavailable:', error);
    }
  }
}

function safely(action, operation) {
  try { return operation(); }
  catch (error) { console.warn(`Blincho: ${action} failed:`, error); }
}

function setBreakFullscreen(active) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!active && !breakWindowState) return;
  const window = mainWindow;
  const generation = ++fullscreenGeneration;
  if (active) {
    if (!breakWindowState) breakWindowState = {
      bounds: window.getBounds(), fullscreen: window.isFullScreen(), maximized: window.isMaximized(),
    };
    window.setFullScreen(true);
  } else if (breakWindowState) {
    const previous = breakWindowState;
    breakWindowState = null;
    if (previous.fullscreen) return;
    const restore = () => {
      if (generation !== fullscreenGeneration || window.isDestroyed()) return;
      safely('restore window bounds', () => {
        if (previous.maximized) window.maximize();
        else window.setBounds(previous.bounds);
      });
    };
    if (process.platform === 'darwin' && window.isFullScreen()) {
      window.once('leave-full-screen', restore);
      window.setFullScreen(false);
    } else {
      window.setFullScreen(false);
      restore();
    }
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

app.on('before-quit', event => {
  isQuitting = true;
  updateController?.beforeQuit(event);
  powerGeneration += 1;
  linuxSession?.invalidate();
  isStrictLockActive = false;
  recordRuntimeEvent('before-quit');
});

function showMainWindow() {
  if (isQuitting || suspended || locked) return null;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  recordRuntimeEvent('show-window');
  return mainWindow;
}

function triggerBreakFromTray() {
  const window = showMainWindow();
  if (!window) return;
  const trigger = () => {
    if (!isQuitting && !suspended && !locked && mainWindow === window && !window.isDestroyed()) {
      window.webContents.send('trigger-break');
    }
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', trigger);
  else trigger();
}

function putWindowInBackground() {
  if (!mainWindow || mainWindow.isDestroyed() || isStrictLockActive) return;
  // Linux desktops may accept Tray construction without displaying an icon.
  // Keep a taskbar entry there, and on Windows if tray setup failed.
  if (process.platform === 'linux' || (process.platform === 'win32' && !tray)) {
    mainWindow.minimize();
    recordRuntimeEvent('close-to-taskbar');
  } else {
    mainWindow.hide();
    recordRuntimeEvent('close-to-tray');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: locales[nativeLocale].title,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: appIconPath,
    backgroundColor: '#070a12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // This local renderer owns the break clock even while the window is hidden.
      backgroundThrottling: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  const isDev = !app.isPackaged;

  if (isDev && (process.argv.includes('--dev') || process.env.VITE_DEV_SERVER === 'true' || process.env.VITE_DEV_SERVER_URL)) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Prevent closing, minimizing, or hiding window during active strict mode eye break
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    if (isStrictLockActive) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(true);
      return;
    }
    putWindowInBackground();
  });

  mainWindow.on('minimize', (e) => {
    if (isStrictLockActive) {
      e.preventDefault();
      mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('blur', () => {
    if (isStrictLockActive && !suspended && !locked && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    breakWindowState = null;
    fullscreenGeneration += 1;
    isStrictLockActive = false;
    recordRuntimeEvent('window-closed');
  });
  for (const event of ['show', 'hide', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, () => recordRuntimeEvent(`window-${event}`));
  }
  recordRuntimeEvent('window-created');
}

// IPC Handlers
registerUpdateIpc({ ipcMain, requireMainRenderer, getController: () => updateController,
  openDownload: () => shell.openExternal('https://blincho.app/#download') });

ipcMain.handle('get-preferred-languages', event => {
  requireMainRenderer(event);
  return preferredSystemLanguages();
});

ipcMain.handle('set-locale', (event, locale) => {
  requireMainRenderer(event);
  if (!isLocale(locale)) throw new TypeError('Unsupported locale');
  if (nativeLocale !== locale) {
    nativeLocale = locale;
    updateNativeLanguage();
  }
});

ipcMain.on('show-notification', (event, payload) => {
  const { title, body } = payload && typeof payload === 'object' ? payload : {};
  if (Notification.isSupported()) {
    const safeTitle = String(title || locales[nativeLocale].notificationTitle).slice(0, 100);
    const safeBody = String(body || locales[nativeLocale].notificationBody).slice(0, 300);
    const notification = new Notification({
      title: safeTitle,
      body: safeBody,
      silent: false,
      ...(process.platform === 'linux' ? { icon: appIconPath } : {}),
    });
    notification.show();
    notification.on('click', () => showMainWindow());
  }
});

ipcMain.on('set-strict-lock', (event, flag) => {
  isStrictLockActive = Boolean(flag) && !suspended && !locked && linuxPresenceConfirmed;
  recordRuntimeEvent('strict-lock-changed');
});

ipcMain.on('set-break-fullscreen', (event, flag) => safely('set break fullscreen', () => setBreakFullscreen(Boolean(flag) && !suspended && !locked && linuxPresenceConfirmed)));

ipcMain.on('flash-window', () => {
  if (mainWindow) {
    mainWindow.flashFrame(true);
  }
});

ipcMain.on('set-always-on-top', (event, flag) => {
  if (mainWindow) {
    safely('set always on top', () => mainWindow.setAlwaysOnTop(Boolean(flag) && !suspended && !locked && linuxPresenceConfirmed));
  }
});

ipcMain.on('bring-to-front', (event, payload) => {
  const { alwaysOnTop = false } = payload && typeof payload === 'object' ? payload : {};
  if (mainWindow && !mainWindow.isDestroyed() && !suspended && !locked && linuxPresenceConfirmed) {
    safely('bring window to front', () => {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      if (alwaysOnTop) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      mainWindow.flashFrame(true);
    });
  }
});

ipcMain.on('minimize-to-tray', () => putWindowInBackground());

ipcMain.handle('get-system-idle-time', () => {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch (err) {
    throw new Error('System idle time is unavailable');
  }
});

function releaseBreakPresentation() {
  isStrictLockActive = false;
  safely('release always on top for absence', () => mainWindow?.setAlwaysOnTop(false));
  safely('restore fullscreen for absence', () => setBreakFullscreen(false));
}

function observeScreenLock(nextLocked, source) {
  if (locked === nextLocked) return;
  locked = nextLocked;
  invalidateMeetingCache();
  if (locked) releaseBreakPresentation();
  recordRuntimeEvent(source);
  if (mainWindow && !mainWindow.isDestroyed()) {
    safely('notify sampled screen lock', () => mainWindow.webContents.send('power-state-change', locked ? 'lock-screen' : 'unlock-screen'));
  }
}

function nativePowerState() {
  const state = powerMonitor.getSystemIdleState(1);
  if (!['active', 'idle', 'locked'].includes(state)) throw new Error('System power state is unconfirmed');
  // Preserve observed lock events through transient active samples until unlock.
  if (state === 'locked') observeScreenLock(true, 'observed-screen-lock');
  return { suspended, locked };
}

ipcMain.handle('get-power-state', () => {
  if (!linuxSession) return nativePowerState();
  if (suspended || isQuitting) return { suspended, locked };
  const generation = powerGeneration;
  return linuxSession.sample().then(session => {
    if (generation !== powerGeneration) throw new Error('System power state sample is stale');
    // Read Electron after the asynchronous query, never reuse pre-sleep state.
    const state = powerMonitor.getSystemIdleState(1);
    if (!['active', 'idle', 'locked'].includes(state)) throw new Error('System power state is unconfirmed');
    linuxPresenceConfirmed = true;
    // Linux has no native unlock event: a fresh unlocked sample must recover.
    observeScreenLock(session.locked || state === 'locked', session.locked || state === 'locked' ? 'linux-session-locked' : 'linux-session-unlocked');
    if (linuxProbeFailureReported) {
      linuxProbeFailureReported = false;
      recordRuntimeEvent('linux-session-recovered');
    }
    return { suspended, locked };
  }).catch(error => {
    if (generation === powerGeneration) {
      linuxPresenceConfirmed = false;
      releaseBreakPresentation();
      if (!linuxProbeFailureReported) {
        linuxProbeFailureReported = true;
        recordRuntimeEvent('linux-session-unconfirmed');
      }
    }
    throw error;
  });
});

function hasActiveMeetingAssertion(output) {
  const summary = output.match(/^\s*PreventUserIdleDisplaySleep\s+(\d+)\s*$/m);
  if (!summary || Number(summary[1]) === 0) return false;
  return output.split('\n').some(line => {
    const assertion = line.match(/\bpid\s+\d+\((.+?)\):.*?\b\d+:\d+:\d+\s+(\w+)\s+named:\s*"([^"]*)"/i);
    if (!assertion || assertion[2] !== 'PreventUserIdleDisplaySleep') return false;
    const owner = assertion[1].trim();
    const name = assertion[3];
    const knownOwner = /^(?:zoom(?:\.us)?|cpthost|microsoft teams|teams|webex|skype|facetime)$/i.test(owner);
    const browserOwner = /^(?:google chrome|chromium|safari|firefox|microsoft edge)$/i.test(owner);
    return knownOwner || (browserOwner && /^(?:WebRTC(?:\b.*)?|.*meet\.google\.com.*)$/i.test(name));
  });
}

const MEETING_CACHE_MS = 10000;
let meetingCache = null;
let meetingCheck = null;
let meetingGeneration = 0;

function invalidateMeetingCache() {
  meetingCache = null;
  meetingGeneration += 1;
}

function runMeetingProbe(file, args, matches) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 1000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(!error && matches(stdout || ''));
    });
  });
}

ipcMain.handle('check-meeting-active', async () => {
  if (process.platform !== 'darwin') return { inMeeting: false, supported: false };
  if (suspended || locked || isQuitting) return { inMeeting: false, supported: true };
  if (meetingCache && performance.now() - meetingCache.at < MEETING_CACHE_MS) return meetingCache.value;
  if (meetingCheck) return meetingCheck;
  const generation = meetingGeneration;
  meetingCheck = (async () => {
    // No shell process; avoid a second native probe when an assertion suffices.
    const activeAssertion = await runMeetingProbe('/usr/bin/pmset', ['-g', 'assertions'], hasActiveMeetingAssertion);
    if (generation !== meetingGeneration || suspended || locked || isQuitting) return { inMeeting: false, supported: true };
    const inMeeting = activeAssertion || await runMeetingProbe('/usr/bin/pgrep', ['-i', 'CptHost'], output => /^\d+$/m.test(output.trim()));
    if (generation !== meetingGeneration || suspended || locked || isQuitting) return { inMeeting: false, supported: true };
    const value = { inMeeting, supported: true,
      details: inMeeting ? 'Обнаружен процесс встречи или активное удержание экрана' : undefined };
    meetingCache = { at: performance.now(), value };
    return value;
  })();
  try { return await meetingCheck; }
  finally { meetingCheck = null; }
});

app.whenReady().then(() => {
  if (!gotTheLock || isQuitting) return;
  nativeLocale = resolveLocale(preferredSystemLanguages());
  updateController = createUpdateController({
    app, fileSystem: fs, platform: process.platform, arch: process.arch, env: process.env,
    onState: state => {
      if (mainWindow && !mainWindow.isDestroyed() && !isQuitting) {
        mainWindow.webContents.send('update-state', state);
      }
    },
  });
  createWindow();
  updateNativeLanguage();
  updateController.start();

  // Listen to OS sleep, wake, lock and unlock to notify renderer
  powerMonitor.on('suspend', () => {
    invalidateMeetingCache();
    powerGeneration += 1;
    linuxSession?.invalidate();
    if (linuxSession) linuxPresenceConfirmed = false;
    suspended = true;
    releaseBreakPresentation();
    recordRuntimeEvent('suspend');
    if (mainWindow && !mainWindow.isDestroyed()) {
      safely('notify suspend', () => mainWindow.webContents.send('power-state-change', 'suspend'));
    }
  });

  powerMonitor.on('resume', () => {
    invalidateMeetingCache();
    powerGeneration += 1;
    linuxSession?.invalidate();
    if (linuxSession) linuxPresenceConfirmed = false;
    suspended = false;
    recordRuntimeEvent('resume');
    if (mainWindow && !mainWindow.isDestroyed()) {
      safely('notify resume', () => mainWindow.webContents.send('power-state-change', 'resume'));
    }
  });

  powerMonitor.on('lock-screen', () => {
    invalidateMeetingCache();
    powerGeneration += 1;
    linuxSession?.invalidate();
    if (linuxSession) linuxPresenceConfirmed = false;
    locked = true;
    releaseBreakPresentation();
    recordRuntimeEvent('lock-screen');
    if (mainWindow && !mainWindow.isDestroyed()) {
      safely('notify lock', () => mainWindow.webContents.send('power-state-change', 'lock-screen'));
    }
  });

  powerMonitor.on('unlock-screen', () => {
    invalidateMeetingCache();
    powerGeneration += 1;
    linuxSession?.invalidate();
    if (linuxSession) linuxPresenceConfirmed = false;
    locked = false;
    recordRuntimeEvent('unlock-screen');
    if (mainWindow && !mainWindow.isDestroyed()) {
      safely('notify unlock', () => mainWindow.webContents.send('power-state-change', 'unlock-screen'));
    }
  });

  // Use the bundled brand in native formats, with a template for macOS themes.
  try {
    let icon = appIconPath;
    if (process.platform !== 'win32') {
      if (process.platform === 'darwin') {
        icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets/trayTemplate.png'));
        if (!icon.isEmpty()) icon.setTemplateImage(true);
      }
      if (typeof icon === 'string' || icon.isEmpty()) {
        icon = nativeImage.createFromPath(appIconPath).resize({ width: process.platform === 'darwin' ? 16 : 24, height: process.platform === 'darwin' ? 16 : 24 });
      }
    }

    if (typeof icon === 'string' || !icon.isEmpty()) {
      tray = new Tray(icon);
      updateNativeLanguage();
      if (process.platform !== 'darwin') tray.on('click', () => showMainWindow());
    }
  } catch (error) {
    tray = null;
    console.warn('Blincho: Tray unavailable; window remains accessible from Dock/taskbar:', error);
  }

  app.on('activate', () => showMainWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
