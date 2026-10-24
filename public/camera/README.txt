Local camera WASM runtime

TensorFlow.js 4.22.0, Copyright Google LLC, Apache-2.0.
The three WASM variants are copied unchanged from the pinned tfjs-backend-wasm npm package.
JavaScript is compiled into the app by Vite. SHA256SUMS.txt pins the WASM bytes.
The optional COCO-SSD model is in camera-model/ outside the application bundle.
At camera opt-in, the app downloads the pinned model from WonderMr/blincho on GitHub,
verifies every size and SHA-256 and caches the complete set on the device for offline use.
No camera frames are stored or sent to GitHub or any other server.
Threaded WASM is disabled; SIMD is detected with portable WASM as a fallback.
Runtime documentation: https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm
