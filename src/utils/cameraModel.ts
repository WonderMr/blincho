import { getCameraModelArtifacts } from './cameraAssets';
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';

export async function loadPersonDetector() {
  const assets = new URL('camera/', document.baseURI).href;
  // Only CPU/WASM backends are imported. WebGL is never registered or probed.
  // Native webviews do not need SharedArrayBuffer or worker support for this.
  tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  setWasmPaths(assets);
  if (!await tf.setBackend('wasm')) throw new Error('Camera WASM runtime unavailable');
  await tf.ready();
  const model = await loadGraphModel(tf.io.fromMemory(await getCameraModelArtifacts()));

  let closed = false, disposed = false, active = 0;
  const dispose = () => {
    if (closed && !active && !disposed) { disposed = true; model.dispose(); }
  };
  return {
    async detect(image: HTMLCanvasElement) {
      if (closed) throw new Error('Camera detector is closed');
      active++;
      let input: tf.Tensor | undefined, output: tf.Tensor | tf.Tensor[] | undefined;
      try {
        input = tf.tidy(() => tf.expandDims(tf.browser.fromPixels(image)));
        // The bundled COCO-SSD model's Slice output removes background:
        // [1, 1917 proposals, 90 classes], with COCO class 1 (person) at column 0.
        // Presence uses every person's score, so boxes/NMS cannot suppress it.
        output = await model.executeAsync(input, 'Postprocessor/Slice');
        if (Array.isArray(output) || output.dtype !== 'float32' || output.shape.length !== 3 || output.shape[0] !== 1 || output.shape[1] !== 1917 || output.shape[2] !== 90) throw new Error('Camera model scores unavailable');
        const scores = await output.data();
        if (scores.length !== 1917 * 90) throw new Error('Camera model scores unavailable');
        let score = 0;
        for (let i = 0; i < scores.length; i += 90) {
          if (!Number.isFinite(scores[i]) || scores[i] < 0 || scores[i] > 1) throw new Error('Camera model scores invalid');
          score = Math.max(score, scores[i]);
        }
        return { detections: score >= 0.35 ? [{ categories: [{ categoryName: 'person', score }] }] : [] };
      } finally {
        tf.dispose(output); input?.dispose();
        active--; dispose();
      }
    },
    // An aborted check may still be executing WASM. Dispose after it settles.
    close() { closed = true; dispose(); },
  };
}
