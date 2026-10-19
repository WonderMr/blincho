const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('rolldown/utils');
const file = path.join(__dirname, '../src/utils/cameraActivity.ts');
const code = transformSync(file, fs.readFileSync(file, 'utf8')).code.replace(/^import .*;\n/gm, '').replace(/export (const|function) /g, '$1 ');
const scope = { exports: {} };
vm.runInNewContext(code + '\nmodule.exports = { createCameraActivityReporter };', { module: scope, console: { warn() {} }, subscribeLanguage() {} });
const { createCameraActivityReporter } = scope.exports;
function stream(count = 1) {
  const tracks = Array.from({ length: count }, () => {
    const listeners = new Set();
    return { kind: 'video', readyState: 'live', muted: true,
      addEventListener(_event, callback) { listeners.add(callback); }, removeEventListener(_event, callback) { listeners.delete(callback); },
      stop() { this.readyState = 'ended'; }, end() { this.stop(); for (const callback of [...listeners]) callback(); },
      get listeners() { return listeners.size; },
    };
  });
  return { getVideoTracks: () => tracks, getTracks: () => tracks, tracks };
}
test('overlapping live owners remain visible until the final release, including muted tracks', async () => {
  const events = [], reporter = createCameraActivityReporter(value => events.push(value));
  const a = stream(2), b = stream();
  const releaseA = reporter.trackStream(a), releaseB = reporter.trackStream(b);
  await reporter.settled(); assert.deepEqual(events, [true]);
  a.tracks[0].end(); await reporter.settled(); assert.deepEqual(events, [true]);
  a.tracks[1].end(); releaseA(); await reporter.settled(); assert.deepEqual(events, [true]);
  releaseB(); releaseB(); await reporter.settled(); assert.deepEqual(events, [true, false]);
  assert.equal(a.tracks[0].listeners + a.tracks[1].listeners + b.tracks[0].listeners, 0);
});
test('a cancelled late stream and repeated old cleanup cannot hide another capture', async () => {
  const events = [], reporter = createCameraActivityReporter(value => events.push(value));
  const current = stream(), releaseCurrent = reporter.trackStream(current);
  const late = stream(), releaseLate = reporter.trackStream(late);
  late.tracks[0].stop(); releaseLate(); releaseLate();
  await reporter.settled(); assert.deepEqual(events, [true]);
  current.tracks[0].stop(); releaseCurrent(); await reporter.settled(); assert.deepEqual(events, [true, false]);
});
test('empty or already ended streams never activate the camera badge', async () => {
  const events = [], reporter = createCameraActivityReporter(value => events.push(value));
  const ended = stream(); ended.tracks[0].stop();
  reporter.trackStream(stream(0))(); reporter.trackStream(ended)();
  await reporter.settled(); assert.deepEqual(events, []);
});
test('slow and rejected native delivery preserves all transition order and recovers', async () => {
  const events = []; let finish;
  const reporter = createCameraActivityReporter(value => {
    events.push(value);
    if (events.length === 1) return new Promise(resolve => { finish = resolve; });
    if (events.length === 2) throw Error('native unavailable');
  });
  const release = reporter.trackStream(stream()); await Promise.resolve();
  release(); reporter.trackStream(stream());
  assert.deepEqual(events, [true]); finish(); await reporter.settled();
  assert.deepEqual(events, [true, false, true]);
});
test('page teardown stops every owned stream and clears the badge without a timeout', async () => {
  const events = [], reporter = createCameraActivityReporter(value => events.push(value));
  const a = stream(2), b = stream(); reporter.trackStream(a); reporter.trackStream(b);
  await reporter.settled(); reporter.stopAll(); reporter.stopAll(); await reporter.settled();
  assert.deepEqual(events, [true, false]);
  assert([...a.tracks, ...b.tracks].every(track => track.readyState === 'ended' && track.listeners === 0));
});
test('a language change refreshes an active label without creating a false inactive state', async () => {
  const events = [], reporter = createCameraActivityReporter(value => events.push(value));
  reporter.refresh(); await reporter.settled(); assert.deepEqual(events, []);
  const release = reporter.trackStream(stream()); reporter.refresh(); await reporter.settled();
  assert.deepEqual(events, [true, true]); release(); await reporter.settled(); assert.deepEqual(events, [true, true, false]);
});
