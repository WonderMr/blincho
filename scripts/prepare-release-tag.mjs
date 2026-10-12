import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRepository, assertVersionMatch, versionFromTag } from './release-lib.mjs';

const SHA_PATTERN = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateObject(object) {
  requireValue(object && typeof object.sha === 'string' && SHA_PATTERN.test(object.sha) && ['commit', 'tag'].includes(object.type), 'Invalid GitHub Git object');
  return object;
}

function validateReference(reference, expectedRef) {
  requireValue(reference?.ref === expectedRef, 'GitHub returned a different release reference');
  return validateObject(reference.object);
}

async function readPackageVersions() {
  const [packageText, lockText] = await Promise.all([
    readFile('package.json', 'utf8'), readFile('package-lock.json', 'utf8'),
  ]);
  return { packageJson: JSON.parse(packageText), lockJson: JSON.parse(lockText) };
}

export async function prepareReleaseTag({
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY,
  eventName = process.env.GITHUB_EVENT_NAME,
  ref = process.env.GITHUB_REF,
  workflowSHA = process.env.GITHUB_SHA,
  token = process.env.GH_TOKEN,
  fetchImpl = fetch,
  getCheckedOutSHA = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  readVersions = readPackageVersions,
} = {}) {
  assertRepository(repository);
  versionFromTag(tag);
  requireValue(['push', 'workflow_dispatch'].includes(eventName), 'Release preparation requires a tag push or manual dispatch');
  if (eventName === 'push') requireValue(ref === `refs/tags/${tag}`, 'Push reference does not match the release tag');

  async function request(route, { method = 'GET', body, allowMissing = false, allowConflict = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}/git/${route}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new Error('GitHub Git reference request failed');
    }
    if (allowMissing && response.status === 404) return undefined;
    if (method === 'POST' && allowConflict && response.status === 422) return undefined;
    requireValue(response.status === (method === 'POST' ? 201 : 200), `GitHub Git reference ${method} failed (${response.status})`);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireValue(size <= 65_536, 'GitHub Git reference response exceeded its size limit');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('GitHub Git reference response is not valid JSON'); }
  }

  const tagRef = `refs/tags/${tag}`;
  async function resolveTag(reference) {
    let object = validateReference(reference, tagRef);
    const seen = new Set();
    // Historical annotated tags are peeled without updating their references.
    while (object.type === 'tag') {
      requireValue(!seen.has(object.sha) && seen.size < 10, 'Invalid or excessively nested annotated release tag');
      seen.add(object.sha);
      const annotated = await request(`tags/${object.sha}`);
      requireValue(annotated?.sha === object.sha, 'GitHub returned a different annotated tag');
      object = validateObject(annotated.object);
    }
    return object.sha;
  }
  const existing = await request(`ref/tags/${tag}`, { allowMissing: true });
  if (existing !== undefined) return { tag, sha: await resolveTag(existing), created: false };

  requireValue(eventName === 'workflow_dispatch' && ref === 'refs/heads/main', 'Missing release tags may only be created by manual dispatch on main');
  requireValue(typeof token === 'string' && token.length > 0, 'Release tag creation requires the workflow GITHUB_TOKEN');
  requireValue(typeof workflowSHA === 'string' && SHA_PATTERN.test(workflowSHA), 'Invalid workflow commit SHA');
  const checkedOutSHA = getCheckedOutSHA();
  requireValue(checkedOutSHA === workflowSHA, 'Checked-out commit differs from the dispatched main commit');
  const main = validateReference(await request('ref/heads/main'), 'refs/heads/main');
  requireValue(main.type === 'commit' && main.sha === checkedOutSHA, 'Main has changed since dispatch; rerun the workflow on its current commit');
  const { packageJson, lockJson } = await readVersions();
  assertVersionMatch(tag, packageJson, lockJson);

  // Create once. A competing creator is accepted only at the exact same commit.
  const creation = await request('refs', {
    method: 'POST', body: { ref: tagRef, sha: checkedOutSHA }, allowConflict: true,
  });
  if (creation === undefined) {
    const racedSHA = await resolveTag(await request(`ref/tags/${tag}`));
    requireValue(racedSHA === checkedOutSHA, 'Existing release tag does not match the checked-out main commit');
    return { tag, sha: racedSHA, created: false };
  }
  const created = validateReference(creation, tagRef);
  requireValue(created.type === 'commit' && created.sha === checkedOutSHA, 'Created release tag does not match the checked-out main commit');
  return { tag, sha: checkedOutSHA, created: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const prepared = await prepareReleaseTag();
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `sha=${prepared.sha}\ncreated=${prepared.created}\n`);
    console.log(`Prepared ${prepared.tag} at ${prepared.sha}. Created: ${prepared.created}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
