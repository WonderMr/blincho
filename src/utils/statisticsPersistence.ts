// Desktop statistics must not pass through WebKit's SQLite localStorage WAL.
// The legacy key is removed only after its complete snapshot is durable.
export const STATISTICS_KEY = 'myeyes_stats_v1';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface NativeStatistics {
  invoke: Invoke;
  value: string;
  saved: string;
  writing?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
}
let native: NativeStatistics | undefined;
let initialization: Promise<void> | undefined;

function validate(value: string): void {
  if (!Array.isArray(JSON.parse(value))) throw new Error('Invalid statistics snapshot');
}

export function initializeStatisticsPersistence(invoke: Invoke): Promise<void> {
  if (native) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    const saved = await invoke<string | null>('statistics_load');
    if (saved !== null && typeof saved !== 'string') throw new Error('Invalid native statistics response');
    const value = saved ?? localStorage.getItem(STATISTICS_KEY) ?? '[]';
    validate(value);
    // Re-acknowledge an existing file too: a prior attempt may have renamed it
    // but failed the durability check before legacy cleanup.
    await invoke('statistics_save', { value });
    // A failed cleanup stays in startup recovery and is retried on next startup.
    localStorage.removeItem(STATISTICS_KEY);
    native = { invoke, value, saved: value };
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}

export function readStatistics(): string | null {
  return native ? native.value : localStorage.getItem(STATISTICS_KEY);
}

function startSave(state: NativeStatistics): void {
  if (state.writing || state.retry !== undefined || state.saved === state.value) return;
  state.retry = setTimeout(() => {
    state.retry = undefined;
    void flushStatistics().catch(error => console.warn('Blincho: Native statistics save failed:', error));
  }, 5000);
}

export function writeStatistics(value: string): void {
  if (!native) {
    if (localStorage.getItem(STATISTICS_KEY) !== value) localStorage.setItem(STATISTICS_KEY, value);
    return;
  }
  native.value = value;
  startSave(native);
}

// Only one immutable snapshot is in flight; later mutations replace the pending
// snapshot. A successful flush acknowledges every mutation made before it ends.
export async function flushStatistics(): Promise<void> {
  const state = native;
  if (!state) return;
  if (state.retry !== undefined) { clearTimeout(state.retry); state.retry = undefined; }
  if (state.writing) { await state.writing; return flushStatistics(); }
  const writing = (async () => {
    while (state.saved !== state.value) {
      const value = state.value;
      await state.invoke('statistics_save', { value });
      state.saved = value;
    }
  })();
  state.writing = writing;
  try { await writing; }
  catch (error) {
    if (state.writing === writing) state.writing = undefined;
    startSave(state);
    throw error;
  }
  finally {
    if (state.writing === writing) state.writing = undefined;
    startSave(state);
  }
}

export function statisticsWriteResult(): boolean | Promise<boolean> {
  if (!native) return true;
  return flushStatistics().then(() => true, error => {
    console.warn('Blincho: Statistics commit failed:', error);
    return false;
  });
}
