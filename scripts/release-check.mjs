import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { assertVersionMatch, releaseNotes } from './release-lib.mjs';

const [tag = process.env.RELEASE_TAG, notesPath] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lockJson = JSON.parse(await readFile('package-lock.json', 'utf8'));
const version = assertVersionMatch(tag, packageJson, lockJson);
const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), version);
if (notesPath) await writeFile(notesPath, notes);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Validated ${tag}, package versions and curated changelog. Release mode: unsigned beta.`);
