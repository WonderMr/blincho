// Launch the actual verified release payload using the same isolated native
// renderer, history and timer checks used for development executables.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

async function run() {
  const { artifactName } = await import('../scripts/release-lib.mjs');
  const root = path.resolve(__dirname, '..');
  const version = require('../package.json').version;
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
  if (!platform || !['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported native package smoke platform');
  const target = platform === 'macos' ? 'zip' : platform === 'windows' ? 'portable' : 'AppImage';
  const file = path.join(root, 'release-upload', artifactName(version, platform, process.arch, target));
  const env = { ...process.env };
  let extracted;
  try {
    if (platform === 'macos') {
      extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-archive-smoke-'));
      execFileSync('/usr/bin/ditto', ['-x', '-k', file, extracted], { stdio: 'inherit' });
      env.BLINCHO_PROTOTYPE_EXECUTABLE = path.join(extracted, 'Blincho.app/Contents/MacOS/blincho');
    } else {
      env.BLINCHO_PROTOTYPE_EXECUTABLE = file;
      if (platform === 'linux') env.APPIMAGE_EXTRACT_AND_RUN = '1';
    }
    execFileSync(process.execPath, [path.join(__dirname, 'tauri-cross-platform-smoke.cjs')], { env, cwd: root, stdio: 'inherit' });
  } finally {
    if (extracted) fs.rmSync(extracted, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
