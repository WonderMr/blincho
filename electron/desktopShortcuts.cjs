'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');

const MARKER = Buffer.from('{"schema":"blincho-shortcut/1"}\n');
const MAX_FILE = 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXTENSIONS = { darwin: '.blincho', win32: '.lnk', linux: '.desktop' };
const MAC_ICON_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  if (argv.length !== 2) throw Error('Invalid icon request');
  var image = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
  if (image.isNil()) throw Error('Launcher icon is unavailable');
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0))
    throw Error('Launcher icon could not be applied');
  return 'ok';
}
`;

function safePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value))
    throw Error('Invalid launcher storage path');
  return value;
}

function selection(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 63 ||
      typeof value.name !== 'string' || value.name.length > 4096)
    throw Error('Invalid launcher selection');
  // The fixed prefix keeps Windows device names and leading-dot paths impossible.
  let name = value.name.normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f<>:"/\\|?*\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, ' ')
    .replace(/[\u2014\u2015]/gu, ',').replace(/\s+/gu, ' ').replace(/[. ]+$/u, '').trim();
  let clipped = '';
  for (const char of name) {
    if (Buffer.byteLength(clipped + char, 'utf8') > 150) break;
    clipped += char;
  }
  name = clipped.replace(/[. ]+$/u, '').trim();
  if (value.mask !== 0 && !name) throw Error('Invalid launcher name');
  return { mask: value.mask, title: value.mask === 0 ? 'Blincho' : `Blincho · ${name}` };
}

async function statOrNull(file) {
  try { return await fsp.lstat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameIdentity(stat, identity) {
  return !identity || (String(stat.dev) === identity.dev && String(stat.ino) === identity.ino);
}

function identityOf(stat) {
  if (!stat || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint')
    throw Error('Launcher file identity is unavailable');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

async function regularBytes(file, limit = MAX_FILE, links = 1, identity = null) {
  const stat = await statOrNull(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== BigInt(links) || stat.size > limit || !sameIdentity(stat, identity))
    throw Error('Launcher storage contains an unsafe file');
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== BigInt(links) || opened.size > limit || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw Error('Launcher storage changed while reading');
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const chunk = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (offset !== Number(opened.size) || final.size !== opened.size || final.nlink !== BigInt(links) || final.mtimeNs !== opened.mtimeNs)
      throw Error('Launcher storage changed while reading');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function safeDirectory(directory, create) {
  let stat = await statOrNull(directory);
  if (!stat && create) {
    // Only the last managed component is created. Parents come from Electron.
    try { await fsp.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = await statOrNull(directory);
  }
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Launcher storage contains an unsafe directory');
  return true;
}

function run(execute, command, args) {
  return new Promise((resolve, reject) => {
    execute(command, args, { shell: false, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(String(stdout || '').trim()));
  });
}

function pngIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  // Width and height zero represent 256 pixels in an ICO directory entry.
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

function desktopValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function desktopExec(executable) {
  if (executable.includes('=')) throw Error('Unsupported executable path');
  // Apply Exec argument quoting first, then the desktop string escape layer.
  return desktopValue(`"${executable.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&')}"`);
}

/** Main-process only. testOnly is a factory-level injection, never an IPC payload. */
function createShortcutController({ app, shell, nativeImage, execute = execFile, platform = process.platform, testOnly = null } = {}) {
  const extension = EXTENSIONS[platform];
  const supported = Boolean(extension && app && app.isPackaged &&
    (platform !== 'darwin' || process.platform === 'darwin' || testOnly?.allowMacHelper === true));
  let queue = Promise.resolve();

  const locations = () => {
    const desktop = safePath(app.getPath('desktop'));
    const userData = safePath(app.getPath('userData'));
    const directory = path.join(userData, 'desktop-launcher');
    return { desktop, userData, directory, state: path.join(directory, 'state.json'), journal: path.join(directory, 'transaction.json'), icons: path.join(directory, 'icons') };
  };

  function stateRecord(state) {
    return { format: state.format, version: state.version, platform: state.platform, filename: state.filename, bytes: state.bytes };
  }

  function decodeRecord(record, paths) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        record.format !== 'com.myeyes.app.desktop-launcher' || record.version !== 1 || record.platform !== platform ||
        typeof record.filename !== 'string' || path.basename(record.filename) !== record.filename ||
        !record.filename.startsWith('Blincho') || !record.filename.endsWith(extension) ||
        Buffer.byteLength(record.filename, 'utf8') > 240 || /[\x00-\x1f<>:"/\\|?*]/u.test(record.filename) ||
        typeof record.bytes !== 'string' || record.bytes.length > MAX_FILE * 1.4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.bytes))
      throw Error('Launcher ownership record is invalid');
    const expected = Buffer.from(record.bytes, 'base64');
    if (!expected.length || expected.length > MAX_FILE || expected.toString('base64') !== record.bytes ||
        (platform === 'darwin' && !expected.equals(MARKER))) throw Error('Launcher ownership record is invalid');
    return { ...stateRecord(record), expected, path: path.join(paths.desktop, record.filename) };
  }

  const recordBytes = state => Buffer.from(`${JSON.stringify(stateRecord(state))}\n`);
  const recordsEqual = (left, right) => (!left && !right) || Boolean(left && right && recordBytes(left).equals(recordBytes(right)));

  async function readState(paths) {
    if (!await safeDirectory(paths.userData, false) || !await safeDirectory(paths.directory, false)) return null;
    const data = await regularBytes(paths.state, MAX_FILE * 2);
    if (!data) return null;
    let state;
    try { state = JSON.parse(data.toString('utf8')); } catch { throw Error('Launcher ownership record is invalid'); }
    return decodeRecord(state, paths);
  }

  function validIdentity(identity) {
    return identity && typeof identity === 'object' && !Array.isArray(identity) &&
      Object.keys(identity).sort().join(',') === 'dev,ino' &&
      ['dev', 'ino'].every(key => typeof identity[key] === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(identity[key]));
  }

  async function removeKnown(file, expected, identity = null) {
    const actual = await regularBytes(file, Math.max(MAX_FILE, expected.length), 1, identity);
    if (!actual) return;
    if (!actual.equals(expected)) throw Error('Launcher transaction file was changed outside Blincho');
    await fsp.unlink(file);
  }

  async function reconcile(paths) {
    if (!await safeDirectory(paths.userData, false) || !await safeDirectory(paths.directory, false)) return;
    const journalBytes = await regularBytes(paths.journal, MAX_FILE * 4);
    if (!journalBytes) return;
    let journal;
    try { journal = JSON.parse(journalBytes.toString('utf8')); } catch { throw Error('Launcher transaction record is invalid'); }
    const keys = 'format,next,previous,previousIdentity,previousStateIdentity,stage,stageIdentity,stateIdentity,stateTemporary,version';
    if (!journal || typeof journal !== 'object' || Array.isArray(journal) ||
        Object.keys(journal).sort().join(',') !== keys ||
        journal.format !== 'com.myeyes.app.desktop-launcher-transaction' || journal.version !== 1 ||
        typeof journal.stage !== 'string' || !new RegExp(`^\\.blincho-launcher-${UUID}\\${extension}$`).test(journal.stage) ||
        typeof journal.stateTemporary !== 'string' || !new RegExp(`^\\.state-${UUID}$`).test(journal.stateTemporary) ||
        !validIdentity(journal.stageIdentity) || !validIdentity(journal.stateIdentity) ||
        !(journal.previousIdentity === null || validIdentity(journal.previousIdentity)) ||
        !(journal.previousStateIdentity === null || validIdentity(journal.previousStateIdentity)))
      throw Error('Launcher transaction record is invalid');
    const next = decodeRecord(journal.next, paths);
    const previous = journal.previous === null ? null : decodeRecord(journal.previous, paths);
    if ((!previous && (journal.previousIdentity !== null || journal.previousStateIdentity !== null)) ||
        (previous && journal.previousStateIdentity === null)) throw Error('Launcher transaction record is invalid');
    const stage = path.join(paths.desktop, journal.stage);
    const stateTemporary = path.join(paths.directory, journal.stateTemporary);
    const current = await readState(paths);
    const currentStateStat = await statOrNull(paths.state);
    const committed = recordsEqual(current, next) && sameIdentity(currentStateStat || {}, journal.stateIdentity);
    const unchanged = recordsEqual(current, previous) && (previous ? sameIdentity(currentStateStat || {}, journal.previousStateIdentity) : !currentStateStat);
    if (!committed && !unchanged) throw Error('Launcher ownership changed during a transaction');
    const stageStat = await statOrNull(stage);
    const outputStat = await statOrNull(next.path);
    // Only the recorded staged inode can establish publication. Equal bytes at a
    // foreign path do not authorize adoption, even for the fixed macOS marker.
    const published = Boolean(outputStat && sameIdentity(outputStat, journal.stageIdentity));
    if (stageStat && !sameIdentity(stageStat, journal.stageIdentity))
      throw Error('Launcher transaction staging file was replaced');
    if (published) {
      const links = stageStat ? 2 : 1;
      const output = await regularBytes(next.path, MAX_FILE, links, journal.stageIdentity);
      if (!output || !output.equals(next.expected)) throw Error('Launcher transaction output was changed outside Blincho');
      if (stageStat) {
        const staged = await regularBytes(stage, MAX_FILE, links, journal.stageIdentity);
        if (!staged || !staged.equals(next.expected)) throw Error('Launcher transaction staging file was changed outside Blincho');
      }
    } else {
      // Before publication, a collision is foreign and stays untouched. After a
      // state commit, a replacement is refused instead of silently being owned.
      if (committed && outputStat) throw Error('Launcher transaction output was replaced');
      if (stageStat) {
        const staged = await regularBytes(stage, MAX_FILE, 1, journal.stageIdentity);
        if (!staged || !staged.equals(next.expected)) throw Error('Launcher transaction staging file was changed outside Blincho');
      }
    }
    // Validate every temporary before committing or deleting anything.
    const pendingState = await regularBytes(stateTemporary, MAX_FILE * 2, 1, journal.stateIdentity);
    const expectedState = recordBytes(next);
    if (pendingState && !pendingState.equals(expectedState)) throw Error('Launcher transaction state was changed outside Blincho');
    if (published && !committed) {
      if (!pendingState) throw Error('Launcher transaction state is unavailable');
      if (await statOrNull(paths.state)) await regularBytes(paths.state, MAX_FILE * 2);
      await fsp.rename(stateTemporary, paths.state);
    }
    // Remove a known link only after verifying the complete expected link count.
    // An extra hardlink keeps the transaction pending and is never accepted.
    if (stageStat) {
      if (published) {
        const staged = await regularBytes(stage, MAX_FILE, 2, journal.stageIdentity);
        if (!staged || !staged.equals(next.expected)) throw Error('Launcher transaction staging file was changed outside Blincho');
        await fsp.unlink(stage);
      } else await removeKnown(stage, next.expected, journal.stageIdentity);
    }
    if ((published || committed) && previous && previous.path !== next.path && journal.previousIdentity) {
      const oldStat = await statOrNull(previous.path);
      if (oldStat && sameIdentity(oldStat, journal.previousIdentity))
        await removeKnown(previous.path, previous.expected, journal.previousIdentity);
      // A replacement at the old name belongs to its new owner and stays intact.
    }
    await removeKnown(stateTemporary, expectedState, journal.stateIdentity);
    await removeKnown(paths.journal, journalBytes);
  }

  async function ownedBytes(state) {
    const bytes = await regularBytes(state.path);
    if (bytes && !bytes.equals(state.expected)) throw Error('Owned launcher was changed outside Blincho');
    return bytes;
  }

  async function imageFile(paths, mask) {
    if (!await safeDirectory(paths.icons, true)) throw Error('Launcher icon directory is unavailable');
    const source = path.join(safePath(app.getAppPath()), 'dist', 'symbiote', `${mask.toString(16).padStart(2, '0')}.png`);
    const image = nativeImage.createFromPath(source);
    if (!image || image.isEmpty()) throw Error('Build icon is unavailable');
    const png = image.resize({ width: 256, height: 256 }).toPNG();
    if (!Buffer.isBuffer(png) || png.length < 24 || png.length > MAX_FILE ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) throw Error('Build icon is invalid');
    const bytes = platform === 'win32' ? pngIco(png) : png;
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const icon = path.join(paths.icons, `${mask.toString(16).padStart(2, '0')}-${digest}${platform === 'win32' ? '.ico' : '.png'}`);
    const existing = await regularBytes(icon);
    if (existing) {
      if (existing.equals(bytes)) return icon;
      // This private derived cache is rebuilt from approved package assets.
    }
    const temporary = path.join(paths.icons, `.stage-${randomUUID()}`);
    try {
      await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      // Atomic replacement inside the private derived cache leaves no additional
      // hardlink that could survive a process interruption.
      await fsp.rename(temporary, icon);
    } finally { await fsp.unlink(temporary).catch(() => {}); }
    return icon;
  }

  async function stageShortcut(temporary, icon, item) {
    if (platform === 'win32') {
      const env = testOnly?.env || process.env;
      const portable = env.PORTABLE_EXECUTABLE_FILE;
      const executable = safePath(portable === undefined ? (testOnly?.execPath || process.execPath) : portable);
      if (portable !== undefined) {
        const target = await statOrNull(executable);
        if (!target || !target.isFile() || target.isSymbolicLink() || path.extname(executable).toLowerCase() !== '.exe')
          throw Error('Windows portable executable is unavailable');
      }
      const created = shell.writeShortcutLink(temporary, 'create', {
        target: executable, args: '', cwd: path.dirname(executable), description: item.title,
        icon, iconIndex: 0, appUserModelId: 'com.myeyes.app',
      });
      if (!created) throw Error('Windows launcher could not be created');
    } else if (platform === 'linux') {
      const env = testOnly?.env || process.env;
      const executable = safePath(env.APPIMAGE || testOnly?.execPath || process.execPath);
      const contents = `[Desktop Entry]\nVersion=1.0\nType=Application\nName=${desktopValue(item.title)}\nExec=${desktopExec(executable)}\nIcon=${desktopValue(icon)}\nTerminal=false\nStartupNotify=true\nStartupWMClass=com.myeyes.app\nX-Blincho-Launcher=1\n`;
      await fsp.writeFile(temporary, contents, { flag: 'wx', mode: 0o755 });
      await fsp.chmod(temporary, 0o755);
    } else {
      await fsp.writeFile(temporary, MARKER, { flag: 'wx', mode: 0o600 });
      const result = await run(execute, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_ICON_SCRIPT, temporary, icon]);
      if (result !== 'ok') throw Error('macOS launcher icon could not be confirmed');
    }
    const bytes = await regularBytes(temporary);
    if (!bytes || !bytes.length) throw Error('Launcher is empty');
    return bytes;
  }

  async function change(kind, request) {
    if (!supported) return { supported: false, exists: false };
    let paths;
    let state;
    let output;
    let temporary;
    let stateTemporary;
    let published = false;
    let journalPrepared = false;
    let oldBytes = null;
    let bytes;
    try {
      const item = selection(request);
      paths = locations();
      if (!await safeDirectory(paths.desktop, false)) throw Error('Desktop directory is unavailable');
      await reconcile(paths);
      state = await readState(paths);
      if (state) oldBytes = await ownedBytes(state);
      if (kind === 'update' && (!state || !oldBytes))
        return { supported: true, ...(state ? { path: state.path } : {}), exists: false };
      output = path.join(paths.desktop, `${item.title}${extension}`);
      if (output !== state?.path || !oldBytes) {
        if (await statOrNull(output)) throw Error('A file with the launcher name already exists');
      }
      if (!await safeDirectory(paths.userData, false)) throw Error('Application data directory is unavailable');
      await safeDirectory(paths.directory, true);
      const icon = await imageFile(paths, item.mask);
      temporary = path.join(paths.desktop, `.blincho-launcher-${randomUUID()}${extension}`);
      // Electron's native API creates its output itself. Reserve its unique name first.
      if (platform === 'win32') await fsp.writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
      bytes = await stageShortcut(temporary, icon, item);
      const record = { format: 'com.myeyes.app.desktop-launcher', version: 1, platform, filename: path.basename(output), bytes: bytes.toString('base64') };
      stateTemporary = path.join(paths.directory, `.state-${randomUUID()}`);
      await fsp.writeFile(stateTemporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      // Recheck the old file after staging, before touching any Desktop entry.
      if (oldBytes && !(await ownedBytes(state))) return { supported: true, path: state.path, exists: false };
      const journal = { format: 'com.myeyes.app.desktop-launcher-transaction', version: 1,
        next: record, previous: state ? stateRecord(state) : null,
        previousIdentity: oldBytes ? identityOf(await fsp.lstat(state.path, { bigint: true })) : null,
        previousStateIdentity: state ? identityOf(await fsp.lstat(paths.state, { bigint: true })) : null,
        stage: path.basename(temporary), stageIdentity: identityOf(await fsp.lstat(temporary, { bigint: true })),
        stateTemporary: path.basename(stateTemporary), stateIdentity: identityOf(await fsp.lstat(stateTemporary, { bigint: true })) };
      const journalTemporary = path.join(paths.directory, `.transaction-${randomUUID()}`);
      try {
        await fsp.writeFile(journalTemporary, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 });
        if (await statOrNull(paths.journal)) throw Error('A launcher transaction is already pending');
        await fsp.rename(journalTemporary, paths.journal);
      } finally { await fsp.unlink(journalTemporary).catch(() => {}); }
      journalPrepared = true;
      if (oldBytes) {
        const current = await regularBytes(state.path, MAX_FILE, 1, journal.previousIdentity);
        if (!current) {
          await reconcile(paths);
          journalPrepared = false; temporary = null; stateTemporary = null;
          return { supported: true, path: state.path, exists: false };
        }
        if (!current.equals(oldBytes)) throw Error('Owned launcher was changed outside Blincho');
      }
      if (output === state?.path && oldBytes) await fsp.rename(temporary, output);
      else await fsp.link(temporary, output);
      published = true;
      // Reconciliation commits ownership first, then removes only journaled
      // staging links and the exact previous owned inode. It is restartable.
      await reconcile(paths);
      temporary = null;
      stateTemporary = null;
      journalPrepared = false;
      if (platform === 'linux') {
        try { await run(execute, '/usr/bin/gio', ['set', output, 'metadata::trusted', 'true']); } catch { /* Desktop support varies. */ }
      }
      return { supported: true, path: output, exists: true };
    } catch (error) {
      if (journalPrepared && !published) {
        try {
          await reconcile(paths);
          journalPrepared = false; temporary = null; stateTemporary = null;
        } catch { /* Keep unsafe or incomplete records intact for the next operation. */ }
      }
      // Keep a prepared transaction intact after an I/O error. The next operation
      // reconciles its exact bytes and inode before strict ownership inspection.
      let exists = false;
      const reportedPath = published ? output : state?.path;
      try { exists = Boolean(reportedPath && await regularBytes(reportedPath)); } catch { /* unsafe is not owned */ }
      return { supported: true, ...(reportedPath ? { path: reportedPath } : {}), exists,
        error: typeof error?.message === 'string' ? error.message : 'Launcher could not be updated' };
    } finally {
      if (temporary && !journalPrepared) await fsp.unlink(temporary).catch(() => {});
      if (stateTemporary && !journalPrepared) await fsp.unlink(stateTemporary).catch(() => {});
    }
  }

  async function inspect(reveal) {
    if (!supported) return { supported: false, exists: false };
    let state;
    try {
      const paths = locations();
      if (!await safeDirectory(paths.desktop, false)) throw Error('Desktop directory is unavailable');
      await reconcile(paths);
      state = await readState(paths);
      if (!state) return { supported: true, exists: false };
      const exists = Boolean(await ownedBytes(state));
      if (reveal && exists) shell.showItemInFolder(state.path);
      return { supported: true, path: state.path, exists };
    } catch (error) {
      return { supported: true, ...(state ? { path: state.path } : {}), exists: false,
        error: typeof error?.message === 'string' ? error.message : 'Launcher could not be inspected' };
    }
  }

  const serialize = operation => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };

  const enqueue = (kind, request) => {
    // Capture plain values now; a caller cannot mutate a queued request later.
    const captured = request && { mask: request.mask, name: request.name };
    return serialize(() => change(kind, captured));
  };

  return {
    create: request => enqueue('create', request),
    update: request => enqueue('update', request),
    status: () => serialize(() => inspect(false)),
    reveal: () => serialize(() => inspect(true)),
    async isShortcutFile(file) {
      if (typeof file !== 'string' || file.length > 4096 || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/u.test(file) ||
          path.extname(file).toLowerCase() !== '.blincho') return false;
      try { return Boolean((await regularBytes(file, MARKER.length))?.equals(MARKER)); } catch { return false; }
    },
  };
}

module.exports = { createShortcutController };
