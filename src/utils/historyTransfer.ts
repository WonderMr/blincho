export interface HistorySnapshot { schemaVersion: number; exportedAt: string; entries: Record<string, string> }
export interface HistoryImportResult { status: 'imported' | 'already-imported' | 'existing-profile' | 'no-export'; entryCount: number }
const MARKER = 'myeyes_tauri_import_v1';
const PENDING = 'myeyes_tauri_import_pending_v1';
const bytes = (text: string) => new TextEncoder().encode(text).length;

export function validateHistorySnapshot(value: unknown): HistorySnapshot {
  const snapshot = value as HistorySnapshot;
  if (!snapshot || snapshot.schemaVersion !== 1 || typeof snapshot.exportedAt !== 'string' ||
      snapshot.exportedAt.length > 64 || !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      !snapshot.entries || typeof snapshot.entries !== 'object' || Array.isArray(snapshot.entries) ||
      Object.keys(snapshot.entries).length > 128 || bytes(JSON.stringify(snapshot)) > 8 * 1024 * 1024) {
    throw new Error('Invalid history export');
  }
  for (const [key, value] of Object.entries(snapshot.entries)) {
    if ((!key.startsWith('myeyes_') && key !== 'blincho-language-v1') || [MARKER, PENDING].includes(key) || bytes(key) > 256 ||
        typeof value !== 'string' || bytes(value) > 4 * 1024 * 1024) throw new Error('Invalid history entry');
    // The application stores these records as JSON. Refuse corrupted known records before writing anything.
    if (['myeyes_settings_v1', 'myeyes_stats_v1', 'myeyes_cvs_result_v1', 'blincho-language-v1'].includes(key)) JSON.parse(value);
  }
  return snapshot;
}

export function importHistorySnapshot(storage: Storage, value: unknown): HistoryImportResult {
  const pending = storage.getItem(PENDING);
  if (pending) {
    const keys: unknown = JSON.parse(pending);
    if (!Array.isArray(keys) || keys.length > 128 || keys.some(key => typeof key !== 'string' || (!key.startsWith('myeyes_') && key !== 'blincho-language-v1') || [MARKER, PENDING].includes(key))) {
      throw new Error('Invalid pending history transaction');
    }
    // A commit marker means all entries were written. Otherwise roll back our incomplete first import.
    if (!storage.getItem(MARKER)) for (const key of keys) storage.removeItem(key);
    storage.removeItem(PENDING);
  }
  if (storage.getItem(MARKER)) return { status: 'already-imported', entryCount: 0 };
  for (let index = 0; index < storage.length; index++) {
    if ((storage.key(index)?.startsWith('myeyes_') || storage.key(index) === 'blincho-language-v1')) return { status: 'existing-profile', entryCount: 0 };
  }
  if (!value) return { status: 'no-export', entryCount: 0 };
  const snapshot = validateHistorySnapshot(value);
  const keys = Object.keys(snapshot.entries);
  storage.setItem(PENDING, JSON.stringify(keys));
  try {
    for (const [key, entry] of Object.entries(snapshot.entries)) storage.setItem(key, entry);
    storage.setItem(MARKER, JSON.stringify({ exportedAt: snapshot.exportedAt, importedAt: new Date().toISOString(), entryCount: keys.length }));
    storage.removeItem(PENDING);
  } catch (error) {
    // Never remove a successfully committed import if final journal cleanup fails.
    if (!storage.getItem(MARKER)) {
      for (const key of keys) storage.removeItem(key);
      storage.removeItem(PENDING);
    }
    throw error;
  }
  return { status: 'imported', entryCount: keys.length };
}

export function gatherLegacyHistory(storage: Storage): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key && (key.startsWith('myeyes_') || key === 'blincho-language-v1') && ![MARKER, PENDING].includes(key)) {
      const value = storage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  }
  return entries;
}
