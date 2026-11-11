import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prepareBookings} from '../functions/_lib/booking.js';
import {reconcileAdminReservations,adminReservationSyncStatus} from '../functions/_lib/admin-spacecloud-sync.js';
import {claimSyncJob,finishSyncJob,getSync,bookingSegments} from '../functions/_lib/booking-spacecloud-sync.js';
import {onRequestPost,onRequestPatch,onRequestDelete} from '../functions/api/admin/reservations.js';
import {executeJob,planJob,memoFor} from '../integrations/spacecloud-worker/safety.mjs';
import {SpacecloudUI} from '../integrations/spacecloud-worker/spacecloud-ui.mjs';

async function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  let tail=Promise.resolve();
  const DB={prepare(sql){
    let args=[];
    const stmt={bind(...values){args=values;return stmt;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async first(){return sqlite.prepare(sql).get(...args)||null;},
      async run(){return {meta:sqlite.prepare(sql).run(...args)};}};
    return stmt;
  },batch(statements){
    const task=tail.then(async()=>{
      sqlite.exec('BEGIN');
      try{const results=[];for(const stmt of statements)results.push(await stmt.run());sqlite.exec('COMMIT');return results;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    });
    tail=task.catch(()=>{});
    return task;
  }};
  const env={DB,sqlite,ADMIN_KEY:'test-admin',SPACECLOUD_SYNC_ENABLED:'true',SPACECLOUD_WORKER_TOKEN:'test-worker-token-12345678901234567890'};
  await prepareBookings(env);
  return env;
}
const date=()=>new Date(Date.now()+20*86400000).toISOString().slice(0,10);
function insert(env,extra={}) {
  const row={code:'RADMIN01',space:'r3',date:date(),start_min:600,end_min:720,channel:'phone',status:'confirmed',...extra};
  env.sqlite.prepare(`INSERT INTO reservations(code,space,date,start_min,end_min,channel,status,customer_name,amount,pay_method,pay_status)
    VALUES(?,?,?,?,?,?,?,'운영 점검',0,'card_offline','unpaid')`).run(row.code,row.space,row.date,row.start_min,row.end_min,row.channel,row.status);
  return row;
}
const ack=async(env,job,status='succeeded')=>finishSyncJob(env,{job_id:job.id,lease_token:job.lease_token,status,
  receipt:{...job,observed_at:Date.now(),verified_blocked:job.action!=='release',verified_released:job.action==='release'||status==='conflict',no_conflicts:true}});
const links=env=>env.sqlite.prepare('SELECT l.*,b.state,b.cancel_requested FROM spacecloud_admin_links l JOIN spacecloud_blocks b ON b.code=l.sync_code ORDER BY l.created_at,l.sync_code').all();
const request=(body,method='POST')=>new Request('https://example.test/api/admin/reservations',{method,headers:{authorization:'Bearer test-admin','content-type':'application/json'},body:JSON.stringify(body)});

test('backfill is idempotent and excludes SpaceCloud originals, paid website bookings and past reservations',async()=>{
  const env=await fixture();insert(env);
  insert(env,{code:'RIMPORT',channel:'spacecloud',start_min:780,end_min:900});
  insert(env,{code:'RPAST',date:'2020-01-01'});
  insert(env,{code:'RWEB',space:'r4'});
  env.sqlite.prepare(`INSERT INTO booking_requests(code,status,room,date,start_min,end_min,people,customer_name,phone,purpose,amount,submission_id,fingerprint,consent,notice_version)
    VALUES('RWEB','confirmed','r4',?,600,720,2,'운영 점검','01012345678','meeting',0,'submission','hash',1,'test')`).run(date());
  await Promise.all([reconcileAdminReservations(env),reconcileAdminReservations(env)]);
  assert.equal(links(env).length,1);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sync_jobs').get().n,1);
  const job=await claimSyncJob(env);
  assert.equal(job.action,'block');assert.match(job.code,/^BADM[a-f0-9]{32}$/);
  await ack(env,job);await reconcileAdminReservations(env);
  assert.equal(await claimSyncJob(env),null);
});

test('overlapping reschedule acquires the new version before releasing the old version',async()=>{
  const env=await fixture(),row=insert(env);
  await reconcileAdminReservations(env);
  const first=await claimSyncJob(env);await ack(env,first);
  env.sqlite.prepare('UPDATE reservations SET start_min=660,end_min=780 WHERE code=?').run(row.code);
  await reconcileAdminReservations(env);
  const next=await claimSyncJob(env);
  assert.equal(next.action,'block');
  assert.deepEqual(next.replaces,bookingSegments(first));
  assert.equal(links(env).find(l=>l.sync_code===first.code).state,'blocked');
  await ack(env,next);await reconcileAdminReservations(env);
  const release=await claimSyncJob(env);
  assert.equal(release.code,first.code);assert.equal(release.action,'release');
  await ack(env,release);await reconcileAdminReservations(env);
  assert.equal(await claimSyncJob(env),null);
  assert.equal((await adminReservationSyncStatus(env,[row]))[0].spacecloud_sync.state,'blocked');
});

test('cancel during a leased creation and delete preserve the immutable release target',async()=>{
  for(const remove of ['cancel','delete']) {
    const env=await fixture(),row=insert(env);
    await reconcileAdminReservations(env);const job=await claimSyncJob(env);
    env.sqlite.prepare(remove==='cancel'?"UPDATE reservations SET status='cancelled' WHERE code=?":'DELETE FROM reservations WHERE code=?').run(row.code);
    await reconcileAdminReservations(env);
    await ack(env,job);await reconcileAdminReservations(env);
    const release=await claimSyncJob(env);
    assert.equal(release.action,'release');assert.equal(release.code,job.code);
    await ack(env,release);await reconcileAdminReservations(env);
    assert.equal(links(env)[0].state,'released');assert.equal(await claimSyncJob(env),null);
  }
});

test('rapid edits coalesce unstarted versions and restoring a cancelled reservation gets a new marker',async()=>{
  const env=await fixture(),row=insert(env);
  await reconcileAdminReservations(env);const old=links(env)[0].sync_code;
  env.sqlite.prepare('UPDATE reservations SET start_min=780,end_min=840 WHERE code=?').run(row.code);
  await reconcileAdminReservations(env);
  const job=await claimSyncJob(env);
  assert.notEqual(job.code,old);assert.equal(links(env).find(l=>l.sync_code===old).state,'released');
  await ack(env,job);
  env.sqlite.prepare("UPDATE reservations SET status='cancelled' WHERE code=?").run(row.code);
  await reconcileAdminReservations(env);await ack(env,await claimSyncJob(env));
  env.sqlite.prepare("UPDATE reservations SET status='confirmed' WHERE code=?").run(row.code);
  await reconcileAdminReservations(env);
  const restored=await claimSyncJob(env);assert.notEqual(restored.code,job.code);
});

test('a conflicting new version retains the original external coverage and is visible for review',async()=>{
  const env=await fixture(),row=insert(env);
  await reconcileAdminReservations(env);const old=await claimSyncJob(env);await ack(env,old);
  env.sqlite.prepare('UPDATE reservations SET start_min=780,end_min=900 WHERE code=?').run(row.code);
  await reconcileAdminReservations(env);const next=await claimSyncJob(env);await ack(env,next,'conflict');
  await reconcileAdminReservations(env);
  assert.equal((await getSync(env,old.code)).state,'blocked');
  assert.equal(await claimSyncJob(env),null);
  assert.equal((await adminReservationSyncStatus(env,[row]))[0].spacecloud_sync.state,'review');
});

test('30-minute inputs retain their local times and conservatively cover enclosing full hours including 24h midnight spans',async()=>{
  const env=await fixture(),row=insert(env,{start_min:30,end_min:1470});
  await reconcileAdminReservations(env);const job=await claimSyncJob(env);
  assert.equal(job.start_min,0);assert.equal(job.end_min,1500);assert.equal(planJob(job).segments.length,2);
  assert.equal(env.sqlite.prepare('SELECT start_min FROM reservations').get().start_min,30);
  assert.equal((await adminReservationSyncStatus(env,[row]))[0].spacecloud_sync.rounded,true);
});

test('normal admin create, update, cancel and deletion entry points enqueue work without a second ledger row',async()=>{
  const env=await fixture();
  const body={space:'r3',date:date(),start_min:600,end_min:720,customer_name:'운영 점검',amount:0,pay_method:'card_offline',pay_status:'unpaid',channel:'phone'};
  const created=await (await onRequestPost({request:request(body),env})).json();
  assert.equal(created.ok,true);assert.equal(created.item.spacecloud_sync.state,'pending');
  const first=await claimSyncJob(env);await ack(env,first);
  const changed=await (await onRequestPatch({request:request({...body,code:created.code,action:'update',start_min:660,end_min:780},'PATCH'),env})).json();
  assert.equal(changed.ok,true);assert.equal(changed.item.start_min,660);
  const next=await claimSyncJob(env);await ack(env,next);await reconcileAdminReservations(env);await ack(env,await claimSyncJob(env));
  const cancelled=await (await onRequestPatch({request:request({code:created.code,action:'cancel'},'PATCH'),env})).json();
  assert.equal(cancelled.ok,true);
  await ack(env,await claimSyncJob(env));
  const deleted=await onRequestDelete({request:request({code:created.code},'DELETE'),env});
  assert.equal(deleted.status,200);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
});

const owned=s=>({...s,name:s.marker,memo:memoFor(s),manual:true});
test('worker reschedules only independently verified old ownership and preserves unrelated conflicts',async()=>{
  const marker='SFWEB:BADM'+'a'.repeat(32);
  const old={date:date(),start_min:600,end_min:720,marker};
  const job={id:'admin-job',lease_token:'lease',action:'block',code:'BADM'+'b'.repeat(32),marker:'SFWEB:BADM'+'b'.repeat(32),room:'r3',date:date(),start_min:660,end_min:780,replaces:[old]};
  for(const impostor of [false,true]){
    const driver={records:[{...owned(old),memo:impostor?'다른 메모':memoFor(old)}],created:0,
      async openRoom(){},async recordsFor(){return [...this.records];},
      async createSegment(s){this.created++;this.records.push(owned(s));},async verifyPublic(){}};
    const result=await executeJob(job,driver,async()=>{});
    assert.equal(result.status,impostor?'conflict':'succeeded');assert.equal(driver.created,impostor?0:1);
  }
});
test('public preflight tolerates only verified old coverage while new hours must be free',async()=>{
  const ui=new SpacecloudUI(null,{}),segment={date:date(),start_min:660,end_min:780};
  const hours=Array(24).fill(true);hours[11]=false;
  ui.readPublicAvailability=async()=>({day_available:true,hours});
  ui.managedRecords=[owned({date:date(),start_min:600,end_min:720,marker:'old'})];
  await ui.assertPublicAvailable(segment);
  hours[12]=false;await assert.rejects(ui.assertPublicAvailable(segment));
});
test('a slow post-write result gets a bounded read-only check without recreating its marker',async()=>{
  const env=await fixture();insert(env);
  await reconcileAdminReservations(env);
  const first=await claimSyncJob(env);await ack(env,first,'review');
  await reconcileAdminReservations(env);
  const check=await claimSyncJob(env);
  assert.equal(check.action,'verify');assert.equal(check.code,first.code);
  await ack(env,check);await reconcileAdminReservations(env);
  assert.equal(links(env).length,1);
  assert.equal(await claimSyncJob(env),null);
});
