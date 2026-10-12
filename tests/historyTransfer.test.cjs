const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-history-import-'));
const config = path.join(output, 'tsconfig.json');
fs.writeFileSync(config, JSON.stringify({ files: [path.join(repo, 'src/utils/historyTransfer.ts')], compilerOptions: {
  target: 'ES2022', module: 'commonjs', rootDir: path.join(repo, 'src/utils'), outDir: output, skipLibCheck: true
} }));
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { stdio: 'inherit' });
const { importHistorySnapshot, validateHistorySnapshot } = require(path.join(output, 'historyTransfer.js'));
function storage(fail) {
  const map = new Map(); let writes = 0;
  return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null, removeItem: key => map.delete(key),
    setItem(key, value) { if (++writes === fail) throw new Error('quota'); map.set(key, value); } };
}
const snapshot = { schemaVersion: 1, exportedAt: '2026-10-12T12:00:00Z', entries: {
  myeyes_settings_v1: '{"workMinutes":20}', myeyes_stats_v1: '[{"date":"2026-10-11","breaksCompleted":4}]',
  myeyes_cvs_result_v1: '{"score":9,"date":"2026-10-11"}', 'blincho-language-v1': '{"preference":"ru"}' } };
const s = storage(); s.setItem('foreign', 'preserved');
assert.equal(importHistorySnapshot(s, snapshot).status, 'imported');
for (const [key, value] of Object.entries(snapshot.entries)) assert.equal(s.getItem(key), value);
s.setItem('myeyes_stats_v1', '[{"date":"2026-10-12","breaksCompleted":5}]');
assert.equal(importHistorySnapshot(s, snapshot).status, 'already-imported');
assert.equal(importHistorySnapshot(s, null).status, 'already-imported', 'committed profiles can skip reading any old export');
assert(s.getItem('myeyes_stats_v1').includes('2026-10-12')); assert.equal(s.getItem('foreign'), 'preserved');
const existing = storage(); existing.setItem('myeyes_stats_v1', '[]');
assert.equal(importHistorySnapshot(existing, snapshot).status, 'existing-profile'); assert.equal(existing.getItem('myeyes_stats_v1'), '[]');
assert.equal(importHistorySnapshot(existing, null).status, 'existing-profile', 'existing data does not depend on a legacy source');
const failed = storage(3); assert.throws(() => importHistorySnapshot(failed, snapshot), /quota/); assert.equal(failed.length, 0);
const crashed = storage(); crashed.setItem('myeyes_tauri_import_pending_v1', '["myeyes_settings_v1"]'); crashed.setItem('myeyes_settings_v1', 'partial');
assert.equal(importHistorySnapshot(crashed, snapshot).status, 'imported'); assert.equal(crashed.getItem('myeyes_settings_v1'), snapshot.entries.myeyes_settings_v1);
assert.throws(() => validateHistorySnapshot({ ...snapshot, schemaVersion: 2 }));
assert.throws(() => validateHistorySnapshot({ ...snapshot, entries: { foreign: 'secret' } }));
assert.throws(() => validateHistorySnapshot({ ...snapshot, entries: { myeyes_stats_v1: 'broken JSON' } }));
assert.throws(() => validateHistorySnapshot({ ...snapshot, entries: { myeyes_tauri_import_v1: '{}' } }));
assert.equal(importHistorySnapshot(storage(), null).status, 'no-export');
console.log('Passed history import: fidelity, idempotency, existing data, quota rollback, interrupted transaction and invalid exports.');
