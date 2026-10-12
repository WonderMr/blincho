const https = require('node:https');

const MANIFEST_URL = 'https://blincho.app/releases.json';
const MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = 15_000;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(version) {
  if (typeof version !== 'string' || version.length > 100 || !RELEASE_VERSION.test(version)) throw new Error('Invalid release version');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid release version');
  return parts;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function availableMacVersion(manifest, currentVersion, arch) {
  versionParts(currentVersion);
  if (!['arm64', 'x64'].includes(arch) || !manifest || manifest.schemaVersion !== 1 ||
      manifest.repository !== 'WonderMr/blincho' || !Array.isArray(manifest.releases) || manifest.releases.length > 200) {
    throw new Error('Invalid release manifest');
  }
  let latest = null;
  for (const release of manifest.releases) {
    versionParts(release?.version);
    if (release.tag !== `v${release.version}` || release.url !== `https://github.com/WonderMr/blincho/releases/tag/v${release.version}` ||
        !Array.isArray(release.assets) || release.assets.length > 30) throw new Error('Invalid release metadata');
    const name = `Blincho-${release.version}-macos-${arch}.zip`;
    const asset = release.assets.find(candidate => candidate?.name === name);
    if (!asset) continue;
    if (asset.platform !== 'macos' || asset.architecture !== arch || asset.format !== 'zip' ||
        asset.url !== `https://github.com/WonderMr/blincho/releases/download/v${release.version}/${name}` ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid package metadata');
    if (compareVersions(release.version, currentVersion) > 0 && (!latest || compareVersions(release.version, latest) > 0)) latest = release.version;
  }
  return latest;
}

// Fetch metadata only. No credentials, renderer URLs, redirects or executable downloads.
function fetchReleaseManifest({ signal, version, get = https.get, timeoutMs = REQUEST_TIMEOUT } = {}) {
  versionParts(version);
  return new Promise((resolve, reject) => {
    let request, response, deadline, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { response?.destroy(); request?.destroy(); reject(error); }
      else resolve(value);
    };
    try {
      request = get(MANIFEST_URL, { signal, agent: false, headers: {
        Accept: 'application/json', 'User-Agent': `Blincho/${version} (+https://blincho.app)`,
      } }, incoming => {
        response = incoming;
        if (incoming.statusCode !== 200 || Number(incoming.headers['content-length']) > MAX_BYTES) {
          finish(new Error('Invalid manifest response')); return;
        }
        let size = 0;
        const chunks = [];
        incoming.on('error', error => finish(error));
        incoming.on('aborted', () => finish(new Error('Incomplete manifest response')));
        incoming.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_BYTES) { finish(new Error('Oversized release manifest')); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (settled) return;
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (error) { finish(error); }
        });
      });
      request.on('error', error => finish(error));
      deadline = setTimeout(() => finish(new Error('Manifest request timed out')), timeoutMs);
      deadline.unref?.();
    } catch (error) { finish(error); }
  });
}

module.exports = { availableMacVersion, fetchReleaseManifest };
