Optional camera model assets

COCO-SSD lite_mobilenet_v2, Copyright Google LLC, Apache-2.0.
These files are kept in source control but excluded from public/ and the application bundle.
The app downloads them from an immutable commit in WonderMr/blincho only after camera opt-in.
src/data/cameraModelManifest.json pins the URL, exact size and SHA-256 of every file.
A complete verified set is cached in IndexedDB on the device for later offline inference.
The bundled public/camera directory contains only the TensorFlow.js WASM runtime and license.
Camera frames are processed locally and are never stored or uploaded.

Upstream model: https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd
Original model: https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json
