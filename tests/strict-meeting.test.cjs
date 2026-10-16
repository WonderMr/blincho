const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./app.test.cjs');

function recordPresentation(h) {
  const calls = [];
  for (const name of ['setBreakFullscreen', 'bringToFront', 'setStrictLock']) {
    h.electronAPI[name] = value => calls.push([name, value]);
  }
  return calls;
}

test('active calls repeatedly postpone strict expiry, then present a strict break after call end', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05, strictMode: true, meetingDetectionEnabled: true });
  try {
    let inMeeting = true;
    let probes = 0;
    h.electronAPI.checkMeetingActive = async () => { probes++; return { inMeeting, supported: true }; };
    const presentation = recordPresentation(h);
    await h.settle();
    await h.advance(4000);
    assert.equal(h.active.has('BreakOverlay'), false, 'an active call must postpone the strict break');
    assert.equal(probes, 1);
    assert.equal(h.captured.TimerWidget.phase, 'work');
    assert.equal(h.captured.TimerWidget.secondsRemaining, 299);
    assert.equal(presentation.length, 0, 'postponement cannot acquire desktop presentation');
    await h.advance(300000);
    assert.equal(probes, 2, 'the active call is checked again at the postponed deadline');
    assert.equal(h.active.has('BreakOverlay'), false);
    assert.equal(h.captured.TimerWidget.secondsRemaining, 299);
    assert.equal(presentation.length, 0);
    inMeeting = false;
    await h.advance(300000);
    assert.equal(probes, 3);
    assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.deepEqual(presentation.map(([name]) => name), ['setBreakFullscreen', 'bringToFront', 'setStrictLock']);
    assert.equal(presentation[0][1], true);
    assert.equal(presentation[1][1].alwaysOnTop, true);
    assert.equal(presentation[2][1], true);
    assert.equal(h.stats().breaksCompleted, 0);
  } finally { h.destroy(); }
});

test('disabled meeting postponement still presents a strict break during a call', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05, strictMode: true, meetingDetectionEnabled: false });
  try {
    let probes = 0;
    h.electronAPI.checkMeetingActive = async () => { probes++; return { inMeeting: true, supported: true }; };
    const presentation = recordPresentation(h);
    await h.settle();
    await h.advance(4000);
    assert.equal(probes, 0, 'disabled postponement cannot issue a meeting probe');
    assert.equal(h.active.has('BreakOverlay'), true);
    assert.equal(presentation.find(([name]) => name === 'setStrictLock')[1], true);
  } finally { h.destroy(); }
});

test('disabling postponement while a strict expiry probe is pending ignores the active result', async () => {
  const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05, strictMode: true, meetingDetectionEnabled: true });
  try {
    let resolveMeeting;
    h.electronAPI.checkMeetingActive = () => new Promise(resolve => { resolveMeeting = resolve; });
    const presentation = recordPresentation(h);
    await h.settle();
    await h.advance(3000);
    assert(resolveMeeting, 'strict expiry must wait for meeting detection');
    await h.call('Navbar', 'onOpenSettings');
    await h.call('SettingsModal', 'onUpdateSettings', { ...h.settings, meetingDetectionEnabled: false });
    resolveMeeting({ inMeeting: true, supported: true });
    await h.settle();
    assert.equal(h.active.has('BreakOverlay'), true, 'the latest disabled policy must allow the strict break');
    assert.equal(h.captured.TimerWidget.phase, 'break');
    assert.equal(presentation.find(([name]) => name === 'setStrictLock')[1], true);
  } finally { h.destroy(); }
});

test('stale active meeting results cannot postpone a reset or absent strict session', async () => {
  for (const change of ['reset', 'lock']) {
    const h = createHarness({ timerPreset: 'custom', workMinutes: 0.05, strictMode: true, meetingDetectionEnabled: true });
    try {
      let resolveMeeting;
      h.electronAPI.checkMeetingActive = () => new Promise(resolve => { resolveMeeting = resolve; });
      const presentation = recordPresentation(h);
      await h.settle();
      await h.advance(3000);
      assert(resolveMeeting, 'strict expiry must reach its meeting probe');
      if (change === 'reset') await h.call('TimerWidget', 'onReset');
      else await h.power('lock-screen');
      const remaining = h.captured.TimerWidget.secondsRemaining;
      resolveMeeting({ inMeeting: true, supported: true });
      await h.settle();
      await h.advance(1000);
      assert.equal(h.captured.TimerWidget.secondsRemaining, remaining, `${change} cannot accept a stale five-minute postponement`);
      assert.equal(h.captured.TimerWidget.phase, change === 'reset' ? 'manual' : 'locked');
      assert.equal(h.active.has('BreakOverlay'), false);
      assert.equal(presentation.length, 0);
      assert.equal(h.notifications, 0, 'stale detection cannot announce a postponed break');
    } finally { h.destroy(); }
  }
});
