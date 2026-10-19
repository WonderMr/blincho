import type { InputActivityBucket } from '../types';
import { dayBounds } from './activity';

export const INPUT_FIELDS = ['keyPresses', 'clicks', 'scrolls', 'mouseMoves'] as const;
export interface InputActivitySnapshot { source: string; status: 'disabled' | 'active' | 'permissionRequired' | 'unsupported' | 'unavailable'; buckets: InputActivityBucket[] }
export interface InputActivityCursor { source: string; buckets: InputActivityBucket[] }

export function normalizeInputActivity(value: unknown, date: string): InputActivityBucket[] {
  if (!Array.isArray(value)) return [];
  const { start, end } = dayBounds(date);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const result = new Map<number, InputActivityBucket>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.start) || item.start % 300_000 !== 0
      || item.start < start || item.start >= end || INPUT_FIELDS.some(field => !Number.isSafeInteger(item[field]) || item[field] < 0)) continue;
    const bucket: InputActivityBucket = { start: item.start, keyPresses: item.keyPresses, clicks: item.clicks, scrolls: item.scrolls, mouseMoves: item.mouseMoves };
    // Duplicate cumulative observations cannot inflate a bucket.
    const previous = result.get(bucket.start);
    if (previous) for (const field of INPUT_FIELDS) bucket[field] = Math.max(bucket[field], previous[field]);
    result.set(bucket.start, bucket);
  }
  return [...result.values()].sort((a, b) => a.start - b.start);
}

export function mergeInputActivity(saved: InputActivityBucket[], incoming: InputActivityBucket[], previous: InputActivityBucket[]) {
  const result = new Map(saved.map(bucket => [bucket.start, { ...bucket }]));
  const cursor = new Map(previous.map(bucket => [bucket.start, bucket]));
  for (const bucket of incoming) {
    const total = result.get(bucket.start) ?? { start: bucket.start, keyPresses: 0, clicks: 0, scrolls: 0, mouseMoves: 0 };
    const old = cursor.get(bucket.start);
    for (const field of INPUT_FIELDS) total[field] = Math.min(Number.MAX_SAFE_INTEGER, total[field] + Math.max(0, bucket[field] - (old?.[field] ?? 0)));
    result.set(bucket.start, total);
  }
  return [...result.values()].sort((a, b) => a.start - b.start);
}

let configuration = Promise.resolve();
export async function configureInputActivity(enabled: boolean, prompt = false, onSnapshot?: (snapshot: InputActivitySnapshot) => void): Promise<InputActivitySnapshot> {
  const api = (window as Window & { __TAURI__?: { core: { invoke<T>(command: string, args: Record<string, unknown>): Promise<T> } } }).__TAURI__;
  if (!api) return { source: '', status: 'unsupported', buckets: [] };
  const request = configuration.then(() => api.core.invoke<InputActivitySnapshot>('input_activity_configure', { enabled, prompt })).then(snapshot => { onSnapshot?.(snapshot); return snapshot; });
  configuration = request.then(() => {}, () => {});
  return request;
}
