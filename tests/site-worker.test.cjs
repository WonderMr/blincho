const {test}=require('node:test');
const assert=require('node:assert/strict');
test('canonical aliases preserve path and query without calling assets',async()=>{
 const worker=(await import('../site/worker.mjs')).default;
 for(const host of ['blincho.com','www.blincho.com','www.blincho.app']){
  const r=await worker.fetch(new Request(`https://${host}/ru/?theme=dark`),{});
  assert.equal(r.status,308);assert.equal(r.headers.get('location'),'https://blincho.app/ru/?theme=dark');
 }
});
test('assets keep errors and reject writes',async()=>{
 const worker=(await import('../site/worker.mjs')).default;
 const env={ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
 const r=await worker.fetch(new Request('https://blincho.app/missing'),env);
 assert.equal(r.status,404); assert.equal(await r.text(),'missing');
 assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await worker.fetch(new Request('https://blincho.app/',{method:'POST'}),env)).status,405);
});
