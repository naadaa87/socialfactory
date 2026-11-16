import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/parking-fixture.mjs';
import {payappConfig,payappPaymentConfig,payappFeedbackConfig,ensurePayapp,kstStamp} from '../functions/_lib/payapp.js';
import {sha256Hex} from '../functions/_lib/auth.js';
import {payConfig,orderToken} from '../functions/_lib/shop.js';
import {onRequestGet as status} from '../functions/api/orders/status.js';
import {onRequestPost as create} from '../functions/api/parking/create.js';

function activate(env) {
  Object.assign(env,{PAYAPP_ACTIVE_ACCOUNT:'gu',PAYAPP_GU_USERID:'guspacedev',PAYAPP_GU_LINKKEY:'new-link',PAYAPP_GU_LINKVAL:'new-value',PAYAPP_GU_REQUESTKEY:'new-request'});
}
async function signed(env,account) {
  const C=payappConfig(env,account),responsedate=kstStamp();
  return {userid:C.userid,linkkey:C.linkkey,linkval:C.linkval,responsedate,hash:await sha256Hex(C.userid+responsedate+C.requestkey)};
}
const payment=(f,oid)=>f.db.prepare('SELECT * FROM payapp_payments WHERE oid=?').get(oid);

test('주차권 신규 결제만 지유공간개발로 전환하고 기존 결제 승인·부분환불·전액환불은 블랭크 계정으로 유지',async t=>{
  const f=await fixture(t),old=await f.purchase();
  activate(f.env);
  const fresh=await f.purchase(f.body({plate:'234나5678',plateConfirm:'234나5678'}));
  assert.equal(payment(f,old.oid).merchant_account,'blank');
  assert.equal(payment(f,old.oid).merchant_userid,'test-user');
  assert.equal(payment(f,fresh.oid).merchant_account,'gu');
  assert.equal(payment(f,fresh.oid).merchant_userid,'guspacedev');
  const requests=f.calls.filter(c=>c.url==='https://api.payapp.kr/oapi/v2');
  assert.equal(requests[0].form.get('userid'),'test-user');
  assert.equal(requests[1].form.get('userid'),'guspacedev');
  assert.equal(requests[1].form.get('hash'),await sha256Hex('guspacedev'+requests[1].form.get('requestdate')+'new-request'));
  assert.equal((await f.cb(old)).status,200);
  const refund={mul_no:'9001',orig_mul_no:payment(f,old.oid).mul_no,orig_price:String(old.amount),price:'1000'};
  assert.equal((await f.cb(old,'70',refund)).status,200);
  assert.equal((await f.cb(old,'70',refund)).status,200);
  assert.equal(payment(f,old.oid).refunded_amount,1000);
  assert.equal((await f.cb(old,'64')).status,200);
  assert.equal(payment(f,old.oid).refunded_amount,old.amount);
  assert.equal((await f.cb(fresh,'4',await signed(f.env,'gu'))).status,200);
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE oid=?').get(fresh.oid).status,'paid');
});

test('양 계정 서명이 유효해도 다른 계정의 원거래에는 승인·환불 통보를 연결할 수 없음',async t=>{
  const f=await fixture(t),old=await f.purchase();activate(f.env);
  const fresh=await f.purchase(f.body({plate:'234나5678',plateConfirm:'234나5678'}));
  assert.equal((await f.cb(old,'4',await signed(f.env,'gu'))).status,403);
  assert.equal((await f.cb(fresh)).status,403);
  assert.equal((await f.cb(old,'64',await signed(f.env,'gu'))).status,403);
  assert.equal(payment(f,old.oid).refunded_amount,0);
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE oid=?').get(old.oid).status,'pending');
  assert.equal(f.db.prepare('SELECT status FROM orders WHERE oid=?').get(fresh.oid).status,'pending');
});

test('신계정 키 누락·오류 때 블랭크나 이니시스로 신규 결제를 우회하지 않고 구거래 통보는 계속 처리',async t=>{
  const f=await fixture(t),old=await f.purchase();activate(f.env);delete f.env.PAYAPP_GU_REQUESTKEY;
  assert.equal(payConfig(f.env).ready,false);
  const calls=f.calls.length;
  const result=await create({env:f.env,request:f.req('/api/parking/create',f.body())});
  assert.equal(result.status,503);assert.equal(f.calls.length,calls);
  f.env.PAYAPP_ENABLED='0';
  assert.equal((await f.cb(old)).status,200);
  assert.equal((await f.cb(old,'64')).status,200);
  assert.equal(payConfig({...f.env,SHOP_PAYMENT_PROVIDER:undefined,INICIS_MID:'old-mid',INICIS_SIGN_KEY:'old-sign'}).ready,false);
  assert.equal(payappConfig({...f.env,PAYAPP_ACTIVE_ACCOUNT:'unknown'}).configured,false);
  assert.equal(payappConfig({...f.env,PAYAPP_GU_USERID:'test-user',PAYAPP_GU_REQUESTKEY:'new-request'}).configured,false);
});

test('전환 후 동일 주차 요청 재시도는 원 계정·URL을 유지하며 PG 요청을 추가하지 않음',async t=>{
  const f=await fixture(t),body=f.body(),old=await f.purchase(body),before=payment(f,old.oid);activate(f.env);
  const again=await f.purchase(body);
  assert.equal(again.oid,old.oid);assert.equal(f.calls.filter(c=>c.url==='https://api.payapp.kr/oapi/v2').length,1);
  const after=payment(f,old.oid);
  for(const field of ['merchant_account','merchant_userid','mul_no','nonce','request_hash','payurl'])assert.equal(after[field],before[field]);
  const response=await status({env:f.env,request:new Request('https://socialfactory.test/api/orders/status?oid='+old.oid+'&t='+await orderToken(f.env,old.oid))});
  const data=await response.json();assert.equal(data.order.sellerName,'주식회사 블랭크');
  for(const secret of ['new-link','new-value','new-request',before.nonce])assert(!JSON.stringify(data).includes(secret));
});

test('구 DB 원장·환불·토큰·결제주소를 보존하면서 원 계정을 추가하고 거래명의 변경을 차단',async t=>{
  const f=await fixture(t);
  f.db.exec(`DROP TABLE payapp_refunds;DROP TABLE payapp_payments;
    CREATE TABLE payapp_payments(oid TEXT PRIMARY KEY,mul_no TEXT UNIQUE,nonce TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,payurl TEXT,refunded_amount INTEGER NOT NULL DEFAULT 0,created_at TEXT);
    CREATE TABLE payapp_refunds(mul_no TEXT PRIMARY KEY,oid TEXT NOT NULL,amount INTEGER NOT NULL,created_at TEXT);
    INSERT INTO payapp_payments VALUES('OLD','123','original-token','old-request','old-hash','https://payapp.kr/original',1000,'2026-11-01 12:00:00');
    INSERT INTO payapp_refunds VALUES('124','OLD',1000,'2026-11-02 12:00:00');`);
  activate(f.env);await ensurePayapp(f.env);await ensurePayapp(f.env);
  const old=payment(f,'OLD');assert.equal(old.merchant_account,'blank');assert.equal(old.merchant_userid,'test-user');
  assert.equal(old.nonce,'original-token');assert.equal(old.payurl,'https://payapp.kr/original');assert.equal(old.refunded_amount,1000);
  assert.equal(f.db.prepare('SELECT amount FROM payapp_refunds WHERE mul_no=?').get('124').amount,1000);
  assert.throws(()=>f.db.exec("UPDATE payapp_payments SET merchant_account='gu' WHERE oid='OLD'"),/payapp-merchant-immutable/);
  assert.throws(()=>f.db.exec("UPDATE payapp_payments SET merchant_userid='guspacedev' WHERE oid='OLD'"),/payapp-merchant-immutable/);
  assert.equal(payappPaymentConfig({...f.env,PAYAPP_USERID:'different-seller'},old).configured,false);
  const auth=await payappFeedbackConfig(f.env,await signed(f.env,'blank'));assert.equal(auth.account,'blank');
});
