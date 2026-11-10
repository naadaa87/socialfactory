import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJob, planJob, memoFor, inspectRecords, ReviewRequired } from '../safety.mjs';
import { calendarGridDates, parseCalendarEntry, publicSlotExpectations } from '../calendar.mjs';
import { readConfig, QueueClient } from '../queue.mjs';

const makeJob=overrides=>({id:1,lease_token:'lease-for-test',action:'block',code:'B261208-TESTING',marker:'SFWEB:B261208-TESTING',room:'r5',date:'2026-12-08',start_min:240,end_min:360,...overrides});
const own=segment=>({...segment,name:segment.marker,memo:memoFor(segment),manual:true});
function fakeDriver(records=[]) {
  return {records:[...records],created:[],removed:[],publicChecks:[],hostReads:[],
    async openRoom(){},async recordsFor(date){this.hostReads.push(date);return this.records;},
    async createSegment(s){this.created.push(s);this.records.push(own(s));},
    async removeSegment(s,r){this.removed.push(r);this.records=this.records.filter(x=>x!==r);},
    async verifyPublic(s,r){this.publicChecks.push({segment:s,remaining:r});}};
}

test('real server opaque job IDs and lease tokens are preserved',()=>{
  const id='fENfFifSL5VNKcOnB1_CoX2J',lease='jVflb49faYiCOmXngp6wSsXY';
  const plan=planJob(makeJob({id,job_id:id,lease_token:lease}));
  assert.equal(plan.job_id,id);assert.equal(plan.lease_token,lease);
});

test('whole-hour overnight job is split without rounding or widening',()=>{
  const plan=planJob(makeJob({start_min:1380,end_min:1560}));
  assert.deepEqual(plan.segments,[{date:'2026-12-08',start_min:1380,end_min:1440,marker:plan.marker},{date:'2026-12-09',start_min:0,end_min:120,marker:plan.marker}]);
  assert.throws(()=>planJob(makeJob({start_min:270,end_min:390})),ReviewRequired);
  assert.throws(()=>planJob(makeJob({segments:[{date:'2026-12-08',start_min:180,end_min:360,marker:makeJob().marker}]})),ReviewRequired);
});

test('calendar month grid distinguishes previous and next month cells',()=>{
  const labels=[29,30,...Array.from({length:31},(_,i)=>i+1),1,2];
  const dates=calendarGridDates('2026.12',labels);
  assert.equal(dates[0],'2026-11-29');assert.equal(dates[2],'2026-12-01');assert.equal(dates.at(-1),'2027-01-02');
  assert.throws(()=>calendarGridDates('2026.12',[...labels.slice(0,8),22,...labels.slice(9)]),ReviewRequired);
});

test('unknown calendar entry fails closed, overnight time is preserved',()=>{
  assert.equal(parseCalendarEntry('2026-12-08',{hours:['23','2'],text:'확23~2,임**',index:0}).end_min,1560);
  assert.throws(()=>parseCalendarEntry('2026-12-08',{hours:[],text:'휴무',index:0}),ReviewRequired);
});

test('block is idempotent only for exact manual marker, memo and period',async()=>{
  const job=makeJob(),segment=planJob(job).segments[0],driver=fakeDriver([own(segment)]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');assert.equal(result.receipt.verified_blocked,true);assert.equal(driver.created.length,0);
  assert.throws(()=>inspectRecords([{...own(segment),manual:false}],segment),ReviewRequired);
  assert.throws(()=>inspectRecords([{...own(segment),memo:'guest copied name'}],segment),ReviewRequired);
  assert.throws(()=>inspectRecords([own(segment),own(segment)],segment),ReviewRequired);
});

test('verify and an already-owned block use one host read and no external writes',async()=>{
  for(const action of ['verify','block']){
    const job=makeJob({action}),segment=planJob(job).segments[0],driver=fakeDriver([own(segment)]);let heartbeats=0;
    const result=await executeJob(job,driver,async()=>{heartbeats++;});
    assert.equal(result.status,'succeeded');assert.equal(result.receipt.verified_blocked,true);assert.equal(result.receipt.no_conflicts,true);
    assert.deepEqual(driver.hostReads,[job.date]);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
    assert.equal(driver.publicChecks.length,1);assert.deepEqual(driver.publicChecks[0].remaining,[own(segment)]);assert.equal(heartbeats,2);
  }
});

test('verification fast path rejects an invalid manual marker, memo or exact time scope before public checks',async()=>{
  const job=makeJob({action:'verify'}),segment=planJob(job).segments[0];
  for(const record of [{...own(segment),manual:false},{...own(segment),memo:'different memo'},
    {...own(segment),name:'SFWEB:B261208-OTHER'}, {...own(segment),start_min:segment.start_min+60}]){
    const driver=fakeDriver([record]),result=await executeJob(job,driver,async()=>{});
    assert.notEqual(result.status,'succeeded');assert.notEqual(result.receipt.verified_blocked,true);assert.notEqual(result.receipt.no_conflicts,true);
    assert.equal(driver.hostReads.length,1);assert.equal(driver.publicChecks.length,0);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
  }
});

test('overnight verification requires every owned segment before checking any public availability',async()=>{
  const job=makeJob({action:'verify',start_min:1380,end_min:1560}),segments=planJob(job).segments,driver=fakeDriver([own(segments[0])]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'review');assert.deepEqual(driver.hostReads,segments.map(segment=>segment.date));
  assert.equal(driver.publicChecks.length,0);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('verification missing its owned record reviews even when another guest overlaps',async()=>{
  const job=makeJob({action:'verify'}),driver=fakeDriver([{date:job.date,start_min:job.start_min,end_min:job.end_min,name:'existing guest',manual:false}]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'review');assert.notEqual(result.receipt.verified_released,true);assert.notEqual(result.receipt.verified_blocked,true);
  assert.equal(driver.hostReads.length,1);assert.equal(driver.publicChecks.length,0);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('public verification failure never turns a read-only fast path into confirmed proof',async()=>{
  const job=makeJob({action:'verify'}),driver=fakeDriver(planJob(job).segments.map(own));
  driver.verifyPublic=async function(){this.publicChecks.push({});throw new Error('public snapshot unavailable');};
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'review');assert.notEqual(result.receipt.verified_blocked,true);assert.notEqual(result.receipt.no_conflicts,true);
  assert.equal(driver.hostReads.length,1);assert.equal(driver.publicChecks.length,1);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('a lost lease stops fast verification before public checks and cannot return success',async()=>{
  const job=makeJob({action:'verify'}),driver=fakeDriver(planJob(job).segments.map(own));
  const result=await executeJob(job,driver,async()=>{throw new Error('lease expired');});
  assert.equal(result.status,'review');assert.equal(driver.hostReads.length,1);assert.equal(driver.publicChecks.length,0);
  assert.notEqual(result.receipt.verified_blocked,true);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('a failed final lease check cannot turn completed public checks into successful proof',async()=>{
  const job=makeJob({action:'verify'}),driver=fakeDriver(planJob(job).segments.map(own));let beats=0;
  const result=await executeJob(job,driver,async()=>{if(++beats===2)throw new Error('final lease check failed');});
  assert.equal(result.status,'review');assert.equal(driver.publicChecks.length,1);assert.equal(driver.hostReads.length,1);
  assert.notEqual(result.receipt.no_conflicts,true);assert.notEqual(result.receipt.verified_blocked,true);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('the write path retains its before-change and after-change host checks',async()=>{
  const job=makeJob(),driver=fakeDriver();const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');assert.deepEqual(driver.hostReads,[job.date,job.date,job.date]);
  assert.equal(driver.created.length,1);assert.equal(driver.removed.length,0);assert.equal(driver.publicChecks.length,1);
});

test('a partially owned overnight block still uses the full write checks for the missing segment',async()=>{
  const job=makeJob({start_min:1380,end_min:1560}),segments=planJob(job).segments,driver=fakeDriver([own(segments[0])]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');assert.equal(driver.hostReads.length,6);assert.deepEqual(driver.created,[segments[1]]);
  assert.equal(driver.removed.length,0);assert.equal(driver.publicChecks.length,2);
});

test('second-day conflict prevents first-day creation',async()=>{
  const job=makeJob({start_min:1380,end_min:1560});
  const driver=fakeDriver([{date:'2026-12-09',start_min:60,end_min:180,name:'existing',manual:false}]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'conflict');assert.equal(result.receipt.verified_released,true);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('own block plus another conflict is review, never auto-deleted',async()=>{
  const job=makeJob(),segment=planJob(job).segments[0];
  const driver=fakeDriver([own(segment),{date:job.date,start_min:300,end_min:420,name:'existing'}]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'review');assert.equal(driver.removed.length,0);
});

test('verify cannot create a missing block',async()=>{
  const driver=fakeDriver();const result=await executeJob(makeJob({action:'verify'}),driver,async()=>{});
  assert.equal(result.status,'review');assert.equal(driver.created.length,0);assert.equal(driver.hostReads.length,1);assert.equal(driver.publicChecks.length,0);
});

test('release deletes only exact owned entry and expects remaining guest slots blocked',async()=>{
  const job=makeJob({action:'release'}),segment=planJob(job).segments[0],guest={date:job.date,start_min:300,end_min:420,name:'guest',manual:false};
  const driver=fakeDriver([own(segment),guest]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');assert.equal(result.receipt.verified_released,true);
  assert.equal(driver.removed.length,1);assert.deepEqual(driver.records,[guest]);
  assert.deepEqual(driver.hostReads,[job.date,job.date,job.date]);assert.equal(driver.created.length,0);
  assert.deepEqual(publicSlotExpectations(segment,driver.publicChecks[0].remaining),[{index:4,disabled:false},{index:5,disabled:true}]);
});

test('uncertain write is never retried or rolled back automatically',async()=>{
  const driver=fakeDriver();driver.createSegment=async function(s){this.created.push(s);this.records.push(own(s));throw new Error('write accepted then network lost');};
  const result=await executeJob(makeJob(),driver,async()=>{});
  assert.equal(result.status,'review');assert.equal(driver.created.length,1);assert.equal(driver.removed.length,0);assert.equal(driver.records.length,1);
});

test('lost lease prevents external mutation',async()=>{
  const driver=fakeDriver();const result=await executeJob(makeJob(),driver,async()=>{throw new Error('expired lease');});
  assert.equal(result.status,'review');assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
});

test('adjacent owned overnight segments do not count as duplicate',()=>{
  const [first,second]=planJob(makeJob({start_min:1380,end_min:1560})).segments;
  const result=inspectRecords([own(first),own(second)],second);
  assert.equal(result.own.date,second.date);assert.equal(result.conflicts.length,0);
});

test('fast receipt preserves the host-read start before slow host, public and final lease checks',async()=>{
  const actualNow=Date.now;let clock=1000;
  Date.now=()=>clock;
  try{
    const job=makeJob({action:'verify'}),driver=fakeDriver(planJob(job).segments.map(own));let beats=0;
    driver.recordsFor=async function(date){this.hostReads.push(date);clock=5000;return this.records;};
    driver.verifyPublic=async function(){clock=17000;this.publicChecks.push({});};
    const result=await executeJob(job,driver,async()=>{clock=++beats===1?9000:25000;});
    assert.equal(result.status,'succeeded');assert.equal(result.receipt.observed_at,1000);assert.equal(driver.hostReads.length,1);
    assert.equal(clock,25000);assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);
  }finally{Date.now=actualNow;}
});

test('overnight fast receipt keeps the earliest host-read start across all segments',async()=>{
  const actualNow=Date.now;let clock=1000;
  Date.now=()=>clock;
  try {
    const job=makeJob({action:'verify',start_min:1380,end_min:1560}),segments=planJob(job).segments;
    const driver=fakeDriver(segments.map(own));
    driver.recordsFor=async function(date){this.hostReads.push(date);clock=this.hostReads.length===1?3000:7000;return this.records;};
    driver.verifyPublic=async function(){clock=this.publicChecks.length?27000:15000;this.publicChecks.push({});};
    let beats=0;const result=await executeJob(job,driver,async()=>{clock=[9000,18000,33000][beats++];});
    assert.equal(result.status,'succeeded');assert.equal(result.receipt.observed_at,1000);
    assert.deepEqual(driver.hostReads,segments.map(segment=>segment.date));assert.equal(driver.publicChecks.length,2);
    assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);assert.equal(clock,33000);
  } finally {Date.now=actualNow;}
});

test('queue config rejects remote HTTP, credentials and weak token',()=>{
  const env={API_ORIGIN:'https://example.com',SPACECLOUD_WORKER_TOKEN:'x'.repeat(40)};
  assert.equal(readConfig(env).allowWrites,false);assert.equal(readConfig({...env,SPACECLOUD_ALLOW_WRITES:'true'}).allowWrites,true);
  assert.throws(()=>readConfig({...env,API_ORIGIN:'http://example.com'}));assert.throws(()=>readConfig({...env,API_ORIGIN:'https://user:password@example.com'}));assert.throws(()=>readConfig({...env,SPACECLOUD_WORKER_TOKEN:'short'}));
  assert.equal(readConfig({...env,API_ORIGIN:'http://127.0.0.1:8766'}).origin,'http://127.0.0.1:8766');
});

test('queue never forwards credentials across redirects and uses exact job lease',async()=>{
  let input;const config={origin:'https://example.com',token:'x'.repeat(40)};
  const client=new QueueClient(config,async(url,options)=>{input={url,options};return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});});
  await client.complete(makeJob(),{status:'review',message:'safe'});
  assert.equal(input.url,'https://example.com/api/internal/spacecloud-sync');assert.equal(input.options.redirect,'manual');
  const body=JSON.parse(input.options.body);assert.equal(body.action,'complete');assert.equal(body.job_id,1);assert.equal(body.lease_token,'lease-for-test');
  let calls=0;const redirected=new QueueClient(config,async()=>{calls++;return new Response('',{status:302,headers:{Location:'https://other.test'}});});
  await assert.rejects(redirected.claim(),{code:'queue-http-302'});assert.equal(calls,1);
});

test('creation and release receipts keep the post-write host observation time before slow public verification',async()=>{
 const actualNow=Date.now;
 try{
  for(const action of ['block','release']){
   let clock=1000,lastHostStarted=0;Date.now=()=>clock;const job=makeJob({action}),segment=planJob(job).segments[0],driver=fakeDriver(action==='release'?[own(segment)]:[]);
   driver.recordsFor=async function(date){lastHostStarted=clock;this.hostReads.push(date);clock+=1000;return this.records;};
   driver.verifyPublic=async function(){clock+=60000;this.publicChecks.push({});};
   const result=await executeJob(job,driver,async()=>{});assert.equal(result.status,'succeeded');assert.equal(result.receipt.observed_at,lastHostStarted);assert(clock-result.receipt.observed_at>30000,'a slow public read does not refresh the host snapshot');
  }
 }finally{Date.now=actualNow;}
});
test('a later overnight segment unavailable in the public API prevents every new external write',async()=>{
 const job=makeJob({start_min:1380,end_min:1560}),segments=planJob(job).segments,driver=fakeDriver();driver.config={publicAvailabilityMode:'public-api-v1'};const checked=[];
 driver.assertPublicAvailable=async segment=>{checked.push(segment.date);if(segment.date===segments[1].date)throw new ReviewRequired('public unavailable');};
 const result=await executeJob(job,driver,async()=>{});assert.equal(result.status,'review');assert.deepEqual(checked,segments.map(s=>s.date));assert.equal(driver.created.length,0);assert.equal(driver.removed.length,0);assert.equal(driver.publicChecks.length,0);
});
test('public API preflight is required for new writes while already-owned verification keeps its blocked-slot proof',async()=>{
 const missing=fakeDriver();missing.config={publicAvailabilityMode:'public-api-v1'};assert.equal((await executeJob(makeJob(),missing,async()=>{})).status,'review');assert.equal(missing.created.length,0);
 const job=makeJob({action:'verify'}),driver=fakeDriver(planJob(job).segments.map(own));driver.config={publicAvailabilityMode:'public-api-v1'};driver.assertPublicAvailable=async()=>{throw Error('owned block is intentionally unavailable');};
 const result=await executeJob(job,driver,async()=>{});assert.equal(result.status,'succeeded');assert.equal(driver.created.length,0);assert.equal(driver.publicChecks.length,1);
});

test('overnight block and release verify both dates from a fresh calendar after the final write',async()=>{
  for(const action of ['block','release']){
    const job=makeJob({action,start_min:1380,end_min:1500});
    const segments=planJob(job).segments,dates=segments.map(segment=>segment.date);
    const driver=fakeDriver(action==='release'?segments.map(own):[]);
    const groupedReads=[];
    driver.recordsForDates=async function(requested,{refresh=true}={}){
      groupedReads.push({requested,refresh,writes:this.created.length+this.removed.length});
      return requested.map(()=>[...this.records]);
    };
    driver.verifyPublic=async function(segment,remaining){
      assert.equal(this.created.length+this.removed.length,2);
      this.publicChecks.push({segment,remaining});
    };
    const result=await executeJob(job,driver,async()=>{});
    assert.equal(result.status,'succeeded');
    assert.equal(result.receipt[action==='release'?'verified_released':'verified_blocked'],true);
    assert.deepEqual(groupedReads,[{requested:dates,refresh:false,writes:0},{requested:dates,refresh:true,writes:2}]);
    assert.deepEqual(driver.hostReads,[dates[1]]);
    assert.deepEqual(driver.publicChecks.map(check=>check.segment.date),dates);
  }
});

test('a conflict that appears on the first night during the second write prevents overnight confirmation',async()=>{
  const job=makeJob({start_min:1380,end_min:1500});
  const segments=planJob(job).segments,driver=fakeDriver();
  driver.recordsForDates=async function(dates){return dates.map(()=>[...this.records]);};
  const create=driver.createSegment.bind(driver);
  driver.createSegment=async function(segment){
    await create(segment);
    if(segment.date===segments[1].date)this.records.push({...segments[0],name:'guest booking',manual:false});
  };
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'review');
  assert.equal(result.receipt.verified_blocked,undefined);
  assert.equal(driver.removed.length,0);
});

test('an overnight write missing from the first host refresh is reread without a duplicate write',async()=>{
  const job=makeJob({start_min:1380,end_min:1500});
  const segments=planJob(job).segments,driver=fakeDriver();
  let reads=0;
  driver.recordsForDates=async function(dates){
    reads++;
    return dates.map(()=>reads===2?this.records.slice(0,1):[...this.records]);
  };
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');
  assert.equal(reads,3);
  assert.deepEqual(driver.created,segments);
  assert.equal(driver.publicChecks.length,2);
});

test('an overnight removal missing from the first host refresh is reread without a duplicate removal',async()=>{
  const job=makeJob({action:'release',start_min:1380,end_min:1500});
  const records=planJob(job).segments.map(own),driver=fakeDriver(records);
  let reads=0;
  driver.recordsForDates=async function(dates){
    reads++;
    return dates.map(()=>reads===2?[records[1]]:[...this.records]);
  };
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');
  assert.equal(reads,3);
  assert.deepEqual(driver.removed,records);
  assert.equal(driver.publicChecks.length,2);
});
