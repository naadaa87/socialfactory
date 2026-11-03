import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestPost as create} from '../functions/api/orders/index.js';
import {onRequestPost as feedback} from '../functions/api/pay/payapp/feedback.js';
import {onRequest as returnPage} from '../functions/api/pay/payapp/return.js';
import {onRequestGet as status} from '../functions/api/orders/status.js';
import {onRequestGet as config} from '../functions/api/shop/products.js';
import {onRequestGet as adminOrders,onRequestPatch as patchOrder} from '../functions/api/admin/orders.js';
import {onRequestGet as stats} from '../functions/api/admin/stats.js';
import {payConfig,sha256,orderToken} from '../functions/_lib/shop.js';
import {ensurePayapp,kstStamp,payappUrl,requestPayment} from '../functions/_lib/payapp.js';
const origin='https://socialfactory.test';
const buyer={productId:'cowork-2h',qty:2,name:'모의 구매자',phone:'01012345678',email:'test@example.test',payMethod:'card',agreeTerms:true,agreePrivacy:true,agreeRefund:true};
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const DB={prepare(sql){let a=[];const q={bind(...args){a=args;return q},async first(){return db.prepare(sql).get(...a)||null},async all(){return {results:db.prepare(sql).all(...a)}},async run(){return {meta:{changes:Number(db.prepare(sql).run(...a).changes)}}}};return q},async batch(qs){db.exec('BEGIN');try{const result=[];for(const q of qs) result.push(await q.run());db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}};
 const env={DB,ADMIN_KEY:'test-admin',SESSION_SECRET:'session-test-secret',SHOP_PAYMENT_PROVIDER:'payapp',PAYAPP_USERID:'test-seller',PAYAPP_LINKKEY:'test-link',PAYAPP_LINKVAL:'test-value',PAYAPP_REQUESTKEY:'test-request',PAYAPP_ENABLED:'1'};
 const req=(path,method='GET',body,headers={})=>new Request(origin+path,{method,headers:{origin,'content-type':path.endsWith('feedback')?'application/x-www-form-urlencoded':'application/json',...headers},...(body===undefined?{}:{body:path.endsWith('feedback')?new URLSearchParams(body).toString():JSON.stringify(body)})});
 const order=()=>db.prepare('SELECT o.*,p.mul_no,p.nonce FROM orders o JOIN payapp_payments p ON o.oid=p.oid ORDER BY o.id DESC').get();
 const seed=async()=>{await ensurePayapp(env);const oid='SF261103120000ABCD';db.prepare("INSERT INTO orders (oid,status,product_id,product_name,amount,buyer_name,buyer_phone,pg_method) VALUES (?,'pending','cowork-2h','모의 2시간권',8000,'구매자','010-1234-5678','payapp:pending')").run(oid);db.prepare('INSERT INTO payapp_payments (oid,mul_no,nonce,request_id,request_hash) VALUES (?,?,?,?,?)').run(oid,'12345','nonce-private','request-id-private','hash');return order()};
 const form=async(o,state='4',extra={})=>{const responsedate=kstStamp();return {userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINKKEY,linkval:env.PAYAPP_LINKVAL,responsedate,hash:await sha256(env.PAYAPP_USERID+responsedate+env.PAYAPP_REQUESTKEY),var1:o.oid,var2:o.nonce,mul_no:o.mul_no,price:String(o.amount),pay_state:state,pay_type:'1',...extra}};
 const send=async(o,state='4',extra={})=>feedback({env,request:req('/api/pay/payapp/feedback','POST',await form(o,state,extra))});
 const getStatus=async(o)=>status({env,request:req('/api/orders/status?oid='+o.oid+'&t='+await orderToken(env,o.oid))});
 return {db,env,req,order,seed,form,send,getStatus};
}
const fakePay=(t,cb)=>t.mock.method(globalThis,'fetch',async(url,opts)=>{assert.equal(url,'https://api.payapp.kr/oapi/v2');assert.equal(opts.redirect,'manual');if(cb)await cb(new URLSearchParams(opts.body));return new Response('state=1&mul_no=12345&payurl=https%3A%2F%2Fpayapp.kr%2Fsample')});
test('필수키/세션 없으면 차단하고 설정 응답에 비밀값을 노출하지 않음',async t=>{
 const f=fixture(t);const j=await(await config({env:f.env})).json();assert.equal(j.pay.ready,true);assert.equal(j.pay.provider,'payapp');assert.equal(j.pay.test,false);assert(!JSON.stringify(j).includes('test-link'));
 for(const key of ['PAYAPP_USERID','PAYAPP_LINKKEY','PAYAPP_LINKVAL','PAYAPP_REQUESTKEY','SESSION_SECRET']){const env={...f.env,[key]:''};assert.equal(payConfig(env).ready,false);assert.equal((await create({env,request:f.req('/api/orders','POST',buyer)})).status,503)}
 assert.equal(payConfig({...f.env,PAYAPP_ENABLED:'0'}).ready,false);assert.equal(payConfig({...f.env,PAYAPP_ENABLED:undefined}).ready,false);
});
test('기존 이니시스 설정/콜백 필드는 유지하고 페이앱만 중지했을 때 우회하지 않음',()=>{
 const c=payConfig({INICIS_MID:'real-mid',INICIS_SIGN_KEY:'sign'});assert.equal(c.provider,'inicis');assert.equal(c.ready,true);assert.equal(c.signKey,'sign');
 assert.equal(payConfig({SHOP_PAYMENT_PROVIDER:'payapp',INICIS_MID:'real',INICIS_SIGN_KEY:'sign'}).ready,false);
});
test('서버 상품 금액·서명·주문 nonce로 요청, SMS 미발송, 모바일/PC 동일 결제 URL',async t=>{
 const f=fixture(t);let sent;fakePay(t,s=>sent=s);
 const r=await create({env:f.env,request:f.req('/api/orders','POST',{...buyer,price:1,device:'mobile',requestId:crypto.randomUUID()})}),j=await r.json();
 assert.equal(r.status,200);assert.equal(j.amount,8000);assert.equal(j.pay.mode,'payapp');assert.equal(sent.get('price'),'8000');assert.equal(sent.get('smsuse'),'n');assert.equal(sent.get('checkretry'),'y');assert.equal(sent.get('feedbackurl'),origin+'/api/pay/payapp/feedback');assert(sent.get('goodname').startsWith('소셜팩토리 건대'));
 assert.equal(sent.get('hash'),await sha256(f.env.PAYAPP_USERID+sent.get('requestdate')+f.env.PAYAPP_REQUESTKEY));assert(!sent.has('requestkey'));
 assert.equal(f.order().status,'pending');assert.equal(f.order().mul_no,'12345');assert.equal(f.order().device,'mobile');
 for(const v of ['test-link','test-value','test-request',sent.get('var2')])assert(!JSON.stringify(j).includes(v));
 assert.equal((await returnPage({env:f.env,request:new Request(sent.get('returnurl'),{method:'POST'})})).status,303);
});
test('동일 요청 재시도/동시 요청은 주문과 PG 요청 하나, 변경된 본문은 충돌',async t=>{
 const f=fixture(t);let calls=0;fakePay(t,()=>calls++);const body={...buyer,requestId:crypto.randomUUID()};
 const invoke=b=>create({env:f.env,request:f.req('/api/orders','POST',b)});
 const rs=await Promise.all([invoke(body),invoke(body)]);for(const r of rs)assert.equal(r.status,200);
 const again=await(await invoke(body)).json();assert.equal(again.oid,f.order().oid);assert.equal(calls,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM orders').get().n,1);
 assert.equal((await invoke({...body,qty:3})).status,409);
});
test('통신 실패 후 결과 확인으로 이동, 재시도는 새로운 청구를 만들지 않음',async t=>{
 const f=fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('timeout')});const body={...buyer,requestId:crypto.randomUUID()};
 const j=await(await create({env:f.env,request:f.req('/api/orders','POST',body)})).json();assert.equal(j.ok,true);assert(j.pay.url.startsWith(origin+'/order-complete?'));assert.equal(f.order().status,'pending');
 await create({env:f.env,request:f.req('/api/orders','POST',body)});assert.equal(calls,1);
 const o=f.order();assert.equal(await(await f.send({...o,mul_no:'12345'})).text(),'SUCCESS');assert.equal(f.order().status,'paid');
});
test('명시적 요청 거절은 실패로 표시, PG 오류 원문은 노출하지 않음',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>new Response('state=0&errno=70060&errorMessage=secret-value'));
 const r=await create({env:f.env,request:f.req('/api/orders','POST',{...buyer,requestId:crypto.randomUUID()})});assert.equal(r.status,502);assert(!(await r.text()).includes('secret-value'));assert.equal(f.order().status,'failed');
});
test('위조·오래된·잘못된 금액/nonce/거래 통보 거절',async t=>{
 const f=fixture(t),o=await f.seed();
 for(const extra of [{hash:'bad'},{linkval:'bad'},{var2:'bad'},{price:'1'},{price:'8000x'},{mul_no:'999'},{responsedate:'20000101000000'},{var1:'foreign-order'}]){assert.notEqual((await f.send(o,'4',extra)).status,200);assert.equal(f.order().status,'pending')}
});
test('반복/동시 승인 통보는 한 번 반영하고 카드 전체번호/통보 원문을 저장하지 않음',async t=>{
 const f=fixture(t),o=await f.seed();
 for(const r of await Promise.all([f.send(o,'4',{card_num:'1234567812345678'}),f.send(o)]))assert.equal(await r.text(),'SUCCESS');
 assert.equal(f.order().status,'paid');const paid=f.order();assert(!JSON.stringify(paid).includes('1234567812345678'));assert.equal(paid.pg_raw,null);assert.equal(paid.pg_method,'payapp:1');
 await f.send(o,'10');assert.equal(f.order().status,'paid');
 const j=await(await f.getStatus(o)).json();assert.equal(j.order.provider,'payapp');assert.equal(j.order.payMethod,'카드');assert.equal(j.order.payurl,null);assert(!JSON.stringify(j).includes('nonce-private'));
});
test('API 응답 전 승인 통보를 받은 경우 결제창 대신 완료 확인 주소 반환',async t=>{
 const f=fixture(t);fakePay(t,async sent=>{const r=await f.send({...f.order(),mul_no:'12345'});assert.equal(await r.text(),'SUCCESS')});
 const j=await(await create({env:f.env,request:f.req('/api/orders','POST',{...buyer,requestId:crypto.randomUUID()})})).json();assert.equal(j.ok,true);assert(j.pay.url.startsWith(origin+'/order-complete?'));assert.equal(f.order().status,'paid');
});
test('DB 실패는 SUCCESS를 보내지 않고 재시도할 수 있음',async t=>{
 const f=fixture(t),o=await f.seed();f.db.exec("CREATE TRIGGER failure BEFORE UPDATE OF status ON orders BEGIN SELECT RAISE(ABORT,'test failure'); END");assert.equal((await f.send(o)).status,500);assert.equal(f.order().status,'pending');f.db.exec('DROP TRIGGER failure');assert.equal(await(await f.send(o)).text(),'SUCCESS');
});
test('전체 취소 후 늦은 승인/대기/부분 통보로 주문을 복원하지 않음',async t=>{
 const f=fixture(t),o=await f.seed();await f.send(o);await f.send(o,'9');await f.send(o);await f.send(o,'10');await f.send(o,'70',{mul_no:'200',orig_mul_no:o.mul_no,orig_price:'8000',price:'1000'});assert.equal(f.order().status,'refunded');assert.equal((await(await f.getStatus(o)).json()).order.refundedAmount,8000);
});
test('부분 취소는 원거래 검증/중복 제거, 통계/주문에 순매출 반영',async t=>{
 const f=fixture(t),o=await f.seed();await f.send(o);const extra={mul_no:'200',orig_mul_no:o.mul_no,orig_price:'8000',price:'3000'};
 for(let n=0;n<2;n++)assert.equal(await(await f.send(o,'70',extra)).text(),'SUCCESS');assert.equal(f.order().status,'paid');assert.equal((await(await f.getStatus(o)).json()).order.refundedAmount,3000);
 assert.equal((await f.send(o,'70',{...extra,orig_price:'1'})).status,400);assert.equal((await f.send(o,'70',{...extra,price:'4000'})).status,400);
 const request=f.req('/api/admin/orders','GET',undefined,{authorization:'Bearer test-admin'}),j=await(await adminOrders({env:f.env,request})).json();assert.equal(j.sales,5000);assert.equal(j.results[0].refunded_amount,3000);
 const s=await(await stats({env:f.env,request})).json();assert.equal(s.periods.all.sales,5000);assert.equal(s.products.find(x=>x.id==='cowork-2h').sales,5000);
 await f.send(o,'71',{...extra,mul_no:'201',price:'5000'});assert.equal(f.order().status,'refunded');assert.equal((await(await f.getStatus(o)).json()).order.refundedAmount,8000);
});
test('수동 상태 변경은 PG 승인/취소를 가장하지 못하고 메모/이용 완료만 허용',async t=>{
 const f=fixture(t),o=await f.seed();const patch=body=>patchOrder({env:f.env,request:f.req('/api/admin/orders','PATCH',{id:o.id,...body},{authorization:'Bearer test-admin'})});
 assert.equal((await patch({status:'paid'})).status,409);await f.send(o);assert.equal((await patch({status:'refunded'})).status,409);assert.equal((await patch({status:'used',memo:'입실 확인'})).status,200);assert.equal(f.order().status,'used');assert.equal(f.order().admin_memo,'입실 확인');
});
test('복귀 URL은 올바른 조회 토큰만 허용하고 승인 처리하지 않음',async t=>{
 const f=fixture(t),o=await f.seed();assert.equal((await(await f.getStatus(o)).json()).order.payMethod,'결제 대기');for(const path of ['/api/pay/payapp/return?oid='+o.oid,'/api/pay/payapp/return?oid='+o.oid+'&t=forged'])assert.equal((await returnPage({env:f.env,request:f.req(path)})).status,403);
 const r=await returnPage({env:f.env,request:f.req('/api/pay/payapp/return?oid='+o.oid+'&t='+await orderToken(f.env,o.oid))});assert.equal(r.status,303);assert.equal(f.order().status,'pending');
 assert.equal((await status({env:f.env,request:f.req('/api/orders/status?oid='+o.oid)})).status,403);
});
test('결제 중지 후에도 기존 주문 취소 통보 처리',async t=>{const f=fixture(t),o=await f.seed();await f.send(o);f.env.PAYAPP_ENABLED='0';assert.equal(await(await f.send(o,'64')).text(),'SUCCESS');assert.equal(f.order().status,'refunded')});
test('기존 DB도 표 자동 준비',async t=>{const f=fixture(t);f.db.exec('DROP TABLE payapp_refunds; DROP TABLE payapp_payments');await ensurePayapp(f.env);assert(f.db.prepare("SELECT name FROM sqlite_master WHERE name='payapp_payments'").get())});
test('HTTPS 페이앱 주소만 허용하고 외부 리다이렉트는 따라가지 않음',async t=>{for(const u of ['http://payapp.kr/a','https://payapp.kr.evil.test/x','https://user:password@payapp.kr/','https://payapp.kr:443/x','javascript:alert(1)']){if(u.includes(':443'))continue;assert.equal(payappUrl(u),null)}assert.equal(payappUrl('https://payapp.kr/a'),'https://payapp.kr/a');t.mock.method(globalThis,'fetch',async()=>new Response('',{status:302,headers:{Location:'https://evil.test'}}));await assert.rejects(requestPayment(payConfig(fixture(t).env).payapp,{}))});
test('요청 출처·누락 동의·번호 오류·과다 요청은 PG 호출 전에 차단',async t=>{
 const f=fixture(t);let calls=0;fakePay(t,()=>calls++);
 for(const body of [{...buyer,agreeTerms:false},{...buyer,phone:'0212345678'},{...buyer,requestId:'invalid'}])assert.equal((await create({env:f.env,request:f.req('/api/orders','POST',body)})).status,400);
 assert.equal((await create({env:f.env,request:f.req('/api/orders','POST',{...buyer,requestId:crypto.randomUUID()},{origin:'https://evil.test'})})).status,403);
 const {ipHashOf}=await import('../functions/_lib/auth.js');const r=f.req('/api/orders','POST',{...buyer,requestId:crypto.randomUUID()},{'cf-connecting-ip':'192.0.2.1'}),ip=await ipHashOf(r,f.env);
 for(let n=0;n<30;n++)f.db.prepare("INSERT INTO orders (oid,product_id,product_name,amount,buyer_name,buyer_phone,ip_hash) VALUES (?,'cowork-2h','모의 주문',4000,'모의','01012345678',?)").run('rate'+n,ip);
 assert.equal((await create({env:f.env,request:r})).status,429);assert.equal(calls,0);
});
test('결제 대기 중인 기존 요청의 URL만 재사용, 계좌이체 수단 정확히 전달',async t=>{
 const f=fixture(t);let sent;fakePay(t,s=>sent=s);const j=await(await create({env:f.env,request:f.req('/api/orders','POST',{...buyer,payMethod:'bank',requestId:crypto.randomUUID()})})).json();assert.equal(sent.get('openpaytype'),'rbank');assert.equal(j.pay.url,'https://payapp.kr/sample');assert.equal((await(await f.getStatus(f.order())).json()).order.payurl,j.pay.url);
});
test('부분 취소가 승인 통보보다 먼저 도착해도 남은 승인 금액을 매출로 반영',async t=>{
 const f=fixture(t),o=await f.seed();await f.send(o,'70',{mul_no:'200',orig_mul_no:o.mul_no,orig_price:'8000',price:'3000'});assert.equal(f.order().status,'paid');await f.send(o);assert.equal((await(await f.getStatus(o)).json()).order.refundedAmount,3000);
});
test('환불 요청만 한 상태는 실제 환불 통보 전까지 매출 유지',async t=>{
 const f=fixture(t),o=await f.seed();await f.send(o);await patchOrder({env:f.env,request:f.req('/api/admin/orders','PATCH',{id:o.id,status:'refund_requested'},{authorization:'Bearer test-admin'})});const r=await adminOrders({env:f.env,request:f.req('/api/admin/orders','GET',undefined,{authorization:'Bearer test-admin'})});assert.equal((await r.json()).sales,8000);
});
