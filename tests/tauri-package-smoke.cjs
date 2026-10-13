// Launch the actual verified release payload using the same isolated native
// renderer, history and timer checks used for development executables.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
if (!platform || !['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported native package smoke platform');
const base = path.join(root, 'release-upload', `Blincho-${version}-${platform}-${process.arch}`);
const env = { ...process.env };
let extracted;
try {
  if (platform === 'macos') {
    extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-archive-smoke-'));
    execFileSync('/usr/bin/ditto', ['-x', '-k', `${base}.zip`, extracted], { stdio: 'inherit' });
    env.BLINCHO_PROTOTYPE_EXECUTABLE = path.join(extracted, 'Blincho.app/Contents/MacOS/blincho');
  } else if (platform === 'windows') {
    env.BLINCHO_PROTOTYPE_EXECUTABLE = `${base}-portable.exe`;
  } else {
    env.BLINCHO_PROTOTYPE_EXECUTABLE = `${base}.AppImage`;
    env.APPIMAGE_EXTRACT_AND_RUN = '1';
  }
  execFileSync(process.execPath, [path.join(__dirname, 'tauri-cross-platform-smoke.cjs')], { env, cwd: root, stdio: 'inherit' });
} finally {
  if (extracted) fs.rmSync(extracted, { recursive: true, force: true });
}
