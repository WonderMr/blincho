import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { assertVersionMatch, releaseNotes, usesTauriDesktop } from './release-lib.mjs';

const [tag = process.env.RELEASE_TAG, notesPath] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const lockJson = JSON.parse(await readFile('package-lock.json', 'utf8'));
const version = assertVersionMatch(tag, packageJson, lockJson);
if (usesTauriDesktop(version)) {
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
  const cargoPackage = cargo.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (config.version !== version || cargoVersion !== version || config.identifier !== 'com.myeyes.app' || config.productName !== 'Blincho') throw new Error('Tauri/Cargo identity and versions must match the release');
  if (config.bundle?.active !== true || config.bundle.createUpdaterArtifacts !== false || config.plugins?.updater) throw new Error('Tauri release must enable native bundles and use manual updates');
  if (packageJson.devDependencies?.['@tauri-apps/cli'] !== '2.12.2' || lockJson.packages?.['node_modules/@tauri-apps/cli']?.version !== '2.12.2') throw new Error('Tauri release CLI must be locked to 2.12.2');
}
const notes = releaseNotes(await readFile('CHANGELOG.md', 'utf8'), version);
if (notesPath) await writeFile(notesPath, notes);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Validated ${tag}, package versions and curated changelog. Release mode: unsigned beta.`);
