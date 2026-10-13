const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const library = import('../scripts/release-lib.mjs');
const feeds = import('../scripts/update-feed.mjs');
const packaging = import('../scripts/update-package.mjs');
const github = import('../scripts/release-github.mjs');
const version = '1.4.0';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

async function fixture(releaseVersion = version, signed = false, { legacy = false } = {}) {
  const lib = await library;
  const { packageSupport } = await packaging;
  const names = lib.expectedArtifacts(releaseVersion, { legacy });
  const files = new Map(names.map(name => {
    const item = lib.describeArtifact(name, releaseVersion);
    const target = item.platform === 'windows' ? item.kind === 'installer' ? 'setup' : 'portable' : item.format;
    return [name, Buffer.from(`package fixture ${lib.artifactName(releaseVersion, item.platform, item.architecture, target)}`)];
  }));
  const receipts = lib.UPDATE_PLATFORMS.flatMap(platform => ['arm64', 'x64'].map(arch => ({
    schemaVersion: 1, version: releaseVersion, platform, arch,
    ...(lib.usesTauriMac(releaseVersion) ? { runtime: lib.usesTauriPlatform(releaseVersion, platform) ? 'tauri' : 'electron' } : {}),
    artifacts: names.filter(name => {
      const item = lib.describeArtifact(name, releaseVersion);
      return item.platform === lib.SITE_PLATFORMS[platform] && item.architecture === arch;
    }).map(name => {
      const item = lib.describeArtifact(name, releaseVersion);
      const target = item.format === 'zip' ? 'zip' : item.format === 'exe' ? item.kind === 'installer' ? 'nsis' : 'portable' : item.format;
      if (lib.usesTauriPlatform(releaseVersion, platform)) return { name, size: files.get(name).length, sha256: hash(files.get(name)), sha512: hash(files.get(name), 'sha512', 'base64'), packageType: 'manual', signed: false, notarized: false, updaterConfig: false, bundleVerified: true };
      const support = packageSupport(platform, arch, target, platform === 'darwin' && signed);
      return { name, size: files.get(name).length, sha256: hash(files.get(name)), sha512: hash(files.get(name), 'sha512', 'base64'), packageType: support.packageType, signed: support.signed, notarized: support.signed, updaterConfig: true };
    }),
  })));
  for (const receipt of receipts) files.set(lib.receiptName(releaseVersion, receipt.platform, receipt.arch), Buffer.from(JSON.stringify(receipt)));
  const checksums = new Map([...files].map(([name, bytes]) => [name, hash(bytes)]));
  files.set('SHA256SUMS.txt', Buffer.from([...checksums].map(([name, digest]) => `${digest}  ${name}\n`).join('')));
  const tag = `v${releaseVersion}`;
  const release = { tag_name: tag, name: `Blincho ${releaseVersion} (beta)`, body: `${lib.releaseSigningNotice(receipts)}\n\n- Example curated release changes.\n`, draft: false, prerelease: true, html_url: `https://github.com/WonderMr/blincho/releases/tag/${tag}`, published_at: '2026-10-12T12:00:00Z', assets: [...files].map(([name, bytes]) => ({ name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded', browser_download_url: `https://github.com/WonderMr/blincho/releases/download/${tag}/${name}` })) };
  const options = { requiredTag: tag, checksumsByTag: new Map([[tag, checksums]]), receiptsByTag: new Map([[tag, receipts]]) };
  return { files, receipts, checksums, release, options, manifest: lib.createManifest([release], options) };
}

async function runPublisher({ releaseVersion = '1.4.1', mutateDraft = () => {}, mutatePublished = () => {} } = {}) {
  const tag = `v${releaseVersion}`;
  const f = await fixture(releaseVersion);
  const draftTag = 'untagged-752e02b9c4ead7c770a3';
  const draft = { ...structuredClone(f.release), draft: true, published_at: null,
    html_url: f.release.html_url.replace(tag, draftTag),
    assets: f.release.assets.map(asset => ({ ...asset, browser_download_url: asset.browser_download_url.replace(`${tag}/`, `${draftTag}/`) })),
  };
  mutateDraft(draft);
  mutatePublished(f.release);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-publisher-'));
  try {
    await mkdir(path.join(directory, 'release-upload'));
    for (const [name, bytes] of f.files) await writeFile(path.join(directory, 'release-upload', name), bytes);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'blincho', version: releaseVersion }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: releaseVersion, packages: { '': { version: releaseVersion } } }));
    await writeFile(path.join(directory, 'CHANGELOG.md'), `## [${releaseVersion}]\n\n- Example curated release changes.\n`);
    await writeFile(path.join(directory, 'releases.json'), JSON.stringify({ draft, published: f.release }));
    // Stub the publisher's two external boundaries before importing it. No gh
    // process or network request can escape this isolated child process.
    await writeFile(path.join(directory, 'mock-github.mjs'), `
      import { readFileSync, appendFileSync } from 'node:fs';
      import childProcess from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      const releases = JSON.parse(readFileSync('releases.json', 'utf8'));
      const tag = ${JSON.stringify(tag)};
      let published = false;
      let commandPending = false;
      childProcess.spawn = (command, args) => {
        if (command !== 'gh' || args[0] !== 'release' || !['upload', 'edit'].includes(args[1]) || args[2] !== tag || args.at(-2) !== '--repo' || args.at(-1) !== 'WonderMr/blincho') throw new Error('Unexpected CLI operation');
        appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
        if (args[1] === 'edit') {
          if (!args.includes('--draft=false')) throw new Error('Expected publication command');
        }
        commandPending = true;
        const child = new EventEmitter();
        setImmediate(() => {
          if (args[1] === 'edit') published = true;
          commandPending = false;
          child.emit('close', 0);
        });
        return child;
      };
      syncBuiltinESMExports();
      globalThis.fetch = async url => {
        if (commandPending) throw new Error('GitHub read before CLI operation completed');
        if (url !== 'https://api.github.com/repos/WonderMr/blincho/releases?per_page=100&page=1') throw new Error('Unexpected network request');
        return new Response(JSON.stringify([published ? releases.published : releases.draft]));
      };
    `);
    const result = spawnSync(process.execPath, ['--import', require('node:url').pathToFileURL(path.join(directory, 'mock-github.mjs')).href, path.resolve(__dirname, '../scripts/release-publish.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: 'WonderMr/blincho', GH_TOKEN: 'fixture-token' },
    });
    if (result.error) throw result.error;
    const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('publisher projects temporary GitHub draft release and asset URLs before publishing verified packages', async () => {
  const result = await runPublisher();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(args => args[1]), ['upload', 'edit']);
  assert.match(result.stdout, /Published v1\.4\.1 with all packages and verified SHA-256 digests/);
});

test('1.6.1 publisher verifies all descriptive packages, legacy aliases and receipts before publication', async () => {
  const lib = await library;
  const result = await runPublisher({ releaseVersion: '1.6.1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(args => args[1]), ['upload', 'edit']);
  const uploaded = result.calls[0].slice(3, -3).map(name => path.basename(name)).sort();
  assert.deepEqual(uploaded, [...lib.expectedReleaseFiles('1.6.1'), 'SHA256SUMS.txt'].sort());
  assert.equal(uploaded.length, 27);
  const tampered = await runPublisher({ releaseVersion: '1.6.1', mutateDraft: release => {
    release.assets.find(item => item.name === 'Blincho-1.6.1-linux-x64.AppImage').digest = `sha256:${'a'.repeat(64)}`;
  } });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Uploaded bytes do not match/);
  assert.deepEqual(tampered.calls.map(args => args[1]), ['upload']);
});

test('publisher refuses unverified draft bytes and unrelated draft URLs before publication', async t => {
  const mutations = [
    ['package digest', release => { release.assets[0].digest = `sha256:${'a'.repeat(64)}`; }, /Uploaded bytes/],
    ['receipt digest', release => { release.assets.find(asset => asset.name.includes('-updates-')).digest = `sha256:${'a'.repeat(64)}`; }, /Uploaded bytes/],
    ['release repository', release => { release.html_url = release.html_url.replace('WonderMr', 'attacker'); }, /Release URL/],
    ['release tag', release => { release.html_url = release.html_url.replace(/untagged-[a-f0-9]+$/, 'v1.4.0'); }, /Release URL/],
    ['asset repository', release => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace('WonderMr', 'attacker'); }, /Asset download URL/],
    ['asset tag', release => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace(/untagged-[a-f0-9]+/, 'v1.4.0'); }, /Asset download URL/],
  ];
  for (const [name, mutateDraft, expected] of mutations) await t.test(name, async () => {
    const result = await runPublisher({ mutateDraft });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(result.calls.map(args => args[1]), ['upload']);
  });
});

test('publisher strictly validates real published URLs without draft projection', async t => {
  const mutations = [
    ['release URL', release => { release.html_url = release.html_url.replace('v1.4.1', 'untagged-752e02b9c4ead7c770a3'); }, /Release URL/],
    ['asset URL', release => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace('v1.4.1/', 'untagged-752e02b9c4ead7c770a3/'); }, /Asset download URL/],
    ['asset digest', release => { release.assets[0].digest = `sha256:${'a'.repeat(64)}`; }, /Uploaded bytes/],
  ];
  for (const [name, mutatePublished, expected] of mutations) await t.test(name, async () => {
    const result = await runPublisher({ mutatePublished });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(result.calls.map(args => args[1]), ['upload', 'edit']);
  });
});

test('mac signing is optional only when no inputs exist and fails closed for every incomplete set', async () => {
  const { macSigningMode, SIGNING_INPUTS, verifyMacSignature } = await packaging;
  assert.equal(macSigningMode({}), false);
  const complete = Object.fromEntries(SIGNING_INPUTS.map(key => [key, 'fixture']));
  complete.APPLE_TEAM_ID = 'A123456789';
  assert.equal(macSigningMode(complete), true);
  for (const key of SIGNING_INPUTS) {
    assert.throws(() => macSigningMode({ ...complete, [key]: '' }), /Incomplete/);
    assert.throws(() => macSigningMode({ [key]: 'fixture' }), /Incomplete/);
  }
  assert.throws(() => macSigningMode({ ...complete, BLINCHO_MAC_SIGNING_IDENTITY: '-' }), /ad-hoc/);
  assert.throws(() => macSigningMode({ ...complete, APPLE_TEAM_ID: 'invalid' }), /team ID/);
  const calls = [];
  const run = (command, args) => { calls.push([command, args]); return { status: 0, stdout: 'Authority=Developer ID Application: Fixture\nTeamIdentifier=A123456789\nflags=0x10000(runtime)\n' }; };
  verifyMacSignature('/test/Blincho.app', complete.APPLE_TEAM_ID, run);
  assert.equal(calls.length, 4);
  for (let failure = 0; failure < 4; failure++) {
    let index = 0;
    assert.throws(() => verifyMacSignature('/test/Blincho.app', complete.APPLE_TEAM_ID, (command, args) => index++ === failure ? { status: 1 } : run(command, args)), /verification failed/);
  }
  assert.throws(() => verifyMacSignature('/test/Blincho.app', complete.APPLE_TEAM_ID, () => ({ status: 0, stdout: 'Signature=adhoc\n' })), /Developer ID/);
});

test('package support distinguishes signed mac, NSIS, AppImage and manual archives', async () => {
  const { packageSupport, builderArtifactName } = await packaging;
  for (const arch of ['x64', 'arm64']) {
    assert.equal(packageSupport('darwin', arch, 'zip', false).packageType, 'manual');
    assert.equal(packageSupport('darwin', arch, 'zip', true).packageType, 'mac-signed');
    assert.equal(packageSupport('win32', arch, 'nsis').packageType, 'nsis');
    assert.equal(packageSupport('win32', arch, 'portable').packageType, 'manual');
    assert.equal(packageSupport('linux', arch, 'AppImage').packageType, 'appimage');
    assert.equal(packageSupport('linux', arch, 'tar.gz').packageType, 'manual');
  }
  assert.equal(builderArtifactName('Blincho-1.4.0-linux-x64.AppImage', 'linux', 'x64'), 'Blincho-1.4.0-linux-x86_64.AppImage');
  assert.equal(builderArtifactName('Blincho-1.4.0-linux-x64.tar.gz', 'linux', 'x64'), 'Blincho-1.4.0-linux-x64.tar.gz');
  assert.throws(() => packageSupport('win32', 'x64', 'nsis', true));
});

test('local gate checks both digest algorithms against bytes and requires all six metadata receipts', async () => {
  const lib = await library;
  const { files, receipts } = await fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-update-gate-'));
  try {
    for (const [name, bytes] of files) await writeFile(path.join(directory, name), bytes);
    assert.equal((await lib.inspectArtifacts(directory, version)).length, 16);
    const receipt = receipts[0];
    const name = lib.receiptName(version, receipt.platform, receipt.arch);
    const restore = () => writeFile(path.join(directory, name), files.get(name));
    const mutations = [item => { item.version = '1.4.1'; }, item => { item.arch = 'x64'; }, item => { item.artifacts[0].sha512 = Buffer.alloc(64).toString('base64'); }, item => { item.artifacts[0].sha256 = 'a'.repeat(64); }, item => { item.artifacts[0].packageType = 'mac-signed'; }, item => { item.artifacts[0].signed = true; }, item => { item.artifacts[0].updaterConfig = false; }, item => { item.artifacts.push(item.artifacts[0]); }];
    for (const mutate of mutations) {
      const changed = structuredClone(receipt); mutate(changed);
      await writeFile(path.join(directory, name), JSON.stringify(changed));
      await assert.rejects(lib.inspectArtifacts(directory, version));
    }
    await restore();
    const packageName = receipt.artifacts[0].name;
    await writeFile(path.join(directory, packageName), 'tampered');
    await assert.rejects(lib.inspectArtifacts(directory, version), /differs from package bytes/);
    await writeFile(path.join(directory, packageName), files.get(packageName));
    await rm(path.join(directory, name));
    await assert.rejects(lib.inspectArtifacts(directory, version), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('published receipts require canonical URLs, hashes and exact architecture coverage before creating feeds', async () => {
  const { loadUpdateReceipts } = await github;
  const lib = await library;
  const f = await fixture();
  const fetchImpl = async (url, settings) => {
    assert.equal(settings.headers, undefined);
    return new Response(f.files.get(url.split('/').at(-1)));
  };
  const receiptsByTag = await loadUpdateReceipts([f.release], f.options.checksumsByTag, { fetchImpl });
  assert.equal(receiptsByTag.get('v1.4.0').length, 6);
  assert.equal(lib.createManifest([f.release], { ...f.options, receiptsByTag }).releases[0].assets.length, 10);
  await assert.rejects(loadUpdateReceipts([f.release], f.options.checksumsByTag, { fetchImpl: async () => new Response('tampered') }), /bytes differ/);
  const bad = structuredClone(f.release);
  bad.assets.find(item => item.name.includes('-updates-')).browser_download_url = 'https://evil.example/receipt.json';
  await assert.rejects(loadUpdateReceipts([bad], f.options.checksumsByTag, { fetchImpl: () => { throw new Error('should not fetch'); } }), /Invalid or unverified/);
  assert.throws(() => lib.createManifest([f.release], { ...f.options, receiptsByTag: new Map() }), /verified update receipts/);
  const tampered = structuredClone(f.release); tampered.assets[0].digest = `sha256:${'a'.repeat(64)}`;
  assert.throws(() => lib.createManifest([tampered], f.options), /digest/);
});

test('installed electron-updater 6.8.9 parses every native feed at its exact channel filename', async () => {
  const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
  const { createUpdateFeeds } = await feeds;
  const f = await fixture(version, true);
  const generated = createUpdateFeeds(f.manifest);
  assert.equal(generated.length, 6);
  const saved = process.env.TEST_UPDATER_ARCH;
  try {
    for (const feed of generated) {
      const [, platform, arch, filename] = feed.path.split('/');
      process.env.TEST_UPDATER_ARCH = arch;
      const base = `https://blincho.app/updates/${platform}/${arch}/`;
      const provider = new GenericProvider({ provider: 'generic', url: base }, {}, { platform, executor: {} });
      provider.httpRequest = async url => { assert.equal(url.href, base + filename); return JSON.stringify(feed.info); };
      const info = await provider.getLatestVersion();
      const resolved = provider.resolveFiles(info);
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].url.href, feed.info.files[0].url);
      assert.ok(resolved[0].url.href.includes(`-${arch}`));
      assert.equal(resolved[0].info.sha512, hash(f.files.get(resolved[0].url.pathname.split('/').at(-1)), 'sha512', 'base64'));
      assert.ok(!resolved[0].url.href.endsWith('-portable.exe') && !resolved[0].url.href.endsWith('.tar.gz'));
    }
  } finally { if (saved === undefined) delete process.env.TEST_UPDATER_ARCH; else process.env.TEST_UPDATER_ARCH = saved; }
});

test('unsigned mac is manual, signing stays per asset and older retry cannot lower the feed version', async () => {
  const { createUpdateFeeds } = await feeds;
  const latest = await fixture('1.4.2', false);
  const older = await fixture('1.4.1', true);
  assert.equal(createUpdateFeeds(latest.manifest).length, 4);
  assert.ok(latest.manifest.releases[0].assets.filter(item => item.platform === 'macos').every(item => item.updateSupport === 'manual' && item.signing === 'unsigned'));
  assert.ok(older.manifest.releases[0].assets.filter(item => item.platform === 'macos').every(item => item.updateSupport === 'mac-signed' && item.signing === 'signed-notarized'));
  assert.ok(older.manifest.releases[0].assets.filter(item => item.platform === 'windows').every(item => item.signing === 'unsigned'));
  const manifest = { ...latest.manifest, releases: [...older.manifest.releases, ...latest.manifest.releases] };
  const generated = createUpdateFeeds(manifest);
  assert.equal(generated.length, 6);
  assert.ok(generated.filter(item => !item.path.includes('/darwin/')).every(item => item.info.version === '1.4.2'));
  assert.ok(generated.filter(item => item.path.includes('/darwin/')).every(item => item.info.version === '1.4.1'));
  for (const mutate of [item => { item.url = item.url.replace('WonderMr', 'attacker'); }, item => { item.url = item.url.replace('https:', 'http:'); }, item => { item.sha512 = 'bad'; }, item => { item.name = item.name.replace('x64', 'arm64'); }, item => { item.signing = 'unsigned'; }]) {
    const broken = structuredClone(older.manifest); mutate(broken.releases[0].assets.find(item => item.name.endsWith('macos-x64.zip')));
    assert.throws(() => createUpdateFeeds(broken));
  }
});

test('CI installs Rust for all native jobs and verifies packages before publication', async () => {
  const workflow = await readFile(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  const ci = await readFile(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  for (const source of [workflow, ci]) {
    const install = source.match(/sudo apt-get install[^\n]+/)[0];
    assert.match(install, /\brpm\b/);
    assert.match(install, /\blibarchive-tools\b/);
  }
  assert.match(workflow, /if: steps\.runtime\.outputs\.tauri == 'true'\s*\n\s*run: \|\s*\n\s*rustup toolchain install 1\.92\.0/);
  assert.doesNotMatch(workflow, /secrets\.(?:MAC_CSC_LINK|MAC_CSC_KEY_PASSWORD|MAC_SIGNING_IDENTITY|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID)/);
  assert.match(workflow, /needs: \[validate, package\]/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
  const source = await readFile(path.join(__dirname, '../scripts/release-publish.mjs'), 'utf8');
  assert.ok(source.indexOf('verifyUploaded(existing, false)') < source.indexOf("'--draft=false'"));
  assert.match(source, /loadUpdateReceipts\(\[existing\]/);
});

test('Tauri macOS receipts keep manual downloads while Electron Windows and Linux feeds advance', async () => {
  const lib = await library;
  const { createUpdateFeeds } = await feeds;
  const latest = await fixture('1.5.0');
  const older = await fixture('1.4.2', true);
  const mac = latest.manifest.releases[0].assets.filter(item => item.platform === 'macos');
  assert.ok(mac.every(item => item.runtime === 'tauri' && item.updateSupport === 'manual' && item.signing === 'unsigned'));
  const manifest = { ...latest.manifest, releases: [...latest.manifest.releases, ...older.manifest.releases] };
  const generated = createUpdateFeeds(manifest);
  assert.equal(generated.length, 6);
  assert.ok(generated.filter(item => item.path.includes('/darwin/')).every(item => item.info.version === '1.4.2'));
  assert.ok(generated.filter(item => !item.path.includes('/darwin/')).every(item => item.info.version === '1.5.0'));
  const receipt = latest.receipts.find(item => item.platform === 'darwin');
  for (const mutate of [item => { delete item.runtime; }, item => { item.runtime = 'electron'; }, item => { item.artifacts[0].updaterConfig = true; }, item => { item.artifacts[0].bundleVerified = false; }, item => { item.artifacts[0].signed = true; item.artifacts[0].notarized = true; item.artifacts[0].packageType = 'mac-signed'; }]) {
    const broken = structuredClone(receipt); mutate(broken);
    assert.throws(() => lib.validateReceipt(broken, '1.5.0'));
  }
  const injected = structuredClone(latest.manifest);
  const injectedMac = injected.releases[0].assets.find(item => item.platform === 'macos');
  injectedMac.updateSupport = 'mac-signed';
  injectedMac.signing = 'signed-notarized';
  assert.throws(() => createUpdateFeeds(injected), /Unsafe package/);
});

test('1.6.0 Tauri releases retain downloads for every OS while feeds retain compatible Electron releases', async () => {
  const lib = await library;
  const { createUpdateFeeds } = await feeds;
  const latest = await fixture('1.6.0');
  const previous = await fixture('1.5.3');
  const older = await fixture('1.4.2', true);
  assert.ok(latest.manifest.releases[0].assets.every(item => item.runtime === 'tauri' && item.updateSupport === 'manual' && item.signing === 'unsigned'));
  const manifest = { ...latest.manifest, releases: [...latest.manifest.releases, ...previous.manifest.releases, ...older.manifest.releases] };
  const generated = createUpdateFeeds(manifest);
  assert.equal(generated.length, 6);
  assert.ok(generated.filter(item => item.path.includes('/darwin/')).every(item => item.info.version === '1.4.2'));
  assert.ok(generated.filter(item => !item.path.includes('/darwin/')).every(item => item.info.version === '1.5.3'));
  for (const receipt of latest.receipts) {
    for (const mutate of [item => { item.runtime = 'electron'; }, item => { delete item.runtime; }, item => { item.artifacts[0].updaterConfig = true; }, item => { item.artifacts[0].bundleVerified = false; }, item => { item.artifacts[0].packageType = item.platform === 'win32' ? 'nsis' : 'appimage'; }]) {
      const broken = structuredClone(receipt); mutate(broken);
      assert.throws(() => lib.validateReceipt(broken, '1.6.0'));
    }
  }
});

test('descriptive packages and legacy aliases round trip through receipt, checksum and manifest verification', async () => {
  const lib = await library;
  const { loadUpdateReceipts } = await github;
  for (const [releaseVersion, legacy] of [['1.6.0', false], ['1.6.1', false]]) {
    const f = await fixture(releaseVersion, false, { legacy });
    const count = releaseVersion === '1.6.1' && !legacy ? 20 : 10;
    assert.equal(f.manifest.releases[0].assets.length, count);
    const fetched = await loadUpdateReceipts([f.release], f.options.checksumsByTag, { fetchImpl: async url => new Response(f.files.get(url.split('/').at(-1))) });
    const verified = lib.createManifest([f.release], { ...f.options, receiptsByTag: fetched });
    assert.deepEqual(verified.releases[0].assets.map(item => item.name), f.manifest.releases[0].assets.map(item => item.name));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-download-name-gate-'));
    try {
      for (const [name, bytes] of f.files) await writeFile(path.join(directory, name), bytes);
      assert.equal((await lib.inspectArtifacts(directory, releaseVersion)).length, count + 6);
      assert.equal((await lib.readLocalReceipts(directory, releaseVersion)).length, 6);
      if (count === 20) {
        const receipt = f.receipts.find(item => item.platform === 'win32');
        const alias = receipt.artifacts.find(item => item.name.endsWith('-setup.exe'));
        const canonical = receipt.artifacts.find(item => item.name.endsWith('-Setup.exe'));
        assert.equal(alias.sha256, canonical.sha256);
        assert.equal(alias.sha512, canonical.sha512);
        const changed = structuredClone(receipt);
        changed.artifacts.find(item => item.name === alias.name).sha256 = 'a'.repeat(64);
        assert.throws(() => lib.validateReceipt(changed, releaseVersion), /alias differs/);
        changed.artifacts = receipt.artifacts.filter(item => item.name !== alias.name);
        assert.throws(() => lib.validateReceipt(changed, releaseVersion), /Incomplete/);
        await writeFile(path.join(directory, alias.name), 'tampered compatibility alias');
        await assert.rejects(lib.inspectArtifacts(directory, releaseVersion), /differs from package bytes/);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('modern release receipts reject legacy-only package sets without Linux installers', async () => {
  const lib = await library;
  const historical = await fixture('1.6.0');
  const outdated = structuredClone(historical.receipts);
  for (const receipt of outdated) {
    receipt.version = '1.6.1';
    for (const item of receipt.artifacts) item.name = item.name.replace('-1.6.0-', '-1.6.1-');
    assert.throws(() => lib.validateReceipt(receipt, '1.6.1'), /Incomplete/);
  }
  assert.throws(() => lib.expectedReleaseFiles('1.6.1', outdated), /Incomplete/);
  for (const releaseVersion of ['1.6.1', '1.7.0']) await assert.rejects(fixture(releaseVersion, false, { legacy: true }), /Incomplete/);
});

test('Linux deb and rpm installers require complete verified manual metadata and stay out of updater feeds', async () => {
  const lib = await library;
  const { createUpdateFeeds } = await feeds;
  const f = await fixture('1.6.1');
  const installers = f.manifest.releases[0].assets.filter(item => ['deb', 'rpm'].includes(item.format));
  assert.equal(installers.length, 4);
  assert.ok(installers.every(item => item.platform === 'linux' && item.kind === 'installer' && item.runtime === 'tauri' && item.updateSupport === 'manual' && item.signing === 'unsigned'));
  assert.equal(lib.expectedReleaseFiles('1.6.1').length, 26);
  assert.equal(f.checksums.size, 26);
  assert.equal(f.release.assets.length, 27);
  assert.deepEqual(createUpdateFeeds(f.manifest), []);
  const previous = await fixture('1.5.3');
  const compatible = createUpdateFeeds({ ...f.manifest, releases: [...f.manifest.releases, ...previous.manifest.releases] });
  assert.equal(compatible.length, 4);
  assert.ok(compatible.every(item => item.info.version === '1.5.3'));
  for (const format of ['deb', 'rpm']) {
    const name = lib.artifactName('1.6.1', 'linux', 'x64', format);
    const receipt = f.receipts.find(item => item.platform === 'linux' && item.arch === 'x64');
    const incomplete = structuredClone(receipt);
    incomplete.artifacts = incomplete.artifacts.filter(item => item.name !== name);
    assert.throws(() => lib.validateReceipt(incomplete, '1.6.1'), /Incomplete/);
    const unsupported = structuredClone(receipt);
    unsupported.artifacts.find(item => item.name === name).packageType = 'appimage';
    assert.throws(() => lib.validateReceipt(unsupported, '1.6.1'), /manual bundle metadata/);
    const missing = structuredClone(f.release);
    missing.assets = missing.assets.filter(item => item.name !== name);
    assert.throws(() => lib.createManifest([missing], f.options), /missing or has unexpected/);
    const checksums = new Map(f.checksums);
    checksums.delete(name);
    assert.throws(() => lib.createManifest([f.release], { ...f.options, checksumsByTag: new Map([['v1.6.1', checksums]]) }));
    const injected = structuredClone(f.manifest);
    const asset = injected.releases[0].assets.find(item => item.name === name);
    asset.updateSupport = 'appimage';
    asset.runtime = 'electron';
    assert.throws(() => createUpdateFeeds(injected), /Unsafe package/);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-linux-installer-gate-'));
  try {
    for (const [name, bytes] of f.files) await writeFile(path.join(directory, name), bytes);
    await writeFile(path.join(directory, installers[0].name), 'tampered Linux installer');
    await assert.rejects(lib.inspectArtifacts(directory, '1.6.1'), /differs from package bytes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('1.5.0 publication gate requires Tauri bundle verification and exact package bytes', async () => {
  const lib = await library;
  const fixtureData = await fixture('1.5.0');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-tauri-receipt-gate-'));
  try {
    for (const [name, bytes] of fixtureData.files) await writeFile(path.join(directory, name), bytes);
    assert.equal((await lib.inspectArtifacts(directory, '1.5.0')).length, 16);
    const receipt = fixtureData.receipts.find(item => item.platform === 'darwin');
    const receiptPath = path.join(directory, lib.receiptName('1.5.0', receipt.platform, receipt.arch));
    for (const mutate of [item => { item.runtime = 'electron'; }, item => { delete item.artifacts[0].bundleVerified; }, item => { item.artifacts[0].updaterConfig = true; }, item => { item.artifacts[0].notarized = true; }, item => { item.artifacts[0].sha512 = Buffer.alloc(64).toString('base64'); }]) {
      const changed = structuredClone(receipt); mutate(changed);
      await writeFile(receiptPath, JSON.stringify(changed));
      await assert.rejects(lib.inspectArtifacts(directory, '1.5.0'));
    }
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(path.join(directory, receipt.artifacts[0].name), 'tampered Tauri ZIP');
    await assert.rejects(lib.inspectArtifacts(directory, '1.5.0'), /differs from package bytes/);
    await writeFile(path.join(directory, receipt.artifacts[0].name), fixtureData.files.get(receipt.artifacts[0].name));
    await rm(receiptPath);
    await assert.rejects(lib.inspectArtifacts(directory, '1.5.0'), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('real asar bundles retain target-specific support and reject missing or redirected updater config', async () => {
  const { createPackage } = require('@electron/asar');
  const { packageSupport, verifyPackagedSupport } = await packaging;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-package-support-'));
  const source = path.join(directory, 'source');
  const resources = path.join(directory, 'resources');
  const feed = 'https://blincho.app/updates/win32/x64/';
  try {
    await mkdir(path.join(source, 'electron'), { recursive: true });
    await mkdir(resources);
    for (const target of ['nsis', 'portable']) {
      const support = packageSupport('win32', 'x64', target);
      await writeFile(path.join(source, 'electron/update-support.json'), JSON.stringify(support));
      await createPackage(source, path.join(resources, 'app.asar'));
      await writeFile(path.join(resources, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feed }));
      await verifyPackagedSupport(resources, support, feed);
      await assert.rejects(verifyPackagedSupport(resources, { ...support, arch: 'arm64' }, feed), /support does not match/);
      await writeFile(path.join(resources, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: 'https://evil.example/' }));
      await assert.rejects(verifyPackagedSupport(resources, support, feed), /canonical target/);
      await rm(path.join(resources, 'app-update.yml'));
      await assert.rejects(verifyPackagedSupport(resources, support, feed), /ENOENT/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('feed writer creates isolated architecture paths and refuses a hashless manifest injection before writing', async () => {
  const { writeUpdateFeeds } = await feeds;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-feed-output-'));
  try {
    const f = await fixture(version, true);
    const result = await writeUpdateFeeds(f.manifest, directory);
    for (const item of result) assert.deepEqual(JSON.parse(await readFile(path.join(directory, item.path), 'utf8')), item.info);
    assert.ok(result.some(item => item.path === 'updates/linux/arm64/latest-linux-arm64.yml'));
    assert.ok(result.some(item => item.path === 'updates/linux/x64/latest-linux.yml'));
    const injected = structuredClone(f.manifest);
    delete injected.releases[0].assets.find(item => item.updateSupport === 'nsis').sha512;
    await assert.rejects(writeUpdateFeeds(injected, path.join(directory, 'rejected')), /verified update asset/);
    await assert.rejects(readFile(path.join(directory, 'rejected/updates/darwin/x64/latest-mac.yml')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('website renders per-download signing and emits feeds only from validated manifest data', async () => {
  const { execFileSync } = require('node:child_process');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-release-site-'));
  const root = path.resolve(__dirname, '..');
  try {
    await cp(path.join(root, 'site'), path.join(directory, 'site'), { recursive: true });
    await mkdir(path.join(directory, 'scripts'));
    await mkdir(path.join(directory, 'assets'));
    for (const name of ['release-lib.mjs', 'update-feed.mjs']) await cp(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    await cp(path.join(root, 'assets/icon.png'), path.join(directory, 'assets/icon.png'));
    // Fixture copy only. The translation worker owns the product catalogues.
    const labels = { 'download.signedNotarized': 'Verified signed fixture', 'download.unsigned': 'Unsigned fixture', 'download.signingUnknown': 'Unknown fixture', 'download.inAppUpdates': 'In-app fixture', 'download.manualUpdates': 'Manual fixture' };
    for (const name of await readdir(path.join(directory, 'site/locales'))) {
      const file = path.join(directory, 'site/locales', name);
      const catalog = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...catalog, ...labels }));
    }
    const f = await fixture(version, true);
    await writeFile(path.join(directory, 'site/releases.json'), JSON.stringify(f.manifest));
    execFileSync(process.execPath, ['site/build.mjs'], { cwd: directory });
    const html = await readFile(path.join(directory, 'site-dist/en/index.html'), 'utf8');
    const links = [...html.matchAll(/<a class="download-file" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(links.length, 10);
    for (const [, url, content] of links) {
      assert.ok(content.includes(url.includes('-macos-') ? labels['download.signedNotarized'] : labels['download.unsigned']));
      assert.ok(content.includes(url.endsWith('-portable.exe') || url.endsWith('.tar.gz') ? labels['download.manualUpdates'] : labels['download.inAppUpdates']));
    }
    assert.equal(JSON.parse(await readFile(path.join(directory, 'site-dist/updates/linux/arm64/latest-linux-arm64.yml'), 'utf8')).version, version);
    f.manifest.releases[0].assets.find(item => item.updateSupport === 'nsis').url = 'https://evil.example/update.exe';
    await writeFile(path.join(directory, 'site/releases.json'), JSON.stringify(f.manifest));
    assert.throws(() => execFileSync(process.execPath, ['site/build.mjs'], { cwd: directory, stdio: 'pipe' }), /Invalid verified update asset/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('website prefers descriptive filenames while retaining exact historical download names', async () => {
  const { execFileSync } = require('node:child_process');
  const lib = await library;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-download-name-site-'));
  const root = path.resolve(__dirname, '..');
  try {
    await cp(path.join(root, 'site'), path.join(directory, 'site'), { recursive: true });
    await mkdir(path.join(directory, 'scripts'));
    await mkdir(path.join(directory, 'assets'));
    for (const name of ['release-lib.mjs', 'update-feed.mjs']) await cp(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    await cp(path.join(root, 'assets/icon.png'), path.join(directory, 'assets/icon.png'));
    for (const [releaseVersion, legacy] of [['1.6.0', false], ['1.6.1', false]]) {
      const f = await fixture(releaseVersion, false, { legacy });
      await writeFile(path.join(directory, 'site/releases.json'), JSON.stringify(f.manifest));
      execFileSync(process.execPath, ['site/build.mjs'], { cwd: directory });
      const html = await readFile(path.join(directory, 'site-dist/en/index.html'), 'utf8');
      const links = [...html.matchAll(/<a class="download-file" href="([^"]+)" download="([^"]+)" title="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const count = releaseVersion === '1.6.1' && !legacy ? 14 : 10;
      assert.equal(links.length, count);
      assert.equal(new Set(links.map(([, , name]) => name)).size, count);
      const catalog = JSON.parse(await readFile(path.join(directory, 'site/locales/en.json'), 'utf8'));
      for (const [, url, name, title, content] of links) {
        assert.ok(url.endsWith(`/${name}`));
        assert.equal(title, name);
        assert.ok(lib.describeArtifact(name, releaseVersion));
        assert.equal(name.startsWith('Blincho-Screen-Breaks-'), releaseVersion === '1.6.1' && !legacy);
        if (/\.(deb|rpm)$/.test(name)) {
          assert.ok(content.includes(catalog['download.installer']));
          assert.ok(content.includes(catalog['download.manualUpdates']));
          assert.ok(!content.includes(catalog['download.portable']));
        }
      }
      const changed = structuredClone(f.manifest);
      changed.releases[0].assets.find(item => item.name === links[0][2]).url = 'https://github.com/WonderMr/blincho/releases/download/v1.6.1/other.exe';
      await writeFile(path.join(directory, 'site/releases.json'), JSON.stringify(changed));
      assert.throws(() => execFileSync(process.execPath, ['site/build.mjs'], { cwd: directory, stdio: 'pipe' }), /Invalid download filename or URL/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
