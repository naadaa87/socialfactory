import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/parking-fixture.mjs';
import {runParkingQueue} from '../functions/_lib/parking-notify.js';
for(const ticket of ['daily','24h'])test(ticket+' 알림톡은 결제·입차·완료마다 상품과 종료 시각을 구분하고 24시간은 결제 시각을 쓰지 않음',async t=>{
 const f=await fixture(t),o=await f.purchase(f.body({ticket}));await f.cb(o);await runParkingQueue(f.env);
 const sent=()=>f.calls.filter(c=>c.form.has('message_1')).map(c=>c.form.get('message_1'));
 const initial=sent();assert.equal(initial.length,1);
 if(ticket==='daily'){assert.match(initial[0],/당일권 \(자정 종료\)/);assert.match(initial[0],/적용 종료: 2026-11-04 23:59 \(한국시간\)/);}
 else{assert.match(initial[0],/24시간권 \(입차 후 24시간\)/);assert.match(initial[0],/적용 종료: 입차 시각 확인 후 확정/);assert.doesNotMatch(initial[0],/적용 종료: 2026-/);}
 assert.equal((await f.act(o,'arrival')).status,200);
 assert.equal((await f.operator(o,'claim',{entryId:'confirmed-entry',entryAt:'2026-11-04T10:25',plateConfirm:'123가4567',confirmEntry:true})).status,200);
 await runParkingQueue(f.env);
 assert.equal((await f.operator(o,'complete',{confirmApplied:true})).status,200);await runParkingQueue(f.env);
 const messages=sent();assert.equal(messages.length,3);
 const expected=ticket==='daily'?'2026-11-04 23:59':'2026-11-05 10:25';
 for(const m of messages.slice(1)){assert(m.includes('적용 종료: '+expected+' (한국시간)'));assert(m.length<=1000);}
 assert.equal((await runParkingQueue(f.env)).sent,0);assert.equal(sent().length,3);
});
