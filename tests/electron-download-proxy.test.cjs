const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

test('Electron builder downloader retains proxy and no-proxy support with the security override', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'blincho-electron-download-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const requests = [];
  const proxy = http.createServer((request, response) => {
    requests.push(request.url);
    response.end('proxied download');
  });
  const direct = http.createServer((_request, response) => response.end('direct download'));
  t.after(() => proxy.close());
  t.after(() => direct.close());
  await Promise.all([proxy, direct].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const builderRequire = createRequire(require.resolve('app-builder-lib'));
  const downloader = builderRequire.resolve('@electron/get');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const directUrl = `http://127.0.0.1:${direct.address().port}/artifact.zip`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { readFile } = require('node:fs/promises');
    const { initializeProxy, downloadArtifact, ElectronDownloadCacheMode } = require(${JSON.stringify(downloader)});
    initializeProxy();
    const agent = global.GLOBAL_AGENT;
    assert.ok(agent, 'initializeProxy must not swallow a load or bootstrap error');
    assert.equal(agent.HTTP_PROXY, ${JSON.stringify(proxyUrl)});
    assert.equal(agent.HTTPS_PROXY, ${JSON.stringify(proxyUrl)});
    initializeProxy();
    assert.equal(global.GLOBAL_AGENT, agent);
    const read = async url => {
      const downloaded = await downloadArtifact({
        // This synthetic fixture predates Electron's checksum manifests.
        version: '1.0.0',
        artifactName: 'artifact.zip',
        isGeneric: true,
        cacheMode: ElectronDownloadCacheMode.Bypass,
        cacheRoot: ${JSON.stringify(path.join(tempRoot, 'cache'))},
        tempDirectory: ${JSON.stringify(tempRoot)},
        mirrorOptions: { resolveAssetURL: async () => url },
      });
      return readFile(downloaded, 'utf8');
    };
    (async () => {
      assert.equal(await read('http://download.invalid/artifact.zip'), 'proxied download');
      assert.equal(await read(${JSON.stringify(directUrl)}), 'direct download');
      console.log('proxy bootstrap, repeated initialization and no-proxy routing passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    timeout: 10_000,
    env: {
      ...process.env,
      GLOBAL_AGENT_HTTP_PROXY: proxyUrl,
      GLOBAL_AGENT_HTTPS_PROXY: proxyUrl,
      GLOBAL_AGENT_NO_PROXY: '127.0.0.1',
    },
  });
  assert.match(stdout, /no-proxy routing passed/);
  assert.deepEqual(requests, ['http://download.invalid/artifact.zip']);
});
