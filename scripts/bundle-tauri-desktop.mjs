import { readFile, readdir, lstat, stat, realpath, mkdir, rm, mkdtemp, rename, copyFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactName, artifactNames, hashFile, usesLinuxInstallers } from './release-lib.mjs';
import { tauriMetadata, verifyTauriExecutable } from './update-package.mjs';

export const RUST_TARGETS = {
  macos: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  windows: { arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' },
  linux: { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' },
};

export function nativeRustTarget(platform, architecture, supplied = process.env.RUST_TARGET) {
  const expected = RUST_TARGETS[platform]?.[architecture];
  if (!expected || (supplied && supplied !== expected)) throw new Error('Invalid native Rust target');
  return expected;
}

async function onlyArtifact(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = entries.filter(entry => entry.isFile() && entry.name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Expected one Tauri ${suffix} bundle`);
  const file = path.join(directory, matches[0].name);
  if (!(await stat(file)).size) throw new Error('Empty Tauri bundle');
  return file;
}

async function filesNamed(directory, name) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesNamed(file, name));
    else if (entry.isFile() && entry.name === name) files.push(file);
  }
  return files;
}

function assertUnsignedWindowsPackage(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows installer');
  const pe = bytes.readUInt32LE(60);
  if (pe > bytes.length - 24 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid Windows installer PE header');
  const optional = pe + 24;
  if (optional > bytes.length - 2) throw new Error('Invalid Windows installer optional header');
  const magic = bytes.readUInt16LE(optional);
  if (![0x10b, 0x20b].includes(magic)) throw new Error('Invalid Windows installer optional header');
  const certificate = optional + (magic === 0x20b ? 112 : 96) + 8 * 4;
  if (certificate > bytes.length - 8 || bytes.readUInt32LE(certificate) || bytes.readUInt32LE(certificate + 4)) throw new Error('Tauri Windows installer must be unsigned');
}

async function verifyLinuxInstaller(bundle, format, architecture, version, executable, temporary, invoke) {
  const query = options => ({ stdio: 'pipe', encoding: 'utf8', ...options });
  const identity = format === 'deb'
    ? invoke('dpkg-deb', ['--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', bundle], query()).stdout
    : invoke('rpm', ['-qp', '--queryformat', '%{NAME}\n%{VERSION}\n%{ARCH}\n', bundle], query()).stdout;
  const expectedArch = format === 'deb' ? { x64: 'amd64', arm64: 'arm64' }[architecture] : { x64: 'x86_64', arm64: 'aarch64' }[architecture];
  if (String(identity).trim() !== `blincho\n${version}\n${expectedArch}`) throw new Error(`Invalid ${format} package identity or architecture`);
  const dependencies = String(format === 'deb'
    ? invoke('dpkg-deb', ['--field', bundle, 'Depends'], query()).stdout
    : invoke('rpm', ['-qp', '--requires', bundle], query()).stdout);
  const names = format === 'deb'
    ? dependencies.trim().split(/,\s*/).map(item => item.split(/[\s(]/)[0])
    : dependencies.trim().split(/\r?\n/).map(item => item.split(/\s/)[0]);
  const required = format === 'deb'
    ? ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good']
    : ['libwebkit2gtk-4.1.so.0()(64bit)', 'libgtk-3.so.0()(64bit)', 'gstreamer1-plugins-base', 'gstreamer1-plugins-good'];
  const tray = format === 'deb' ? ['libayatana-appindicator3-1', 'libappindicator3-1'] : ['libayatana-appindicator3.so.1()(64bit)', 'libappindicator3.so.1()(64bit)'];
  if (!required.every(name => names.includes(name)) || !tray.some(name => names.includes(name))) throw new Error(`Missing ${format} system runtime dependencies`);
  const extracted = path.join(temporary, format);
  await mkdir(extracted);
  if (format === 'deb') invoke('dpkg-deb', ['--extract', bundle, extracted], query());
  else invoke('bsdtar', ['-xf', bundle, '-C', extracted], query());
  const packaged = path.join(extracted, 'usr/bin/blincho');
  await verifyTauriExecutable(packaged, version, 'linux', architecture);
  if (await hashFile(packaged) !== await hashFile(executable)) throw new Error(`Tauri ${format} executable differs from the verified Cargo executable`);
  const entries = await readdir(path.join(extracted, 'usr/share/applications'), { withFileTypes: true });
  if (!entries.some(entry => entry.isFile() && entry.name.endsWith('.desktop'))) throw new Error(`Missing ${format} desktop entry`);
  const icons = await filesNamed(path.join(extracted, 'usr/share/icons'), 'blincho.png');
  if (!icons.length) throw new Error(`Missing ${format} application icon`);
  // These installed packages use system WebKitGTK instead of a portable AppDir.
  const libraries = await filesNamed(extracted, 'libwebkit2gtk-4.1.so.0');
  if (libraries.length) throw new Error(`Unexpected bundled WebKitGTK in ${format} package`);
}

// Use the pinned Tauri CLI for native NSIS/AppImage/deb/rpm packaging. Portable Windows
// ships its self-contained Rust executable. Linux tar.gz ships the same AppDir
// and libraries as the AppImage, including its AppRun launcher.
export async function packageTauriDesktop(platform, architecture, version, receipt, run = spawnSync) {
  if (!['windows', 'linux'].includes(platform)) throw new Error('Unsupported Tauri desktop bundler');
  const runtimePlatform = platform === 'windows' ? 'win32' : 'linux';
  const target = nativeRustTarget(platform, architecture);
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  if (config.identifier !== 'com.myeyes.app' || config.productName !== 'Blincho' || config.version !== version || config.bundle?.active !== true || config.bundle.createUpdaterArtifacts !== false || config.plugins?.updater) throw new Error('Tauri project identity, version or manual bundle configuration does not match the release');
  if (process.env.CARGO_TARGET_DIR) throw new Error('Release packaging requires the project Cargo target directory');
  const metadata = JSON.stringify(tauriMetadata(version, runtimePlatform, architecture));
  const invoke = (command, args, options = {}) => {
    const result = run(command, args, { stdio: 'inherit', shell: false, env: { ...process.env, BLINCHO_RELEASE_METADATA: metadata, ...(platform === 'linux' ? { NO_STRIP: '1' } : {}) }, ...options });
    if (result.error || result.status !== 0) throw new Error(`Tauri native packaging failed: ${command}`);
    return result;
  };
  const output = path.resolve('src-tauri/target', target, 'release');
  const installers = platform === 'linux' && usesLinuxInstallers(version);
  const bundleTypes = platform === 'windows' ? ['nsis'] : installers ? ['appimage', 'deb', 'rpm'] : ['appimage'];
  const bundleType = bundleTypes[0];
  const bundleDirectory = path.join(output, 'bundle', bundleType);
  // A previous installer must never be mistaken for this build's output.
  for (const type of bundleTypes) await rm(path.join(output, 'bundle', type), { recursive: true, force: true });
  invoke(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--target', target, '--bundles', bundleTypes.join(','), '--ci', '--no-sign', '--no-binary-patching', '--', '--locked']);
  const executable = path.join(output, platform === 'windows' ? 'blincho.exe' : 'blincho');
  await verifyTauriExecutable(executable, version, runtimePlatform, architecture);
  const bundle = await onlyArtifact(bundleDirectory, platform === 'windows' ? '-setup.exe' : '.AppImage');
  const temporary = await mkdtemp(path.join(tmpdir(), 'blincho-package-'));
  const upload = path.resolve('release-upload');
  await mkdir(upload, { recursive: true });
  const record = async (source, target) => {
    for (const name of artifactNames(version, platform, architecture, target)) {
      const destination = path.join(upload, name);
      if (source !== destination) await copyFile(source, destination);
      if (platform === 'linux' && target === 'AppImage') await chmod(destination, 0o755);
      receipt.artifacts.push({ name, size: (await stat(destination)).size, sha256: await hashFile(destination), sha512: await hashFile(destination, 'sha512', 'base64'), packageType: 'manual', signed: false, notarized: false, updaterConfig: false, bundleVerified: true });
    }
  };
  try {
    if (platform === 'windows') {
      assertUnsignedWindowsPackage(await readFile(bundle));
      const extracted = path.join(temporary, 'installer');
      invoke('7z', ['x', '-y', `-o${extracted}`, bundle], { stdio: 'pipe', encoding: 'utf8' });
      const installed = await filesNamed(extracted, 'blincho.exe');
      if (installed.length !== 1) throw new Error('Tauri NSIS installer must contain one native executable');
      await verifyTauriExecutable(installed[0], version, runtimePlatform, architecture);
      if (await hashFile(installed[0]) !== await hashFile(executable)) throw new Error('Tauri NSIS executable differs from the verified portable executable');
      await record(bundle, 'setup');
      await record(executable, 'portable');
    } else {
      if (installers) {
        for (const format of ['deb', 'rpm']) {
          const installer = await onlyArtifact(path.join(output, 'bundle', format), `.${format}`);
          await verifyLinuxInstaller(installer, format, architecture, version, executable, temporary, invoke);
          await record(installer, format);
        }
      }
      // linuxdeploy may adjust ELF RPATHs when preparing its AppDir. Verify that
      // actual output and compare the AppImage payload with it, rather than
      // incorrectly requiring it to match the pre-deployment Cargo ELF bytes.
      const deployedExecutable = path.join(bundleDirectory, 'Blincho.AppDir/usr/bin/blincho');
      await verifyTauriExecutable(deployedExecutable, version, runtimePlatform, architecture);
      await chmod(bundle, 0o755);
      invoke(bundle, ['--appimage-extract'], { cwd: temporary, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const appDirectory = path.join(temporary, 'squashfs-root');
      const bundledExecutable = path.join(appDirectory, 'usr/bin/blincho');
      await verifyTauriExecutable(bundledExecutable, version, runtimePlatform, architecture);
      const bundledHash = await hashFile(bundledExecutable);
      if (bundledHash !== await hashFile(deployedExecutable)) throw new Error('Tauri AppImage executable differs from the verified AppDir executable');
      const launcher = path.join(appDirectory, 'AppRun');
      const resolvedLauncher = await realpath(launcher);
      if (!resolvedLauncher.startsWith(`${await realpath(appDirectory)}${path.sep}`) || !((await stat(launcher)).mode & 0o111)) throw new Error('Missing or unsafe AppImage launcher');
      if (!(await lstat(path.join(appDirectory, 'usr/lib'))).isDirectory()) throw new Error('AppImage runtime libraries are missing');
      const archiveName = artifactName(version, platform, architecture, 'tar.gz');
      const archiveRoot = archiveName.slice(0, -'.tar.gz'.length);
      await rename(appDirectory, path.join(temporary, archiveRoot));
      const archive = path.join(upload, archiveName);
      invoke('tar', ['-czf', archive, '-C', temporary, archiveRoot]);
      // Inspect final archive bytes rather than trusting only the staging tree.
      const verifyDirectory = path.join(temporary, 'archive-verification');
      await mkdir(verifyDirectory);
      invoke('tar', ['-xzf', archive, '-C', verifyDirectory]);
      const archivedExecutable = path.join(verifyDirectory, archiveRoot, 'usr/bin/blincho');
      await verifyTauriExecutable(archivedExecutable, version, runtimePlatform, architecture);
      if (await hashFile(archivedExecutable) !== bundledHash) throw new Error('Tauri archive executable differs from the verified AppImage executable');
      await record(bundle, 'AppImage');
      await record(archive, 'tar.gz');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
