import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

export async function loadPersonDetector() {
  const assets = new URL('camera/', document.baseURI).href.replace(/\/$/, '');
  const files = await FilesetResolver.forVisionTasks(assets);
  return ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${assets}/efficientdet_lite0.tflite`, delegate: 'CPU' },
    // WebKitGTK can expose OffscreenCanvas without a working WebGL context.
    canvas: document.createElement('canvas'),
    runningMode: 'IMAGE', categoryAllowlist: ['person'], scoreThreshold: 0.35,
  });
}
