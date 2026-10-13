import { gatherLegacyHistory } from './historyTransfer';
import { createHistoryRecovery } from './historyRecovery';
import type { HistoryStartupResult } from './historyRecovery';
import { TimerSession, PresenceReason } from './timerSession';
import type { AppSettings } from '../types';
import type {} from './notifications';
import type { UpdateState } from './updates';

export interface NativeTimerSnapshot {
  totalMs: number; remainingMs: number; manualPaused: boolean; breakActive: boolean;
  exercising: boolean; expiryPending: boolean; version: number; reasons: PresenceReason[];
  absentSince: number | null; absenceEpoch: number; idleSeconds: number; locked: boolean; suspended: boolean;
  meetingPostponedEpoch?: number; breakElapsed: boolean; breakEndAt?: number | null; focusByDate: Record<string, number>; tickCount: number;
}
interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void> };
  window: { getCurrentWindow(): { startDragging(): Promise<void> } };
}
declare global { interface Window { __TAURI__?: TauriGlobal } }
const frames = new Set<(snapshot: NativeTimerSnapshot) => void>();
const breaks = new Set<() => void>();
const updateListeners = new Set<(state: UpdateState) => void>();
let latest: NativeTimerSnapshot | null = null;
let commandQueue = Promise.resolve();
let exportTimer: ReturnType<typeof setTimeout> | undefined;
let bridgeInitialization: Promise<void> | undefined;
let historyRecovery: ReturnType<typeof createHistoryRecovery> | undefined;

export class NativeTimerSession extends TimerSession {
  advance(now: number): boolean { this.lastUpdated = now; return false; }
}
export function hasNativeTimer(): boolean { return !!window.__TAURI__; }
export function subscribeNativeTimer(callback: (snapshot: NativeTimerSnapshot) => void): () => void {
  frames.add(callback); return () => frames.delete(callback);
}
export function synchronizeNativeTimer(session: TimerSession, settings: AppSettings): void {
  if (!window.__TAURI__) return;
  const input = { totalMs: session.totalMs, remainingMs: session.remainingMs, manualPaused: session.manualPaused,
    breakActive: session.breakActive, exercising: session.exercising, expiryPending: session.expiryPending,
    version: session.version, breakSeconds: settings.breakSeconds, strictMode: settings.strictMode,
    idleEnabled: settings.idleDetectionEnabled, idleThresholdSeconds: settings.idleThresholdMinutes * 60,
    meetingEnabled: settings.meetingDetectionEnabled, autoTakeover: settings.autoTakeoverModal };
  commandQueue = commandQueue.then(async () => {
    latest = await window.__TAURI__!.core.invoke<NativeTimerSnapshot>('configure_timer', { input });
  }).catch(error => console.warn('Blincho: Native timer update failed:', error));
}
export async function readNativeTimer(): Promise<NativeTimerSnapshot | null> {
  if (!window.__TAURI__) return null;
  await commandQueue;
  latest = await window.__TAURI__.core.invoke<NativeTimerSnapshot>('timer_snapshot');
  return latest;
}
export function scheduleLegacyHistoryExport(): void {
  if (!window.electronAPI?.isElectron || window.electronAPI.platform !== 'darwin' || !window.electronAPI.exportLegacyHistory || window.__TAURI__) return;
  clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    try { void window.electronAPI!.exportLegacyHistory!(gatherLegacyHistory(localStorage))
      .catch(error => console.warn('Blincho: History export failed:', error)); }
    catch (error) { console.warn('Blincho: History collection failed:', error); }
  }, 300);
}
export function initializeTauriBridge(): Promise<void> {
  if (!window.__TAURI__) { scheduleLegacyHistoryExport(); return Promise.resolve(); }
  if (!bridgeInitialization) bridgeInitialization = installTauriBridge().catch(error => { bridgeInitialization = undefined; throw error; });
  return bridgeInitialization;
}

export async function initializeTauriHistory(): Promise<void> {
  if (!window.__TAURI__) return;
  historyRecovery ??= createHistoryRecovery(localStorage, () => window.__TAURI__!.core.invoke('legacy_history'));
  const history = await historyRecovery.run();
  reportHistoryStartup(history);
}

export async function continueWithoutTauriHistory(): Promise<void> {
  if (!window.__TAURI__) return;
  historyRecovery ??= createHistoryRecovery(localStorage, () => window.__TAURI__!.core.invoke('legacy_history'));
  const history = await historyRecovery.continueWithoutHistory();
  reportHistoryStartup(history);
}

function reportHistoryStartup(history: HistoryStartupResult): void {
  // Diagnostics must not turn a successfully imported or explicitly skipped profile into a startup failure.
  try {
    void window.__TAURI__!.core.invoke('renderer_report', { report: { ready: true, history, entries: Object.keys(gatherLegacyHistory(localStorage)) } })
      .catch(error => console.warn('Blincho: History startup report failed:', error));
  } catch (error) { console.warn('Blincho: History startup report failed:', error); }
}

async function installTauriBridge(): Promise<void> {
  const api = window.__TAURI__;
  if (!api) return;
  const info = await api.core.invoke<{ platform: 'darwin' | 'win32' | 'linux'; meetingDetectionSupported: boolean }>('desktop_info');
  document.documentElement.dataset.platform = info.platform;
  document.documentElement.dataset.runtime = 'tauri';
  const command = (operation: string, flag?: boolean) => api.core.invoke<void>('desktop_command', { operation, flag: flag ?? null });
  window.electronAPI = {
    isElectron: true, // Compatibility adapter for the existing shared UI and desktop detection.
    platform: info.platform,
    meetingDetectionSupported: info.meetingDetectionSupported,
    checkMeetingActive: () => api.core.invoke('check_meeting_active'),
    requestNotificationPermission: () => api.core.invoke<boolean>('notification_permission'),
    showNotification: (title, body) => { void api.core.invoke('notification_send', {title, body}).catch(error => console.warn('Blincho: Notification failed:', error)); },
    flashWindow: () => { void api.core.invoke('attention').catch(error => console.warn('Blincho: Attention failed:', error)); },
    setLocale: locale => api.core.invoke('set_locale', { locale }),
    getUpdateState: () => api.core.invoke<UpdateState>('update_get_state'),
    setUpdatePolicy: policy => api.core.invoke<UpdateState>('update_set_policy', {policy}),
    checkForUpdates: () => api.core.invoke<UpdateState>('update_check'),
    downloadUpdate: version => api.core.invoke<UpdateState>('update_download', {version}),
    skipUpdate: version => api.core.invoke<UpdateState>('update_skip', {version}),
    onUpdateState: callback => { updateListeners.add(callback); return () => updateListeners.delete(callback); },
    openUpdateDownload: () => api.core.invoke<boolean>('update_open_download'),
    setAlwaysOnTop: flag => command('alwaysOnTop', flag), bringToFront: () => command('show'),
    setBreakFullscreen: flag => command('fullscreen', flag), minimizeToTray: () => command('hide'),
    setStrictLock: flag => command('strict', flag),
    getSystemIdleTime: async () => (await readNativeTimer())!.idleSeconds,
    getPowerState: async () => { const snapshot = (await readNativeTimer())!; return { locked: snapshot.locked, suspended: snapshot.suspended }; },
    getPreferredLanguages: () => api.core.invoke<string[]>('preferred_languages'),
    onTriggerBreak: callback => { breaks.add(callback); return () => breaks.delete(callback); },
  };
  const unlisten: Array<() => void> = [];
  try {
    unlisten.push(await api.event.listen<NativeTimerSnapshot>('native-timer', event => {
      latest = event.payload;
      for (const callback of frames) callback(event.payload);
    }));
    unlisten.push(await api.event.listen<UpdateState>('update-state', event => { for (const callback of updateListeners) callback(event.payload); }));
    unlisten.push(await api.event.listen('trigger-break', () => { for (const callback of breaks) callback(); }));
  } catch (error) {
    for (const unsubscribe of unlisten) unsubscribe();
    throw error;
  }
  document.addEventListener('click', event => {
    const anchor = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || !anchor.href.startsWith('https:')) return;
    event.preventDefault();
    void api.core.invoke('open_external', {url:anchor.href}).catch(error => console.warn('Blincho: External link failed:', error));
  });
  document.addEventListener('mousedown' , event => {
    if ((event.target as HTMLElement)?.closest('.mac-titlebar-drag') && !(event.target as HTMLElement)?.closest('button,input,a')) {
      void api.window.getCurrentWindow().startDragging().catch(error => console.warn('Blincho: Drag failed:', error));
    }
  });
}
