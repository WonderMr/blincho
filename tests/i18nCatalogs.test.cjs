const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSync } = require('rolldown/utils');
const repo = path.resolve(__dirname, '..');
const directory = path.join(repo, 'src/i18n/locales');
const ru = JSON.parse(fs.readFileSync(path.join(directory, 'ru.json')));
const languages = ['en','ru','es','fr','de','it','pt','zh','ja','ko','ar','hi','tr','pl','uk','hy','bn','id','vi','th','fa','ur','he','nl','sv','cs','ro','el','ta','te'];
const tokens = (value, pattern) => [...value.matchAll(pattern)].map(match=>match[0]).sort();

test('all thirty offline catalogues completely translate every source key and preserve interpolation and links', () => {
  assert(Object.keys(ru).length >= 381, 'existing catalogue coverage must not shrink');
  for (const language of languages) {
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, language+'.json')));
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(ru).sort(), language);
    for (const [key,value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${language}: ${key}`);
      assert(value.trim(), `${language}: empty ${key}`);
      assert(!/[\u2014\u2015]|\s\u2013\s/.test(value), `${language}: forbidden prose dash ${key}`);
      assert.deepEqual(tokens(value,/\{\w+\}/g),tokens(key,/\{\w+\}/g),`${language}: placeholders ${key}`);
      assert.deepEqual(tokens(value,/https?:\/\/[^\s;]*[^\s;.,)]/g),tokens(key,/https?:\/\/[^\s;]*[^\s;.,)]/g),`${language}: URLs ${key}`);
      if (!['ru','uk'].includes(language)) assert(!/[А-Яа-яЁё]/.test(value), `${language}: untranslated Russian: ${key}`);
    }
  }
});

test('every static translation call in production source is present in the canonical catalogue', () => {
  function walkFiles(directory) {
    return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory() ? walkFiles(path.join(directory,entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory,entry.name)] : []);
  }
  const missing=[];
  for(const file of walkFiles(path.join(repo,'src'))) {
    const ast=parseSync(file,fs.readFileSync(file,'utf8')).program;
    function visit(node) {
      if(!node||typeof node!=='object')return;
      if(node.type==='CallExpression'&&['t','translate'].includes(node.callee?.name)&&typeof node.arguments[0]?.value==='string') {
        const source=node.arguments[0].value;
        if(!Object.hasOwn(ru,source))missing.push(`${path.relative(repo,file)}: ${source}`);
      }
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    }
    visit(ast);
  }
  assert.deepEqual(missing,[]);
});
