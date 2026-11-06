import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ensureSyncSchema,enqueueSync,getSync,claimSyncJob,finishSyncJob,heartbeatSyncJob,requireVerifiedBlock,queueRelease,
  bookingSegments,saveWorkerCalendar,loadWorkerCalendar,workerAuthorized } from '../functions/_lib/booking-spacecloud-sync.js';
import { onRequestGet } from '../functions/api/internal/spacecloud-sync.js';

function setup() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  let batchTail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},async first(){return sqlite.prepare(sql).get(...args)||null;},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},async batch(statements){
      const task=batchTail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}});batchTail=task.catch(()=>{});return task;}};
  return {DB,sqlite,SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'test-worker-token-never-use-in-production-123'};
}
const booking=(extra={})=>({code:'B261208-SYNC01',room:'r5',date:'2026-12-08',start_min:240,end_min:360,...extra});
const receipt=(job,extra={})=>({marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,
  segments:job.segments,no_conflicts:true,verified_blocked:true,observed_at:Date.now(),...extra});
const complete=(job,extra={})=>({job_id:job.id,lease_token:job.lease_token,status:'succeeded',receipt:receipt(job),...extra});

test('worker claims require independent long bearer secret; public requests get no job data',async()=>{
  const env=setup();await ensureSyncSchema(env);await enqueueSync(env,booking());
  const denied=await onRequestGet({request:new Request('https://example.test/api/internal/spacecloud-sync'),env});
  assert.equal(denied.status,401);assert(!JSON.stringify(await denied.json()).includes('B261208'));
  assert.equal(workerAuthorized(new Request('https://example.test',{headers:{authorization:'Bearer '+env.SPACECLOUD_WORKER_TOKEN}}),env),true);
  assert.equal(workerAuthorized(new Request('https://example.test',{headers:{authorization:'Bearer test'}}),{SPACECLOUD_WORKER_TOKEN:'test'}),false);
});

test('enqueue is idempotent, binds immutable room/time and rejects unsupported half-hour writes',async()=>{
  const env=setup(),a=await enqueueSync(env,booking()),b=await enqueueSync(env,booking());
  assert.equal(a.marker,'SFWEB:'+booking().code);assert.equal(a.access_token,b.access_token);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sync_jobs').get().n,1);
  await assert.rejects(enqueueSync(env,booking({start_min:300,end_min:420})),{code:'sync-scope'});
  await assert.rejects(enqueueSync(env,booking({code:'B261208-HALF01',start_min:270,end_min:390})),{code:'sync-time-step'});
  assert.deepEqual(bookingSegments(booking({start_min:1380,end_min:1500})),[
    {date:'2026-12-08',start_min:1380,end_min:1440,marker:a.marker},{date:'2026-12-09',start_min:0,end_min:60,marker:a.marker}]);
});

test('concurrent worker polls serialize all jobs in the same room but permit independent rooms',async()=>{
  const env=setup();await enqueueSync(env,booking());await enqueueSync(env,booking({code:'B261209-SYNC02',date:'2026-12-09'}));
  const claims=await Promise.all([claimSyncJob(env),claimSyncJob(env)]);
  assert.equal(claims.filter(Boolean).length,1);
  await enqueueSync(env,booking({code:'B261208-SYNC03',room:'r4'}));
  assert.equal((await claimSyncJob(env)).room,'r4');
  assert(!JSON.stringify(claims).includes('access_token'));
});

test('exact verified receipt gates checkout freshness; replay never creates a second block',async()=>{
  const env=setup(),scope=booking();await enqueueSync(env,scope);
  await assert.rejects(requireVerifiedBlock(env,scope),{code:'sync-not-ready'});
  const job=await claimSyncJob(env);
  assert.equal((await heartbeatSyncJob(env,{job_id:job.id,lease_token:job.lease_token})).ok,true);
  assert.equal((await finishSyncJob(env,complete(job))).state,'blocked');
  assert.equal((await requireVerifiedBlock(env,scope)).state,'blocked');
  assert.equal((await finishSyncJob(env,complete(job))).already,true);
  assert.equal(await claimSyncJob(env),null);
  env.sqlite.prepare('UPDATE spacecloud_blocks SET verified_at=? WHERE code=?').run(Date.now()-31000,scope.code);
  await assert.rejects(requireVerifiedBlock(env,scope),{code:'sync-not-ready'});
  await enqueueSync(env,scope,'verify');const verify=await claimSyncJob(env);assert.equal(verify.action,'verify');
  await finishSyncJob(env,complete(verify));assert.equal((await requireVerifiedBlock(env,scope)).state,'blocked');
});

test('mismatched scope, partial midnight proof or uncertain conflict quarantines capacity',async()=>{
  for(const bad of [job=>({...receipt(job),room:'r1'}),job=>({...receipt(job),segments:[]}),job=>({...receipt(job),no_conflicts:false})]) {
    const env=setup(),scope=booking({start_min:1380,end_min:1500});await enqueueSync(env,scope);const job=await claimSyncJob(env);
    const result=await finishSyncJob(env,complete(job,{receipt:bad(job)}));assert.equal(result.state,'review');
    await assert.rejects(requireVerifiedBlock(env,scope),{code:'sync-not-ready'});
    await enqueueSync(env,booking({code:'B261209-SYNC02',date:'2026-12-09'}));assert.equal(await claimSyncJob(env),null);
  }
  const env=setup();await enqueueSync(env,booking());const job=await claimSyncJob(env);
  const result=await finishSyncJob(env,complete(job,{status:'conflict',receipt:{}}));assert.equal(result.state,'review');
});

test('old or invalid observation timestamps cannot become fresh checkout proof after delayed acknowledgement',async()=>{
  for(const observed_at of [Date.now()-31000,Date.now()+6000,null,'2026-12-08T04:00:00Z']) {
    const env=setup(),scope=booking();await enqueueSync(env,scope);const job=await claimSyncJob(env);
    const result=await finishSyncJob(env,complete(job,{receipt:receipt(job,{observed_at})}));
    assert.equal(result.state,'review');assert.equal((await getSync(env,scope.code)).verified_at,null);
    await assert.rejects(requireVerifiedBlock(env,scope),{code:'sync-not-ready'});
  }
  const env=setup(),scope=booking();await enqueueSync(env,scope);const job=await claimSyncJob(env),observed_at=Date.now()-5000;
  await finishSyncJob(env,complete(job,{receipt:receipt(job,{observed_at})}));
  assert.equal((await getSync(env,scope.code)).verified_at,observed_at);
  assert.equal((await requireVerifiedBlock(env,scope)).state,'blocked');
});

test('conflict is terminal only with proof that no owned remote block remains',async()=>{
  const env=setup();await enqueueSync(env,booking());const job=await claimSyncJob(env);
  const result=await finishSyncJob(env,complete(job,{status:'conflict',receipt:receipt(job,{verified_released:true})}));
  assert.equal(result.state,'conflict');assert.equal((await getSync(env,booking().code)).verified_at,null);
});

test('cancellation during an in-flight block never allows checkout and release waits for ownership proof',async()=>{
  const env=setup(),scope=booking();await enqueueSync(env,scope);const block=await claimSyncJob(env);
  await queueRelease(env,scope);assert.equal(await claimSyncJob(env),null);
  await finishSyncJob(env,complete(block));assert.equal((await getSync(env,scope.code)).state,'releasing');
  await assert.rejects(requireVerifiedBlock(env,scope),{code:'sync-not-ready'});
  const release=await claimSyncJob(env);assert.equal(release.action,'release');
  await finishSyncJob(env,complete(release,{receipt:receipt(release,{verified_released:true,verified_blocked:false})}));
  assert.equal((await getSync(env,scope.code)).state,'released');
});

test('lost lease is quarantined instead of replayed blindly; expired worker cannot mutate acknowledged state',async()=>{
  const env=setup();await enqueueSync(env,booking());const job=await claimSyncJob(env);
  env.sqlite.prepare('UPDATE spacecloud_sync_jobs SET lease_until=? WHERE id=?').run(Date.now()-1,job.id);
  await assert.rejects(heartbeatSyncJob(env,{job_id:job.id,lease_token:job.lease_token}),{code:'sync-lease-expired'});
  assert.equal(await claimSyncJob(env),null);assert.equal((await getSync(env,booking().code)).state,'review');
  const replay=await finishSyncJob(env,complete(job));assert.equal(replay.status,'review');
  assert.equal((await getSync(env,booking().code)).state,'review');
});

test('durable external holds survive cancelled local records until release is acknowledged, including midnight',async()=>{
  const env=setup();await enqueueSync(env,booking({start_min:1380,end_min:1500}));
  const insert=()=>env.sqlite.prepare(`INSERT INTO reservations (code,status,space,date,start_min,end_min,customer_name,amount,pay_method,pay_status)
    VALUES ('OTHER-RESERVATION','confirmed','r5','2026-12-09',0,120,'existing',20000,'card_offline','paid')`).run();
  assert.throws(insert,/booking-conflict/);
  const job=await claimSyncJob(env);await finishSyncJob(env,complete(job));await queueRelease(env,booking({start_min:1380,end_min:1500}));
  assert.throws(insert,/booking-conflict/);
  const release=await claimSyncJob(env);await finishSyncJob(env,complete(release,{receipt:receipt(release,{verified_released:true})}));
  assert.doesNotThrow(insert);
});

test('calendar snapshots replace complete date scopes without retaining guest data or stale ghost reservations',async()=>{
  const env=setup();const body={room:'r5',range_start:'2026-12-08',range_end:'2026-12-09',events:[
    {date:'2026-12-08',start_min:240,end_min:360,name:'PRIVATE',phone:'01077779999'},
    {date:'2026-12-09',start_min:0,end_min:60,marker:'SFWEB:B261208-SYNC01'}]};
  await saveWorkerCalendar(env,body);let snapshot=await loadWorkerCalendar(env);
  assert.equal(snapshot.results.length,2);assert(!JSON.stringify(snapshot).includes('PRIVATE'));assert(!JSON.stringify(snapshot).includes('01077779999'));
  await saveWorkerCalendar(env,{...body,events:[]});snapshot=await loadWorkerCalendar(env);assert.equal(snapshot.results.length,0);assert.equal(snapshot.rooms.length,2);
  await assert.rejects(saveWorkerCalendar(env,{...body,events:[{date:'2026-12-10',start_min:0,end_min:60}]}),{code:'sync-snapshot'});
});
