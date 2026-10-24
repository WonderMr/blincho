import type { io } from '@tensorflow/tfjs-core';
import cameraModelManifest from '../data/cameraModelManifest.json';

export interface CameraModelManifest {
  version: string;
  baseUrl: string;
  files: { name: string; bytes: number; sha256: string }[];
}

export interface CameraModelCacheRecord {
  version: string;
  files: { name: string; data: ArrayBuffer }[];
}

export interface CameraModelCache {
  read(version: string): Promise<unknown>;
  write(record: CameraModelCacheRecord, signal: AbortSignal): Promise<void>;
}

export interface CameraAssetDependencies {
  manifest?: CameraModelManifest;
  cache?: CameraModelCache;
  fetch?: typeof fetch;
  digest?: (data: ArrayBuffer) => Promise<string>;
  requestTimeoutMs?: number;
}

const MODEL_FILE = 'model.json';
const SHARD_FILES = Array.from({ length: 5 }, (_, index) => `group1-shard${index + 1}of5`);
const EXPECTED_FILES = [MODEL_FILE, ...SHARD_FILES];

function abortError(): DOMException {
  return new DOMException('Camera model preparation cancelled', 'AbortError');
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function createIndexedDbCache(): CameraModelCache {
  let connection: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (!connection) {
      connection = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('Camera model storage unavailable'));
          return;
        }
        const request = indexedDB.open('blincho-camera-models', 1);
        let failed = false;
        request.onupgradeneeded = () => request.result.createObjectStore('models', { keyPath: 'version' });
        request.onerror = () => reject(request.error ?? new Error('Camera model storage unavailable'));
        request.onblocked = () => { failed = true; reject(new Error('Camera model storage blocked')); };
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => { db.close(); connection = undefined; };
          resolve(db);
        };
      });
      connection.catch(() => { connection = undefined; });
    }
    return connection;
  };
  return {
    async read(version) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('models', 'readonly');
        const request = transaction.objectStore('models').get(version);
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Camera model cache read failed'));
      });
    },
    async write(record, signal) {
      const db = await abortable(open(), signal);
      checkAbort(signal);
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('models', 'readwrite');
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const onAbort = () => { try { transaction.abort(); } catch { /* Already committed. */ } };
        signal.addEventListener('abort', onAbort, { once: true });
        transaction.oncomplete = () => { cleanup(); resolve(); };
        transaction.onabort = transaction.onerror = () => {
          cleanup();
          reject(signal.aborted ? abortError() : transaction.error ?? new Error('Camera model cache write failed'));
        };
        // One transaction publishes the complete verified version, never individual files.
        transaction.objectStore('models').put(record);
      });
    },
  };
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function readArtifacts(record: CameraModelCacheRecord): io.ModelArtifacts {
  const model = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.files[0].data));
  if (!model || typeof model !== 'object' || !model.modelTopology || typeof model.modelTopology !== 'object'
      || !Array.isArray(model.weightsManifest)) throw new Error('Invalid camera model document');
  const paths: unknown[] = [];
  const weightSpecs: io.WeightsManifestEntry[] = [];
  for (const group of model.weightsManifest) {
    if (!group || !Array.isArray(group.paths) || !Array.isArray(group.weights)) throw new Error('Invalid camera model weights manifest');
    paths.push(...group.paths);
    weightSpecs.push(...group.weights);
  }
  if (paths.length !== SHARD_FILES.length || paths.some((name, index) => name !== SHARD_FILES[index])) {
    throw new Error('Unexpected camera model shard order');
  }
  const shards = record.files.slice(1);
  const weightData = new Uint8Array(shards.reduce((total, file) => total + file.data.byteLength, 0));
  let offset = 0;
  for (const shard of shards) { weightData.set(new Uint8Array(shard.data), offset); offset += shard.data.byteLength; }
  return { modelTopology: model.modelTopology, weightSpecs, weightData: weightData.buffer };
}

export function createCameraAssetStore(dependencies: CameraAssetDependencies = {}) {
  // The manifest is compiled into the app. Downloaded JSON never supplies a URL or filename.
  const manifest = dependencies.manifest ?? cameraModelManifest;
  if (!manifest.version || manifest.files.length !== EXPECTED_FILES.length
      || manifest.files.some((file, index) => file.name !== EXPECTED_FILES[index]
        || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error('Invalid pinned camera model manifest');
  }
  const base = new URL(manifest.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new Error('Invalid pinned camera model URL');
  }
  const cache = dependencies.cache ?? createIndexedDbCache();
  const fetchFile = dependencies.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const digest = dependencies.digest ?? sha256;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? 60_000;
  const totalBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  let ready: CameraModelCacheRecord | undefined;
  type Consumer = { resolve(): void; reject(error: unknown): void; progress?: (percent: number) => void; cleanup(): void };
  type Preparation = { controller: AbortController; consumers: Set<Consumer>; progress: number };
  let preparation: Preparation | undefined;

  const notify = (consumer: Consumer, percent: number) => {
    // A UI progress callback must not break another caller's download.
    try { consumer.progress?.(percent); } catch { /* Consumer owns its callback. */ }
  };
  const progress = (operation: Preparation, percent: number) => {
    if (operation.controller.signal.aborted || percent === operation.progress) return;
    operation.progress = percent;
    for (const consumer of operation.consumers) notify(consumer, percent);
  };

  const verify = async (value: unknown, signal?: AbortSignal): Promise<CameraModelCacheRecord> => {
    const record = value as CameraModelCacheRecord | undefined;
    if (!record || record.version !== manifest.version || !Array.isArray(record.files)
        || record.files.length !== manifest.files.length) throw new Error('Camera model is not cached');
    const files: CameraModelCacheRecord['files'] = [];
    for (let index = 0; index < manifest.files.length; index++) {
      if (signal) checkAbort(signal);
      const expected = manifest.files[index], file = record.files[index];
      if (file?.name !== expected.name || !(file.data instanceof ArrayBuffer) || file.data.byteLength !== expected.bytes) {
        throw new Error('Invalid cached camera model size or file');
      }
      // Own the verified bytes; consumers and storage implementations cannot mutate them later.
      const data = file.data.slice(0);
      const actualHash = signal ? await abortable(digest(data), signal) : await digest(data);
      if (actualHash !== expected.sha256) throw new Error('Camera model checksum mismatch');
      files.push({ name: expected.name, data });
    }
    if (signal) checkAbort(signal);
    const verified = { version: manifest.version, files };
    // Validate paths only after every byte has passed its pinned hash.
    readArtifacts(verified);
    return verified;
  };

  const download = async (operation: Preparation): Promise<CameraModelCacheRecord> => {
    const signal = operation.controller.signal;
    const files: CameraModelCacheRecord['files'] = [];
    let receivedTotal = 0;
    for (const expected of manifest.files) {
      checkAbort(signal);
      const requestController = new AbortController();
      const onAbort = () => requestController.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, requestTimeoutMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let responseBody: ReadableStream<Uint8Array> | null = null;
      try {
        const requestSignal = requestController.signal;
        const response = await abortable(fetchFile(new URL(expected.name, base).href, {
          signal: requestSignal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        }), requestSignal);
        responseBody = response.body;
        if (response.status !== 200) throw new Error(`Camera model download returned HTTP ${response.status}`);
        // Content-Length can describe gzip bytes while fetch yields decoded bytes.
        // Bound and verify the decoded stream instead, then check its pinned hash.
        if (!response.body) throw new Error('Camera model download stream unavailable');
        reader = response.body.getReader();
        const data = new Uint8Array(expected.bytes);
        let offset = 0;
        while (true) {
          const chunk = await abortable(reader.read(), requestSignal);
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || offset + chunk.value.byteLength > expected.bytes) {
            throw new Error('Camera model download exceeds pinned size');
          }
          data.set(chunk.value, offset);
          offset += chunk.value.byteLength;
          receivedTotal += chunk.value.byteLength;
          progress(operation, Math.floor(receivedTotal / totalBytes * 99));
        }
        if (offset !== expected.bytes) throw new Error('Camera model download size mismatch');
        checkAbort(signal);
        const actualHash = await abortable(digest(data.buffer), requestSignal);
        if (actualHash !== expected.sha256) throw new Error('Camera model checksum mismatch');
        files.push({ name: expected.name, data: data.buffer });
      } catch (error) {
        if (reader) void reader.cancel().catch(() => {});
        else if (responseBody) void responseBody.cancel().catch(() => {});
        if (signal.aborted) throw abortError();
        if (timedOut) throw new Error('Camera model download timed out');
        throw error;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reader?.releaseLock();
      }
    }
    const record = { version: manifest.version, files };
    readArtifacts(record);
    checkAbort(signal);
    await abortable(cache.write(record, signal), signal);
    checkAbort(signal);
    return record;
  };

  const run = async (operation: Preparation) => {
    checkAbort(operation.controller.signal);
    let record: CameraModelCacheRecord | undefined;
    try {
      record = await verify(await abortable(cache.read(manifest.version), operation.controller.signal), operation.controller.signal);
    } catch (error) {
      checkAbort(operation.controller.signal);
      // Missing, unavailable or corrupt cached bytes may be repaired only by explicit preparation.
      record = await download(operation);
    }
    checkAbort(operation.controller.signal);
    ready = record;
    progress(operation, 100);
  };

  function prepareCameraModel(signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (ready) { try { onProgress?.(100); } catch { /* Consumer owns its callback. */ } return Promise.resolve(); }
    if (!preparation) {
      const operation: Preparation = { controller: new AbortController(), consumers: new Set(), progress: 0 };
      preparation = operation;
      const finish = (error?: unknown) => {
        if (preparation === operation) preparation = undefined;
        for (const consumer of operation.consumers) {
          consumer.cleanup();
          if (error === undefined) consumer.resolve(); else consumer.reject(error);
        }
        operation.consumers.clear();
      };
      // Attach the first consumer before any asynchronous work can settle.
      void Promise.resolve().then(() => run(operation)).then(() => finish(), error => finish(error));
    }
    const operation = preparation;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        consumer.cleanup();
        operation.consumers.delete(consumer);
        reject(abortError());
        if (operation.consumers.size === 0) {
          operation.controller.abort();
          if (preparation === operation) preparation = undefined;
        }
      };
      const consumer: Consumer = { resolve, reject, progress: onProgress, cleanup: () => signal?.removeEventListener('abort', onAbort) };
      operation.consumers.add(consumer);
      signal?.addEventListener('abort', onAbort, { once: true });
      notify(consumer, operation.progress);
    });
  }

  async function getCameraModelArtifacts(): Promise<io.ModelArtifacts> {
    if (!ready) ready = await verify(await cache.read(manifest.version));
    return readArtifacts(ready);
  }

  return { prepareCameraModel, getCameraModelArtifacts };
}

let cameraAssets: ReturnType<typeof createCameraAssetStore> | undefined;
const defaultStore = () => cameraAssets ??= createCameraAssetStore();
export const prepareCameraModel = (signal?: AbortSignal, onProgress?: (percent: number) => void) => defaultStore().prepareCameraModel(signal, onProgress);
export const getCameraModelArtifacts = () => defaultStore().getCameraModelArtifacts();
