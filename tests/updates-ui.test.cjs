const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { React, ReactDOMClient, ReactDOM, doc, transformer } = require('./support/syntheticDom.cjs');
const rootPath = path.resolve(__dirname, '..');
function load(relative) {
  const file = path.join(rootPath, relative), module = { exports: {} };
  let source = transformer.transformSync(file, fs.readFileSync(file, 'utf8'), { jsx: { runtime: 'classic' } }).code;
  const names = [...source.matchAll(/export (?:async )?(?:const|function|class)\s+(\w+)/g)].map(m => m[1]);
  source = source.replace(/import (\w+), \{([^}]+)\} from "([^"]+)";/g, 'const $1=require("$3");const {$2}=$1;')
    .replace(/import \{([^}]+)\} from "([^"]+)";/g, 'const {$1}=require("$2");')
    .replace(/import (\w+) from "([^"]+)";/g, 'const $1=require("$2");')
    .replace(/export (async )?(const|function|class) /g, '$1$2 ') + `\nObject.assign(module.exports,{${names.join(',')}});`;
  const requireLocal = name => name === 'react' ? React : name === 'lucide-react' ? new Proxy({}, {get: () => () => null}) :
    name === '../i18n/runtime' ? {t: (key, values = {}) => key.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token), formatDate: value => value} : (()=>{ throw Error(`Unexpected import ${name}`); })();
  vm.runInNewContext(source, {module, require: requireLocal, console, window, document: doc}, {filename: file});
  return module.exports;
}
const { UpdateSettings, UpdateNotice } = load('src/components/UpdateSettings.tsx');
const { useUpdates } = load('src/utils/updates.ts');
const base = {policy:'ask',status:'available',supported:true,supportReason:null,currentVersion:'1.4.0',availableVersion:'1.4.1',skippedVersion:null,progress:null,lastCheckedAt:null,errorCode:null,installOnQuit:false,manualCheck:false,manualDownloadUrl:'https://blincho.app/#download'};
const props = node => node[Object.keys(node).find(key => key.startsWith('__reactProps'))];
function harness(Component, initialProps) {
  const host=doc.createElement('div');doc.body.appendChild(host);const root=ReactDOMClient.createRoot(host);
  const render = p => ReactDOM.flushSync(()=>root.render(React.createElement(Component,p)));
  render(initialProps);
  return {host,render,button: label => host.querySelectorAll('button').find(node=>node.textContent===label),
    click(label) {const node=this.button(label);assert(node,label);ReactDOM.flushSync(()=>props(node).onClick());},
    close() {ReactDOM.flushSync(()=>root.unmount());doc.body.removeChild(host);}};
}
function controls(overrides={}) {return {state:{...base},pending:false,failed:false,setPolicy(){},check(){},download(){},skip(){},openDownload(){},...overrides};}
async function settle() {for(let i=0;i<5;i++){await new Promise(setImmediate);ReactDOM.flushSync(()=>{});}}

test('update notice respects policy, skip, manual check, rest and session dismissal without downloading', () => {
  let downloads=0,policy=null;
  const updates=controls({download:()=>downloads++,setPolicy:value=>policy=value});
  const h=harness(UpdateNotice,{updates,suspended:false,onSettings(){}});
  try {
    assert(h.host.textContent.includes('1.4.1'));
    for(const patch of [{policy:'off'},{policy:'auto'},{skippedVersion:'1.4.1'},{manualCheck:true},{status:'downloading'}]) {
      h.render({updates:{...updates,state:{...base,...patch}},suspended:false,onSettings(){}});assert.equal(h.host.textContent,'');
    }
    h.render({updates,suspended:true,onSettings(){}});assert.equal(h.host.textContent,'');
    h.render({updates,suspended:false,onSettings(){}});h.click('Позже');assert.equal(h.host.textContent,'');assert.equal(downloads,0);
    const next={...updates,state:{...base,availableVersion:'1.4.2'}};
    h.render({updates:next,suspended:false,onSettings(){}});h.click('Больше не показывать обновления');assert.equal(policy,'off');assert.equal(downloads,0);
    h.click('Скачать обновление');assert.equal(downloads,1);
  } finally {h.close();}
});

test('settings keep manual actions under off, disable unsupported auto, and expose cancel before quit', () => {
  let checked=0,downloaded=0,opened=0,policy;
  const updates=controls({state:{...base,policy:'off',manualCheck:true},check:()=>checked++,download:()=>downloaded++,openDownload:()=>opened++,setPolicy:value=>policy=value});
  const h=harness(UpdateSettings,{updates});
  try {
    h.click('Проверить обновления');h.click('Скачать обновление');assert.equal(checked,1);assert.equal(downloaded,1);
    h.render({updates:{...updates,state:{...base,supported:false,status:'manual'}}});
    assert(h.host.querySelectorAll('option').find(node=>node.getAttribute('value')==='auto').getAttribute('disabled')!==null);
    assert.equal(h.button('Скачать обновление'),undefined);h.click('Скачать с сайта');assert.equal(opened,1);
    h.render({updates:{...updates,state:{...base,status:'ready',installOnQuit:true}}});
    assert(h.host.textContent.includes('«Выйти»'));h.click('Отменить и отключить обновления');assert.equal(policy,'off');
  } finally {h.close();}
});

test('update hook ignores stale initial and command responses after newer push events and cleans subscription', async () => {
  let resolveInitial, resolveCheck, listener, removed=0,latest;
  window.electronAPI={getUpdateState:()=>new Promise(resolve=>resolveInitial=resolve),onUpdateState:callback=>{listener=callback;return()=>removed++;},checkForUpdates:()=>new Promise(resolve=>resolveCheck=resolve)};
  function Capture(){latest=useUpdates();return null;}
  const h=harness(Capture,{});
  try {
    await settle();ReactDOM.flushSync(()=>listener({...base,policy:'off'}));resolveInitial({...base,policy:'auto'});await settle();assert.equal(latest.state.policy,'off');
    let command;ReactDOM.flushSync(()=>command=latest.check());await settle();
    ReactDOM.flushSync(()=>listener({...base,status:'ready',installOnQuit:true}));resolveCheck({...base,status:'checking'});await command;await settle();assert.equal(latest.state.status,'ready');assert.equal(latest.pending,false);
  } finally {h.close();window.electronAPI=undefined;}
  assert.equal(removed,1);
});
