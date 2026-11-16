import test from 'node:test';import assert from 'node:assert/strict';import{fixture}from'./helpers/parking-fixture.mjs';import{onRequestGet as config}from'../functions/api/parking/config.js';import{onRequestPost as create}from'../functions/api/parking/create.js';import{runParkingQueue}from'../functions/_lib/parking-notify.js';import{onRequestGet as detail}from'../functions/api/orders/status.js';
test('당일권과 24시간권 가격·시간을 구분하고 미연결 24시간권은 PG 요청 전에 차단',async t=>{
 const f=await fixture(t),c=await(await config({env:f.env})).json();let daily=c.tickets.find(t=>t.id==='daily'),rolling=c.tickets.find(t=>t.id==='24h');assert.equal(daily.price,30000);assert.match(daily.label,/자정 종료/);assert.match(daily.description,/23:59/);assert.equal(rolling.price,40000);assert.equal(rolling.available,false);assert.match(rolling.label,/입차 후 24시간/);
 const before=f.calls.filter(c=>String(c.url).includes('payapp.kr')).length,r=await create({env:f.env,request:f.req('/api/parking/create',f.body({ticket:'24h'}))});assert.equal(r.status,400);assert.equal(f.calls.filter(c=>String(c.url).includes('payapp.kr')).length,before);
 const o=await f.purchase(f.body({ticket:'daily'}));await f.cb(o);await runParkingQueue(f.env);
 const msg=f.calls.find(c=>c.form.get('message_1'));assert.match(msg.form.get('message_1'),/당일권 \(자정 종료\)/);
 const receipt=await(await detail({env:f.env,request:f.req('/api/orders/status?oid='+o.oid+'&t='+o.token)})).json();assert.match(receipt.order.parking.ticketDescription,/23:59/);
});
