const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

async function runPackager(platform, arch, scenario = {}) {
  const version = scenario.version || '1.6.0';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-native-package-test-'));
  try {
    await mkdir(path.join(directory, 'src-tauri'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blincho', version, build: { appId: 'com.myeyes.app' } }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
    await writeFile(path.join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify({ version, identifier: 'com.myeyes.app', productName: 'Blincho', bundle: { active: true, createUpdaterArtifacts: false }, ...scenario.config }));
    const mock = path.join(directory, 'mock-native.mjs');
    await writeFile(mock, `
      import fs from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import Module, { syncBuiltinESMExports } from 'node:module';
      import childProcess from 'node:child_process';
      const platform = ${JSON.stringify(platform)};
      const arch = ${JSON.stringify(arch)};
      const version = ${JSON.stringify(version)};
      const scenario = ${JSON.stringify(scenario)};
      // Node 22 computes tmpdir from process.platform. Keep the real host's
      // filesystem location when the fixture simulates another target OS.
      const hostTmpdir = os.tmpdir();
      os.tmpdir = () => hostTmpdir;
      Object.defineProperty(process, 'platform', { value: platform === 'windows' ? 'win32' : 'linux' });
      Object.defineProperty(process, 'arch', { value: arch });
      // Windows cannot represent Unix executable bits. Track the permissions
      // requested by these fixtures through rename and archive extraction.
      const fixtureModes = new Map();
      const writeExecutable = (file, bytes, mode = 0o755) => {
        fs.writeFileSync(file, bytes);
        fs.chmodSync(file, mode);
        if (platform === 'linux') fixtureModes.set(path.resolve(file), mode);
      };
      const withFixtureMode = original => async (file, ...args) => {
        const info = await original(file, ...args);
        const mode = fixtureModes.get(path.resolve(file));
        if (mode !== undefined) info.mode = (info.mode & ~0o777) | mode;
        return info;
      };
      fs.promises.lstat = withFixtureMode(fs.promises.lstat);
      fs.promises.stat = withFixtureMode(fs.promises.stat);
      const originalRename = fs.promises.rename;
      fs.promises.rename = async (source, destination) => {
        await originalRename(source, destination);
        const root = path.resolve(source);
        for (const [file, mode] of [...fixtureModes]) {
          if (file === root || file.startsWith(root + path.sep)) {
            fixtureModes.delete(file);
            fixtureModes.set(path.resolve(destination) + file.slice(root.length), mode);
          }
        }
      };
      const archivedModes = new Map();
      const originalRun = childProcess.spawnSync;
      const originalLoad = Module._load;
      Module._load = function(name, ...rest) {
        if (name === 'electron-builder') throw new Error('Current native packaging must not load Electron builder');
        return originalLoad.call(this, name, ...rest);
      };
      const executableBytes = metadata => {
        const bytes = Buffer.alloc(512);
        if (platform === 'windows') {
          bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\\0\\0', 64);
          bytes.writeUInt16LE(scenario.wrongArch ? 0x14c : arch === 'arm64' ? 0xaa64 : 0x8664, 68);
          bytes.writeUInt16LE(0x20b, 88);
          if (scenario.signed) bytes.writeUInt32LE(400, 88 + 112 + 32);
        } else {
          bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(scenario.wrongArch ? 3 : arch === 'arm64' ? 183 : 62, 18);
        }
        return Buffer.concat([bytes, Buffer.from(scenario.metadataMissing ? 'no runtime receipt' : metadata)]);
      };
      let executable;
      let bundle;
      let nativeBytes;
      let cargoBytes;
      childProcess.spawnSync = (command, args, options) => {
        fs.appendFileSync('calls.jsonl', JSON.stringify([command, args, options.env?.BLINCHO_RELEASE_METADATA || null]) + '\\n');
        if (command === process.execPath && args[0] === 'node_modules/@tauri-apps/cli/tauri.js') {
          if (scenario.buildFailed) return { status: 1 };
          const target = args[args.indexOf('--target') + 1];
          const output = path.resolve('src-tauri/target', target, 'release');
          executable = path.join(output, platform === 'windows' ? 'blincho.exe' : 'blincho');
          nativeBytes = executableBytes(options.env.BLINCHO_RELEASE_METADATA);
          cargoBytes = nativeBytes;
          fs.mkdirSync(output, { recursive: true });
          writeExecutable(executable, nativeBytes, scenario.executableNotExecutable ? 0o644 : 0o755);
          const bundleDir = path.join(output, 'bundle', platform === 'windows' ? 'nsis' : 'appimage');
          fs.mkdirSync(bundleDir, { recursive: true });
          if (platform === 'linux') {
            const deployed = path.join(bundleDir, 'Blincho.AppDir/usr/bin/blincho');
            fs.mkdirSync(path.dirname(deployed), { recursive: true });
            // Model linuxdeploy's legitimate ELF changes. AppImage contents
            // must match the deployed AppDir, while metadata still matches Cargo.
            nativeBytes = Buffer.concat([nativeBytes, Buffer.from('deployed RPATH')]);
            writeExecutable(deployed, nativeBytes, scenario.deployedNotExecutable ? 0o644 : 0o755);
          }
          bundle = path.join(bundleDir, 'Blincho_' + version + '_' + arch + (platform === 'windows' ? '-setup.exe' : '.AppImage'));
          fs.writeFileSync(bundle, platform === 'windows' ? executableBytes('synthetic NSIS installer') : 'synthetic AppImage');
          if (platform === 'linux' && args[args.indexOf('--bundles') + 1].includes('deb')) {
            for (const format of ['deb', 'rpm']) {
              const dir = path.join(output, 'bundle', format);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, 'Blincho.' + format), 'synthetic ' + format);
            }
          }
          return { status: 0 };
        }
        const extractInstaller = (format, root) => {
          fs.mkdirSync(path.join(root, 'usr/bin'), { recursive: true });
          fs.mkdirSync(path.join(root, 'usr/share/applications'), { recursive: true });
          fs.mkdirSync(path.join(root, 'usr/share/icons/hicolor/32x32/apps'), { recursive: true });
          const tampered = scenario.installerTampered === format;
          writeExecutable(path.join(root, 'usr/bin/blincho'), tampered ? Buffer.concat([cargoBytes, Buffer.from('tampered')]) : cargoBytes, scenario.installerNotExecutable === format ? 0o644 : 0o755);
          if (scenario.installerDesktopMissing !== format) fs.writeFileSync(path.join(root, 'usr/share/applications/blincho.desktop'), '[Desktop Entry]\\nExec=blincho');
          if (scenario.installerIconMissing !== format) fs.writeFileSync(path.join(root, 'usr/share/icons/hicolor/32x32/apps/blincho.png'), 'synthetic icon');
          if (scenario.installerBundledWebKit === format) {
            fs.mkdirSync(path.join(root, 'usr/lib'), { recursive: true });
            fs.writeFileSync(path.join(root, 'usr/lib/libwebkit2gtk-4.1.so.0'), 'unexpected runtime');
          }
          return { status: 0 };
        };
        const installerIdentity = format => ({ status: 0, stdout: 'blincho\\n' + (scenario.installerIdentity === format ? '0.0.0' : version) + '\\n' + (format === 'deb' ? arch === 'arm64' ? 'arm64' : 'amd64' : arch === 'arm64' ? 'aarch64' : 'x86_64') + '\\n' });
        if (command === 'dpkg-deb') {
          if (args[0] === '--show') return installerIdentity('deb');
          if (args[0] === '--field') return { status: 0, stdout: scenario.installerDependenciesMissing === 'deb' ? 'libgtk-3-0' : 'libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good' };
          if (args[0] === '--extract') return extractInstaller('deb', args[2]);
        }
        if (command === 'rpm') {
          if (args[1] === '--queryformat') return installerIdentity('rpm');
          if (args[1] === '--requires') return { status: 0, stdout: scenario.installerDependenciesMissing === 'rpm' ? 'libgtk-3.so.0()(64bit)' : 'libwebkit2gtk-4.1.so.0()(64bit)\\nlibgtk-3.so.0()(64bit)\\nlibayatana-appindicator3.so.1()(64bit)\\ngstreamer1-plugins-base\\ngstreamer1-plugins-good\\n' };
        }
        if (command === 'bsdtar') return extractInstaller('rpm', args[args.indexOf('-C') + 1]);
        if (command === '7z') {
          const extracted = args.find(arg => arg.startsWith('-o')).slice(2);
          fs.mkdirSync(path.join(extracted, 'native'), { recursive: true });
          fs.writeFileSync(path.join(extracted, 'native/blincho.exe'), scenario.packageTampered ? Buffer.concat([nativeBytes, Buffer.from('tampered')]) : nativeBytes);
          return { status: 0 };
        }
        if (command === bundle && args[0] === '--appimage-extract') {
          const root = path.join(options.cwd, 'squashfs-root');
          fs.mkdirSync(path.join(root, 'usr/bin'), { recursive: true }); fs.mkdirSync(path.join(root, 'usr/lib'), { recursive: true });
          writeExecutable(path.join(root, 'usr/bin/blincho'), scenario.packageTampered ? Buffer.concat([nativeBytes, Buffer.from('tampered')]) : nativeBytes, scenario.extractedNotExecutable ? 0o644 : 0o755);
          if (!scenario.launcherMissing) writeExecutable(path.join(root, 'AppRun'), '#!/bin/sh\\nexec "$APPDIR/usr/bin/blincho"', scenario.launcherNotExecutable ? 0o644 : 0o755);
          fs.writeFileSync(path.join(root, 'usr/lib/native-library.fixture'), 'synthetic runtime library');
          return { status: 0 };
        }
        if (command === 'tar') {
          const result = originalRun(command, args, options);
          if (result.status === 0) {
            const root = path.resolve(args[args.indexOf('-C') + 1]);
            if (args[0] === '-czf') {
              for (const [file, mode] of fixtureModes) {
                if (file.startsWith(root + path.sep)) archivedModes.set(path.relative(root, file), mode);
              }
            } else if (args[0] === '-xzf') {
              for (const [file, mode] of archivedModes) {
                fixtureModes.set(path.join(root, file), scenario.archivedNotExecutable && path.basename(file) === 'blincho' ? 0o644 : mode);
              }
            }
          }
          return result;
        }
        throw new Error('Unexpected packaging command: ' + command);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.resolve(__dirname, '../scripts/release-package.mjs'), platform, arch], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELEASE_TAG: `v${version}`, RUST_TARGET: scenario.rustTarget || '', CARGO_TARGET_DIR: '' },
    });
    if (result.error) throw result.error;
    const optional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const receipt = await optional(path.join(directory, `release-upload/Blincho-${version}-updates-${platform === 'windows' ? 'win32' : 'linux'}-${arch}.json`));
    const calls = await optional(path.join(directory, 'calls.jsonl'));
    const parsed = receipt && JSON.parse(receipt);
    const packages = parsed && await Promise.all(parsed.artifacts.map(async artifact => ({ artifact, bytes: await readFile(path.join(directory, 'release-upload', artifact.name)) })));
    return { ...result, receipt: parsed, calls: calls ? calls.toString().trim().split('\n').map(JSON.parse) : [], packages };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('current Windows and Linux use locked native Tauri bundles and verified manual receipts on both architectures', async t => {
  const { validateReceipt } = await import('../scripts/release-lib.mjs');
  const { RUST_TARGETS } = await import('../scripts/bundle-tauri-desktop.mjs');
  for (const platform of ['windows', 'linux']) for (const arch of ['arm64', 'x64']) await t.test(`${platform}/${arch}`, async () => {
    const result = await runPackager(platform, arch);
    assert.equal(result.status, 0, result.stderr);
    const [command, args, metadata] = result.calls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--target', RUST_TARGETS[platform][arch], '--bundles', platform === 'windows' ? 'nsis' : 'appimage', '--ci', '--no-sign', '--no-binary-patching', '--', '--locked']);
    assert.equal(JSON.parse(metadata).arch, arch);
    assert.equal(JSON.parse(metadata).runtime, 'tauri');
    assert.equal(result.receipt.runtime, 'tauri');
    validateReceipt(result.receipt, '1.6.0');
    assert.equal(result.receipt.artifacts.length, 2);
    for (const { artifact, bytes } of result.packages) {
      assert.equal(artifact.packageType, 'manual');
      assert.equal(artifact.bundleVerified, true);
      assert.equal(artifact.updaterConfig, false);
      assert.equal(artifact.signed, false);
      assert.equal(artifact.notarized, false);
      assert.equal(artifact.size, bytes.length);
      assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(artifact.sha512, createHash('sha512').update(bytes).digest('base64'));
    }
    if (platform === 'windows') assert.equal(result.calls[1][0], '7z');
    else assert.ok(result.calls.some(([, args]) => args[0] === '--appimage-extract'));
  });
});

test('1.6.1 native desktop packaging writes descriptive files and identical compatibility aliases', async t => {
  const { artifactName, artifactNames, validateReceipt } = await import('../scripts/release-lib.mjs');
  for (const platform of ['windows', 'linux']) for (const arch of ['arm64', 'x64']) await t.test(`${platform}/${arch}`, async () => {
    const result = await runPackager(platform, arch, { version: '1.6.1' });
    assert.equal(result.status, 0, result.stderr);
    validateReceipt(result.receipt, '1.6.1');
    assert.equal(result.receipt.artifacts.length, platform === 'windows' ? 3 : 5);
    assert.equal(result.calls[0][1][result.calls[0][1].indexOf('--bundles') + 1], platform === 'windows' ? 'nsis' : 'appimage,deb,rpm');
    for (const target of platform === 'windows' ? ['setup', 'portable'] : ['AppImage', 'tar.gz', 'deb', 'rpm']) {
      const names = artifactNames('1.6.1', platform, arch, target);
      const packages = names.map(name => result.packages.find(item => item.artifact.name === name));
      assert.ok(packages.every(Boolean));
      for (const item of packages) assert.deepEqual(item.bytes, packages[0].bytes);
      assert.equal(packages[0].artifact.name, artifactName('1.6.1', platform, arch, target));
      assert.ok(packages[0].artifact.name.startsWith('Blincho-Screen-Breaks-'));
    }
    if (platform === 'linux') {
      const tarCall = result.calls.find(([command, args]) => command === 'tar' && args[0] === '-czf');
      assert.equal(tarCall[1].at(-1), `Blincho-Screen-Breaks-1.6.1-Linux-${arch === 'arm64' ? 'ARM64' : 'x64'}-Portable`);
    }
  });
});

test('Linux installers reject wrong identity, missing dependencies, altered payloads and incomplete installed layouts', async t => {
  for (const format of ['deb', 'rpm']) for (const [name, property, expected] of [
    ['identity', 'installerIdentity', /package identity or architecture/],
    ['dependencies', 'installerDependenciesMissing', /system runtime dependencies/],
    ['payload', 'installerTampered', /differs from the verified Cargo executable/],
    ['permissions', 'installerNotExecutable', /not executable/],
    ['desktop', 'installerDesktopMissing', /desktop entry/],
    ['icon', 'installerIconMissing', /application icon/],
    ['bundled WebKit', 'installerBundledWebKit', /Unexpected bundled WebKitGTK/],
  ]) await t.test(`${format}/${name}`, async () => {
    const result = await runPackager('linux', 'arm64', { version: '1.6.1', [property]: format });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(result.receipt, null);
  });
});

test('wrong target, failed build, altered metadata, wrong architecture and mismatched payloads cannot emit receipts', async t => {
  for (const platform of ['windows', 'linux']) {
    for (const [name, scenario, expected] of [
      ['target', { rustTarget: '../../outside' }, /Invalid native Rust target/],
      ['identity', { config: { identifier: 'com.invalid.app' } }, /project identity/],
      ['build', { buildFailed: true }, /packaging failed/],
      ['metadata', { metadataMissing: true }, /metadata does not match/],
      ['architecture', { wrongArch: true }, /architecture does not match/],
      ['payload', { packageTampered: true }, /differs from the verified/],
      ...(platform === 'windows' ? [['signature', { signed: true }, /must be unsigned/]] : [
        ['launcher', { launcherMissing: true }, /ENOENT/],
        ['executable permissions', { executableNotExecutable: true }, /Tauri executable is not executable/],
        ['deployed permissions', { deployedNotExecutable: true }, /Tauri executable is not executable/],
        ['extracted permissions', { extractedNotExecutable: true }, /Tauri executable is not executable/],
        ['launcher permissions', { launcherNotExecutable: true }, /Missing or unsafe AppImage launcher/],
        ['archived permissions', { archivedNotExecutable: true }, /Tauri executable is not executable/],
      ]),
    ]) await t.test(`${platform}/${name}`, async () => {
      const result = await runPackager(platform, 'arm64', scenario);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(result.receipt, null);
      if (name === 'target' || name === 'identity') assert.deepEqual(result.calls, []);
    });
  }
});

test('release preflight rejects mismatched Cargo/config versions, updater configuration and unlocked CLI', async t => {
  for (const [name, mutate, expected] of [
    ['valid', () => {}, null],
    ['Cargo version', data => { data.cargo = '[package]\nname = "blincho"\nversion = "1.5.3"\n'; }, /identity and versions/],
    ['config version', data => { data.config.version = '1.5.3'; }, /identity and versions/],
    ['config identity', data => { data.config.identifier = 'com.other.app'; }, /identity and versions/],
    ['disabled bundling', data => { data.config.bundle.active = false; }, /native bundles/],
    ['updater artifacts', data => { data.config.bundle.createUpdaterArtifacts = true; }, /manual updates/],
    ['updater plugin', data => { data.config.plugins = { updater: { endpoints: ['https://example.invalid'] } }; }, /manual updates/],
    ['floating CLI', data => { data.package.devDependencies['@tauri-apps/cli'] = '^2.12.2'; }, /CLI must be locked/],
    ['different locked CLI', data => { data.lock.packages['node_modules/@tauri-apps/cli'].version = '2.12.1'; }, /CLI must be locked/],
  ]) await t.test(name, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-release-preflight-'));
    try {
      const data = {
        package: { name: 'blincho', version: '1.6.0', devDependencies: { '@tauri-apps/cli': '2.12.2' } },
        lock: { version: '1.6.0', packages: { '': { version: '1.6.0' }, 'node_modules/@tauri-apps/cli': { version: '2.12.2' } } },
        config: { version: '1.6.0', identifier: 'com.myeyes.app', productName: 'Blincho', bundle: { active: true, createUpdaterArtifacts: false } },
        cargo: '[package]\nname = "blincho"\nversion = "1.6.0"\n\n[dependencies]\n',
      };
      mutate(data);
      await mkdir(path.join(directory, 'src-tauri'));
      await writeFile(path.join(directory, 'package.json'), JSON.stringify(data.package));
      await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(data.lock));
      await writeFile(path.join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify(data.config));
      await writeFile(path.join(directory, 'src-tauri/Cargo.toml'), data.cargo);
      await writeFile(path.join(directory, 'CHANGELOG.md'), '## [1.6.0]\n\n- Native Rust desktop packages on all supported systems.\n');
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/release-check.mjs')], { cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELEASE_TAG: 'v1.6.0' } });
      if (result.error) throw result.error;
      if (expected) { assert.notEqual(result.status, 0); assert.match(result.stderr, expected); }
      else assert.equal(result.status, 0, result.stderr);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
