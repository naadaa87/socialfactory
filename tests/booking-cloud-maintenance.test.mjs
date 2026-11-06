import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';
import { sha256Hex } from '../functions/_lib/auth.js';
import { getBooking } from '../functions/_lib/booking.js';
import { getSync,claimSyncJob,finishSyncJob } from '../functions/_lib/booking-spacecloud-sync.js';
import { onSyncCompleted } from '../functions/_lib/booking-checkout.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { onRequestPost as maintain } from '../functions/api/internal/spacecloud-sync.js';
import { onRequestPost as feedback } from '../functions/api/booking/payapp-feedback.js';

const ORIGIN='https://maintenance.example';
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  let tail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},batch(statements){
    const task=tail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=task.catch(()=>{});return task;
  }};
  return {DB,sqlite,SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'maintenance-test-worker-token-longer-than-thirty-two',
    PAYAPP_ENABLED:'1',PAYAPP_USERID:'maintenance-test-merchant',PAYAPP_LINK_KEY:'maintenance-test-key',PAYAPP_LINK_VALUE:'maintenance-test-value',
    PAYAPP_REQUEST_KEY:'maintenance-test-request-key',PAYAPP_SITE_URL:ORIGIN};
}
const request=(path,body,token)=>new Request(ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
const payment=(env,code)=>env.sqlite.prepare('SELECT * FROM booking_payapp_requests WHERE code=?').get(code);
const jobs=env=>env.sqlite.prepare('SELECT id,booking_code,action,state,lease_token FROM spacecloud_sync_jobs ORDER BY created_at,id').all();
async function create(env){
  const body={submissionId:crypto.randomUUID(),room:'r5',date:addDaysIso(kstToday(),15),start_min:600,end_min:720,people:4,name:'Maintenance fixture',phone:'01012345678',purpose:'meeting',consent:true};
  const response=await submit({request:request('/api/booking/requests',body),env});assert.equal(response.status,200);return (await response.json()).code;
}
async function complete(env,job){
  assert(job);const receipt={marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,segments:job.segments,
    no_conflicts:true,verified_blocked:true,observed_at:Date.now()};
  const done=await finishSyncJob(env,{job_id:job.id,lease_token:job.lease_token,status:'succeeded',receipt});await onSyncCompleted(env,done.code);
}
async function pendingPayment(env){const code=await create(env);await complete(env,await claimSyncJob(env));assert.equal((await getBooking(env,code)).payment_status,'pending');return code;}
async function maintenance(env,token=env.SPACECLOUD_WORKER_TOKEN){return maintain({request:request('/api/internal/spacecloud-sync',{action:'maintenance'},token),env});}
const age=(env,code)=>env.sqlite.prepare("UPDATE booking_requests SET approved_at=datetime('now','+9 hours','-20 minutes') WHERE code=?").run(code);
const stamp=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,19).replace(/\D/g,'');
async function paidNotification(env,code){
  const row=payment(env,code),fields={userid:env.PAYAPP_USERID,linkkey:env.PAYAPP_LINK_KEY,linkval:env.PAYAPP_LINK_VALUE,responsedate:stamp(),var1:code,var2:row.token,
    mul_no:row.mul_no,price:String(row.amount),pay_state:'4',pay_date:stamp()};
  fields.hash=await sha256Hex(env.PAYAPP_USERID+fields.responsedate+env.PAYAPP_REQUEST_KEY);
  const response=await feedback({request:new Request(ORIGIN+'/api/booking/payapp-feedback',{method:'POST',body:new URLSearchParams(fields)}),env});assert.equal(await response.text(),'SUCCESS');
}
async function withProvider(run){
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.payapp.kr/oapi/v2');const fields=new URLSearchParams(options.body);calls.push(fields.get('cmd'));
    return new Response(fields.get('cmd')==='paycancel'?'state=1':'state=1&mul_no=7654321&payurl=https%3A%2F%2Fpayapp.kr%2Fmaintenance-fixture');};
  try{return await run(calls);}finally{globalThis.fetch=previous;}
}

test('authenticated maintenance cancels an expired unpaid provider request and queues release without leasing it',async()=>withProvider(async calls=>{
  const env=fixture(),code=await pendingPayment(env);age(env,code);
  const response=await maintenance(env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.maintenance,true);assert(!('job' in body));
  assert.deepEqual(calls,['payrequest','paycancel']);assert.equal(payment(env,code).status,'cancelled');
  assert.equal((await getBooking(env,code)).status,'awaiting_payment');assert.equal((await getBooking(env,code)).payment_status,'releasing');
  assert.equal((await getSync(env,code)).state,'releasing');
  const release=jobs(env).filter(row=>row.action==='release');assert.equal(release.length,1);assert.equal(release[0].state,'queued');assert.equal(release[0].lease_token,null);
  assert.equal(jobs(env).some(row=>row.state==='leased'),false);
  assert.equal((await maintenance(env)).status,200);assert.deepEqual(calls,['payrequest','paycancel']);assert.equal(jobs(env).filter(row=>row.action==='release').length,1);
}));

test('maintenance preserves a paid confirmed booking even when its approval time is old',async()=>withProvider(async calls=>{
  const env=fixture(),code=await pendingPayment(env);await paidNotification(env,code);await complete(env,await claimSyncJob(env));
  assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal(payment(env,code).status,'paid');age(env,code);
  const before=jobs(env),response=await maintenance(env);assert.equal(response.status,200);assert.deepEqual(calls,['payrequest']);
  assert.equal((await getBooking(env,code)).status,'confirmed');assert.equal((await getSync(env,code)).state,'blocked');assert.deepEqual(jobs(env),before);
}));

test('unauthorized maintenance cannot change an expired booking, payment or queue',async()=>withProvider(async calls=>{
  const env=fixture(),code=await pendingPayment(env);age(env,code);const before={booking:await getBooking(env,code),payment:payment(env,code),jobs:jobs(env),sync:await getSync(env,code)};
  for(const token of ['', 'incorrect-worker-token']){const denied=await maintenance(env,token);assert.equal(denied.status,401);assert.equal((await denied.json()).error,'unauthorized');}
  assert.deepEqual(calls,['payrequest']);assert.deepEqual(await getBooking(env,code),before.booking);assert.deepEqual(payment(env,code),before.payment);assert.deepEqual(jobs(env),before.jobs);assert.deepEqual(await getSync(env,code),before.sync);
}));

test('maintenance leaves a queued initial synchronization job unleased and issues no payment',async()=>withProvider(async calls=>{
  const env=fixture(),code=await create(env),before=jobs(env);assert.equal(before.length,1);assert.equal(before[0].state,'queued');
  const response=await maintenance(env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.maintenance,true);assert(!body.job);
  assert.deepEqual(jobs(env),before);assert.equal((await getSync(env,code)).state,'pending');assert.equal(payment(env,code),undefined);assert.deepEqual(calls,[]);
}));

test('disabled integration rejects maintenance before changing provider or queue state',async()=>withProvider(async calls=>{
  const env=fixture(),code=await pendingPayment(env);age(env,code);const before=jobs(env);env.SPACECLOUD_SYNC_ENABLED='false';
  const response=await maintenance(env);assert.equal(response.status,503);assert.equal((await response.json()).error,'sync-disabled');
  assert.deepEqual(calls,['payrequest']);assert.equal(payment(env,code).status,'requested');assert.equal((await getBooking(env,code)).payment_status,'pending');assert.deepEqual(jobs(env),before);
}));
