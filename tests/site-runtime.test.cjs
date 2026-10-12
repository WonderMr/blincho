const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../site/site.js'),'utf8');
function run({pathname='/',language='ru-RU',stored={},denied=false}={}){
 const events={};const attrs={};const calls=[];const data={...stored};
 const button={dataset:{system:'System theme',light:'Light theme',dark:'Dark theme'},setAttribute:(key,value)=>attrs[key]=value,removeAttribute:key=>delete attrs[key],addEventListener:(name,fn)=>events.theme=fn};
 const select={value:'',addEventListener:(name,fn)=>events.language=fn};
 const document={documentElement:{lang:'en',dataset:{}},querySelector:s=>s==='#theme-toggle'?button:select};
 const location={pathname,search:'?test=1',hash:'#download',replace:value=>calls.push(value),assign:value=>calls.push(value)};
 const localStorage={getItem:key=>{if(denied)throw Error('denied');return data[key]??null;},setItem:(key,value)=>{if(denied)throw Error('denied');data[key]=value;}};
 vm.runInNewContext(script,{document,location,navigator:{languages:[language],language},localStorage});
 return {events,attrs,calls,data,document,select,button};
}
test('root detects supported base locale while explicit localized URL wins',()=>{
 assert.deepEqual(run().calls,['/ru/?test=1#download']);
 assert.deepEqual(run({language:'pt-BR'}).calls,['/pt/?test=1#download']);
 assert.deepEqual(run({language:'xx'}).calls,['/en/?test=1#download']);
 assert.deepEqual(run({stored:{'blincho-site-language':'de'}}).calls,['/de/?test=1#download']);
 assert.deepEqual(run({pathname:'/en/'}).calls,[]);
});
test('theme cycles system, light, dark and system; storage failure does not break controls',()=>{
 const r=run({pathname:'/en/',denied:true});
 r.events.theme();assert.equal(r.document.documentElement.dataset.theme,'light');
 r.events.theme();assert.equal(r.document.documentElement.dataset.theme,'dark');
 r.events.theme();assert.equal(r.document.documentElement.dataset.theme,undefined);
 assert.equal(r.attrs['aria-label'],'System theme');
 r.select.value='ar';r.events.language();assert.deepEqual(r.calls,['/ar/?test=1#download']);
});
