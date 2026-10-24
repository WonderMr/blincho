import { useEffect, useRef } from 'react';
import type { AppSettings, DayStats } from '../types';
import type { McpStats } from './mcpStats';

export interface LocalMcpState {
  enabled: boolean;
  running: boolean;
  url: string | null;
  token: string | null;
  error: string | null;
}
export interface LocalMcpSnapshot {
  status: { isRunning: boolean; isBreakActive: boolean; breakElapsed: boolean; strictMode: boolean;
    isIdlePaused: boolean; exercising: boolean; secondsRemaining: number; presenceReasons: string[]; cameraChecking: boolean;
    timerVersion: number; breakEventId: string | null };
  settings: AppSettings;
  todayStats: Pick<DayStats, 'date' | 'breaksCompleted' | 'exercisesCompleted' | 'focusMinutes'>;
  stats: McpStats;
}
export interface LocalMcpCommand { name: string; timerVersion: number; breakEventId: string | null }
export interface LocalMcpBridge {
  configureLocalMcp?: (enabled: boolean) => Promise<LocalMcpState>;
  getLocalMcpState?: () => Promise<LocalMcpState>;
  publishLocalMcp?: (snapshot: LocalMcpSnapshot) => Promise<void>;
  takeLocalMcpCommands?: () => Promise<LocalMcpCommand[]>;
}

// Credentials stay in the desktop process and the connection UI. The server
// receives only timer settings and aggregate counters, without history or images.
export function useLocalMcp(enabled: boolean, snapshot: () => LocalMcpSnapshot,
  execute: (command: LocalMcpCommand, isCurrent: () => boolean) => void | Promise<void>): void {
  const current = useRef({ snapshot, execute });
  current.current = { snapshot, execute };
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api?.configureLocalMcp) return;
    let cancelled = false, busy = false;
    const tick = async () => {
      if (busy || cancelled || !enabled) return;
      busy = true;
      try {
        await api.publishLocalMcp?.(current.current.snapshot());
        if (cancelled) return;
        for (const command of await api.takeLocalMcpCommands?.() ?? []) {
          if (cancelled) break;
          await current.current.execute(command, () => !cancelled);
        }
      } catch (error) { console.warn('Blincho: Local MCP synchronization failed:', error); }
      finally { busy = false; }
    };
    void api.configureLocalMcp(enabled).then(() => tick()).catch(error => console.warn('Blincho: Local MCP configuration failed:', error));
    const interval = enabled ? setInterval(() => { void tick(); }, 500) : undefined;
    return () => { cancelled = true; clearInterval(interval); void api.configureLocalMcp!(false).catch(error => console.warn('Blincho: Local MCP shutdown failed:', error)); };
  }, [enabled]);
}

export function localMcpConnection(state: LocalMcpState): string {
  return JSON.stringify({ mcpServers: { blincho: { url: state.url, headers: { Authorization: `Bearer ${state.token}` } } } }, null, 2);
}
