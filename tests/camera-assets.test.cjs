const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '..');
test('offline camera runtime matches the pinned dependency and bundled model bytes', () => {
  for (const name of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
    const shipped = fs.readFileSync(path.join(repo, 'public/camera', name));
    const upstream = fs.readFileSync(path.join(repo, 'node_modules/@mediapipe/tasks-vision/wasm', name));
    assert(shipped.equals(upstream), `${name} matches the installed pinned runtime`);
  }
  const model = fs.readFileSync(path.join(repo, 'public/camera/efficientdet_lite0.tflite'));
  assert.equal(createHash('sha256').update(model).digest('hex'), '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb');
  assert.equal(model.subarray(4, 8).toString(), 'TFL3');
  assert.match(fs.readFileSync(path.join(repo, 'public/camera/LICENSE.txt'), 'utf8'), /Apache License/);
});
