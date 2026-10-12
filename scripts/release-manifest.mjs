import { writeFile, rename, mkdir, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fetchManifest } from './release-github.mjs';
import { REPOSITORY, versionFromTag } from './release-lib.mjs';

const [requiredTag = process.env.RELEASE_TAG, destination = 'site/releases.json'] = process.argv.slice(2);
versionFromTag(requiredTag);
const manifest = await fetchManifest({ repository: process.env.GITHUB_REPOSITORY || REPOSITORY, requiredTag });
const temporary = `${destination}.${process.pid}.tmp`;
await mkdir(path.dirname(destination), { recursive: true });
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
const shouldDeploy = manifest.latest === versionFromTag(requiredTag);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `deploy=${shouldDeploy}\nlatest=${manifest.latest}\n`);
console.log(`Generated ${manifest.releases.length} release entries. Latest: ${manifest.latest}. Deploy this tag: ${shouldDeploy}.`);
