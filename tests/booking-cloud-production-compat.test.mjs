import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { payappConfig,ensureBookingPayappSchema,createPayment } from '../functions/_lib/booking-payapp.js';
import { ensurePayapp } from '../functions/_lib/payapp.js';
import { sha256Hex } from '../functions/_lib/auth.js';
import { onRequestPost as bookingFeedback } from '../functions/api/booking/payapp-feedback.js';
import { onRequestPost as newOrder } from '../functions/api/orders/index.js';
import { onRequestGet as products } from '../functions/api/shop/products.js';

function fixture(t) {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  const DB={prepare(sql){let args=[];const q={bind(...a){args=a;return q;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return q;},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return {sqlite,DB,PAYAPP_USERID:'existing-merchant',PAYAPP_LINKKEY:'existing-link',PAYAPP_LINKVAL:'existing-value',PAYAPP_REQUESTKEY:'existing-request',PAYAPP_ENABLED:'1',PAYAPP_SITE_URL:'https://socialfactory.test'};
}

test('booking PayApp uses existing production credentials without replacing the legacy refund ledger',async t=>{
  const env=fixture(t);await ensurePayapp(env);await ensureBookingPayappSchema(env);
  assert.equal(payappConfig(env).ready,true);assert.equal(payappConfig({...env,PAYAPP_ENABLED:'0'}).ready,false);
  assert.deepEqual(env.sqlite.prepare('PRAGMA table_info(payapp_refunds)').all().map(r=>r.name),['mul_no','oid','amount','created_at']);
  assert.deepEqual(env.sqlite.prepare('PRAGMA table_info(booking_payapp_refunds)').all().map(r=>r.name),['mul_no','code','amount','created_at']);
  env.sqlite.prepare("INSERT INTO orders(oid,product_id,product_name,amount,buyer_name,buyer_phone) VALUES('OLD-ORDER','cowork-2h','기존 결제',4000,'기존 고객','01000000000')").run();
  env.sqlite.prepare("INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES('OLD-ORDER','111','old-nonce','old-request','old-hash')").run();
  env.sqlite.prepare("INSERT INTO payapp_refunds(mul_no,oid,amount) VALUES('112','OLD-ORDER',1000)").run();
  let sent;
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'https://api.payapp.kr/oapi/v2');sent=new URLSearchParams(options.body);return new Response('state=1&mul_no=222&payurl=https%3A%2F%2Fpayapp.kr%2Ffixture');});
  await createPayment(env,{code:'OF-PRODUCTION-COMPAT',kind:'office',label:'상담 확정 청구',amount:10000,phone:'01012345678'});
  assert.equal(sent.get('feedbackurl'),'https://socialfactory.test/api/booking/payapp-feedback');
  assert.equal(sent.get('linkkey'),env.PAYAPP_LINKKEY);
  assert.equal(sent.get('hash'),await sha256Hex(env.PAYAPP_USERID+sent.get('requestdate')+env.PAYAPP_REQUESTKEY));
  const row=env.sqlite.prepare("SELECT * FROM booking_payapp_requests WHERE code='OF-PRODUCTION-COMPAT'").get();
  const stamp=new Date(Date.now()+9*3600000).toISOString().slice(0,19).replace(/\D/g,'');
  const fields={userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINKKEY,linkval:env.PAYAPP_LINKVAL,responsedate:stamp,
    hash:await sha256Hex(env.PAYAPP_USERID+stamp+env.PAYAPP_REQUESTKEY),var1:row.code,var2:row.token,mul_no:row.mul_no,price:String(row.amount),pay_state:'4',pay_date:stamp};
  const response=await bookingFeedback({env,request:new Request('https://socialfactory.test/api/booking/payapp-feedback',{method:'POST',body:new URLSearchParams(fields)})});
  assert.equal(await response.text(),'SUCCESS');assert.equal(env.sqlite.prepare('SELECT status FROM booking_payapp_requests').get().status,'paid');
  assert.equal(env.sqlite.prepare("SELECT amount FROM payapp_refunds WHERE mul_no='112'").get().amount,1000);
  assert.equal(env.sqlite.prepare("SELECT nonce FROM payapp_payments WHERE oid='OLD-ORDER'").get().nonce,'old-nonce');
});

test('retired fixed website product writes stop before issuing payment while historical definitions stay readable',async t=>{
  const env=fixture(t);let network=0;t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('No payment expected');});
  for(const productId of ['cowork-2h','cowork-day','cowork-month','locker-month','laptop-day']) {
    const response=await newOrder({env,request:new Request('https://socialfactory.test/api/orders',{method:'POST',headers:{origin:'https://socialfactory.test','content-type':'application/json'},body:JSON.stringify({productId})})});
    assert.equal(response.status,410);
  }
  assert.equal(network,0);assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
  const listing=await (await products({env})).json();assert.equal(listing.products.length,0);assert.equal(listing.channels.coworking,'onsite-kiosk');
});
