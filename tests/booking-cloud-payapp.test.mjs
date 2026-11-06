import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../functions/_lib/auth.js';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';
import { payappConfig,createPayment,ensurePayappSchema,validateFeedback,recordFeedback,validPayappUrl,parseProviderTime,cancelBookingPayment } from '../functions/_lib/booking-payapp.js';
import { onRequestPost as feedback } from '../functions/api/booking/payapp-feedback.js';
import { onRequestGet as paymentStatus,onRequestPost as acceptPayment } from '../functions/api/booking/payment-status.js';
import { onRequestGet as officeList,onRequestPost as officeCreate } from '../functions/api/admin/booking-payapp.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { getBooking } from '../functions/_lib/booking.js';

const ORIGIN='https://example.test';
function fixture(configured=true) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},
    async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {DB,sqlite,ADMIN_KEY:'test-only-admin',...(configured?{PAYAPP_ENABLED:'1',PAYAPP_USERID:'test-only-merchant',PAYAPP_LINK_KEY:'test-only-link-key',PAYAPP_LINK_VALUE:'test-only-link-value',PAYAPP_REQUEST_KEY:'test-only-request-key',PAYAPP_SITE_URL:ORIGIN}:{})};
}
const stamp=(time=Date.now())=>new Date(time+9*3600000).toISOString().slice(0,19).replace(/\D/g,'');
const post=(path,body,{admin=false,origin=ORIGIN}={})=>new Request(ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',origin,...(admin?{authorization:'Bearer test-only-admin'}:{})},body:JSON.stringify(body)});
const payment=(extra={})=>({code:'OF-TEST-0001',kind:'office',label:'독립사무실 월 이용료',amount:275000,phone:'01012345678',...extra});
const row=(env,code='OF-TEST-0001')=>env.sqlite.prepare('SELECT * FROM booking_payapp_requests WHERE code=?').get(code);
async function issue(env,options=payment()) {
  const previous=globalThis.fetch;globalThis.fetch=async()=>new Response('state=1&mul_no=123456&payurl=https%3A%2F%2Fpayapp.kr%2Ftest-payment');
  try{return await createPayment(env,options);}finally{globalThis.fetch=previous;}
}
async function signed(env,paymentRow,extra={}) {
  const fields={userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINK_KEY,linkval:env.PAYAPP_LINK_VALUE,responsedate:stamp(),var1:paymentRow.code,var2:paymentRow.token,
    mul_no:paymentRow.mul_no||'123456',price:String(paymentRow.amount),pay_state:'4',pay_date:stamp(),...extra};
  fields.hash=await sha256Hex(env.PAYAPP_USERID+fields.responsedate+env.PAYAPP_REQUEST_KEY);return fields;
}
const deliver=(env,fields)=>feedback({request:new Request(ORIGIN+'/api/booking/payapp-feedback',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)}),env});
async function roomFixture() {
  const env=fixture(),body={submissionId:crypto.randomUUID(),room:'r3',date:addDaysIso(kstToday(),12),start_min:600,end_min:720,people:6,name:'테스트 담당자',phone:'01012345678',company:'테스트',purpose:'meeting',consent:true};
  const response=await submit({request:post('/api/booking/requests',body),env});const result=await response.json();assert.equal(response.status,200);
  env.sqlite.prepare("UPDATE booking_requests SET status='awaiting_payment',payment_status='creating' WHERE code=?").run(result.code);
  await issue(env,payment({code:result.code,kind:'room',amount:result.amount}));return {env,code:result.code,body};
}

test('PayApp requires all secrets and an exact HTTPS origin before issuing any payment',async()=>{
  const env=fixture(false),previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected network');};
  try {
    assert.equal(payappConfig(env).ready,false);await assert.rejects(createPayment(env,payment()),error=>error.status===503&&error.code==='PAYAPP_NOT_CONFIGURED');assert.equal(calls,0);
    for(const origin of ['http://example.test','https://example.test/path','https://user:pass@example.test','https://example.test?x=1'])assert.equal(payappConfig({...fixture(),PAYAPP_SITE_URL:origin}).ready,false);
    assert.equal(payappConfig(fixture()).ready,true);
  }finally{globalThis.fetch=previous;}
});

test('payment issuance returns only its own consent checkout URL and retries do not duplicate provider charges',async()=>{
  const env=fixture(),previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.payapp.kr/oapi/v2');assert.equal(options.redirect,'manual');
    const form=new URLSearchParams(options.body);assert.equal(form.get('cmd'),'payrequest');assert.equal(form.get('smsuse'),'n');assert.equal(form.get('price'),'275000');assert.equal(form.get('feedbackurl'),ORIGIN+'/api/booking/payapp-feedback');
    assert.equal(form.get('hash'),await sha256Hex(env.PAYAPP_USERID+form.get('requestdate')+env.PAYAPP_REQUEST_KEY));
    return new Response('state=1&mul_no=123456&payurl=https%3A%2F%2Fpayapp.kr%2Ftest-payment');};
  try {
    const first=await createPayment(env,payment()),second=await createPayment(env,payment());assert.deepEqual(second,first);assert.equal(calls,1);
    assert(first.url.startsWith(ORIGIN+'/booking-status?'));assert(!first.url.includes('payapp.kr'));assert.equal(new URL(first.url).searchParams.get('t'),row(env).token);
    await assert.rejects(createPayment(env,payment({amount:999000})),error=>error.code==='PAYMENT_MISMATCH');assert.equal(calls,1);
  }finally{globalThis.fetch=previous;}
  for(const url of ['http://payapp.kr/x','https://payapp.kr.evil.test/x','https://user:pass@payapp.kr/x','javascript:alert(1)'])assert.equal(validPayappUrl(url),false);
});

test('provider refusals can be cancelled while uncertain results retain their hold and forbid reissue',async()=>{
  const previous=globalThis.fetch;
  try {
    for(const mode of ['reject','network','bad-url','bad-id','http','malformed']) {
      const env=fixture();let calls=0;globalThis.fetch=async()=>{calls++;if(mode==='network')throw new Error('offline');if(mode==='http')return new Response('error',{status:502});
        return new Response(mode==='reject'?'state=0&errorMessage=denied':mode==='malformed'?'<html>Gateway error</html>':mode==='bad-url'?'state=1&mul_no=123456&payurl=https%3A%2F%2Fevil.test%2Fx':'state=1&mul_no=oops&payurl=https%3A%2F%2Fpayapp.kr%2Fx');};
      await assert.rejects(createPayment(env,payment()),error=>error.status===502);assert.equal(row(env).status,mode==='reject'?'failed':'review');
      await assert.rejects(createPayment(env,payment()),error=>error.code==='PAYAPP_REVIEW');assert.equal(calls,1);
      if(mode==='reject'){await cancelBookingPayment(env,{booking:{code:payment().code}});assert.equal(row(env).status,'cancelled');assert.equal(calls,1);}
    }
  }finally{globalThis.fetch=previous;}
});

test('provider timeout aborts the request and preserves uncertain state without a second request',async()=>{
  const env=fixture(),previousFetch=globalThis.fetch,previousTimeout=globalThis.setTimeout;let calls=0;
  globalThis.setTimeout=(callback,delay,...args)=>previousTimeout(callback,delay===12000?0:delay,...args);
  globalThis.fetch=async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}));};
  try {await assert.rejects(createPayment(env,payment()),error=>error.code==='PAYAPP_UNCERTAIN');assert.equal(row(env).status,'review');await assert.rejects(createPayment(env,payment()));assert.equal(calls,1);}
  finally{globalThis.fetch=previousFetch;globalThis.setTimeout=previousTimeout;}
});

test('feedback authentication rejects forged merchant secrets, token, amount, payment id, hash and timestamps',async()=>{
  const env=fixture();await issue(env);const original=await signed(env,row(env));
  assert.equal((await validateFeedback(env,original)).event.state,'paid');
  for(const change of [{userid:'other'},{linkkey:'other'},{linkval:'other'},{var2:'wrong-token'},{var1:'OF-UNKNOWN'},{price:'1'},{mul_no:'999999'},{hash:'00'},{price:'275000.0'}])
    await assert.rejects(validateFeedback(env,{...original,...change}),error=>error.status===403);
  for(const responsedate of [stamp(Date.now()-16*60000),stamp(Date.now()+16*60000),'20260230120000','not-a-date'])
    await assert.rejects(validateFeedback(env,await signed(env,row(env),{responsedate})),error=>error.status===403);
  assert.equal(parseProviderTime('20260230120000'),null);
  const rejected=await deliver(env,{...original,price:'1'});assert.equal(rejected.status,403);assert.notEqual(await rejected.text(),'SUCCESS');assert.equal(row(env).status,'requested');
  const oversized=await feedback({request:new Request(ORIGIN+'/api/booking/payapp-feedback',{method:'POST',body:'x'.repeat(65537)}),env});assert.equal(oversized.status,413);
});

test('payment details conceal provider URL until consent and require an unguessable token and same-origin acceptance',async()=>{
  const env=fixture(),issued=await issue(env),saved=row(env),params=new URL(issued.url).search;
  const denied=await paymentStatus({request:new Request(ORIGIN+'/api/booking/payment-status?code='+saved.code+'&t=wrong'),env});assert.equal(denied.status,404);
  const details=await(await paymentStatus({request:new Request(ORIGIN+'/api/booking/payment-status'+params),env})).json();
  assert.equal(details.amount,275000);assert.equal(details.can_pay,true);assert(!JSON.stringify(details).includes('payapp.kr'));assert(!('url'in details));assert(!('pay_url'in details));
  const input={code:saved.code,t:saved.token,consent:false};assert.equal((await acceptPayment({request:post('/api/booking/payment-status',input),env})).status,400);
  assert.equal((await acceptPayment({request:post('/api/booking/payment-status',{...input,consent:true,t:'wrong'}),env})).status,404);
  assert.equal((await acceptPayment({request:post('/api/booking/payment-status',{...input,consent:true},{origin:'https://other.test'}),env})).status,403);
  assert.equal(row(env).accepted_at,null);
  const accepted=await acceptPayment({request:post('/api/booking/payment-status',{...input,consent:true}),env});assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).url,'https://payapp.kr/test-payment');assert(row(env).accepted_at);assert.equal(row(env).consent_version,'2026-11-06');
});

test('room checkout rejects changed or cancelled booking state even with a valid payment token',async()=>{
  const {env,code}=await roomFixture(),saved=row(env,code);
  const body={code,t:saved.token,consent:true};
  env.sqlite.prepare("UPDATE booking_requests SET status='cancelled' WHERE code=?").run(code);
  assert.equal((await acceptPayment({request:post('/api/booking/payment-status',body),env})).status,409);
  assert.equal(row(env,code).accepted_at,null);
});

test('office invoices require admin access, a real office inquiry and explicit contract confirmation',async()=>{
  const env=fixture(),previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('state=1&mul_no=123456&payurl=https%3A%2F%2Fpayapp.kr%2Ftest-payment');};
  env.sqlite.prepare(`INSERT INTO inquiries(receipt,submission_id,purpose,name,phone,message,consent) VALUES ('SF-TEST-OFFICE','test-office-submission','office','입주 담당자','01012345678','입주 상담',1)`).run();
  env.sqlite.prepare(`INSERT INTO inquiries(receipt,submission_id,purpose,name,phone,message,consent) VALUES ('SF-TEST-ROOM','test-room-submission','rental','대관 담당자','01012345678','대관 문의',1)`).run();
  const inquiry=env.sqlite.prepare("SELECT id FROM inquiries WHERE purpose='office'").get(),nonOffice=env.sqlite.prepare("SELECT id FROM inquiries WHERE purpose='rental'").get();
  const body={inquiry_id:inquiry.id,amount:275000,label:'독립사무실 B호 월 이용료',contract_confirmed:true};
  try {
    assert.equal((await officeCreate({request:post('/api/admin/booking-payapp',body),env})).status,401);
    assert.equal((await officeCreate({request:post('/api/admin/booking-payapp',{...body,contract_confirmed:false},{admin:true}),env})).status,400);
    assert.equal((await officeCreate({request:post('/api/admin/booking-payapp',{...body,inquiry_id:nonOffice.id},{admin:true}),env})).status,404);
    assert.equal((await officeCreate({request:post('/api/admin/booking-payapp',{...body,amount:1},{admin:true}),env})).status,400);assert.equal(calls,0);
    const response=await officeCreate({request:post('/api/admin/booking-payapp',body,{admin:true}),env});assert.equal(response.status,200);const data=await response.json();assert(data.url.startsWith(ORIGIN+'/booking-status?'));assert.equal(calls,1);
    const listing=await officeList({request:new Request(ORIGIN+'/api/admin/booking-payapp',{headers:{authorization:'Bearer test-only-admin'}}),env});const list=await listing.json();
    assert.equal(list.results.length,1);assert(list.results[0].pay_url.startsWith(ORIGIN+'/booking-status?'));assert(!('token'in list.results[0]));
    assert.equal(list.inquiries.length,1);
  }finally{globalThis.fetch=previous;}
});

test('pending then paid feedback confirms a room once, ignores duplicate and older pending events, and flags partial cancellation',async()=>{
  const {env,code}=await roomFixture();const saved=row(env,code);
  let response=await deliver(env,await signed(env,saved,{pay_state:'1'}));assert.equal(await response.text(),'SUCCESS');assert.equal(row(env,code).status,'pending');assert.equal((await getBooking(env,code)).status,'awaiting_payment');
  const paid=await signed(env,row(env,code));response=await deliver(env,paid);assert.equal(await response.text(),'SUCCESS');assert.equal(row(env,code).status,'paid');assert.equal((await getBooking(env,code)).status,'confirmed');
  assert.equal(await(await deliver(env,paid)).text(),'SUCCESS');assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
  assert.equal(await(await deliver(env,await signed(env,row(env,code),{pay_state:'1'}))).text(),'SUCCESS');assert.equal(row(env,code).status,'paid');
  const partial=await signed(env,row(env,code),{pay_state:'71',orig_mul_no:saved.mul_no,orig_price:String(saved.amount),mul_no:'987654',price:'5000'});
  assert.equal(await(await deliver(env,partial)).text(),'SUCCESS');assert.equal(row(env,code).status,'partial_refund');assert.equal(row(env,code).refund_amount,5000);
  assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal((await getBooking(env,code)).payment_status,'refund_pending');
  assert.equal((await getBooking(env,code)).refund_amount,5000);
  assert.equal(await(await deliver(env,partial)).text(),'SUCCESS');assert.equal(row(env,code).refund_amount,5000);
  const nextPartial=await signed(env,row(env,code),{pay_state:'71',orig_mul_no:saved.mul_no,orig_price:String(saved.amount),mul_no:'987655',price:'3000'});
  assert.equal(await(await deliver(env,nextPartial)).text(),'SUCCESS');assert.equal(row(env,code).refund_amount,8000);
  assert.equal((await getBooking(env,code)).refund_amount,8000);
  assert.equal(env.sqlite.prepare('SELECT refund_amount FROM reservations WHERE code=?').get(code).refund_amount,8000);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM booking_payapp_refunds WHERE code=?').get(code).n,2);
  const mismatch=await signed(env,row(env,code),{pay_state:'71',orig_mul_no:saved.mul_no,orig_price:String(saved.amount),mul_no:'987655',price:'3001'});
  assert.equal((await deliver(env,mismatch)).status,403);assert.equal(row(env,code).refund_amount,8000);
  assert.equal(await(await deliver(env,paid)).text(),'SUCCESS');assert.equal(row(env,code).status,'partial_refund');
  assert.equal(await(await deliver(env,await signed(env,row(env,code),{pay_state:'9'}))).text(),'SUCCESS');assert.equal(row(env,code).status,'refunded');assert.equal((await getBooking(env,code)).status,'cancelled');
});

test('a rejected excess partial refund does not poison the ledger for later valid events',async()=>{
  const env=fixture();await issue(env);const saved=row(env);
  const partial=extra=>signed(env,row(env),{pay_state:'71',orig_mul_no:saved.mul_no,orig_price:String(saved.amount),...extra});
  assert.equal(await(await deliver(env,await partial({mul_no:'800001',price:'200000'}))).text(),'SUCCESS');
  assert.equal((await deliver(env,await partial({mul_no:'800002',price:'100000'}))).status,403);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM booking_payapp_refunds').get().n,1);
  assert.equal(await(await deliver(env,await partial({mul_no:'800003',price:'50000'}))).text(),'SUCCESS');
  assert.equal(row(env).refund_amount,250000);
});

test('concurrent notifications with the same prior snapshot cannot regress paid or refunded status',async()=>{
  const env=fixture();await issue(env);const saved=row(env),time=stamp();
  const paid=await validateFeedback(env,await signed(env,saved,{pay_state:'4',responsedate:time}));
  const pending=await validateFeedback(env,await signed(env,saved,{pay_state:'1',responsedate:time}));
  await Promise.all([recordFeedback(env,paid),recordFeedback(env,pending)]);assert.equal(row(env).status,'paid');
  const refunded=await validateFeedback(env,await signed(env,row(env),{pay_state:'9',responsedate:time}));
  const duplicatePaid=await validateFeedback(env,await signed(env,row(env),{pay_state:'4',responsedate:time}));
  await Promise.all([recordFeedback(env,refunded),recordFeedback(env,duplicatePaid)]);assert.equal(row(env).status,'refunded');assert.equal(row(env).refund_amount,saved.amount);
});

test('partial cancellation validates original amount and id; stale notifications cannot roll state backward',async()=>{
  const env=fixture();await issue(env);const saved=row(env);
  const partial=await signed(env,saved,{pay_state:'71',orig_mul_no:saved.mul_no,orig_price:String(saved.amount),mul_no:'987654',price:'5000'});
  for(const change of [{orig_mul_no:'999999'},{orig_price:'1'},{price:String(saved.amount+1)}])await assert.rejects(validateFeedback(env,{...partial,...change}),error=>error.status===403);
  env.sqlite.prepare("UPDATE booking_payapp_requests SET provider_stamp=?,status='paid' WHERE code=?").run(stamp(),saved.code);
  const old=await signed(env,saved,{pay_state:'1',responsedate:stamp(Date.now()-60000)});assert.equal((await validateFeedback(env,old)).stale,true);
  assert.equal(await(await deliver(env,old)).text(),'SUCCESS');assert.equal(row(env).status,'paid');
});

test('unpaid cancellation uses ready-only mode and paid invoices cannot be silently cancelled',async()=>{
  const env=fixture();await issue(env);const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;const form=new URLSearchParams(options.body);assert.equal(form.get('cmd'),'paycancel');assert.equal(form.get('cancelmode'),'ready');assert.equal(form.get('partcancel'),'0');return new Response('state=1');};
  try {
    assert.equal((await cancelBookingPayment(env,{booking:{code:'OF-TEST-0001'}})).ok,true);assert.equal(row(env).status,'cancelled');assert.equal(calls,1);
    assert.equal((await cancelBookingPayment(env,{booking:{code:'OF-TEST-0001'}})).ok,true);assert.equal(calls,1);
    env.sqlite.prepare("UPDATE booking_payapp_requests SET status='paid' WHERE code='OF-TEST-0001'").run();
    await assert.rejects(cancelBookingPayment(env,{booking:{code:'OF-TEST-0001'}}),error=>error.code==='PAYAPP_REVIEW');assert.equal(calls,1);
  }finally{globalThis.fetch=previous;}
});
