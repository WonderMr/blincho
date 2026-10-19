const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('This build targets macOS');
const args = process.argv.slice(2);
let debug = false;
let target;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--debug' && !debug) debug = true;
  else if (args[index] === '--target' && target === undefined) target = args[++index];
  else throw new Error('Invalid macOS bundle arguments');
}
const targetArchitectures = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x64' };
if (args.includes('--target') && (!target || targetArchitectures[target] !== process.arch)) {
  throw new Error('Invalid native macOS Rust target');
}
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const profile = debug ? 'debug' : 'release';
const binary = path.join(root, 'src-tauri/target', ...(target ? [target] : []), profile, 'blincho');
const icon = path.join(root, 'assets/icon.icns');
// Check inputs before replacing only this script's fixed output bundle.
for (const input of [binary, icon]) {
  if (!fs.statSync(input).isFile()) throw new Error(`Invalid macOS bundle input: ${input}`);
  fs.accessSync(input, fs.constants.R_OK);
}
const bundle = path.join(root, debug ? 'release/tauri-macos-debug/Blincho.app' : 'release/tauri-macos/Blincho.app');
const contents = path.join(bundle, 'Contents');
fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
fs.copyFileSync(binary, path.join(contents, 'MacOS/blincho'));
fs.chmodSync(path.join(contents, 'MacOS/blincho'), 0o755);
fs.copyFileSync(icon, path.join(contents, 'Resources/icon.icns'));
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.myeyes.app</string>
<key>CFBundleName</key><string>Blincho</string>
<key>CFBundleDisplayName</key><string>Blincho</string>
<key>CFBundleExecutable</key><string>blincho</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleDocumentTypes</key><array><dict>
<key>CFBundleTypeName</key><string>Blincho Shortcut</string>
<key>CFBundleTypeRole</key><string>Viewer</string>
<key>LSHandlerRank</key><string>Owner</string>
<key>LSItemContentTypes</key><array><string>com.myeyes.blincho-shortcut</string></array>
<key>CFBundleTypeExtensions</key><array><string>blincho</string></array>
<key>CFBundleTypeIconFile</key><string>icon.icns</string>
</dict></array>
<key>UTExportedTypeDeclarations</key><array><dict>
<key>UTTypeIdentifier</key><string>com.myeyes.blincho-shortcut</string>
<key>UTTypeDescription</key><string>Blincho Shortcut</string>
<key>UTTypeConformsTo</key><array><string>public.data</string></array>
<key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>blincho</string></array></dict>
</dict></array>
<key>NSCameraUsageDescription</key><string>Blincho checks presence after input inactivity or a timed break when you enable the corresponding option. It can lock the computer after confirmed absence. Camera frames stay on this device and are not saved.</string>
</dict></plist>`);
fs.writeFileSync(path.join(contents, 'Resources/blincho-runtime.json'), JSON.stringify({schemaVersion:1,runtime:'tauri',platform:'darwin',arch:process.arch,version,identifier:'com.myeyes.app',packageType:'manual',signed:false,notarized:false,updaterConfig:false}));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'inherit' });
console.log(bundle);
