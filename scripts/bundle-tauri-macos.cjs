const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw new Error('This build targets macOS');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const bundle = path.join(root, process.argv.includes('--debug') ? 'release/tauri-macos-debug/Blincho.app' : 'release/tauri-macos/Blincho.app');
const contents = path.join(bundle, 'Contents');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
fs.copyFileSync(path.join(root, process.argv.includes('--debug') ? 'src-tauri/target/debug/blincho' : 'src-tauri/target/release/blincho'), path.join(contents, 'MacOS/blincho'));
fs.chmodSync(path.join(contents, 'MacOS/blincho'), 0o755);
fs.copyFileSync(path.join(root, 'assets/icon.icns'), path.join(contents, 'Resources/icon.icns'));
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
</dict></plist>`);
fs.writeFileSync(path.join(contents, 'Resources/blincho-runtime.json'), JSON.stringify({schemaVersion:1,runtime:'tauri',platform:'darwin',arch:process.arch,version,identifier:'com.myeyes.app',packageType:'manual',signed:false,notarized:false,updaterConfig:false}));
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'inherit' });
console.log(bundle);
