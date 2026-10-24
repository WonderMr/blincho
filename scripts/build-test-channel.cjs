const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const target = process.argv[2];
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-gnu',
};
const expected = targets[`${process.platform}-${process.arch}`];
if (!expected || (target && target !== expected) || process.argv.length > 3) throw new Error('Unsupported native test build target');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.test.conf.json'), 'utf8'));
if (config.identifier !== 'com.myeyes.test' || config.productName !== 'Blincho Test' || config.bundle.fileAssociations.length) throw new Error('Invalid test identity');
const version = require('../package.json').version;
const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const targetDirectory = path.join(root, 'release/test-target');
const output = path.join(root, 'release/test-channel');
const artifacts = path.join(root, 'release/test-artifacts');
const env = { ...process.env, TAURI_CONFIG: JSON.stringify(config), CARGO_TARGET_DIR: targetDirectory };
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: root, env, stdio: 'inherit', ...extra });
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rustArgs = target ? ['--target', target] : [];
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(artifacts, { recursive: true });
run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')]);
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build']);
run('cargo', ['build', '--locked', '--release', '--manifest-path', 'src-tauri/Cargo.toml', ...rustArgs]);
const binary = path.join(targetDirectory, ...(target ? [target] : []), 'release', process.platform === 'win32' ? 'blincho.exe' : 'blincho');
const receipt = { identifier: config.identifier, productName: config.productName, sha256: digest(binary) };
fs.writeFileSync(path.join(path.dirname(binary), 'test-channel-receipt.json'), JSON.stringify(receipt));
let payload;
if (process.platform === 'darwin') {
  run(process.execPath, ['scripts/bundle-tauri-macos.cjs', '--test', ...(target ? ['--target', target] : [])]);
  payload = path.join(output, 'Blincho Test.app');
} else if (process.platform === 'win32') {
  payload = path.join(output, 'Blincho Test.exe');
  fs.copyFileSync(binary, payload);
} else {
  run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--config', 'src-tauri/tauri.test.conf.json', '--bundles', 'appimage', '--ci', '--no-sign', '--no-binary-patching', ...(target ? ['--target', target] : []), '--', '--locked']);
  const directory = path.join(path.dirname(binary), 'bundle/appimage');
  const images = fs.readdirSync(directory).filter(name => name.endsWith('.AppImage'));
  if (images.length !== 1) throw new Error('Expected one test AppImage');
  payload = path.join(output, 'Blincho-Test.AppImage');
  fs.copyFileSync(path.join(directory, images[0]), payload);
  fs.chmodSync(payload, 0o755);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
const build = { schemaVersion: 1, channel: 'test', version, head, dirty, platform, architecture: process.arch,
  identifier: config.identifier, productName: config.productName, sourceBinarySha256: receipt.sha256,
  ...(process.platform === 'linux' ? { appImageSha256: digest(payload) }
    : { packagedBinarySha256: digest(process.platform === 'darwin' ? path.join(payload, 'Contents/MacOS/blincho') : payload) }),
  automaticUpdates: false, autostart: false, legacyImport: false, stableFileAssociations: false };
fs.writeFileSync(path.join(output, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'README.txt'), `Blincho Test ${version}\n\nOpen ${path.basename(payload)} directly. This portable test channel has a separate identity and profile and can run alongside Blincho. It does not import the stable profile, register login startup, create desktop shortcuts or check the stable update feed. Sync is disabled by default. Enable it explicitly for account tests. Use a separate test account for cloud isolation. Signing into the same account intentionally shares settings, statistics and breaks. Pause the other application while testing breaks.\n\nmacOS requires version 14 or later. This local macOS build is ad-hoc signed, without notarization. Portable Windows requires WebView2 and can register its own Blincho Test notification shortcut in the Start Menu. Linux uses an AppImage; make it executable before opening it. Do not run it through a desktop-integration tool. No installer or system package is provided.\n\nSync credentials and encryption keys remain in memory. Reconnect after restarting. Physical account sync and timing across devices still require manual verification.\n\nSource: ${head}${dirty ? ' (local changes)' : ''}\n`);
const stem = `Blincho-Test-${version}-${platform}-${process.arch}`;
const archive = path.join(artifacts, stem + (process.platform === 'linux' ? '.tar.gz' : '.zip'));
const entries = [path.basename(payload), 'BUILD.json', 'README.txt'];
if (process.platform === 'darwin') {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', output, archive]);
} else if (process.platform === 'win32') {
  // Pass paths as environment values, never as executable PowerShell source.
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath ($env:BLINCHO_TEST_FILES | ConvertFrom-Json) -DestinationPath $env:BLINCHO_TEST_ZIP -Force'],
    { env: { ...env, BLINCHO_TEST_FILES: JSON.stringify(entries.map(name => path.join(output, name))), BLINCHO_TEST_ZIP: archive } });
} else {
  run('tar', ['-czf', archive, '-C', output, ...entries]);
}
fs.writeFileSync(archive + '.sha256', `${digest(archive)}  ${path.basename(archive)}\n`);
console.log(archive);
