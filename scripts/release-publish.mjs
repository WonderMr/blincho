import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { assertRepository, REPOSITORY, assertVersionMatch, inspectArtifacts, parseChecksums, sha256File, releaseNotes, createManifest } from './release-lib.mjs';
import { listReleases, loadChecksums } from './release-github.mjs';

const tag = process.env.RELEASE_TAG;
const repository = process.env.GITHUB_REPOSITORY || REPOSITORY;
assertRepository(repository);
if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required for release publication');
const version = assertVersionMatch(tag, JSON.parse(await readFile('package.json', 'utf8')), JSON.parse(await readFile('package-lock.json', 'utf8')));
const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), version);
const directory = process.argv[2] || 'release-upload';
const artifacts = await inspectArtifacts(directory, version);
const checksumFile = path.join(directory, 'SHA256SUMS.txt');
const checksumText = await readFile(checksumFile, 'utf8');
const checksums = parseChecksums(checksumText);
if (checksums.size !== artifacts.length || artifacts.some(asset => checksums.get(asset.name) !== asset.sha256)) throw new Error('Local checksums do not match the complete artifact set');
const checksumDigest = await sha256File(checksumFile);
const title = `Blincho ${version} (unsigned beta)`;

function gh(args) {
  const result = spawnSync('gh', [...args, '--repo', repository], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GitHub CLI failed with exit code ${result.status}`);
}

function verifyUploaded(release, published) {
  if (!release || !Array.isArray(release.assets) || release.assets.length !== artifacts.length + 1) throw new Error('Release does not contain exactly the expected artifacts and checksum file');
  for (const local of [...artifacts, { name: 'SHA256SUMS.txt', sha256: checksumDigest, size: Buffer.byteLength(checksumText) }]) {
    const asset = release.assets.find(remote => remote.name === local.name);
    if (asset?.digest !== `sha256:${local.sha256}` || asset.size !== local.size || asset.state !== 'uploaded') throw new Error(`Uploaded bytes do not match the local package: ${local.name}`);
  }
  if (release.name !== title || release.body !== notes || !release.prerelease) throw new Error('Existing release notes or beta metadata differ; review the release manually');
  if (published) createManifest([release], { repository, requiredTag: tag, checksumsByTag: new Map([[tag, checksums]]) });
}

let existing = (await listReleases({ repository })).find(release => release.tag_name === tag);
if (existing && !existing.draft) {
  // A full retry can rebuild different archive timestamps. Verify the published set
  // against its own checksums instead of replacing it with newly rebuilt bytes.
  if (existing.name !== title || existing.body !== notes || !existing.prerelease) throw new Error('Published release metadata differs; review the release manually');
  const publishedChecksums = await loadChecksums([existing], { repository });
  createManifest([existing], { repository, requiredTag: tag, checksumsByTag: publishedChecksums });
  console.log(`Existing ${tag} has a complete verified package set. No release assets were changed.`);
} else {
  if (existing && (existing.name !== title || existing.body !== notes || !existing.prerelease)) throw new Error('An unrelated draft already uses this tag; review it manually');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'blincho-release-'));
  try {
    const notesFile = path.join(temporary, 'notes.md');
    await writeFile(notesFile, notes);
    if (!existing) gh(['release', 'create', tag, '--verify-tag', '--draft', '--prerelease', '--latest=false', '--title', title, '--notes-file', notesFile]);
    // Clobber is restricted to our matching draft. Failed uploads leave a draft for retry.
    gh(['release', 'upload', tag, ...artifacts.map(asset => asset.file), checksumFile, '--clobber']);
    existing = (await listReleases({ repository })).find(release => release.tag_name === tag);
    if (!existing?.draft) throw new Error('Release left draft state before upload verification');
    verifyUploaded(existing, false);
    gh(['release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false', '--verify-tag']);
    const published = (await listReleases({ repository })).find(release => release.tag_name === tag);
    verifyUploaded(published, true);
    console.log(`Published ${tag} with all packages and verified SHA-256 digests.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
