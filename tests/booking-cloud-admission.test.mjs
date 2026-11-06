import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { assertCloudAdmission,MINIMUM_BOOKING_BROWSER_MS } from '../functions/_lib/booking-cloud-admission.js';
import { onRequestPost as submit } from '../functions/api/booking/requests.js';
import { kstToday,addDaysIso } from '../functions/_lib/admin.js';

const RUNNER='https://runner.example.workers.dev',ORIGIN='https://admission.example';
const admin='test-only-admission-private-admin-token-more-than-thirty-two';
const config=()=>({SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_RUNNER_URL:RUNNER,CLOUD_ADMIN_TOKEN:admin});
const status=()=>({ok:true,enabled:true,allow_writes:true,login_saved:true,runner:{busy:false,review:false},budget:{
  utc_day:new Date().toISOString().slice(0,10),utc_month:new Date().toISOString().slice(0,7),
  daily_limit_ms:1800000,daily_reserved_ms:0,monthly_limit_ms:7200000,monthly_reserved_ms:0,rolling_32d_limit_ms:7200000,rolling_32d_reserved_ms:0}});
const denied={code:'cloud-admission-unavailable',status:503};

test('admission checks only a configured private Worker status and permits a healthy busy runner',async()=>{
  const calls=[],data=status();data.runner.busy=true;
  assert.equal(await assertCloudAdmission(config(),{fetcher:async(url,options)=>{calls.push({url,options});return Response.json(data);}}),undefined);
  assert.equal(calls.length,1);assert.equal(calls[0].url,RUNNER+'/status');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+admin);assert(!JSON.stringify(calls[0]).includes('SPACECLOUD_WORKER_TOKEN'));
  assert.equal(calls[0].options.headers['Cache-Control'],'no-store');
});

test('missing login, stopped writes and a quarantined runner reject new admissions',async()=>{
  for(const change of [data=>data.enabled=false,data=>data.allow_writes=false,data=>data.login_saved=false,data=>data.runner.review=true,data=>delete data.runner]){
    const data=status();change(data);await assert.rejects(assertCloudAdmission(config(),{fetcher:async()=>Response.json(data)}),denied);
  }
});

test('each usage cap requires three worst-case browser reservations without resetting the rolling cap',async()=>{
  assert.equal(MINIMUM_BOOKING_BROWSER_MS,540000);
  for(const [limit,used] of [['daily_limit_ms','daily_reserved_ms'],['monthly_limit_ms','monthly_reserved_ms'],['rolling_32d_limit_ms','rolling_32d_reserved_ms']]){
    const data=status();data.budget[used]=data.budget[limit]-MINIMUM_BOOKING_BROWSER_MS+1;
    await assert.rejects(assertCloudAdmission(config(),{fetcher:async()=>Response.json(data)}),denied);
    data.budget[used]--;await assertCloudAdmission(config(),{fetcher:async()=>Response.json(data)});
  }
});

test('stale dates and malformed or out-of-policy budget values fail closed',async()=>{
  for(const change of [data=>data.budget.utc_day='2000-01-01',data=>data.budget.utc_month='2000-01',
    data=>data.budget.monthly_limit_ms=28800000,data=>data.budget.daily_reserved_ms=-1,data=>data.budget.rolling_32d_reserved_ms='0']){
    const data=status();change(data);await assert.rejects(assertCloudAdmission(config(),{fetcher:async()=>Response.json(data)}),denied);
  }
});

test('untrusted origins or missing admin credentials receive no request and manual bookings skip Cloud',async()=>{
  let requests=0;const fetcher=async()=>{requests++;throw Error('must not fetch');};
  for(const extra of [{SPACECLOUD_RUNNER_URL:'https://attacker.example'},{SPACECLOUD_RUNNER_URL:RUNNER+'/'},{CLOUD_ADMIN_TOKEN:''},{CLOUD_ADMIN_TOKEN:'short'}]){
    await assert.rejects(assertCloudAdmission({...config(),...extra},{fetcher}),denied);
  }
  await assertCloudAdmission({SPACECLOUD_SYNC_ENABLED:'false'},{fetcher});assert.equal(requests,0);
});

test('network, redirect, non-JSON and oversized responses expose only a safe unavailable error',async()=>{
  for(const fetcher of [async()=>{throw Error('PRIVATE-UPSTREAM-ERROR');},async()=>new Response('PRIVATE-UPSTREAM-ERROR',{status:302,headers:{Location:'https://attacker.example'}}),
    async()=>new Response('PRIVATE-UPSTREAM-ERROR'),async()=>new Response('x'.repeat(16385))]){
    await assert.rejects(assertCloudAdmission(config(),{fetcher}),error=>{assert.equal(error.code,denied.code);assert(!error.message.includes('PRIVATE'));assert.equal(error.status,503);return true;});
  }
});

function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));let tail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},batch(statements){
    const task=tail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=task.catch(()=>{});return task;
  }};
  return {...config(),DB,sqlite,SPACECLOUD_WORKER_TOKEN:'test-only-admission-worker-token-more-than-thirty-two',PAYAPP_ENABLED:'1',
    PAYAPP_USERID:'admission-merchant',PAYAPP_LINK_KEY:'admission-key',PAYAPP_LINK_VALUE:'admission-value',PAYAPP_REQUEST_KEY:'admission-request-key',PAYAPP_SITE_URL:ORIGIN};
}
const input=()=>({submissionId:crypto.randomUUID(),room:'r5',date:addDaysIso(kstToday(),15),start_min:600,end_min:720,people:4,name:'Admission fixture',phone:'01012345678',purpose:'meeting',consent:true});
const request=body=>new Request(ORIGIN+'/api/booking/requests',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify(body)});
async function withCloud(data,run){
  const previous=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});if(url===RUNNER+'/status')return Response.json(data);if(url===RUNNER+'/run')return Response.json({ok:true,scheduled:true},{status:202});throw Error('unexpected provider request');};
  try{return await run(calls);}finally{globalThis.fetch=previous;}
}

test('an exhausted cloud budget creates no booking, synchronization job or PayApp request',async()=>{
  const env=fixture(),data=status();data.budget.rolling_32d_reserved_ms=7200000;
  await withCloud(data,async calls=>{
    const response=await submit({request:request(input()),env});assert.equal(response.status,503);assert.equal((await response.json()).error,denied.code);
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM booking_requests').get().n,0);assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sync_jobs').get().n,0);
    assert.equal(calls.length,1);assert(calls.every(call=>call.url===RUNNER+'/status'));
    if(env.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='booking_payapp_requests'").get())assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM booking_payapp_requests').get().n,0);
  });
});

test('healthy admission creates only a local hold and duplicate receipts remain accessible during a later outage',async()=>{
  const env=fixture(),data=status(),body=input();
  await withCloud(data,async calls=>{
    let response=await submit({request:request(body),env});assert.equal(response.status,200);const first=await response.json();assert.equal(first.status,'awaiting_payment');
    assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM booking_requests').get().n,1);assert.equal(env.sqlite.prepare("SELECT COUNT(*) n FROM spacecloud_sync_jobs WHERE state='queued'").get().n,1);
    assert.equal(calls.filter(call=>call.url===RUNNER+'/status').length,1);data.login_saved=false;
    response=await submit({request:request(body),env});assert.equal(response.status,200);const duplicate=await response.json();assert.equal(duplicate.code,first.code);assert.equal(duplicate.duplicate,true);
    assert.equal(calls.filter(call=>call.url===RUNNER+'/status').length,1);assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM booking_requests').get().n,1);
    assert(calls.every(call=>call.url.startsWith(RUNNER+'/')));
  });
});
