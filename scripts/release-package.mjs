import { readFile, writeFile, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertVersionMatch, expectedArtifacts, describeArtifact, hashFile, receiptName, validateReceipt } from './release-lib.mjs';
import { macSigningMode, packageSupport, builderArtifactName, verifyMacSignature, verifyPackagedSupport } from './update-package.mjs';

const [platform, architecture] = process.argv.slice(2);
const nativePlatform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
if (platform !== nativePlatform || architecture !== process.arch || !['arm64', 'x64'].includes(architecture)) {
  throw new Error(`Native packaging requires ${platform}/${architecture}, got ${nativePlatform}/${process.arch}`);
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (packageJson.build.appId !== 'com.myeyes.app') throw new Error('Application identity must remain com.myeyes.app');
const version = assertVersionMatch(process.env.RELEASE_TAG, packageJson, JSON.parse(await readFile('package-lock.json', 'utf8')));
const signed = platform === 'macos' ? macSigningMode() : false;
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const buildPlatform = { macos: Platform.MAC, windows: Platform.WINDOWS, linux: Platform.LINUX }[platform];
const targets = { macos: ['zip'], windows: ['nsis', 'portable'], linux: ['AppImage', 'tar.gz'] }[platform];
const feed = `https://blincho.app/updates/${process.platform}/${architecture}/`;
const supportFile = 'electron/update-support.json';
const receipt = { schemaVersion: 1, version, platform: process.platform, arch: architecture, artifacts: [] };
let originalSupport;
try { originalSupport = await readFile(supportFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await mkdir('release-upload', { recursive: true });
try {
  // Separate builds ensure portable Windows and Linux archives contain manual
  // support metadata, even though they share the same application source.
  for (const target of targets) {
    const support = packageSupport(process.platform, architecture, target, signed);
    await writeFile(supportFile, JSON.stringify(support) + '\n');
    let resourcesDir;
    let signatureVerified = false;
    await build({
      targets: buildPlatform.createTarget([target], Arch[architecture]),
      publish: 'never',
      config: {
        forceCodeSigning: signed,
        publish: [{ provider: 'generic', url: feed }],
        mac: { identity: signed ? process.env.BLINCHO_MAC_SIGNING_IDENTITY : null, type: 'distribution', notarize: signed, hardenedRuntime: signed, artifactName: 'Blincho-${version}-macos-${arch}.${ext}' },
        win: { signExecutable: false },
        nsis: { artifactName: 'Blincho-${version}-windows-${arch}-setup.${ext}' },
        portable: { artifactName: 'Blincho-${version}-windows-${arch}-portable.${ext}' },
        linux: { artifactName: 'Blincho-${version}-linux-${arch}.${ext}' },
        afterPack: async context => {
          resourcesDir = context.packager.getResourcesDir(context.appOutDir);
          // Also provide config in manual-only packages. JSON is valid YAML.
          await writeFile(path.join(resourcesDir, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feed, updaterCacheDirName: 'blincho-updater' }) + '\n');
        },
        afterSign: async context => {
          if (!signed) return;
          verifyMacSignature(path.join(context.appOutDir, 'Blincho.app'), process.env.APPLE_TEAM_ID);
          signatureVerified = true;
        },
      },
    });
    if (signed && !signatureVerified) throw new Error('Signed macOS package was not verified');
    if (!resourcesDir) throw new Error('Missing packaged application resources');
    await verifyPackagedSupport(resourcesDir, support, feed);
    const extension = { zip: '.zip', nsis: '-setup.exe', portable: '-portable.exe', AppImage: '.AppImage', 'tar.gz': '.tar.gz' }[target];
    const name = expectedArtifacts(version).find(name => {
      const artifact = describeArtifact(name, version);
      return artifact.platform === platform && artifact.architecture === architecture && name.endsWith(extension);
    });
    const source = path.join(packageJson.build.directories.output, builderArtifactName(name, platform, architecture));
    if (!(await stat(source)).size) throw new Error(`Empty release artifact: ${name}`);
    const destination = path.join('release-upload', name);
    await copyFile(source, destination);
    receipt.artifacts.push({ name, size: (await stat(destination)).size, sha256: await hashFile(destination), sha512: await hashFile(destination, 'sha512', 'base64'), packageType: support.packageType, signed, notarized: signatureVerified, updaterConfig: true });
  }
  validateReceipt(receipt, version);
  await writeFile(path.join('release-upload', receiptName(version, process.platform, architecture)), JSON.stringify(receipt, null, 2) + '\n');
} finally {
  if (originalSupport) await writeFile(supportFile, originalSupport);
  else await rm(supportFile, { force: true });
}
