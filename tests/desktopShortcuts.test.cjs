'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createShortcutController } = require('../electron/desktopShortcuts.cjs');

const MARKER = '{"schema":"blincho-shortcut/1"}\n';
async function fixture(t, platform = 'linux', overrides = {}) {
  const root = await fsp.mkdtemp('/private/tmp/blincho-electron-test-');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'Desktop');
  const userData = path.join(root, 'userData');
  const packagePath = path.join(root, 'Blincho.app');
  await Promise.all([fsp.mkdir(desktop), fsp.mkdir(userData), fsp.mkdir(packagePath)]);
  const calls = [];
  const imageSources = [];
  let active = 0;
  let maxActive = 0;
  const app = { isPackaged: true, getPath: kind => ({ desktop, userData })[kind], getAppPath: () => packagePath, ...overrides.app };
  const shell = {
    showItemInFolder(file) { calls.push({ type: 'reveal', file }); },
    writeShortcutLink(file, operation, options) {
      calls.push({ type: 'windows', file, operation, options });
      fs.writeFileSync(file, JSON.stringify(options));
      return true;
    },
    ...overrides.shell,
  };
  const nativeImage = { createFromPath(file) {
    imageSources.push(file);
    const mask = Number.parseInt(path.basename(file, '.png'), 16);
    return { isEmpty: () => false, resize: size => {
      assert.deepEqual(size, { width: 256, height: 256 });
      return { toPNG: () => {
        const png = Buffer.alloc(25);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
        png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20); png[24] = mask;
        return png;
      } };
    } };
  }, ...overrides.nativeImage };
  const execute = overrides.execute || ((command, args, options, done) => {
    active += 1; maxActive = Math.max(maxActive, active);
    calls.push({ type: 'execute', command, args, options });
    setTimeout(() => { active -= 1; done(null, command.endsWith('osascript') ? 'ok\n' : ''); }, 1);
  });
  const testOnly = { execPath: path.join(root, 'installed', 'Blincho'), env: {}, allowMacHelper: true, ...overrides.testOnly };
  const options = { app, shell, nativeImage, execute, platform, testOnly };
  const controller = createShortcutController(options);
  const statePath = path.join(userData, 'desktop-launcher', 'state.json');
  return { controller, restart: () => createShortcutController(options), root, desktop, userData, packagePath, calls, imageSources, statePath, app,
    maxActive: () => maxActive, readState: async () => JSON.parse(await fsp.readFile(statePath, 'utf8')) };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: explicit opt-in, every mask, dynamic filename, exact icon, persistence, deletion`, async t => {
    const f = await fixture(t, platform);
    assert.deepEqual(await f.controller.update({ mask: 5, name: 'Before opt-in' }), { supported: true, exists: false });
    assert.deepEqual(await fsp.readdir(f.userData), []);
    let previous;
    for (let mask = 0; mask < 64; mask += 1) {
      const result = await f.controller[mask ? 'update' : 'create']({ mask, name: `Name ${mask}` });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.exists, true);
      assert.equal(path.basename(result.path), `${mask ? `Blincho · Name ${mask}` : 'Blincho'}${{ darwin: '.blincho', win32: '.lnk', linux: '.desktop' }[platform]}`);
      if (previous) assert.equal(fs.existsSync(previous), false);
      previous = result.path;
      const state = await f.readState();
      assert.equal(state.filename, path.basename(result.path));
      assert.deepEqual(Buffer.from(state.bytes, 'base64'), await fsp.readFile(result.path));
      assert.equal(path.basename(f.imageSources.at(-1)), `${mask.toString(16).padStart(2, '0')}.png`);
      if (platform === 'darwin') {
        assert.equal(await fsp.readFile(result.path, 'utf8'), MARKER);
        const call = f.calls.at(-1);
        assert.equal(call.command, '/usr/bin/osascript');
        assert.equal(call.options.shell, false);
        assert.equal(call.options.timeout, 5000);
        assert.match(call.args[3], /setIconForFileOptions/);
        assert.doesNotMatch(call.args[3], /Finder|Application\(/);
        assert.equal(call.args.length, 6);
        const icon = await fsp.readFile(call.args[5]); assert.equal(icon[24], mask);
      } else if (platform === 'win32') {
        const call = f.calls.at(-1);
        assert.equal(call.operation, 'create');
        assert.equal(call.options.appUserModelId, 'com.myeyes.app');
        assert.equal(call.options.args, '');
        assert.equal(call.options.target, path.join(f.root, 'installed', 'Blincho'));
        const ico = await fsp.readFile(call.options.icon);
        assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 1);
        assert.equal(ico[6], 0); assert.equal(ico[7], 0); assert.equal(ico.readUInt16LE(12), 32);
        assert.equal(ico.readUInt32LE(18), 22); assert.equal(ico.at(-1), mask);
      } else {
        const text = await fsp.readFile(result.path, 'utf8');
        assert.match(text, /^\[Desktop Entry\]\n/);
        assert.match(text, /StartupWMClass=com\.myeyes\.app\n/);
        assert.equal((await fsp.stat(result.path)).mode & 0o777, 0o755);
        const icon = /^Icon=(.+)$/m.exec(text)[1]; assert.equal((await fsp.readFile(icon))[24], mask);
        assert.equal(f.calls.at(-1).command, '/usr/bin/gio');
      }
    }
    const localized = await f.controller.update({ mask: 63, name: 'Зелёные глаза' });
    assert.equal(localized.error, undefined); assert.match(path.basename(localized.path), /Зелёные глаза/);
    assert.equal(fs.existsSync(previous), false);
    const restarted = createShortcutController({ app: f.app, platform, shell: { writeShortcutLink() { throw Error('Unexpected API'); } },
      nativeImage: { createFromPath() { throw Error('Unexpected API'); } }, testOnly: { allowMacHelper: true } });
    await fsp.unlink(localized.path);
    assert.deepEqual(await restarted.update({ mask: 1, name: 'Deleted by user' }), { supported: true, path: localized.path, exists: false });
    assert.equal((await fsp.readdir(f.desktop)).length, 0);
    assert.deepEqual(await fsp.readdir(f.packagePath), []);
  });
}

test('serializes rapid updates and captures arguments at submission', async t => {
  const f = await fixture(t, 'darwin');
  const first = f.controller.create({ mask: 1, name: 'First' });
  const request = { mask: 2, name: 'Second' };
  const second = f.controller.update(request);
  request.mask = 60; request.name = 'Mutated after submission';
  const last = f.controller.update({ mask: 3, name: 'Последний' });
  const [a, b, c] = await Promise.all([first, second, last]);
  assert.ok([a, b, c].every(x => x.exists && !x.error));
  assert.match(b.path, /Second/); assert.match(c.path, /Последний/);
  assert.equal(f.maxActive(), 1);
  assert.deepEqual(await fsp.readdir(f.desktop), [path.basename(c.path)]);
  assert.equal((await f.readState()).filename, path.basename(c.path));
});

test('refuses unrelated name collisions including default installed shortcuts', async t => {
  const f = await fixture(t);
  const defaultLink = path.join(f.desktop, 'Blincho.desktop');
  await fsp.writeFile(defaultLink, 'unrelated installed shortcut');
  const initial = await f.controller.create({ mask: 0, name: '' });
  assert.match(initial.error, /already exists/);
  assert.equal(await fsp.readFile(defaultLink, 'utf8'), 'unrelated installed shortcut');
  assert.equal(fs.existsSync(f.statePath), false);
  const owned = await f.controller.create({ mask: 1, name: 'Owned' });
  const collision = path.join(f.desktop, 'Blincho · Collision.desktop');
  await fsp.writeFile(collision, 'user file');
  assert.match((await f.controller.update({ mask: 2, name: 'Collision' })).error, /already exists/);
  assert.equal(fs.existsSync(owned.path), true);
  assert.equal(await fsp.readFile(collision, 'utf8'), 'user file');
});

test('refuses changed owned bytes, symlinks, hardlinks and malicious ownership paths', async t => {
  for (const kind of ['modified', 'symlink', 'hardlink', 'state-traversal', 'state-symlink', 'icon-symlink']) {
    const f = await fixture(t);
    const owned = await f.controller.create({ mask: 1, name: 'Owned' });
    const outside = path.join(f.root, `outside-${kind}`);
    await fsp.writeFile(outside, kind === 'hardlink' ? await fsp.readFile(owned.path) : 'untouched');
    if (kind === 'modified') await fsp.writeFile(owned.path, 'user-edited');
    if (kind === 'symlink') { await fsp.unlink(owned.path); await fsp.symlink(outside, owned.path); }
    if (kind === 'hardlink') { await fsp.unlink(owned.path); await fsp.link(outside, owned.path); }
    if (kind === 'state-traversal') {
      const state = await f.readState(); state.filename = '../outside-state-traversal';
      await fsp.writeFile(f.statePath, JSON.stringify(state));
    }
    if (kind === 'state-symlink') { await fsp.unlink(f.statePath); await fsp.symlink(outside, f.statePath); }
    if (kind === 'icon-symlink') {
      const original = /^Icon=(.+)$/m.exec(await fsp.readFile(owned.path, 'utf8'))[1];
      await fsp.unlink(original); await fsp.symlink(outside, original);
    }
    const result = await f.controller.update({ mask: 1, name: 'Updated' });
    assert.ok(result.error, kind);
    assert.equal(await fsp.readFile(outside, 'utf8'), kind === 'hardlink' ? await fsp.readFile(owned.path, 'utf8') : 'untouched', kind);
    assert.equal(fs.existsSync(path.join(f.desktop, 'Blincho · Updated.desktop')), false, kind);
  }
});

test('handles filename controls, traversal, reserved characters, Unicode and byte bounds', async t => {
  const f = await fixture(t);
  const result = await f.controller.create({ mask: 9, name: '../<>:"\\|?*\n\r\tCON\u202e ' + '😀漢'.repeat(100) });
  assert.equal(result.error, undefined);
  assert.equal(path.dirname(result.path), f.desktop);
  assert.equal(path.extname(result.path), '.desktop');
  assert.equal(Buffer.byteLength(path.basename(result.path)) < 240, true);
  assert.doesNotMatch(path.basename(result.path), /[<>:"/\\|?*\x00-\x1f\u202e]/u);
  assert.equal(path.basename(result.path).includes('😀'), true);
  for (const request of [null, {}, { mask: -1, name: 'bad' }, { mask: 64, name: 'bad' }, { mask: 1.2, name: 'bad' },
    { mask: '1', name: 'bad' }, { mask: 1, name: 5 }, { mask: 1, name: '\n' }, { mask: 1, name: 'x'.repeat(4097) }]) {
    assert.match((await f.controller.update(request)).error, /Invalid/);
  }
});

test('Linux uses outer APPIMAGE and safely encodes Exec without evaluating shell syntax', async t => {
  const outer = '/home/user/Apps/Blincho "special" `cmd` $HOME %F \\ here.AppImage';
  const f = await fixture(t, 'linux', { testOnly: { env: { APPIMAGE: outer } } });
  const result = await f.controller.create({ mask: 1, name: 'Test' });
  assert.equal(result.error, undefined);
  const exec = /^Exec=(.+)$/m.exec(await fsp.readFile(result.path, 'utf8'))[1];
  assert.equal(exec, '"/home/user/Apps/Blincho \\\\"special\\\\" \\\\`cmd\\\\` \\\\$HOME %%F \\\\\\\\ here.AppImage"');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, '/usr/bin/gio');
  const failTrust = await fixture(t, 'linux', { execute: (_cmd, _args, _options, done) => done(Error('No metadata support')) });
  assert.equal((await failTrust.controller.create({ mask: 0, name: '' })).exists, true);
  for (const APPIMAGE of ['relative', '/unsafe\nline', '/has=equals']) {
    const bad = await fixture(t, 'linux', { testOnly: { env: { APPIMAGE } } });
    assert.ok((await bad.controller.create({ mask: 1, name: 'Test' })).error);
    assert.deepEqual(await fsp.readdir(bad.desktop), []);
  }
});

test('macOS marker recognition is bounded, exact and never executes supplied contents', async t => {
  const f = await fixture(t, 'darwin');
  const result = await f.controller.create({ mask: 0, name: '' });
  assert.equal(await f.controller.isShortcutFile(result.path), true);
  const count = f.calls.length;
  const unknown = path.join(f.root, 'unknown.blincho');
  for (const contents of ['#!/bin/sh\necho bad', '{"command":"bad"}', MARKER + ' ', 'x'.repeat(1024 * 1024)]) {
    await fsp.writeFile(unknown, contents);
    assert.equal(await f.controller.isShortcutFile(unknown), false);
  }
  await fsp.unlink(unknown); await fsp.symlink(result.path, unknown);
  assert.equal(await f.controller.isShortcutFile(unknown), false);
  assert.equal(await f.controller.isShortcutFile('../unknown.blincho'), false);
  assert.equal(await f.controller.isShortcutFile('/a\0.blincho'), false);
  assert.equal(await f.controller.isShortcutFile('x'.repeat(5000)), false);
  assert.equal(await f.controller.isShortcutFile(f.desktop), false);
  assert.equal(await f.controller.isShortcutFile(path.join(f.root, 'missing.blincho')), false);
  assert.equal(f.calls.length, count);
});

test('unsupported, unpackaged and helper failures leave no launcher or ownership record', async t => {
  for (const options of [{ platform: 'freebsd' }, { platform: 'linux', app: { isPackaged: false } }]) {
    const f = await fixture(t, options.platform, { app: options.app });
    assert.deepEqual(await f.controller.create({ mask: 1, name: 'Test' }), { supported: false, exists: false });
    assert.equal(f.calls.length, 0); assert.deepEqual(await fsp.readdir(f.userData), []);
  }
  const mac = await fixture(t, 'darwin', { execute: (_cmd, _args, _options, done) => done(Error('Icon helper unavailable')) });
  assert.match((await mac.controller.create({ mask: 1, name: 'Test' })).error, /Icon helper unavailable/);
  assert.deepEqual(await fsp.readdir(mac.desktop), []); assert.equal(fs.existsSync(mac.statePath), false);
  const win = await fixture(t, 'win32', { shell: { writeShortcutLink: () => false } });
  assert.match((await win.controller.create({ mask: 1, name: 'Test' })).error, /Windows launcher/);
  assert.deepEqual(await fsp.readdir(win.desktop), []);
});

test('managed directory symlinks are refused without writing through them', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'external'); await fsp.mkdir(outside);
  await fsp.symlink(outside, path.join(f.userData, 'desktop-launcher'));
  assert.ok((await f.controller.create({ mask: 1, name: 'Test' })).error);
  assert.deepEqual(await fsp.readdir(outside), []);
  assert.deepEqual(await fsp.readdir(f.desktop), []);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: same filename replaces only owned file and changes icon`, async t => {
    const f = await fixture(t, platform);
    const initial = await f.controller.create({ mask: 1, name: 'Same title' });
    const updated = await f.controller.update({ mask: 2, name: 'Same title' });
    assert.equal(updated.error, undefined); assert.equal(updated.path, initial.path);
    assert.deepEqual(await fsp.readdir(f.desktop), [path.basename(updated.path)]);
    assert.deepEqual(Buffer.from((await f.readState()).bytes, 'base64'), await fsp.readFile(updated.path));
    if (platform === 'darwin') assert.equal((await fsp.readFile(f.calls.at(-1).args[5]))[24], 2);
    if (platform === 'win32') assert.equal((await fsp.readFile(JSON.parse(await fsp.readFile(updated.path)).icon)).at(-1), 2);
    if (platform === 'linux') assert.equal((await fsp.readFile(/^Icon=(.+)$/m.exec(await fsp.readFile(updated.path, 'utf8'))[1]))[24], 2);
  });
}

test('deletion during icon staging is respected and staging files are removed', async t => {
  let ownedPath = null;
  const f = await fixture(t, 'darwin', { execute: (_cmd, _args, _options, done) => {
    if (ownedPath) fs.unlinkSync(ownedPath);
    done(null, 'ok');
  } });
  const initial = await f.controller.create({ mask: 1, name: 'Initial' }); ownedPath = initial.path;
  const result = await f.controller.update({ mask: 2, name: 'New' });
  assert.deepEqual(result, { supported: true, path: initial.path, exists: false });
  assert.deepEqual(await fsp.readdir(f.desktop), []);
  assert.deepEqual((await fsp.readdir(path.dirname(f.statePath))).filter(x => x.startsWith('.state-')), []);
});

test('collision introduced during icon staging is not overwritten', async t => {
  let collision = null;
  const f = await fixture(t, 'darwin', { execute: (_cmd, _args, _options, done) => {
    if (collision) fs.writeFileSync(collision, 'arrived during staging');
    done(null, 'ok');
  } });
  const initial = await f.controller.create({ mask: 1, name: 'Initial' });
  collision = path.join(f.desktop, 'Blincho · New.blincho');
  const result = await f.controller.update({ mask: 2, name: 'New' });
  assert.ok(result.error);
  assert.equal(await fsp.readFile(collision, 'utf8'), 'arrived during staging');
  assert.equal(await fsp.readFile(initial.path, 'utf8'), MARKER);
  assert.equal((await f.readState()).filename, path.basename(initial.path));
  assert.equal((await fsp.readdir(f.desktop)).some(x => x.startsWith('.blincho-launcher-')), false);
});


test('status/reveal serialize with updates and only reveal exact validated ownership', async t => {
  const f = await fixture(t, 'darwin');
  assert.deepEqual(await f.controller.status(), { supported: true, exists: false });
  assert.deepEqual(await f.controller.reveal(), { supported: true, exists: false });
  assert.deepEqual(await fsp.readdir(f.userData), []);
  const creation = f.controller.create({ mask: 1, name: 'Owned' });
  const state = f.controller.status();
  const initial = await creation;
  assert.deepEqual(await state, { supported: true, path: initial.path, exists: true });
  assert.deepEqual(await f.controller.reveal('/untrusted/renderer/path'), { supported: true, path: initial.path, exists: true });
  assert.equal(f.calls.at(-1).file, initial.path);
  assert.equal(f.calls.at(-1).type, 'reveal');
  const revealed = f.calls.filter(x => x.type === 'reveal').length;
  await fsp.unlink(initial.path);
  assert.deepEqual(await f.controller.reveal(), { supported: true, path: initial.path, exists: false });
  assert.equal(f.calls.filter(x => x.type === 'reveal').length, revealed);
  await fsp.symlink(f.statePath, initial.path);
  assert.ok((await f.controller.status()).error);
  assert.ok((await f.controller.reveal()).error);
  assert.equal(f.calls.filter(x => x.type === 'reveal').length, revealed);
});

async function failOnce(method, matches, operation) {
  const original = fsp[method];
  let injected = false;
  fsp[method] = async (...args) => {
    if (!injected && matches(...args)) {
      injected = true;
      const error = Error(`Injected ${method} EIO`); error.code = 'EIO'; throw error;
    }
    return original.apply(fsp, args);
  };
  try { return await operation(); }
  finally { fsp[method] = original; assert.equal(injected, true, `Expected injected ${method} failure`); }
}

async function pendingPublication(f, request, kind = 'create') {
  const result = await failOnce('rename', (_from, to) => to === f.statePath,
    () => f.controller[kind](request));
  assert.match(result.error, /Injected rename EIO/);
  const journalPath = path.join(path.dirname(f.statePath), 'transaction.json');
  const journal = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
  return { result, journal, journalPath, stage: path.join(f.desktop, journal.stage), output: path.join(f.desktop, journal.next.filename) };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: transient state commit failures recover creation, rename and same-name changes on restart`, async t => {
    const f = await fixture(t, platform);
    let previous = null;
    for (const [kind, mask, name] of [['create', 1, 'First'], ['update', 2, 'Renamed'], ['update', 3, 'Renamed']]) {
      const pending = await pendingPublication(f, { mask, name }, kind);
      assert.equal(fs.existsSync(pending.output), true);
      assert.equal((await fsp.stat(pending.output)).nlink, fs.existsSync(pending.stage) ? 2 : 1);
      const recovered = await f.restart().status();
      assert.deepEqual(recovered, { supported: true, path: pending.output, exists: true });
      assert.equal(fs.existsSync(pending.journalPath), false);
      assert.equal(fs.existsSync(pending.stage), false);
      assert.equal((await fsp.stat(pending.output)).nlink, 1);
      assert.equal((await f.readState()).filename, path.basename(pending.output));
      assert.deepEqual(Buffer.from((await f.readState()).bytes, 'base64'), await fsp.readFile(pending.output));
      if (previous && previous !== pending.output) assert.equal(fs.existsSync(previous), false);
      previous = pending.output;
    }
    assert.equal((await f.controller.update({ mask: 4, name: 'Recovered update' })).error, undefined);
    assert.equal((await fsp.readdir(f.desktop)).length, 1);
    assert.deepEqual(await fsp.readdir(f.packagePath), []);
  });
}

test('the next mutation reconciles a failed creation instead of reporting a permanent collision', async t => {
  const f = await fixture(t);
  const pending = await pendingPublication(f, { mask: 1, name: 'Same name' });
  const retry = await f.controller.create({ mask: 2, name: 'Same name' });
  assert.equal(retry.error, undefined); assert.equal(retry.exists, true);
  assert.equal(retry.path, pending.output);
  assert.equal(fs.existsSync(pending.journalPath), false);
  assert.deepEqual(await fsp.readdir(f.desktop), [path.basename(retry.path)]);
});

test('restart finishes interrupted linked-stage, old-name and journal cleanup after state commit', async t => {
  for (const boundary of ['stage', 'old', 'journal']) {
    const f = await fixture(t, 'darwin');
    const initial = await f.controller.create({ mask: 1, name: 'Before' });
    const journalPath = path.join(path.dirname(f.statePath), 'transaction.json');
    const result = await failOnce('unlink', file => boundary === 'stage' ? path.basename(file).startsWith('.blincho-launcher-') :
      boundary === 'old' ? file === initial.path : file === journalPath,
    () => f.controller.update({ mask: 2, name: 'After' }));
    assert.match(result.error, /Injected unlink EIO/);
    assert.equal((await f.readState()).filename, 'Blincho · After.blincho');
    assert.equal(fs.existsSync(journalPath), true);
    const restarted = await f.restart().status();
    assert.deepEqual(restarted, { supported: true, path: path.join(f.desktop, 'Blincho · After.blincho'), exists: true });
    assert.equal(fs.existsSync(initial.path), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.deepEqual(await fsp.readdir(f.desktop), ['Blincho · After.blincho']);
  }
});

test('restart rolls back a prepared unpublished journal and preserves a foreign collision', async t => {
  const f = await fixture(t, 'darwin');
  const pending = await pendingPublication(f, { mask: 1, name: 'Interrupted' });
  // This is the exact pre-publication filesystem state: the journal and stage
  // are durable, but no visible entry has been linked yet.
  await fsp.unlink(pending.output);
  assert.deepEqual(await f.restart().status(), { supported: true, exists: false });
  assert.equal(fs.existsSync(pending.stage), false);
  assert.equal(fs.existsSync(pending.journalPath), false);
  assert.equal(fs.existsSync(f.statePath), false);
  const second = await pendingPublication(f, { mask: 2, name: 'Foreign' });
  await fsp.unlink(second.output);
  await fsp.writeFile(second.output, MARKER);
  const foreignIdentity = (await fsp.lstat(second.output)).ino;
  assert.deepEqual(await f.restart().status(), { supported: true, exists: false });
  assert.equal((await fsp.lstat(second.output)).ino, foreignIdentity);
  assert.equal(await fsp.readFile(second.output, 'utf8'), MARKER);
  assert.equal(fs.existsSync(second.stage), false);
  assert.equal(fs.existsSync(second.journalPath), false);
  assert.match((await f.controller.create({ mask: 2, name: 'Foreign' })).error, /already exists/);
});

test('restart refuses unknown hardlinks and changed staged bytes without deleting anything', async t => {
  for (const kind of ['hardlink', 'changed', 'symlink', 'stage-replaced']) {
    const f = await fixture(t, 'darwin');
    const pending = await pendingPublication(f, { mask: 1, name: kind });
    const external = path.join(f.root, `external-${kind}`);
    if (kind === 'hardlink') await fsp.link(pending.output, external);
    if (kind === 'changed') await fsp.writeFile(pending.output, 'changed by user');
    if (kind === 'symlink') {
      await fsp.writeFile(external, 'foreign');
      await fsp.unlink(pending.stage); await fsp.symlink(external, pending.stage);
    }
    if (kind === 'stage-replaced') {
      await fsp.unlink(pending.stage); await fsp.writeFile(pending.stage, MARKER);
    }
    const before = await fsp.readdir(f.desktop);
    const recovered = await f.restart().status();
    assert.ok(recovered.error, kind); assert.equal(recovered.exists, false, kind);
    assert.deepEqual(await fsp.readdir(f.desktop), before, kind);
    assert.equal(fs.existsSync(pending.journalPath), true, kind);
    assert.equal(fs.existsSync(f.statePath), false, kind);
    if (kind === 'hardlink') {
      assert.equal((await fsp.stat(external)).nlink, 3);
      await fsp.unlink(external);
      assert.equal((await f.restart().status()).exists, true);
      assert.equal((await fsp.stat(pending.output)).nlink, 1);
    }
    if (kind === 'symlink') assert.equal(await fsp.readFile(external, 'utf8'), 'foreign');
  }
});

test('malformed transaction paths, identities, bytes and records never authorize Desktop changes', async t => {
  for (const corruption of ['stage-traversal', 'stage-unrecognized', 'state-traversal', 'identity', 'record', 'base64', 'platform', 'journal-symlink']) {
    const f = await fixture(t, 'darwin');
    const pending = await pendingPublication(f, { mask: 1, name: 'Safe' });
    const foreign = path.join(f.root, 'foreign'); await fsp.writeFile(foreign, 'preserve');
    const journal = pending.journal;
    if (corruption === 'stage-traversal') journal.stage = '../foreign';
    if (corruption === 'stage-unrecognized') journal.stage = 'ordinary.blincho';
    if (corruption === 'state-traversal') journal.stateTemporary = '../foreign';
    if (corruption === 'identity') journal.stageIdentity.ino = '-1';
    if (corruption === 'record') journal.next.filename = '../foreign';
    if (corruption === 'base64') journal.next.bytes = '!!!!';
    if (corruption === 'platform') journal.next.platform = 'win32';
    if (corruption === 'journal-symlink') {
      await fsp.unlink(pending.journalPath); await fsp.symlink(foreign, pending.journalPath);
    } else await fsp.writeFile(pending.journalPath, JSON.stringify(journal));
    const before = await fsp.readdir(f.desktop);
    assert.ok((await f.restart().status()).error, corruption);
    assert.deepEqual(await fsp.readdir(f.desktop), before, corruption);
    assert.equal(await fsp.readFile(foreign, 'utf8'), 'preserve', corruption);
    assert.equal(fs.existsSync(f.statePath), false, corruption);
  }
});

test('cleanup preserves a foreign replacement at the previous owned filename', async t => {
  const f = await fixture(t, 'darwin');
  const initial = await f.controller.create({ mask: 1, name: 'Old' });
  const pending = await pendingPublication(f, { mask: 2, name: 'New' }, 'update');
  await fsp.unlink(initial.path); await fsp.writeFile(initial.path, 'foreign replacement');
  assert.equal((await f.restart().status()).exists, true);
  assert.equal(await fsp.readFile(initial.path, 'utf8'), 'foreign replacement');
  assert.equal(fs.existsSync(pending.journalPath), false);
  assert.deepEqual(await fsp.readdir(f.desktop), ['Blincho · New.blincho', 'Blincho · Old.blincho']);
});

test('Windows portable shortcuts use the stable outer exe and never execute it', async t => {
  const f = await fixture(t, 'win32');
  const portable = path.join(f.root, 'Blincho Portable.exe'); await fsp.writeFile(portable, 'portable fixture');
  const portableController = createShortcutController({ app: f.app, platform: 'win32',
    testOnly: { execPath: path.join(f.root, 'temporary-extracted', 'Blincho.exe'), env: { PORTABLE_EXECUTABLE_FILE: portable } },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({ toPNG: () => {
      const png = Buffer.alloc(25); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20); return png;
    } }) }) },
    shell: { writeShortcutLink(file, operation, options) {
      assert.equal(operation, 'create'); assert.equal(options.target, portable); assert.equal(options.cwd, f.root);
      fs.writeFileSync(file, JSON.stringify(options)); return true;
    } }, execute() { throw Error('Portable executable must never run'); } });
  const result = await portableController.create({ mask: 1, name: 'Portable' });
  assert.equal(result.error, undefined);
  assert.equal(JSON.parse(await fsp.readFile(result.path)).target, portable);
  assert.equal(await fsp.readFile(portable, 'utf8'), 'portable fixture');
});

test('Windows refuses invalid, missing, non-file and symlinked portable targets', async t => {
  for (const kind of ['relative', 'control', 'empty', 'missing', 'directory', 'non-exe', 'symlink']) {
    const f = await fixture(t, 'win32');
    const executable = path.join(f.root, 'portable.exe');
    let portable = executable;
    if (kind === 'relative') portable = 'relative.exe';
    if (kind === 'control') portable = '/invalid\n.exe';
    if (kind === 'empty') portable = '';
    if (kind === 'directory') await fsp.mkdir(executable);
    if (kind === 'non-exe') { portable = path.join(f.root, 'portable.txt'); await fsp.writeFile(portable, 'foreign'); }
    if (kind === 'symlink') { const target = path.join(f.root, 'actual.exe'); await fsp.writeFile(target, 'foreign'); await fsp.symlink(target, executable); }
    const invalid = await fixture(t, 'win32', { testOnly: { env: { PORTABLE_EXECUTABLE_FILE: portable } } });
    const result = await invalid.controller.create({ mask: 1, name: 'Invalid portable' });
    assert.ok(result.error, kind); assert.equal(result.exists, false, kind);
    assert.deepEqual(await fsp.readdir(invalid.desktop), [], kind);
    assert.equal(invalid.calls.filter(call => call.type === 'windows').length, 0, kind);
    assert.equal(fs.existsSync(invalid.statePath), false, kind);
  }
});


test('same-name publication rechecks the original inode after journal preparation', async t => {
  const f = await fixture(t, 'darwin');
  const initial = await f.controller.create({ mask: 1, name: 'Same' });
  const original = fsp.rename;
  let foreignIdentity;
  fsp.rename = async (...args) => {
    const result = await original.apply(fsp, args);
    if (args[1] === path.join(path.dirname(f.statePath), 'transaction.json')) {
      await fsp.unlink(initial.path); await fsp.writeFile(initial.path, MARKER);
      foreignIdentity = (await fsp.lstat(initial.path, { bigint: true })).ino;
    }
    return result;
  };
  let result;
  try { result = await f.controller.update({ mask: 2, name: 'Same' }); }
  finally { fsp.rename = original; }
  assert.ok(result.error);
  assert.equal((await fsp.lstat(initial.path, { bigint: true })).ino, foreignIdentity);
  assert.equal(await fsp.readFile(initial.path, 'utf8'), MARKER);
  assert.deepEqual(await fsp.readdir(f.desktop), [path.basename(initial.path)]);
  assert.equal(fs.existsSync(path.join(path.dirname(f.statePath), 'transaction.json')), false);
});
