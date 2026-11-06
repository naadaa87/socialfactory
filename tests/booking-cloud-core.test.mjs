import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { BOOKING_RATES,prepareBookings,calculateBookingAmount,validateBooking,bookingAvailability,applyBookingPayment,getBooking } from '../functions/_lib/booking.js';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { onRequestGet as availability } from '../functions/api/booking/availability.js';
import { onRequestGet as list,onRequestPatch as update } from '../functions/api/admin/booking-requests.js';

function setup(config) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const DB = { prepare(sql) {
    let args = [];
    const statement = {bind(...values) { args = values; return statement; },
      async all() { return {results:sqlite.prepare(sql).all(...args)}; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { return {meta:sqlite.prepare(sql).run(...args)}; }};
    return statement;
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results=[]; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) {sqlite.exec('ROLLBACK'); throw error;}
  }};
  return {DB,sqlite,ADMIN_KEY:'test-admin-bookings',SPACECLOUD_ICAL_FEEDS:config ? JSON.stringify(config) : undefined};
}
const day = () => addDaysIso(kstToday(),10);
const value = (extra={}) => ({submissionId:crypto.randomUUID(),room:'r1',date:day(),start_min:600,end_min:720,people:8,name:'예약 담당자',phone:'01012345678',email:'',company:'테스트 단체',purpose:'meeting',purpose_detail:'팀 회의',requests:'모니터 사용',consent:true,...extra});
const request = (body,path='/api/booking/requests',admin=false) => new Request('https://example.test'+path,{method:'POST',headers:{'content-type':'application/json',origin:'https://example.test',...(admin ? {authorization:'Bearer test-admin-bookings'} : {})},body:JSON.stringify(body)});
const send = async (env,body=value()) => { const response = await submit({request:request(body),env}); return {status:response.status,data:await response.json()}; };
const insertReservation = (env,{code='RTEST',room='r1',date=day(),start=660,end=780}={}) => env.sqlite.prepare(`INSERT INTO reservations
  (code,status,space,date,start_min,end_min,customer_name,amount,pay_method,pay_status) VALUES (?,'confirmed',?,?,?,?,'기존 예약자',20000,'card_offline','paid')`).run(code,room,date,start,end);
const admin = (body,env) => update({request:request(body,'/api/admin/booking-requests',true),env});

test('server pricing handles half hours, midnight, weekends and previous-night holiday rules',()=>{
  assert.equal(calculateBookingAmount({room:'r1',date:'2026-11-06',start_min:690,end_min:810}),37500); // Friday 11:30~13:30
  assert.equal(calculateBookingAmount({room:'r1',date:'2026-11-06',start_min:1380,end_min:1500}),35000); // Fri night to Sat early uses weekday
  assert.equal(calculateBookingAmount({room:'r1',date:'2026-11-07',start_min:1380,end_min:1500}),50000); // Sat to Sunday
  assert.equal(calculateBookingAmount({room:'r3',date:'2026-12-25',start_min:720,end_min:840}),40000);
  assert.equal(BOOKING_RATES.rooms.r3.max,16);
});

test('validation rejects impossible dates, fractional/negative times, bad capacity and missing consent',()=>{
  const base=value();
  for (const [extra,field] of [[{date:'2027-02-30'},'date'],[{date:addDaysIso(kstToday(),-1)},'date'],[{start_min:610},'start_min'],[{start_min:600.5},'start_min'],[{end_min:660},'end_min'],[{end_min:2070},'end_min'],[{people:37},'people'],[{people:0},'people'],[{phone:'123'},'phone'],[{consent:false},'consent'],[{purpose:'other',purpose_detail:''},'purpose_detail']]) assert.equal(validateBooking({...base,...extra}).field,field);
  assert(validateBooking({...base,start_min:1380,end_min:1500}).value);
});

test('submission is idempotent, computes amount on server and does not confirm or create a sale',async()=>{
  const env=setup(),body=value({amount:1});
  const first=await send(env,body),second=await send(env,body);
  assert.equal(first.status,200);assert.equal(first.data.status,'requested');assert.equal(first.data.amount,calculateBookingAmount(body));
  assert.equal(first.data.code,second.data.code);assert.equal(second.data.duplicate,true);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM booking_requests').get().n,1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
  const reused=await send(env,{...body,people:3});assert.equal(reused.status,409);assert.equal(reused.data.error,'submission-reused');
});

test('atomic conflict guards handle simultaneous requests, independent rooms and adjacent boundaries',async()=>{
  const env=setup();
  const outcomes=await Promise.all([send(env),send(env)]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  assert.equal((await send(env,value({start_min:720,end_min:840}))).status,200);
  assert.equal((await send(env,value({room:'r2'}))).status,200);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM booking_requests').get().n,3);
});

test('both previous-day and next-day overlaps are rejected including admin writes after a request',async()=>{
  const env=setup();
  assert.equal((await send(env,value({start_min:1380,end_min:1500}))).status,200);
  assert.equal((await send(env,value({date:addDaysIso(day(),1),start_min:0,end_min:120}))).status,409);
  assert.throws(()=>insertReservation(env,{date:addDaysIso(day(),1),start:30,end:150}),/booking-conflict/);
  assert.doesNotThrow(()=>insertReservation(env,{date:addDaysIso(day(),1),start:60,end:180}));
  const env2=setup();await prepareBookings(env2);insertReservation(env2,{date:addDaysIso(day(),1),start:0,end:120});
  assert.equal((await send(env2,value({start_min:1380,end_min:1500}))).status,409);
});

test('expired requested holds release their times while payment-issued requests retain the hold',async()=>{
  const env=setup(),first=await send(env);
  env.sqlite.prepare("UPDATE booking_requests SET expires_at=datetime('now','+9 hours','-1 minute') WHERE code=?").run(first.data.code);
  const second=await send(env);assert.equal(second.status,200);
  assert.equal((await getBooking(env,first.data.code)).status,'expired');
  env.sqlite.prepare("UPDATE booking_requests SET status='awaiting_payment',payment_status='pending',expires_at=datetime('now','+9 hours','-1 minute') WHERE code=?").run(second.data.code);
  assert.equal((await send(env)).status,409);
});

test('public availability exposes only merged time ranges and privacy-safe external status',async()=>{
  const env=setup();await send(env,value({start_min:1380,end_min:1500,name:'PRIVATE PERSON',phone:'01077779999'}));
  const response=await availability({request:new Request(`https://example.test/api/booking/availability?room=r1&date=${addDaysIso(day(),1)}`),env});
  assert.equal(response.status,200);const body=await response.json();
  assert(body.blocked.some(r=>r.start_min===-60 && r.end_min===60));
  assert.equal(body.capacity,36);assert.equal(body.external.configured,false);assert.equal(body.external.stale,true);
  assert(!JSON.stringify(body).includes('PRIVATE'));assert(!JSON.stringify(body).includes('01077779999'));
  assert(body.blocked.every(r=>Object.keys(r).sort().join(',')==='end_min,start_min'));
});

test('external feed blocks occupied times and failure warns while keeping the last known blocks',async()=>{
  const env=setup({r1:'https://api.spacecloud.kr/partner/reservations/ical?product_id=1&ical_uid=testtoken'});
  const compact=day().replace(/-/g,'');let fail=false;
  const old=globalThis.fetch;
  globalThis.fetch=async()=>{if(fail)throw new Error('offline');return new Response(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:private\r\nDTSTART;TZID=Asia/Seoul:${compact}T100000\r\nDTEND;TZID=Asia/Seoul:${compact}T120000\r\nSUMMARY:PRIVATE CUSTOMER\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);};
  try {
    assert.equal((await send(env)).status,409);
    fail=true;await prepareBookings(env);
    const data=await bookingAvailability(env,'r1',day(),{force:true});
    assert(data.blocked.some(r=>r.start_min===600&&r.end_min===720));assert.equal(data.external.stale,true);
    assert(!JSON.stringify(data).includes('PRIVATE'));
  } finally {globalThis.fetch=old;}
});

test('public endpoint rejects cross-origin writes and repeated abuse',async()=>{
  const env=setup();
  const cross=new Request('https://example.test/api/booking/requests',{method:'POST',headers:{origin:'https://other.test','content-type':'application/json'},body:JSON.stringify(value())});
  assert.equal((await submit({request:cross,env})).status,403);
  for(let n=0;n<5;n++) assert.equal((await send(env,value({date:addDaysIso(day(),n)}))).status,200);
  assert.equal((await send(env,value({date:addDaysIso(day(),6)}))).status,429);
});

test('admin operations require authentication, external-channel confirmation and configured PayApp',async()=>{
  const env=setup(),created=await send(env);
  const denied=await list({request:new Request('https://example.test/api/admin/booking-requests'),env});assert.equal(denied.status,401);
  const listing=await list({request:new Request('https://example.test/api/admin/booking-requests',{headers:{authorization:'Bearer test-admin-bookings'}}),env});
  const body=await listing.json();assert.equal(body.results.length,1);assert.equal(body.payapp.ready,false);
  assert.equal((await admin({code:created.data.code,action:'approve'},env)).status,400);
  assert.equal((await admin({code:created.data.code,action:'approve',external_checked:true},env)).status,503);
  assert.equal((await getBooking(env,created.data.code)).status,'requested');
});

test('approval issues only one payment request, retains its slot, and allows an early verified callback',async()=>{
  const env=setup(),created=await send(env),code=created.data.code;
  Object.assign(env,{PAYAPP_ENABLED:'1',PAYAPP_USERID:'test-merchant',PAYAPP_LINK_KEY:'test-key',PAYAPP_LINK_VALUE:'test-value',PAYAPP_REQUEST_KEY:'test-request-key',PAYAPP_SITE_URL:'https://example.test'});
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.payapp.kr/oapi/v2');calls++;
    const form=new URLSearchParams(options.body);assert.equal(form.get('var1'),code);assert.equal(form.get('smsuse'),'n');
    await applyBookingPayment(env,{code,id:'45678',state:'paid',paid_at:'20261106140000'});
    return new Response('state=1&mul_no=45678&payurl=https%3A%2F%2Fpayapp.kr%2Ftest-only');
  };
  try {
    const result=await admin({code,action:'approve',external_checked:true},env);assert.equal(result.status,200);
    const booking=await getBooking(env,code);assert.equal(booking.status,'confirmed');assert.equal(booking.payment_status,'paid');assert.equal(booking.payment_id,'45678');
    assert(booking.payment_url.startsWith('https://'));
    assert.equal((await admin({code,action:'approve',external_checked:true},env)).status,409);assert.equal(calls,1);
    assert.equal((await send(env)).status,409);
  }finally {globalThis.fetch=old;}
});

test('uncertain PayApp issuance keeps its hold and blocks duplicate issuance and unsafe cancellation',async()=>{
  const env=setup(),created=await send(env),code=created.data.code;
  Object.assign(env,{PAYAPP_ENABLED:'1',PAYAPP_USERID:'test-merchant',PAYAPP_LINK_KEY:'test-key',PAYAPP_LINK_VALUE:'test-value',PAYAPP_REQUEST_KEY:'test-request-key',PAYAPP_SITE_URL:'https://example.test'});
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('network');};
  try {
    assert.equal((await admin({code,action:'approve',external_checked:true},env)).status,502);
    const booking=await getBooking(env,code);assert.equal(booking.status,'awaiting_payment');assert.equal(booking.payment_status,'review');
    assert.equal((await send(env)).status,409);
    assert.equal((await admin({code,action:'approve',external_checked:true},env)).status,409);
    assert.equal((await admin({code,action:'cancel'},env)).status,409);assert.equal(calls,1);
    assert.equal((await getBooking(env,code)).status,'awaiting_payment');
  }finally {globalThis.fetch=old;}
});

test('verified payment callback confirms exactly once and persists matching reservation',async()=>{
  const env=setup(),created=await send(env),code=created.data.code;
  env.sqlite.prepare("UPDATE booking_requests SET status='awaiting_payment',payment_status='creating' WHERE code=?").run(code);
  assert.deepEqual(await applyBookingPayment(env,{code,id:'12345',state:'paid',paid_at:'20261106130000'}),{ok:true});
  assert.equal((await getBooking(env,code)).status,'confirmed');
  const reservation=env.sqlite.prepare('SELECT * FROM reservations WHERE code=?').get(code);
  assert.equal(reservation.pay_status,'paid');assert.equal(reservation.amount,created.data.amount);assert.equal(reservation.channel,'web');assert.equal(reservation.paid_at,'2026-11-06');
  assert.equal((await applyBookingPayment(env,{code,id:'12345',state:'paid'})).already,true);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
  assert.equal((await applyBookingPayment(env,{code,id:'99999',state:'paid'})).error,'payment-mismatch');
  await applyBookingPayment(env,{code,id:'12345',state:'pending'});assert.equal((await getBooking(env,code)).payment_status,'paid');
});

test('late payment after expiry is sent for review rather than confirming an occupied time',async()=>{
  const env=setup(),first=await send(env),code=first.data.code;
  env.sqlite.prepare("UPDATE booking_requests SET status='expired' WHERE code=?").run(code);
  assert.equal((await send(env)).status,200);
  const result=await applyBookingPayment(env,{code,id:'22222',state:'paid'});
  assert.equal(result.review,true);assert.equal((await getBooking(env,code)).status,'payment_review');
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
});

test('cancelled unpaid requests free time while confirmed reservations require refund confirmation',async()=>{
  const env=setup(),created=await send(env),code=created.data.code;
  assert.equal((await admin({code,action:'cancel',reason:'일정 변경'},env)).status,200);
  assert.equal((await send(env)).status,200);
  const env2=setup(),other=await send(env2),paidCode=other.data.code;
  env2.sqlite.prepare("UPDATE booking_requests SET status='awaiting_payment' WHERE code=?").run(paidCode);
  await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'paid'});
  assert.equal((await admin({code:paidCode,action:'cancel'},env2)).status,409);
  assert.equal((await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'cancelled'})).error,'refund-confirmation-required');
  assert.equal((await getBooking(env2,paidCode)).status,'confirmed');
  await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'refund_pending',refund_amount:5000});
  assert.equal((await getBooking(env2,paidCode)).status,'confirmed');assert.equal((await getBooking(env2,paidCode)).refund_amount,5000);
  assert.equal(env2.sqlite.prepare('SELECT refund_amount,pay_status FROM reservations WHERE code=?').get(paidCode).refund_amount,5000);
  await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'refund_pending',refund_amount:10000});
  await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'refund_pending',refund_amount:5000});
  assert.equal((await getBooking(env2,paidCode)).refund_amount,10000);
  assert.equal((await getBooking(env2,paidCode)).status,'confirmed');
  assert.equal(env2.sqlite.prepare('SELECT refund_amount FROM reservations WHERE code=?').get(paidCode).refund_amount,10000);
  await applyBookingPayment(env2,{code:paidCode,id:'33333',state:'refunded',refund_amount:other.data.amount});
  assert.equal((await getBooking(env2,paidCode)).status,'cancelled');
  assert.equal(env2.sqlite.prepare('SELECT status,pay_status FROM reservations WHERE code=?').get(paidCode).pay_status,'refunded');
});
