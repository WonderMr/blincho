const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { availableMacVersion, fetchReleaseManifest } = require('../electron/manualUpdates.cjs');

function release(version, arch = 'arm64') {
  const name = `Blincho-${version}-macos-${arch}.zip`;
  return { version, tag: `v${version}`, url: `https://github.com/WonderMr/blincho/releases/tag/v${version}`,
    assets: [{ name, platform: 'macos', architecture: arch, format: 'zip', size: 1024, sha256: 'a'.repeat(64),
      url: `https://github.com/WonderMr/blincho/releases/download/v${version}/${name}` }] };
}
const manifest = (...releases) => ({ schemaVersion: 1, repository: 'WonderMr/blincho', releases });

test('manual notifier compares numeric versions and selects a newer matching Mac architecture only', () => {
  const list = manifest(release('1.9.0'), release('1.10.0'), release('2.0.0', 'x64'), release('1.4.2'));
  assert.equal(availableMacVersion(list, '1.4.2', 'arm64'), '1.10.0');
  assert.equal(availableMacVersion(list, '1.4.2', 'x64'), '2.0.0');
  assert.equal(availableMacVersion(list, '2.0.0', 'arm64'), null);
  assert.equal(availableMacVersion(manifest(), '1.4.2', 'arm64'), null);
  assert.equal(availableMacVersion(manifest(release('1.4.2')), '1.4.2', 'arm64'), null);
});

test('manual notifier rejects malformed versions, manifests and package metadata', () => {
  for (const version of ['1.4', '1.4.3-beta', '01.4.3', '99999999999999999999.0.0', '<script>']) {
    assert.throws(() => availableMacVersion(manifest(release(version)), '1.4.2', 'arm64'));
  }
  for (const bad of [null, {}, { ...manifest(), schemaVersion: 2 }, { ...manifest(), repository: 'attacker/repo' }, manifest(null)]) {
    assert.throws(() => availableMacVersion(bad, '1.4.2', 'arm64'));
  }
  for (const patch of [{ url: 'https://evil.test/update.zip' }, { size: -1 }, { sha256: '' }, { architecture: 'x64' }, { format: 'dmg' }]) {
    const next = release('1.5.0'); Object.assign(next.assets[0], patch);
    assert.throws(() => availableMacVersion(manifest(next), '1.4.2', 'arm64'));
  }
  const next = release('1.5.0'); next.url = 'https://evil.test/release';
  assert.throws(() => availableMacVersion(manifest(next), '1.4.2', 'arm64'));
});

function transport({ statusCode = 200, headers = {}, chunks = ['{}'], stall = false } = {}) {
  const calls = [];
  const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
  const response = new PassThrough(); response.statusCode = statusCode; response.headers = headers;
  const get = (url, options, receive) => {
    calls.push({ url, options });
    const abort = () => { request.destroy(); request.emit('error', new Error('aborted')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    setImmediate(() => {
      if (options.signal?.aborted) return abort();
      receive(response);
      if (!stall) { for (const chunk of chunks) response.write(chunk); response.end(); }
    });
    return request;
  };
  return { calls, request, response, get };
}

test('manifest transport pins HTTPS endpoint, omits credentials and parses bounded JSON', async () => {
  const h = transport({ chunks: ['{"schema', 'Version":1}'] });
  const result = await fetchReleaseManifest({ version: '1.4.2', get: h.get });
  assert.deepEqual(result, { schemaVersion: 1 });
  assert.equal(h.calls[0].url, 'https://blincho.app/releases.json');
  assert.deepEqual(h.calls[0].options.headers, { Accept: 'application/json', 'User-Agent': 'Blincho/1.4.2 (+https://blincho.app)' });
  assert.equal(h.calls[0].options.agent, false);
});

for (const [name, options] of [
  ['redirect', { statusCode: 302, headers: { location: 'https://evil.test' } }],
  ['HTTP error', { statusCode: 500 }],
  ['oversized content length', { headers: { 'content-length': '1048577' } }],
  ['oversized stream', { chunks: [Buffer.alloc(1048577)] }],
  ['invalid JSON', { chunks: ['<html>'] }],
]) test(`manifest transport rejects ${name}`, async () => {
  const h = transport(options);
  await assert.rejects(fetchReleaseManifest({ version: '1.4.2', get: h.get }));
  assert.equal(h.request.destroyed, true);
  assert.equal(h.calls.length, 1);
});

test('manifest transport aborts an in-flight request and enforces a total deadline', async () => {
  const h = transport({ stall: true }), abort = new AbortController();
  const pending = fetchReleaseManifest({ version: '1.4.2', get: h.get, signal: abort.signal });
  await new Promise(setImmediate); abort.abort();
  await assert.rejects(pending); assert.equal(h.request.destroyed, true);
  const hung = transport({ stall: true });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(fetchReleaseManifest({ version: '1.4.2', get: hung.get, timeoutMs: 10 }), /timed out/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(hung.request.destroyed, true);
});
