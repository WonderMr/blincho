const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, stat } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

async function runMacBundler({ arch = 'arm64', debug = false, target, args, missingInput, testChannel = false, badReceipt = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-tauri-bundle-'));
  try {
    await mkdir(path.join(directory, 'scripts'));
    await writeFile(path.join(directory, 'scripts/bundle-tauri-macos.cjs'), await readFile(path.join(__dirname, '../scripts/bundle-tauri-macos.cjs')));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.5.0' }));
    await mkdir(path.join(directory, 'assets'));
    if (missingInput !== 'icon') await writeFile(path.join(directory, 'assets/icon.icns'), 'synthetic icon');
    for (const profile of ['debug', 'release']) {
      for (const rustTarget of [null, 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
        const binary = path.join(directory, 'src-tauri/target', ...(rustTarget ? [rustTarget] : []), profile, 'blincho');
        await mkdir(path.dirname(binary), { recursive: true });
        if (missingInput !== 'binary') await writeFile(binary, `${rustTarget || 'host'}-${profile}`);
      }
      const bundle = path.join(directory, profile === 'debug' ? 'release/tauri-macos-debug' : 'release/tauri-macos', 'Blincho.app');
      await mkdir(path.join(bundle, 'Contents/Resources/nested'), { recursive: true });
      await writeFile(path.join(bundle, 'Contents/Resources/nested/stale.txt'), 'healthy previous bundle');
      await writeFile(path.join(path.dirname(bundle), 'keep.txt'), 'owned output sibling');
    }
    if (testChannel) {
      await mkdir(path.join(directory, 'src-tauri'), { recursive: true });
      await writeFile(path.join(directory, 'src-tauri/tauri.test.conf.json'), JSON.stringify({ productName: 'Blincho Test', identifier: 'com.myeyes.test' }));
      const output = path.join(directory, 'release/test-target', ...(target ? [target] : []), 'release');
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'blincho'), 'test channel executable');
      await writeFile(path.join(output, 'test-channel-receipt.json'), JSON.stringify({ productName: 'Blincho Test', identifier: 'com.myeyes.test', sha256: badReceipt ? 'invalid' : createHash('sha256').update('test channel executable').digest('hex') }));
    }
    await mkdir(path.join(directory, 'unowned'));
    await writeFile(path.join(directory, 'unowned/keep.txt'), 'unowned sentinel');
    const mock = path.join(directory, 'mock-native.cjs');
    await writeFile(mock, `
      const fs = require('node:fs');
      const originalChmod = fs.chmodSync;
      fs.chmodSync = (filename, mode) => {
        fs.appendFileSync('chmod.jsonl', JSON.stringify(mode) + '\\n');
        return originalChmod(filename, mode);
      };
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
      require('node:child_process').execFileSync = (command, args) => {
        if (command !== '/usr/bin/codesign') throw new Error('Unexpected native command');
        fs.appendFileSync('calls.jsonl', JSON.stringify([command, args]) + '\\n');
      };
    `);
    const options = args || [...(debug ? ['--debug'] : []), ...(testChannel ? ['--test'] : []), ...(target ? ['--target', target] : [])];
    const result = spawnSync(process.execPath, ['--require', mock, path.join(directory, 'scripts/bundle-tauri-macos.cjs'), ...options], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    if (result.error) throw result.error;
    const bundle = testChannel ? path.join(directory, 'release/test-channel/Blincho Test.app') : path.join(directory, debug ? 'release/tauri-macos-debug' : 'release/tauri-macos', 'Blincho.app');
    const readOptional = filename => readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const calls = (await readOptional(path.join(directory, 'calls.jsonl')) || '').trim().split('\n').filter(Boolean).map(JSON.parse);
    const chmodModes = (await readOptional(path.join(directory, 'chmod.jsonl')) || '').trim().split('\n').filter(Boolean).map(JSON.parse);
    const executable = path.join(bundle, 'Contents/MacOS/blincho');
    return {
      ...result, calls, chmodModes, copied: await readOptional(executable),
      executableMode: await stat(executable).then(value => value.mode & 0o777).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
      metadata: await readOptional(path.join(bundle, 'Contents/Resources/blincho-runtime.json')).then(value => value && JSON.parse(value)),
      plist: await readOptional(path.join(bundle, 'Contents/Info.plist')),
      stableBundle: await readOptional(path.join(directory, 'release/tauri-macos/Blincho.app/Contents/Resources/nested/stale.txt')),
      stale: await readOptional(path.join(bundle, 'Contents/Resources/nested/stale.txt')),
      sibling: await readOptional(path.join(path.dirname(bundle), 'keep.txt')),
      otherBundle: await readOptional(path.join(directory, debug ? 'release/tauri-macos' : 'release/tauri-macos-debug', 'Blincho.app/Contents/Resources/nested/stale.txt')),
      unowned: await readOptional(path.join(directory, 'unowned/keep.txt')),
    };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('test bundling preserves the stable app and uses its verified separate identity without document ownership', async () => {
  const result = await runMacBundler({ testChannel: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.copied, 'test channel executable');
  assert.equal(result.stableBundle, 'healthy previous bundle');
  assert.equal(result.metadata.identifier, 'com.myeyes.test');
  assert.equal(result.metadata.channel, 'test');
  assert.match(result.plist, /<key>CFBundleDisplayName<\/key><string>Blincho Test<\/string>/);
  assert.match(result.plist, /NSCameraUsageDescription/);
  assert.doesNotMatch(result.plist, /CFBundleDocumentTypes|UTExportedTypeDeclarations|com\.myeyes\.app/);
});

test('test bundling refuses an executable that does not match its channel receipt', async () => {
  const result = await runMacBundler({ testChannel: true, badReceipt: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Test channel binary receipt mismatch/);
  assert.equal(result.stableBundle, 'healthy previous bundle');
  assert.equal(result.copied, null);
});

test('local release and debug bundling removes stale app files while keeping sibling outputs and host Cargo paths', async t => {
  for (const debug of [false, true]) await t.test(debug ? 'debug' : 'release', async () => {
    const result = await runMacBundler({ debug });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.copied, `host-${debug ? 'debug' : 'release'}`);
    assert.deepEqual(result.chmodModes, [0o755]);
    if (process.platform !== 'win32') assert.equal(result.executableMode, 0o755);
    assert.equal(result.stale, null);
    assert.equal(result.sibling, 'owned output sibling');
    assert.equal(result.otherBundle, 'healthy previous bundle');
    assert.equal(result.unowned, 'unowned sentinel');
    assert.equal(result.metadata.arch, 'arm64');
    assert.deepEqual(result.calls.map(([, args]) => args.slice(0, -1)), [['--force', '--sign', '-'], ['--verify', '--strict']]);
  });
});

test('explicit native Rust targets bundle the matching Cargo output for each profile', async t => {
  for (const [arch, target] of [['arm64', 'aarch64-apple-darwin'], ['x64', 'x86_64-apple-darwin']]) {
    for (const debug of [false, true]) await t.test(`${arch}/${debug ? 'debug' : 'release'}`, async () => {
      const result = await runMacBundler({ arch, target, debug });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.copied, `${target}-${debug ? 'debug' : 'release'}`);
      assert.equal(result.metadata.arch, arch);
      assert.equal(result.stale, null);
    });
  }
});

test('invalid bundle targets or missing inputs preserve the previous app and unowned files', async t => {
  for (const [name, options, expected] of [
    ['different architecture', { target: 'x86_64-apple-darwin' }, /Invalid native macOS Rust target/],
    ['unsupported target', { target: 'aarch64-unknown-linux-gnu' }, /Invalid native macOS Rust target/],
    ['path traversal', { target: '../../unowned' }, /Invalid native macOS Rust target/],
    ['missing target value', { args: ['--target'] }, /Invalid native macOS Rust target/],
    ['unknown argument', { args: ['--output', '../../unowned'] }, /Invalid macOS bundle arguments/],
    ['missing release binary', { missingInput: 'binary' }, /ENOENT/],
    ['missing debug binary', { debug: true, missingInput: 'binary' }, /ENOENT/],
    ['missing icon', { missingInput: 'icon' }, /ENOENT/],
  ]) await t.test(name, async () => {
    const result = await runMacBundler(options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(result.calls, []);
    assert.equal(result.stale, 'healthy previous bundle');
    assert.equal(result.sibling, 'owned output sibling');
    assert.equal(result.otherBundle, 'healthy previous bundle');
    assert.equal(result.unowned, 'unowned sentinel');
  });
});

async function runMacPackager(arch, scenario = {}) {
  const version = scenario.version || '1.5.0';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-tauri-package-'));
  try {
    await mkdir(path.join(directory, 'src-tauri'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blincho', version, build: { appId: 'com.myeyes.app' } }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
    await writeFile(path.join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'com.myeyes.app', productName: 'Blincho', version, ...scenario.config }));
    const oldBundleFile = path.join(directory, 'release/tauri-macos/Blincho.app/Contents/Resources/old-bundle.txt');
    await mkdir(path.dirname(oldBundleFile), { recursive: true });
    await writeFile(oldBundleFile, 'healthy previous bundle');
    const mock = path.join(directory, 'mock-native.mjs');
    await writeFile(mock, `
      import fs from 'node:fs';
      import path from 'node:path';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const arch = ${JSON.stringify(arch)};
      const version = ${JSON.stringify(version)};
      const scenario = ${JSON.stringify(scenario)};
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      Object.defineProperty(process, 'arch', { value: arch });
      const bundle = path.resolve('release/tauri-macos/Blincho.app');
      const executable = path.join(bundle, 'Contents/MacOS/blincho');
      const originalLstat = fs.promises.lstat;
      // Model macOS mode bits only for this synthetic executable. Windows cannot store them.
      fs.promises.lstat = async (...args) => {
        const result = await originalLstat(...args);
        if (path.resolve(args[0]) === executable) result.mode = (result.mode & ~0o777) | (scenario.executableMode ?? 0o755);
        return result;
      };
      const metadata = { schemaVersion: 1, runtime: 'tauri', platform: 'darwin', arch, version, identifier: 'com.myeyes.app', packageType: 'manual', signed: false, notarized: false, updaterConfig: false, ...scenario.metadata };
      childProcess.spawnSync = (command, args) => {
        fs.appendFileSync('calls.jsonl', JSON.stringify([command, args]) + '\\n');
        if (command === 'cargo') return { status: scenario.cargoFailed ? 1 : 0 };
        if (command === process.execPath && args[0] === 'scripts/bundle-tauri-macos.cjs') {
          fs.rmSync(bundle, { recursive: true, force: true });
          for (const dir of ['MacOS', 'Resources']) fs.mkdirSync(path.join(bundle, 'Contents', dir), { recursive: true });
          fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), 'synthetic plist');
          fs.writeFileSync(path.join(bundle, 'Contents/MacOS/blincho'), 'synthetic native executable', { mode: 0o755 });
          if (!scenario.missingMetadata) fs.writeFileSync(path.join(bundle, 'Contents/Resources/blincho-runtime.json'), JSON.stringify(metadata));
          return { status: 0 };
        }
        if (command === '/usr/bin/plutil') return { status: 0, stdout: JSON.stringify({ CFBundleIdentifier: 'com.myeyes.app', CFBundleName: 'Blincho', CFBundleDisplayName: 'Blincho', CFBundleExecutable: 'blincho', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version, ...scenario.plist }) };
        if (command === '/usr/bin/lipo') return { status: 0, stdout: scenario.binaryArch || (arch === 'x64' ? 'x86_64' : 'arm64') };
        if (command === '/usr/bin/codesign') return { status: scenario.signatureFailed ? 1 : 0, stderr: scenario.signature || 'Signature=adhoc\\nTeamIdentifier=not set\\n' };
        if (command === '/usr/bin/ditto') {
          fs.writeFileSync(args.at(-1), 'synthetic zip bytes for ' + arch);
          return { status: 0 };
        }
        throw new Error('Unexpected native command: ' + command);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.resolve(__dirname, '../scripts/release-package.mjs'), 'macos', arch], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELEASE_TAG: `v${version}`, RUST_TARGET: scenario.rustTarget ?? '' },
    });
    if (result.error) throw result.error;
    const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const receiptPath = path.join(directory, `release-upload/Blincho-${version}-updates-darwin-${arch}.json`);
    const receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const bytes = await readFile(path.join(directory, `release-upload/Blincho-${version}-macos-${arch}.zip`)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const packages = receipt && await Promise.all(receipt.artifacts.map(async artifact => ({ artifact, bytes: await readFile(path.join(directory, 'release-upload', artifact.name)) })));
    const previousBundle = await readFile(oldBundleFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { ...result, calls, receipt, bytes, packages, previousBundle };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function runElectronPackager(platform, arch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-electron-package-'));
  try {
    await mkdir(path.join(directory, 'electron'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blincho', version: '1.5.0', build: { appId: 'com.myeyes.app', directories: { output: 'release' } } }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '1.5.0', packages: { '': { version: '1.5.0' } } }));
    const mock = path.join(directory, 'mock-electron.mjs');
    await writeFile(mock, `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import Module, { createRequire, syncBuiltinESMExports } from 'node:module';
      import childProcess from 'node:child_process';
      const require = createRequire(import.meta.url);
      const { createPackage } = require(${JSON.stringify(require.resolve('@electron/asar'))});
      const platform = ${JSON.stringify(platform)};
      const arch = ${JSON.stringify(arch)};
      Object.defineProperty(process, 'platform', { value: platform === 'windows' ? 'win32' : 'linux' });
      Object.defineProperty(process, 'arch', { value: arch });
      childProcess.spawnSync = () => { throw new Error('Electron packaging must not run Rust or native Tauri commands'); };
      syncBuiltinESMExports();
      const load = Module._load;
      Module._load = function(request, ...rest) {
        if (request !== 'electron-builder') return load.call(this, request, ...rest);
        const native = { createTarget: targets => targets[0] };
        return { Platform: { WINDOWS: native, LINUX: native }, Arch: { x64: 'x64', arm64: 'arm64' }, build: async options => {
          const target = options.targets;
          await fs.appendFile('calls.jsonl', JSON.stringify(target) + '\\n');
          const resources = path.resolve('release/mock-' + target + '/resources');
          await fs.mkdir(resources, { recursive: true });
          // The packager reads electron/update-support.json inside app.asar.
          // Preserve its expected path in a real archive, independent of builder.
          const source = path.resolve('release/mock-' + target + '/source');
          await fs.mkdir(path.join(source, 'electron'), { recursive: true });
          await fs.copyFile('electron/update-support.json', path.join(source, 'electron/update-support.json'));
          await createPackage(source, path.join(resources, 'app.asar'));
          await options.config.afterPack({ appOutDir: resources, packager: { getResourcesDir: () => resources } });
          const suffix = { nsis: '-setup.exe', portable: '-portable.exe', AppImage: '.AppImage', 'tar.gz': '.tar.gz' }[target];
          const publicArch = target === 'AppImage' && arch === 'x64' ? 'x86_64' : arch;
          await fs.writeFile(path.join('release', 'Blincho-1.5.0-' + platform + '-' + publicArch + suffix), 'synthetic Electron ' + target + ' package');
        } };
      };
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.resolve(__dirname, '../scripts/release-package.mjs'), platform, arch], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELEASE_TAG: 'v1.5.0' },
    });
    if (result.error) throw result.error;
    const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse);
    const receipt = await readFile(path.join(directory, `release-upload/Blincho-1.5.0-updates-${platform === 'windows' ? 'win32' : 'linux'}-${arch}.json`), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const support = await readFile(path.join(directory, 'electron/update-support.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { ...result, calls, receipt, support };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('macOS packaging builds locked current Cargo sources and publishes canonical manual Tauri receipts', async t => {
  const { validateReceipt } = await import('../scripts/release-lib.mjs');
  const { createHash } = require('node:crypto');
  for (const arch of ['x64', 'arm64']) await t.test(arch, async () => {
    const rustTarget = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    const result = await runMacPackager(arch, { rustTarget });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls[0], ['cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--locked', '--target', rustTarget]]);
    assert.deepEqual(result.calls[1], [process.execPath, ['scripts/bundle-tauri-macos.cjs', '--target', rustTarget]]);
    assert.equal(result.calls.at(-1)[0], '/usr/bin/ditto');
    assert.deepEqual(result.calls.at(-1)[1].slice(0, 4), ['-c', '-k', '--sequesterRsrc', '--keepParent']);
    assert.equal(result.calls.at(-1)[1].length, 6);
    assert.ok(result.calls.at(-1)[1][4].endsWith(path.sep + path.join('release', 'tauri-macos', 'Blincho.app')));
    assert.equal(result.receipt.runtime, 'tauri');
    validateReceipt(result.receipt, '1.5.0');
    const artifact = result.receipt.artifacts[0];
    assert.equal(artifact.name, `Blincho-1.5.0-macos-${arch}.zip`);
    assert.equal(artifact.packageType, 'manual');
    assert.equal(artifact.updaterConfig, false);
    assert.equal(artifact.bundleVerified, true);
    assert.equal(artifact.signed, false);
    assert.equal(artifact.notarized, false);
    assert.equal(artifact.size, result.bytes.length);
    assert.equal(artifact.sha256, createHash('sha256').update(result.bytes).digest('hex'));
    assert.equal(artifact.sha512, createHash('sha512').update(result.bytes).digest('base64'));
  });
});

test('1.6.1 macOS packaging writes descriptive archives and identical legacy aliases', async t => {
  const { artifactNames, validateReceipt } = await import('../scripts/release-lib.mjs');
  for (const arch of ['arm64', 'x64']) await t.test(arch, async () => {
    const result = await runMacPackager(arch, { version: '1.6.1' });
    assert.equal(result.status, 0, result.stderr);
    validateReceipt(result.receipt, '1.6.1');
    const [canonical, alias] = artifactNames('1.6.1', 'macos', arch, 'zip');
    assert.deepEqual(result.receipt.artifacts.map(item => item.name), [canonical, alias]);
    assert.ok(result.calls.at(-1)[1].at(-1).endsWith(canonical));
    assert.deepEqual(result.packages[0].bytes, result.packages[1].bytes);
    assert.equal(result.packages[0].artifact.sha256, result.packages[1].artifact.sha256);
    assert.equal(result.packages[0].artifact.sha512, result.packages[1].artifact.sha512);
  });
});

test('macOS packaging defaults to the native Rust target and rejects mismatched targets before building', async t => {
  const defaultTarget = await runMacPackager('arm64');
  assert.equal(defaultTarget.status, 0, defaultTarget.stderr);
  assert.deepEqual(defaultTarget.calls[0][1].slice(-2), ['--target', 'aarch64-apple-darwin']);
  for (const rustTarget of ['x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', '../../unowned']) await t.test(rustTarget, async () => {
    const result = await runMacPackager('arm64', { rustTarget });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid native macOS Rust target/);
    assert.deepEqual(result.calls, []);
    assert.equal(result.receipt, null);
    assert.equal(result.bytes, null);
    assert.equal(result.previousBundle, 'healthy previous bundle');
  });
  const failedCargo = await runMacPackager('arm64', { cargoFailed: true });
  assert.notEqual(failedCargo.status, 0);
  assert.equal(failedCargo.previousBundle, 'healthy previous bundle');
});

test('missing or tampered Tauri bundle metadata, identity, architecture and signing block ZIP receipts', async t => {
  const cases = [
    ['missing metadata', { missingMetadata: true }, /ENOENT/],
    ['runtime', { metadata: { runtime: 'electron' } }, /metadata does not match/],
    ['metadata version', { metadata: { version: '1.4.2' } }, /metadata does not match/],
    ['metadata updater', { metadata: { updaterConfig: true } }, /metadata does not match/],
    ['project identity', { config: { identifier: 'com.myeyes.tauri.prototype' } }, /project identity/],
    ['bundle identity', { plist: { CFBundleIdentifier: 'com.myeyes.tauri.prototype' } }, /bundle identity/],
    ['bundle version', { plist: { CFBundleVersion: '1' } }, /bundle identity/],
    ['executable name', { plist: { CFBundleExecutable: '../wrong' } }, /bundle identity/],
    ['non-executable file', { executableMode: 0o644 }, /is not executable/],
    ['wrong architecture', { binaryArch: 'x86_64' }, /architecture does not match/],
    ['invalid signature', { signatureFailed: true }, /verification failed/],
    ['Developer ID signature', { signature: 'Authority=Developer ID Application: Fixture\nTeamIdentifier=A123456789\n' }, /ad hoc signature/],
    ['Cargo failure', { cargoFailed: true }, /build failed: cargo/],
  ];
  for (const [name, scenario, expected] of cases) await t.test(name, async () => {
    const result = await runMacPackager('arm64', scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.equal(result.receipt, null);
    assert.equal(result.bytes, null);
    assert.ok(result.calls.every(([command]) => command !== '/usr/bin/ditto'));
  });
});

test('historical 1.5.0 Windows and Linux retain separate Electron packages without invoking Rust or Tauri', async t => {
  const { validateReceipt } = await import('../scripts/release-lib.mjs');
  for (const platform of ['windows', 'linux']) for (const arch of ['arm64', 'x64']) await t.test(`${platform}/${arch}`, async () => {
    const result = await runElectronPackager(platform, arch);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, platform === 'windows' ? ['nsis', 'portable'] : ['AppImage', 'tar.gz']);
    assert.equal(result.receipt.runtime, 'electron');
    validateReceipt(result.receipt, '1.5.0');
    assert.deepEqual(result.receipt.artifacts.map(item => item.packageType), platform === 'windows' ? ['nsis', 'manual'] : ['appimage', 'manual']);
    assert.ok(result.receipt.artifacts.every(item => item.updaterConfig && !item.signed && !item.notarized && item.name.includes(`-${arch}`)));
    assert.equal(result.support, null);
  });
});

test('CI and release use locked Rust builds on all six native targets with OS dependencies', async () => {
  const { load } = require('js-yaml');
  const jobs = load(await readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8')).jobs;
  assert.ok(jobs.validate.steps.every(step => !/cargo|rustup/.test(step.run || '')));
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'];
  const native = jobs['tauri-native'];
  assert.deepEqual(native.strategy.matrix.include.map(target => target['rust-target']), targets);
  assert.ok(native.steps.some(step => /rustup toolchain install 1\.92\.0/.test(step.run || '')));
  assert.ok(native.steps.some(step => /cmake==3\.31\.10/.test(step.run || '')));
  assert.ok(native.steps.some(step => step.if === "runner.os == 'Linux'" && /libwebkit2gtk-4.1-dev/.test(step.run)));
  for (const command of ['cargo fmt --manifest-path src-tauri/Cargo.toml --check', 'cargo check --manifest-path src-tauri/Cargo.toml --locked --target ${{ matrix.rust-target }}', 'cargo test --manifest-path src-tauri/Cargo.toml --locked --target ${{ matrix.rust-target }}']) assert.ok(native.steps.some(step => step.run === command));
  const release = load(await readFile(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  for (const step of release.jobs.package.steps.filter(step => /cargo|rustup|cmake==/.test(step.run || ''))) assert.ok(["steps.runtime.outputs.tauri == 'true'", "steps.runtime.outputs.tauri == 'true' && hashFiles('tests/tauri-cross-platform-smoke.cjs') != ''", "matrix.platform != 'windows' && steps.runtime.outputs.tauri == 'true'"].includes(step.if));
  assert.deepEqual(release.jobs.package.strategy.matrix.include.map(target => target['rust-target']), targets);
  assert.ok(release.jobs.package.steps.some(step => step.if?.includes("matrix.platform == 'linux'") && /libfuse2/.test(step.run || '')));
  assert.ok(release.jobs.package.steps.some(step => step.if?.includes("matrix.platform == 'windows'") && /Get-Command 7z/.test(step.run || '')));
  const packageStep = release.jobs.package.steps.find(step => step.name === 'Build native packages');
  assert.deepEqual(packageStep.env, { RUST_TARGET: '${{ matrix.rust-target }}' });
});
