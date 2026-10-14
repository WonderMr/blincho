import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

export async function loadPersonDetector() {
  const assets = new URL('camera/', document.baseURI).href.replace(/\/$/, '');
  // Use the portable WASM runtime on WKWebView, including Intel Macs.
  const files = window.electronAPI?.platform === 'darwin' ? {
    wasmLoaderPath: `${assets}/vision_wasm_nosimd_internal.js`,
    wasmBinaryPath: `${assets}/vision_wasm_nosimd_internal.wasm`,
  } : await FilesetResolver.forVisionTasks(assets);
  return ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${assets}/efficientdet_lite0.tflite`, delegate: 'CPU' },
    // WebKitGTK can expose OffscreenCanvas without a working WebGL context.
    canvas: document.createElement('canvas'),
    runningMode: 'IMAGE', categoryAllowlist: ['person'], scoreThreshold: 0.35,
  });
}
