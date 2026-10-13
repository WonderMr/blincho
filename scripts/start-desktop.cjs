const { spawn } = require('node:child_process');
// npm supplies its JS entry point when running this script, avoiding .cmd
// execution and shell quoting on Windows, including Node paths with spaces.
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const args = npmCli ? [npmCli, 'run', 'tauri:dev'] : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run tauri:dev'] : ['run', 'tauri:dev'];
const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
