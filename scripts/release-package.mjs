import { readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertVersionMatch, expectedArtifacts, describeArtifact, hashFile, receiptName, validateReceipt, usesTauriMac } from './release-lib.mjs';
import { packageSupport, builderArtifactName, verifyPackagedSupport, verifyTauriMacBundle } from './update-package.mjs';

const [platform, architecture] = process.argv.slice(2);
const nativePlatform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
if (platform !== nativePlatform || architecture !== process.arch || !['arm64', 'x64'].includes(architecture)) {
  throw new Error(`Native packaging requires ${platform}/${architecture}, got ${nativePlatform}/${process.arch}`);
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (packageJson.build.appId !== 'com.myeyes.app') throw new Error('Application identity must remain com.myeyes.app');
const version = assertVersionMatch(process.env.RELEASE_TAG, packageJson, JSON.parse(await readFile('package-lock.json', 'utf8')));
await mkdir('release-upload', { recursive: true });
const receipt = { schemaVersion: 1, version, platform: process.platform, arch: architecture, runtime: platform === 'macos' ? 'tauri' : 'electron', artifacts: [] };

if (platform === 'macos') {
  if (!usesTauriMac(version)) throw new Error('This pipeline packages Tauri macOS releases from 1.5.0 onward');
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  if (config.identifier !== 'com.myeyes.app' || config.productName !== 'Blincho' || config.version !== version) throw new Error('Tauri project identity or version does not match the release');
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw new Error(`Tauri macOS build failed: ${command}`);
  };
  // Rebuild the current locked Cargo project and remove stale bundles before
  // running the shared bundler. Windows and Linux do not execute this branch.
  await rm('release/tauri-macos', { recursive: true, force: true });
  run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--locked']);
  run(process.execPath, ['scripts/bundle-tauri-macos.cjs']);
  const bundle = path.resolve('release/tauri-macos/Blincho.app');
  await verifyTauriMacBundle(bundle, version, architecture);
  const name = `Blincho-${version}-macos-${architecture}.zip`;
  const destination = path.resolve('release-upload', name);
  await rm(destination, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, destination]);
  const size = (await stat(destination)).size;
  if (!size) throw new Error(`Empty release artifact: ${name}`);
  receipt.artifacts.push({ name, size, sha256: await hashFile(destination), sha512: await hashFile(destination, 'sha512', 'base64'), packageType: 'manual', signed: false, notarized: false, updaterConfig: false, bundleVerified: true });
  validateReceipt(receipt, version);
  await writeFile(path.join('release-upload', receiptName(version, process.platform, architecture)), JSON.stringify(receipt, null, 2) + '\n');
} else {
  const signed = false;
  const require = createRequire(import.meta.url);
  const { build, Platform, Arch } = require('electron-builder');
  const buildPlatform = { windows: Platform.WINDOWS, linux: Platform.LINUX }[platform];
  const targets = { windows: ['nsis', 'portable'], linux: ['AppImage', 'tar.gz'] }[platform];
  const feed = `https://blincho.app/updates/${process.platform}/${architecture}/`;
  const supportFile = 'electron/update-support.json';
  let originalSupport;
  try { originalSupport = await readFile(supportFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  try {
    // Separate builds ensure portable Windows and Linux archives contain manual
    // support metadata, even though they share the same application source.
    for (const target of targets) {
      const support = packageSupport(process.platform, architecture, target, signed);
      await writeFile(supportFile, JSON.stringify(support) + '\n');
      let resourcesDir;
      await build({
        targets: buildPlatform.createTarget([target], Arch[architecture]),
        publish: 'never',
        config: {
          forceCodeSigning: signed,
          publish: [{ provider: 'generic', url: feed }],
          win: { signExecutable: false },
          nsis: { artifactName: 'Blincho-${version}-windows-${arch}-setup.${ext}' },
          portable: { artifactName: 'Blincho-${version}-windows-${arch}-portable.${ext}' },
          linux: { artifactName: 'Blincho-${version}-linux-${arch}.${ext}' },
          afterPack: async context => {
            resourcesDir = context.packager.getResourcesDir(context.appOutDir);
            // Also provide config in manual-only packages. JSON is valid YAML.
            await writeFile(path.join(resourcesDir, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feed, updaterCacheDirName: 'blincho-updater' }) + '\n');
          },
        },
      });
      if (!resourcesDir) throw new Error('Missing packaged application resources');
      await verifyPackagedSupport(resourcesDir, support, feed);
      const extension = { nsis: '-setup.exe', portable: '-portable.exe', AppImage: '.AppImage', 'tar.gz': '.tar.gz' }[target];
      const name = expectedArtifacts(version).find(name => {
        const artifact = describeArtifact(name, version);
        return artifact.platform === platform && artifact.architecture === architecture && name.endsWith(extension);
      });
      const source = path.join(packageJson.build.directories.output, builderArtifactName(name, platform, architecture));
      if (!(await stat(source)).size) throw new Error(`Empty release artifact: ${name}`);
      const destination = path.join('release-upload', name);
      await copyFile(source, destination);
      receipt.artifacts.push({ name, size: (await stat(destination)).size, sha256: await hashFile(destination), sha512: await hashFile(destination, 'sha512', 'base64'), packageType: support.packageType, signed, notarized: false, updaterConfig: true });
    }
    validateReceipt(receipt, version);
    await writeFile(path.join('release-upload', receiptName(version, process.platform, architecture)), JSON.stringify(receipt, null, 2) + '\n');
  } finally {
    if (originalSupport) await writeFile(supportFile, originalSupport);
    else await rm(supportFile, { force: true });
  }
}
