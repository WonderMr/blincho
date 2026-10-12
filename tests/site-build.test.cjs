const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
test('all website languages are prerendered with complete copy, canonical links and RTL',()=>{
 execFileSync(process.execPath,['site/build.mjs'],{cwd:root});
 const appLocales=fs.readdirSync(path.join(root,'src/i18n/locales')).filter(f=>f.endsWith('.json')).sort();
 const siteLocales=fs.readdirSync(path.join(root,'site/locales')).filter(f=>f.endsWith('.json')).sort();
 assert.deepEqual(siteLocales,appLocales);
 for(const file of siteLocales){
  const lang=file.slice(0,-5); const catalog=JSON.parse(fs.readFileSync(path.join(root,'site/locales',file),'utf8'));
  const html=fs.readFileSync(path.join(root,'site-dist',lang,'index.html'),'utf8');
  assert.match(html,new RegExp(`dir="${lang==='ar'?'rtl':'ltr'}"`));
  assert.ok(html.includes(`href="https://blincho.app/${lang}/"`));
  const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  for(const match of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)<\//g)){
   const key=match[1];
   if(key==='download.version')continue;
   assert.equal(match[2],escape(catalog[key]),`${lang}/${key}`);
  }
  assert.equal((html.match(/rel="alternate"/g)||[]).length,16);
  assert.ok(!/[\u2014\u2015]|\s\u2013\s/.test(html),lang);
  assert.ok(!/https:\/\/(fonts\.googleapis|www\.google-analytics)/.test(html));
 }
});
