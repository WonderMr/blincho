export interface SymbioteShortcutStatus { supported: boolean; exists: boolean; path?: string | null }
// Cross-platform Notification Dispatcher (Tauri commands & Web Notifications)
import type { UpdateBridge } from './updates';
import type { LocalMcpBridge } from './localMcp';
import { getCurrentSymbioteIconPath } from './symbioteIcons';

declare global {
  interface Window {
    desktopAPI?: UpdateBridge & LocalMcpBridge & {
      requestNotificationPermission?: () => Promise<boolean>;
      showNotification: (title: string, body: string) => void;
      flashWindow: () => void;
      setAlwaysOnTop: (flag: boolean) => void;
      setCameraActivity?: (active: boolean, label: string) => Promise<void>;
      setSymbioteBuild?: (mask: number) => Promise<void>;
      syncSymbioteShortcut?: (mask: number, name: string) => Promise<SymbioteShortcutStatus>;
      createSymbioteShortcut?: (mask: number, name: string) => Promise<SymbioteShortcutStatus>;
      getSymbioteShortcutStatus?: () => Promise<SymbioteShortcutStatus>;
      showSymbioteShortcut?: () => Promise<boolean>;
      bringToFront?: (options?: { alwaysOnTop?: boolean }) => void;
      setBreakFullscreen?: (flag: boolean) => void;
      minimizeToTray?: () => void;
      getSystemIdleTime?: () => Promise<number>;
      checkMeetingActive?: (options?: { fresh?: boolean }) => Promise<{ inMeeting: boolean; details?: string; supported?: boolean }>;
      meetingDetectionSupported?: boolean;
      getPowerState?: () => Promise<{ suspended: boolean; locked: boolean }>;
      lockComputer?: () => Promise<boolean>;
      setStrictLock?: (flag: boolean) => void;
      onPowerStateChange?: (callback: (state: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen') => void) => (() => void);
      onTriggerBreak?: (callback: () => void) => (() => void);
      isDesktop: boolean;
      platform?: string;
      getPreferredLanguages?: () => Promise<string[]>;
      setLocale?: (locale: string) => Promise<void>;
    };
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (window.desktopAPI?.requestNotificationPermission) {
    try { return await window.desktopAPI.requestNotificationPermission(); } catch { return false; }
  }
  if (window.desktopAPI?.isDesktop) {
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
  // Use native notifications when running on desktop
  if (window.desktopAPI?.showNotification) {
    const dispatch = (action: string, operation: () => unknown) => {
      try { Promise.resolve(operation()).catch(error => console.warn(`Blincho: ${action} failed:`, error)); }
      catch (error) { console.warn(`Blincho: ${action} failed:`, error); }
    };
    dispatch('show notification', () => window.desktopAPI?.showNotification(title, body));
    dispatch('flash notification window', () => window.desktopAPI?.flashWindow());
    return;
  }

  // Fallback to Web Notification API
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body,
        icon: getCurrentSymbioteIconPath(),
      });
    } catch {
      // Notification blocked or restricted
    }
  }
}
