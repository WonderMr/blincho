import { readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertVersionMatch, artifactNames, hashFile, receiptName, validateReceipt, usesTauriMac, usesTauriDesktop } from './release-lib.mjs';
import { verifyTauriMacBundle } from './update-package.mjs';
import { packageTauriDesktop } from './bundle-tauri-desktop.mjs';

const [platform, architecture] = process.argv.slice(2);
const nativePlatform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
if (platform !== nativePlatform || architecture !== process.arch || !['arm64', 'x64'].includes(architecture)) {
  throw new Error(`Native packaging requires ${platform}/${architecture}, got ${nativePlatform}/${process.arch}`);
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const version = assertVersionMatch(process.env.RELEASE_TAG, packageJson, JSON.parse(await readFile('package-lock.json', 'utf8')));
await mkdir('release-upload', { recursive: true });
const receipt = { schemaVersion: 1, version, platform: process.platform, arch: architecture, runtime: 'tauri', artifacts: [] };

if (platform === 'macos') {
  if (!usesTauriMac(version)) throw new Error('This pipeline packages Tauri macOS releases from 1.5.0 onward');
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  if (config.identifier !== 'com.myeyes.app' || config.productName !== 'Blincho' || config.version !== version) throw new Error('Tauri project identity or version does not match the release');
  const expectedRustTarget = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[architecture];
  const rustTarget = process.env.RUST_TARGET || expectedRustTarget;
  if (rustTarget !== expectedRustTarget) throw new Error('Invalid native macOS Rust target');
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw new Error(`Tauri macOS build failed: ${command}`);
  };
  // The shared bundler replaces its own output after validating build inputs.
  // Windows and Linux do not execute this branch.
  run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--locked', '--target', rustTarget]);
  run(process.execPath, ['scripts/bundle-tauri-macos.cjs', '--target', rustTarget]);
  const bundle = path.resolve('release/tauri-macos/Blincho.app');
  await verifyTauriMacBundle(bundle, version, architecture);
  const [name, alias] = artifactNames(version, platform, architecture, 'zip');
  const destination = path.resolve('release-upload', name);
  await rm(destination, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, destination]);
  const size = (await stat(destination)).size;
  if (!size) throw new Error(`Empty release artifact: ${name}`);
  receipt.artifacts.push({ name, size, sha256: await hashFile(destination), sha512: await hashFile(destination, 'sha512', 'base64'), packageType: 'manual', signed: false, notarized: false, updaterConfig: false, bundleVerified: true });
  if (alias) {
    await copyFile(destination, path.resolve('release-upload', alias));
    receipt.artifacts.push({ ...receipt.artifacts[0], name: alias });
  }
  validateReceipt(receipt, version);
  await writeFile(path.join('release-upload', receiptName(version, process.platform, architecture)), JSON.stringify(receipt, null, 2) + '\n');
} else if (usesTauriDesktop(version)) {
  await packageTauriDesktop(platform, architecture, version, receipt);
  validateReceipt(receipt, version);
  await writeFile(path.join('release-upload', receiptName(version, process.platform, architecture)), JSON.stringify(receipt, null, 2) + '\n');
} else {
  throw new Error('This pipeline only packages Tauri desktop releases from 1.6.0 onward');
}
