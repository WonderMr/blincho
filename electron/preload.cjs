const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
}, { once: true });

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  meetingDetectionSupported: process.platform === 'darwin',
  getPreferredLanguages: () => ipcRenderer.invoke('get-preferred-languages'),
  setLocale: (locale) => ipcRenderer.invoke('set-locale', locale),
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
  checkMeetingActive: () => ipcRenderer.invoke('check-meeting-active'),
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
