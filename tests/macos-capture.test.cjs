const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('macOS passive capture scan distinguishes inactivity, active devices and incomplete observations', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blincho-capture-test-'));
  try {
    const binary = path.join(directory, 'capture-test');
    execFileSync('clang', ['-fobjc-arc', '-Wall', '-Wextra', '-Werror', path.join(__dirname, 'native/macos-capture-fixture.m'), '-o', binary], { stdio: 'pipe' });
    execFileSync(binary, [], { stdio: 'pipe' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
