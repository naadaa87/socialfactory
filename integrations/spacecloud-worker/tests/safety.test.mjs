import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJob, planJob, memoFor, inspectRecords, ReviewRequired } from '../safety.mjs';
import { calendarGridDates, parseCalendarEntry, publicSlotExpectations } from '../calendar.mjs';
import { readConfig, QueueClient } from '../queue.mjs';

const makeJob=overrides=>({id:1,lease_token:'lease-for-test',action:'block',code:'B261208-TESTING',marker:'SFWEB:B261208-TESTING',room:'r5',date:'2026-12-08',start_min:240,end_min:360,...overrides});
const own=segment=>({...segment,name:segment.marker,memo:memoFor(segment),manual:true});
function fakeDriver(records=[]) {
  return {records:[...records],created:[],removed:[],publicChecks:[],
    async openRoom(){},async recordsFor(){return this.records;},
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
  assert.equal(result.status,'review');assert.equal(driver.created.length,0);
});

test('release deletes only exact owned entry and expects remaining guest slots blocked',async()=>{
  const job=makeJob({action:'release'}),segment=planJob(job).segments[0],guest={date:job.date,start_min:300,end_min:420,name:'guest',manual:false};
  const driver=fakeDriver([own(segment),guest]);
  const result=await executeJob(job,driver,async()=>{});
  assert.equal(result.status,'succeeded');assert.equal(result.receipt.verified_released,true);
  assert.equal(driver.removed.length,1);assert.deepEqual(driver.records,[guest]);
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

test('receipt uses earliest segment observation before a slow final heartbeat',async()=>{
  const actualNow=Date.now;let clock=1000;
  Date.now=()=>clock;
  try {
    const job=makeJob({start_min:1380,end_min:1560}),segments=planJob(job).segments;
    const driver=fakeDriver(segments.map(own));
    driver.verifyPublic=async function(){clock=this.publicChecks.length?5000:1000;this.publicChecks.push({});};
    const result=await executeJob(job,driver,async()=>{clock=9000;});
    assert.equal(result.status,'succeeded');assert.equal(result.receipt.observed_at,1000);
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
  assert.equal(input.url,'https://example.com/api/internal/spacecloud-sync');assert.equal(input.options.redirect,'error');
  const body=JSON.parse(input.options.body);assert.equal(body.action,'complete');assert.equal(body.job_id,1);assert.equal(body.lease_token,'lease-for-test');
});
