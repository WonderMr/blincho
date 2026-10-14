const { execFile } = require('node:child_process');
const path = require('node:path');

// The direct macOS entry point is private and can disappear in a future OS.
// Match the native Tauri path and confirm the lock, never substitute display sleep.
// https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/caffeinate/libcaffeinate.m
const MAC_LOCK_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('CoreGraphics');
var framework = $.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/login.framework');
if (framework.isNil() || !framework.load) throw Error('The macOS session lock API is unavailable');
ObjC.bindFunction('SACLockScreenImmediate', ['void', []]);
$.SACLockScreenImmediate();
var locked = false;
for (var attempt = 0; attempt < 60; attempt++) {
  var state = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());
  if (state && state.CGSSessionScreenIsLocked === true) { locked = true; break; }
  $.NSThread.sleepForTimeInterval(0.05);
}
if (!locked) throw Error('The computer lock could not be confirmed');
'locked';
`;

// LockWorkStation has no rundll32-compatible entry point. Invoke the documented
// BOOL API directly and preserve its failure; Electron then confirms lock state.
// https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation
const WINDOWS_LOCK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BlinchoSessionLock { [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool LockWorkStation(); }'
if (-not [BlinchoSessionLock]::LockWorkStation()) { throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
`;

function runCommand(execute, file, args, timeout = 6000) {
  return new Promise((resolve, reject) => {
    execute(file, args, { timeout, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, shell: false },
      (error, stdout) => error ? reject(error) : resolve(String(stdout || '').trim()));
  });
}

function createComputerLocker({ execute = execFile, platform = process.platform, env = process.env,
  confirmed = async () => false, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let pending = null;
  const linuxSession = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(env.XDG_SESSION_ID || '') ? env.XDG_SESSION_ID : null;
  const lockConfirmed = platform === 'linux' ? async () => {
    const state = await runCommand(execute, '/usr/bin/loginctl', ['show-session', linuxSession || 'auto', '--property=LockedHint', '--no-pager'], 1000);
    return state === 'LockedHint=yes';
  } : confirmed;
  const request = async () => {
    if (env.BLINCHO_PROTOTYPE_TEST_DIR !== undefined) throw Error('Computer locking is disabled in test profiles');
    if (platform === 'darwin') {
      const result = await runCommand(execute, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_LOCK_SCRIPT]);
      if (result !== 'locked') throw Error('The computer lock could not be confirmed');
      return true;
    }
    if (platform === 'win32') {
      const root = env.SystemRoot || 'C:\\Windows';
      if (!/^[A-Za-z]:\\[^\0\r\n]*$/.test(root) || root.includes('..')) throw Error('Invalid Windows system directory');
      await runCommand(execute, path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOCK_SCRIPT]);
    } else if (platform === 'linux') {
      // Omitting the ID asks logind to lock the caller's own session.
      await runCommand(execute, '/usr/bin/loginctl', ['lock-session', ...(linuxSession ? [linuxSession] : [])]);
    } else {
      throw Error('Computer locking is unavailable on this platform');
    }
    const deadline = now() + 3000;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if (await lockConfirmed() === true) return true; } catch { /* Unknown state is not success. */ }
      if (now() >= deadline) break;
      await wait(50);
    }
    throw Error('The computer lock could not be confirmed');
  };
  return () => {
    if (!pending) pending = request().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createComputerLocker };
