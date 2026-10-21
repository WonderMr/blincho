const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, after } = require('node:test');
const { webcrypto } = require('node:crypto');

const repository = path.resolve(__dirname, '..');
const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-sync-'));
const config = path.join(buildDirectory, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({
  files: ['src/utils/syncCrypto.ts', 'src/utils/syncData.ts', 'src/utils/storage.ts'].map(file => path.join(repository, file)),
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    skipLibCheck: true, rootDir: path.join(repository, 'src'), outDir: buildDirectory },
}));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { generateRecoveryKey, deriveSyncKey, encryptSync, decryptSync, MAX_SYNC_PAYLOAD_BYTES } = require(path.join(buildDirectory, 'utils/syncCrypto.js'));
const { projectSyncSettings, applySyncSettings, projectSyncStats, validateSyncStats, mergeSyncStats, MAX_SYNC_DAYS } = require(path.join(buildDirectory, 'utils/syncData.js'));
const { DEFAULT_SETTINGS } = require(path.join(buildDirectory, 'utils/storage.js'));
after(() => fs.rmSync(buildDirectory, { recursive: true, force: true }));

const accountId = '0123456789abcdef0123456789abcdef';
const differentAccount = 'abcdef0123456789abcdef0123456789';
const day = (date = '2026-10-20', extra = {}) => ({
  date, breaksCompleted: 2, exercisesCompleted: 1, focusMinutes: 40.5,
  techniqueCounts: { 'donald-korb-blinking': 1 }, ...extra,
});

test('recovery keys use 32 random bytes, canonical base64url and nonextractable AES keys', async () => {
  const secrets = Array.from({ length: 64 }, generateRecoveryKey);
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    assert.equal(Buffer.from(secret, 'base64url').toString('base64url'), secret);
  }
  const key = await deriveSyncKey(secrets[0], accountId);
  assert.equal(key.extractable, false);
  assert.deepEqual(key.algorithm, { name: 'AES-GCM', length: 256 });
  assert.deepEqual(key.usages, ['encrypt', 'decrypt']);
  await assert.rejects(() => webcrypto.subtle.exportKey('raw', key));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(secrets[0].at(-1));
  const noncanonical = secrets[0].slice(0, -1) + alphabet[last + 1];
  for (const invalid of ['', secrets[0] + '=', secrets[0].slice(1), ' ' + secrets[0], noncanonical, null, 42]) {
    await assert.rejects(() => deriveSyncKey(invalid, accountId));
  }
  await assert.rejects(() => deriveSyncKey(secrets[0], 'account:settings'));
});

test('AES-GCM roundtrips JSON and binds the account and message kind', async () => {
  const secret = generateRecoveryKey();
  const key = await deriveSyncKey(secret, accountId);
  const sameKey = await deriveSyncKey(secret, accountId);
  const wrongKey = await deriveSyncKey(generateRecoveryKey(), accountId);
  const otherAccountKey = await deriveSyncKey(secret, differentAccount);
  const payload = { hello: 'Привет', nested: [null, true, { value: 1 }] };
  const envelope = await encryptSync(key, accountId, 'settings', payload);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'v']);
  assert.equal(envelope.v, 1);
  assert.equal(Buffer.from(envelope.iv, 'base64url').length, 12);
  assert.deepEqual(await decryptSync(sameKey, accountId, 'settings', envelope), payload);
  assert.notEqual((await encryptSync(key, accountId, 'settings', payload)).iv, envelope.iv);
  await assert.rejects(() => decryptSync(wrongKey, accountId, 'settings', envelope));
  await assert.rejects(() => decryptSync(otherAccountKey, accountId, 'settings', envelope));
  await assert.rejects(() => decryptSync(key, differentAccount, 'settings', envelope));
  await assert.rejects(() => decryptSync(key, accountId, 'stats', envelope));
  await assert.rejects(() => encryptSync(key, accountId, 'stats:settings', payload));
  for (const field of ['iv', 'ciphertext']) {
    const changed = Buffer.from(envelope[field], 'base64url');
    changed[0] ^= 1;
    await assert.rejects(() => decryptSync(key, accountId, 'settings', { ...envelope, [field]: changed.toString('base64url') }));
  }
});

test('malformed envelopes, invalid JSON, invalid UTF-8 and oversized payloads fail closed', async () => {
  const key = await deriveSyncKey(generateRecoveryKey(), accountId);
  const envelope = await encryptSync(key, accountId, 'stats', []);
  for (const invalid of [null, [], 'x', {}, { ...envelope, v: 2 }, { ...envelope, extra: true },
    { ...envelope, iv: 'A' }, { ...envelope, iv: envelope.iv + '=' }, { ...envelope, ciphertext: 'AA' },
    { ...envelope, ciphertext: '!invalid' }, { ...envelope, ciphertext: 'A'.repeat(700000) }]) {
    await assert.rejects(() => decryptSync(key, accountId, 'stats', invalid));
  }
  await assert.rejects(() => encryptSync(key, accountId, 'stats', undefined));
  await assert.rejects(() => encryptSync(key, accountId, 'stats', 'x'.repeat(MAX_SYNC_PAYLOAD_BYTES - 1)));
  await assert.rejects(() => encryptSync(key, accountId, 'stats', '界'.repeat(Math.ceil(MAX_SYNC_PAYLOAD_BYTES / 3))));
  const maximum = 'x'.repeat(MAX_SYNC_PAYLOAD_BYTES - 2);
  assert.equal(await decryptSync(key, accountId, 'stats', await encryptSync(key, accountId, 'stats', maximum)), maximum);
  for (const plaintext of [new TextEncoder().encode('not json'), Uint8Array.of(0xff), new Uint8Array(MAX_SYNC_PAYLOAD_BYTES + 1)]) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(`blincho-sync:v1:${accountId}:stats`), tagLength: 128 }, key, plaintext);
    await assert.rejects(() => decryptSync(key, accountId, 'stats', {
      v: 1, iv: Buffer.from(iv).toString('base64url'), ciphertext: Buffer.from(ciphertext).toString('base64url'),
    }));
  }
});

test('settings project seven preferences and preserve every local security and consent choice', () => {
  const current = { ...DEFAULT_SETTINGS, notificationsEnabled: false, autoTakeoverModal: false,
    idleDetectionEnabled: false, idleAction: 'reset', idleThresholdMinutes: 7, strictModeIgnoreIdle: true,
    meetingDetectionEnabled: false, meetingHistoryEnabled: true, cameraLockEnabled: true,
    enhancedPresenceEnabled: true, absenceLockEnabled: true, inputActivityEnabled: true,
    localMcpEnabled: true, strictMode: true, futurePrivacySetting: false };
  const original = structuredClone(current);
  const incoming = projectSyncSettings({ ...DEFAULT_SETTINGS, timerPreset: 'pomodoro', workMinutes: 3,
    breakSeconds: 2, soundEnabled: false, soundVolume: 12, theme: 'dark', colorPalette: 'ocean' });
  assert.deepEqual(Object.keys(incoming).sort(), ['breakSeconds', 'colorPalette', 'soundEnabled', 'soundVolume', 'theme', 'timerPreset', 'workMinutes']);
  const applied = applySyncSettings(current, incoming);
  assert.equal(applied.workMinutes, 25);
  assert.equal(applied.breakSeconds, 300);
  assert.equal(applied.soundVolume, 12);
  assert.equal(applied.theme, 'dark');
  for (const key of Object.keys(current).filter(key => !(key in incoming))) assert.equal(applied[key], current[key], key);
  assert.deepEqual(current, original);
  for (const invalid of [null, [], {}, { ...incoming, cameraLockEnabled: false }, { ...incoming, workMinutes: NaN },
    { ...incoming, workMinutes: 0 }, { ...incoming, breakSeconds: 1801 }, { ...incoming, timerPreset: 'other' },
    { ...incoming, soundVolume: Infinity }, { ...incoming, soundEnabled: 1 }, { ...incoming, theme: 'midnight' },
    { ...incoming, colorPalette: 'other' }]) assert.throws(() => applySyncSettings(current, invalid));
});

test('statistics project aggregates and reject malformed or private remote data', () => {
  const privateDay = day('2026-10-20', {
    completedEventIds: ['private-event'], activity: [{ start: 1, end: 2, state: 'work' }],
    meetings: [{ start: 1, end: 2, app: 'private-app' }], inputActivity: [{ start: 1, keyPresses: 2 }],
    inputActivityCursor: { source: 'secret', buckets: [] }, journal: { answer: 'private-answer' },
    techniqueCounts: { 'donald-korb-blinking': 1, 'private-custom-id': 2 },
  });
  const projected = projectSyncStats([privateDay]);
  assert.deepEqual(projected, [day()]);
  for (const value of ['private-event', 'private-app', 'private-answer', 'private-custom-id', 'secret']) assert.ok(!JSON.stringify(projected).includes(value));
  assert.deepEqual(validateSyncStats([day('2024-02-29'), day('0001-01-01'), day('9999-12-31')]).map(item => item.date), ['0001-01-01', '2024-02-29', '9999-12-31']);
  for (const invalid of [null, {}, new Array(1), Array(MAX_SYNC_DAYS + 1).fill(day()), [day(), day()], [day('2025-02-29')],
    [day('2026-04-31')], [day('0000-01-01')], [day('2026-1-01')], [day('2026-10-20', { breaksCompleted: -1 })],
    [day('2026-10-20', { breaksCompleted: 0.5 })], [day('2026-10-20', { exercisesCompleted: 1000001 })],
    [day('2026-10-20', { focusMinutes: Infinity })], [day('2026-10-20', { focusMinutes: 1441 })],
    [day('2026-10-20', { techniqueCounts: { unknown: 1 } })], [day('2026-10-20', { techniqueCounts: { 'donald-korb-blinking': NaN } })],
    [day('2026-10-20', { techniqueCounts: [] })], [day('2026-10-20', { activity: [] })],
    [day('2026-10-20', { meetings: [] })], [JSON.parse('{"date":"2026-10-20","breaksCompleted":0,"exercisesCompleted":0,"focusMinutes":0,"techniqueCounts":{"__proto__":1}}')]]) {
    assert.throws(() => validateSyncStats(invalid));
  }
});

test('merging derives stable additive totals from distinct snapshots and retains local details', () => {
  const local = [day('2026-10-20', { activity: [{ start: 1, end: 2, state: 'work' }],
    completedEventIds: ['local-only'], meetings: [{ start: 1, end: 2, app: 'local-app' }],
    inputActivity: [{ start: 1, keyPresses: 2, clicks: 0, scrolls: 0, mouseMoves: 0 }] })];
  const snapshots = [[day()], [day('2026-10-19'), day('2026-10-20', { focusMinutes: 20.25 })]];
  const savedLocal = structuredClone(local);
  const savedSnapshots = structuredClone(snapshots);
  const merged = mergeSyncStats(local, snapshots);
  assert.deepEqual(merged.map(item => item.date), ['2026-10-19', '2026-10-20']);
  assert.equal(merged[1].breaksCompleted, 6);
  assert.equal(merged[1].exercisesCompleted, 3);
  assert.equal(merged[1].focusMinutes, 101.25);
  assert.equal(merged[1].techniqueCounts['donald-korb-blinking'], 3);
  assert.deepEqual(merged[1].activity, local[0].activity);
  assert.deepEqual(merged[1].meetings, local[0].meetings);
  assert.deepEqual(merged[1].inputActivity, local[0].inputActivity);
  assert.deepEqual(merged[1].completedEventIds, local[0].completedEventIds);
  assert.deepEqual(Object.keys(merged[0]).sort(), ['breaksCompleted', 'date', 'exercisesCompleted', 'focusMinutes', 'techniqueCounts']);
  assert.deepEqual(mergeSyncStats(local, snapshots), merged);
  assert.deepEqual(local, savedLocal);
  assert.deepEqual(snapshots, savedSnapshots);
  merged[1].techniqueCounts['donald-korb-blinking'] = 100;
  assert.deepEqual(local, savedLocal);
  assert.deepEqual(snapshots, savedSnapshots);
  assert.throws(() => mergeSyncStats(local, [[day('2026-10-20', { meetings: [] })]]));
});
