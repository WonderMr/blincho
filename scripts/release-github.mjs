import { REPOSITORY, assertRepository, versionFromTag, parseChecksums, createManifest, usesUpdateReceipts, expectedReceipts, validateReceipt, validateReceiptSet, receiptName } from './release-lib.mjs';
import { createHash } from 'node:crypto';

async function boundedText(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('GitHub response exceeded its size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function listReleases({ repository = REPOSITORY, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  assertRepository(repository);
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub release listing failed (${response.status})`);
    const entries = JSON.parse(await boundedText(response, 10_000_000));
    if (!Array.isArray(entries)) throw new Error('GitHub releases response must be an array');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error('GitHub release history exceeds the 10,000-release safety limit; increase the reviewed bound before deploying');
}

export async function loadChecksums(releases, { repository = REPOSITORY, fetchImpl = fetch } = {}) {
  assertRepository(repository);
  const result = new Map();
  for (const release of releases) {
    if (release?.draft === true || typeof release?.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
    versionFromTag(release.tag_name);
    if (!Array.isArray(release.assets)) throw new Error('Release assets must be an array');
    const checksumAssets = release.assets.filter(asset => asset?.name === 'SHA256SUMS.txt');
    if (checksumAssets.length > 1) throw new Error('Duplicate checksum asset');
    if (!checksumAssets.length) continue;
    const asset = checksumAssets[0];
    const expectedUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/SHA256SUMS.txt`;
    if (asset.browser_download_url !== expectedUrl || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1_000_000) {
      throw new Error('Invalid checksum asset metadata');
    }
    // Published assets are public. Do not forward the GitHub token to download redirects.
    const response = await fetchImpl(expectedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Checksum download failed (${response.status})`);
    const text = await boundedText(response, 1_000_000);
    if (Buffer.byteLength(text) !== asset.size) throw new Error('Checksum document size differs from GitHub metadata');
    if (asset.digest != null && asset.digest !== `sha256:${createHash('sha256').update(text).digest('hex')}`) throw new Error('Checksum document digest differs from GitHub metadata');
    result.set(release.tag_name, parseChecksums(text));
  }
  return result;
}

export async function fetchManifest(options = {}) {
  const releases = await listReleases(options);
  const checksumsByTag = await loadChecksums(releases, options);
  const receiptsByTag = await loadUpdateReceipts(releases, checksumsByTag, options);
  return createManifest(releases, { ...options, checksumsByTag, receiptsByTag });
}


export async function loadUpdateReceipts(releases, checksumsByTag, { repository = REPOSITORY, fetchImpl = fetch } = {}) {
  assertRepository(repository);
  const result = new Map();
  for (const release of releases) {
    if (release?.draft === true || typeof release?.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
    const version = versionFromTag(release.tag_name);
    if (!usesUpdateReceipts(version)) continue;
    const receipts = [];
    for (const name of expectedReceipts(version)) {
      const matches = release.assets?.filter(item => item.name === name);
      if (matches?.length !== 1) throw new Error('Missing or duplicate update receipt asset');
      const asset = matches[0];
      const expectedUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
      const checksum = checksumsByTag.get(release.tag_name)?.get(name);
      if (asset.browser_download_url !== expectedUrl || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 65536 || !checksum || asset.digest !== `sha256:${checksum}`) throw new Error('Invalid or unverified update receipt asset');
      const response = await fetchImpl(expectedUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Update receipt download failed (${response.status})`);
      const text = await boundedText(response, 65536);
      if (Buffer.byteLength(text) !== asset.size || createHash('sha256').update(text).digest('hex') !== checksum) throw new Error('Update receipt bytes differ from verified digest');
      const receipt = validateReceipt(JSON.parse(text), version);
      if (name !== receiptName(version, receipt.platform, receipt.arch)) throw new Error('Update receipt filename mismatch');
      receipts.push(receipt);
    }
    result.set(release.tag_name, validateReceiptSet(receipts, version));
  }
  return result;
}
