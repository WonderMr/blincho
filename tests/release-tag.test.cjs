const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const path = require('node:path');
const { load } = require('js-yaml');

const library = import('../scripts/prepare-release-tag.mjs');
const sha = 'a'.repeat(40);
const historicalSHA = 'c77cca3653171ecf84818039ca95913573709b9e';
const tag = 'v1.5.0';
const repository = 'WonderMr/blincho';
const reference = (ref, commit = sha, type = 'commit') => ({ ref, object: { type, sha: commit } });
const versions = () => ({ packageJson: { name: 'blincho', version: '1.5.0' }, lockJson: { version: '1.5.0', packages: { '': { version: '1.5.0' } } } });

test('security inventory supports Electron history and requires complete Rust locks', { skip: process.platform === 'win32' }, async (t) => {
  const workflow = load(await readFile(path.join(__dirname, '../.github/workflows/vulnerability-scan.yml'), 'utf8'));
  const stage = workflow.jobs['vulnerability-scan'].steps.find(step => step.id === 'inventory');
  for (const [manifest, lock, succeeds] of [[false, false, true], [true, false, false], [true, true, true], [false, true, false]]) {
    await t.test(`Cargo manifest=${manifest}, lock=${lock}`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-security-inventory-'));
      try {
        const project = path.join(directory, 'project');
        const temporary = path.join(directory, 'runner');
        const output = path.join(directory, 'outputs');
        await mkdir(project); await mkdir(temporary);
        await writeFile(output, '');
        await writeFile(path.join(project, 'package.json'), '{}');
        await writeFile(path.join(project, 'package-lock.json'), '{}');
        if (manifest || lock) await mkdir(path.join(project, 'src-tauri'));
        if (manifest) await writeFile(path.join(project, 'src-tauri/Cargo.toml'), '[package]\nname="fixture"\nversion="1.0.0"\n');
        if (lock) await writeFile(path.join(project, 'src-tauri/Cargo.lock'), 'version = 3\n');
        const result = spawnSync('bash', ['-e', '-c', stage.run], {
          cwd: project, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: temporary, GITHUB_OUTPUT: output },
        });
        assert.equal(result.status === 0, succeeds, result.stderr);
        if (succeeds) assert.equal(await readFile(output, 'utf8'), `targets=package-lock.json${manifest ? ',src-tauri/Cargo.lock' : ''}\n`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
});

function scenario({ responses = [
  [404, {}], [200, reference('refs/heads/main')], [201, reference(`refs/tags/${tag}`)],
], overrides = {} } = {}) {
  const calls = [];
  let versionReads = 0;
  const settings = {
    tag, repository, eventName: 'workflow_dispatch', ref: 'refs/heads/main', workflowSHA: sha,
    token: 'synthetic-ephemeral-token', getCheckedOutSHA: () => sha,
    readVersions: async () => { versionReads += 1; return versions(); },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-ephemeral-token');
      assert.ok(options.signal instanceof AbortSignal);
      const next = responses[calls.length - 1];
      assert.ok(next, `Unexpected API request: ${options.method} ${url}`);
      const [status, value] = next;
      return new Response(JSON.stringify(value), { status });
    },
    ...overrides,
  };
  return { settings, calls, versionReads: () => versionReads };
}

test('manual main dispatch creates only the matching current version at the checked-out exact SHA', async () => {
  const { prepareReleaseTag } = await library;
  const fixture = scenario();
  assert.deepEqual(await prepareReleaseTag(fixture.settings), { tag, sha, created: true });
  assert.equal(fixture.versionReads(), 1);
  assert.deepEqual(fixture.calls, [
    { url: `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`, method: 'GET', body: undefined },
    { url: `https://api.github.com/repos/${repository}/git/ref/heads/main`, method: 'GET', body: undefined },
    { url: `https://api.github.com/repos/${repository}/git/refs`, method: 'POST', body: { ref: `refs/tags/${tag}`, sha } },
  ]);
  assert.equal(Object.hasOwn(fixture.calls.at(-1).body, 'force'), false);
});

test('existing current and historical tags are read-only and do not compare the current main package', async t => {
  const { prepareReleaseTag } = await library;
  for (const [releaseTag, commit, eventName, ref] of [
    [tag, sha, 'workflow_dispatch', 'refs/heads/main'],
    ['v1.4.2', historicalSHA, 'workflow_dispatch', 'refs/heads/main'],
    [tag, sha, 'push', `refs/tags/${tag}`],
    ['v1.4.2', historicalSHA, 'workflow_dispatch', 'refs/heads/retry'],
  ]) await t.test(`${eventName} ${ref} ${releaseTag}`, async () => {
    const fixture = scenario({ responses: [[200, reference(`refs/tags/${releaseTag}`, commit)]], overrides: {
      tag: releaseTag, eventName, ref,
      readVersions: () => { throw new Error('Must not compare historical release with main package'); },
      getCheckedOutSHA: () => { throw new Error('Existing tags do not require a new main checkout'); },
    } });
    assert.deepEqual(await prepareReleaseTag(fixture.settings), { tag: releaseTag, sha: commit, created: false });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].method, 'GET');
    assert.equal(fixture.versionReads(), 0);
  });
});

test('historical annotated tags resolve their commit through read-only API calls', async () => {
  const { prepareReleaseTag } = await library;
  const annotatedSHA = 'b'.repeat(40);
  const fixture = scenario({ responses: [
    [200, reference('refs/tags/v1.4.2', annotatedSHA, 'tag')],
    [200, { sha: annotatedSHA, object: { type: 'commit', sha: historicalSHA } }],
  ], overrides: { tag: 'v1.4.2' } });
  assert.deepEqual(await prepareReleaseTag(fixture.settings), { tag: 'v1.4.2', sha: historicalSHA, created: false });
  assert.ok(fixture.calls.every(call => call.method === 'GET'));
  assert.equal(fixture.versionReads(), 0);
});

test('wrong branch, tag refs and nonmanual events cannot create a missing tag', async t => {
  const { prepareReleaseTag } = await library;
  for (const overrides of [
    { ref: 'refs/heads/feature' }, { ref: `refs/tags/${tag}` },
    { eventName: 'push', ref: `refs/tags/${tag}` }, { eventName: 'pull_request' },
    { eventName: 'push', ref: 'refs/tags/v1.4.2' },
  ]) await t.test(JSON.stringify(overrides), async () => {
    const fixture = scenario({ overrides });
    await assert.rejects(prepareReleaseTag(fixture.settings), /manual dispatch on main|tag push or manual dispatch|Push reference/);
    assert.ok(fixture.calls.every(call => call.method === 'GET'));
    assert.equal(fixture.versionReads(), 0);
  });
});

test('invalid stable tag names and another repository fail before any API request', async t => {
  const { prepareReleaseTag } = await library;
  for (const overrides of [
    ...['', '1.5.0', 'v01.5.0', 'v1.5', 'v1.5.0-beta', 'v1.5.0/evil', 'v1.5.0\n', 'v9007199254740992.0.0'].map(tag => ({ tag })),
    { repository: 'another/repository' },
  ]) await t.test(JSON.stringify(overrides), async () => {
    const fixture = scenario({ overrides });
    await assert.rejects(prepareReleaseTag(fixture.settings));
    assert.equal(fixture.calls.length, 0);
  });
});

test('package identity, tag and both lockfile versions must agree before creation', async t => {
  const { prepareReleaseTag } = await library;
  for (const [name, mutate] of [
    ['package identity', input => { input.packageJson.name = 'wrong'; }],
    ['package version', input => { input.packageJson.version = '1.4.2'; }],
    ['lock version', input => { input.lockJson.version = '1.4.2'; }],
    ['lock root version', input => { input.lockJson.packages[''].version = '1.4.2'; }],
    ['missing lock root', input => { delete input.lockJson.packages['']; }],
  ]) await t.test(name, async () => {
    const fixture = scenario({ overrides: { readVersions: async () => { const input = versions(); mutate(input); return input; } } });
    await assert.rejects(prepareReleaseTag(fixture.settings), /package|Blincho/);
    assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'GET']);
  });
});

test('missing workflow token, invalid dispatch SHA, checkout mismatch and moved main all fail closed', async t => {
  const { prepareReleaseTag } = await library;
  for (const [name, overrides, responses] of [
    ['missing token', { token: '' }, undefined],
    ['invalid SHA', { workflowSHA: 'main' }, undefined],
    ['checkout mismatch', { getCheckedOutSHA: () => 'b'.repeat(40) }, undefined],
    ['moved main', {}, [[404, {}], [200, reference('refs/heads/main', 'b'.repeat(40))]]],
    ['main is a tag object', {}, [[404, {}], [200, reference('refs/heads/main', sha, 'tag')]]],
  ]) await t.test(name, async () => {
    const fixture = scenario({ overrides, ...(responses ? { responses } : {}) });
    // The synthetic fetch still checks absence of real credentials.
    if (!fixture.settings.token) fixture.settings.fetchImpl = async (url, options) => {
      fixture.calls.push({ url, method: options.method });
      assert.equal(options.headers.Authorization, undefined);
      return new Response('{}', { status: 404 });
    };
    await assert.rejects(prepareReleaseTag(fixture.settings), /GITHUB_TOKEN|SHA|Checked-out|Main has changed/);
    assert.ok(fixture.calls.every(call => call.method === 'GET'));
    assert.equal(fixture.versionReads(), 0);
  });
});

test('only a tag lookup 404 allows preparation; other HTTP failures and malformed success bodies never write', async t => {
  const { prepareReleaseTag } = await library;
  for (const status of [401, 403, 409, 422, 429, 500]) await t.test(`HTTP ${status}`, async () => {
    const fixture = scenario({ responses: [[status, {}]] });
    await assert.rejects(prepareReleaseTag(fixture.settings), new RegExp(String(status)));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].method, 'GET');
  });
  for (const [name, value] of [
    ['null', null], ['array', []], ['wrong ref', reference('refs/tags/v1.4.2')],
    ['bad SHA', reference(`refs/tags/${tag}`, 'main')], ['wrong object', reference(`refs/tags/${tag}`, sha, 'tree')],
  ]) await t.test(name, async () => {
    const fixture = scenario({ responses: [[200, value]] });
    await assert.rejects(prepareReleaseTag(fixture.settings), /reference|Git object/);
    assert.equal(fixture.calls.length, 1);
  });
  const fixture = scenario({ responses: [[404, {}], [403, {}]] });
  await assert.rejects(prepareReleaseTag(fixture.settings), /403/);
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'GET']);
  const missingMain = scenario({ responses: [[404, {}], [404, {}]] });
  await assert.rejects(prepareReleaseTag(missingMain.settings), /404/);
  assert.deepEqual(missingMain.calls.map(call => call.method), ['GET', 'GET']);
});

test('a create conflict outside 422 fails without retrying, updating or deleting any reference', async () => {
  const { prepareReleaseTag } = await library;
  const fixture = scenario({ responses: [[404, {}], [200, reference('refs/heads/main')], [409, {}]] });
  await assert.rejects(prepareReleaseTag(fixture.settings), /409/);
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  assert.equal(fixture.calls.at(-1).body.sha, sha);
});

test('a 422 creation race succeeds through read-only resolution only at the checked-out SHA', async t => {
  const { prepareReleaseTag } = await library;
  const annotatedSHA = 'b'.repeat(40);
  const nestedSHA = 'c'.repeat(40);
  for (const [name, responses] of [
    ['lightweight tag', [[200, reference(`refs/tags/${tag}`)]]],
    ['annotated tag', [
      [200, reference(`refs/tags/${tag}`, annotatedSHA, 'tag')],
      [200, { sha: annotatedSHA, object: { type: 'commit', sha } }],
    ]],
    ['nested annotated tag', [
      [200, reference(`refs/tags/${tag}`, annotatedSHA, 'tag')],
      [200, { sha: annotatedSHA, object: { type: 'tag', sha: nestedSHA } }],
      [200, { sha: nestedSHA, object: { type: 'commit', sha } }],
    ]],
  ]) await t.test(name, async () => {
    const fixture = scenario({ responses: [[404, {}], [200, reference('refs/heads/main')], [422, {}], ...responses] });
    assert.deepEqual(await prepareReleaseTag(fixture.settings), { tag, sha, created: false });
    assert.equal(fixture.versionReads(), 1);
    assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'GET', 'POST', ...responses.map(() => 'GET')]);
    assert.equal(fixture.calls[2].body.sha, sha);
    assert.equal(Object.hasOwn(fixture.calls[2].body, 'force'), false);
    assert.equal(fixture.calls[3].url, `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`);
  });
});

test('a 422 creation race with a mismatched, missing or invalid tag fails after bounded read-only checks', async t => {
  const { prepareReleaseTag } = await library;
  const annotatedSHA = 'b'.repeat(40);
  for (const [name, responses, expected] of [
    ['different commit', [[200, reference(`refs/tags/${tag}`, historicalSHA)]], /does not match the checked-out/],
    ['different annotated commit', [
      [200, reference(`refs/tags/${tag}`, annotatedSHA, 'tag')],
      [200, { sha: annotatedSHA, object: { type: 'commit', sha: historicalSHA } }],
    ], /does not match the checked-out/],
    ['missing tag', [[404, {}]], /404/],
    ['wrong reference', [[200, reference('refs/tags/v1.4.2')]], /different release reference/],
    ['invalid object', [[200, reference(`refs/tags/${tag}`, sha, 'tree')]], /Invalid GitHub Git object/],
    ['cyclic annotation', [
      [200, reference(`refs/tags/${tag}`, annotatedSHA, 'tag')],
      [200, { sha: annotatedSHA, object: { type: 'tag', sha: annotatedSHA } }],
    ], /nested annotated release tag/],
    ['lookup failure', [[500, {}]], /500/],
  ]) await t.test(name, async () => {
    const fixture = scenario({ responses: [[404, {}], [200, reference('refs/heads/main')], [422, {}], ...responses] });
    await assert.rejects(prepareReleaseTag(fixture.settings), expected);
    assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'GET', 'POST', ...responses.map(() => 'GET')]);
    assert.equal(fixture.calls[2].body.sha, sha);
  });
});

test('unexpected creation responses, network failures and invalid JSON cannot report success or expose response text', async () => {
  const { prepareReleaseTag } = await library;
  const wrongSHA = scenario({ responses: [[404, {}], [200, reference('refs/heads/main')], [201, reference(`refs/tags/${tag}`, 'b'.repeat(40))]] });
  await assert.rejects(prepareReleaseTag(wrongSHA.settings), /does not match the checked-out/);
  const networkFailure = scenario({ overrides: { fetchImpl: async () => { throw new Error('synthetic-ephemeral-token'); } } });
  await assert.rejects(prepareReleaseTag(networkFailure.settings), error => error.message === 'GitHub Git reference request failed');
  const malformed = scenario({ overrides: { fetchImpl: async () => new Response('synthetic-ephemeral-token') } });
  await assert.rejects(prepareReleaseTag(malformed.settings), error => error.message === 'GitHub Git reference response is not valid JSON');
  const oversized = scenario({ overrides: { fetchImpl: async () => new Response(' '.repeat(65_537)) } });
  await assert.rejects(prepareReleaseTag(oversized.settings), /size limit/);
  const annotatedSHA = 'b'.repeat(40);
  const cycle = scenario({ responses: [
    [200, reference(`refs/tags/${tag}`, annotatedSHA, 'tag')],
    [200, { sha: annotatedSHA, object: { type: 'tag', sha: annotatedSHA } }],
  ] });
  await assert.rejects(prepareReleaseTag(cycle.settings), /nested annotated release tag/);
  assert.ok(cycle.calls.every(call => call.method === 'GET'));
});

test('CLI uses read-only actual checkout SHA and exports the same commit to subsequent jobs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blincho-prepare-tag-'));
  try {
    const input = versions();
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(input.packageJson));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(input.lockJson));
    const mock = path.join(directory, 'mock-github.mjs');
    await writeFile(mock, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.execFileSync = (command, args) => {
        if (command !== 'git' || JSON.stringify(args) !== JSON.stringify(['rev-parse', 'HEAD'])) throw new Error('Unexpected subprocess');
        return '${sha}\\n';
      };
      syncBuiltinESMExports();
      let requests = 0;
      globalThis.fetch = async (url, options) => {
        requests += 1;
        if (requests === 1 && options.method === 'GET' && url.endsWith('/ref/tags/${tag}')) return new Response('{}', { status: 404 });
        if (requests === 2 && options.method === 'GET' && url.endsWith('/ref/heads/main')) return new Response('${JSON.stringify(reference('refs/heads/main'))}');
        if (requests === 3 && options.method === 'POST' && url.endsWith('/git/refs') && options.body === '${JSON.stringify({ ref: `refs/tags/${tag}`, sha })}') return new Response('${JSON.stringify(reference(`refs/tags/${tag}`))}', { status: 201 });
        throw new Error('Unexpected API request');
      };
    `);
    const output = path.join(directory, 'outputs.txt');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, path.resolve(__dirname, '../scripts/prepare-release-tag.mjs')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, RELEASE_TAG: tag, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GH_TOKEN: 'synthetic-ephemeral-token', GITHUB_OUTPUT: output },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), `sha=${sha}\ncreated=true\n`);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-ephemeral-token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workflow gates every job on preparation and pins each checkout to the resolved immutable commit', async () => {
  const workflow = load(await readFile(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  const jobs = workflow.jobs;
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(jobs.prepare.permissions, { contents: 'write' });
  assert.deepEqual(jobs.publish.permissions, { contents: 'write' });
  for (const job of ['validate', 'package', 'deploy']) assert.equal(jobs[job].permissions, undefined);
  assert.equal(jobs['vulnerability-scan'].needs, 'prepare');
  assert.equal(jobs['vulnerability-scan'].uses, './.github/workflows/vulnerability-scan.yml');
  assert.equal(jobs['vulnerability-scan'].with.ref, '${{ needs.prepare.outputs.sha }}');
  assert.deepEqual(jobs.validate.needs, ['prepare', 'vulnerability-scan']);
  assert.equal(jobs.package.needs, 'validate');
  assert.deepEqual(jobs.publish.needs, ['validate', 'package']);
  assert.equal(jobs.deploy.needs, 'publish');
  assert.equal(jobs.prepare.outputs.sha, '${{ steps.tag.outputs.sha }}');
  assert.equal(jobs.validate.outputs.sha, '${{ needs.prepare.outputs.sha }}');
  assert.equal(jobs.publish.outputs.sha, '${{ needs.validate.outputs.sha }}');
  for (const [name, checkoutRef] of Object.entries({
    prepare: '${{ github.sha }}', validate: '${{ needs.prepare.outputs.sha }}',
    package: '${{ needs.validate.outputs.sha }}', publish: '${{ needs.validate.outputs.sha }}', deploy: '${{ needs.publish.outputs.sha }}',
  })) {
    const checkout = jobs[name].steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, checkoutRef);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(jobs[name].if, undefined);
  }
  const preparation = jobs.prepare.steps.find(step => step.id === 'tag');
  assert.equal(preparation.run, 'node scripts/prepare-release-tag.mjs');
  assert.deepEqual(preparation.env, { GH_TOKEN: '${{ github.token }}' });
  for (const job of ['validate', 'package']) {
    const retry = jobs[job].steps.find(step => step.name === 'Repair Windows test import for immutable v1.4.2 retry');
    assert.equal(retry.if, "github.event_name == 'workflow_dispatch' && env.RELEASE_TAG == 'v1.4.2'");
    assert.ok(retry.run.includes(historicalSHA));
  }
});
