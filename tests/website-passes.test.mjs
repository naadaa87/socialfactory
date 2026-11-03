import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {fromMs,toMs} from '../functions/_lib/kiosk.js';
import {ensureWebsitePasses,syncWebsiteOrder,syncWebsiteOrders,checkInWebsitePass,syncWebsiteRefund,websiteTerms} from '../functions/_lib/website-passes.js';
import {onRequestPost as callback} from '../functions/api/pay/payapp/feedback.js';
import {onRequestPost as backfill} from '../functions/api/admin/website-passes.js';
import {onRequestGet as passes,onRequestPatch as patchPass} from '../functions/api/admin/passes.js';
import {onRequestGet as sales} from '../functions/api/admin/sales.js';
import {onRequestGet as dashboard} from '../functions/api/admin/dashboard.js';
import {runQueue} from '../functions/_lib/notify.js';
import {kstStamp} from '../functions/_lib/payapp.js';
import {sha256} from '../functions/_lib/shop.js';
const ORIGIN='https://socialfactory.test';
function fixture(t){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-03T09:00:00Z'));
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const DB={prepare(q){let a=[];return {bind(...v){a=v;return this},async first(){return db.prepare(q).get(...a)||null},async all(){return {results:db.prepare(q).all(...a)}},async run(){return this.exec()},exec(){return {meta:{changes:Number(db.prepare(q).run(...a).changes)}}}}},async batch(ss){db.exec('BEGIN');try{const r=ss.map(s=>s.exec());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 const env={DB,ADMIN_KEY:'test-admin',PAYAPP_USERID:'seller',PAYAPP_LINKKEY:'link',PAYAPP_LINKVAL:'val',PAYAPP_REQUESTKEY:'key',PAYAPP_ENABLED:'1',SESSION_SECRET:'session'};
 let n=0;
 const seed=(product='cowork-2h',qty=1,extra={})=>{const oid='SF261103180000'+String(++n).padStart(4,'0'),mul=String(12000+n);const status=extra.status||'paid',amount=extra.amount||4000*qty;db.prepare(`INSERT INTO orders (oid,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,pg_method,tid,paid_at,start_date,test_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(oid,status,product,product,qty,amount,'모의 구매자','010-1234-5678','payapp:25',status==='pending'?null:mul,status==='pending'?null:'2026-11-03 17:31:37',extra.startDate||'',extra.test?1:0);db.prepare('INSERT INTO payapp_payments (oid,mul_no,nonce,request_id,request_hash) VALUES (?,?,?,?,?)').run(oid,mul,'nonce'+n,'request'+n,'hash');return {oid,mul}};
 const req=(path,method='GET',body,auth=true)=>new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,'content-type':path.includes('/feedback')?'application/x-www-form-urlencoded':'application/json',...(auth?{authorization:'Bearer test-admin'}:{})},...(body===undefined?{}:{body:path.includes('/feedback')?new URLSearchParams(body).toString():JSON.stringify(body)})});
 const feedback=async(o,state='4',extra={})=>{const row=db.prepare('SELECT * FROM orders WHERE oid=?').get(o.oid),responsedate=kstStamp(),p=db.prepare('SELECT nonce FROM payapp_payments WHERE oid=?').get(o.oid);return callback({env,request:req('/api/pay/payapp/feedback','POST',{userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINKKEY,linkval:env.PAYAPP_LINKVAL,responsedate,hash:await sha256(env.PAYAPP_USERID+responsedate+env.PAYAPP_REQUESTKEY),var1:o.oid,var2:p.nonce,mul_no:o.mul,price:String(row.amount),pay_type:'25',pay_state:state,...extra})})};
 const items=()=>db.prepare('SELECT p.*,pp.amount,pp.refund_amount,pp.channel,pp.status AS payment_status FROM passes p JOIN pass_payments pp ON pp.id=p.payment_id ORDER BY p.id').all();
 return {db,env,seed,req,feedback,items};
}
test('승인 주문만 전화번호로 고객·이용권에 자동 등록, 재시도/수량도 중복 없음',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',3,{status:'pending'});await syncWebsiteOrder(f.env,o.oid);assert.equal(f.items().length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n,0);
 assert.equal(await(await f.feedback(o)).text(),'SUCCESS');assert.equal(f.items().length,3);for(const p of f.items()){assert.equal(p.status,'ready');assert.equal(p.channel,'website');assert.equal(p.amount,4000);assert.equal(p.ends_at,fromMs(toMs(f.db.prepare('SELECT paid_at FROM orders WHERE oid=?').get(o.oid).paid_at)+90*864e5))}
 await f.feedback(o);await syncWebsiteOrder(f.env,o.oid);assert.equal(f.items().length,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customers').get().n,1);
 const c=f.db.prepare('SELECT * FROM customers').get();assert.equal(c.phone,'01012345678');assert.equal(c.name,'모의 구매자');assert(c.privacy_agreed_at);
});
test('처음 입실 시에만 시간 시작, 단순 목록 조회/재시작으로 기간 리셋 없음',async t=>{
 const f=fixture(t),o=f.seed();await syncWebsiteOrder(f.env,o.oid);const p=f.items()[0];assert.equal(p.status,'ready');
 const listed=await(await passes({env:f.env,request:f.req('/api/admin/passes?state=active')})).json();assert.equal(listed.results[0].status,'ready');assert.equal(f.items()[0].status,'ready');
 const r=await checkInWebsitePass(f.env,p.id);assert.equal(r.pass.starts_at,'2026-11-03 18:00:00');assert.equal(r.pass.ends_at,'2026-11-03 20:00:00');assert.equal(r.pass.status,'active');assert.equal((await checkInWebsitePass(f.env,p.id)).duplicate,true);assert.equal(f.items()[0].ends_at,r.pass.ends_at);
 assert(f.db.prepare("SELECT id FROM notification_jobs WHERE kind='expire_soon'").get());
});
test('사용 기한 지난 티켓·환불 티켓·동일 그룹 사용 중인 경우 시작 차단',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',2);await syncWebsiteOrder(f.env,o.oid);let ps=f.items();await checkInWebsitePass(f.env,ps[0].id);assert((await checkInWebsitePass(f.env,ps[1].id)).error);
 await f.feedback(o,'9');for(const p of f.items())assert.equal(p.status,'cancelled');assert((await checkInWebsitePass(f.env,ps[1].id)).error);
 const z=f.seed();await syncWebsiteOrder(f.env,z.oid);const p=f.items().at(-1);f.db.prepare("UPDATE passes SET ends_at='2026-11-02 12:00:00' WHERE id=?").run(p.id);assert.equal((await checkInWebsitePass(f.env,p.id)).error,'expired');
});
test('데이패스는 입실한 날 자정까지, 정기권·사물함은 지정일과 달력 기간 적용',async t=>{
 const f=fixture(t);let o=f.seed('cowork-day');await syncWebsiteOrder(f.env,o.oid);assert.equal((await checkInWebsitePass(f.env,f.items()[0].id)).pass.ends_at,'2026-11-04 00:00:00');
 o=f.seed('locker-month',3,{startDate:'2027-01-31'});await syncWebsiteOrder(f.env,o.oid);const lock=f.items().filter(p=>p.pass_group==='locker');assert.equal(lock[0].starts_at,'2027-01-31 00:00:00');assert.equal(lock[0].ends_at,'2027-02-28 00:00:00');assert.equal(lock[1].starts_at,'2027-02-28 00:00:00');assert.equal(lock[1].ends_at,'2027-03-28 00:00:00');assert.equal(lock[2].starts_at,lock[1].ends_at);assert.equal(lock[2].ends_at,'2027-04-28 00:00:00');
});
test('노트북 대여는 좌석 이용권으로 오발급하지 않음',async t=>{const f=fixture(t),o=f.seed('laptop-day');await syncWebsiteOrder(f.env,o.oid);assert.equal(f.items().length,0)});
test('기존 고객 이름 유지, 시작 조건 스냅샷 사용',async t=>{
 const f=fixture(t),o=f.seed();f.db.prepare("INSERT INTO customers (phone,phone_fmt,name) VALUES ('01012345678','010-1234-5678','기존 고객')").run();
 const terms={...websiteTerms({id:'cowork-2h',name:'주문 당시 이용권'}),duration:{hours:3}};f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(terms));await syncWebsiteOrder(f.env,o.oid);assert.equal(f.db.prepare('SELECT name FROM customers').get().name,'기존 고객');const p=f.items()[0];assert.equal(p.product_name,'주문 당시 이용권');assert.equal((await checkInWebsitePass(f.env,p.id)).pass.ends_at,'2026-11-03 21:00:00');
});
test('발급 도중 DB 실패는 사본·이용권을 함께 롤백하고 PG 재시도로 복구',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',2,{status:'pending'});f.db.exec("CREATE TRIGGER fail_pass BEFORE INSERT ON passes BEGIN SELECT RAISE(ABORT,'test fail'); END");assert.equal((await f.feedback(o)).status,500);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pass_payments').get().n,0);assert.equal(f.items().length,0);f.db.exec('DROP TRIGGER fail_pass');assert.equal(await(await f.feedback(o)).text(),'SUCCESS');assert.equal(f.items().length,2);
});
test('부분·전체 취소는 사본 금액과 연결 이용권에도 반영, 늦은 승인에 복원 없음',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',2);await syncWebsiteOrder(f.env,o.oid);const partial={mul_no:'555001',orig_mul_no:o.mul,orig_price:'8000',price:'4000'};await f.feedback(o,'70',partial);await f.feedback(o,'70',partial);const ps=f.items();assert.equal(ps[0].status,'cancelled');assert.equal(ps[0].refund_amount,4000);assert.equal(ps[1].status,'ready');assert.equal(ps[1].refund_amount,0);
 await f.feedback(o,'64');await f.feedback(o);for(const p of f.items()){assert.equal(p.status,'cancelled');assert.equal(p.refund_amount,4000);assert.equal(p.payment_status,'refunded')}
});
test('금액만 일부 취소했을 때 이용 시간을 임의로 단축하지 않음',async t=>{
 const f=fixture(t),o=f.seed();await syncWebsiteOrder(f.env,o.oid);await f.feedback(o,'71',{mul_no:'555002',orig_mul_no:o.mul,orig_price:'4000',price:'500'});assert.equal(f.items()[0].status,'ready');assert.equal(f.items()[0].refund_amount,500);assert.equal((await checkInWebsitePass(f.env,f.items()[0].id)).pass.ends_at,'2026-11-03 20:00:00');
});
test('전체 환불이 먼저 도착한 주문에는 이용권을 새로 발급하지 않음',async t=>{const f=fixture(t),o=f.seed();await f.feedback(o,'9');await f.feedback(o);assert.equal(f.items().length,0)});
test('기존 승인 주문 자동 복구와 관리자 인증, 홈페이지 환불 수동 덮어쓰기 차단',async t=>{
 const f=fixture(t),o=f.seed();assert.equal((await backfill({env:f.env,request:f.req('/api/admin/website-passes','POST',{},false)})).status,401);const r=await(await backfill({env:f.env,request:f.req('/api/admin/website-passes','POST',{})})).json();assert.equal(r.issued,1);assert.equal((await syncWebsiteOrders(f.env)).issued,0);
 const id=f.items()[0].id;assert.equal((await patchPass({env:f.env,request:f.req('/api/admin/passes','PATCH',{id,action:'cancel',refundAmount:4000,refundConfirmed:true})})).status,409);assert.equal(f.items()[0].status,'ready');
 assert.equal((await patchPass({env:f.env,request:f.req('/api/admin/passes','PATCH',{id,action:'check-in'})})).status,200);
});
test('홈페이지 사본 때문에 대시보드·매출 금액이 두 배가 되지 않음',async t=>{
 const f=fixture(t),o=f.seed();await syncWebsiteOrder(f.env,o.oid);let result=await(await dashboard({env:f.env,request:f.req('/api/admin/dashboard')})).json();assert.equal(result.month.orders,4000);assert.equal(result.month.kiosk,0);assert.equal(result.month.total,4000);
 result=await(await sales({env:f.env,request:f.req('/api/admin/sales?year=2026')})).json();assert.equal(result.total,4000);assert.equal(result.allTime.total,4000);assert.equal(result.thisMonth.total,4000);assert.equal(result.byMethod.kiosk,0);const without=await(await sales({env:f.env,request:f.req('/api/admin/sales?year=2026&orders=0')})).json();assert.equal(without.total,0);
 await f.feedback(o,'70',{mul_no:'555003',orig_mul_no:o.mul,orig_price:'4000',price:'1000'});result=await(await dashboard({env:f.env,request:f.req('/api/admin/dashboard')})).json();assert.equal(result.month.orders,3000);assert.equal(result.month.kiosk,0);assert.equal(result.month.total,3000);
});
test('동시 복구와 반복 통보에도 같은 단위의 결제·이용권은 한 개',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',2);await Promise.all([syncWebsiteOrder(f.env,o.oid),syncWebsiteOrder(f.env,o.oid)]);assert.equal(f.items().length,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pass_payments').get().n,2);
});
test('입실 직전 취소가 발생하면 결제 사본 반영 전이어도 시작을 거절',async t=>{
 const f=fixture(t),o=f.seed();await syncWebsiteOrder(f.env,o.oid);const original=f.env.DB.prepare;let fired=false;
 f.env.DB.prepare=function(sql){const q=original.call(this,sql);if(sql.startsWith("UPDATE passes SET status='active'")){const run=q.run;q.run=async function(){if(!fired){fired=true;f.db.prepare("UPDATE orders SET status='refunded' WHERE oid=?").run(o.oid);f.db.prepare('UPDATE payapp_payments SET refunded_amount=4000 WHERE oid=?').run(o.oid)}return run.call(q)}}return q};
 assert((await checkInWebsitePass(f.env,f.items()[0].id)).error);assert.equal(f.items()[0].status,'ready');await syncWebsiteRefund(f.env,o.oid);assert.equal(f.items()[0].status,'cancelled');
});
test('전체 취소 통보의 사본 반영 실패도 관리자 자동 복구로 회복',async t=>{
 const f=fixture(t),o=f.seed();await syncWebsiteOrder(f.env,o.oid);f.db.prepare("UPDATE orders SET status='refunded' WHERE oid=?").run(o.oid);f.db.prepare('UPDATE payapp_payments SET refunded_amount=4000 WHERE oid=?').run(o.oid);assert.equal((await syncWebsiteOrders(f.env)).orders,1);assert.equal(f.items()[0].status,'cancelled');assert.equal(f.items()[0].refund_amount,4000);assert.equal((await syncWebsiteOrders(f.env)).orders,0);
});
test('이미 이용 완료로 처리한 과거 주문에 새 입실 권리를 부여하지 않음',async t=>{const f=fixture(t),o=f.seed('cowork-2h',1,{status:'used'});await syncWebsiteOrder(f.env,o.oid);assert.equal(f.items().length,0);assert.equal((await syncWebsiteOrders(f.env)).orders,0)});

test('예약 2시간권은 선택 시각과 수량별 연속 기간을 고정하고 재시도·조회로 바꾸지 않음',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',2,{startDate:'2026-11-05 14:30:00'});
 f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(websiteTerms({id:'cowork-2h',name:'코워킹 2시간권'},'2026-11-05 14:30:00')));
 await syncWebsiteOrder(f.env,o.oid);let ps=f.items();assert.equal(ps[0].status,'active');assert.equal(ps[0].starts_at,'2026-11-05 14:30:00');assert.equal(ps[0].ends_at,'2026-11-05 16:30:00');assert.equal(ps[1].starts_at,ps[0].ends_at);assert.equal(ps[1].ends_at,'2026-11-05 18:30:00');
 const r=await(await passes({env:f.env,request:f.req('/api/admin/passes?state=active')})).json();assert.equal(r.results.length,2);
 const before=ps.map(p=>[p.starts_at,p.ends_at]);await checkInWebsitePass(f.env,ps[0].id);await syncWebsiteOrder(f.env,o.oid);await f.feedback(o);assert.deepEqual(f.items().map(p=>[p.starts_at,p.ends_at]),before);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE kind='purchase'").get().n,2);
 const reminder=f.db.prepare("SELECT * FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get();assert.equal(reminder.send_after,'2026-11-05 18:10:00');assert.equal(JSON.parse(reminder.vars).만료,'11월 5일 18:30');
});
test('예약 데이패스는 선택한 날 자정에 끝나고 시작 전 만료 알림은 만들지 않음',async t=>{
 const f=fixture(t),o=f.seed('cowork-day',2,{startDate:'2026-11-05 23:00:00'});
 f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(websiteTerms({id:'cowork-day',name:'데이패스'},'2026-11-05 23:00:00')));
 await syncWebsiteOrder(f.env,o.oid);const ps=f.items();assert.equal(ps[0].starts_at,'2026-11-05 23:00:00');assert.equal(ps[0].ends_at,'2026-11-06 00:00:00');assert.equal(ps[1].starts_at,ps[0].ends_at);assert.equal(ps[1].ends_at,'2026-11-07 00:00:00');
 const one=f.seed('cowork-day',1,{startDate:'2026-11-08 23:00:00'});f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(one.oid,JSON.stringify(websiteTerms({id:'cowork-day',name:'데이패스'},'2026-11-08 23:00:00')));await syncWebsiteOrder(f.env,one.oid);const last=f.items().at(-1);assert.equal(f.db.prepare("SELECT send_after FROM notification_jobs WHERE kind='expire_soon' AND status='queued' AND pass_id=?").get(last.id).send_after,'2026-11-08 23:00:00');
});
test('예약 주문의 지연 승인·환불은 확정 기간을 미루지 않고 알림을 취소',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',1,{startDate:'2026-11-03 15:00:00'});f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(websiteTerms({id:'cowork-2h',name:'2시간권'},'2026-11-03 15:00:00')));
 await f.feedback(o);assert.equal(f.items()[0].starts_at,'2026-11-03 15:00:00');assert.equal(f.items()[0].ends_at,'2026-11-03 17:00:00');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get().n,0);
 await f.feedback(o,'9');assert.equal(f.items()[0].status,'cancelled');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE status='queued' AND kind!='refund'").get().n,0);
});

test('예약 구매 알림은 승인 후 1회, 만료 알림은 확정 종료 20분 전에만 발송',async t=>{
 const f=fixture(t),o=f.seed('cowork-2h',1,{startDate:'2026-11-05 18:00:00'});f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(websiteTerms({id:'cowork-2h',name:'2시간권'},'2026-11-05 18:00:00')));
 Object.assign(f.env,{ALIMTALK_ENABLED:'1',ALIMTALK_PROVIDER:'webhook',ALIMTALK_WEBHOOK_URL:'https://notifications.example.test'});const sent=[];
 t.mock.method(globalThis,'fetch',async(url,opts)=>{assert.equal(url,f.env.ALIMTALK_WEBHOOK_URL);sent.push(JSON.parse(opts.body));return new Response('{"id":"mock-message"}')});
 await syncWebsiteOrder(f.env,o.oid);await syncWebsiteOrder(f.env,o.oid);await runQueue(f.env);assert.equal(sent.length,1);assert.equal(sent[0].kind,'purchase');assert(sent[0].text.includes('11월 5일 18:00'));assert(sent[0].text.includes('11월 5일 20:00'));
 let now=Date.parse('2026-11-05T10:39:00Z');t.mock.method(Date,'now',()=>now);await runQueue(f.env);assert.equal(sent.length,1);
 now+=60000;await runQueue(f.env);await runQueue(f.env);assert.equal(sent.length,2);assert.equal(sent[1].kind,'expire_soon');assert(sent[1].text.includes('11월 5일 20:00'));
});

test('날짜가 떨어진 예약은 각 이용의 만료를 안내하고, 미래 예약이 앞 예약 알림을 막지 않음',async t=>{
 const f=fixture(t);
 for(const start of ['2026-11-05 18:00:00','2026-11-10 18:00:00']){
  const o=f.seed('cowork-2h',1,{startDate:start});f.db.prepare('INSERT INTO website_order_terms VALUES (?,?)').run(o.oid,JSON.stringify(websiteTerms({id:'cowork-2h',name:'2시간권'},start)));await syncWebsiteOrder(f.env,o.oid);
 }
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_jobs WHERE kind='expire_soon' AND status='queued'").get().n,2);
 Object.assign(f.env,{ALIMTALK_ENABLED:'1',ALIMTALK_PROVIDER:'webhook',ALIMTALK_WEBHOOK_URL:'https://notifications.example.test'});const sent=[];t.mock.method(globalThis,'fetch',async(_,opts)=>{sent.push(JSON.parse(opts.body));return new Response('{"id":"mock"}')});await runQueue(f.env);
 t.mock.method(Date,'now',()=>Date.parse('2026-11-05T10:40:00Z'));await runQueue(f.env);const reminders=sent.filter(j=>j.kind==='expire_soon');assert.equal(reminders.length,1);assert(reminders[0].text.includes('11월 5일 20:00'));
});
