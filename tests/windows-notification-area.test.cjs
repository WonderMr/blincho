const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadNotificationAreaProof, callIndicatorReady, assertCallIndicator, assertCallRestored } = require('./support/windowsNotificationArea.cjs');

const sdkOutput = [
  'SDK pointer=8 size=976 hwnd=8 icon=32 tip=40 guid=952 balloon=968',
  'taskbar=00000000000302CA pid=9412 tid=5712 responsive=1 response=0 messagingError=0',
  'desktop=Default',
  ...['A-static-no-message', 'A2-static-message', 'B-registered-message', 'C-registered-message-STA'].flatMap((name, index) => [
    `${name} window=000000000004012E flags=${index === 0 ? 6 : 7} callback=${index === 0 ? 0 : 6002} add=0 durationMs=0`,
    `${name} addAfterPump=0`,
  ]),
  'STA initialization=00000000',
].join('\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const scripts = { sdkProbe: 'windows-tray-sdk-probe.cpp', sdkDiagnostic: 'diagnose-windows-tray.ps1', desktopPreparation: 'prepare-windows-desktop.ps1' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-proof-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'blincho-notification-area-proof-11111111-1111-1111-1111-111111111111.json');
  const now = Date.now();
  const environment = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ARCH: 'ARM64', RUNNER_TEMP: directory,
    COMPUTERNAME: 'runner-example', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'tauri-native',
    GITHUB_SHA: 'a'.repeat(40), BLINCHO_WINDOWS_DESKTOP_SESSION_ID: '3', BLINCHO_WINDOWS_NOTIFICATION_AREA_PROOF: file };
  const proof = { schemaVersion: 1, classification: 'unavailable', probe: 'native-windows-sdk', architecture: 'arm64',
    generatedAt: new Date(now).toISOString(), machine: 'RUNNER-EXAMPLE', sessionId: 3, taskbarProcessId: 9412,
    github: { runId: '12345', runAttempt: '2', job: 'tauri-native', sha: 'a'.repeat(40) },
    sourceHashes: Object.fromEntries(Object.entries(scripts).map(([key, name]) => [key,
      sha256(fs.readFileSync(path.join(__dirname, '../scripts', name)))])), sdkOutput };
  function save() {
    fs.writeFileSync(file, JSON.stringify(proof));
    environment.BLINCHO_WINDOWS_NOTIFICATION_AREA_PROOF_SHA256 = sha256(fs.readFileSync(file));
  }
  save();
  return { proof, environment, save, file, options: { environment, platform: 'win32', architecture: 'arm64', hostname: 'runner-example', now } };
}

test('without SDK proof every desktop and CI target requires actual icon application', () => {
  for (const environment of [{}, { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ARCH: 'ARM64' },
    { BLINCHO_ALLOW_UNAVAILABLE_NOTIFICATION_AREA: '1' }]) assert.equal(loadNotificationAreaProof({ environment }), null);
  const failed = { callIndicatorActive: false, callIndicatorAttempts: 1, callIndicatorUpdates: 0,
    callIndicatorError: 'tray icon error: Unspecified error (os error -2147467259)' };
  assert.equal(callIndicatorReady(failed, true, null), false);
  assert.throws(() => assertCallIndicator(failed, true, null));
});

test('same-machine ARM64 CI proof accepts all four SDK failures and failed native diagnostics', t => {
  const fixtureData = fixture(t);
  const proof = loadNotificationAreaProof(fixtureData.options);
  assert.equal(proof.classification, 'unavailable');
  const active = { callIndicatorActive: false, callIndicatorAttempts: 1, callIndicatorUpdates: 0,
    callIndicatorError: 'tray icon error: Unspecified error (os error -2147467259)' };
  assert.equal(callIndicatorReady(active, true, proof), true);
  assert.doesNotThrow(() => assertCallIndicator(active, true, proof));
  assert.doesNotThrow(() => assertCallIndicator({ ...active, callIndicatorError: null }, false, proof));
  const recovered = { callIndicatorActive: true, callIndicatorAttempts: 2, callIndicatorUpdates: 1, callIndicatorError: null };
  assert.equal(callIndicatorReady(recovered, true, proof), true, 'Recovered native application still requires healthy diagnostics');
  assert.doesNotThrow(() => assertCallIndicator(recovered, true, proof));
  for (const mutation of [ { callIndicatorActive: true }, { callIndicatorAttempts: 0 }, { callIndicatorUpdates: 1 },
    { callIndicatorError: null }, { callIndicatorError: 'another backend error' }]) {
    assert.equal(callIndicatorReady({ ...active, ...mutation }, true, proof), false);
    assert.throws(() => assertCallIndicator({ ...active, ...mutation }, true, proof));
  }
});

test('proof rejects local runs, other architectures, machines, jobs, attempts and commits', t => {
  const fixtureData = fixture(t);
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'Linux' }, { RUNNER_ARCH: 'X64' },
    { COMPUTERNAME: 'another-machine' }, { GITHUB_RUN_ID: '54321' }, { GITHUB_RUN_ATTEMPT: '1' },
    { GITHUB_JOB: 'package' }, { GITHUB_SHA: 'b'.repeat(40) }, { BLINCHO_WINDOWS_DESKTOP_SESSION_ID: '4' }]) {
    assert.throws(() => loadNotificationAreaProof({ ...fixtureData.options,
      environment: { ...fixtureData.environment, ...change } }));
  }
  for (const change of [{ platform: 'darwin' }, { architecture: 'x64' }, { hostname: 'another-machine' }]) {
    assert.throws(() => loadNotificationAreaProof({ ...fixtureData.options, ...change }));
  }
});

test('proof rejects modified bytes, stale or future timestamps, source changes and untrusted locations', t => {
  const fixtureData = fixture(t);
  fs.appendFileSync(fixtureData.file, ' ');
  assert.throws(() => loadNotificationAreaProof(fixtureData.options), /hash/);
  fixtureData.save();
  for (const generatedAt of ['invalid', new Date(fixtureData.options.now - 31 * 60_000).toISOString(),
    new Date(fixtureData.options.now + 61_000).toISOString()]) {
    fixtureData.proof.generatedAt = generatedAt; fixtureData.save();
    assert.throws(() => loadNotificationAreaProof(fixtureData.options), /time|fresh/);
  }
  fixtureData.proof.generatedAt = new Date(fixtureData.options.now).toISOString();
  fixtureData.proof.sourceHashes.sdkProbe = 'b'.repeat(64); fixtureData.save();
  assert.throws(() => loadNotificationAreaProof(fixtureData.options), /source/);
  fixtureData.environment.RUNNER_TEMP = path.join(fixtureData.environment.RUNNER_TEMP, 'other');
  fs.mkdirSync(fixtureData.environment.RUNNER_TEMP);
  assert.throws(() => loadNotificationAreaProof(fixtureData.options), /RUNNER_TEMP/);
});

test('incomplete, contradictory or malformed SDK evidence never relaxes icon assertions', t => {
  const fixtureData = fixture(t);
  const variants = ['A-static-no-message', 'A2-static-message', 'B-registered-message', 'C-registered-message-STA'];
  const invalid = [sdkOutput.replace('size=976', 'size=968'), sdkOutput.replace('responsive=1', 'responsive=0'),
    sdkOutput.replace('pid=9412', 'pid=9413'), sdkOutput.replace('messagingError=0', 'messagingError=5'),
    sdkOutput.replace('STA initialization=00000000', 'STA initialization=80010106'),
    sdkOutput + '\nSTA initialization=80010106',
    sdkOutput.replace('window=000000000004012E', 'window=0000000000000000'),
    sdkOutput + '\n' + sdkOutput.split('\n')[0],
    ...variants.flatMap(name => [sdkOutput.replace(`${name} addAfterPump=0`, `${name} addAfterPump=1`),
      sdkOutput.replace(new RegExp(`^${name} (.+) add=0 `, 'm'), `${name} $1 add=1 `),
      sdkOutput.replace(new RegExp(`^${name} window=.+$`, 'm'), ''),
      sdkOutput.replace(`${name} window=000000000004012E flags=`, `${name} window=000000000004012E flags=99`)])];
  for (const output of invalid) {
    fixtureData.proof.sdkOutput = output; fixtureData.save();
    assert.throws(() => loadNotificationAreaProof(fixtureData.options));
  }
});

test('normal icon diagnostics require success and inactive diagnostics require cleared errors', () => {
  const active = { callIndicatorActive: true, callIndicatorAttempts: 1, callIndicatorUpdates: 1, callIndicatorError: null };
  assert.equal(callIndicatorReady(active, true, null), true);
  assert.doesNotThrow(() => assertCallIndicator(active, true, null));
  assert.equal(callIndicatorReady({ ...active, callIndicatorUpdates: 0 }, true, null), false);
  assert.equal(callIndicatorReady({ ...active, callIndicatorError: 'failed' }, true, null), false);
  assert.equal(callIndicatorReady({ ...active, callIndicatorActive: false }, false, null), true);
  assert.equal(callIndicatorReady({ ...active, callIndicatorActive: false, callIndicatorError: 'failed' }, false, null), false);
});

test('restoration preserves positive transitions after recovery and never counts rejection as success', t => {
  const proof = loadNotificationAreaProof(fixture(t).options);
  const failed = { callIndicatorActive: false, callIndicatorAttempts: 1, callIndicatorUpdates: 0,
    callIndicatorError: 'tray icon error: Unspecified error (os error -2147467259)' };
  const endedUnavailable = { ...failed, callIndicatorError: null };
  assert.doesNotThrow(() => assertCallRestored(failed, endedUnavailable, proof));
  assert.throws(() => assertCallRestored(failed, endedUnavailable, null));
  const recovered = { callIndicatorActive: true, callIndicatorAttempts: 2, callIndicatorUpdates: 1, callIndicatorError: null };
  assert.throws(() => assertCallRestored(recovered, { ...recovered, callIndicatorActive: false }, proof), /restores/);
  const restored = { callIndicatorActive: false, callIndicatorAttempts: 3, callIndicatorUpdates: 2, callIndicatorError: null };
  assert.doesNotThrow(() => assertCallRestored(recovered, restored, proof));
  assert.doesNotThrow(() => assertCallRestored(failed, restored, proof));
});
