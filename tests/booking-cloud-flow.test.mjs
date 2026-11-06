import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../functions/_lib/auth.js';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';
import { getBooking,prepareBookings,applyBookingPayment } from '../functions/_lib/booking.js';
import { getSync,finishSyncJob } from '../functions/_lib/booking-spacecloud-sync.js';
import { cancelSynchronizedBooking,onSyncCompleted } from '../functions/_lib/booking-checkout.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { onRequestGet as pollWorker,onRequestPost as completeWorker } from '../functions/api/internal/spacecloud-sync.js';
import { onRequestGet as paymentStatus,onRequestPost as checkout } from '../functions/api/booking/payment-status.js';
import { onRequestPost as cancel } from '../functions/api/booking/cancel.js';
import { onRequestPost as feedback } from '../functions/api/booking/payapp-feedback.js';

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
async function withProvider(run,{mode='success',cloudStatus}={}) {
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
  const cancellation=cancelSynchronizedBooking(env,stale);
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
  await done(env,release,{proof:receipt(release,{verified_released:true})});assert.equal((await getBooking(env,code)).status,'cancelled');
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
  try {await cancelSynchronizedBooking(env,await getBooking(env,code));}finally{resume();}
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
