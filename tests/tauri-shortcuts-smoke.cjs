// Explicit packaged macOS smoke. --finder pauses for real Finder open actions.
// Isolated profile, Desktop, LaunchServices identity and ad hoc signed QA bundle.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
if (process.platform !== 'darwin') throw Error('This packaged Finder smoke requires macOS');
const root = path.resolve(__dirname, '..');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-shortcuts-native-')));
// LaunchServices excludes applications in the system temporary directory from
// document handlers. Put only the signed QA bundle in a dedicated recovery folder.
const qaParent = process.env.BLINCHO_SHORTCUT_QA_BUNDLE_DIR || path.join(root, 'recovery');
fs.mkdirSync(qaParent, { recursive: true });
const qaDirectory = fs.mkdtempSync(path.join(qaParent, 'shortcut-finder-qa-'));
const bundle = path.join(qaDirectory, 'Blincho Shortcut QA.app');
const identifier = 'com.myeyes.shortcut.qa' + Date.now();
const source = path.join(directory, 'history.json');
const desktop = path.join(directory, 'desktop');
const phasePath = path.join(directory, 'phase.json');
const pointer = '/private/tmp/blincho-shortcuts-active.json';
const finderMode = process.argv.includes('--finder');
const bundleSource = process.env.BLINCHO_SHORTCUT_BUNDLE || path.join(root, 'release/tauri-macos-debug/Blincho.app');
const helperSource = path.join(directory, 'icon-proof.swift');
const helper = path.join(directory, 'icon-proof');
fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {
  myeyes_settings_v1: JSON.stringify({ idleDetectionEnabled: false, meetingDetectionEnabled: true,
    soundEnabled: false, notificationsEnabled: false, strictMode: false, localMcpEnabled: false }),
  'blincho-language-v1': JSON.stringify({ preference: 'en', acknowledged: true }),
} }), { mode: 0o600 });
fs.mkdirSync(desktop);
fs.cpSync(bundleSource, bundle, { recursive: true });
const executable = path.join(bundle, 'Contents/MacOS/shortcut-qa-launcher');
const c = path.join(directory, 'launcher.c');
fs.writeFileSync(c, `#include <mach-o/dyld.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <string.h>\n#include <limits.h>\nint main(int argc,char**argv){char exe[PATH_MAX];uint32_t size=sizeof(exe);if(_NSGetExecutablePath(exe,&size))return 70;char*slash=strrchr(exe,'/');if(!slash)return 71;strcpy(slash+1,"blincho");setenv("BLINCHO_PROTOTYPE_TEST_DIR",${JSON.stringify(directory)},1);setenv("BLINCHO_PROTOTYPE_HISTORY_SOURCE",${JSON.stringify(source)},1);setenv("BLINCHO_SMOKE_PRESENCE","1",1);setenv("BLINCHO_SMOKE_MEETINGS","1",1);argv[0]=exe;execv(exe,argv);return 72;}\n`);
execFileSync('/usr/bin/clang', [c, '-o', executable]);
const plist = path.join(bundle, 'Contents/Info.plist');
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', identifier, plist]);
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', 'shortcut-qa-launcher', plist]);
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Blincho Shortcut QA', plist]);
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
const verify = () => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
verify();
function hashes(folder) {
  const result = {};
  function visit(current) { for (const item of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, item.name);
    if (item.isDirectory()) visit(file);
    else if (item.isFile()) result[path.relative(folder, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } }
  visit(folder); return result;
}
const before = hashes(bundle);
fs.writeFileSync(helperSource, `import AppKit\nimport CryptoKit\nimport CoreServices\nlet args=CommandLine.arguments\nif args[1]=="handler" { let value=LSCopyDefaultRoleHandlerForContentType("com.myeyes.blincho-shortcut" as CFString, .all); print(value?.takeRetainedValue() as String? ?? "none") } else { let image=NSWorkspace.shared.icon(forFile:args[1]); let data=image.tiffRepresentation!; print(SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()) }\n`);
execFileSync('/usr/bin/swiftc', [helperSource, '-o', helper]);
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
execFileSync(lsregister, ['-f', bundle]);
const defaultHandler = execFileSync(helper, ['handler'], { encoding: 'utf8' }).trim();
let child = spawn(executable, ['--autostart'], { stdio: ['ignore', 'ignore', 'pipe'] });
let output = '', sequence = 0, allowExit = false;
child.stderr.on('data', value => { output += value; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const diagnosticsPath = path.join(directory, 'runtime-diagnostics.json');
const diagnostics = () => JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
async function until(read, predicate = Boolean, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!allowExit && child.exitCode !== null) throw Error('QA app exited: ' + output);
    try { const value = await read(); if (predicate(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(100);
  }
  throw Error('Shortcut smoke timed out: ' + output);
}
async function control(operation, extra = {}) {
  const id = ++sequence;
  fs.writeFileSync(path.join(directory, 'control.tmp'), JSON.stringify({ operation, id, ...extra }), { mode: 0o600 });
  fs.renameSync(path.join(directory, 'control.tmp'), path.join(directory, 'control.json'));
  const value = await until(() => JSON.parse(fs.readFileSync(path.join(directory, 'response.json'), 'utf8')), value => value.id === id);
  assert.equal(value.ok, true, value.error);
}
async function evaluate(expression) {
  const id = ++sequence;
  await control('eval', { script: `(async()=>{try{const result=await (${expression});await window.__TAURI__.core.invoke('renderer_report',{report:{shortcutSmoke:{id:${id},result}}});}catch(error){await window.__TAURI__.core.invoke('renderer_report',{report:{shortcutSmoke:{id:${id},error:String(error)}}});}})();` });
  const value = await until(diagnostics, value => value.renderer?.shortcutSmoke?.id === id);
  assert.equal(value.renderer.shortcutSmoke.error, undefined);
  return value.renderer.shortcutSmoke.result;
}
function phase(stage, extra = {}) {
  const value = { stage, directory, bundle, identifier, defaultHandler, phasePath, ...extra };
  fs.writeFileSync(phasePath, JSON.stringify(value, null, 2)); fs.writeFileSync(pointer, JSON.stringify(value, null, 2));
  console.log(JSON.stringify(value));
}
const keysText = fs.readFileSync(path.join(root, 'src/utils/symbiote.ts'), 'utf8').match(/SYMBIOTE_NAME_KEYS = \[([\s\S]*?)\] as const/)[1];
const keys = [...keysText.matchAll(/'([^']+)'/g)].map(match => match[1]);
function name(mask, language = 'en') {
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/locales', language + '.json'), 'utf8'));
  if (mask === 32) return catalogue['Спутник']; if (mask === 48) return catalogue['Напарник']; if (mask === 63) return catalogue['Блинчиборг'];
  const title = catalogue[keys[mask & 31]]; return mask & 32 ? catalogue['{name} на связи'].replace('{name}', title) : title;
}
(async () => {
  await until(diagnostics, value => value.renderer?.ready && value.symbioteAppearance?.applied === 0);
  const initial = await evaluate('window.electronAPI.getSymbioteShortcutStatus()'); assert.equal(initial.supported, true); assert.equal(initial.exists, false);
  await evaluate(`(()=>{document.querySelector('.nav-settings-button').click();return true;})()`);
  await until(() => evaluate(`Boolean(document.querySelector('[data-shortcut-create]'))`));
  await evaluate(`(()=>{document.querySelector('[data-shortcut-create]').click();return true;})()`);
  let status = await until(() => evaluate('window.electronAPI.getSymbioteShortcutStatus()'), value => value.exists);
  const fileIdentity = fs.statSync(status.path).ino;
  const icons = new Set();
  for (let mask = 0; mask < 64; mask++) {
    status = await evaluate(`(async()=>{await window.electronAPI.setSymbioteBuild(${mask});return window.electronAPI.syncSymbioteShortcut(${mask},${JSON.stringify(name(mask))});})()`);
    assert.equal(status.exists, true); assert.equal(path.dirname(status.path), desktop);
    assert.equal(path.basename(status.path), (mask ? 'Blincho · ' + name(mask) : 'Blincho') + '.blincho');
    assert.equal(fs.statSync(status.path).ino, fileIdentity);
    icons.add(execFileSync(helper, [status.path], { encoding: 'utf8' }).trim());
    assert.equal(fs.readdirSync(desktop).filter(file => !file.startsWith('.')).length, 1);
  }
  assert.equal(icons.size, 64, 'macOS must read all 64 distinct portraits');
  for (const language of fs.readdirSync(path.join(root, 'src/i18n/locales')).map(file => file.replace(/\.json$/, ''))) {
    status = await evaluate(`window.electronAPI.syncSymbioteShortcut(63,${JSON.stringify(name(63, language))})`);
    assert.equal(path.basename(status.path), 'Blincho · ' + name(63, language) + '.blincho');
  }
  for (const value of [{ mask: 64, name: 'bad' }, { mask: '63', name: 'bad' }, { mask: 1, name: 'bad\nname' }, { mask: 1, name: 'x', path: '/tmp/file' }]) {
    assert.equal(await evaluate(`window.__TAURI__.core.invoke('sync_symbiote_shortcut',{selection:${JSON.stringify(value)}}).then(()=>false,()=>true)`), true);
  }
  fs.unlinkSync(status.path);
  status = await evaluate(`window.electronAPI.syncSymbioteShortcut(63,${JSON.stringify(name(63))})`); assert.equal(status.exists, false);
  status = await evaluate(`window.electronAPI.createSymbioteShortcut(63,${JSON.stringify(name(63))})`); assert.equal(status.exists, true);
  const collision = path.join(desktop, 'Blincho · Collision.blincho'); fs.writeFileSync(collision, 'foreign');
  assert.equal(await evaluate(`window.electronAPI.syncSymbioteShortcut(1,'Collision').then(()=>false,()=>true)`), true);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'foreign'); fs.unlinkSync(collision);
  status = await evaluate(`window.electronAPI.syncSymbioteShortcut(63,${JSON.stringify(name(63))})`);
  // Exercise the real JXA/AppKit bridge too; fake-OS unit tests cannot detect
  // JavaScript null being bridged to NSNull instead of an Objective-C nil image.
  const electronDesktop = path.join(directory, 'electron-desktop');
  const electronProfile = path.join(directory, 'electron-profile');
  fs.mkdirSync(electronDesktop); fs.mkdirSync(electronProfile);
  const { createShortcutController } = require('../electron/desktopShortcuts.cjs');
  const electron = createShortcutController({
    app: { isPackaged: true, getAppPath: () => root,
      getPath: kind => ({ desktop: electronDesktop, userData: electronProfile })[kind] },
    shell: {},
    // Approved assets are already 256 pixels; test the actual platform helper.
    nativeImage: { createFromPath: file => ({ isEmpty: () => false,
      resize: () => ({ toPNG: () => fs.readFileSync(file) }) }) },
  });
  const electronIcons = new Set();
  for (const mask of [63, 0]) {
    const result = await electron.create({ mask, name: name(mask) });
    assert.equal(result.error, undefined); assert.equal(result.exists, true);
    assert.equal(await electron.isShortcutFile(result.path), true);
    electronIcons.add(execFileSync(helper, [result.path], { encoding: 'utf8' }).trim());
    assert.equal(fs.readdirSync(electronDesktop).filter(file => !file.startsWith('.')).length, 1);
  }
  assert.equal(electronIcons.size, 2, 'Electron AppKit helper must apply distinct actual icons');
  verify(); assert.deepEqual(hashes(bundle), before);
  if (finderMode) {
    await evaluate('window.electronAPI.showSymbioteShortcut()');
    const warmBefore = diagnostics().events.filter(event => event.source === 'shortcut-open').length;
    phase('finder-warm-ready', { shortcut: status.path, pid: diagnostics().pid, warmBefore });
    await until(() => fs.existsSync(path.join(directory, 'finder-warm-done')), Boolean, 300000);
    const warm = await until(diagnostics, value => value.events.filter(event => event.source === 'shortcut-open').length > warmBefore && value.visible && !value.minimized);
    assert.equal(warm.pid, child.pid, 'Finder must reuse the already running app');
    allowExit = true; await control('quit'); await until(() => child.exitCode !== null);
    fs.unlinkSync(diagnosticsPath);
    phase('finder-cold-ready', { shortcut: status.path });
    await until(() => fs.existsSync(path.join(directory, 'finder-cold-done')), Boolean, 300000);
    const cold = await until(diagnostics, value => value.renderer?.ready && value.events.some(event => event.source === 'shortcut-open') && value.visible && !value.minimized);
    assert.notEqual(cold.pid, child.pid);
    verify(); assert.deepEqual(hashes(bundle), before);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, masks: 64, locales: 30, finderWarm: true, finderCold: true, signatureValid: true, bundleBytesUnchanged: true, coldPid: cold.pid }, null, 2));
    phase('passed', { shortcut: status.path });
  } else phase('api-passed', { shortcut: status.path, finderWarm: false, finderCold: false });
})().catch(error => { console.error(error); phase('failed', { error: String(error), output }); process.exitCode = 1; }).finally(async () => {
  allowExit = true;
  try { if (fs.existsSync(diagnosticsPath)) await control('quit'); } catch { if (child.exitCode === null) child.kill(); }
  try { execFileSync(lsregister, ['-u', bundle]); } catch {}
});
