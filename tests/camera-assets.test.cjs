const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const assets = path.join(repo, 'public/camera');
const modelAssets = path.join(repo, 'camera-model');
const downloadManifest = require('../src/data/cameraModelManifest.json');
const assetDirectory = name => name.endsWith('.wasm') ? assets : modelAssets;
const hashes = {
  'model.json': '3770b2528339b1e3340cb74360e1e40401816b009779aeb8d0cce3a4353ea3a9',
  'group1-shard1of5': '0e7af0f713e98521252321f7f84892c31cefccccec3ac64c84e5065b75ed5646',
  'group1-shard2of5': '74cc6cfc2c4510c9cd81b8ad4cebf6f6a8f305119bb365ce0eb96276da38519a',
  'group1-shard3of5': '50383033f893eae136392a403e8f70ade5efd90867df5695c4ca5ac640e14f38',
  'group1-shard4of5': 'd856dc534c780068bbf6c666ce1516df2c8433d87578aa31fcdf197de7058cc2',
  'group1-shard5of5': '3d356f1fb6dfca6af78c56db34d9326706d0196e303f9de6b04f236ca79ed309',
  'tfjs-backend-wasm.wasm': '70a5d516060464e5269f01c74bac1772d6b8ab6cb612acf16b5cdaf61f78d892',
  'tfjs-backend-wasm-simd.wasm': '77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b',
  'tfjs-backend-wasm-threaded-simd.wasm': 'c052228d4bef185c27bbe59a9e029570c78bbb9f08b3cb46b597851650373de2',
};

test('offline camera assets match pinned upstream bytes and integrity manifest', () => {
  for (const [name, hash] of Object.entries(hashes)) {
    const shipped = fs.readFileSync(path.join(assetDirectory(name), name));
    assert.equal(createHash('sha256').update(shipped).digest('hex'), hash, name);
    if (name.endsWith('.wasm')) {
      const upstream = fs.readFileSync(path.join(repo, 'node_modules/@tensorflow/tfjs-backend-wasm/dist', name));
      assert(shipped.equals(upstream), `${name} matches the installed pinned runtime`);
      assert.equal(shipped.subarray(0, 4).toString('hex'), '0061736d');
    }
  }
  for (const directory of [assets, modelAssets]) assert.equal(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), Object.entries(hashes).filter(([name]) => assetDirectory(name) === directory).map(([name, hash]) => `${hash}  ${name}\n`).join(''));
  assert.deepEqual(downloadManifest.files, Object.entries(hashes).filter(([name]) => !name.endsWith('.wasm')).map(([name, sha256]) => ({ name, bytes: fs.statSync(path.join(modelAssets, name)).size, sha256 })));
  assert.match(downloadManifest.baseUrl, /^https:\/\/raw\.githubusercontent\.com\/WonderMr\/blincho\/[a-f0-9]{40}\/public\/camera\/$/);
  assert.match(fs.readFileSync(path.join(assets, 'LICENSE.txt'), 'utf8'), /Apache License/);
});

test('model weights only reference complete bundled shards and match manifest sizes', () => {
  const model = JSON.parse(fs.readFileSync(path.join(modelAssets, 'model.json'), 'utf8'));
  assert(Array.isArray(model.modelTopology.node));
  for (const group of model.weightsManifest) {
    for (const shard of group.paths) {
      assert.match(shard, /^group1-shard[1-5]of5$/);
      assert(hashes[shard]);
    }
    const bytes = group.weights.reduce((total, weight) => {
      const dtype = weight.quantization?.dtype ?? weight.dtype;
      const itemBytes = { float32: 4, int32: 4, bool: 1, uint8: 1, uint16: 2 }[dtype];
      assert(itemBytes, `known model dtype ${dtype}`);
      return total + weight.shape.reduce((size, dim) => size * dim, 1) * itemBytes;
    }, 0);
    assert.equal(group.paths.reduce((total, shard) => total + fs.statSync(path.join(modelAssets, shard)).size, 0), bytes);
  }
  for (const directory of [assets, modelAssets]) assert.deepEqual(fs.readdirSync(directory).sort(), [...Object.keys(hashes).filter(name => assetDirectory(name) === directory), 'LICENSE.txt', 'README.txt', 'SHA256SUMS.txt'].sort());
  assert(!fs.existsSync(path.join(assets, 'model.json')), 'model stays outside bundled public assets');
});

test('detector dependencies stay pinned without MediaPipe or any WebGL runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  for (const name of ['core', 'converter', 'backend-wasm', 'backend-cpu']) {
    assert.equal(packageJson.dependencies[`@tensorflow/tfjs-${name}`], '4.22.0');
    assert.equal(lock.packages[`node_modules/@tensorflow/tfjs-${name}`].version, '4.22.0');
  }
  assert.equal(packageJson.dependencies['@tensorflow-models/coco-ssd'], undefined);
  assert.equal(packageJson.dependencies['@mediapipe/tasks-vision'], undefined);
  assert(!Object.keys(lock.packages).some(name => /mediapipe|tfjs-backend-webgl/.test(name)));
});
