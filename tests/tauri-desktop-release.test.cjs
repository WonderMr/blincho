const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

async function runPackager(platform, arch, scenario = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-native-package-test-'));
  try {
    await mkdir(path.join(directory, 'src-tauri'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blincho', version: '1.6.0', build: { appId: 'com.myeyes.app' } }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '1.6.0', packages: { '': { version: '1.6.0' } } }));
    await writeFile(path.join(directory, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.6.0', identifier: 'com.myeyes.app', productName: 'Blincho', bundle: { active: true, createUpdaterArtifacts: false }, ...scenario.config }));
    const mock = path.join(directory, 'mock-native.mjs');
    await writeFile(mock, `
      import fs from 'node:fs';
      import path from 'node:path';
      import Module, { syncBuiltinESMExports } from 'node:module';
      import childProcess from 'node:child_process';
      const platform = ${JSON.stringify(platform)};
      const arch = ${JSON.stringify(arch)};
      const scenario = ${JSON.stringify(scenario)};
      Object.defineProperty(process, 'platform', { value: platform === 'windows' ? 'win32' : 'linux' });
      Object.defineProperty(process, 'arch', { value: arch });
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
      childProcess.spawnSync = (command, args, options) => {
        fs.appendFileSync('calls.jsonl', JSON.stringify([command, args, options.env?.BLINCHO_RELEASE_METADATA || null]) + '\\n');
        if (command === process.execPath && args[0] === 'node_modules/@tauri-apps/cli/tauri.js') {
          if (scenario.buildFailed) return { status: 1 };
          const target = args[args.indexOf('--target') + 1];
          const output = path.resolve('src-tauri/target', target, 'release');
          executable = path.join(output, platform === 'windows' ? 'blincho.exe' : 'blincho');
          nativeBytes = executableBytes(options.env.BLINCHO_RELEASE_METADATA);
          fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(executable, nativeBytes); fs.chmodSync(executable, 0o755);
          const bundleDir = path.join(output, 'bundle', platform === 'windows' ? 'nsis' : 'appimage');
          fs.mkdirSync(bundleDir, { recursive: true });
          if (platform === 'linux') {
            const deployed = path.join(bundleDir, 'Blincho.AppDir/usr/bin/blincho');
            fs.mkdirSync(path.dirname(deployed), { recursive: true });
            // Model linuxdeploy's legitimate ELF changes. AppImage contents
            // must match the deployed AppDir, while metadata still matches Cargo.
            nativeBytes = Buffer.concat([nativeBytes, Buffer.from('deployed RPATH')]);
            fs.writeFileSync(deployed, nativeBytes); fs.chmodSync(deployed, 0o755);
          }
          bundle = path.join(bundleDir, platform === 'windows' ? 'Blincho_1.6.0_' + arch + '-setup.exe' : 'Blincho_1.6.0_' + arch + '.AppImage');
          fs.writeFileSync(bundle, platform === 'windows' ? executableBytes('synthetic NSIS installer') : 'synthetic AppImage');
          return { status: 0 };
        }
        if (command === '7z') {
          const extracted = args.find(arg => arg.startsWith('-o')).slice(2);
          fs.mkdirSync(path.join(extracted, 'native'), { recursive: true });
          fs.writeFileSync(path.join(extracted, 'native/blincho.exe'), scenario.packageTampered ? Buffer.concat([nativeBytes, Buffer.from('tampered')]) : nativeBytes);
          return { status: 0 };
        }
        if (command === bundle && args[0] === '--appimage-extract') {
          const root = path.join(options.cwd, 'squashfs-root');
          fs.mkdirSync(path.join(root, 'usr/bin'), { recursive: true }); fs.mkdirSync(path.join(root, 'usr/lib'), { recursive: true });
          fs.writeFileSync(path.join(root, 'usr/bin/blincho'), scenario.packageTampered ? Buffer.concat([nativeBytes, Buffer.from('tampered')]) : nativeBytes); fs.chmodSync(path.join(root, 'usr/bin/blincho'), 0o755);
          if (!scenario.launcherMissing) { fs.writeFileSync(path.join(root, 'AppRun'), '#!/bin/sh\\nexec "$APPDIR/usr/bin/blincho"'); fs.chmodSync(path.join(root, 'AppRun'), 0o755); }
          fs.writeFileSync(path.join(root, 'usr/lib/native-library.fixture'), 'synthetic runtime library');
          return { status: 0 };
        }
        if (command === 'tar') return originalRun(command, args, options);
        throw new Error('Unexpected packaging command: ' + command);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.resolve(__dirname, '../scripts/release-package.mjs'), platform, arch], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELEASE_TAG: 'v1.6.0', RUST_TARGET: scenario.rustTarget || '', CARGO_TARGET_DIR: '' },
    });
    if (result.error) throw result.error;
    const optional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const receipt = await optional(path.join(directory, `release-upload/Blincho-1.6.0-updates-${platform === 'windows' ? 'win32' : 'linux'}-${arch}.json`));
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

test('wrong target, failed build, altered metadata, wrong architecture and mismatched payloads cannot emit receipts', async t => {
  for (const platform of ['windows', 'linux']) {
    for (const [name, scenario, expected] of [
      ['target', { rustTarget: '../../outside' }, /Invalid native Rust target/],
      ['identity', { config: { identifier: 'com.invalid.app' } }, /project identity/],
      ['build', { buildFailed: true }, /packaging failed/],
      ['metadata', { metadataMissing: true }, /metadata does not match/],
      ['architecture', { wrongArch: true }, /architecture does not match/],
      ['payload', { packageTampered: true }, /differs from the verified/],
      ...(platform === 'windows' ? [['signature', { signed: true }, /must be unsigned/]] : [['launcher', { launcherMissing: true }, /ENOENT/]]),
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
