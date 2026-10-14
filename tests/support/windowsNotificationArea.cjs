const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const sourceFiles = { sdkProbe: 'windows-tray-sdk-probe.cpp', sdkDiagnostic: 'diagnose-windows-tray.ps1',
  desktopPreparation: 'prepare-windows-desktop.ps1' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const nonzeroHandle = value => BigInt('0x' + value.replace(/^0x/i, '')) > 0n;
function oneLine(output, pattern, name) {
  const matches = [...output.matchAll(pattern)];
  assert.equal(matches.length, 1, `SDK proof requires exactly one ${name} result`);
  return matches[0];
}

// A platform or environment flag alone cannot exempt an icon assertion. The
// trusted preparation step hands off the independent SDK output from this job.
function loadNotificationAreaProof({ environment = process.env, platform = process.platform,
  architecture = process.arch, hostname = os.hostname(), now = Date.now() } = {}) {
  const file = environment.BLINCHO_WINDOWS_NOTIFICATION_AREA_PROOF;
  const expectedHash = environment.BLINCHO_WINDOWS_NOTIFICATION_AREA_PROOF_SHA256;
  if (!file && !expectedHash) return null;
  assert.equal(platform, 'win32', 'SDK exception requires Windows');
  assert.equal(architecture, 'arm64', 'SDK exception requires native ARM64');
  assert.equal(environment.GITHUB_ACTIONS, 'true', 'SDK exception requires GitHub Actions');
  assert.equal(environment.RUNNER_OS, 'Windows');
  assert.equal(environment.RUNNER_ARCH, 'ARM64');
  assert.equal(typeof file, 'string', 'SDK proof path is missing');
  assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, 'SDK proof hash is missing or malformed');
  assert.equal(typeof environment.RUNNER_TEMP, 'string', 'SDK proof requires RUNNER_TEMP');
  assert(path.isAbsolute(file), 'SDK proof path must be absolute');
  assert.match(path.basename(file), /^blincho-notification-area-proof-[a-f0-9-]{36}\.json$/i);
  const temporary = fs.realpathSync(environment.RUNNER_TEMP);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'SDK proof cannot be a symlink');
  assert.equal(path.dirname(fs.realpathSync(file)), temporary, 'SDK proof must be in RUNNER_TEMP');
  assert(fs.statSync(file).size <= 128 * 1024, 'SDK proof is too large');
  const bytes = fs.readFileSync(file);
  assert.equal(sha256(bytes), expectedHash, 'SDK proof hash does not match its bytes');
  const proof = JSON.parse(bytes.toString('utf8'));
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.classification, 'unavailable');
  assert.equal(proof.probe, 'native-windows-sdk');
  assert.equal(proof.architecture, 'arm64');
  assert.equal(typeof proof.machine, 'string');
  assert.equal(proof.machine.toLowerCase(), hostname.toLowerCase(), 'SDK proof belongs to another machine');
  assert.equal(proof.machine.toLowerCase(), environment.COMPUTERNAME?.toLowerCase(), 'SDK proof machine does not match CI');
  assert(Number.isSafeInteger(proof.sessionId) && proof.sessionId >= 0, 'SDK proof session is invalid');
  assert.equal(String(proof.sessionId), environment.BLINCHO_WINDOWS_DESKTOP_SESSION_ID, 'SDK proof belongs to another session');
  assert(Number.isSafeInteger(proof.taskbarProcessId) && proof.taskbarProcessId > 0, 'SDK proof taskbar process is invalid');
  for (const [key, variable, format] of [['runId', 'GITHUB_RUN_ID', /^\d+$/],
    ['runAttempt', 'GITHUB_RUN_ATTEMPT', /^[1-9]\d*$/], ['job', 'GITHUB_JOB', /^[A-Za-z0-9_-]+$/],
    ['sha', 'GITHUB_SHA', /^[a-f0-9]{40}$/]]) {
    assert.match(environment[variable] ?? '', format, `SDK proof requires ${variable}`);
    assert.equal(proof.github?.[key], environment[variable], `SDK proof belongs to another ${key}`);
  }
  const generated = Date.parse(proof.generatedAt);
  assert(Number.isFinite(generated), 'SDK proof timestamp is invalid');
  assert(now - generated <= 30 * 60_000 && generated - now <= 60_000, 'SDK proof must be fresh');
  for (const [key, name] of Object.entries(sourceFiles)) {
    assert.equal(proof.sourceHashes?.[key], sha256(fs.readFileSync(path.join(__dirname, '../../scripts', name))),
      `SDK proof source does not match ${name}`);
  }
  assert.equal(typeof proof.sdkOutput, 'string');
  const output = proof.sdkOutput.replace(/\r/g, '');
  oneLine(output, /^SDK pointer=8 size=976 hwnd=8 icon=32 tip=40 guid=952 balloon=968$/gm, 'ARM64 struct layout');
  assert.equal(output.split('\n').filter(line => line.startsWith('SDK pointer=')).length, 1, 'SDK layout must not conflict');
  const taskbar = oneLine(output,
    /^taskbar=((?:0x)?[A-Fa-f0-9]+) pid=(\d+) tid=(\d+) responsive=1 response=0 messagingError=0$/gm, 'responsive taskbar');
  assert(nonzeroHandle(taskbar[1]) && Number(taskbar[3]) > 0, 'SDK taskbar must exist');
  assert.equal(Number(taskbar[2]), proof.taskbarProcessId, 'SDK and preflight must inspect the same taskbar');
  assert.equal(output.split('\n').filter(line => line.startsWith('taskbar=')).length, 1, 'SDK taskbar must not conflict');
  oneLine(output, /^STA initialization=0000000[01]$/gm, 'STA initialization');
  assert.equal(output.split('\n').filter(line => line.startsWith('STA initialization=')).length, 1, 'SDK STA result must not conflict');
  for (const [index, name] of ['A-static-no-message', 'A2-static-message', 'B-registered-message', 'C-registered-message-STA'].entries()) {
    const added = oneLine(output, new RegExp(`^${name} window=((?:0x)?[A-Fa-f0-9]+) flags=${index === 0 ? 6 : 7} callback=${index === 0 ? 0 : 6002} add=0 durationMs=\\d+$`, 'gm'), `${name} initial rejection`);
    assert(nonzeroHandle(added[1]), 'SDK variant owner window must exist');
    oneLine(output, new RegExp(`^${name} addAfterPump=0$`, 'gm'), `${name} rejection after pumping`);
    assert.equal(output.split('\n').filter(line => line.startsWith(name + ' ')).length, 2, `${name} must not have contradictory results`);
  }
  return proof;
}

function callIndicatorReady(tray, active, unavailableProof) {
  if (!tray || !Number.isSafeInteger(tray.callIndicatorAttempts) || tray.callIndicatorAttempts < 0 ||
    !Number.isSafeInteger(tray.callIndicatorUpdates) || tray.callIndicatorUpdates < 0 ||
    tray.callIndicatorUpdates > tray.callIndicatorAttempts) return false;
  const applied = tray.callIndicatorActive === active && tray.callIndicatorError === null &&
    (!active || tray.callIndicatorUpdates > 0);
  if (applied) return true;
  if (unavailableProof) {
    return tray.callIndicatorActive === false && tray.callIndicatorUpdates === 0 && (active
      ? tray.callIndicatorAttempts > 0 && typeof tray.callIndicatorError === 'string' &&
        /^tray icon error: Unspecified error \(os error -2147467259\)$/.test(tray.callIndicatorError)
      : tray.callIndicatorError === null);
  }
  return false;
}

function assertCallIndicator(tray, active, unavailableProof) {
  assert(callIndicatorReady(tray, active, unavailableProof),
    `Expected ${unavailableProof ? 'independently proven unavailable' : 'successfully applied'} ${active ? 'active' : 'inactive'} tray icon: ${JSON.stringify(tray)}`);
}

function assertCallRestored(active, inactive, unavailableProof) {
  assertCallIndicator(inactive, false, unavailableProof);
  if (active.callIndicatorActive || inactive.callIndicatorUpdates > 0) {
    assert(inactive.callIndicatorUpdates > active.callIndicatorUpdates, 'Call end or disable restores the regular icon');
  } else {
    assert(unavailableProof, 'Unavailable native icon requires independent SDK proof');
    assert.equal(inactive.callIndicatorUpdates, 0, 'Rejected icon changes cannot be reported as successful');
    assert(inactive.callIndicatorAttempts >= active.callIndicatorAttempts, 'Failure diagnostics retain attempted icon changes');
  }
}

module.exports = { loadNotificationAreaProof, callIndicatorReady, assertCallIndicator, assertCallRestored };
