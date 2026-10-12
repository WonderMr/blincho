import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectArtifacts, versionFromTag } from './release-lib.mjs';

const [directory = 'release-upload', tag = process.env.RELEASE_TAG] = process.argv.slice(2);
const artifacts = await inspectArtifacts(directory, versionFromTag(tag));
await writeFile(path.join(directory, 'SHA256SUMS.txt'), artifacts.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
console.log(`Validated all ${artifacts.length} packages and update receipts; generated SHA256SUMS.txt.`);
