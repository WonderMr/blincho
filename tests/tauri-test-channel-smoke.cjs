// Verify the real channel identity without the prototype singleton override.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const payload = { darwin: 'Blincho Test.app/Contents/MacOS/blincho', win32: 'Blincho Test.exe', linux: 'Blincho-Test.AppImage' }[process.platform];
if (!payload) throw new Error('Unsupported native test platform');
const build = JSON.parse(fs.readFileSync(path.join(root, 'release/test-channel/BUILD.json'), 'utf8'));
const digest = createHash('sha256').update(fs.readFileSync(path.join(root, 'release/test-channel', payload))).digest('hex');
assert.equal(digest, process.platform === 'linux' ? build.appImageSha256 : build.packagedBinarySha256);
assert.equal(build.identifier, 'com.myeyes.test');
assert.equal(build.dirty, false, 'Native delivery smoke requires a committed build');
const data = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
  : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
const profile = path.join(data, 'com.myeyes.test');
const report = path.join(profile, 'runtime-diagnostics.json');
const env = { ...process.env, BLINCHO_DIAGNOSTICS: '1' };
delete env.BLINCHO_PROTOTYPE_TEST_DIR;
delete env.BLINCHO_PROTOTYPE_HISTORY_SOURCE;
const started = Date.now();
const child = spawn(path.join(root, 'release/test-channel', payload),
  [...(process.platform === 'linux' ? ['--appimage-extract-and-run'] : []), '--autostart'],
  { env, stdio: ['ignore', 'ignore', 'pipe'] });
let launchError;
child.on('error', error => { launchError = error; });
child.stderr.on('data', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    let value;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Test app exited early: ${child.exitCode}`);
      try {
        if (fs.statSync(report).mtimeMs >= started) {
          const current = JSON.parse(fs.readFileSync(report, 'utf8'));
          if (current.renderer?.ready && current.identifier === 'com.myeyes.test') { value = current; break; }
        }
      } catch (error) { if (!['ENOENT'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
      await sleep(100);
    }
    assert.ok(value, 'Test channel did not report readiness');
    assert.equal(value.productName, 'Blincho Test');
    assert.equal(value.testChannel, true);
    assert.equal(path.resolve(value.profile), profile);
    assert.equal(path.resolve(value.webviewStorage), profile);
    assert.equal(path.resolve(value.sourceExport), path.join(profile, 'legacy-import-disabled.json'));
    assert.equal(value.autostart.managed, false);
    assert.equal(value.updates.checkSupported, false);
    assert.equal(value.strict, false);
    console.log(JSON.stringify({ status: 'passed', identifier: value.identifier, productName: value.productName,
      profileIsSeparate: true, explicitWebviewStore: true, legacyImportDisabled: true,
      autostartManaged: false, stableUpdateChecks: false, prototypeOverrideUsed: false }));
  } finally {
    if (child.exitCode === null) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
