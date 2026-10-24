import { useEffect, useRef, useState } from 'react';
import type { AppSettings, DayStats } from '../types';
import { deriveSyncKey, encryptSync, decryptSync } from './syncCrypto';
import { applySyncSettings, projectSyncSettings, projectSyncStats, validateSyncStats } from './syncData';

export const SYNC_SERVER_URL = 'https://back.blincho.app';
export type SyncStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface SyncControls {
  status: SyncStatus;
  error: 'key' | 'connection' | null;
  account: string | null;
  connect: (mode: 'register' | 'login', email: string, password: string, recoveryKey: string, registrationCode: string) => Promise<void>;
  disconnect: () => void;
  deleteAccount: (password: string) => Promise<void>;
}
export interface SharedBreak {
  v: 1; id: string; deviceId: string; createdAt: number; startAt: number; endAt: number;
}
interface Callbacks {
  snapshot: () => { settings: AppSettings; stats: DayStats[] };
  settings: (settings: unknown) => void;
  stats: (snapshots: DayStats[][]) => void;
  breakGeneration?: () => number;
  break: (event: SharedBreak, isCurrent: () => boolean) => void | Promise<void>;
  status: (status: SyncStatus) => void;
}
interface Envelope { v: 1; iv: string; ciphertext: string }
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const idPattern = /^[a-f0-9]{32}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateSharedBreak(value: unknown, now = Date.now()): SharedBreak {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'createdAt,deviceId,endAt,id,startAt,v' || value.v !== 1 ||
    typeof value.id !== 'string' || !idPattern.test(value.id) || typeof value.deviceId !== 'string' || !idPattern.test(value.deviceId) ||
    ![value.createdAt, value.startAt, value.endAt].every(time => typeof time === 'number' && Number.isSafeInteger(time))) throw new Error('Invalid break');
  const event = value as unknown as SharedBreak;
  if (event.createdAt > now + 5000 || now - event.createdAt > 600_000 || event.startAt < event.createdAt ||
    event.startAt - event.createdAt > 5000 || event.startAt > now + 5000 || event.endAt <= now ||
    event.endAt - event.startAt < 1000 || event.endAt - event.startAt > 1_800_000) throw new Error('Expired or invalid break');
  return event;
}

function deviceIdFor(accountId: string, storage: Storage): string {
  const key = `blincho_sync_device_${accountId}`;
  const previous = storage.getItem(key);
  if (previous && idPattern.test(previous)) return previous;
  const id = hexId();
  storage.setItem(key, id);
  return id;
}

async function responseJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 12 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export class AccountSyncSession {
  private token = '';
  private accountId = '';
  private deviceId = '';
  private key: CryptoKey | null = null;
  private closed = false;
  private controllers = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scheduled: { event: SharedBreak; timer: ReturnType<typeof setTimeout> } | null = null;
  private busy = false;
  private cursor = 0;
  private instance = '';
  private seen = new Set<string>();
  private localBreakGenerations = new Map<string, number | undefined>();
  private revisions = new Map<string, number>();
  private pendingSettings: Partial<ReturnType<typeof projectSyncSettings>> | null = null;
  private localSettings: ReturnType<typeof projectSyncSettings>;
  private statsJSON = '';
  private nextStateAt = 0;
  private nextStatsAt = 0;
  constructor(private callbacks: Callbacks, private storage: Storage = localStorage,
    private baseUrl = SYNC_SERVER_URL, private fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid sync endpoint');
    this.baseUrl = url.origin;
    this.localSettings = projectSyncSettings(callbacks.snapshot().settings);
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), path.startsWith('/v1/events') ? 5000 : 15_000);
    try {
      const response = await this.fetcher(this.baseUrl + path, { method, signal: controller.signal, cache: 'no-store',
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 401) {
        this.close();
        this.callbacks.status('disconnected');
        throw new Error('Sync authorization expired');
      }
      if (!response.ok) throw new Error(response.status === 409 ? 'Conflict' : 'Sync request failed');
      if (response.status === 204) return null;
      const value = await responseJSON(response);
      if (this.closed) throw new Error('Closed');
      return value;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async connect(mode: 'register' | 'login', email: string, password: string, secret: string, registrationCode: string): Promise<void> {
    let keyCheck: Envelope | undefined;
    if (mode === 'register') {
      this.accountId = hexId();
      this.key = await deriveSyncKey(secret, this.accountId);
      keyCheck = await encryptSync(this.key, this.accountId, 'key-check', { check: 'blincho-sync-v1' });
    }
    const auth = await this.request(`/v1/${mode}`, 'POST', { email, password,
      ...(mode === 'register' ? { registrationCode, accountId: this.accountId, keyCheck } : {}) });
    if (!record(auth) || typeof auth.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(auth.token) ||
      typeof auth.accountId !== 'string' || !idPattern.test(auth.accountId)) throw new Error('Invalid account');
    this.token = auth.token;
    this.accountId = auth.accountId;
    this.key = await deriveSyncKey(secret, this.accountId);
    try {
      const check = await decryptSync(this.key, this.accountId, 'key-check', auth.keyCheck);
      if (!record(check) || check.check !== 'blincho-sync-v1') throw new Error('Invalid key');
    } catch { await this.request('/v1/logout', 'POST', {}).catch(() => {}); throw new Error('Encryption key mismatch'); }
    if (this.closed) throw new Error('Closed');
    this.deviceId = deviceIdFor(this.accountId, this.storage);
    try {
      const ids: unknown = JSON.parse(this.storage.getItem(`blincho_sync_seen_${this.accountId}`) || '[]');
      if (Array.isArray(ids)) this.seen = new Set(ids.filter((id): id is string => typeof id === 'string' && idPattern.test(id)).slice(-256));
    } catch { this.seen.clear(); }
    await this.pullState();
    await this.pushStats();
    if (this.closed) throw new Error('Closed');
    this.callbacks.status('connected');
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    void this.tick();
  }
  settingsChanged(settings: AppSettings): void {
    const next = projectSyncSettings(settings);
    const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== this.localSettings[key as keyof typeof next]));
    this.localSettings = next;
    if (!Object.keys(changed).length) return;
    this.pendingSettings = { ...this.pendingSettings, ...changed };
    this.nextStateAt = 0;
  }
  private async pullState(): Promise<void> {
    const value = await this.request('/v1/state');
    if (!record(value) || !Array.isArray(value.documents) || value.documents.length > 32) throw new Error('Invalid state');
    const snapshots: DayStats[][] = [];
    let settings: unknown;
    const revisions = new Map<string, number>();
    for (const doc of value.documents) {
      if (!record(doc) || typeof doc.id !== 'string' || !(doc.id === 'settings' || /^stats_[a-f0-9]{32}$/.test(doc.id)) ||
        typeof doc.revision !== 'number' || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || revisions.has(doc.id)) throw new Error('Invalid document');
      revisions.set(doc.id, doc.revision);
      const kind = doc.id === 'settings' ? 'settings' : doc.id.replace('_', '-');
      if (doc.id === 'settings') settings = await decryptSync(this.key!, this.accountId, kind, doc.envelope);
      else if (doc.id !== `stats_${this.deviceId}`) {
        // One unreadable peer must not block local uploads or other devices' totals.
        try { snapshots.push(validateSyncStats(await decryptSync(this.key!, this.accountId, kind, doc.envelope))); }
        catch { /* Omit this peer until it publishes a readable snapshot. */ }
      }
    }
    if (this.closed) return;
    if (settings !== undefined) {
      const remote = projectSyncSettings(applySyncSettings(this.callbacks.snapshot().settings, settings));
      const merged = { ...remote, ...this.pendingSettings };
      if (this.pendingSettings || revisions.get('settings') !== this.revisions.get('settings')) this.callbacks.settings(merged);
      this.localSettings = merged;
    } else {
      this.pendingSettings = { ...this.localSettings, ...this.pendingSettings };
    }
    this.revisions = revisions;
    this.callbacks.stats(snapshots);
    this.nextStateAt = Date.now() + 15_000;
  }
  private async putDocument(id: string, payload: unknown): Promise<void> {
    const kind = id === 'settings' ? 'settings' : id.replace('_', '-');
    const envelope = await encryptSync(this.key!, this.accountId, kind, payload);
    const result = await this.request(`/v1/state/${id}`, 'PUT', { baseRevision: this.revisions.get(id) ?? 0, envelope });
    if (!record(result) || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('Invalid revision');
    this.revisions.set(id, result.revision);
  }
  private async pushStats(): Promise<void> {
    const stats = projectSyncStats(this.callbacks.snapshot().stats);
    const json = JSON.stringify(stats);
    if (json !== this.statsJSON) { await this.putDocument(`stats_${this.deviceId}`, stats); this.statsJSON = json; }
    this.nextStatsAt = Date.now() + 30_000;
  }
  private remember(id: string): void {
    this.seen.add(id);
    this.seen = new Set([...this.seen].slice(-256));
    // Failure to persist replay protection must stop remote commands.
    this.storage.setItem(`blincho_sync_seen_${this.accountId}`, JSON.stringify([...this.seen]));
  }
  private schedule(event: SharedBreak): void {
    if (this.closed || this.seen.has(event.id)) return;
    this.remember(event.id);
    if (this.scheduled) {
      const previous = this.scheduled.event;
      if (previous.startAt < event.startAt || (previous.startAt === event.startAt && previous.id < event.id)) return;
      clearTimeout(this.scheduled.timer);
    }
    // Capture the UI generation before delivery. A local publish records it before
    // its POST so a concurrent poll cannot make a reset or pause look current.
    const generation = this.localBreakGenerations.has(event.id)
      ? this.localBreakGenerations.get(event.id) : this.callbacks.breakGeneration?.();
    const current = () => !this.closed && (generation === undefined || generation === this.callbacks.breakGeneration?.());
    const timer = setTimeout(() => {
      this.scheduled = null;
      if (current() && event.endAt > Date.now()) {
        Promise.resolve().then(() => { if (current()) return this.callbacks.break(event, current); })
          .catch(() => { if (!this.closed) this.callbacks.status('error'); });
      }
    }, Math.max(0, event.startAt - Date.now()));
    this.scheduled = { event, timer };
  }
  async publishBreak(seconds: number): Promise<void> {
    if (this.scheduled) return;
    if (!this.key || !Number.isFinite(seconds) || seconds < 1 || seconds > 1800) throw new Error('Invalid duration');
    const createdAt = Date.now();
    const event: SharedBreak = { v: 1, id: hexId(), deviceId: this.deviceId, createdAt, startAt: createdAt + 2500, endAt: createdAt + 2500 + seconds * 1000 };
    this.localBreakGenerations.set(event.id, this.callbacks.breakGeneration?.());
    this.localBreakGenerations = new Map([...this.localBreakGenerations].slice(-256));
    const envelope = await encryptSync(this.key, this.accountId, 'break', event);
    await this.request('/v1/events', 'POST', { envelope });
    // A slow POST must not start an already expired break locally.
    if (event.endAt <= Date.now()) throw new Error('Shared break delivery expired');
    this.schedule(validateSharedBreak(event));
  }
  private async pollEvents(): Promise<void> {
    let value = await this.request(`/v1/events?after=${this.cursor}`);
    if (!record(value) || typeof value.instance !== 'string' || value.instance.length > 128) throw new Error('Invalid event stream');
    if (this.instance && value.instance !== this.instance) { this.cursor = 0; value = await this.request('/v1/events?after=0'); }
    if (!record(value) || typeof value.instance !== 'string' || value.instance.length > 128 || !Array.isArray(value.events) || value.events.length > 256 ||
      typeof value.cursor !== 'number' || !Number.isSafeInteger(value.cursor) || value.cursor < this.cursor) throw new Error('Invalid event stream');
    let last = this.cursor;
    for (const item of value.events) {
      if (!record(item) || typeof item.seq !== 'number' || !Number.isSafeInteger(item.seq) || item.seq <= last || item.seq > value.cursor) throw new Error('Invalid sequence');
      let event: SharedBreak;
      try { event = validateSharedBreak(await decryptSync(this.key!, this.accountId, 'break', item.envelope)); }
      catch { last = item.seq; continue; }
      if (this.closed) return;
      this.schedule(event);
      last = item.seq;
    }
    this.instance = value.instance;
    this.cursor = value.cursor;
  }
  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      await this.pollEvents();
      if (Date.now() >= this.nextStateAt) await this.pullState();
      const desired = this.pendingSettings;
      if (desired) {
        await this.putDocument('settings', { ...this.localSettings, ...desired });
        if (this.pendingSettings === desired) this.pendingSettings = null;
      }
      if (Date.now() >= this.nextStatsAt) await this.pushStats();
      if (!this.closed) this.callbacks.status('connected');
    } catch { this.nextStateAt = 0; if (!this.closed) this.callbacks.status('error'); }
    finally { this.busy = false; }
  }
  async deleteAccount(password: string): Promise<void> { await this.request('/v1/delete-account', 'POST', { password }); }
  close(): void {
    if (this.closed) return;
    const token = this.token;
    this.closed = true;
    clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled.timer);
    this.scheduled = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.key = null; this.token = ''; this.pendingSettings = null;
    this.callbacks.stats([]);
    // Revoke the server session best-effort after clearing local credentials.
    if (token) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      void this.fetcher(this.baseUrl + '/v1/logout', { method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
      }).catch(() => {}).finally(() => clearTimeout(timeout));
    }
  }
}

export function useAccountSync(enabled: boolean, callbacks: Omit<Callbacks, 'status'>): SyncControls & {
  startBreak: (seconds: number) => Promise<boolean>; settingsChanged: (settings: AppSettings) => void;
} {
  const current = useRef(callbacks); current.current = callbacks;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const session = useRef<AccountSyncSession | null>(null);
  const [state, setState] = useState<{ status: SyncStatus; error: SyncControls['error']; account: string | null }>({ status: 'disconnected', error: null, account: null });
  const mounted = useRef(false);
  const disconnect = () => {
    const previous = session.current; session.current = null; previous?.close();
    if (mounted.current) current.current.stats([]);
    if (mounted.current) setState({ status: 'disconnected', error: null, account: null });
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; session.current?.close(); session.current = null; }; }, []);
  useEffect(() => { if (!enabled) disconnect(); }, [enabled]);
  return {
    ...state, disconnect,
    connect: async (mode, email, password, secret, code) => {
      if (!enabledRef.current || session.current) return;
      setState({ status: 'connecting', error: null, account: null });
      let client: AccountSyncSession | undefined;
      try {
        client = new AccountSyncSession({ snapshot: () => current.current.snapshot(), settings: value => current.current.settings(value),
        breakGeneration: () => current.current.breakGeneration?.() ?? 0,
        stats: values => { if (mounted.current && session.current === client) current.current.stats(values); },
        break: (event, isCurrent) => current.current.break(event, () => isCurrent() && session.current === client), status: status => {
          if (mounted.current && session.current === client) {
            if (status === 'disconnected') session.current = null;
            setState({ status, error: status === 'error' || status === 'disconnected' ? 'connection' : null,
              account: status === 'disconnected' ? null : email });
          }
        } });
        session.current = client;
        await client.connect(mode, email, password, secret, code);
      }
      catch (error) {
        client?.close();
        if (!client || session.current === client) {
          session.current = null;
          if (mounted.current) setState({ status: 'error', error: error instanceof Error && error.message === 'Encryption key mismatch' ? 'key' : 'connection', account: null });
        }
        throw new Error('Sync connection failed');
      }
    },
    deleteAccount: async password => { const client = session.current; if (!client) return; await client.deleteAccount(password); if (session.current === client) disconnect(); },
    startBreak: async seconds => { const client = session.current; if (!client || state.status === 'connecting') return false; await client.publishBreak(seconds); return true; },
    settingsChanged: settings => session.current?.settingsChanged(settings),
  };
}
