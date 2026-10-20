const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
}, { once: true });

let cameraGeneration;
let cameraRevision = 0;

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  meetingDetectionSupported: process.platform === 'darwin',
  configureLocalMcp: enabled => ipcRenderer.invoke('local-mcp-configure', enabled),
  getLocalMcpState: () => ipcRenderer.invoke('local-mcp-status'),
  publishLocalMcp: snapshot => ipcRenderer.invoke('local-mcp-publish', snapshot),
  takeLocalMcpCommands: () => ipcRenderer.invoke('local-mcp-take-commands'),
  getPreferredLanguages: () => ipcRenderer.invoke('get-preferred-languages'),
  setLocale: (locale) => ipcRenderer.invoke('set-locale', locale),
  setCameraActivity: async (active, label) => {
    cameraGeneration ??= ipcRenderer.invoke('camera-activity-generation');
    const generation = await cameraGeneration;
    return ipcRenderer.invoke('camera-activity-update', { generation, revision: ++cameraRevision, active, label });
  },
  setSymbioteBuild: mask => ipcRenderer.invoke('set-symbiote-build', mask),
  syncSymbioteShortcut: (mask, name) => ipcRenderer.invoke('sync-symbiote-shortcut', mask, name),
  createSymbioteShortcut: (mask, name) => ipcRenderer.invoke('create-symbiote-shortcut', mask, name),
  getSymbioteShortcutStatus: () => ipcRenderer.invoke('get-symbiote-shortcut-status'),
  showSymbioteShortcut: () => ipcRenderer.invoke('show-symbiote-shortcut'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  setUpdatePolicy: (policy) => ipcRenderer.invoke('set-update-policy', policy),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (version) => ipcRenderer.invoke('download-update', version),
  skipUpdate: (version) => ipcRenderer.invoke('skip-update', version),
  openUpdateDownload: () => ipcRenderer.invoke('open-update-download'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update-state', listener);
    return () => ipcRenderer.removeListener('update-state', listener);
  },
  showNotification: (title, body) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  flashWindow: () => {
    ipcRenderer.send('flash-window');
  },
  setAlwaysOnTop: (flag) => {
    ipcRenderer.send('set-always-on-top', flag);
  },
  bringToFront: (options) => {
    ipcRenderer.send('bring-to-front', options);
  },
  setBreakFullscreen: (flag) => ipcRenderer.send('set-break-fullscreen', Boolean(flag)),
  minimizeToTray: () => {
    ipcRenderer.send('minimize-to-tray');
  },
  getSystemIdleTime: () => ipcRenderer.invoke('get-system-idle-time'),
  getPowerState: () => ipcRenderer.invoke('get-power-state'),
  lockComputer: () => ipcRenderer.invoke('lock-computer'),
  checkMeetingActive: options => ipcRenderer.invoke('check-meeting-active', options),
  setStrictLock: (flag) => {
    ipcRenderer.send('set-strict-lock', flag);
  },
  onPowerStateChange: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on('power-state-change', listener);
    return () => ipcRenderer.removeListener('power-state-change', listener);
  },
  onTriggerBreak: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('trigger-break', listener);
    return () => ipcRenderer.removeListener('trigger-break', listener);
  },
});
