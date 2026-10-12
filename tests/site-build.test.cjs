const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const os=require('node:os');
test('all website languages are prerendered with complete copy, canonical links and RTL',()=>{
 execFileSync(process.execPath,['site/build.mjs'],{cwd:root});
 const appLocales=fs.readdirSync(path.join(root,'src/i18n/locales')).filter(f=>f.endsWith('.json')).sort();
 const siteLocales=fs.readdirSync(path.join(root,'site/locales')).filter(f=>f.endsWith('.json')).sort();
 assert.deepEqual(siteLocales,appLocales);
 assert.equal(siteLocales.length,30);
 for(const file of siteLocales){
  const lang=file.slice(0,-5); const catalog=JSON.parse(fs.readFileSync(path.join(root,'site/locales',file),'utf8'));
  const html=fs.readFileSync(path.join(root,'site-dist',lang,'index.html'),'utf8');
  assert.match(html,new RegExp(`dir="${['ar','fa','ur','he'].includes(lang)?'rtl':'ltr'}"`));
  assert.ok(html.includes(`href="https://blincho.app/${lang}/"`));
  const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  for(const match of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)<\//g)){
   const key=match[1];
   if(key==='download.version')continue;
   assert.equal(match[2],escape(catalog[key]),`${lang}/${key}`);
  }
  assert.equal((html.match(/rel="alternate"/g)||[]).length,31);
  const choices=[...html.matchAll(/<option value="([^"]+)"/g)].map(match=>match[1]+'.json').sort();
  assert.deepEqual(choices,siteLocales,lang+' language picker');
  assert.ok(!/[\u2014\u2015]|\s\u2013\s/.test(html),lang);
  assert.ok(!/https:\/\/(fonts\.googleapis|www\.google-analytics)/.test(html));
 }
});
test('verified release date renders actionable content',()=>{
 const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'blincho-site-build-'));
 try{
  fs.cpSync(path.join(root,'site'),path.join(isolated,'site'),{recursive:true});
  fs.mkdirSync(path.join(isolated,'scripts'));
  for(const file of ['update-feed.mjs','release-lib.mjs']) fs.copyFileSync(path.join(root,'scripts',file),path.join(isolated,'scripts',file));
  fs.mkdirSync(path.join(isolated,'assets'));fs.copyFileSync(path.join(root,'assets/icon.png'),path.join(isolated,'assets/icon.png'));
  fs.writeFileSync(path.join(isolated,'site/releases.json'),JSON.stringify({schemaVersion:1,latest:'1.3.2',releases:[{
   version:'1.3.2',tag:'v1.3.2',publishedAt:'2026-10-12T12:00:00Z',url:'https://github.com/WonderMr/blincho/releases/tag/v1.3.2',assets:[],checksumUrl:null
  }]}));
  execFileSync(process.execPath,['site/build.mjs'],{cwd:isolated});
  const html=fs.readFileSync(path.join(isolated,'site-dist/en/index.html'),'utf8');
  assert.match(html,/<span id="release-date">Oct 12, 2026<\/span>/);
  assert.ok(html.includes('A calmer compact interface'));
 }finally{fs.rmSync(isolated,{recursive:true,force:true});}
});
