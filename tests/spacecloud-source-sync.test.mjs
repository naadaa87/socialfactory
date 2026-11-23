import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureSourceSync,sourceSnapshot,sourceVersion,enqueueSourceSync,claimSourceSync,checkpointSourceSync,attachSourceSync,retrySourceSync} from '../functions/_lib/spacecloud-source-sync.js';
import {ensureHostCalendar} from '../functions/_lib/spacecloud-host-calendar.js';
import {calendarRows,mergeCalendarRows} from '../functions/_lib/spacecloud.js';
import {loadCalendarDisplay,publishCalendarDisplay} from '../functions/_lib/spacecloud-display.js';
import {readBoard} from '../functions/_lib/reservation-board.js';
import {onRequestPost as admin} from '../functions/api/admin/spacecloud-source.js';
import {onRequestPost as internal} from '../functions/api/internal/spacecloud-source.js';
import {onRequestPatch as patchReservation} from '../functions/api/admin/reservations.js';
import {executeSourceJob} from '../workers/spacecloud-cloud/source-sync.mjs';
import {ROOMS} from '../integrations/spacecloud-worker/spacecloud-ui.mjs';
const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const state={cookies:[],origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'spacecloud__userInfo',value:JSON.stringify({accessToken:'PRIVATE_AUTH'})}]}]};
const source=()=>({id:'77',space:'r1',date:day(10),start_min:600,end_min:720,title:'운영점검단체'});
async function fixture(t,{linked=false}={}) {
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 let tail=Promise.resolve();const DB={prepare(sql){let args=[];const q={bind(...v){args=v;return q;},async all(){return {results:sqlite.prepare(sql).all(...args)};},
  async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return q;},batch(statements){
  const run=tail.then(async()=>{sqlite.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}});
  tail=run.catch(()=>{});return run;
 }};
 const env={DB,ADMIN_KEY:'source-admin-test-only',SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'source-worker-test-only-longer-than-32-chars'};
 await ensureHostCalendar(env);await ensureSourceSync(env);
 const before=source(),base=Date.parse(before.date+'T00:00:00+09:00');
 const rows=await calendarRows([{start:base+before.start_min*60000,end:base+before.end_min*60000,title:before.title,source_manual_id:before.id,source_url:''}],before.space,Date.now());
 const projection={results:rows,info:{configured:false,rooms:[],host_calendar:{last_success:Date.now()-1000}}};
 await publishCalendarDisplay(env,projection,[],Date.now());
 if(linked)sqlite.prepare("INSERT INTO reservations(code,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,refund_amount) VALUES(?,'r1',?,600,720,?,'spacecloud',55000,'bank_other','paid',0)").run(rows[0].code,before.date,before.title);
 const body={code:rows[0].code,action:'update',expected_version:await sourceVersion(before),space:'r2',date:day(11),start_min:780,end_min:900};
 return {env,sqlite,before,rows,body};
}
function provider(before) {
 const records=[{...before,tel:'01012345678',memo:'PRIVATE_ORIGINAL_MEMO'}],paid=[],writes=[];let sequence=80,failAfterCreate=false,failAfterDelete=false;
 const fetcher=async(input,options={})=>{
  const url=new URL(input);
  assert.equal(url.origin,'https://api.spacecloud.kr');assert.equal(options.headers.Authorization,'PRIVATE_AUTH');
  if(url.pathname==='/partner/reservations/calendar') {
   assert.equal(options.method,'GET');
   const room=Object.keys(ROOMS).find(r=>String(ROOMS[r].product)===url.searchParams.get('product_id'));
   const month=url.searchParams.get('year')+'-'+url.searchParams.get('month');
   const first=Date.parse(month+'-01T00:00:00Z'),last=new Date(first);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
   const start=first-new Date(first).getUTCDay()*86400000,total=Math.ceil((last-start+86400000)/604800000)*7;
   return Response.json(Array.from({length:total},(_,i)=>{
    const date=new Date(start+i*86400000).toISOString().slice(0,10);
    return {reservations:paid.filter(r=>r.space===room&&r.date===date).map(r=>({id:r.id,symd:date.replaceAll('-',''),shour:r.start_min/60,ehour:r.end_min/60-1,rsv_stat_cd:'RSCFM',user_info:{name:r.title}})),
     external_schedules:records.filter(r=>r.space===room&&r.date===date).map(r=>({id:r.id,symd:date.replaceAll('-',''),shour:r.start_min/60,ehour:r.end_min/60-1,name:r.title,tel:r.tel,memo:r.memo}))};
   }));
  }
  const match=/^\/partner\/products\/(\d+)\/external_schedules(?:\/(\d+))?$/.exec(url.pathname);assert(match);
  const space=Object.keys(ROOMS).find(r=>String(ROOMS[r].product)===match[1]),id=match[2],method=options.method;
  const body=options.body?JSON.parse(options.body):null;writes.push({space,id,method,body});
  if(method==='DELETE') {
   const index=records.findIndex(r=>r.space===space&&r.id===id);assert(index>=0);records.splice(index,1);
   if(failAfterDelete){failAfterDelete=false;throw Error('response lost');}
   return Response.json({success:true});
  }
  assert(['POST','PUT'].includes(method));assert.equal(body.REPEAT_TYPE,'-1');assert.equal(body.SDATE,body.EDATE);
  const point={id:id||String(++sequence),space,date:body.SDATE.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'),start_min:Number(body.SHOUR)*60,end_min:(Number(body.EHOUR)+1)*60,title:body.NAME,tel:body.TEL,memo:body.MEMO};
  if(method==='PUT') {const index=records.findIndex(r=>r.space===space&&r.id===id);assert(index>=0);records[index]=point;}
  else records.push(point);
  if(method==='POST'&&failAfterCreate){failAfterCreate=false;throw Error('response lost');}
  return Response.json({success:true});
 };
 return {records,paid,writes,fetcher,loseCreateResponse(){failAfterCreate=true;},loseDeleteResponse(){failAfterDelete=true;}};
}
async function run(f,remote) {
 const job=await claimSourceSync(f.env);assert(job);
 const result=await executeSourceJob(job,state,{fetcher:remote.fetcher,checkpoint:body=>checkpointSourceSync(f.env,{...body,id:job.id,lease_token:job.lease_token})});
 await checkpointSourceSync(f.env,{action:'finish',id:job.id,lease_token:job.lease_token,state:result.state});
 return job;
}
test('source metadata requires a verified host ID; old titles and owned website holds cannot authorize writes',async()=>{
 assert.equal(sourceSnapshot({space:'r1',date:day(1),customer_name:'일반 수기 이름'}),null);
 assert.equal(sourceSnapshot({source_manual_id:'77',space:'r1',source_manual_date:day(1),source_manual_start:600,source_manual_duration:120,customer_name:'SFWEB:OWNED'}),null);
});
test('room/date/time move is verified before deleting the exact original, preserving revenue and native contacts',async t=>{
 const f=await fixture(t,{linked:true}),remote=provider(f.before);
 const beforeMoney=f.sqlite.prepare('SELECT amount,refund_amount,pay_status FROM reservations').get();
 await enqueueSourceSync(f.env,f.body);
 assert.equal(f.sqlite.prepare('SELECT space FROM reservations').get().space,'r1');
 await run(f,remote);
 assert.deepEqual(remote.writes.map(w=>w.method),['POST','DELETE']);assert.equal(remote.writes[1].id,'77');
 assert.equal(remote.records.length,1);assert.equal(remote.records[0].space,'r2');assert.equal(remote.records[0].date,f.body.date);
 assert.equal(remote.records[0].tel,'01012345678');assert(remote.records[0].memo.startsWith('PRIVATE_ORIGINAL_MEMO\n[SFEDIT:'));
 assert.deepEqual(f.sqlite.prepare('SELECT amount,refund_amount,pay_status FROM reservations').get(),beforeMoney);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,1);
 const view=await loadCalendarDisplay(f.env,{});assert.equal(view.results.length,1);assert.equal(view.results[0].space,'r2');
 const report=await readBoard(f.env,{today:f.body.date,loadExternal:(env,options)=>loadCalendarDisplay(env,options),mergeRows:mergeCalendarRows});
 assert.equal(report.reservations.length,1);assert.equal(report.reservations[0].room,'r2');
 const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM spacecloud_source_jobs').all());
 for(const secret of ['PRIVATE_AUTH','01012345678','PRIVATE_ORIGINAL_MEMO'])assert(!stored.includes(secret));
});
test('same-room edits use PUT and a second lease resolves an already applied edit without resubmitting it',async t=>{
 const f=await fixture(t),remote=provider(f.before);f.body.space='r1';
 await enqueueSourceSync(f.env,f.body);await run(f,remote);
 assert.deepEqual(remote.writes.map(w=>w.method),['PUT']);assert.equal(remote.records[0].id,'77');
 const done=f.sqlite.prepare('SELECT * FROM spacecloud_source_jobs').get();
 f.sqlite.prepare("UPDATE spacecloud_source_jobs SET state='queued'").run();await run(f,remote);
 assert.equal(remote.writes.length,1);assert.equal(done.phase,'writing');
});
test('a lost creation response is resolved by its unique marker and never creates a duplicate',async t=>{
 const f=await fixture(t),remote=provider(f.before);remote.loseCreateResponse();
 await enqueueSourceSync(f.env,f.body);await run(f,remote);
 assert.deepEqual(remote.writes.map(w=>w.method),['POST','DELETE']);assert.equal(remote.records.length,1);
});
test('an expired creating lease only recovers a matching replacement; it never repeats an uncertain POST',async t=>{
 const f=await fixture(t),remote=provider(f.before);await enqueueSourceSync(f.env,f.body);
 const job=await claimSourceSync(f.env);await checkpointSourceSync(f.env,{...job,action:'checkpoint',phase:'creating'});
 f.sqlite.prepare("UPDATE spacecloud_source_jobs SET lease_until=0").run();
 const recovery=await claimSourceSync(f.env);
 await assert.rejects(executeSourceJob(recovery,state,{fetcher:remote.fetcher,checkpoint:()=>{throw Error('no new writes');}}),{code:'source-creation-uncertain'});
 assert.equal(remote.writes.length,0);assert.equal(remote.records.length,1);
});
test('recovery after a lost create acknowledgement adopts exactly one marked replacement',async t=>{
 const f=await fixture(t),remote=provider(f.before);await enqueueSourceSync(f.env,f.body);
 const job=await claimSourceSync(f.env);await checkpointSourceSync(f.env,{...job,action:'checkpoint',phase:'creating'});
 remote.records.push({id:'98',...job.target,tel:'01012345678',memo:'PRIVATE_ORIGINAL_MEMO\n[SFEDIT:'+job.id+']'});
 f.sqlite.prepare("UPDATE spacecloud_source_jobs SET lease_until=0").run();await run(f,remote);
 assert.deepEqual(remote.writes.map(w=>w.method),['DELETE']);assert.equal(remote.records.length,1);assert.equal(remote.records[0].id,'98');
});
test('a later authoritative snapshot supersedes the verified write bridge',async t=>{
 const f=await fixture(t),remote=provider(f.before);await enqueueSourceSync(f.env,f.body);await run(f,remote);
 const target=remote.records[0],base=Date.parse(target.date+'T00:00:00+09:00');
 const newest=await calendarRows([{start:base+target.start_min*60000,end:base+target.end_min*60000,title:'원본에서 다시 수정한 이름',source_manual_id:target.id,source_url:''}],target.space,Date.now());
 await publishCalendarDisplay(f.env,{results:newest,info:{configured:false,rooms:[],host_calendar:{last_success:Date.now()+10}}},[],Date.now()+10);
 const rows=(await loadCalendarDisplay(f.env,{})).results;assert.equal(rows.length,1);assert.equal(rows[0].customer_name,'원본에서 다시 수정한 이름');
});
test('manual cancellation removes occupancy, preserves financial records, and recovers a lost DELETE response',async t=>{
 const f=await fixture(t,{linked:true}),remote=provider(f.before);remote.loseDeleteResponse();
 await enqueueSourceSync(f.env,{...f.body,action:'cancel'});await run(f,remote);
 assert.equal(remote.records.length,0);assert.equal((await loadCalendarDisplay(f.env,{})).results.length,0);
 const money=f.sqlite.prepare('SELECT status,amount,refund_amount,pay_status FROM reservations').get();
 assert.equal(money.status,'cancelled');assert.equal(money.amount,55000);assert.equal(money.refund_amount,0);assert.equal(money.pay_status,'paid');
});
test('concurrent changes, paid-only identities, ambiguous originals and target conflicts abort before any mutation',async t=>{
 for(const kind of ['changed','paid','duplicate','conflict']) {
  const f=await fixture(t),remote=provider(f.before);await enqueueSourceSync(f.env,f.body);const job=await claimSourceSync(f.env);
  if(kind==='changed')remote.records[0].title='다른 운영자가 수정한 이름';
  if(kind==='paid'){remote.records.length=0;remote.paid.push({...f.before});}
  if(kind==='duplicate')remote.records.push({...remote.records[0],id:'78'});
  if(kind==='conflict')remote.paid.push({id:'99',...f.body,title:'다른 예약'});
  await assert.rejects(executeSourceJob(job,state,{fetcher:remote.fetcher,checkpoint:body=>checkpointSourceSync(f.env,{...body,id:job.id,lease_token:job.lease_token})}));
  assert.equal(remote.writes.length,0,kind);
 }
});
test('queue rejects stale views, unsupported half-hours, duplicate requests and native payment records',async t=>{
 const f=await fixture(t);
 await assert.rejects(enqueueSourceSync(f.env,{...f.body,expected_version:'stale'}),{code:'source-stale'});
 await assert.rejects(enqueueSourceSync(f.env,{...f.body,start_min:810}),{code:'source-time'});
 await enqueueSourceSync(f.env,f.body);
 await assert.rejects(enqueueSourceSync(f.env,f.body),{code:'source-busy'});
 await publishCalendarDisplay(f.env,{results:[{...f.rows[0],source_manual_id:undefined,source_url:'https://partner.spacecloud.kr/reservation/123'}],info:{configured:false,rooms:[]}},[],Date.now()+1);
 await assert.rejects(enqueueSourceSync(f.env,f.body),{code:'source-unavailable'});
});
test('HTTP controls require the right credentials; lease checkpoints cannot complete an unverified original',async t=>{
 const f=await fixture(t);
 const request=(body,token)=>new Request('https://site.test/api/source',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 assert.equal((await admin({env:f.env,request:request(f.body)})).status,401);
 assert.equal((await internal({env:f.env,request:request({action:'claim'},f.env.ADMIN_KEY)})).status,401);
 assert.equal((await admin({env:f.env,request:request(f.body,f.env.ADMIN_KEY)})).status,202);
 const job=await claimSourceSync(f.env);
 await assert.rejects(checkpointSourceSync(f.env,{...job,action:'finish',state:'succeeded'}),{code:'source-receipt'});
 await assert.rejects(checkpointSourceSync(f.env,{...job,lease_token:'wrong',action:'checkpoint',phase:'creating'}),{code:'source-lease'});
 await checkpointSourceSync(f.env,{...job,action:'finish',state:'review'});
 await retrySourceSync(f.env,job.id);
 const retried=await claimSourceSync(f.env);assert.equal(retried.phase,'planned');assert.notEqual(retried.lease_token,job.lease_token);
});
test('the original imported ledger form cannot silently change geometry or cancel a paid source',async t=>{
 const f=await fixture(t,{linked:true});
 const request=new Request('https://site.test/api/admin/reservations',{method:'PATCH',headers:{authorization:'Bearer '+f.env.ADMIN_KEY,'content-type':'application/json'},body:JSON.stringify({code:f.body.code,action:'cancel'})});
 const response=await patchReservation({env:f.env,request});assert.equal(response.status,409);
 assert.equal((await response.json()).error,'source-original-required');assert.equal(f.sqlite.prepare('SELECT status FROM reservations').get().status,'confirmed');
 const rows=await attachSourceSync(f.env,f.rows,f.rows);assert.equal(rows[0].source_manual.id,'77');assert(rows[0].source_manual.version);
});

test('temporary errors back off without losing the write checkpoint and expose persistent delays',async t=>{
 const {readSyncAlerts}=await import('../functions/_lib/spacecloud-sync-alerts.js');
 const f=await fixture(t);await enqueueSourceSync(f.env,f.body);
 let now=Date.now()+10;
 for(const [index,delay] of [60000,120000,300000,600000,900000,900000].entries()) {
  const job=await claimSourceSync(f.env,{now});assert(job);
  if(index===0)await checkpointSourceSync(f.env,{...job,action:'checkpoint',phase:'creating'},{now});
  else assert.equal(job.phase,'creating');
  await checkpointSourceSync(f.env,{...job,action:'finish',state:'retry',error:'source-network'},{now});
  assert.equal(await claimSourceSync(f.env,{now:now+delay-1}),null);
  const report=await readSyncAlerts(f.env,{now});
  assert.equal(report.counts.retrying,1);assert.equal(report.counts.delayed,index>=2?1:0);
  assert.equal(report.items[0].next_retry_at,now+delay);assert.equal(report.items[0].attempts,index+1);
  assert.equal(report.items[0].before.title,f.before.title);assert.equal(report.items[0].target.space,f.body.space);
  const leaked=JSON.stringify(report);for(const key of ['lease_token','before_json','PRIVATE_AUTH','PRIVATE_ORIGINAL_MEMO'])assert(!leaked.includes(key));
  now+=delay;
 }
 // A longer provider throttle is respected instead of shortening it to backoff.
 const job=await claimSourceSync(f.env,{now});
 await checkpointSourceSync(f.env,{...job,action:'finish',state:'retry',error:'source-rate-limit',retry_after_ms:3600000},{now});
 assert.equal((await readSyncAlerts(f.env,{now})).items[0].next_retry_at,now+3600000);
 assert.equal(f.sqlite.prepare('SELECT phase FROM spacecloud_source_jobs').get().phase,'creating');
});
test('status is authenticated, global, read-only and retains alerts even when the original disappears',async t=>{
 const {onRequestGet}=await import('../functions/api/admin/spacecloud-source.js');
 const {readSyncAlerts}=await import('../functions/_lib/spacecloud-sync-alerts.js');
 const f=await fixture(t);await enqueueSourceSync(f.env,f.body);const job=await claimSourceSync(f.env);
 await checkpointSourceSync(f.env,{...job,action:'finish',state:'review',error:'source-creation-uncertain'});
 await publishCalendarDisplay(f.env,{results:[],info:{configured:false,rooms:[]}},[],Date.now()+1);
 const before=f.sqlite.prepare('SELECT * FROM spacecloud_source_jobs').all();
 const request=token=>new Request('https://site.test/api/admin/spacecloud-source',{headers:token?{authorization:'Bearer '+token}:{}});
 assert.equal((await onRequestGet({env:f.env,request:request()})).status,401);
 const response=await onRequestGet({env:f.env,request:request(f.env.ADMIN_KEY)});assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');const report=await response.json();
 assert.equal(report.counts.review,1);assert.equal(report.items[0].id,job.id);assert(report.items[0].needs_attention);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM spacecloud_source_jobs').all(),before);
 // Stuck first-time work is flagged even if no worker can claim it.
 await retrySourceSync(f.env,job.id);
 f.sqlite.prepare('UPDATE spacecloud_source_jobs SET created_at=?,attempts=0').run(Date.now()-300001);
 assert.equal((await readSyncAlerts(f.env)).counts.delayed,1);
});
test('alerts cover local admin holds and releases without affecting payment or source queues',async t=>{
 const {ensureSyncSchema}=await import('../functions/_lib/booking-spacecloud-sync.js');
 const {readSyncAlerts}=await import('../functions/_lib/spacecloud-sync-alerts.js');
 const f=await fixture(t,{linked:true});await ensureSyncSchema(f.env);const now=Date.now();
 f.sqlite.prepare(`INSERT INTO spacecloud_admin_links(sync_code,reservation_code,room,date,original_start,original_end,desired,created_at) VALUES('BADMtest',?,'r3',?,600,660,0,?)`).run(f.body.code,f.before.date,now);
 f.sqlite.prepare(`INSERT INTO spacecloud_blocks(code,room,date,start_min,end_min,marker,access_token,state,created_at,updated_at) VALUES('BADMtest','r3',?,600,660,'SFWEB:BADMtest','DO_NOT_LEAK','review',?,?)`).run(f.before.date,now,now);
 const report=await readSyncAlerts(f.env,{now});assert.equal(report.counts.review,1);
 assert.equal(report.items[0].kind,'admin');assert.equal(report.items[0].action,'cancel');assert(!JSON.stringify(report).includes('DO_NOT_LEAK'));
 assert.equal(f.sqlite.prepare('SELECT amount FROM reservations').get().amount,55000);
});
test('native network and upstream 5xx errors are retried safely; uncertainty never repeats a create',async t=>{
 const {retryableSourceError}=await import('../workers/spacecloud-cloud/source-sync.mjs');
 const f=await fixture(t);await enqueueSourceSync(f.env,f.body);const job=await claimSourceSync(f.env),remote=provider(f.before);
 const checkpoint=body=>checkpointSourceSync(f.env,{...body,id:job.id,lease_token:job.lease_token});
 let networkError;try {await executeSourceJob(job,state,{checkpoint,fetcher:async()=>{throw new TypeError('PRIVATE_NETWORK_DETAIL');}});}catch(error){networkError=error;}
 assert.equal(networkError.code,'source-network');assert(retryableSourceError(networkError));
 // A POST accepted before a 503 is verified and completed without repeating it.
 let postCount=0;
 const fetcher=async(url,options)=>{const r=await remote.fetcher(url,options);if(options.method==='POST'){postCount++;return new Response('',{status:503});}return r;};
 const done=await executeSourceJob(job,state,{checkpoint,fetcher});assert.equal(done.state,'succeeded');assert.equal(postCount,1);
 assert.equal(retryableSourceError({code:'source-write-unverified'}),true);
 for(const code of ['source-creation-uncertain','source-conflict','source-stale','source-ambiguous'])assert.equal(retryableSourceError({code}),false);
});
