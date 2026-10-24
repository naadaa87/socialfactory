import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../tools/spacecloud-collector/background.js',import.meta.url),'utf8');
function harness(){let saved={},clicked,updated,handler;const updates=[],badges=[],injected=[];
 const chrome={storage:{session:{async get(k){return {[k]:saved[k]};},async set(x){Object.assign(saved,x);},async remove(k){delete saved[k];}}},action:{onClicked:{addListener(fn){clicked=fn;}},async setBadgeText(x){badges.push(x);}},tabs:{onUpdated:{addListener(fn){updated=fn;}},async update(id,x){updates.push([id,x]);}},scripting:{async executeScript(x){injected.push(x);}},runtime:{onMessage:{addListener(fn){handler=fn;}}}};
 vm.runInNewContext(code,{chrome,URL,console});return {saved,updates,badges,injected,start:tab=>clicked(tab),updated:(id,x)=>updated(id,x),message:(m,url='https://partner.spacecloud.kr/report/draft?page=1')=>new Promise(resolve=>handler(m,{url,tab:{id:7}},resolve))};}
test('collector preserves filters, traverses pages, deduplicates IDs and removes temporary payment data',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?space=123&page=2'});assert.match(h.updates[0][1].url,/page=1/);assert.match(h.updates[0][1].url,/space=123/);
 await h.updated(7,{status:'complete'});assert.equal(h.injected.length,1);
 const row={reservation_id:'123',amount:40000,refund_amount:0};
 const a=await h.message({type:'page',rows:[row],next:'/report/draft?space=123&page=2'},'https://partner.spacecloud.kr/report/draft?space=123&page=1');assert(a.next);
 const b=await h.message({type:'page',rows:[row,{...row,reservation_id:'456'}],next:null},'https://partner.spacecloud.kr/report/draft?space=123&page=2');assert.equal(b.file.rows.length,2);assert.equal(b.file.pages,2);assert.equal(h.saved.job,undefined);
});
test('collector fails closed on page loops, changed filters and conflicting payment values',async()=>{
 for(const kind of ['loop','filter','amount']){
  const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
  if(kind==='amount')await h.message({type:'page',rows:[{reservation_id:'1',amount:10}],next:'/report/draft?page=2'});
  const m=kind==='loop'?{type:'page',rows:[],next:'/report/draft?page=1'}:kind==='filter'?{type:'page',rows:[],next:'/report/draft?space=changed&page=2'}:{type:'page',rows:[{reservation_id:'1',amount:20}],next:null};
  const r=await h.message(m,kind==='amount'?'https://partner.spacecloud.kr/report/draft?page=2':undefined);assert.equal(r.ok,false);assert.equal(h.saved.job,undefined);
 }
});

test('equal reservation fields in different property order are not treated as changed payments',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
 await h.message({type:'page',rows:[{reservation_id:'1',amount:40000,refund_amount:0}],next:'/report/draft?page=2'});
 const r=await h.message({type:'page',rows:[{amount:40000,refund_amount:0,reservation_id:'1'}],next:null},'https://partner.spacecloud.kr/report/draft?page=2');
 assert.equal(r.ok,true);assert.equal(r.file.rows.length,1);
});

test('collector shares prior page identity and rejects a stale table sent as the next page',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
 await h.message({type:'page',rows:[{reservation_id:'1',amount:10}],signature:'1|2',next:'/report/draft?page=2'});
 const state=await h.message({type:'state'},'https://partner.spacecloud.kr/report/draft?page=2');assert.equal(state.previousSignature,'1|2');
 const result=await h.message({type:'page',rows:[],signature:'1|2',next:null},'https://partner.spacecloud.kr/report/draft?page=2');assert.equal(result.ok,false);assert.match(result.error,/이전 페이지/);assert.equal(h.saved.job,undefined);
});
