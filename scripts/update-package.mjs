import { spawnSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export function tauriMacMetadata(version, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Invalid Tauri macOS architecture');
  return { schemaVersion: 1, runtime: 'tauri', platform: 'darwin', arch, version, identifier: 'com.myeyes.app', packageType: 'manual', signed: false, notarized: false, updaterConfig: false };
}

export function tauriMetadata(version, platform, arch) {
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid Tauri native target');
  return { schemaVersion: 1, runtime: 'tauri', platform, arch, version, identifier: 'com.myeyes.app', packageType: 'manual', signed: false, notarized: false, updaterConfig: false };
}

// A release-only compile-time string is returned by get_runtime_metadata, so it
// remains in the actual executable and can be checked without launching the app.
export async function verifyTauriExecutable(file, version, platform, arch) {
  const info = await lstat(file);
  if (!info.isFile() || !info.size) throw new Error('Missing or invalid Tauri executable');
  const bytes = await readFile(file);
  if (!bytes.includes(Buffer.from(JSON.stringify(tauriMetadata(version, platform, arch))))) throw new Error('Tauri executable metadata does not match the release');
  if (platform === 'win32') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows Tauri executable');
    const offset = bytes.readUInt32LE(60);
    if (offset > bytes.length - 24 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid Windows PE header');
    if (bytes.readUInt16LE(offset + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) throw new Error('Tauri executable architecture does not match the release');
    const optional = offset + 24;
    if (optional > bytes.length - 2 || bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Expected Windows PE32+ executable');
    const certificate = optional + 112 + 8 * 4;
    if (certificate > bytes.length - 8 || bytes.readUInt32LE(certificate) || bytes.readUInt32LE(certificate + 4)) throw new Error('Tauri Windows executable must be unsigned');
  } else if (platform === 'linux') {
    if (bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Invalid Linux ELF64 executable');
    if (bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)) throw new Error('Tauri executable architecture does not match the release');
    if (!(info.mode & 0o111)) throw new Error('Tauri executable is not executable');
  } else throw new Error('Unsupported Tauri executable verification target');
  return bytes;
}

// The manual Tauri bundle has no Electron updater configuration. Inspect its
// actual metadata, executable and ad hoc signature before producing a receipt.
export async function verifyTauriMacBundle(appPath, version, arch, run = spawnSync) {
  for (const directory of [appPath, path.join(appPath, 'Contents'), path.join(appPath, 'Contents/MacOS'), path.join(appPath, 'Contents/Resources')]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Missing or invalid Tauri macOS bundle directory');
  }
  const requireFile = async file => {
    const info = await lstat(file);
    if (!info.isFile() || !info.size) throw new Error('Missing or invalid Tauri macOS bundle file');
    return info;
  };
  const contents = path.join(appPath, 'Contents');
  const metadataPath = path.join(contents, 'Resources/blincho-runtime.json');
  await requireFile(metadataPath);
  const expected = tauriMacMetadata(version, arch);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (!metadata || Object.keys(metadata).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => metadata[key] !== value)) throw new Error('Tauri macOS bundle metadata does not match the release');
  const invoke = (command, args) => {
    const result = run(command, args, { encoding: 'utf8', shell: false });
    if (result.error || result.status !== 0) throw new Error(`Tauri macOS bundle verification failed: ${command}`);
    return `${result.stdout || ''}\n${result.stderr || ''}`;
  };
  const plistPath = path.join(contents, 'Info.plist');
  await requireFile(plistPath);
  const plist = JSON.parse(invoke('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
  if (plist.CFBundleIdentifier !== expected.identifier || plist.CFBundleName !== 'Blincho' || plist.CFBundleDisplayName !== 'Blincho' || plist.CFBundleExecutable !== 'blincho' || plist.CFBundlePackageType !== 'APPL' || plist.CFBundleShortVersionString !== version || plist.CFBundleVersion !== version) throw new Error('Tauri macOS bundle identity or version does not match the release');
  const executable = path.join(contents, 'MacOS/blincho');
  if (!((await requireFile(executable)).mode & 0o111)) throw new Error('Tauri macOS bundle executable is not executable');
  const nativeArchitecture = arch === 'x64' ? 'x86_64' : 'arm64';
  if (invoke('/usr/bin/lipo', ['-archs', executable]).trim() !== nativeArchitecture) throw new Error('Tauri macOS bundle architecture does not match the release');
  invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const signature = invoke('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
  if (!signature.includes('Signature=adhoc') || !signature.includes('TeamIdentifier=not set') || signature.includes('Authority=')) throw new Error('Tauri macOS release requires an ad hoc signature and manual updates');
  return expected;
}
