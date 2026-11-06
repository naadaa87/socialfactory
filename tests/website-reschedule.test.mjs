import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestPost as change} from '../functions/api/orders/reschedule.js';
import {onRequestGet as status} from '../functions/api/orders/status.js';
import {onRequestGet as memberOrders} from '../functions/api/member/orders.js';
import {websiteTerms,syncWebsiteOrder} from '../functions/_lib/website-passes.js';
import {orderToken} from '../functions/_lib/shop.js';
import {sha256Hex} from '../functions/_lib/auth.js';
import {expiryNoticeStmts,queuePassNotices} from '../functions/_lib/kiosk.js';
import {runQueue} from '../functions/_lib/notify.js';
const origin='https://socialfactory.test';
async function fixture(t,{product='cowork-2h',qty=1,start='2026-11-05 14:30:00'}={}){
 let now=Date.parse('2026-11-03T09:00:00Z');t.mock.method(Date,'now',()=>now);
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 // Keep SQLite's transaction-time guard on the same controlled clock as Date.now.
 const clockSql=q=>q.replace(/\bdatetime\(\s*'now'/gi,()=>"datetime('"+new Date(now).toISOString()+"'");
 const DB={prepare(q){let a=[];return {q,bind(...v){a=v;return this},async first(){return db.prepare(clockSql(q)).get(...a)||null},async all(){return {results:db.prepare(clockSql(q)).all(...a)}},async run(){return this.exec()},exec(){return {meta:{changes:Number(db.prepare(clockSql(q)).run(...a).changes)}}}}},async batch(ss){db.exec('BEGIN');try{const r=ss.map(s=>s.exec());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const env={DB,SESSION_SECRET:'session-only-test'},oid='SF261103180000ABCD';
 db.prepare(`INSERT INTO orders(oid,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,tid,paid_at,created_at,start_date) VALUES (?,'paid',?,?,?,?,'구매자','010-1234-5678','12000','2026-11-03 17:30:00','2026-11-03 17:29:00',?)`).run(oid,product,'2시간권',qty,4000*qty,start);
 db.prepare("INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES (?,'12000','nonce','payment-request','original-payment-hash')").run(oid);
 db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(oid,JSON.stringify(websiteTerms({id:product,name:product},start)));
 await syncWebsiteOrder(env,oid);
 const token=await orderToken(env,oid),body={oid,token,expectedStart:start,startAt:'2026-11-06T16:00',requestId:crypto.randomUUID()};
 const request=(b=body,headers={})=>new Request(origin+'/api/orders/reschedule',{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(b)});
 const invoke=(b=body,headers)=>change({env,request:request(b,headers)});
 const passes=()=>db.prepare('SELECT * FROM passes ORDER BY id').all();
 const get=()=>status({env,request:new Request(origin+'/api/orders/status?oid='+oid+'&t='+token)});
 const member=async(id=1)=>{const tok='member-test-cookie-'+String(id).padStart(20,'0');db.prepare("INSERT INTO members(id,name,phone,email) VALUES (?,'회원','010-1234-5678',?)").run(id,`member${id}@example.test`);db.prepare("INSERT INTO sessions(token_hash,member_id,expires_at) VALUES (?,?,'2099-01-01 00:00:00')").run(await sha256Hex(tok),id);return 'sf_session='+tok};
 return {db,env,oid,token,body,request,invoke,passes,get,member,setNow(v){now=Date.parse(v)}};
}
test('비회원 주문 토큰으로 시간·종료·조건·미발송 구매 알림·만료 예약을 원자적으로 변경',async t=>{
 const f=await fixture(t,{qty:2}),before=f.passes();const oldExpiry=f.db.prepare("SELECT id FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get();
 const r=await f.invoke();assert.equal(r.status,200);assert.equal((await r.json()).ok,true);const ps=f.passes();assert.deepEqual(ps.map(p=>p.id),before.map(p=>p.id));assert.deepEqual(ps.map(p=>[p.starts_at,p.ends_at]),[['2026-11-06 16:00:00','2026-11-06 18:00:00'],['2026-11-06 18:00:00','2026-11-06 20:00:00']]);
 assert.equal(f.db.prepare('SELECT start_date FROM orders').get().start_date,'2026-11-06 16:00:00');assert.equal(f.db.prepare('SELECT amount FROM orders').get().amount,8000);assert.equal(f.db.prepare('SELECT request_hash FROM payapp_payments').get().request_hash,'original-payment-hash');
 assert.equal(JSON.parse(f.db.prepare('SELECT terms FROM website_order_terms').get().terms).startAt,'2026-11-06 16:00:00');
 for(const row of f.db.prepare('SELECT terms FROM kiosk_payment_terms').all())assert.equal(JSON.parse(row.terms).startAt,'2026-11-06 16:00:00');
 assert.equal(f.db.prepare('SELECT status FROM notification_jobs WHERE id=?').get(oldExpiry.id).status,'cancelled');const next=f.db.prepare("SELECT * FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get();assert.equal(next.send_after,'2026-11-06 19:40:00');assert.equal(JSON.parse(next.vars).만료,'11월 6일 20:00');
 const purchase=f.db.prepare("SELECT vars FROM notification_jobs WHERE kind='purchase' ORDER BY id").all();assert.equal(purchase.length,2);assert.equal(JSON.parse(purchase[0].vars).시작,'11월 6일 16:00');
 const o=(await(await f.get()).json()).order;assert.equal(o.schedule.allowed,true);assert.equal(o.startDate,'2026-11-06 16:00:00');assert.equal(o.schedule.maxStart,'2027-02-01 17:29:00');
 await syncWebsiteOrder(f.env,f.oid);assert.equal(f.passes()[0].starts_at,ps[0].starts_at);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,1);
});
test('다른 계정·잘못된 토큰·외부 사이트는 차단, 주문 소유 회원은 토큰 없이 변경',async t=>{
 const f=await fixture(t);assert.equal((await f.invoke({...f.body,token:'wrong'})).status,403);assert.equal((await f.invoke(f.body,{origin:'https://other.test'})).status,403);
 const own=await f.member(1),other=await f.member(2);f.db.prepare('UPDATE orders SET member_id=1').run();assert.equal((await f.invoke({...f.body,token:''},{cookie:other})).status,403);assert.equal((await f.invoke({...f.body,token:''},{cookie:own})).status,200);
 const list=await memberOrders({env:f.env,request:new Request(origin+'/api/member/orders',{headers:{cookie:own}})});assert.equal((await list.json()).results[0].start_date,'2026-11-06 16:00:00');
 const no=await memberOrders({env:f.env,request:new Request(origin+'/api/member/orders',{headers:{cookie:other}})});assert.equal((await no.json()).results.length,0);
});
test('이용 시작 경계·취소·부분 환불·관리자 조정·발송 중에는 변경 불가',async t=>{
 const f=await fixture(t);f.setNow('2026-11-05T05:30:00Z');assert.equal((await f.invoke()).status,409);f.setNow('2026-11-03T09:00:00Z');
 f.db.prepare("UPDATE orders SET status='refunded'").run();assert.equal((await f.invoke()).status,409);f.db.prepare("UPDATE orders SET status='paid'").run();
 f.db.prepare('UPDATE payapp_payments SET refunded_amount=500').run();assert.equal((await f.invoke()).status,409);f.db.prepare('UPDATE payapp_payments SET refunded_amount=0').run();
 f.db.prepare("UPDATE passes SET ends_at='2026-11-05 20:00:00'").run();assert.equal((await f.invoke()).status,409);f.db.prepare("UPDATE passes SET ends_at='2026-11-05 16:30:00'").run();
 f.db.prepare("UPDATE notification_jobs SET status='sending' WHERE kind='purchase'").run();assert.equal((await f.invoke()).status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,0);
});
test('실제 한국 날짜·미래와 원래 구매일의 90일 한도를 검증',async t=>{
 const f=await fixture(t);
 for(const startAt of ['2026-11-31T12:00','2026-11-03T17:00','2026-11-04T25:00','2026-11-04T18:00Z'])assert.equal((await f.invoke({...f.body,startAt})).status,400);
 f.setNow('2026-11-04T09:00:00Z');const r=await f.invoke({...f.body,startAt:'2027-02-02T12:00'});assert.equal(r.status,400);assert.equal((await r.json()).field,'originalLimit');
 assert.equal(f.passes()[0].starts_at,'2026-11-05 14:30:00');
});
test('데이패스와 여러 매는 새 날짜의 자정 기준 연속 기간으로 변경',async t=>{
 const f=await fixture(t,{product:'cowork-day',qty:2});assert.equal((await f.invoke({...f.body,startAt:'2026-11-07T23:00'})).status,200);assert.deepEqual(f.passes().map(p=>[p.starts_at,p.ends_at]),[['2026-11-07 23:00:00','2026-11-08 00:00:00'],['2026-11-08 00:00:00','2026-11-09 00:00:00']]);
});
test('오래된 화면·동시 변경은 한 요청만 반영하고 같은 요청 재시도는 추가 변경하지 않음',async t=>{
 const f=await fixture(t);const old=f.body,other={...old,requestId:crypto.randomUUID(),startAt:'2026-11-07T10:00'};
 const rs=await Promise.all([f.invoke(old),f.invoke(other)]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
 const accepted=rs[0].status===200?old:other,at=f.passes()[0].starts_at;assert.equal((await f.invoke(accepted)).status,200);assert.equal(f.passes()[0].starts_at,at);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,1);
 const next={...accepted,requestId:crypto.randomUUID(),expectedStart:at,startAt:'2026-11-08T11:00'};assert.equal((await f.invoke(next)).status,200);assert.equal((await f.invoke(accepted)).status,200);assert.equal(f.passes()[0].starts_at,'2026-11-08 11:00:00');
});
test('변경 중 DB 오류가 나면 주문·이용권·조건·알림·이력 모두 롤백, 같은 요청 재시도 가능',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER fail_notice BEFORE UPDATE ON notification_jobs BEGIN SELECT RAISE(ABORT,'failure'); END");assert.equal((await f.invoke()).status,500);assert.equal(f.passes()[0].starts_at,f.body.expectedStart);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,0);assert.equal(f.db.prepare('SELECT start_date FROM orders').get().start_date,f.body.expectedStart);
 f.db.exec('DROP TRIGGER fail_notice');assert.equal((await f.invoke()).status,200);
});
test('전송한 구매 알림은 기록을 유지하고 새 구매 알림은 추가하지 않음',async t=>{
 const f=await fixture(t);f.db.prepare("UPDATE notification_jobs SET status='sent',rendered='이미 발송한 본문' WHERE kind='purchase'").run();assert.equal((await f.invoke()).status,200);const p=f.db.prepare("SELECT * FROM notification_jobs WHERE kind='purchase'").all();assert.equal(p.length,1);assert.equal(p[0].status,'sent');assert.equal(p[0].rendered,'이미 발송한 본문');
});
test('수량·금액·명의 등 브라우저 값은 시간 변경에 쓰지 않으며 변경 시 기존 별도 예약 알림 유지',async t=>{
 const f=await fixture(t);const second='SF261103180000NEXT';f.db.prepare("INSERT INTO orders(oid,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,tid,paid_at,start_date) SELECT ?,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,tid,paid_at,? FROM orders WHERE oid=?").run(second,'2026-11-10 14:30:00',f.oid);
 f.db.prepare("INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES (?,'12001','n2','p2','h2')").run(second);f.db.prepare("UPDATE orders SET tid='12001' WHERE oid=?").run(second);f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(second,JSON.stringify(websiteTerms({id:'cowork-2h',name:'별도 예약'},'2026-11-10 14:30:00')));await syncWebsiteOrder(f.env,second);
 assert.equal((await f.invoke({...f.body,qty:10,amount:0,name:'다른 고객'})).status,200);assert.equal(f.passes().length,2);assert.equal(f.db.prepare('SELECT amount FROM orders WHERE oid=?').get(f.oid).amount,4000);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get().n,2);
});
test('대기열 선택 후 변경된 미발송 구매 알림은 새 시간으로만 발송',async t=>{
 const f=await fixture(t);Object.assign(f.env,{ALIMTALK_ENABLED:'1',ALIMTALK_PROVIDER:'webhook',ALIMTALK_WEBHOOK_URL:'https://notify.example.test'});let mutated=false;const prepare=f.env.DB.prepare;
 f.env.DB.prepare=function(q){const s=prepare.call(this,q);if(q.startsWith("UPDATE notification_jobs SET status = 'sending'")){const run=s.run;s.run=async function(){if(!mutated){mutated=true;assert.equal((await f.invoke()).status,200)}return run.call(s)}}return s};
 const sent=[];t.mock.method(globalThis,'fetch',async(_,o)=>{sent.push(JSON.parse(o.body));return new Response('{"id":"mock"}')});await runQueue(f.env);assert.equal(sent.length,1);assert(sent[0].text.includes('11월 6일 16:00'));assert(!sent[0].text.includes('11월 5일 14:30'));
});

test('검사 직후 환불이 들어와도 트랜잭션의 원장 검사로 변경을 거절',async t=>{
 const f=await fixture(t),prepare=f.env.DB.prepare;let fired=false;
 f.env.DB.prepare=function(q){const s=prepare.call(this,q);if(q.startsWith('INSERT OR IGNORE INTO website_schedule_changes')){const exec=s.exec;s.exec=function(){if(!fired){fired=true;f.db.prepare("UPDATE orders SET status='refunded'").run();f.db.prepare('UPDATE payapp_payments SET refunded_amount=4000').run()}return exec.call(s)}}return s};
 assert.equal((await f.invoke()).status,409);assert.equal(f.passes()[0].starts_at,f.body.expectedStart);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,0);
});
test('동일 요청이 동시에 도착해도 변경 이력과 기간 갱신은 한 번',async t=>{
 const f=await fixture(t),responses=await Promise.all([f.invoke(),f.invoke()]);assert(responses.every(r=>r.status===200));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,1);assert.equal(f.passes()[0].starts_at,'2026-11-06 16:00:00');
});
test('같은 요청 키로 서로 다른 시각을 동시에 보내면 성공으로 오인하지 않음',async t=>{
 const f=await fixture(t),rs=await Promise.all([f.invoke(),f.invoke({...f.body,startAt:'2026-11-07T11:00'})]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM website_schedule_changes').get().n,1);
});
test('일정 변경 전에 만든 오래된 알림 재계산이 나중에 실행돼도 새 예약을 지우지 않음',async t=>{
 const f=await fixture(t),pass=f.passes()[0],customer=f.db.prepare('SELECT * FROM customers').get();const stale=await expiryNoticeStmts(f.env,customer,pass.pass_group);
 assert.equal((await f.invoke()).status,200);await f.env.DB.batch(stale);const jobs=f.db.prepare("SELECT * FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").all();assert.equal(jobs.length,1);assert.equal(jobs[0].send_after,'2026-11-06 17:40:00');
});
test('승인 통보와 일정 변경이 겹쳐도 처음 구매 안내에는 최신 시각만 저장',async t=>{
 const f=await fixture(t),pass=f.passes()[0],pay=f.db.prepare('SELECT * FROM pass_payments').get();f.db.prepare("DELETE FROM notification_jobs WHERE kind='purchase'").run();
 assert.equal((await f.invoke()).status,200);await queuePassNotices(f.env,pass,pay);const jobs=f.db.prepare("SELECT * FROM notification_jobs WHERE kind='purchase'").all();assert.equal(jobs.length,1);assert.equal(JSON.parse(jobs[0].vars).시작,'11월 6일 16:00');
});
test('동시에 관리자 번호 이동이 일어나면 예전 고객 기준으로 일정을 덮어쓰지 않음',async t=>{
 const f=await fixture(t),prepare=f.env.DB.prepare;let moved=false;f.env.DB.prepare=function(q){const s=prepare.call(this,q);if(q.startsWith('INSERT OR IGNORE INTO website_schedule_changes')){const exec=s.exec;s.exec=function(){if(!moved){moved=true;f.db.prepare("INSERT INTO customers(phone) VALUES ('01099998888')").run();f.db.prepare('UPDATE passes SET customer_id=2').run();f.db.prepare('UPDATE pass_payments SET customer_id=2').run()}return exec.call(s)}}return s};assert.equal((await f.invoke()).status,409);assert.equal(f.passes()[0].starts_at,f.body.expectedStart);
});
