import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prepareBookings,kstTimestamp} from '../functions/_lib/booking.js';
import {onRequestPatch} from '../functions/api/admin/booking-requests.js';

const origin='https://example.test',code='B261122-ABCDEFGH12';
async function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let args=[];const statement={
    bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}
  };return statement;},async batch(statements){const results=[];for(const statement of statements)results.push(await statement.run());return results;}};
  const env={DB,sqlite,ADMIN_KEY:'test-only-admin',BOOKING_NOTIFY_START:kstTimestamp(Date.now()-4*86400000),
    BOOKING_NOTIFY_STAFF:'01011112222,01033334444',BOOKING_NOTIFY_CUSTOMER:'1',BOOKING_NOTIFY_LIVE:'1',
    ALIGO_API_KEY:'test-key',ALIGO_USER_ID:'test-user',ALIGO_SENDER:'021234567'};
  await prepareBookings(env);
  const paidAt=kstTimestamp(Date.now()-2*86400000);
  sqlite.prepare(`INSERT INTO booking_requests (code,submission_id,fingerprint,status,room,date,start_min,end_min,people,
    customer_name,phone,purpose,amount,consent,notice_version,payment_status,payment_id,paid_at,updated_at)
    VALUES (?,?,'test','confirmed','r5','2026-11-22',960,1140,10,'테스트','01099998888','meeting',120000,1,'test','paid','123',?,?)`)
    .run(code,code,paidAt,paidAt);
  sqlite.prepare(`INSERT INTO booking_payapp_requests (code,kind,label,amount,token,mul_no,status,paid_at)
    VALUES (?,'room','test',120000,'private-test-token','123','paid',?)`).run(code,paidAt);
  return env;
}
const request=({admin=true,site=origin,bookingCode=code}={})=>new Request(origin+'/api/admin/booking-requests',{
  method:'PATCH',headers:{origin:site,'content-type':'application/json',...(admin?{authorization:'Bearer test-only-admin'}:{})},
  body:JSON.stringify({action:'notify-operators',code:bookingCode})
});

test('explicit operator recovery sends only the missing staff SMS for an older paid booking and deduplicates retries',async t=>{
  const env=await fixture(),sends=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://apis.aligo.in/send/');
    const form=new URLSearchParams(options.body);sends.push(form);
    assert.equal(form.get('testmode_yn'),'N');
    return Response.json({result_code:1,msg_id:sends.length,success_cnt:1,error_cnt:0});
  });
  const before=env.sqlite.prepare('SELECT * FROM booking_requests WHERE code=?').get(code);
  const response=await onRequestPatch({env,request:request()});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.result.accepted,2);
  assert.equal(result.notices.length,2);
  assert(result.notices.every(notice=>notice.state==='accepted'));
  assert.deepEqual(sends.map(form=>form.get('receiver')).sort(),['01011112222','01033334444']);
  assert(sends.every(form=>form.get('msg').includes('120,000원')));
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM booking_notifications WHERE recipient='customer'").get().n,0);
  assert.deepEqual(env.sqlite.prepare('SELECT * FROM booking_requests WHERE code=?').get(code),before);
  assert.equal((await onRequestPatch({env,request:request()})).status,200);
  assert.equal(sends.length,2);
});

test('operator recovery requires same-origin admin authorization, live SMS readiness, and a settled payment',async t=>{
  const env=await fixture();let sends=0;
  t.mock.method(globalThis,'fetch',async()=>{sends++;throw Error('unexpected network');});
  assert.equal((await onRequestPatch({env,request:request({admin:false})})).status,401);
  assert.equal((await onRequestPatch({env,request:request({site:'https://other.test'})})).status,403);
  env.BOOKING_NOTIFY_LIVE='0';
  assert.equal((await onRequestPatch({env,request:request()})).status,503);
  env.BOOKING_NOTIFY_LIVE='1';
  env.sqlite.prepare("UPDATE booking_requests SET payment_status='paid_verifying' WHERE code=?").run(code);
  assert.equal((await onRequestPatch({env,request:request()})).status,409);
  env.sqlite.prepare("UPDATE booking_requests SET payment_status='paid',refund_amount=1 WHERE code=?").run(code);
  assert.equal((await onRequestPatch({env,request:request()})).status,409);
  assert.equal(sends,0);
});
