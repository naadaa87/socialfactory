import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {onRequestPost as send} from '../functions/api/guest/request.js';import {onRequestPost as verify} from '../functions/api/guest/verify.js';import {onRequestGet as list} from '../functions/api/guest/orders.js';import {onRequestGet as meta,onRequestDelete as logout} from '../functions/api/guest/session.js';
import {onRequestGet as detail} from '../functions/api/orders/status.js';import {onRequestPost as change} from '../functions/api/orders/reschedule.js';import {cleanupGuest} from '../functions/_lib/guest-orders.js';import {websiteTerms,syncWebsiteOrder} from '../functions/_lib/website-passes.js';
import {onRequestGet as bookingDetail} from '../functions/api/booking/payment-status.js';
function fixture(t){
 let now=Date.parse('2026-11-03T09:00:00Z');t.mock.method(Date,'now',()=>now);const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 // Keep SQLite's transaction-time guard on the same controlled clock as Date.now.
 const clockSql=q=>q.replace(/\bdatetime\(\s*'now'/gi,()=>"datetime('"+new Date(now).toISOString()+"'");
 const DB={prepare(q){let a=[];return {bind(...v){a=v;return this},async first(){return db.prepare(clockSql(q)).get(...a)||null},async all(){return {results:db.prepare(clockSql(q)).all(...a)}},async run(){return this.exec()},exec(){return {meta:{changes:Number(db.prepare(clockSql(q)).run(...a).changes)}}}}},async batch(ss){db.exec('BEGIN');try{const r=ss.map(s=>s.exec());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const env={DB,SESSION_SECRET:'guest-test-secret',GUEST_OTP_ENABLED:'1',ALIGO_API_KEY:'api-test-key',ALIGO_USER_ID:'test-user',ALIGO_SENDER:'0212345678'},sent=[];let response={result_code:1,msg_id:'test-mid',success_cnt:1,error_cnt:0},throwNet=false;
 t.mock.method(globalThis,'fetch',async(url,o)=>{const form=new URLSearchParams(o.body);sent.push({url,form});assert.equal(o.redirect,'manual');if(throwNet)throw Error('timeout');return new Response(JSON.stringify(response))});
 const req=(path,body,cookie='',headers={})=>new Request('https://socialfactory.test'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://socialfactory.test','content-type':'application/json','cf-connecting-ip':'192.0.2.10',...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const issue=async(phone='01012345678',headers)=>{const r=await send({env,request:req('/api/guest/request',{phone},'',headers)});return {r,j:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],code:sent.at(-1)?.form.get('msg').match(/\d{6}/)?.[0]}};
 const prove=(issued,code=issued.code,cookie=issued.cookie)=>verify({env,request:req('/api/guest/verify',{challenge:issued.j.challenge,code},cookie)});
 const auth=async()=>{const i=await issue(),v=await prove(i);assert.equal(v.status,200);return v.headers.get('set-cookie').split(';')[0]};
 const seed=async(oid,phone='010-1234-5678',member=null)=>{db.prepare("INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,member_id,start_date,tid,paid_at,created_at) VALUES (?,'paid','cowork-2h','2시간권',4000,'테스트 고객',?,?,'2026-11-06 14:00:00',?,'2026-11-03 17:30:00','2026-11-03 17:29:00')").run(oid,phone,member,oid);db.prepare('INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES (?,?,?,?,?)').run(oid,oid,'n'+oid,'r'+oid,'h');db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(oid,JSON.stringify(websiteTerms({id:'cowork-2h',name:'2시간권'},'2026-11-06 14:00:00')));await syncWebsiteOrder(env,oid)};
 return {db,env,sent,req,issue,prove,auth,seed,advance(ms){now+=ms},response(v){response=v},network(){throwNet=true}};
}
test('문자 6자리 인증과 HttpOnly 단기 세션, 인증번호·키·토큰은 응답에 노출하지 않음',async t=>{
 const f=fixture(t),i=await f.issue();assert.equal(i.r.status,200);assert.equal(i.code.length,6);for(const v of [i.code,f.env.ALIGO_API_KEY,'01012345678'])assert(!JSON.stringify(i.j).includes(v));assert.match(i.r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Secure/);assert(!f.db.prepare('SELECT code_hash FROM guest_otp_challenges').get().code_hash.includes(i.code));
 const r=await f.prove(i),j=await r.json();assert.equal(j.ok,true);assert.equal(j.maskedPhone,'010-****-5678');assert.match(r.headers.get('set-cookie'),/Max-Age=1800/);assert.equal(f.db.prepare('SELECT code_hash FROM guest_otp_challenges').get().code_hash,'');assert.equal((await f.prove(i)).status,400);
});
test('다른 브라우저·잘못된 인증번호·만료 및 5회 초과 입력 거절',async t=>{
 const f=fixture(t),i=await f.issue();assert.equal((await f.prove(i,i.code,'sf_guest_challenge=other-browser')).status,400);const wrong=i.code==='000000'?'111111':'000000';for(let n=0;n<5;n++)assert.equal((await f.prove(i,wrong)).status,400);assert.equal((await f.prove(i)).status,400);
 f.advance(61000);const next=await f.issue();f.advance(300001);assert.equal((await f.prove(next)).status,400);
});
test('동시·연속 문자 요청은 한 번만 접수하고 전화/IP/하루 제한 적용',async t=>{
 const f=fixture(t),rs=await Promise.all([f.issue(),f.issue()]);assert.deepEqual(rs.map(r=>r.r.status).sort(),[200,429]);assert.equal(f.sent.length,1);
 for(let n=1;n<5;n++){f.advance(61000);assert.equal((await f.issue()).r.status,200)}f.advance(61000);assert.equal((await f.issue()).r.status,429);
 const g=fixture(t);g.env.GUEST_OTP_DAILY_LIMIT='2';assert.equal((await g.issue('01012345671')).r.status,200);assert.equal((await g.issue('01012345672')).r.status,200);assert.equal((await g.issue('01012345673')).r.status,429);assert.equal(g.sent.length,2);
});
test('발송 응답 미확인은 자동 재발송 없이 도착한 코드로 인증, 명시적 거절은 실패 처리',async t=>{
 const f=fixture(t);f.network();const i=await f.issue();assert.equal(i.r.status,202);assert.equal(i.j.delivery,'unconfirmed');assert.equal(f.sent.length,1);assert.equal((await f.prove(i)).status,200);
 const g=fixture(t);g.response({result_code:-101,message:'private-provider-message'});const rejected=await g.issue();assert.equal(rejected.r.status,502);assert(!JSON.stringify(rejected.j).includes('private-provider-message'));assert.equal(g.db.prepare('SELECT status FROM guest_otp_challenges').get().status,'failed');
});
test('설정 비활성·잘못된 번호·외부 출처는 발송 없이 거절',async t=>{
 const f=fixture(t);f.env.GUEST_OTP_ENABLED='0';assert.equal((await f.issue()).r.status,503);f.env.GUEST_OTP_ENABLED='1';assert.equal((await f.issue('01012345678\n01087654321')).r.status,400);assert.equal((await f.issue('01012345678',{origin:'https://evil.test'})).r.status,403);assert.equal(f.sent.length,0);
 f.env.ALIGO_RELAY_URL='https://evil.test/send';f.env.ALIGO_RELAY_SECRET='test-secret';assert.equal((await f.issue()).r.status,503);assert.equal(f.sent.length,0);
});
test('인증한 번호의 비회원 주문만 조회, 같은 번호 회원 주문·타인 주문은 차단',async t=>{
 const f=fixture(t);await f.seed('SF261103180000G001');await f.seed('SF261103180000G002','010-8765-4321');await f.seed('SF261103180000G003','010-1234-5678',42);
 assert.equal((await list({env:f.env,request:f.req('/api/guest/orders')})).status,401);const cookie=await f.auth();const r=await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)}),j=await r.json();assert.deepEqual(j.results.map(o=>o.oid),['SF261103180000G001']);assert(!JSON.stringify(j).includes('테스트 고객'));assert(!JSON.stringify(j).includes('010-1234-5678'));
 for(const [oid,status] of [['SF261103180000G001',200],['SF261103180000G002',403],['SF261103180000G003',403]])assert.equal((await detail({env:f.env,request:f.req('/api/orders/status?oid='+oid,undefined,cookie)})).status,status);
});
test('휴대폰 인증 세션으로 본인 비회원 일정만 변경, 인증 종료·30분 경과 후 거절',async t=>{
 const f=fixture(t);await f.seed('SF261103180000G001');await f.seed('SF261103180000G002','010-8765-4321');const cookie=await f.auth();const body={oid:'SF261103180000G001',expectedStart:'2026-11-06 14:00:00',startAt:'2026-11-07T16:00',requestId:crypto.randomUUID()};
 assert.equal((await change({env:f.env,request:f.req('/api/orders/reschedule',{...body,oid:'SF261103180000G002'},cookie)})).status,403);assert.equal((await change({env:f.env,request:f.req('/api/orders/reschedule',body,cookie)})).status,200);
 assert.equal(f.db.prepare('SELECT start_date FROM orders WHERE oid=?').get(body.oid).start_date,'2026-11-07 16:00:00');
 const m=await(await meta({env:f.env,request:f.req('/api/guest/session',undefined,cookie)})).json();assert(m.verified);assert(!JSON.stringify(m).includes('01012345678'));
 const out=await logout({env:f.env,request:new Request('https://socialfactory.test/api/guest/session',{method:'DELETE',headers:{origin:'https://socialfactory.test',cookie}})});assert.equal(out.status,200);assert.equal((await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).status,401);
 f.advance(61000);const cookie2=await f.auth();f.advance(1800001);assert.equal((await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie2)})).status,401);f.advance(86400000);await cleanupGuest(f.env);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM guest_otp_challenges').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM guest_order_sessions').get().n,0);
});
test('인증번호 동시 검증은 하나의 세션만 만들고 코드를 재사용할 수 없음',async t=>{
 const f=fixture(t),i=await f.issue(),rs=await Promise.all([f.prove(i),f.prove(i)]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,400]);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM guest_order_sessions').get().n,1);
});
test('휴대폰 인증만으로 오래된 주문 이력을 조회하거나 추측한 주문번호에 접근하지 못함',async t=>{
 const f=fixture(t);await f.seed('SF261103180000G001');f.db.prepare("UPDATE orders SET created_at='2026-01-01 00:00:00'").run();const cookie=await f.auth();assert.equal((await(await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).json()).results.length,0);assert.equal((await detail({env:f.env,request:f.req('/api/orders/status?oid=SF261103180000G001',undefined,cookie)})).status,403);
});

function bookingFixture(f,{code='B-RECOVERY',phone='010-1234-5678',date='2099-12-15',status='awaiting_payment',payment='sync_pending',sync='pending',invoice=false,created='2026-11-03 18:00:00',expires=null}={}){
 f.db.prepare(`INSERT INTO booking_requests(code,submission_id,fingerprint,status,room,date,start_min,end_min,people,customer_name,phone,email,company,purpose,requests,amount,consent,notice_version,payment_status,created_at,expires_at)
  VALUES (?,?,?,?,'r5',?,1380,1500,6,'Private guest',?,'private@example.com','Private company','meeting','Private request',16000,1,'test',?,?,?)`).run(code,code,code,status,date,phone,payment,created,expires);
 if(sync)f.db.prepare(`INSERT INTO spacecloud_blocks(code,room,date,start_min,end_min,marker,access_token,state,created_at,updated_at) VALUES (?,'r5',?,1380,1500,?,?,?,1,1)`).run(code,date,'SFWEB:'+code,'hold-token-'+code,sync);
 if(invoice)f.db.prepare(`INSERT INTO booking_payapp_requests(code,kind,label,amount,token,mul_no,pay_url,status,created_at) VALUES (?,'room','5번룸 청구',16000,?,?,?, 'requested',?)`).run(code,'pay-token-'+code,'mul-'+code,'https://payapp.kr/private-provider-link',created);
 return code;
}
function officeFixture(f,{code='OF-RECOVERY',phone='010-1234-5678',status='requested',purpose='office',created='2026-11-03 18:01:00'}={}){
 const id=Number(f.db.prepare(`INSERT INTO inquiries(receipt,submission_id,purpose,name,phone,message,consent) VALUES (?,?,?,'Private office customer',?,'Private terms',1)`).run(code,code,purpose,phone).lastInsertRowid);
 f.db.prepare(`INSERT INTO booking_payapp_requests(code,kind,inquiry_id,label,amount,token,mul_no,pay_url,status,created_at) VALUES (?,'office',?,'독립사무실 월 이용료',275000,?,?,?, ?,?)`).run(code,id,'office-token-'+code,'mul-'+code,'https://payapp.kr/private-provider-link',status,created);
 return code;
}
test('OTP identity recovers only matching room/office links, including holds before an invoice, and preserves legacy orders',async t=>{
 const f=fixture(t);await f.seed('SF-LEGACY');bookingFixture(f);bookingFixture(f,{code:'B-WITH-INVOICE',date:'2099-12-16',invoice:true,payment:'pending',sync:'blocked'});
 officeFixture(f);bookingFixture(f,{code:'B-OTHER',phone:'01087654321',date:'2099-12-17'});officeFixture(f,{code:'OF-OTHER',phone:'01087654321'});officeFixture(f,{code:'OF-NONOFFICE',purpose:'rental'});
 const denied=await list({env:f.env,request:f.req('/api/guest/orders?phone=01012345678')});assert.equal(denied.status,401);assert(!JSON.stringify(await denied.json()).includes('token-'));
 const forged=await list({env:f.env,request:f.req('/api/guest/orders',undefined,'sf_guest='+('a'.repeat(43)))});assert.equal(forged.status,401);
 const cookie=await f.auth(),response=await list({env:f.env,request:f.req('/api/guest/orders?phone=01087654321',undefined,cookie)}),j=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(new Set(j.results.map(o=>o.oid)),new Set(['SF-LEGACY','B-RECOVERY','B-WITH-INVOICE','OF-RECOVERY']));
 const serialized=JSON.stringify(j);for(const secret of ['Private guest','Private company','Private request','Private office customer','Private terms','private@example.com','01012345678','010-1234-5678','private-provider-link','token-B-OTHER','token-OF-OTHER','token-OF-NONOFFICE'])assert(!serialized.includes(secret),secret);
 const room=j.results.find(o=>o.oid==='B-RECOVERY');assert.equal(room.status,'sync_pending');assert.equal(room.statusLabel,'예약 일정 확보 중');assert.equal(room.start_min,1380);assert.equal(room.end_min,1500);
 assert.equal(j.results.filter(o=>o.oid==='B-WITH-INVOICE').length,1);
 for(const o of j.results.filter(o=>o.kind)){
  assert.equal(Object.hasOwn(o,'token'),false);assert.equal(Object.hasOwn(o,'access_token'),false);assert.equal(Object.hasOwn(o,'payment_token'),false);
  const url=new URL(o.detail_url,'https://socialfactory.test');assert.equal(url.pathname,'/booking-status');assert.equal(url.searchParams.get('code'),o.oid);
  assert.equal((await bookingDetail({env:f.env,request:f.req('/api/booking/payment-status'+url.search)})).status,200);
 }
 assert.equal(new URL(j.results.find(o=>o.oid==='B-WITH-INVOICE').detail_url,'https://socialfactory.test').searchParams.get('t'),'hold-token-B-WITH-INVOICE');
 const wrong=await bookingDetail({env:f.env,request:f.req('/api/booking/payment-status?code=B-OTHER&t=hold-token-B-RECOVERY')});assert.equal(wrong.status,404);
});
test('recovered room status distinguishes cancellation in progress, confirmed payment, pending and review without expiring holds',async t=>{
 const f=fixture(t),cases=[
  {code:'B-VERIFYING',payment:'paid_verifying',sync:'blocked',expected:'paid_verifying'},
  {code:'B-RELEASING',payment:'releasing',sync:'releasing',expected:'releasing'},
  {code:'B-CANCELLED',status:'cancelled',payment:'cancelled',sync:'released',expected:'cancelled'},
  {code:'B-CONFIRMED',status:'confirmed',payment:'paid',sync:'blocked',expected:'confirmed'},
  {code:'B-REVIEW',status:'payment_review',payment:'review',sync:'review',expected:'sync_review'},
  {code:'B-EXPIRED',status:'requested',payment:'unpaid',sync:null,expires:'2026-11-03 17:00:00',expected:'expired'},
  {code:'B-PENDING',payment:'pending',sync:'blocked',invoice:true,expected:'pending'}
 ];
 cases.forEach((c,i)=>bookingFixture(f,{...c,date:'2099-12-'+String(i+1).padStart(2,'0')}));
 officeFixture(f,{code:'OF-CANCELLED',status:'cancelled'});officeFixture(f,{code:'OF-REFUNDED',status:'refunded'});officeFixture(f,{code:'OF-PARTIAL',status:'partial_refund'});
 const cookie=await f.auth(),j=await(await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).json();
 for(const c of cases)assert.equal(j.results.find(o=>o.oid===c.code).status,c.expected,c.code);
 assert.equal(j.results.find(o=>o.oid==='OF-CANCELLED').statusLabel,'결제요청 취소');assert.equal(j.results.find(o=>o.oid==='OF-REFUNDED').statusLabel,'환불 완료');assert.equal(j.results.find(o=>o.oid==='OF-PARTIAL').statusLabel,'부분 환불');
 assert.equal(f.db.prepare("SELECT status FROM booking_requests WHERE code='B-EXPIRED'").get().status,'requested');
 assert.equal(j.results.find(o=>o.oid==='B-EXPIRED').detail_url,null);
});
test('booking recovery respects the same 90-day boundary, normalized verified number and session expiry',async t=>{
 const f=fixture(t);bookingFixture(f,{code:'B-OLD',created:'2026-01-01 00:00:00'});officeFixture(f,{code:'OF-OLD',created:'2026-01-01 00:00:00'});
 bookingFixture(f,{code:'B-SPACES',phone:'010 1234 5678',date:'2099-12-16'});officeFixture(f,{code:'OF-SPACES',phone:'010 1234 5678'});
 const cookie=await f.auth(),j=await(await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).json();assert.deepEqual(new Set(j.results.map(o=>o.oid)),new Set(['B-SPACES','OF-SPACES']));
 f.advance(1800001);const denied=await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)});assert.equal(denied.status,401);assert(!JSON.stringify(await denied.json()).includes('token-'));
});
test('legacy guest lookup continues without creating missing booking-integration tables',async t=>{
 const f=fixture(t);await f.seed('SF-LEGACY');f.db.exec('DROP TABLE spacecloud_blocks; DROP TABLE booking_payapp_requests;');
 const cookie=await f.auth(),j=await(await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).json();assert.equal(j.ok,true);assert.deepEqual(j.results.map(o=>o.oid),['SF-LEGACY']);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='spacecloud_blocks'").get().n,0);
});
test('office recovery matches the inquiry API digit-only identity for punctuation and text without returning another number tokens',async t=>{
 const f=fixture(t),phones=['010.1234.5678','010 (1234)5678','전화: 010/1234/5678','010\t1234\n5678'];
 phones.forEach((phone,index)=>officeFixture(f,{code:'OF-FORMAT-'+index,phone}));
 officeFixture(f,{code:'OF-OTHER-PUNCTUATION',phone:'010 (8765)4321'});officeFixture(f,{code:'OF-EXTRA-DIGIT',phone:'010.1234.56789'});officeFixture(f,{code:'OF-SHORT-NUMBER',phone:'010.123.4567'});
 const unauthenticated=await list({env:f.env,request:f.req('/api/guest/orders?phone=01012345678')});assert.equal(unauthenticated.status,401);assert(!JSON.stringify(await unauthenticated.json()).includes('office-token-'));
 const cookie=await f.auth(),response=await list({env:f.env,request:f.req('/api/guest/orders?phone=01087654321',undefined,cookie)}),j=await response.json();assert.equal(response.status,200);
 assert.deepEqual(new Set(j.results.map(o=>o.oid)),new Set(phones.map((_,index)=>'OF-FORMAT-'+index)));
 const serialized=JSON.stringify(j);for(const code of ['OF-OTHER-PUNCTUATION','OF-EXTRA-DIGIT','OF-SHORT-NUMBER'])assert(!serialized.includes(code));
 for(const row of j.results){const url=new URL(row.detail_url,'https://socialfactory.test');assert.equal(url.searchParams.get('t'),'office-token-'+row.oid);assert.equal(Object.hasOwn(row,'token'),false);}
});
test('sync conflicts and review errors outrank paid verification in recovered room status',async t=>{
 const f=fixture(t),cases=[
  {code:'B-PAID-SYNC-REVIEW',sync:'review',expected:'sync_review',label:'예약 일정 확인 중'},
  {code:'B-PAID-SYNC-CONFLICT',sync:'conflict',expected:'sync_conflict',label:'일정 중복 · 결제 불가'},
  {code:'B-PAID-BOOKING-REVIEW',sync:'blocked',status:'payment_review',expected:'review',label:'예약·결제 상태 확인 중'},
  {code:'B-PAID-PROVIDER-REVIEW',sync:'blocked',invoice:true,provider:'review',expected:'review',label:'예약·결제 상태 확인 중'},
  {code:'B-PAID-PROVIDER-FAILED',sync:'blocked',invoice:true,provider:'failed',expected:'failed',label:'결제요청 실패'},
  {code:'B-PAID-VERIFICATION-ONLY',sync:'blocked',expected:'paid_verifying',label:'결제 확인 · 예약 확정 중'}
 ];
 cases.forEach((c,index)=>{bookingFixture(f,{...c,payment:'paid_verifying',date:'2099-11-'+String(index+1).padStart(2,'0')});if(c.provider)f.db.prepare('UPDATE booking_payapp_requests SET status=? WHERE code=?').run(c.provider,c.code);});
 const cookie=await f.auth(),j=await(await list({env:f.env,request:f.req('/api/guest/orders',undefined,cookie)})).json();
 for(const c of cases){const row=j.results.find(o=>o.oid===c.code);assert.equal(row.status,c.expected,c.code);assert.equal(row.statusLabel,c.label,c.code);}
});
