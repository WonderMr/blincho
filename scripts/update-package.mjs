import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

export const SIGNING_INPUTS = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'BLINCHO_MAC_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
export function macSigningMode(env = process.env) {
  const supplied = SIGNING_INPUTS.filter(key => typeof env[key] === 'string' && env[key].trim());
  if (!supplied.length) return false;
  if (supplied.length !== SIGNING_INPUTS.length) throw new Error('Incomplete macOS signing credentials; supply all six documented secrets or none');
  if (env.BLINCHO_MAC_SIGNING_IDENTITY.trim() === '-' || env.BLINCHO_MAC_SIGNING_IDENTITY.startsWith('Developer ID Application:')) throw new Error('Use the certificate owner identity without a prefix; ad-hoc signing is prohibited');
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('Invalid Apple team ID');
  return true;
}

export function packageSupport(platform, arch, target, signed = false) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid native target');
  const allowed = { darwin: ['zip'], win32: ['nsis', 'portable'], linux: ['AppImage', 'tar.gz'] };
  if (!allowed[platform].includes(target) || (signed && platform !== 'darwin')) throw new Error('Invalid package support combination');
  const packageType = platform === 'darwin' && signed ? 'mac-signed' : target === 'nsis' ? 'nsis' : target === 'AppImage' ? 'appimage' : 'manual';
  return { schemaVersion: 1, platform, arch, packageType, signed };
}

export function builderArtifactName(name, platform, arch) {
  return platform === 'linux' && arch === 'x64' && name.endsWith('.AppImage') ? name.replace('-x64.AppImage', '-x86_64.AppImage') : name;
}

// Runs after builder's signing and notarization and before zip creation. A failed
// check stops packaging; the provisional bundled signed flag is never published.
export function verifyMacSignature(appPath, teamId, run = spawnSync) {
  const invoke = (command, args) => {
    const result = run(command, args, { encoding: 'utf8', shell: false });
    if (result.error || result.status !== 0) throw new Error(`macOS signing verification failed: ${command}`);
    return `${result.stdout || ''}\n${result.stderr || ''}`;
  };
  invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const details = invoke('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
  if (!details.includes('Authority=Developer ID Application:') || !details.includes(`TeamIdentifier=${teamId}\n`) || !/flags=.*\bruntime\b/.test(details)) throw new Error('macOS application lacks the expected Developer ID, team or hardened runtime');
  invoke('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  invoke('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
}


export async function verifyPackagedSupport(resourcesDir, support, feed) {
  const require = createRequire(import.meta.url);
  const { extractFile, uncache } = require('@electron/asar');
  const { load } = require('js-yaml');
  const archive = path.join(resourcesDir, 'app.asar');
  // Multiple target builds can rewrite the same archive path in this process.
  uncache(archive);
  const bundled = JSON.parse(extractFile(archive, 'electron/update-support.json').toString('utf8'));
  if (JSON.stringify(bundled) !== JSON.stringify(support)) throw new Error('Packaged update support does not match the target');
  const config = load(await readFile(path.join(resourcesDir, 'app-update.yml'), 'utf8'));
  if (config?.provider !== 'generic' || config.url !== feed) throw new Error('Packaged updater feed does not match the canonical target');
}
