// Execute the real Vite service-worker generator and generated worker in a VM.
// Cache/fetch are controlled boundaries; browser installation remains untested.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { transformSync } = require('rolldown/utils');
const repo = path.resolve(__dirname, '..');
const configFile = path.join(repo, 'vite.config.mts');
let config;
const transformed = transformSync(configFile, fs.readFileSync(configFile, 'utf8')).code;
const code = transformed.replace(/import \{ defineConfig \} from "vite";/, 'const defineConfig=value=>value;')
  .replace(/import react from "@vitejs\/plugin-react";/, 'const react=()=>({name:"react-boundary"});')
  .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");')
  .replace('export default', 'config =').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(configFile).href));
// The generated config is retrieved explicitly, without exporting Vite internals.
const context = { require, URL };
vm.runInNewContext(code, context); config = context.config;
const workerPlugin = config.plugins.find(plugin => plugin.name === 'myeyes-offline-shell');
const bundle = { 'index.html': {}, 'assets/index-test.js': {}, 'assets/index-test.css': {} };
let emitted;
workerPlugin.generateBundle.call({ emitFile: asset => { emitted = asset; } }, {}, bundle);
assert.equal(emitted.fileName, 'sw.js');

function worker() {
  const events = new Map(), cacheData = new Map();
  const normalize = request => typeof request === 'string' ? request : request.url;
  const caches = {
    async open(name) {
      if (!cacheData.has(name)) cacheData.set(name, new Map());
      const entries = cacheData.get(name);
      return { async addAll(urls) { assert.equal(new Set(urls).size, urls.length, 'no duplicate precache URLs'); for (const url of urls) entries.set(url, { url, cached: true }); }, async match(request) { return entries.get(normalize(request)); } };
    },
    async keys() { return [...cacheData.keys()]; },
    async delete(name) { return cacheData.delete(name); },
  };
  let claimed = 0, online = true, fetches = 0;
  const self = { registration: { scope: 'https://example.test/myeyes/' }, location: { origin: 'https://example.test' }, clients: { async claim() { claimed++; } }, addEventListener: (name, callback) => events.set(name, callback) };
  vm.runInNewContext(emitted.source, { self, caches, URL, async fetch(request) { fetches++; if (!online) throw new Error('offline'); return { url: normalize(request), network: true }; } });
  return {
    cacheData, caches, get claimed() { return claimed; }, get fetches() { return fetches; }, set online(value) { online = value; },
    async lifecycle(type) { let promise; events.get(type)({ waitUntil(value) { promise = value; } }); await promise; },
    async request(url, method = 'GET', mode = 'cors') { let response; events.get('fetch')({ request: { url, method, mode }, respondWith(value) { response = value; } }); return response === undefined ? undefined : await response; },
  };
}

(async () => {
  const results = [];
  const w = worker(); await w.lifecycle('install');
  const [current] = await w.caches.keys(), cached = w.cacheData.get(current);
  for (const name of ['index.html', 'manifest.webmanifest', 'icon.png', 'favicon.png', ...Object.keys(bundle)]) assert(cached.has('https://example.test/myeyes/' + name), `${name} precached under deployment scope`);
  assert(current.startsWith('myeyes-shell-')); results.push('precache includes HTML, built chunks, manifest and icons once under deployment scope');
  await w.caches.open('myeyes-shell-old'); await w.caches.open('other-app-cache'); await w.lifecycle('activate');
  assert.equal(w.cacheData.has('myeyes-shell-old'), false); assert(w.cacheData.has('other-app-cache')); assert(w.cacheData.has(current)); assert.equal(w.claimed, 1); results.push('activation removes only previous MyEyes caches and claims clients');
  assert.equal((await w.request('https://example.test/myeyes/', 'GET', 'navigate')).network, true);
  w.online = false;
  assert.equal((await w.request('https://example.test/myeyes/deep-link', 'GET', 'navigate')).url, 'https://example.test/myeyes/index.html');
  const fetches = w.fetches; assert.equal((await w.request('https://example.test/myeyes/assets/index-test.js')).cached, true); assert.equal(w.fetches, fetches); results.push('offline navigation and built assets use the installed shell');
  assert.equal(await w.request('https://external.test/font.woff2'), undefined);
  assert.equal(await w.request('https://example.test/another-app/file.js'), undefined);
  assert.equal(await w.request('https://example.test/myeyes/action', 'POST'), undefined); results.push('external origins, out-of-scope URLs and non-GET requests bypass worker');

  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'public/manifest.webmanifest'), 'utf8'));
  const png = fs.readFileSync(path.join(repo, 'public/icon.png'));
  assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
  assert(manifest.icons.some(icon => icon.src === './icon.png' && icon.sizes === '512x512'));
  for (const icon of manifest.icons) assert(fs.existsSync(path.resolve(repo, 'public', icon.src))); results.push('manifest icon paths exist and PNG dimensions match 512x512 declaration');

  const mainFile = path.join(repo, 'src/main.tsx');
  function register(prod, electron, protocol) {
    let registered = null, listener;
    const source = transformSync(mainFile, fs.readFileSync(mainFile, 'utf8'), { jsx: { runtime: 'classic' } }).code
      .replace(/^import\s+[^\n]*;\n/gm, '').replaceAll('import.meta.env.PROD', String(prod)).replaceAll('import.meta.env.BASE_URL', '"/myeyes/"');
    const window = { electronAPI: electron ? {} : undefined, addEventListener(name, callback) { assert.equal(name, 'load'); listener = callback; } };
    vm.runInNewContext(source, { window, location: { protocol }, navigator: { serviceWorker: { async register(url) { registered = url; } } }, document: { getElementById: () => null }, console,
      loadSettings: () => ({ theme: 'system', colorPalette: 'sage' }),
      applyAppearance: (mode, palette) => { assert.equal(mode, 'system'); assert.equal(palette, 'sage'); },
    });
    listener?.(); return registered;
  }
  assert.equal(register(true, false, 'https:'), '/myeyes/sw.js');
  assert.equal(register(false, false, 'https:'), null); assert.equal(register(true, true, 'file:'), null); assert.equal(register(true, false, 'file:'), null);
  results.push('service worker registration uses deployment base and production browser-only gate');
  console.log(JSON.stringify({ passed: results.length, results, limitation: 'VM cache/fetch logic; PWA installation and browser offline navigation require browser E2E' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
