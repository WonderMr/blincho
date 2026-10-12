import { readFile, mkdir, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertVersionMatch, expectedArtifacts, describeArtifact } from './release-lib.mjs';

const [platform, architecture] = process.argv.slice(2);
const nativePlatform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
if (platform !== nativePlatform || architecture !== process.arch || !['arm64', 'x64'].includes(architecture)) {
  throw new Error(`Native packaging requires ${platform}/${architecture}, got ${nativePlatform}/${process.arch}`);
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const version = assertVersionMatch(process.env.RELEASE_TAG, packageJson, JSON.parse(await readFile('package-lock.json', 'utf8')));
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const buildPlatform = { macos: Platform.MAC, windows: Platform.WINDOWS, linux: Platform.LINUX }[platform];
const targets = { macos: ['zip'], windows: ['nsis', 'portable'], linux: ['AppImage', 'tar.gz'] }[platform];
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await build({
  targets: buildPlatform.createTarget(targets, Arch[architecture]),
  publish: 'never',
  config: {
    forceCodeSigning: false,
    mac: { identity: null, notarize: false, artifactName: 'Blincho-${version}-macos-${arch}.${ext}' },
    win: { signExecutable: false },
    nsis: { artifactName: 'Blincho-${version}-windows-${arch}-setup.${ext}' },
    portable: { artifactName: 'Blincho-${version}-windows-${arch}-portable.${ext}' },
    linux: { artifactName: 'Blincho-${version}-linux-${arch}.${ext}' },
  },
});
// Upload only the deterministic public packages, never unpacked apps or builder metadata.
await mkdir('release-upload', { recursive: true });
for (const name of expectedArtifacts(version)) {
  const artifact = describeArtifact(name, version);
  if (artifact.platform !== platform || artifact.architecture !== architecture) continue;
  const source = path.join(packageJson.build.directories.output, name);
  if (!(await stat(source)).size) throw new Error(`Empty release artifact: ${name}`);
  await copyFile(source, path.join('release-upload', name));
}
