const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

async function finishBreak(h) {
  await h.settle();
  await h.advance(1000);
  assert(h.active.has('BreakOverlay'));
  const elapsed = h.captured.BreakOverlay.onElapsed;
  await h.advance(20_000);
  await elapsed(h.monotonicNow);
  await h.settle();
}

test('camera call: post-break capture skips active or unknown meetings independently of postponement', async () => {
  for (const meetingDetectionEnabled of [false, true]) {
    for (const status of [{ supported: true, inMeeting: true }, { supported: false, inMeeting: false }]) {
      const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60, cameraLockEnabled: true, meetingDetectionEnabled });
      let cameras = 0;
      h.desktopAPI.lockComputer = async () => false;
      h.setCameraCheck(async () => { cameras++; return 'present'; });
      try {
        await h.advance(1000);
        assert(h.active.has('BreakOverlay'));
        const elapsed = h.captured.BreakOverlay.onElapsed;
        h.desktopAPI.checkMeetingActive = async () => status;
        await h.advance(20_000);
        await elapsed(h.monotonicNow);
        await h.settle();
        assert.equal(cameras, 0, JSON.stringify({ meetingDetectionEnabled, status }));
      } finally { h.destroy(); }
    }
  }
});

test('camera call: input during the pre-capture meeting probe prevents late acquisition', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60, cameraLockEnabled: true });
  let release, cameras = 0;
  h.desktopAPI.lockComputer = async () => false;
  h.setCameraCheck(async () => { cameras++; return 'present'; });
  try {
    h.desktopAPI.checkMeetingActive = () => new Promise(resolve => { release = resolve; });
    await finishBreak(h);
    assert(release, 'camera waits for a fresh meeting probe');
    assert.equal(cameras, 0);
    await h.emit('mousemove', { movementX: 1, movementY: 0 });
    release({ supported: true, inMeeting: false });
    await h.settle();
    assert.equal(cameras, 0);
  } finally { h.destroy(); }
});

test('camera call: legacy call observation aborts post-break capture and prevents locking', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 60, cameraLockEnabled: true, meetingDetectionEnabled: false });
  let signal, release, locks = 0;
  h.desktopAPI.lockComputer = async () => { locks++; return true; };
  h.setCameraCheck(value => { signal = value; return new Promise(resolve => { release = resolve; }); });
  try {
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    await finishBreak(h);
    assert(signal);
    h.desktopAPI.checkMeetingActive = async () => ({ supported: true, inMeeting: true });
    await h.advance(1000);
    assert.equal(signal.aborted, true);
    release('absent');
    await h.settle();
    assert.equal(locks, 0);
  } finally { h.destroy(); }
});

test('camera call: final meeting check prevents locking after a completed observation', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 1 / 60, cameraLockEnabled: true });
  let locks = 0;
  h.desktopAPI.lockComputer = async () => { locks++; return true; };
  h.setCameraCheck(async () => {
    h.desktopAPI.checkMeetingActive = async () => ({ supported: true, inMeeting: true });
    return 'absent';
  });
  try {
    await finishBreak(h);
    assert.equal(locks, 0);
  } finally { h.destroy(); }
});

async function nativeHarness({ deferredBegin = false } = {}) {
  const previous = window.__TAURI__;
  let snapshot, ticks = 0, h, releaseBegin;
  const state = { meeting: false, cameras: 0, finishCalls: 0 };
  window.__TAURI__ = { core: { async invoke(command, args) {
    if (command === 'configure_timer') snapshot = { ...args.input, reasons: [], focusByDate: {}, activitySpans: [], meetingSpans: [], meetingApplications: [], absenceEpoch: 0, absentSince: null, idleSeconds: 61, locked: false, suspended: false, breakElapsed: false, breakEndAt: null, meetingHistoryEpoch: 0, meetingPostponedEpoch: 0 };
    if (command === 'configure_timer' || command === 'timer_snapshot') return { ...snapshot, tickCount: ++ticks, presenceEpoch: state.epoch ?? (state.meeting ? 2 : 1), liveMeetingStatus: { supported: true, inMeeting: state.meeting, applications: state.meeting ? ['Zoom'] : [] } };
    if (command === 'presence_check_begin') {
      if (deferredBegin) return new Promise(resolve => { releaseBegin = () => resolve({ epoch: 1, startedAt: h.now }); });
      return { epoch: 1, startedAt: h.now };
    }
    if (command === 'presence_check_finish') { state.finishCalls++; return { accepted: false, locked: false }; }
  } } };
  h = createHarness({ enhancedPresenceEnabled: true, absenceLockEnabled: false, cameraLockEnabled: false });
  h.setCameraCheck(signal => { state.cameras++; state.signal = signal; return new Promise(resolve => { state.releaseCamera = resolve; }); });
  await h.settle();
  return { h, state, releaseBegin: () => releaseBegin?.(), destroy() { h.destroy(); if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous; } };
}

test('camera call: native call snapshot aborts enhanced capture without submitting its result', async () => {
  const n = await nativeHarness();
  try {
    await n.h.advance(1000);
    assert(n.state.signal);
    n.state.meeting = true;
    await n.h.advance(1000);
    assert.equal(n.state.signal.aborted, true);
    n.state.releaseCamera('present');
    await n.h.settle();
    assert.equal(n.state.finishCalls, 0);
  } finally { n.destroy(); }
});

test('camera call: delayed native permission token cannot start capture after call detection', async () => {
  const n = await nativeHarness({ deferredBegin: true });
  try {
    await n.h.advance(1000);
    n.state.meeting = true;
    await n.h.advance(1000);
    n.releaseBegin();
    await n.h.settle();
    assert.equal(n.state.cameras, 0);
  } finally { n.destroy(); }
});

test('camera call: native epoch invalidation cancels a check even if the call already ended', async () => {
  const n = await nativeHarness();
  try {
    await n.h.advance(1000);
    assert(n.state.signal);
    n.state.epoch = 2;
    await n.h.advance(1000);
    assert.equal(n.state.signal.aborted, true);
    n.state.releaseCamera('absent');
    await n.h.settle();
    assert.equal(n.state.finishCalls, 0);
  } finally { n.destroy(); }
});


test('camera call: same-tick native evidence gates post-break acquisition', async () => {
  for (const inMeeting of [false, true]) {
    const previous = window.__TAURI__;
    let snapshot, ticks = 0, lastReadTick = 0, checks = 0, armed = false;
    window.__TAURI__ = { core: { async invoke(command, args) {
      if (command === 'configure_timer') snapshot = { ...args.input, reasons: [], focusByDate: {},
        absenceEpoch: 0, absentSince: null, idleSeconds: 0, locked: false, suspended: false,
        breakElapsed: false, breakEndAt: null };
      if (command === 'timer_snapshot' && !armed) lastReadTick = ++ticks;
      if (command === 'configure_timer' || command === 'timer_snapshot') return {
        ...snapshot, tickCount: command === 'configure_timer' ? ++ticks : lastReadTick,
        presenceEpoch: 1, liveMeetingStatus: { supported: true, inMeeting: armed && inMeeting },
      };
    } } };
    const h = createHarness({ cameraLockEnabled: true });
    h.setCameraCheck(async () => { checks++; return 'present'; });
    h.desktopAPI.lockComputer = async () => false;
    h.desktopAPI.checkMeetingActive = async () => { armed = true; return { supported: true, inMeeting: false }; };
    try {
      await h.settle();
      await h.call('TimerWidget', 'onTriggerInstantBreak');
      snapshot = { ...snapshot, breakElapsed: true, breakEndAt: h.now };
      await h.advance(1000);
      assert.equal(armed, true, 'fresh negative call probe completes before the native call observation');
      assert.equal(checks, inMeeting ? 0 : 1, 'same tick must permit the negative control and reject a current call');
    } finally {
      h.destroy();
      if (previous === undefined) delete window.__TAURI__; else window.__TAURI__ = previous;
    }
  }
});

test('camera call: system input during the final meeting probe prevents locking', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 60, cameraLockEnabled: true });
  let probes = 0, release, locks = 0;
  h.desktopAPI.checkMeetingActive = async () => {
    if (++probes === 2) return new Promise(resolve => { release = resolve; });
    return { supported: true, inMeeting: false };
  };
  h.desktopAPI.lockComputer = async () => { locks++; return true; };
  h.setCameraCheck(async () => 'absent');
  try {
    h.setIdle(30);
    await h.call('TimerWidget', 'onTriggerInstantBreak');
    await finishBreak(h);
    assert(release, 'final fresh meeting probe is pending');
    await h.advance(100);
    h.setIdle(0);
    release({ supported: true, inMeeting: false });
    await h.settle();
    assert.equal(locks, 0, 'new system input must invalidate absence while the meeting probe was pending');
  } finally { h.destroy(); }
});
