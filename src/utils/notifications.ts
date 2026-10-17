// Cross-platform Notification Dispatcher (Electron IPC & Web Notifications)
import type { UpdateBridge } from './updates';
import type { LocalMcpBridge } from './localMcp';

declare global {
  interface Window {
    electronAPI?: UpdateBridge & LocalMcpBridge & {
      requestNotificationPermission?: () => Promise<boolean>;
      showNotification: (title: string, body: string) => void;
      flashWindow: () => void;
      setAlwaysOnTop: (flag: boolean) => void;
      bringToFront?: (options?: { alwaysOnTop?: boolean }) => void;
      setBreakFullscreen?: (flag: boolean) => void;
      minimizeToTray?: () => void;
      getSystemIdleTime?: () => Promise<number>;
      checkMeetingActive?: () => Promise<{ inMeeting: boolean; details?: string; supported?: boolean }>;
      meetingDetectionSupported?: boolean;
      getPowerState?: () => Promise<{ suspended: boolean; locked: boolean }>;
      lockComputer?: () => Promise<boolean>;
      setStrictLock?: (flag: boolean) => void;
      onPowerStateChange?: (callback: (state: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen') => void) => (() => void);
      onTriggerBreak?: (callback: () => void) => (() => void);
      isElectron: boolean;
      platform?: string;
      getPreferredLanguages?: () => Promise<string[]>;
      setLocale?: (locale: string) => Promise<void>;
      exportLegacyHistory?: (entries: Record<string, string>) => Promise<{ exportedAt: string; entryCount: number }>;
    };
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (window.electronAPI?.requestNotificationPermission) {
    try { return await window.electronAPI.requestNotificationPermission(); } catch { return false; }
  }
  if (window.electronAPI?.isElectron) {
    return true;
  }
  if (!('Notification' in window)) {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission !== 'denied') {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }
  return false;
}

export function showEyeBreakNotification(title: string, body: string): void {
  // Try Electron IPC first
  if (window.electronAPI?.showNotification) {
    const dispatch = (action: string, operation: () => unknown) => {
      try { Promise.resolve(operation()).catch(error => console.warn(`Blincho: ${action} failed:`, error)); }
      catch (error) { console.warn(`Blincho: ${action} failed:`, error); }
    };
    dispatch('show notification', () => window.electronAPI?.showNotification(title, body));
    dispatch('flash notification window', () => window.electronAPI?.flashWindow());
    return;
  }

  // Fallback to Web Notification API
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%2338bdf8"><circle cx="12" cy="12" r="10"/></svg>',
      });
    } catch {
      // Notification blocked or restricted
    }
  }
}
