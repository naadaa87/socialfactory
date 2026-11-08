import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { prepareBookings,bookingAvailability,getBooking } from '../functions/_lib/booking.js';
import { ensurePayappSchema } from '../functions/_lib/booking-payapp.js';
import { enqueueSync,claimSyncJob,finishSyncJob,getSync } from '../functions/_lib/booking-spacecloud-sync.js';
import { cancelBookingRequest } from '../functions/_lib/booking-checkout.js';
import { loadSpacecloud } from '../functions/_lib/spacecloud.js';
import { onRequestPost as complete } from '../functions/api/internal/spacecloud-sync.js';

const FEED='https://api.spacecloud.kr/partner/reservations/ical?product_id=140492&ical_uid=release-test-private';
function fixture(t){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sqlite.close());
  let tail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},batch(statements){
    const task=tail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=task.catch(()=>{});return task;
  }};
  return {DB,sqlite,SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'release-test-worker-token-longer-than-thirty-two',SPACECLOUD_ICAL_FEEDS:JSON.stringify({r5:FEED}),
    PAYAPP_ENABLED:'1',PAYAPP_USERID:'fixture-merchant',PAYAPP_LINK_KEY:'fixture-key',PAYAPP_LINK_VALUE:'fixture-value',PAYAPP_REQUEST_KEY:'fixture-request-key',PAYAPP_SITE_URL:'https://release.example'};
}
const receipt=job=>({marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,segments:job.segments,no_conflicts:true,verified_blocked:true,verified_released:true,observed_at:Date.now()});
const calendar=(date,own)=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+[
  ...(own?[['own-release-fixture','100000','120000','SFWEB:release_fixture_01']]:[]),
  ['other-customer-fixture','140000','160000','Other Spacecloud reservation']
].map(([uid,start,end,title])=>`BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=Asia/Seoul:${date.replaceAll('-','')}T${start}\r\nDTEND;TZID=Asia/Seoul:${date.replaceAll('-','')}T${end}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\n`).join('')+'END:VCALENDAR\r\n';

for(const failedFeed of [false,true])test(failedFeed?'release keeps the last cached block conservatively when the forced feed refresh fails':'unpaid cancellation and release refresh cached own iCal immediately while preserving other reservations',async t=>{
  const env=fixture(t),date=new Date(Date.now()+15*86400000).toISOString().slice(0,10),code='release_fixture_01';
  await prepareBookings(env);await ensurePayappSchema(env);
  env.sqlite.prepare(`INSERT INTO booking_requests (code,submission_id,fingerprint,status,room,date,start_min,end_min,people,customer_name,phone,purpose,amount,consent,notice_version,payment_status)
    VALUES (?,?,?,'awaiting_payment','r5',?,600,720,4,'Release fixture','01012345678','meeting',40000,1,'fixture','pending')`).run(code,crypto.randomUUID(),'fixture',date);
  env.sqlite.prepare(`INSERT INTO booking_payapp_requests (code,kind,label,amount,token,mul_no,status) VALUES (?,'room','Fixture',40000,'fixture-token','7654321','requested')`).run(code);
  await enqueueSync(env,await getBooking(env,code));const block=await claimSyncJob(env);
  await finishSyncJob(env,{job_id:block.id,lease_token:block.lease_token,status:'succeeded',receipt:receipt(block)});
  let upstreamOwn=true,feedCalls=0;const providerCalls=[],previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url)===FEED){feedCalls++;if(!upstreamOwn&&failedFeed)return new Response('unavailable',{status:503});return new Response(calendar(date,upstreamOwn));}
    assert.equal(String(url),'https://api.payapp.kr/oapi/v2');const fields=new URLSearchParams(options.body);providerCalls.push(fields.get('cmd'));assert.equal(fields.get('cmd'),'paycancel');assert.equal(fields.get('cancelmode'),'ready');return new Response('state=1');
  };t.after(()=>{globalThis.fetch=previousFetch;});
  await loadSpacecloud(env,{force:true});
  const before=await bookingAvailability(env,'r5',date);assert.deepEqual(before.blocked,[{start_min:600,end_min:720},{start_min:840,end_min:960}]);assert.equal(feedCalls,1);
  await cancelBookingRequest(env,await getBooking(env,code));assert.deepEqual(providerCalls,['paycancel']);
  const release=await claimSyncJob(env);assert.equal(release.action,'release');upstreamOwn=false;
  const response=await complete({env,request:new Request('https://release.example/api/internal/spacecloud-sync',{method:'POST',headers:{authorization:'Bearer '+env.SPACECLOUD_WORKER_TOKEN,'content-type':'application/json'},body:JSON.stringify({action:'complete',job_id:release.id,lease_token:release.lease_token,status:'succeeded',receipt:receipt(release)})})});
  assert.equal(response.status,200);assert.equal((await response.json()).state,'released');assert.equal(feedCalls,2,'completion must fetch the real upstream despite the fresh five-minute cache');
  assert.equal((await getBooking(env,code)).status,'cancelled');assert.equal((await getSync(env,code)).state,'released');
  const after=await bookingAvailability(env,'r5',date);assert.equal(feedCalls,2,'public availability reuses the just-refreshed snapshot');assert.equal(after.external.stale,failedFeed);
  assert.deepEqual(after.blocked,failedFeed?before.blocked:[{start_min:840,end_min:960}]);
  assert.deepEqual(providerCalls,['paycancel'],'no new charge is issued during cancellation or release');
});
