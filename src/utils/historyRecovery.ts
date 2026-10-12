import { importHistorySnapshot, validateHistorySnapshot } from './historyTransfer';
import type { HistoryImportResult } from './historyTransfer';

export const HISTORY_CHOICE_KEY = 'blincho-tauri-history-choice-v1';
const IMPORT_MARKER = 'myeyes_tauri_import_v1';
const IMPORT_PENDING = 'myeyes_tauri_import_pending_v1';
export type HistoryStartupResult = HistoryImportResult | { status: 'continued-without-history'; entryCount: number };

/** Keep the explicit opt-out outside legacy data and its import transaction. */
function hasContinueChoice(storage: Storage): boolean {
  const raw = storage.getItem(HISTORY_CHOICE_KEY);
  if (!raw) return false;
  try {
    const choice = JSON.parse(raw);
    return choice?.schemaVersion === 1 && choice.source === 'electron-legacy-history' && choice.choice === 'continue-without-history';
  } catch { return false; }
}

/** Import attempts are repeatable; successful startup and an explicit choice are idempotent. */
export function createHistoryRecovery(storage: Storage, readLegacyHistory: () => Promise<unknown>) {
  let attempt: Promise<HistoryStartupResult> | undefined;
  async function importHistory(): Promise<HistoryStartupResult> {
    if (hasContinueChoice(storage)) return { status: 'continued-without-history', entryCount: 0 };
    // Inspect the current profile without rolling back a journal before the source can be read.
    if (storage.getItem(IMPORT_MARKER)) return importHistorySnapshot(storage, null);
    if (!storage.getItem(IMPORT_PENDING)) {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith('myeyes_') || key === 'blincho-language-v1') return importHistorySnapshot(storage, null);
      }
    }
    const snapshot = await readLegacyHistory();
    // A rejected or invalid source must leave an interrupted import journal unchanged.
    if (snapshot) validateHistorySnapshot(snapshot);
    return importHistorySnapshot(storage, snapshot);
  }
  return {
    run(): Promise<HistoryStartupResult> {
      if (!attempt) attempt = importHistory().catch(error => { attempt = undefined; throw error; });
      return attempt;
    },
    async continueWithoutHistory(): Promise<HistoryStartupResult> {
      if (attempt) await attempt.catch(() => {});
      // Persist before allowing App to write defaults or new history. On failure, recovery stays open.
      storage.setItem(HISTORY_CHOICE_KEY, JSON.stringify({ schemaVersion: 1, source: 'electron-legacy-history', choice: 'continue-without-history' }));
      const result: HistoryStartupResult = { status: 'continued-without-history', entryCount: 0 };
      attempt = Promise.resolve(result);
      return result;
    },
  };
}

export function historyErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  // Render as text, bound the detail, and keep control characters and prose dashes out of the UI.
  return Array.from(message.slice(0, 1200).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u2013\u2014\u2015]/g, ':')).slice(0, 600).join('');
}
