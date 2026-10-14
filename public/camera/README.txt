Local camera person detection assets

Runtime: @tensorflow/tfjs-core, tfjs-converter, tfjs-backend-wasm and
tfjs-backend-cpu 4.22.0. The presence adapter reads the original person
score output directly, using the layout verified in coco-ssd 2.2.3 source.
Copyright Google LLC. Runtime and model are distributed under Apache-2.0;
the license text is in LICENSE.txt.
WASM source: the pinned tfjs-backend-wasm npm package's dist directory,
copied unchanged. JavaScript is compiled into the app by Vite.
Model: COCO-SSD lite_mobilenet_v2, distributed by TensorFlow.js.
Manifest and five weight shards copied unchanged on 2026-10-14 from:
https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json
Shard URLs use the same directory and names from weightsManifest.paths.
Model SHA-256: 3770b2528339b1e3340cb74360e1e40401816b009779aeb8d0cce3a4353ea3a9
All bundled model/runtime hashes are recorded in SHA256SUMS.txt and pinned
independently in tests/camera-assets.test.cjs.
Model documentation: https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd
Runtime documentation: https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm
Model license: https://github.com/tensorflow/models/blob/master/LICENSE
Runtime license: https://github.com/tensorflow/tfjs/blob/master/LICENSE

These assets ship with the app. No remote model or runtime is fetched during
camera checks. Camera frames remain in memory on the device and are not saved.
Inference uses WASM CPU tensors. Presence does not require boxes or NMS. No WebGL backend is imported.
Threaded WASM is disabled for native webview compatibility; SIMD is detected
by TensorFlow.js, with the portable WASM binary available as a fallback.
