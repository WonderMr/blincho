import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPOSITORY, UPDATE_PLATFORMS, SITE_PLATFORMS, compareVersions, describeArtifact } from './release-lib.mjs';

export function channelFilename(platform, arch) {
  if (!UPDATE_PLATFORMS.includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported feed target');
  // electron-updater 6.8.9 Provider.getChannelFilePrefix(), not builder defaults.
  return platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml';
}

export function createUpdateFeeds(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.releases) || (manifest.repository != null && manifest.repository !== REPOSITORY)) throw new Error('Invalid update manifest');
  const releases = [...manifest.releases].sort((a, b) => compareVersions(b.version, a.version));
  if (manifest.latest !== (releases[0]?.version ?? null)) throw new Error('Manifest latest version is inconsistent');
  const feeds = [];
  for (const platform of UPDATE_PLATFORMS) for (const arch of ['x64', 'arm64']) {
    for (const release of releases) {
      if (release.tag !== `v${release.version}` || !Array.isArray(release.assets)) throw new Error('Invalid release identity');
      const supportedType = { darwin: 'mac-signed', win32: 'nsis', linux: 'appimage' }[platform];
      const assets = release.assets.filter(item => item.platform === SITE_PLATFORMS[platform] && item.architecture === arch && item.updateSupport === supportedType);
      if (assets.length > 1) throw new Error('Ambiguous update artifact');
      if (!assets.length) continue;
      const asset = assets[0];
      const description = describeArtifact(asset.name, release.version);
      const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${release.tag}/${asset.name}`;
      if (!description || description.platform !== SITE_PLATFORMS[platform] || description.architecture !== arch || asset.url !== expectedUrl || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512) || Buffer.from(asset.sha512, 'base64').toString('base64') !== asset.sha512) throw new Error('Invalid verified update asset');
      if ((asset.runtime != null && asset.runtime !== 'electron') || (platform === 'darwin' && (asset.signing !== 'signed-notarized' || description.format !== 'zip')) || (platform === 'win32' && !asset.name.endsWith('-setup.exe')) || (platform === 'linux' && description.format !== 'AppImage')) throw new Error('Unsafe package in update feed');
      const info = { version: release.version, files: [{ url: asset.url, sha512: asset.sha512, size: asset.size }], path: asset.url, sha512: asset.sha512, releaseDate: release.publishedAt };
      feeds.push({ path: `updates/${platform}/${arch}/${channelFilename(platform, arch)}`, info });
      break;
    }
  }
  return feeds;
}
export async function writeUpdateFeeds(manifest, output) {
  const feeds = createUpdateFeeds(manifest);
  for (const feed of feeds) {
    const destination = path.join(output, feed.path);
    await mkdir(path.dirname(destination), { recursive: true });
    // JSON is a YAML subset, accepted by electron-updater's pinned js-yaml parser.
    await writeFile(destination, JSON.stringify(feed.info, null, 2) + '\n');
  }
  return feeds;
}
