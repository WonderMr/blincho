const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function launch(platform, env) {
  let call;
  const process = { platform, env, execPath: 'C:\\Program Files\\nodejs\\node.exe' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/start-desktop.cjs'), 'utf8'), {
    process, console,
    require: name => {
      assert.equal(name, 'node:child_process');
      return { spawn: (...args) => { call = args; return { on() {} }; } };
    },
  });
  return call;
}

test('desktop launcher invokes npm JS directly on all platforms, including paths with spaces', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const [command, args, options] = launch(platform, { npm_execpath: npmCli });
    assert.equal(command, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(Array.from(args), [npmCli, 'run', 'tauri:dev']);
    assert.equal(options.shell, false);
  }
});

test('bare Windows launcher uses cmd for npm command files and Unix uses npm', () => {
  const [command, args] = launch('win32', {});
  assert.equal(command, 'cmd.exe');
  assert.deepEqual(Array.from(args), ['/d', '/s', '/c', 'npm run tauri:dev']);
  assert.equal(launch('linux', {})[0], 'npm');
});
