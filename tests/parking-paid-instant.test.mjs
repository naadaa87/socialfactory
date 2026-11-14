import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/parking-fixture.mjs';
import {automaticParking,ensureAutomation,automationSign} from '../functions/_lib/parking-automation.js';
import {runCycle} from '../deploy/amano-server/worker.mjs';
import {DISCOUNTS} from '../deploy/amano-server/client.mjs';

async function setup(t) {
 const f=await fixture(t);
 f.env.ALIGO_RELAY_SECRET='local-socialfactory-payment-secret-at-least-32';
 await ensureAutomation(f.env);
 f.db.exec('UPDATE parking_automation_settings SET enabled=1');
 const call=async(action,data={})=>{
  const body=JSON.stringify({action,...data,time:Date.now()});
  const response=await automaticParking({env:f.env,request:new Request('https://local.test/automation',{
   method:'POST',headers:{'X-Socialfactory-Signature':await automationSign(f.env.ALIGO_RELAY_SECRET,body)},body})});
  return {status:response.status,body:await response.json()};
 };
 return {...f,call};
}

test('결제 알림 조회는 결제일 기준으로 통합 결제 1건을 반환하고 환불·미결제·타 상품·과거 건을 제외',async t=>{
 const f=await setup(t),o=await f.purchase(f.body({date:'2026-11-05',vehicles:[
  {ticket:'1h',plate:'123가4567',plateConfirm:'123가4567'},
  {ticket:'daily',plate:'45나6789',plateConfirm:'45나6789'}]}));
 const request={since:'2026-11-04 00:00:00'};
 assert.equal((await f.call('payments',request)).body.payments.length,0);
 await f.cb(o);
 // SQLite uses its own clock, independent of this fixture's Date.now stub.
 f.db.prepare('UPDATE orders SET paid_at=? WHERE oid=?').run('2026-11-04 11:00:00',o.oid);
 const feed=(await f.call('payments',request)).body;
 assert.equal(feed.payments.length,1);assert.equal(feed.payments[0].amount,34000);
 assert.equal(feed.payments[0].vehicles.length,2);assert(!JSON.stringify(feed).includes('01012345678'));
 assert.equal((await f.call('payments',{...request,after:feed.next})).body.payments.length,0);
 assert.equal((await f.call('payment',{...request,oid:o.oid})).body.payments.length,1);
 assert.equal((await f.call('payments',{since:'2026-11-05 00:00:00'})).body.payments.length,0);
 f.db.exec('UPDATE payapp_payments SET refunded_amount=1000');
 assert.equal((await f.call('payments',request)).body.payments.length,0);
 assert.equal((await f.call('payments',{since:'invalid'})).status,400);
});

test('수동 입차 요청 없이 실제 입차된 일일권 2대를 무료 1시간→일일권 순서로 등록하고 재호출은 중복 차감하지 않음',async t=>{
 const f=await setup(t),o=await f.purchase(f.body({vehicles:[
  {ticket:'daily',plate:'123가4567',plateConfirm:'123가4567'},
  {ticket:'daily',plate:'45나6789',plateConfirm:'45나6789'}]}));
 await f.cb(o);
 const rows=f.db.prepare('SELECT * FROM parking_orders ORDER BY rowid').all();
 const memory={},store={read:key=>memory[key]?structuredClone(memory[key]):null,
  save:(key,value)=>memory[key]=structuredClone(value)};
 let balance=244000;
 const registrations=[];
 const state=new Map(rows.map((p,i)=>[p.plate,{entry:{id:String(i+1),plate:p.plate,
  cardType:'0',entryAt:'2026-11-04T10:00:00',out:false},
  types:Object.entries(DISCOUNTS).map(([id,v])=>({id,...v})),discounts:[]}]));
 const site=async(action,data={})=>{
  const response=await f.call(action,data);assert.equal(response.status,200,JSON.stringify(response));return response.body;
 };
 const client={credentials:{username:'local-account'},login:async()=>{},
  entries:async plate=>[state.get(plate).entry],
  detail:async entry=>({...structuredClone(state.get(entry.plate)),balance}),
  register:async(entry,code,oid)=>{
   const value=DISCOUNTS[code];balance-=value.price;registrations.push({plate:entry.plate,code});
   state.get(entry.plate).discounts.push({id:String(registrations.length),code,...value,
    charged:value.price,entryId:entry.id,memo:oid,account:'local-account'});
  }};
 assert.equal((await runCycle({site,client,store})).processed,2);
 assert.equal(balance,204000);
 for(const row of rows)assert.deepEqual(registrations.filter(r=>r.plate===row.plate).map(r=>r.code),['1','10']);
 assert(f.db.prepare('SELECT status,arrival_at FROM parking_orders').all().every(p=>p.status==='applied'&&p.arrival_at));
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM parking_events WHERE kind='arrival'").get().n,2);
 assert.equal((await runCycle({site,client,store})).processed,0);assert.equal(registrations.length,4);
});

test('미입차·취소 문의·다른 결제의 차량을 즉시 등록 대상으로 섞지 않음',async t=>{
 const f=await setup(t),a=await f.purchase(),b=await f.purchase(f.body({plate:'45나6789',plateConfirm:'45나6789'}));
 await f.cb(a);await f.cb(b);
 let feed=await f.call('orders',{payment_oid:a.oid});assert.deepEqual(feed.body.items.map(p=>p.oid),[a.oid]);
 const site=async(action,data={})=>(await f.call(action,data)).body,memory={};
 const result=await runCycle({site,client:{login:async()=>{},entries:async()=>[]},
  store:{read:key=>memory[key],save:(key,value)=>memory[key]=value}});
 assert.equal(result.waiting,2);assert.equal(result.processed,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM parking_automation_claims').get().n,0);
 await f.act(a,'request',{reason:'차량번호 확인'});
 assert.equal((await f.call('orders',{payment_oid:a.oid})).body.items.length,0);
});

test('입차 요청 전 발생한 등록 오류도 확인 필요로 보류되어 반복 자동 차감을 막음',async t=>{
 const f=await setup(t),o=await f.purchase();await f.cb(o);
 const result=await f.call('issue',{oid:o.oid,data:{memo:'아마노 잔액 부족'}});
 assert.equal(result.status,200);assert.equal(f.db.prepare('SELECT status FROM parking_orders').get().status,'issue');
 assert.equal((await f.call('orders')).body.items.length,0);
});


test('결제 승인 응답의 백그라운드 작업은 관리자 문자와 즉시 등록을 함께 깨운다',async t=>{
 const f=await setup(t),o=await f.purchase(),calls=[],jobs=[];
 const original=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='https://relay.naranhistory.com/socialfactory/amano'){
   calls.push(JSON.parse(options.body));return Response.json({ok:true});
  }
  return original(url,options);
 });
 const {onRequestPost:feedback}=await import('../functions/api/pay/payapp/feedback.js');
 // Reuse the fixture's signed callback payload while capturing waitUntil.
 const request=await (async()=>{
  // A valid duplicate paid callback still safely wakes the idempotent server.
  await f.cb(o);
  const {kstStamp}=await import('../functions/_lib/payapp.js');
  const {sha256Hex}=await import('../functions/_lib/auth.js');
  const pg=f.db.prepare('SELECT * FROM payapp_payments WHERE oid=?').get(o.oid),date=kstStamp();
  return new Request('https://socialfactory.test/api/pay/payapp/feedback',{method:'POST',body:new URLSearchParams({
   userid:f.env.PAYAPP_USERID,linkkey:f.env.PAYAPP_LINKKEY,linkval:f.env.PAYAPP_LINKVAL,responsedate:date,
   hash:await sha256Hex(f.env.PAYAPP_USERID+date+f.env.PAYAPP_REQUESTKEY),pay_state:'4',mul_no:pg.mul_no,
   price:String(o.amount),var1:o.oid,var2:pg.nonce,pay_type:'1'})});
 })();
 assert.equal(await(await feedback({env:f.env,request,waitUntil:job=>jobs.push(job)})).text(),'SUCCESS');
 await Promise.all(jobs);
 assert.deepEqual(calls.map(c=>c.action).sort(),['paid-notices','process']);
 assert(calls.every(c=>c.oid===o.oid));
});
