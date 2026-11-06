import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { normalizePayment, stamp, ensureTossSales, TOSS_SOURCE, preparePayments, savePayments, verifyWebhook } from '../functions/_lib/toss-sales.js';
import { onRequestPost as webhook } from '../functions/api/toss-place/webhook.js';
import { onRequestPost as admin, onRequestGet as status } from '../functions/api/admin/toss-sales.js';
import { onRequestGet as sales } from '../functions/api/admin/sales.js';
import { onRequestGet as dashboard } from '../functions/api/admin/dashboard.js';

const currentDay=new Date(Date.now()+9*3600e3).toISOString().slice(0,10), year=currentDay.slice(0,4);
const paidAt=currentDay+'T09:00:00+09:00';
const payment=(extra={})=>({id:'640000000000000001',merchantId:42,orderId:'620000000000000001',state:'APPROVED',sourceType:'CARD',paymentMethod:'CARD_IC',amount:12000,approvedNo:'00123456',approvedAt:paidAt,updatedAt:paidAt,...extra});
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
  const DB={prepare(sql){let args=[];const q={bind(...a){args=a;return q},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)||null},async run(){return {meta:db.prepare(sql).run(...args)}}};return q;},async batch(qs){db.exec('BEGIN');try{const result=[];for(const q of qs)result.push(await q.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const env={DB,ADMIN_KEY:'admin-test',SESSION_SECRET:'local-session-test',TOSS_PLACE_MERCHANT_ID:'42',TOSS_PLACE_ACCESS_KEY:'access-private',TOSS_PLACE_SECRET_KEY:'secret-private',TOSS_PLACE_WEBHOOK_SECRET:'webhook-private'};
  const request=(body,auth=true)=>new Request('https://example.test/api/admin/toss-sales',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer admin-test'}:{})},body:JSON.stringify(body)});
  const post=async body=>admin({env,request:request(body)});
  const get=path=>new Request('https://example.test'+path,{headers:{authorization:'Bearer admin-test'}});
  const getSales=async(extra='')=>(await sales({env,request:get('/api/admin/sales?year='+year+extra)})).json();
  const send=async(p=payment(),eventId='evt-1',options={})=>{
    const event={id:eventId,type:p.state==='CANCELLED'?'payment.payment.cancelled.v1':'payment.payment.approved.v1',createdAt:paidAt,merchantId:42,data:{payment:p},...options.event};
    const raw=JSON.stringify(event),timestamp=String(options.timestamp??Date.now());
    const signature='v1='+createHmac('sha256',options.secret||env.TOSS_PLACE_WEBHOOK_SECRET).update(timestamp+'.'+raw).digest('hex');
    return webhook({env,request:new Request('https://example.test/api/toss-place/webhook',{method:'POST',headers:{'x-toss-webhook-id':eventId,'x-toss-timestamp':timestamp,'x-toss-signature':options.signature||signature},body:raw})});
  };
  const included=()=>db.prepare('SELECT * FROM '+TOSS_SOURCE).all();
  const seedPass=(p=payment(),testMode=0)=>{
    db.exec("INSERT OR IGNORE INTO customers(id,phone) VALUES(1,'01000000000')");
    db.prepare("INSERT INTO pass_payments(payment_key,status,channel,customer_id,product_id,product_name,amount,approval_number,paid_at,test_mode) VALUES(?,'paid','toss_front',1,'cowork-2h','2시간권',?,?,?,?)")
      .run('SFK'+p.id,p.amount,p.approvedNo,stamp(p.approvedAt).kst,testMode);
  };
  const manual=()=>db.prepare("INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,paid_at) VALUES('R1','confirmed','r1',?,600,660,'test','visit',12000,'card_offline','paid',?)").run(currentDay,currentDay);
  return {env,db,post,request,get,getSales,send,included,seedPass,manual};
}

test('timestamps normalize KST and reject invalid dates, unsafe IDs, amounts and foreign merchants',()=>{
  assert.equal(stamp('2026-11-04T15:00:00Z').kst,'2026-11-05 00:00:00');
  assert.equal(stamp('2026-02-30T10:00:00'),null);
  assert.equal(normalizePayment(payment(),'42').approval_no,'00123456');
  for(const bad of [{merchantId:43},{id:640000000000000001},{amount:-1},{amount:'12000'},{state:'PENDING'},{approvedAt:'bad'},{updatedAt:'2000-01-01T00:00:00Z'},{state:'CANCELLED',cancelledAt:null}])assert.throws(()=>normalizePayment(payment(bad),'42'));
});

test('live Toss nanosecond timestamps work for signed installation and payment events',async t=>{
  const f=fixture(t);
  const at=currentDay+'T09:00:00.123456789+09:00';
  assert.equal(stamp(at).ms,Date.parse(currentDay+'T09:00:00.123+09:00'));
  assert.equal(stamp('2026-02-30T10:00:00.123456789Z'),null);
  assert.equal(stamp(currentDay+'T09:00:00.1234567890Z'),null);
  f.env.TOSS_PLACE_MERCHANT_ID='';
  assert.equal((await f.send(payment(),'live-install',{event:{type:'app.installation.created.v1',createdAt:at,merchantId:42,data:{merchant:{id:42,name:'소셜팩토리 건대'}}}})).status,200);
  assert.equal(f.db.prepare('SELECT installed FROM toss_installations').get().installed,1);
  f.env.TOSS_PLACE_MERCHANT_ID='42';
  const p=payment({approvedAt:at,updatedAt:at});
  assert.equal((await f.send(p,'live-payment')).status,200);
  assert.equal(f.included()[0].paid_at,currentDay+' 09:00:00');
  await f.post({action:'commit',payments:[p]});
  assert.equal(f.included().length,1);
});

test('admin import requires authentication and validates whole batch before writing',async t=>{
  const f=fixture(t);
  assert.equal((await admin({env:f.env,request:f.request({action:'commit',payments:[payment()]},false)})).status,401);
  for(const rows of [[],[payment(),payment()],[payment(),payment({id:'2',amount:-1})]])assert.equal((await f.post({action:'commit',payments:rows})).status,400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM toss_payments').get().n,0);
});

test('preview is read-only, import is idempotent and creates no passes/reservations/messages',async t=>{
  const f=fixture(t);let r=await f.post({action:'preview',payments:[payment()]});assert.equal(r.status,200);assert.equal((await r.json()).rows[0].counted,true);
  assert.equal(f.included().length,0);
  for(let i=0;i<3;i++)assert.equal((await f.post({action:'commit',payments:[payment()]})).status,200);
  assert.equal(f.included().length,1);
  for(const table of ['passes','pass_payments','reservations','notification_jobs'])assert.equal(f.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
});

test('general terminal appears in all totals/months/channels/dashboard even with passes unchecked',async t=>{
  const f=fixture(t);await f.post({action:'commit',payments:[payment()]});
  for(const extra of ['','&orders=0','&basis=use']){
    const d=await f.getSales(extra);assert.equal(d.total,12000);assert.equal(d.allTime.total,12000);assert.equal(d.thisMonth.total,12000);assert.equal(d.byMethod.toss_terminal,12000);assert.equal(d.countBy.toss_terminal,1);assert.equal(d.byChannel.toss_terminal.amount,12000);
    assert.equal(d.months.find(m=>m.ym===currentDay.slice(0,7)).total,12000);
  }
  const d=await(await dashboard({env:f.env,request:f.get('/api/admin/dashboard')})).json();assert.equal(d.month.total,12000);assert.equal(d.month.terminal,12000);
});

test('signed webhook repeats once and rejects tampered, stale, wrong merchant or state events',async t=>{
  const f=fixture(t);
  for(const options of [{secret:'wrong'},{timestamp:Date.now()-400000},{event:{merchantId:43}},{event:{type:'payment.payment.cancelled.v1'}},{signature:'v1='+'0'.repeat(64)}])assert.notEqual((await f.send(payment(),'bad',options)).status,200);
  assert.equal((await f.send()).status,200);assert.equal((await(await f.send()).json()).duplicate,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM toss_webhook_events').get().n,1);assert.equal(f.included().length,1);
});

test('official HMAC uses the exact raw body and timestamp, not parsed/re-serialized JSON',async()=>{
  const raw='{ "id" : "example" }',time=String(Date.now()),secret='key';
  const sig='v1='+createHmac('sha256',secret).update(time+'.'+raw).digest('hex');
  const req=new Request('https://example.test',{headers:{'x-toss-timestamp':time,'x-toss-signature':sig}});
  assert.equal(await verifyWebhook(req,raw,secret),true);assert.equal(await verifyWebhook(req,JSON.stringify(JSON.parse(raw)),secret),false);
});

test('cancel before approval, old snapshots and late approval never restore cancelled revenue',async t=>{
  const f=fixture(t),cancel=payment({state:'CANCELLED',cancelledAt:currentDay+'T10:00:00+09:00',updatedAt:currentDay+'T10:00:00+09:00'});
  assert.equal((await f.send(cancel,'cancel')).status,200);assert.equal((await f.send(payment(),'late')).status,200);
  await f.post({action:'commit',payments:[payment()]});
  assert.equal(f.included()[0].refund_amount,12000);assert.equal((await f.getSales()).total,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM toss_webhook_events').get().n,2);
});

test('same payment ID cannot change original amount/order/approval on reimport or webhook',async t=>{
  const f=fixture(t);await f.send();
  for(const extra of [{amount:1000},{orderId:'999'},{approvedNo:'changed'},{pgDetails:{transactionId:'different'}}]){
    assert.equal((await f.post({action:'commit',payments:[payment(extra)]})).status,400);
    assert.equal((await f.send(payment(extra),'conflict')).status,409);
  }
  assert.equal(f.included()[0].amount,12000);
});

test('webhook transaction rolls back if event recording fails, and retry succeeds',async t=>{
  const f=fixture(t);await ensureTossSales(f.env);f.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON toss_webhook_events BEGIN SELECT RAISE(ABORT,'test'); END");
  assert.equal((await f.send()).status,500);assert.equal(f.included().length,0);
  f.db.exec('DROP TRIGGER fail_event');assert.equal((await f.send()).status,200);assert.equal(f.included().length,1);
});

test('plugin arriving after webhook is dynamically excluded; cancellations subtract once from plugin revenue',async t=>{
  const f=fixture(t);await f.send();assert.equal(f.included().length,1);
  f.seedPass();assert.equal(f.included().length,0);let d=await f.getSales();assert.equal(d.total,12000);assert.equal(d.byMethod.kiosk,12000);assert.equal(d.byMethod.toss_terminal,0);
  await f.send(payment({state:'CANCELLED',cancelledAt:currentDay+'T10:00:00+09:00',updatedAt:currentDay+'T10:00:00+09:00'}),'cancel');
  d=await f.getSales();assert.equal(d.total,0);assert.equal(d.refunds,12000);
});

test('test-mode plugin and zero approval placeholders cannot introduce duplicate revenue',async t=>{
  const f=fixture(t);f.seedPass(payment(),1);await f.send();assert.equal((await f.getSales()).total,0);
  const zero=payment({id:'2',orderId:'3',approvedNo:'00000000'});await f.post({action:'commit',payments:[zero]});assert.equal(f.included().length,0);
});

test('manual card candidates stay on hold until explicit reviewed decision, without changing reservation',async t=>{
  const f=fixture(t);f.manual();await f.send();assert.equal(f.included().length,0);assert.equal((await f.getSales()).total,12000);
  assert.equal((await f.post({action:'review',paymentId:payment().id,decision:'include',note:''})).status,400);
  assert.equal((await f.post({action:'review',paymentId:payment().id,decision:'include',note:'별도 거래 확인'})).status,200);assert.equal((await f.getSales()).total,24000);
  assert.equal((await(await f.post({action:'preview',payments:[payment()]})).json()).rows[0].counted,true);
  await f.post({action:'review',paymentId:payment().id,decision:'exclude',note:'수기 매출과 중복'});assert.equal((await f.getSales()).total,12000);assert.equal(f.db.prepare('SELECT amount FROM reservations').get().amount,12000);
  assert.equal((await(await f.post({action:'preview',payments:[payment()]})).json()).rows[0].counted,false);
});

test('external recorded payment methods stay out of revenue and cannot be forced into sales',async t=>{
  const f=fixture(t);await f.post({action:'commit',payments:[payment({sourceType:'EXTERNAL'})]});assert.equal(f.included().length,0);
  assert.equal((await f.post({action:'review',paymentId:payment().id,decision:'include',note:'확인했습니다'})).status,400);
});

test('administrator-issued offline passes without approval identifiers are held for manual reconciliation',async t=>{
  const f=fixture(t);f.seedPass();f.db.exec("UPDATE pass_payments SET channel='admin',approval_number=NULL,pay_method='card_offline'");
  await f.send();assert.equal(f.included().length,0);assert.equal((await f.getSales()).total,12000);
  const d=await(await status({env:f.env,request:f.get('/api/admin/toss-sales')})).json();assert.equal(d.rows[0].disposition,'review');
});

test('an offline pass registered days after a terminal payment stays on hold until reviewed',async t=>{
  const f=fixture(t);f.seedPass();
  f.db.prepare("UPDATE pass_payments SET channel='admin',approval_number=NULL,pay_method='card_offline',paid_at=datetime(?,'+4 days')").run(currentDay);
  await f.send();assert.equal(f.included().length,0);assert.equal((await f.getSales()).total,12000);
  const d=await(await status({env:f.env,request:f.get('/api/admin/toss-sales')})).json();assert.equal(d.rows[0].disposition,'review');
  f.db.prepare("UPDATE pass_payments SET paid_at=datetime(?,'+8 days')").run(currentDay);
  assert.equal(f.included().length,1);
});

test('approval timestamps determine deduplication even when result reporting crossed midnight',async t=>{
  const f=fixture(t);f.seedPass();f.db.prepare("UPDATE pass_payments SET paid_at='2027-01-01 00:00:03',approved_ts=?").run(Date.parse(paidAt));
  await f.send();assert.equal(f.included().length,0);
});

test('zero-approval cash is a distinct general payment and webhook/import share the same ID',async t=>{
  const f=fixture(t),p=payment({sourceType:'CASH',paymentMethod:'CASH',approvedNo:'00000000'});
  await f.post({action:'commit',payments:[p]});await f.send(p);assert.equal(f.included().length,1);assert.equal((await f.getSales()).total,12000);
});

test('historical API uses official endpoint, all order states, stable paging and server credentials',async t=>{
  const f=fixture(t);let count=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    count++;const u=new URL(url);assert.equal(u.origin,'https://open-api.tossplace.com');assert.equal(u.pathname,'/api-public/openapi/v1/merchants/42/order/orders');
    assert.equal(u.searchParams.get('page'),'2');assert.equal(u.searchParams.get('size'),'25');assert(u.searchParams.get('orderStates').includes('OPENED'));
    assert.equal(u.searchParams.get('from'),'2022-01-01T00:00:00Z');
    assert.equal(options.headers['x-secret-key'],'secret-private');assert.equal(options.redirect,'manual');
    assert.equal(options.headers['User-Agent'],'SocialfactorySales/1.0 (+https://socialfactory.co.kr)');
    return Response.json({resultType:'SUCCESS',success:[{merchantId:42,payments:[payment()]}]});
  });
  const d=await(await f.post({action:'fetch',from:'2020-01-01',to:currentDay,page:2})).json();assert.equal(count,1);assert.equal(d.payments.length,1);assert.equal(d.nextPage,null);assert.equal(f.included().length,0);
  assert(!JSON.stringify(d).includes('secret-private'));
});

test('connection status never exposes keys; missing setup, foreign payments, rate limit fail clearly',async t=>{
  const f=fixture(t);const d=await(await status({env:f.env,request:f.get('/api/admin/toss-sales')})).json();assert(d.apiReady);assert(d.webhookReady);
  for(const key of ['secret-private','access-private','webhook-private'])assert(!JSON.stringify(d).includes(key));
  t.mock.method(globalThis,'fetch',async()=>new Response('private-upstream-error',{status:429}));
  const r=await f.post({action:'fetch',from:'2020-01-01',to:currentDay,page:1});assert.equal(r.status,422);assert(!(await r.text()).includes('private-upstream-error'));
  f.env.TOSS_PLACE_MERCHANT_ID='';assert.equal((await f.post({action:'commit',payments:[payment()]})).status,400);assert.equal((await f.send()).status,503);
});

test('Workers-compatible fetch refuses redirects without forwarding credentials',async t=>{
  const f=fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.equal(new URL(url).origin,'https://open-api.tossplace.com');
    assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://other.example/collect'}});
  });
  const r=await f.post({action:'fetch',from:'2020-01-01',to:currentDay,page:1});
  assert.equal(r.status,422);assert.equal(calls,1);
  assert.match((await r.json()).message,/HTTP 302/);
  assert.equal(f.included().length,0);
});

test('signed installation discovers merchant before configuration without enabling payments or saving owner contacts',async t=>{
  const f=fixture(t);f.env.TOSS_PLACE_MERCHANT_ID='';
  const event={type:'app.installation.created.v1',merchantId:42,data:{merchant:{id:42,name:'소셜팩토리 건대',ownerName:'private-owner',businessNumber:'private-number',phone:'private-phone'}}};
  assert.equal((await f.send(payment(),'install',{event})).status,200);
  assert.equal((await f.send()).status,503);
  assert.equal(f.env.TOSS_PLACE_MERCHANT_ID,'');
  const stored=f.db.prepare('SELECT * FROM toss_installations').get();assert.equal(stored.merchant_id,'42');assert.equal(stored.installed,1);
  const d=await(await status({env:f.env,request:f.get('/api/admin/toss-sales')})).json();assert.equal(d.installations[0].merchant_name,'소셜팩토리 건대');assert.equal(d.lastWebhook,null);assert.equal(d.apiReady,false);assert.equal(d.signingReady,true);
  for(const secret of ['private-owner','private-number','private-phone']){assert(!JSON.stringify(stored).includes(secret));assert(!JSON.stringify(d).includes(secret));}
});

test('installation requires signature and matching merchant metadata; stale install does not restore removal',async t=>{
  const f=fixture(t);const event={type:'app.installation.created.v1',merchantId:42,data:{merchant:{id:42,name:'소셜팩토리 건대'}}};
  assert.equal((await f.send(payment(),'bad-install',{event,secret:'wrong'})).status,401);
  assert.equal((await f.send(payment(),'bad-id',{event:{...event,data:{merchant:{id:43}}}})).status,400);
  await f.send(payment(),'install',{event});
  await f.send(payment(),'uninstall',{event:{type:'app.installation.deleted.v1',merchantId:42,createdAt:currentDay+'T10:00:00+09:00',data:{merchantId:42}}});
  await f.send(payment(),'old-install',{event});
  const row=f.db.prepare('SELECT * FROM toss_installations').get();assert.equal(row.installed,0);assert.equal(row.merchant_name,'소셜팩토리 건대');
});

test('signed developer webhook test works before merchant setup but never grants access or writes payments',async t=>{
  const f=fixture(t);f.env.TOSS_PLACE_MERCHANT_ID='';
  const r=await f.send(payment(),'test-event',{event:{type:'_test.v1'}});assert.equal(r.status,200);assert.equal((await r.json()).test,true);
  assert.equal(f.env.TOSS_PLACE_MERCHANT_ID,'');
});
