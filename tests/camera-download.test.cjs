const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { transformSync } = require('rolldown/utils');

const repo = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const copy = value => structuredClone(value);
const isAbort = error => error.name === 'AbortError';
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

function loadStore(globals = {}) {
  const file = path.join(repo, 'src/utils/cameraAssets.ts');
  const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const module = { exports: {} };
  vm.runInNewContext(code + '\nmodule.exports={createCameraAssetStore,prepareCameraModel,getCameraModelArtifacts};', {
    module, cameraModelManifest: JSON.parse(fs.readFileSync(path.join(repo, 'src/data/cameraModelManifest.json'), 'utf8')),
    URL, ArrayBuffer, Uint8Array, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, crypto: webcrypto,
    fetch: () => { throw Error('Unexpected default transport'); }, ...globals,
  }, { filename: file });
  return module.exports;
}

function fixture(paths) {
  const names = Array.from({ length: 5 }, (_, index) => `group1-shard${index + 1}of5`);
  const model = { modelTopology: { node: [] }, weightsManifest: [{ paths: paths ?? names, weights: [{ name: 'weights', shape: [5], dtype: 'float32' }] }] };
  const bytes = new Map([['model.json', new TextEncoder().encode(JSON.stringify(model))], ...names.map((name, index) => [name, Uint8Array.of(index + 1, 0, 0, 0)])]);
  const manifest = {
    version: 'test-immutable-model-v1', baseUrl: 'https://assets.blincho.test/pinned/',
    files: [...bytes].map(([name, data]) => ({ name, bytes: data.byteLength, sha256: hash(data.buffer) })),
  };
  const record = { version: manifest.version, files: [...bytes].map(([name, data]) => ({ name, data: data.buffer.slice(0) })) };
  return { manifest, bytes, record };
}

function memoryCache(initial) {
  const records = new Map(); if (initial) records.set(initial.version, copy(initial));
  const writes = [], reads = [];
  return {
    records, writes, reads,
    async read(version) { reads.push(version); return copy(records.get(version)); },
    async write(record, signal) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      writes.push(copy(record)); records.set(record.version, copy(record));
    },
  };
}

function transport(f, change) {
  const requests = [];
  const fetch = async (url, options) => {
    const name = new URL(url).pathname.split('/').at(-1);
    assert(f.bytes.has(name), `unpinned filename ${name}`);
    assert.equal(url, f.manifest.baseUrl + name);
    requests.push({ name, options });
    const data = f.bytes.get(name);
    if (change) { const changed = await change(name, data, options); if (changed) return changed; }
    return new Response(data, { status: 200, headers: { 'content-length': String(data.byteLength) } });
  };
  return { fetch, requests };
}

function store(f, cache, network, extras = {}) {
  return loadStore().createCameraAssetStore({ manifest: f.manifest, cache, fetch: network.fetch, digest: async data => hash(data), ...extras });
}

test('import and artifact reads never download; explicit prepare verifies, atomically caches and joins pinned weights', async () => {
  let importFetches = 0;
  const api = loadStore({ fetch: () => { importFetches++; throw Error('Network disabled'); } });
  assert.equal(importFetches, 0);
  const f = fixture(), cache = memoryCache(), network = transport(f), progress = [];
  const assets = api.createCameraAssetStore({ manifest: f.manifest, cache, fetch: network.fetch, digest: async bytes => hash(bytes) });
  await assert.rejects(assets.getCameraModelArtifacts(), /not cached/);
  assert.equal(network.requests.length, 0);
  await assets.prepareCameraModel(undefined, percent => progress.push(percent));
  assert.equal(network.requests.length, 6);
  assert.equal(cache.writes.length, 1);
  assert.equal(cache.writes[0].files.length, 6);
  assert.deepEqual(cache.reads, [f.manifest.version, f.manifest.version]);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 100);
  assert(progress.every((value, index) => value >= 0 && value <= 100 && (!index || value > progress[index - 1])));
  for (const { options } of network.requests) {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
  }
  const artifacts = await assets.getCameraModelArtifacts();
  assert.deepEqual(JSON.parse(JSON.stringify(artifacts.modelTopology)), { node: [] });
  assert.equal(artifacts.weightSpecs[0].name, 'weights');
  assert.deepEqual([...new Uint8Array(artifacts.weightData)], [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0]);
  new Uint8Array(artifacts.weightData).fill(255);
  assert.equal(new Uint8Array((await assets.getCameraModelArtifacts()).weightData)[0], 1);
  const offline = { fetch() { throw Error('Offline'); } };
  let checks = 0;
  const restored = store(f, cache, offline, { digest: async data => { checks++; return hash(data); } });
  await restored.prepareCameraModel();
  await restored.getCameraModelArtifacts();
  assert.equal(checks, 6);
  const cacheOnly = store(f, cache, offline);
  assert.equal(new Uint8Array((await cacheOnly.getCameraModelArtifacts()).weightData)[0], 1);
  assert.equal(cache.writes.length, 1);
});

test('cached bytes are checked for version, exact files, size and SHA-256 before use; prepare repairs corruption', async () => {
  for (const corrupt of [
    record => { new Uint8Array(record.files[1].data)[0] ^= 1; },
    record => { record.files[1].data = new ArrayBuffer(1); },
    record => { record.files.pop(); },
    record => { record.files[1].name = 'https://evil.test/weights'; },
    record => { record.version = 'other-version'; },
  ]) {
    const f = fixture(), record = copy(f.record); corrupt(record);
    const cache = memoryCache(); cache.records.set(f.manifest.version, record);
    const network = transport(f), assets = store(f, cache, network);
    await assert.rejects(assets.getCameraModelArtifacts(), /cached|checksum/);
    assert.equal(network.requests.length, 0);
    await assets.prepareCameraModel();
    assert.equal(network.requests.length, 6); assert.equal(cache.writes.length, 1);
    await assets.getCameraModelArtifacts();
  }
});

test('HTTP, missing streams, declared size, short/oversized bodies and bad hashes leave no ready or partial cache and can retry', async () => {
  const failures = [
    () => new Response('missing', { status: 404 }),
    () => new Response(null, { status: 200 }),
    (_name, data) => new Response(data.subarray(1)),
    (_name, data) => new Response(Uint8Array.from([...data, 0])),
    (_name, data) => { const changed = data.slice(); changed[0] ^= 1; return new Response(changed); },
  ];
  for (const fail of failures) {
    const f = fixture(), cache = memoryCache(); let failing = true;
    const network = transport(f, (...args) => failing ? fail(...args) : undefined), assets = store(f, cache, network);
    await assert.rejects(assets.prepareCameraModel(), /HTTP|stream|size|checksum/);
    assert.equal(cache.writes.length, 0); assert.equal(cache.records.size, 0);
    await assert.rejects(assets.getCameraModelArtifacts(), /not cached/);
    const before = network.requests.length;
    failing = false; await assets.prepareCameraModel();
    assert.equal(network.requests.length - before, 6); assert.equal(cache.writes.length, 1);
  }
});

test('verified JSON cannot change trusted shard order, duplicate shards or supply remote paths', async () => {
  for (const paths of [
    ['group1-shard2of5', 'group1-shard1of5', 'group1-shard3of5', 'group1-shard4of5', 'group1-shard5of5'],
    Array(5).fill('group1-shard1of5'),
    ['https://evil.test/weights', 'group1-shard2of5', 'group1-shard3of5', 'group1-shard4of5', 'group1-shard5of5'],
  ]) {
    const f = fixture(paths), cache = memoryCache(), network = transport(f), assets = store(f, cache, network);
    await assert.rejects(assets.prepareCameraModel(), /shard order/);
    assert.equal(network.requests.length, 6); assert.equal(cache.writes.length, 0);
    cache.records.set(f.manifest.version, f.record);
    await assert.rejects(assets.getCameraModelArtifacts(), /shard order/);
    assert.equal(network.requests.length, 6);
  }
});

test('cancellation before or during download rejects AbortError and permits an immediate fresh retry', async () => {
  const f = fixture(), cache = memoryCache(); let block = true;
  const network = transport(f, (_name, _bytes, options) => {
    if (block) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  });
  const assets = store(f, cache, network);
  const already = new AbortController(); already.abort();
  await assert.rejects(assets.prepareCameraModel(already.signal), isAbort);
  assert.equal(network.requests.length, 0);
  const abort = new AbortController(), progress = [];
  const cancelled = assets.prepareCameraModel(abort.signal, value => progress.push(value));
  await flush(); assert.equal(network.requests.length, 1);
  abort.abort(); block = false;
  const retry = assets.prepareCameraModel();
  await assert.rejects(cancelled, isAbort); await retry;
  assert.equal(network.requests.length, 7); assert.equal(cache.writes.length, 1);
  assert.deepEqual(progress, [0]);
});

test('concurrent callers share transfer; cancelling one consumer leaves the other active and detaches its progress', async () => {
  const f = fixture(), cache = memoryCache(); let release;
  const network = transport(f, (name, data) => name === 'model.json' ? new Promise(resolve => { release = () => resolve(new Response(data)); }) : undefined);
  const assets = store(f, cache, network), abort = new AbortController(), first = [], second = [];
  const cancelled = assets.prepareCameraModel(abort.signal, value => first.push(value));
  const completed = assets.prepareCameraModel(undefined, value => second.push(value));
  await flush(); assert.equal(network.requests.length, 1);
  const requestSignal = network.requests[0].options.signal;
  abort.abort(); await assert.rejects(cancelled, isAbort);
  assert.equal(requestSignal.aborted, false);
  release(); await completed;
  assert.equal(network.requests.length, 6); assert.equal(cache.writes.length, 1);
  assert.deepEqual(first, [0]); assert.equal(second.at(-1), 100);
  const firstLength = first.length, secondLength = second.length;
  await assets.prepareCameraModel(undefined, () => { throw Error('Bad callback'); });
  assert.equal(first.length, firstLength); assert.equal(second.length, secondLength);
});

test('aborting the only caller during streaming cancels the reader, publishes nothing, and retries', async () => {
  const f = fixture(), cache = memoryCache(); let blocking = true, cancelled = 0;
  const network = transport(f, (_name, data) => blocking ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(data.subarray(0, 1)); }, cancel() { cancelled++; },
  })) : undefined);
  const assets = store(f, cache, network), abort = new AbortController();
  const pending = assets.prepareCameraModel(abort.signal);
  await flush(); abort.abort(); await assert.rejects(pending, isAbort); await flush();
  assert.equal(cancelled, 1); assert.equal(cache.writes.length, 0);
  blocking = false; await assets.prepareCameraModel(); assert.equal(cache.writes.length, 1);
});

test('request timeout also bounds a transport which ignores AbortSignal, and failure remains retryable', async () => {
  const f = fixture(), cache = memoryCache(); let blocking = true;
  const network = transport(f, () => blocking ? new Promise(() => {}) : undefined);
  const assets = store(f, cache, network, { requestTimeoutMs: 10 });
  await assert.rejects(assets.prepareCameraModel(), /timed out/);
  assert.equal(network.requests[0].options.signal.aborted, true); assert.equal(cache.writes.length, 0);
  blocking = false; await assets.prepareCameraModel(); assert.equal(cache.writes.length, 1);
});

test('cache commit failure never marks ready and storage cancellation receives the shared signal', async () => {
  const f = fixture(), cache = memoryCache(), network = transport(f); let writeSignal;
  const write = cache.write;
  cache.write = async (_record, signal) => { writeSignal = signal; throw Error('Quota exceeded'); };
  const assets = store(f, cache, network);
  await assert.rejects(assets.prepareCameraModel(), /Quota/);
  await assert.rejects(assets.getCameraModelArtifacts(), /not cached/);
  assert.equal(writeSignal.aborted, false);
  cache.write = write; await assets.prepareCameraModel(); assert.equal(cache.writes.length, 1);
  const waiting = memoryCache(), abort = new AbortController(); let reachedWrite = false;
  waiting.write = async (_record, signal) => {
    reachedWrite = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  };
  const waitingStore = store(f, waiting, transport(f));
  const pending = waitingStore.prepareCameraModel(abort.signal);
  for (let index = 0; index < 20 && !reachedWrite; index++) await flush();
  assert.equal(reachedWrite, true); abort.abort(); await assert.rejects(pending, isAbort);
  assert.equal(waiting.records.size, 0);
});

test('the production SHA-256 implementation validates a cache before offline use', async () => {
  const f = fixture(), cache = memoryCache(f.record);
  const assets = loadStore().createCameraAssetStore({ manifest: f.manifest, cache, fetch() { throw Error('Offline'); } });
  await assets.prepareCameraModel();
  assert.equal(new Uint8Array((await assets.getCameraModelArtifacts()).weightData)[16], 5);
});

function indexedDbHarness() {
  const records = new Map(), transactions = []; let initialized = false;
  const harness = { records, transactions, onPut: undefined };
  const db = {
    createObjectStore(name, options) { assert.equal(name, 'models'); assert.equal(options.keyPath, 'version'); },
    close() {},
    transaction(name, mode) {
      assert.equal(name, 'models'); transactions.push(mode);
      let aborted = false;
      const transaction = {
        error: null,
        abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
        objectStore(storeName) {
          assert.equal(storeName, 'models');
          return {
            get(key) {
              assert.equal(mode, 'readonly'); const request = {};
              queueMicrotask(() => {
                request.result = copy(records.get(key)); request.onsuccess?.();
                queueMicrotask(() => { if (!aborted) transaction.oncomplete?.(); });
              });
              return request;
            },
            put(record) {
              assert.equal(mode, 'readwrite'); const staged = copy(record);
              harness.onPut?.();
              queueMicrotask(() => {
                if (aborted) return;
                records.set(staged.version, staged); transaction.oncomplete?.();
              });
            },
          };
        },
      };
      return transaction;
    },
  };
  harness.indexedDB = {
    open(name, version) {
      assert.equal(name, 'blincho-camera-models'); assert.equal(version, 1);
      const request = { result: db };
      queueMicrotask(() => {
        if (!initialized) { initialized = true; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return harness;
}

test('the IndexedDB adapter commits all verified files together and reopens them without network', async () => {
  const f = fixture(), indexedDb = indexedDbHarness(), network = transport(f);
  const api = loadStore({ indexedDB: indexedDb.indexedDB });
  const assets = api.createCameraAssetStore({ manifest: f.manifest, fetch: network.fetch });
  await assets.prepareCameraModel();
  assert.equal(indexedDb.records.size, 1);
  assert.equal(indexedDb.records.get(f.manifest.version).files.length, 6);
  assert.deepEqual(indexedDb.transactions, ['readonly', 'readwrite']);
  const reopened = loadStore({ indexedDB: indexedDb.indexedDB }).createCameraAssetStore({ manifest: f.manifest, fetch() { throw Error('Offline'); } });
  assert.equal(new Uint8Array((await reopened.getCameraModelArtifacts()).weightData)[0], 1);
  assert.equal(network.requests.length, 6);
});

test('cancellation inside the IndexedDB write aborts the transaction before any complete record is visible', async () => {
  const f = fixture(), indexedDb = indexedDbHarness(), network = transport(f), abort = new AbortController();
  indexedDb.onPut = () => abort.abort();
  const assets = loadStore({ indexedDB: indexedDb.indexedDB }).createCameraAssetStore({ manifest: f.manifest, fetch: network.fetch });
  await assert.rejects(assets.prepareCameraModel(abort.signal), isAbort); await flush();
  assert.equal(indexedDb.records.size, 0);
  indexedDb.onPut = undefined;
  await assets.prepareCameraModel(); assert.equal(indexedDb.records.size, 1);
  assert.equal(network.requests.length, 12);
});


test('HTTP compression length does not replace decoded size and hash verification', async () => {
  const f = fixture(), cache = memoryCache();
  const network = transport(f, (_name, data) => new Response(data, { headers: { 'content-length': '1', 'content-encoding': 'gzip' } }));
  const assets = store(f, cache, network);
  await assets.prepareCameraModel();
  assert.equal(network.requests.length, 6); assert.equal(cache.writes.length, 1);
  assert.deepEqual(Buffer.from((await assets.getCameraModelArtifacts()).weightData), Buffer.concat(f.record.files.slice(1).map(file => Buffer.from(file.data))));
});
