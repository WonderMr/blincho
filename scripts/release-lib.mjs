import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const REPOSITORY = 'WonderMr/blincho';
export const UNSIGNED_NOTICE = 'Unsigned beta. These packages are not code-signed or notarized. macOS Gatekeeper and Windows SmartScreen may warn or block launch. Install only if you trust this project and verify the SHA-256 checksum.';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().replace(/\.000Z$/, 'Z') === value.replace(/\.000Z$/, 'Z');
}

export function assertVersion(version) {
  requireValue(typeof version === 'string' && VERSION_PATTERN.test(version), 'Version must be X.Y.Z with no prefix, suffix or leading zeros');
  requireValue(version.split('.').every(part => Number.isSafeInteger(Number(part))), 'Version components are too large');
  return version;
}

export function versionFromTag(tag) {
  requireValue(typeof tag === 'string' && tag.startsWith('v'), 'Release tag must be vX.Y.Z');
  return assertVersion(tag.slice(1));
}

export function assertVersionMatch(tag, packageJson, lockJson) {
  const version = versionFromTag(tag);
  requireValue(packageJson?.name === 'blincho', 'Expected the Blincho package');
  requireValue(packageJson.version === version, 'Tag does not match package.json version');
  requireValue(lockJson?.version === version && lockJson?.packages?.['']?.version === version, 'Tag does not match package-lock.json versions');
  return version;
}

export function releaseNotes(changelog, version, receipts = null) {
  assertVersion(version);
  requireValue(typeof changelog === 'string', 'Changelog must be text');
  const sections = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:[^\n]*)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  const matches = sections.filter(match => match[1] === version);
  requireValue(matches.length === 1, `CHANGELOG.md must contain exactly one ## [${version}] section`);
  const notes = matches[0][2].trim();
  requireValue(notes.length >= 20 && /^- \S/m.test(notes) && !/\b(TODO|TBD|PLACEHOLDER)\b/i.test(notes), 'Release changelog needs curated bullet points without placeholders');
  requireValue(!/[\u2014\u2015]/u.test(notes), 'Release notes must not contain long dashes');
  const notice = receipts ? releaseSigningNotice(receipts) : UNSIGNED_NOTICE;
  return `${notice}\n\n${notes}\n`;
}

export function expectedArtifacts(version) {
  assertVersion(version);
  return ['arm64', 'x64'].flatMap(arch => [
    `Blincho-${version}-macos-${arch}.zip`,
    `Blincho-${version}-windows-${arch}-setup.exe`,
    `Blincho-${version}-windows-${arch}-portable.exe`,
    `Blincho-${version}-linux-${arch}.AppImage`,
    `Blincho-${version}-linux-${arch}.tar.gz`,
  ]).sort();
}

export function describeArtifact(name, version) {
  assertVersion(version);
  if (typeof name !== 'string' || !expectedArtifacts(version).includes(name)) return null;
  const match = name.match(/^Blincho-[\d.]+-(macos|windows|linux)-(arm64|x64)(?:-(setup|portable))?\.(zip|exe|AppImage|tar\.gz)$/);
  return { platform: match[1], architecture: match[2], format: match[4], kind: match[3] === 'setup' ? 'installer' : 'portable' };
}

export function parseChecksums(text) {
  requireValue(typeof text === 'string' && text.length <= 1_000_000, 'Invalid checksum document');
  const checksums = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})  (Blincho-[A-Za-z0-9.\-]+)$/);
    requireValue(match, 'Malformed SHA256SUMS.txt line');
    requireValue(!checksums.has(match[2]), 'Duplicate checksum filename');
    checksums.set(match[2], match[1].toLowerCase());
  }
  requireValue(checksums.size > 0, 'Empty checksum document');
  return checksums;
}

export async function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}
export const sha256File = file => hashFile(file);

export async function inspectArtifacts(directory, version) {
  const expected = expectedReleaseFiles(version);
  const entries = await readdir(directory, { withFileTypes: true });
  requireValue(entries.every(entry => entry.isFile() && (expected.includes(entry.name) || entry.name === 'SHA256SUMS.txt')), 'Unexpected files, directories or symlinks in release upload folder');
  const result = [];
  for (const name of expected) {
    const file = path.join(directory, name);
    const info = await stat(file);
    requireValue(info.size > 0, `Release artifact is empty: ${name}`);
    result.push({ name, file, size: info.size, sha256: await sha256File(file) });
  }
  if (usesUpdateReceipts(version)) await readLocalReceipts(directory, version, result);
  return result;
}

function releaseUrl(repository, tag, name) {
  const base = `https://github.com/${repository}/releases/`;
  return name ? `${base}download/${tag}/${name}` : `${base}tag/${tag}`;
}

export function assertRepository(repository) {
  requireValue(repository === REPOSITORY, `Release repository must be ${REPOSITORY}`);
}

function validateAsset(asset, repository, tag) {
  requireValue(asset && typeof asset === 'object' && !Array.isArray(asset), 'Invalid GitHub release asset');
  requireValue(typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(asset.name), 'Unsafe release asset name');
  const canonical = releaseUrl(repository, tag, encodeURIComponent(asset.name));
  // GitHub preserves unreserved characters and percent-encodes spaces.
  requireValue(asset.browser_download_url === canonical, 'Asset download URL does not belong to this repository and tag');
  requireValue(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.state === 'uploaded', 'Asset is empty or not fully uploaded');
  if (asset.digest != null) requireValue(typeof asset.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/.test(asset.digest), 'Invalid GitHub asset digest');
}

export function createManifest(releases, { repository = REPOSITORY, requiredTag, checksumsByTag = new Map(), receiptsByTag = new Map(), generatedAt = new Date().toISOString() } = {}) {
  assertRepository(repository);
  if (requiredTag) versionFromTag(requiredTag);
  requireValue(Array.isArray(releases), 'GitHub releases response must be an array');
  requireValue(isTimestamp(generatedAt), 'Invalid manifest generation date');
  const versions = new Set();
  const entries = [];
  for (const release of releases) {
    requireValue(release && typeof release === 'object' && !Array.isArray(release), 'Invalid GitHub release');
    requireValue(typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean' && typeof release.tag_name === 'string', 'Invalid GitHub release flags or tag');
    if (release.draft || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name)) continue;
    const version = versionFromTag(release.tag_name);
    requireValue(!versions.has(version), 'Duplicate release version');
    versions.add(version);
    requireValue(release.html_url === releaseUrl(repository, release.tag_name), 'Release URL does not belong to this repository and tag');
    requireValue(isTimestamp(release.published_at), 'Invalid release publication date');
    requireValue(release.name == null || typeof release.name === 'string', 'Invalid release name');
    requireValue(release.body == null || typeof release.body === 'string', 'Invalid release notes');
    requireValue(Array.isArray(release.assets), 'Release assets must be an array');
    const names = new Set();
    const assets = [];
    const receipts = receiptsByTag.get(release.tag_name);
    if (usesUpdateReceipts(version)) {
      requireValue(receipts, 'Release requires verified update receipts');
      validateReceiptSet(receipts, version);
    }
    let checksumUrl = null;
    for (const asset of release.assets) {
      validateAsset(asset, repository, release.tag_name);
      requireValue(!names.has(asset.name), 'Duplicate release asset');
      names.add(asset.name);
      if (asset.name === 'SHA256SUMS.txt') checksumUrl = asset.browser_download_url;
      const description = describeArtifact(asset.name, version);
      if (!description) continue;
      const digest = asset.digest?.slice(7).toLowerCase();
      const checksum = checksumsByTag.get(release.tag_name)?.get(asset.name);
      requireValue(checksum || digest, `Missing SHA-256 for ${asset.name}`);
      requireValue(!checksum || !digest || checksum === digest, 'GitHub digest does not match SHA256SUMS.txt');
      const record = receipts?.flatMap(receipt => receipt.artifacts).find(item => item.name === asset.name);
      if (record) requireValue(digest && checksum === digest && record.sha256 === digest && record.size === asset.size, 'Update receipt does not match verified GitHub asset bytes');
      assets.push({ name: asset.name, url: asset.browser_download_url, size: asset.size, ...description, sha256: checksum ?? digest,
        signing: record ? (record.signed ? 'signed-notarized' : 'unsigned') : 'unknown',
        updateSupport: record?.packageType ?? 'manual', ...(record ? { sha512: record.sha512 } : {}) });
    }
    if (receipts) {
      const checksums = checksumsByTag.get(release.tag_name);
      requireValue(checksumUrl && checksums, 'Release requires SHA256SUMS.txt');
      const expected = expectedReleaseFiles(version);
      requireValue(names.size === expected.length + 1 && expected.every(name => names.has(name)), 'Release is missing or has unexpected package or receipt assets');
      requireValue(checksums.size === expected.length && expected.every(name => checksums.has(name)), 'Release checksum list is incomplete or contains unexpected artifacts');
      for (const asset of release.assets.filter(item => item.name !== 'SHA256SUMS.txt')) requireValue(asset.digest === `sha256:${checksums.get(asset.name)}`, 'GitHub digest does not match SHA256SUMS.txt');
    }
    const notes = release.body ?? '';
    if (release.tag_name === requiredTag) {
      requireValue(release.prerelease && (receipts ? notes.startsWith(releaseSigningNotice(receipts)) : /unsigned beta/i.test(notes)), 'Current release must truthfully describe beta signing status');
      requireValue(checksumUrl && checksumsByTag.has(requiredTag), 'Current release requires SHA256SUMS.txt');
      requireValue(expectedArtifacts(version).every(name => assets.some(asset => asset.name === name)), 'Current release is missing required platform artifacts');
      requireValue(checksumsByTag.get(requiredTag).size === expectedReleaseFiles(version).length && expectedReleaseFiles(version).every(name => checksumsByTag.get(requiredTag).has(name)), 'Current release checksum list is incomplete or contains unexpected artifacts');
    }
    entries.push({ version, tag: release.tag_name, name: release.name || `Blincho ${version}`, publishedAt: release.published_at, url: release.html_url, prerelease: release.prerelease, signing: receipts ? (receipts.some(receipt => receipt.artifacts.some(item => item.signed)) ? 'mixed' : 'unsigned') : /unsigned beta/i.test(notes) ? 'unsigned' : 'unknown', notes, assets: assets.sort((a, b) => a.name.localeCompare(b.name)), checksumUrl });
  }
  if (requiredTag) requireValue(entries.some(release => release.tag === requiredTag), 'Current tag is missing from published GitHub releases');
  entries.sort((a, b) => {
    const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });
  return { schemaVersion: 1, generatedAt, repository, latest: entries[0]?.version ?? null, releases: entries };
}


export const UPDATE_PLATFORMS = ['darwin', 'win32', 'linux'];
export const SITE_PLATFORMS = { darwin: 'macos', win32: 'windows', linux: 'linux' };
export function usesUpdateReceipts(version) { return compareVersions(version, '1.4.0') >= 0; }
export function compareVersions(left, right) {
  assertVersion(left); assertVersion(right);
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
export function receiptName(version, platform, arch) {
  assertVersion(version);
  requireValue(UPDATE_PLATFORMS.includes(platform) && ['x64', 'arm64'].includes(arch), 'Invalid receipt target');
  return `Blincho-${version}-updates-${platform}-${arch}.json`;
}
export function expectedReceipts(version) {
  return UPDATE_PLATFORMS.flatMap(platform => ['arm64', 'x64'].map(arch => receiptName(version, platform, arch))).sort();
}
export function expectedReleaseFiles(version) {
  return [...expectedArtifacts(version), ...(usesUpdateReceipts(version) ? expectedReceipts(version) : [])].sort();
}
export function validateReceipt(receipt, version) {
  requireValue(receipt?.schemaVersion === 1 && receipt.version === version && UPDATE_PLATFORMS.includes(receipt.platform) && ['x64', 'arm64'].includes(receipt.arch), 'Invalid update receipt identity');
  const expected = expectedArtifacts(version).filter(name => {
    const item = describeArtifact(name, version);
    return item.platform === SITE_PLATFORMS[receipt.platform] && item.architecture === receipt.arch;
  });
  requireValue(Array.isArray(receipt.artifacts) && receipt.artifacts.length === expected.length && new Set(receipt.artifacts.map(item => item?.name)).size === expected.length, 'Incomplete or duplicate update receipt artifacts');
  for (const item of receipt.artifacts) {
    requireValue(item && expected.includes(item.name) && Number.isSafeInteger(item.size) && item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256) && typeof item.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(item.sha512) && Buffer.from(item.sha512, 'base64').toString('base64') === item.sha512, 'Invalid update receipt artifact or hashes');
    requireValue(typeof item.signed === 'boolean' && typeof item.notarized === 'boolean' && item.updaterConfig === true, 'Missing verified package configuration');
    const packageType = receipt.platform === 'darwin' && item.signed && item.notarized ? 'mac-signed' : item.name.endsWith('-setup.exe') ? 'nsis' : item.name.endsWith('.AppImage') ? 'appimage' : 'manual';
    requireValue(item.packageType === packageType, 'Invalid package update support');
    requireValue(receipt.platform === 'darwin' ? item.signed === item.notarized : !item.signed && !item.notarized, 'Unsupported signing claim');
  }
  return receipt;
}
export function validateReceiptSet(receipts, version) {
  requireValue(Array.isArray(receipts) && receipts.length === 6, 'Six native update receipts are required');
  for (const receipt of receipts) validateReceipt(receipt, version);
  requireValue(new Set(receipts.map(item => `${item.platform}/${item.arch}`)).size === 6, 'Duplicate native update receipt');
  return receipts;
}
export async function readLocalReceipts(directory, version, inspected = null) {
  const records = inspected ?? await inspectArtifacts(directory, version);
  const receipts = [];
  for (const name of expectedReceipts(version)) {
    const text = await readFile(path.join(directory, name), 'utf8');
    requireValue(Buffer.byteLength(text) <= 65536, 'Update receipt is too large');
    const receipt = validateReceipt(JSON.parse(text), version);
    requireValue(name === receiptName(version, receipt.platform, receipt.arch), 'Update receipt filename mismatch');
    for (const item of receipt.artifacts) {
      const actual = records.find(record => record.name === item.name);
      requireValue(actual && actual.size === item.size && actual.sha256 === item.sha256 && await hashFile(actual.file, 'sha512', 'base64') === item.sha512, 'Update receipt differs from package bytes');
    }
    receipts.push(receipt);
  }
  return validateReceiptSet(receipts, version);
}
export function releaseSigningNotice(receipts) {
  const signed = receipts.filter(item => item.platform === 'darwin').filter(item => item.artifacts[0].signed);
  if (!signed.length) return UNSIGNED_NOTICE;
  const architectures = signed.map(item => item.arch).sort().join(', ');
  return `Beta release. macOS (${architectures}) packages are signed with Developer ID and notarized. Other packages are unsigned. Signing and in-app update support are listed per download. Verify the SHA-256 checksum before manual installation.`;
}
