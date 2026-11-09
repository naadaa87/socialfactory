import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../functions/_lib/auth.js';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';
import { getBooking,prepareBookings,applyBookingPayment } from '../functions/_lib/booking.js';
import { getSync,finishSyncJob } from '../functions/_lib/booking-spacecloud-sync.js';
import { cancelBookingRequest,onSyncCompleted,sweepUnpaidBookings } from '../functions/_lib/booking-checkout.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { onRequestGet as pollWorker,onRequestPost as completeWorker } from '../functions/api/internal/spacecloud-sync.js';
import { onRequestGet as paymentStatus,onRequestPost as checkout } from '../functions/api/booking/payment-status.js';
import { onRequestPost as cancel } from '../functions/api/booking/cancel.js';
import { onRequestPost as feedback } from '../functions/api/booking/payapp-feedback.js';

import { onRequestPatch as updateBooking,onRequestGet as listBookings } from '../functions/api/admin/booking-requests.js';
import { runBookingNotifications } from '../functions/_lib/booking-notify.js';
import { kstTimestamp } from '../functions/_lib/booking.js';
import { BOOKING_TEMPLATES } from '../functions/_lib/booking-templates.js';

const ORIGIN='https://example.test';
function fixture() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  let batchTail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},async batch(statements){
      const task=batchTail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}});batchTail=task.catch(()=>{});return task;}};
  return {DB,sqlite,ADMIN_KEY:'test-sync-flow-admin',SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'test-only-worker-token-more-than-thirty-two-characters',
    SPACECLOUD_RUNNER_URL:'https://runner.example.workers.dev',CLOUD_ADMIN_TOKEN:'test-only-cloud-admission-admin-token-more-than-thirty-two',
    PAYAPP_ENABLED:'1',PAYAPP_USERID:'test-sync-merchant',PAYAPP_LINK_KEY:'test-sync-key',PAYAPP_LINK_VALUE:'test-sync-value',PAYAPP_REQUEST_KEY:'test-sync-request-key',PAYAPP_SITE_URL:ORIGIN};
}
const post=(path,body,token)=>new Request(ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
const body=(extra={})=>({submissionId:crypto.randomUUID(),room:'r5',date:addDaysIso(kstToday(),12),start_min:600,end_min:720,people:6,name:'테스트 예약자',phone:'01012345678',purpose:'meeting',consent:true,...extra});
async function create(env,input=body()) {
  const response=await submit({request:post('/api/booking/requests',input),env});return {response,data:await response.json(),input};
}
async function nextJob(env) {
  const response=await pollWorker({request:new Request(ORIGIN+'/api/internal/spacecloud-sync',{headers:{authorization:'Bearer '+env.SPACECLOUD_WORKER_TOKEN}}),env});
  assert.equal(response.status,200);return (await response.json()).job;
}
const receipt=(job,extra={})=>({marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,segments:job.segments,no_conflicts:true,verified_blocked:true,observed_at:Date.now(),...extra});
async function done(env,job,{status='succeeded',proof=receipt(job)}={}) {
  return completeWorker({request:post('/api/internal/spacecloud-sync',{action:'complete',job_id:job.id,lease_token:job.lease_token,status,receipt:proof},env.SPACECLOUD_WORKER_TOKEN),env});
}
const paymentRow=(env,code)=>env.sqlite.prepare('SELECT * FROM booking_payapp_requests WHERE code=?').get(code);
const tokenFrom=data=>new URL(data.status_url,ORIGIN).searchParams.get('t');
const stamp=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,19).replace(/\D/g,'');
async function notify(env,code,state,extra={}) {
  const row=paymentRow(env,code),fields={userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINK_KEY,linkval:env.PAYAPP_LINK_VALUE,
    responsedate:stamp(),var1:code,var2:row.token,mul_no:row.mul_no,price:String(row.amount),pay_state:state,pay_date:stamp(),...extra};
  fields.hash=await sha256Hex(env.PAYAPP_USERID+fields.responsedate+env.PAYAPP_REQUEST_KEY);
  return feedback({request:new Request(ORIGIN+'/api/booking/payapp-feedback',{method:'POST',body:new URLSearchParams(fields)}),env});
}
const requestCheckout=(env,code,t)=>checkout({request:post('/api/booking/payment-status',{code,t,consent:true}),env});
const readyCloudStatus=()=>({ok:true,enabled:true,allow_writes:true,login_saved:true,public_login_saved:true,runner:{busy:false,review:false},budget:{utc_day:new Date().toISOString().slice(0,10),utc_month:new Date().toISOString().slice(0,7),daily_limit_ms:2700000,daily_reserved_ms:0,monthly_limit_ms:7200000,monthly_reserved_ms:0,rolling_32d_limit_ms:7200000,rolling_32d_reserved_ms:0}});
async function withProvider(run,{mode='success',cloudStatus,sms,alimtalk,unapproved=false}={}) {
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
    if(String(url)==='https://runner.example.workers.dev/status'){
      assert.equal(options?.method || 'GET','GET');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer test-only-cloud-admission-admin-token-more-than-thirty-two');
      const data=readyCloudStatus();if(cloudStatus)cloudStatus(data);return Response.json(data);
    }
    if(String(url)==='https://runner.example.workers.dev/run'){
      assert.equal(options?.method,'POST');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer test-only-worker-token-more-than-thirty-two-characters');
      return Response.json({ok:true,scheduled:true},{status:202});
    }
    if(alimtalk && String(url).includes('/template/list/')) {
      const code=options.body.get('tpl_code');
      const kind=Object.keys(BOOKING_TEMPLATES).find(key=>'mock-'+key===code || code==='mock-unapproved-receipt' && key==='received');
      const template=BOOKING_TEMPLATES[kind];
      return Response.json({code:0,list:template?[{templtCode:code,inspStatus:unapproved?'REQ':'APR',
        status:'A',templtContent:template.text,buttons:template.buttons.button}]:[]});
    }
    if(alimtalk && String(url).includes('/alimtalk/send/')) {
      alimtalk.push(new URLSearchParams(options.body));
      return Response.json({code:0,info:{mid:alimtalk.length,scnt:1,fcnt:0}});
    }
    if(sms && String(url)==='https://apis.aligo.in/send/') {
      sms.push(new URLSearchParams(options.body));
      return Response.json({result_code:1,msg_id:sms.length,success_cnt:1,error_cnt:0});
    }
    assert.equal(url,'https://api.payapp.kr/oapi/v2');const form=new URLSearchParams(options.body);calls.push(form);
    if(mode==='unknown')throw new Error('network interruption');
    if(mode==='rejected')return new Response('state=0&errorMessage=denied');
    return new Response(form.get('cmd')==='paycancel'?'state=1':'state=1&mul_no=987654&payurl=https%3A%2F%2Fpayapp.kr%2Ftest-sync-payment');};
  try{return await run(calls);}finally{globalThis.fetch=previous;}
}

test('new automatic reservation holds locally and exposes no provider payment until exact external block proof',async()=>withProvider(async calls=>{
  const env=fixture(),created=await create(env);assert.equal(created.response.status,200);assert.equal(created.data.status,'awaiting_payment');
  const code=created.data.code,t=tokenFrom(created.data);assert(t);assert.equal(calls.length,0);assert(!paymentRow(env,code));
  let response=await requestCheckout(env,code,t);assert.equal(response.status,409);assert(!JSON.stringify(await response.json()).includes('payapp.kr'));
  const job=await nextJob(env);assert.equal(job.action,'block');assert(!JSON.stringify(job).includes('테스트 예약자'));assert(!JSON.stringify(job).includes('01012345678'));
  response=await done(env,job);assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].get('cmd'),'payrequest');
  assert.equal((await getBooking(env,code)).payment_status,'pending');
  response=await requestCheckout(env,code,t);assert.equal(response.status,200);assert.equal((await response.json()).url,'https://payapp.kr/test-sync-payment');
  assert.equal((await done(env,job)).status,200);assert.equal(calls.length,1);
}));

test('stale checkout waits for a fresh worker verification and only then returns the provider URL',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),code=data.code,t=tokenFrom(data);await done(env,await nextJob(env));
  env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now()-31000,code);
  const pending=await requestCheckout(env,code,t);assert.equal(pending.status,202);const result=await pending.json();assert.equal(result.pending,true);assert(!result.url);
  assert.equal(paymentRow(env,code).accepted_at,null);
  const verify=await nextJob(env);assert.equal(verify.action,'verify');await done(env,verify);
  const allowed=await requestCheckout(env,code,t);assert.equal(allowed.status,200);assert((await allowed.json()).url.startsWith('https://payapp.kr/'));assert.equal(calls.length,1);
}));

test('lost capacity or runner readiness after blocking cannot claim creating or issue a PayApp invoice',async()=>{
  for(const reason of ['budget','not-ready']){
    let ready=true;
    await withProvider(async calls=>{
      const env=fixture(),{data}=await create(env),job=await nextJob(env);ready=false;
      const response=await done(env,job);assert.equal(response.status,503);assert.equal(calls.length,0);assert(!paymentRow(env,data.code));
      const booking=await getBooking(env,data.code);assert.equal(booking.payment_status,'sync_pending');assert.equal(booking.approved_at,null);assert.equal((await getSync(env,data.code)).state,'blocked');
    },{cloudStatus(data){if(!ready){if(reason==='budget')data.budget.rolling_32d_reserved_ms=data.budget.rolling_32d_limit_ms;else data.runner.review=true;}}});
  }
});

test('a stale checkout cannot enqueue another verification when cloud capacity is unavailable',async()=>{
  let ready=true;
  await withProvider(async calls=>{
    const env=fixture(),{data}=await create(env),code=data.code,t=tokenFrom(data);await done(env,await nextJob(env));
    env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now()-31000,code);ready=false;
    const response=await requestCheckout(env,code,t),body=await response.json();assert.equal(response.status,503);assert.equal(body.error,'cloud-admission-unavailable');assert(!body.url);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) n FROM spacecloud_sync_jobs WHERE booking_code=? AND action='verify'").get(code).n,0);
    assert.equal(paymentRow(env,code).accepted_at,null);assert.equal(calls.length,1);assert.equal((await getBooking(env,code)).payment_status,'pending');
  },{cloudStatus(data){if(!ready)data.budget.daily_reserved_ms=data.budget.daily_limit_ms;}});
});

test('a fresh block cannot expose an existing provider URL after cloud capacity or readiness is lost',async()=>{
  for(const reason of ['budget','not-ready']){
    let ready=true;
    await withProvider(async calls=>{
      const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));ready=false;
      const response=await requestCheckout(env,code,tokenFrom(data)),body=await response.json();assert.equal(response.status,503);assert.equal(body.error,'cloud-admission-unavailable');assert(!body.url);
      assert.equal(calls.length,1);assert.equal((await getSync(env,code)).state,'blocked');assert.equal((await getBooking(env,code)).payment_status,'pending');
    },{cloudStatus(data){if(!ready){if(reason==='budget')data.budget.monthly_reserved_ms=data.budget.monthly_limit_ms;else data.login_saved=false;}}});
  }
});

test('a cloud status response cannot refresh stale calendar proof before issuing an invoice or returning its URL',async()=>{
  let env,code,ageProof=false;
  await withProvider(async calls=>{
    env=fixture();const created=await create(env);code=created.data.code;const job=await nextJob(env);ageProof=true;
    let response=await done(env,job);assert.equal(response.status,409);assert.equal(calls.length,0);assert(!paymentRow(env,code));assert.equal((await getBooking(env,code)).payment_status,'sync_pending');
    ageProof=false;
    env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now(),code);await onSyncCompleted(env,code);assert.equal(calls.length,1);
    ageProof=true;response=await requestCheckout(env,code,tokenFrom(created.data));assert.equal(response.status,409);assert(!(await response.json()).url);
  },{cloudStatus(){if(ageProof)env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now()-31000,code);}});
});

test('a later capacity failure cannot reject paid finalization or confirmed refund release',async()=>{
  let ready=true,reads=0;
  await withProvider(async calls=>{
    const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));ready=false;const before=reads;
    assert.equal(await (await notify(env,code,'4')).text(),'SUCCESS');const verify=await nextJob(env);assert.equal(verify.action,'verify');assert.equal((await done(env,verify)).status,200);
    assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal((await getBooking(env,code)).payment_status,'paid');
    assert.equal(await (await notify(env,code,'9')).text(),'SUCCESS');const release=await nextJob(env);assert.equal(release.action,'release');
    assert.equal((await done(env,release,{proof:receipt(release,{verified_released:true,verified_blocked:false})})).status,200);
    assert.equal((await getSync(env,code)).state,'released');assert.equal((await getBooking(env,code)).status,'cancelled');assert.equal(reads,before);assert.equal(calls.length,1);
  },{cloudStatus(data){reads++;if(!ready)data.budget.rolling_32d_reserved_ms=data.budget.rolling_32d_limit_ms;}});
});

test('unknown provider issuance retains both holds, blocks cancellation and never issues a second payment',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),job=await nextJob(env);assert.equal((await done(env,job)).status,502);
  assert.equal((await getBooking(env,data.code)).payment_status,'review');assert.equal((await getSync(env,data.code)).state,'blocked');
  const denied=await cancel({request:post('/api/booking/cancel',{code:data.code,t:tokenFrom(data)}),env});assert.equal(denied.status,409);
  assert.equal((await done(env,job)).status,200);assert.equal(calls.length,1);assert.equal(await nextJob(env),null);
  const competing=await create(env,body());assert.equal(competing.response.status,409);
},{mode:'unknown'}));

test('definite provider refusal queues release and retains occupancy until the worker confirms removal',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),code=data.code;assert.equal((await done(env,await nextJob(env))).status,200);
  assert.equal((await getSync(env,code)).state,'releasing');assert.equal((await getBooking(env,code)).status,'awaiting_payment');
  assert.equal((await create(env)).response.status,409);
  const release=await nextJob(env);assert.equal(release.action,'release');await done(env,release,{proof:receipt(release,{verified_released:true,verified_blocked:false})});
  assert.equal((await getBooking(env,code)).status,'cancelled');assert.equal((await getSync(env,code)).state,'released');assert.equal(calls.length,1);
  assert.equal((await create(env)).response.status,200);
},{mode:'rejected'}));

test('customer cancellation during initial synchronization creates no provider request and releases only owned block',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),block=await nextJob(env);
  const response=await cancel({request:post('/api/booking/cancel',{code:data.code,t:tokenFrom(data)}),env});assert.equal(response.status,202);
  await done(env,block);assert.equal(calls.length,0);assert.equal((await getSync(env,data.code)).state,'releasing');
  const release=await nextJob(env);assert.equal(release.action,'release');assert.equal(release.marker,block.marker);
  await done(env,release,{proof:receipt(release,{verified_released:true})});assert.equal((await getBooking(env,data.code)).status,'cancelled');
}));

test('verified provider cancellation and full refund both release while partial refund preserves room occupancy',async()=>withProvider(async()=>{
  for(const paid of [false,true]) {
    const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));
    if(paid) {
      assert.equal((await notify(env,code,'4')).status,200);
      const verify=await nextJob(env);assert.equal(verify.action,'verify');await done(env,verify);
      assert.equal((await getBooking(env,code)).status,'confirmed');
      const row=paymentRow(env,code);
      assert.equal((await notify(env,code,'70',{mul_no:'987655',orig_mul_no:row.mul_no,orig_price:String(row.amount),price:'1000'})).status,200);
      assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal((await getSync(env,code)).state,'blocked');assert.equal(await nextJob(env),null);
    }
    const response=await notify(env,code,paid?'9':'8');assert.equal(await response.text(),'SUCCESS');
    assert.equal((await getSync(env,code)).state,'releasing');const release=await nextJob(env);assert.equal(release.action,'release');
    await done(env,release,{proof:receipt(release,{verified_released:true})});assert.equal((await getBooking(env,code)).status,'cancelled');
  }
}));

test('cancellation claims its state before a concurrent provider issuance can appear after the no-payment read',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),code=data.code,job=await nextJob(env);
  await finishSyncJob(env,{job_id:job.id,lease_token:job.lease_token,status:'succeeded',receipt:receipt(job)});
  const stale=await getBooking(env,code),originalPrepare=env.DB.prepare;
  let resume,signal;
  const paused=new Promise(resolve=>{signal=resolve;}),gate=new Promise(resolve=>{resume=resolve;});
  let intercepted=false;
  env.DB.prepare=function(sql){
    const statement=originalPrepare.call(this,sql);
    if(sql==='SELECT * FROM booking_payapp_requests WHERE code=?1') {
      const first=statement.first;
      statement.first=async function(){const result=await first.call(this);if(!intercepted){intercepted=true;signal();await gate;}return result;};
    }
    return statement;
  };
  const cancellation=cancelBookingRequest(env,stale);
  await paused;
  try {await onSyncCompleted(env,code);}finally{resume();}
  await cancellation;
  const payment=paymentRow(env,code),block=await getSync(env,code);
  assert(!(block.cancel_requested && payment && ['creating','requested','pending'].includes(payment.status)),
    'time must not be released while a newly issued PayApp request remains active');
  assert(calls.length===0 || calls.some(form=>form.get('cmd')==='paycancel'));
}));

test('simultaneous automatic submissions accept one room hold and one synchronization job',async()=>withProvider(async calls=>{
  const env=fixture();await prepareBookings(env);const results=await Promise.all([create(env),create(env)]);
  assert.deepEqual(results.map(x=>x.response.status).sort(),[200,409]);assert.equal(calls.length,0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_blocks').get().n,1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sync_jobs').get().n,1);
}));

test('unpaid timeout cancels the provider request before a worker can release the external hold',async()=>withProvider(async calls=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));
  env.sqlite.prepare("UPDATE booking_requests SET approved_at=datetime('now','+9 hours','-20 minutes') WHERE code=?").run(code);
  const release=await nextJob(env);assert.equal(release.action,'release');
  assert.deepEqual(calls.map(form=>form.get('cmd')),['payrequest','paycancel']);
  assert.equal(paymentRow(env,code).status,'cancelled');assert.equal((await getBooking(env,code)).status,'awaiting_payment');
  await done(env,release,{proof:receipt(release,{verified_released:true})});assert.equal((await getBooking(env,code)).status,'expired');
}));

test('late paid callback cannot confirm or release a room after cancellation wins the database race',async()=>withProvider(async()=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));
  const originalPrepare=env.DB.prepare,originalBatch=env.DB.batch;
  env.DB.prepare=function(sql){const statement=originalPrepare.call(this,sql);statement._sql=sql;return statement;};
  let signal,resume;
  const paused=new Promise(resolve=>{signal=resolve;}),gate=new Promise(resolve=>{resume=resolve;});
  env.DB.batch=async function(statements){
    if(statements.some(statement=>/^INSERT INTO reservations/.test(statement._sql || ''))){signal();await gate;}
    return originalBatch.call(this,statements);
  };
  const callback=applyBookingPayment(env,{code,id:paymentRow(env,code).mul_no,state:'paid',paid_at:stamp(),external_verified:true});await paused;
  try {await cancelBookingRequest(env,await getBooking(env,code));}finally{resume();}
  assert.equal((await callback).ok,true);
  assert.equal((await getBooking(env,code)).status,'payment_review');
  assert.equal((await getSync(env,code)).state,'review');
  assert.equal(await nextJob(env),null,'a paid-state ambiguity must stop a queued remote release');
}));

test('provider payment waits for a new external verification before exposing a confirmed reservation',async()=>withProvider(async()=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));
  assert.equal((await notify(env,code,'4')).status,200);
  assert.equal((await getBooking(env,code)).status,'awaiting_payment');assert.equal((await getBooking(env,code)).payment_status,'paid_verifying');
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
  const statusResponse=await paymentStatus({request:new Request(ORIGIN+'/api/booking/payment-status?code='+code+'&t='+tokenFrom(data)),env});
  const status=await statusResponse.json();assert.equal(status.status,'paid_verifying');assert.equal(status.can_cancel,false);assert.equal(status.can_pay,false);
  assert.equal((await notify(env,code,'4')).status,200);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) n FROM spacecloud_sync_jobs WHERE action='verify' AND state IN ('queued','leased')").get().n,1);
  const verify=await nextJob(env);assert.equal(verify.action,'verify');await done(env,verify);
  assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,1);
  await notify(env,code,'4');assert.equal(await nextJob(env),null);
}));

test('external conflict found after payment holds the booking for review rather than confirming or releasing',async()=>withProvider(async()=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));await notify(env,code,'4');
  const verify=await nextJob(env);assert.equal(verify.action,'verify');
  assert.equal((await done(env,verify,{status:'review',proof:receipt(verify,{no_conflicts:false})})).status,200);
  assert.equal((await getSync(env,code)).state,'review');assert.notEqual((await getBooking(env,code)).status,'confirmed');
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);assert.equal(await nextJob(env),null);
  assert.equal((await create(env)).response.status,409);
}));

test('partial refund arriving during final verification preserves finalization and refunded amount',async()=>withProvider(async()=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));await notify(env,code,'4');
  const row=paymentRow(env,code);
  assert.equal((await notify(env,code,'70',{mul_no:'987655',orig_mul_no:row.mul_no,orig_price:String(row.amount),price:'1000'})).status,200);
  const verify=await nextJob(env);assert.equal(verify.action,'verify');await done(env,verify);
  const final=await getBooking(env,code);assert.equal(final.status,'confirmed');assert.equal(final.refund_amount,1000);
  assert.equal(final.payment_status,'refund_pending');assert.equal((await getSync(env,code)).state,'blocked');assert.equal(await nextJob(env),null);
}));

test('a verification job created before payment cannot confirm it even when the worker clock is ahead',async()=>withProvider(async()=>{
  const env=fixture(),{data}=await create(env),code=data.code;await done(env,await nextJob(env));
  env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now()-31000,code);
  assert.equal((await requestCheckout(env,code,tokenFrom(data))).status,202);
  const olderVerification=await nextJob(env);
  env.sqlite.prepare('UPDATE spacecloud_sync_jobs SET created_at=? WHERE id=?').run(Date.now()-1000,olderVerification.id);
  await notify(env,code,'4');
  await done(env,olderVerification,{proof:receipt(olderVerification,{observed_at:Date.now()+3000})});
  assert.equal((await getBooking(env,code)).payment_status,'paid_verifying');
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
  const freshVerification=await nextJob(env);assert.equal(freshVerification.action,'verify');await done(env,freshVerification);
  assert.equal((await getBooking(env,code)).status,'confirmed');
}));

test('booking notices wait for confirmation and approved copy, deduplicate concurrent jobs, and reflect refund outcomes', async t=>{
  const {runBookingNotifications}=await import('../functions/_lib/booking-notify.js');
  const {BOOKING_TEMPLATES}=await import('../functions/_lib/booking-templates.js');
  const {ensurePayappSchema}=await import('../functions/_lib/booking-payapp.js');
  const {kstTimestamp}=await import('../functions/_lib/booking.js');
  const e=Object.assign(fixture(),{
    BOOKING_NOTIFY_START:kstTimestamp(Date.now()-60000),
    BOOKING_NOTIFY_STAFF:'01011112222,01033334444',
    BOOKING_NOTIFY_CUSTOMER:'1',BOOKING_NOTIFY_LIVE:'1',ALIGO_API_KEY:'fake-key',
    ALIGO_USER_ID:'fake-user',ALIGO_SENDER_KEY:'fake-sender-key',ALIGO_SENDER:'021234567'
  });
  await prepareBookings(e);
  await ensurePayappSchema(e);
  const code='B261107-A1B2C3D4E5';
  const date=addDaysIso(kstToday(),12);
  e.sqlite.prepare(`INSERT INTO booking_requests (code,submission_id,fingerprint,status,room,date,start_min,end_min,people,customer_name,phone,purpose,amount,consent,notice_version,payment_status,payment_id,paid_at,updated_at)
    VALUES (?,?,'example','awaiting_payment','r1',?,1380,1500,8,'테스트','010-2222-3333','meeting',40000,1,'test','paid_verifying','5',?,?)`)
    .run(code,code,date,kstTimestamp(),kstTimestamp());
  e.sqlite.prepare(`INSERT INTO booking_payapp_requests (code,kind,label,amount,token,mul_no,status,paid_at)
    VALUES (?,'room','test',40000,'test-link-token','5','paid',?)`).run(code,kstTimestamp());

  const sends=[];
  let mismatch=true;
  let uncertain=false;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const path=new URL(url).pathname;
    const form=options.body;
    if(path.includes('/template/list/')){
      const template=Object.values(BOOKING_TEMPLATES).find(value=>value.code===form.get('tpl_code'));
      return Response.json({code:0,list:[{templtCode:template.code,inspStatus:'APR',status:'A',
        templtContent:mismatch?'wrong text':template.text,buttons:template.buttons.button}]});
    }
    sends.push({path,form});
    if(path.includes('alimtalk'))return Response.json({code:0,info:{mid:100+sends.length,scnt:1,fcnt:0}});
    if(uncertain && form.get('receiver')==='01011112222')throw Error('timed out');
    return Response.json({result_code:1,msg_id:100+sends.length,success_cnt:1,error_cnt:0});
  });
  await runBookingNotifications(e);
  assert.equal(sends.length,0);
  e.sqlite.exec("UPDATE booking_requests SET status='confirmed',payment_status='paid'");
  await Promise.all([runBookingNotifications(e),runBookingNotifications(e)]);
  assert.equal(sends.length,2);
  assert.deepEqual(sends.map(item=>item.form.get('receiver')).sort(),['01011112222','01033334444']);
  assert.match(sends[0].form.get('msg'),/23:00~익일 01:00/);
  assert.match(sends[0].form.get('msg'),/40,000원/);
  assert.doesNotMatch(sends[0].form.get('msg'),/test-link-token|010-2222-3333/);
  assert.equal(e.sqlite.prepare("SELECT state FROM booking_notifications WHERE recipient='customer'").get().state,'queued');

  mismatch=false;
  // Another approved template has an independent approval cache key.
  e.sqlite.exec("UPDATE booking_requests SET payment_status='refund_pending',refund_amount=10000");
  e.sqlite.exec("UPDATE booking_payapp_requests SET status='partial_refund',refund_amount=10000");
  uncertain=true;
  await runBookingNotifications(e);
  await runBookingNotifications(e);
  assert.equal(sends.length,5);
  const partial=sends.find(item=>item.form.get('tpl_code')===BOOKING_TEMPLATES.partial.code).form;
  assert.equal(partial.get('receiver_1'),'01022223333');
  assert.equal(partial.get('failover'),'Y');
  assert.match(partial.get('fmessage_1'),/test-link-token/);
  assert.match(partial.get('message_1'),/예약은 유지됩니다/);
  assert.match(partial.get('message_1'),/10,000원/);
  assert.equal(e.sqlite.prepare("SELECT state FROM booking_notifications WHERE kind='partial' AND recipient='staff0'").get().state,'unknown');

  e.sqlite.exec("UPDATE booking_requests SET status='cancelled',payment_status='refunded',refund_amount=40000");
  e.sqlite.exec("UPDATE booking_payapp_requests SET status='refunded',refund_amount=40000");
  await runBookingNotifications(e);
  assert.equal(sends.length,8);
  const cancelled=sends.find(item=>item.form.get('tpl_code')===BOOKING_TEMPLATES.cancelled.code).form;
  assert.match(cancelled.get('message_1'),/예약이 취소되었습니다/);
  assert.match(cancelled.get('message_1'),/40,000원/);
  assert.equal(e.sqlite.prepare("SELECT state FROM booking_notifications WHERE kind='confirmed' AND recipient='customer'").get().state,'skipped');
});

function enableLifecycleNotices(env) {
  return Object.assign(env,{
    BOOKING_NOTIFY_START:kstTimestamp(Date.now()-60000),
    BOOKING_NOTIFY_CUSTOMER:'1',BOOKING_NOTIFY_LIVE:'1',BOOKING_NOTIFY_STAFF:'01011112222,01033334444',
    ALIGO_API_KEY:'mock-api-key',ALIGO_USER_ID:'mock-user',ALIGO_SENDER:'021234567',
    ALIGO_SENDER_KEY:'mock-booking-sender',
    BOOKING_ALIMTALK_RECEIVED:'mock-received',BOOKING_ALIMTALK_PAYMENT_READY:'mock-payment_ready',
    BOOKING_ALIMTALK_UNPAID_EXPIRED:'mock-unpaid_expired'
  });
}

test('customer gets one receipt, a verified payment link, then expiry only after the worker proves release',async()=>{
  const sms=[],alimtalk=[];
  await withProvider(async calls=>{
    const env=enableLifecycleNotices(fixture());
    const {data,input}=await create(env);
    assert.equal(alimtalk.length,1);
    assert.equal(alimtalk[0].get('receiver_1'),'01012345678');
    assert.match(alimtalk[0].get('message_1'),/신청이 접수되었습니다/);
    assert.equal(alimtalk[0].get('failover'),'Y');
    assert.doesNotMatch(alimtalk[0].get('fmessage_1'),new RegExp(tokenFrom(data)));
    assert.equal((await create(env,input)).data.duplicate,true);
    assert.equal(alimtalk.length,1);

    await done(env,await nextJob(env));
    assert.equal(alimtalk.length,1);
    assert.equal(sms.length,1);
    const payment=paymentRow(env,data.code);
    assert.equal(sms[0].get('msg_type'),'LMS');
    assert.equal(sms[0].get('receiver'),'01012345678');
    const message=sms[0].get('msg');
    assert.match(message,/결제 기한:/);
    const link=message.match(/https:\/\/socialfactory\.co\.kr\/booking-status\?[^\s]+/)[0];
    assert.equal(new URL(link).searchParams.get('t'),payment.token);
    assert.doesNotMatch(message,/payapp\.kr/);

    env.sqlite.prepare("UPDATE booking_requests SET approved_at=datetime('now','+9 hours','-20 minutes') WHERE code=?").run(data.code);
    assert.equal((await requestCheckout(env,data.code,tokenFrom(data))).status,409);
    const release=await nextJob(env);
    assert.equal(release.action,'release');
    assert.deepEqual(calls.map(form=>form.get('cmd')),['payrequest','paycancel']);
    assert.equal(alimtalk.length,1);
    assert.equal(sms.length,1);
    const result=await done(env,release,{proof:receipt(release,{verified_released:true,verified_blocked:false})});
    assert.equal(result.status,200);
    assert.equal(alimtalk.length,2);
    assert.match(alimtalk[1].get('message_1'),/미납|결제가 확인되지 않아/);
    assert.equal(alimtalk[1].get('failover'),'Y');
    assert.equal((await getBooking(env,data.code)).status,'expired');
    const status=await paymentStatus({env,request:new Request(ORIGIN+data.status_url)});
    assert.equal((await status.json()).status,'expired');
    assert.equal((await done(env,release)).status,200);
    assert.equal(alimtalk.length,2);

    const response=await listBookings({env,request:new Request(ORIGIN+'/api/admin/booking-requests',{
      headers:{authorization:'Bearer '+env.ADMIN_KEY}
    })});
    const admin=await response.json();
    assert.deepEqual(admin.results[0].notifications.map(item=>item.kind).sort(),['payment_ready','received','unpaid_expired']);
    assert.equal(admin.recentNotifications.every(item=>item.state==='accepted' && item.last4==='5678'),true);
    assert.doesNotMatch(JSON.stringify(admin.recentNotifications),new RegExp(payment.token));
  },{sms,alimtalk});
});

test('paid verification sends staff a single delay notice, then alerts immediately on an explicit sync failure',async()=>{
  const sms=[];
  await withProvider(async()=>{
    const env=enableLifecycleNotices(fixture());
    const {data}=await create(env);
    await done(env,await nextJob(env));
    assert.equal(await (await notify(env,data.code,'4')).text(),'SUCCESS');
    assert.equal(sms.filter(form=>form.get('receiver')!=='01012345678').length,0);

    env.sqlite.prepare('UPDATE spacecloud_payment_checks SET after_ms=? WHERE code=?').run(Date.now()-121000,data.code);
    const maintenance=()=>completeWorker({env,request:post('/api/internal/spacecloud-sync',{action:'maintenance'},env.SPACECLOUD_WORKER_TOKEN)});
    assert.equal((await maintenance()).status,200);
    assert.equal((await maintenance()).status,200);
    const staffMessages=()=>sms.filter(form=>form.get('receiver')!=='01012345678');
    assert.equal(staffMessages().length,2);
    for(const message of staffMessages()) {
      assert.match(message.get('msg'),/예약 확정 지연/);
      assert.doesNotMatch(message.get('msg'),/01012345678|booking-status/);
    }
    const verification=await nextJob(env);
    assert.equal((await done(env,verification,{status:'review'})).status,200);
    assert.equal(staffMessages().length,4);
    assert.match(staffMessages()[2].get('msg'),/연동 확인 필요/);
    assert.equal((await done(env,verification,{status:'review'})).status,200);
    assert.equal(staffMessages().length,4);
    assert.equal(sms.filter(form=>form.get('receiver')==='01012345678').length,1);
  },{sms});
});

test('manual approval sends the customer a payment link and an expired link is closed by ready-only provider cancellation',async()=>{
  const sms=[],alimtalk=[];
  await withProvider(async calls=>{
    const env=enableLifecycleNotices(fixture());
    env.SPACECLOUD_SYNC_ENABLED='false';
    const {data}=await create(env);
    assert.equal(alimtalk.length,1);
    assert.doesNotMatch(alimtalk[0].get('message_1'),/booking-status/);
    const approved=await updateBooking({env,request:post('/api/admin/booking-requests',{
      action:'approve',code:data.code,external_checked:true
    },env.ADMIN_KEY)});
    assert.equal(approved.status,200);
    assert.equal(alimtalk.length,1);
    assert.equal(sms.length,1);
    assert.match(sms[0].get('msg'),/결제 기한:/);
    const {token}=paymentRow(env,data.code);
    assert.equal((await requestCheckout(env,data.code,token)).status,200);
    env.sqlite.prepare("UPDATE booking_requests SET payment_expires_at=NULL,expires_at=datetime('now','+9 hours','-1 minute') WHERE code=?").run(data.code);
    await sweepUnpaidBookings(env);
    assert.equal(calls.length,1);
    assert.equal((await requestCheckout(env,data.code,token)).status,200);
    env.sqlite.prepare("UPDATE booking_requests SET payment_expires_at=expires_at WHERE code=?").run(data.code);
    assert.equal((await requestCheckout(env,data.code,token)).status,409);
    await sweepUnpaidBookings(env);
    await runBookingNotifications(env,{code:data.code});
    assert.equal(calls[1].get('cancelmode'),'ready');
    assert.equal((await getBooking(env,data.code)).status,'expired');
    assert.equal(alimtalk.length,2);
    assert.match(alimtalk[1].get('message_1'),/만료되었습니다/);
  },{sms,alimtalk});
});

test('cloud readiness failures produce one staff incident notice until health recovers',async()=>{
  const sms=[];
  let cloudReady=false;
  await withProvider(async()=>{
    const env=enableLifecycleNotices(fixture());
    assert.equal((await create(env)).response.status,503);
    assert.equal((await create(env)).response.status,503);
    await runBookingNotifications(env,{checkIntegration:true});
    assert.equal(sms.length,2);
    assert(sms.every(form=>form.get('msg').includes('대관 연동 장애')));
    cloudReady=true;
    await runBookingNotifications(env,{checkIntegration:true});
    cloudReady=false;
    await runBookingNotifications(env,{checkIntegration:true});
    assert.equal(sms.length,4);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) n FROM booking_notifications WHERE kind='sync_outage' AND state='accepted'").get().n,4);
  },{sms,cloudStatus(data){data.login_saved=cloudReady;}});
});

test('unapproved customer templates remain queued without sending an SMS',async()=>{
  const sms=[],alimtalk=[];
  await withProvider(async()=>{
    const env=enableLifecycleNotices(fixture());
    env.BOOKING_ALIMTALK_RECEIVED='mock-unapproved-receipt';
    const {data}=await create(env);
    const notice=env.sqlite.prepare("SELECT state FROM booking_notifications WHERE code=? AND kind='received'").get(data.code);
    assert.equal(notice.state,'queued');
    assert.equal(sms.length,0);
    assert.equal(alimtalk.length,0);
  },{sms,alimtalk,unapproved:true});
});
