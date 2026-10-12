const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm, symlink } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const library = import('../scripts/release-lib.mjs');
const github = import('../scripts/release-github.mjs');
const digest = 'a'.repeat(64);
const repository = 'WonderMr/blincho';

async function fixture(version = '1.3.2') {
  const { expectedArtifacts } = await library;
  const tag = `v${version}`;
  const assets = expectedArtifacts(version).map((name, index) => ({ name, size: index + 10, state: 'uploaded', digest: `sha256:${digest}`, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` }));
  const checksumText = expectedArtifacts(version).map(name => `${digest}  ${name}\n`).join('');
  assets.push({ name: 'SHA256SUMS.txt', size: Buffer.byteLength(checksumText), state: 'uploaded', digest: `sha256:${createHash('sha256').update(checksumText).digest('hex')}`, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/SHA256SUMS.txt` });
  return { tag_name: tag, name: `Blincho ${version}`, body: 'Unsigned beta. Curated release notes.', published_at: '2026-10-12T12:00:00Z', draft: false, prerelease: true, html_url: `https://github.com/${repository}/releases/tag/${tag}`, assets };
}

async function options(tag = 'v1.3.2') {
  const { expectedArtifacts } = await library;
  return { requiredTag: tag, generatedAt: '2026-10-12T12:00:00Z', checksumsByTag: new Map([[tag, new Map(expectedArtifacts(tag.slice(1)).map(name => [name, digest]))]]) };
}

test('release tags must match package and both lockfile versions exactly', async () => {
  const { assertVersionMatch, versionFromTag } = await library;
  const pkg = { name: 'blincho', version: '1.3.2' };
  const lock = { version: '1.3.2', packages: { '': { version: '1.3.2' } } };
  assert.equal(assertVersionMatch('v1.3.2', pkg, lock), '1.3.2');
  for (const tag of ['1.3.2', 'v01.3.2', 'v1.3.2-beta', 'v1.3.2\n', 'v1.3', 'v1.3.2/evil', 'v99999999999999999999.0.0']) assert.throws(() => versionFromTag(tag));
  assert.throws(() => assertVersionMatch('v1.3.3', pkg, lock), /package.json/);
  assert.throws(() => assertVersionMatch('v1.3.2', pkg, { ...lock, version: '1.3.1' }), /package-lock/);
  assert.throws(() => assertVersionMatch('v1.3.2', pkg, { ...lock, packages: {} }), /package-lock/);
});

test('notes use only the requested curated changelog section and force the unsigned beta notice', async () => {
  const { releaseNotes } = await library;
  const text = '# Changelog\n\n## [1.3.2]\n\n- New website and download history.\n\n## [1.3.1]\n\n- Older unrelated changes.\n';
  const notes = releaseNotes(text, '1.3.2');
  assert.match(notes, /^Unsigned beta\./);
  assert.match(notes, /New website/);
  assert.doesNotMatch(notes, /Older unrelated/);
  for (const malformed of ['# Missing entry', '## [1.3.2]\n\n- TODO release changes.', `${text}\n## [1.3.2]\n\n- Duplicate heading and release.`, '## [1.3.2]\n\n']) assert.throws(() => releaseNotes(malformed, '1.3.2'));
});

test('manifest chooses latest semantic version while retaining earlier releases and beta labels', async () => {
  const { createManifest } = await library;
  const older = await fixture('1.3.9');
  older.published_at = '2026-10-13T12:00:00Z';
  const current = await fixture('1.3.10');
  const manifest = createManifest([older, current], await options('v1.3.10'));
  assert.equal(manifest.latest, '1.3.10');
  assert.deepEqual(manifest.releases.map(release => release.version), ['1.3.10', '1.3.9']);
  assert.equal(manifest.releases[0].assets.length, 10);
  assert.equal(manifest.releases[0].signing, 'unsigned');
  assert.equal(manifest.releases[0].prerelease, true);
  assert.deepEqual(new Set(manifest.releases[0].assets.map(asset => `${asset.platform}/${asset.architecture}`)), new Set(['macos/arm64', 'macos/x64', 'windows/arm64', 'windows/x64', 'linux/arm64', 'linux/x64']));
});

test('historical releases without modern assets retain notes and release links without invented signing data', async () => {
  const { createManifest } = await library;
  const old = await fixture('1.0.0');
  old.body = 'Initial public release';
  old.assets = [];
  const draft = { ...(await fixture('2.0.0')), draft: true };
  const manifest = createManifest([await fixture(), old, draft], await options());
  assert.equal(manifest.releases.length, 2);
  assert.equal(manifest.releases[1].signing, 'unknown');
  assert.equal(manifest.releases[1].checksumUrl, null);
  assert.deepEqual(manifest.releases[1].assets, []);
});

test('malformed GitHub inputs fail closed before a manifest can replace the live release list', async () => {
  const { createManifest } = await library;
  const settings = await options();
  for (const input of [null, {}, [null], [{ tag_name: 'v1.3.2' }]]) assert.throws(() => createManifest(input, settings));
  const mutations = [
    release => { release.prerelease = false; },
    release => { release.body = '<script>untrusted notes</script>'; },
    release => { release.body = {}; },
    release => { release.name = {}; },
    release => { release.published_at = 'not a date'; },
    release => { release.published_at = '2026-02-30T12:00:00Z'; },
    release => { release.html_url = 'https://evil.example/release'; },
    release => { release.assets.pop(); },
    release => { release.assets.shift(); },
    release => { release.assets[0].browser_download_url = 'javascript:alert(1)'; },
    release => { release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace('v1.3.2', 'v1.3.1'); },
    release => { release.assets[0].size = -1; },
    release => { release.assets[0].state = 'new'; },
    release => { release.assets[0].digest = `sha256:${'b'.repeat(64)}`; },
    release => { release.assets[0].name = '../evil'; },
    release => { release.assets.push({ ...release.assets[0] }); },
  ];
  for (const mutate of mutations) { const release = await fixture(); mutate(release); assert.throws(() => createManifest([release], settings)); }
  assert.throws(() => createManifest([], settings), /missing from published/);
  const release = await fixture();
  assert.throws(() => createManifest([release, release], settings), /Duplicate release/);
  assert.throws(() => createManifest([release], { ...settings, repository: 'other/project' }), /repository/);
  assert.throws(() => createManifest([release], { ...settings, checksumsByTag: new Map() }), /requires SHA256SUMS/);
});

test('checksum parser rejects traversal, malformed digests and duplicate names', async () => {
  const { parseChecksums } = await library;
  assert.equal(parseChecksums(`${digest}  Blincho-1.3.2-macos-arm64.zip\n`).size, 1);
  for (const invalid of ['', `${digest}  ../secret.zip`, `${digest}  /absolute.zip`, 'abc  Blincho-test.zip', `${digest}  Blincho-test.zip\n${digest}  Blincho-test.zip`]) assert.throws(() => parseChecksums(invalid));
});

test('artifact gate hashes actual files and rejects missing, empty, extra and linked artifacts', async () => {
  const { expectedArtifacts, inspectArtifacts } = await library;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-artifacts-'));
  try {
    const names = expectedArtifacts('1.3.2');
    for (const name of names) await writeFile(path.join(directory, name), `fixture:${name}`);
    const results = await inspectArtifacts(directory, '1.3.2');
    assert.equal(results.length, 10);
    assert.equal(new Set(results.map(asset => asset.sha256)).size, 10);
    await writeFile(path.join(directory, 'unexpected.txt'), 'bad');
    await assert.rejects(inspectArtifacts(directory, '1.3.2'), /Unexpected/);
    await rm(path.join(directory, 'unexpected.txt'));
    await writeFile(path.join(directory, names[0]), '');
    await assert.rejects(inspectArtifacts(directory, '1.3.2'), /empty/);
    await rm(path.join(directory, names[0]));
    await assert.rejects(inspectArtifacts(directory, '1.3.2'), /ENOENT/);
    if (process.platform !== 'win32') {
      await symlink(path.join(directory, names[1]), path.join(directory, names[0]));
      await assert.rejects(inspectArtifacts(directory, '1.3.2'), /symlinks/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GitHub release listing paginates and rejects errors and malformed JSON shape', async () => {
  const { listReleases } = await github;
  const requests = [];
  const releases = await listReleases({ token: 'test-token', fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(requests.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]));
  } });
  assert.equal(releases.length, 101);
  assert.match(requests[1], /page=2$/);
  await assert.rejects(listReleases({ fetchImpl: async () => new Response('{}') }), /must be an array/);
  await assert.rejects(listReleases({ fetchImpl: async () => new Response('{}', { status: 403 }) }), /403/);
  await assert.rejects(listReleases({ fetchImpl: async () => new Response('not JSON') }), SyntaxError);
});

test('checksum download verifies origin before fetching and does not forward credentials', async () => {
  const { loadChecksums } = await github;
  const { expectedArtifacts } = await library;
  const release = await fixture();
  let called = 0;
  const result = await loadChecksums([release], { fetchImpl: async (url, settings) => {
    called += 1;
    assert.equal(settings.headers, undefined);
    return new Response(expectedArtifacts('1.3.2').map(name => `${digest}  ${name}\n`).join(''));
  } });
  assert.equal(result.get('v1.3.2').size, 10);
  assert.equal(called, 1);
  await assert.rejects(loadChecksums([release], { fetchImpl: async () => new Response('truncated') }), /size differs/);
  release.assets.at(-1).digest = `sha256:${'b'.repeat(64)}`;
  await assert.rejects(loadChecksums([release], { fetchImpl: async () => new Response(expectedArtifacts('1.3.2').map(name => `${digest}  ${name}\n`).join('')) }), /digest differs/);
  release.assets.at(-1).browser_download_url = 'https://evil.example/checksums';
  await assert.rejects(loadChecksums([release], { fetchImpl: () => { throw new Error('must not fetch'); } }), /Invalid checksum asset/);
});

test('workflow publishes only after all native packages and deploys only after publication', async () => {
  const workflow = await readFile(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /needs: \[validate, package\]/);
  assert.match(workflow, /deploy:\s*\n\s*needs: publish/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
  for (const os of ['macos-15-intel', 'macos-15', 'windows-2022', 'windows-11-arm', 'ubuntu-24.04-arm', 'ubuntu-24.04']) assert.ok(workflow.includes(`os: ${os},`));
  assert.match(workflow, /manifest.outputs.deploy == 'true'/);
});
