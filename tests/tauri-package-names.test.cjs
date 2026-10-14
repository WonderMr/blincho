const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

test('package smoke launches existing historical and descriptive payloads on every native target without GUI', async t => {
  const { artifactName } = await import('../scripts/release-lib.mjs');
  for (const version of ['1.6.0', '1.6.1']) for (const platform of ['macos', 'windows', 'linux']) for (const arch of ['x64', 'arm64']) await t.test(`${version}/${platform}/${arch}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blincho-package-name-smoke-'));
    try {
      for (const folder of ['tests', 'scripts', 'release-upload']) await fs.mkdir(path.join(directory, folder));
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
      await fs.copyFile(path.join(__dirname, 'tauri-package-smoke.cjs'), path.join(directory, 'tests/tauri-package-smoke.cjs'));
      await fs.copyFile(path.join(__dirname, '../scripts/release-lib.mjs'), path.join(directory, 'scripts/release-lib.mjs'));
      await fs.writeFile(path.join(directory, 'tests/tauri-cross-platform-smoke.cjs'), 'throw new Error("Real GUI smoke must never run in this fixture");');
      const target = platform === 'macos' ? 'zip' : platform === 'windows' ? 'portable' : 'AppImage';
      const name = artifactName(version, platform, arch, target);
      await fs.writeFile(path.join(directory, 'release-upload', name), 'synthetic verified payload');
      const mock = path.join(directory, 'mock.mjs');
      await fs.writeFile(mock, `
        import fs from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const hostTmpdir = os.tmpdir(); os.tmpdir = () => hostTmpdir;
        Object.defineProperty(process, 'platform', { value: ${JSON.stringify({macos:'darwin',windows:'win32',linux:'linux'}[platform])} });
        Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
        cp.execFileSync = (command, args, options) => {
          if (command === '/usr/bin/ditto') {
            if (path.basename(args[2]) !== ${JSON.stringify(name)}) throw new Error('Wrong macOS download selected');
            fs.accessSync(args[2]);
            const binary = path.join(args[3], 'Blincho.app/Contents/MacOS/blincho');
            fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, 'synthetic native binary');
            fs.writeFileSync('extracted.txt', args[3]);
            return;
          }
          if (command !== process.execPath || !['tauri-cross-platform-smoke.cjs', 'tauri-camera-smoke.cjs'].includes(path.basename(args[0]))) throw new Error('Unexpected GUI boundary');
          fs.accessSync(options.env.BLINCHO_PROTOTYPE_EXECUTABLE);
          const previous=fs.existsSync('selected.json')?JSON.parse(fs.readFileSync('selected.json','utf8')):{probes:[]};
          fs.writeFileSync('selected.json', JSON.stringify({ file: options.env.BLINCHO_PROTOTYPE_EXECUTABLE, appImage: options.env.APPIMAGE_EXTRACT_AND_RUN,probes:[...previous.probes,path.basename(args[0])] }));
        };
        syncBuiltinESMExports();
      `);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, 'tests/tauri-package-smoke.cjs'], { cwd: directory, encoding: 'utf8', timeout: 15_000, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '' } });
      assert.equal(result.status, 0, result.stderr);
      const selected = JSON.parse(await fs.readFile(path.join(directory, 'selected.json'), 'utf8'));
      assert.equal(path.basename(selected.file), platform === 'macos' ? 'blincho' : name);
      assert.equal(selected.appImage, platform === 'linux' ? '1' : '');
      assert.deepEqual(selected.probes, ['tauri-cross-platform-smoke.cjs', 'tauri-camera-smoke.cjs']);
      if (platform === 'macos') {
        const extracted = await fs.readFile(path.join(directory, 'extracted.txt'), 'utf8');
        await assert.rejects(fs.stat(extracted), { code: 'ENOENT' });
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
