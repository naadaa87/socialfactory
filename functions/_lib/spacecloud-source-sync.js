import { randomToken, sha256Hex } from './auth.js';
import { isIsoDate, ROOM_KEYS } from './admin.js';
import { loadCalendarDisplay } from './spacecloud-display.js';
import { isCalendarLinked } from './spacecloud-links.js';

const ACTIVE="('queued','leased','review')";
const PRODUCTS={r1:140236,r2:140235,r3:140486,r4:140487,r5:140492};
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const prepared=new WeakMap();
export async function ensureSourceSync(env) {
 if(!prepared.has(env.DB)) {
  const task=env.DB.batch([
   env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_source_jobs (
    id TEXT PRIMARY KEY,source_code TEXT NOT NULL,linked_code TEXT,source_id TEXT NOT NULL,source_space TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('update','cancel')),before_json TEXT NOT NULL,target_json TEXT,
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','succeeded','review')),
    phase TEXT NOT NULL DEFAULT 'planned',result_id TEXT,result_space TEXT,
    lease_token TEXT,lease_until INTEGER,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
    message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`),
   env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_source_active ON spacecloud_source_jobs(source_space,source_id) WHERE state IN ${ACTIVE}`),
   env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sc_source_state ON spacecloud_source_jobs(state,retry_at,created_at)')
  ]);prepared.set(env.DB,task);task.catch(()=>prepared.delete(env.DB));
 }await prepared.get(env.DB);
}
export function sourceSnapshot(row) {
 if(typeof row?.source_manual_id!=='string'||!/^\d{1,20}$/.test(row.source_manual_id) || /^SFWEB:/.test(row.customer_name||''))return null;
 const start=row.source_manual_start,end=start+row.source_manual_duration;
 if(!ROOM_KEYS.includes(row.space)||!isIsoDate(row.source_manual_date)||!Number.isInteger(start)||!Number.isInteger(end)
  ||start<0||start>=1440||start%60||end%60||end<=start||end-start>1440)return null;
 return {id:row.source_manual_id,space:row.space,date:row.source_manual_date,start_min:start,end_min:end,title:row.customer_name};
}
export const sourceVersion=source=>sha256Hex(JSON.stringify(source));
function matchingSource(row,sources,jobs=[]) {
 if(sourceSnapshot(row))return row;
 if(!isCalendarLinked(row))return null;
 const candidates=sources.filter(e=>sourceSnapshot(e) && (e.code===row.code || e.space===row.space && e.date===row.date
  &&e.start_min===row.start_min&&e.end_min===row.end_min&&e.customer_name===row.customer_name));
 if(candidates.length===1)return candidates[0];
 if(!candidates.length) {
  const tracked=jobs.find(j=>j.state==='succeeded'&&j.action==='update'&&(j.linked_code===row.code||j.source_code===row.code));
  const found=tracked?sources.filter(e=>e.space===tracked.result_space&&e.source_manual_id===tracked.result_id):[];
  if(found.length===1)return found[0];
 }
 return null;
}
const summary=row=>({id:row.id,state:row.state,phase:row.phase,message:row.message||
 (row.state==='succeeded'?'스페이스클라우드 원본 반영 완료':row.state==='review'?'스페이스클라우드 원본 확인 필요':'스페이스클라우드 원본 변경을 처리 중입니다.')});
export async function attachSourceSync(env,rows,sources=[]) {
 if(!rows.length)return rows;
 let jobs=[];
 if(rows.concat(sources).some(sourceSnapshot)) {
  await ensureSourceSync(env);
  jobs=(await env.DB.prepare("SELECT * FROM spacecloud_source_jobs ORDER BY CASE state WHEN 'queued' THEN 0 WHEN 'leased' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1000").all()).results||[];
 }
 return Promise.all(rows.map(async row=>{
  const origin=matchingSource(row,sources,jobs),source=origin&&sourceSnapshot(origin);
  const bySlot=sources.filter(e=>e.space===row.space&&e.date===row.date&&e.start_min===row.start_min&&e.end_min===row.end_min&&e.customer_name===row.customer_name);
  const related=isCalendarLinked(row)&&(sources.find(e=>e.code===row.code)||(bySlot.length===1?bySlot[0]:null));
  const job=jobs.find(j=>j.source_code===row.code || j.linked_code===row.code || source &&
   (j.source_id===source.id&&j.source_space===source.space || j.result_id===source.id&&j.result_space===source.space));
  return {...row,...(related?.source_url?{source_url:related.source_url}:{}),...(source?{source_manual:{...source,version:await sourceVersion(source),
   calendar_url:'https://partner.spacecloud.kr/reservation-calendar?space=82026&product='+PRODUCTS[source.space]}}:{}),...(job?{source_sync:summary(job)}:{})};
 }));
}
export function readSourceTarget(body,before) {
 if(body.action==='cancel')return null;
 if(body.action!=='update')throw fail('source-action','변경 또는 취소 작업을 선택해 주세요.',400);
 const {space,date,start_min,end_min}=body;
 if(!ROOM_KEYS.includes(space)||!isIsoDate(date)||!Number.isInteger(start_min)||!Number.isInteger(end_min)
  ||start_min<0||start_min>=1440||start_min%60||end_min%60||end_min<=start_min||end_min>1440)
  throw fail('source-time','스페이스클라우드 수기 일정은 1시간 단위로 선택해 주세요.',400);
 return {space,date,start_min,end_min,title:before.title};
}
export async function enqueueSourceSync(env,body,{now=Date.now()}={}) {
 await ensureSourceSync(env);
 if(env.SPACECLOUD_SYNC_ENABLED!=='true')throw fail('source-disabled','클라우드 예약 연동 설정을 확인해 주세요.',503);
 if(!/^SC[1-5]-[a-f0-9]{16}$/.test(body.code||''))throw fail('source-code','스페이스클라우드 원본 일정 번호를 확인해 주세요.',400);
 const display=await loadCalendarDisplay(env,{});
 const local=await env.DB.prepare('SELECT * FROM reservations WHERE code=?1').bind(body.code).first();
 const aliases=local?(await env.DB.prepare("SELECT * FROM spacecloud_source_jobs WHERE state='succeeded' AND action='update' AND linked_code=?1 ORDER BY updated_at DESC,id DESC LIMIT 1").bind(local.code).all()).results||[]:[];
 const row=display.results.find(r=>r.code===body.code) || local&&matchingSource(local,display.results,aliases);
 const before=row&&sourceSnapshot(row);
 if(!before)throw fail('source-unavailable','수기 원본을 확인할 수 없습니다. 결제 예약은 스페이스클라우드에서 직접 처리해 주세요.');
 if(await sourceVersion(before)!==body.expected_version)throw fail('source-stale','원본 일정이 바뀌었습니다. 새로 불러온 뒤 다시 요청해 주세요.');
 const active=(await env.DB.prepare("SELECT source_code,linked_code,source_id,source_space,result_id,result_space,target_json FROM spacecloud_source_jobs WHERE state IN ('queued','leased','review')").all()).results||[];
 if(active.some(job=>{
  const moving=job.target_json?JSON.parse(job.target_json):null;
  return job.source_code===body.code||local&&job.linked_code===local.code||job.source_id===before.id&&job.source_space===before.space
   ||job.result_id===before.id&&job.result_space===before.space||moving&&moving.space===before.space&&moving.date===before.date
    &&moving.start_min===before.start_min&&moving.end_min===before.end_min&&moving.title===before.title;
 }))throw fail('source-busy','이 원본 일정의 변경을 처리 중입니다. 완료 후 다시 요청해 주세요.');
 const target=readSourceTarget(body,before);
 if(local&&target&&target.date!==local.date) {
  try {if(await env.DB.prepare('SELECT reservation_id FROM spacecloud_sales WHERE linked_code=?1').bind(local.code).first())
   throw fail('source-ledger-date','정산 매출과 연결된 예약입니다. 이용일 변경 전 정산 원본을 확인해 주세요.');}
  catch(error){if(!/no such table/.test(error.message))throw error;}
 }
 if(target && target.date.slice(0,7)>='2029-10')throw fail('source-range','원본 대조가 지원하는 날짜 범위를 벗어났습니다.');
 if(target && Date.parse(target.date+'T00:00:00+09:00')+target.end_min*60000<=now)
  throw fail('source-past','이용이 끝난 시간으로 원본 일정을 변경할 수 없습니다.');
 if(target) {
  const absolute=r=>Date.parse(r.date+'T00:00:00+09:00')+r.start_min*60000;
  const start=absolute(target),end=start+(target.end_min-target.start_min)*60000;
  const all=(await env.DB.prepare("SELECT code,status,space,date,start_min,end_min,customer_name FROM reservations WHERE status='confirmed' AND date BETWEEN date(?1,'-1 day') AND date(?1,'+1 day')").bind(target.date).all()).results||[];
  const hit=display.results.concat(all).some(r=>r.space===target.space && r.code!==body.code && r.code!==local?.code &&
   !(r.source_manual_id===before.id&&r.space===before.space) && absolute(r)<end && start<absolute(r)+(r.end_min-r.start_min)*60000);
  if(hit)throw fail('source-conflict','변경할 시간에 다른 예약이 있습니다. 원본을 변경하지 않았습니다.');
 }
 const linked=local&&isCalendarLinked(local)?local.code:null,id=randomToken(18);
 try {
  await env.DB.prepare(`INSERT INTO spacecloud_source_jobs(id,source_code,linked_code,source_id,source_space,action,before_json,target_json,created_at,updated_at)
   VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`).bind(id,body.code,linked,before.id,before.space,body.action,JSON.stringify(before),target?JSON.stringify(target):null,now).run();
 }catch(error){if(/UNIQUE/i.test(error.message))throw fail('source-busy','이 원본 일정의 다른 변경을 처리 중입니다. 완료 후 다시 요청해 주세요.');throw error;}
 return {ok:true,job:summary({id,state:'queued',phase:'planned'})};
}
export async function claimSourceSync(env,{now=Date.now()}={}) {
 await ensureSourceSync(env);
 const waiting=await env.DB.prepare("SELECT id FROM spacecloud_source_jobs WHERE state='queued' AND retry_at<=?1 OR state='leased' AND lease_until<=?1 LIMIT 1").bind(now).first();
 if(!waiting)return null;
 // Reclaiming retains the write checkpoint. The executor must verify an uncertain
 // creation rather than submitting it twice.
 await env.DB.prepare("UPDATE spacecloud_source_jobs SET state='queued',lease_token=NULL WHERE state='leased' AND lease_until<=?1").bind(now).run();
 const token=randomToken(24);
 await env.DB.prepare(`UPDATE spacecloud_source_jobs SET state='leased',lease_token=?1,lease_until=?2,attempts=attempts+1,updated_at=?3
  WHERE id=(SELECT id FROM spacecloud_source_jobs WHERE state='queued' AND retry_at<=?3 ORDER BY created_at,id LIMIT 1)`)
  .bind(token,now+120000,now).run();
 const job=await env.DB.prepare('SELECT * FROM spacecloud_source_jobs WHERE lease_token=?1').bind(token).first();
 return job?{id:job.id,lease_token:token,action:job.action,before:JSON.parse(job.before_json),target:job.target_json?JSON.parse(job.target_json):null,
  phase:job.phase,result_id:job.result_id,result_space:job.result_space}:null;
}
export async function checkpointSourceSync(env,body,{now=Date.now()}={}) {
 await ensureSourceSync(env);
 const job=await env.DB.prepare("SELECT * FROM spacecloud_source_jobs WHERE id=?1 AND lease_token=?2 AND state='leased' AND lease_until>?3")
  .bind(body.id,body.lease_token,now).first();
 if(!job)throw fail('source-lease','원본 변경 작업의 처리 권한이 만료됐습니다.');
 const target=job.target_json?JSON.parse(job.target_json):null;
 const phases={planned:[job.action==='cancel'?'deleting':target.space===job.source_space?'writing':'creating'],creating:['created'],created:['deleting'],writing:[],deleting:[]};
 if(body.action==='checkpoint') {
  if(!phases[job.phase]?.includes(body.phase))throw fail('source-phase','원본 처리 순서를 확인해 주세요.');
  if(body.phase==='created' && (!/^\d{1,20}$/.test(body.result_id||'') || !ROOM_KEYS.includes(body.result_space)))throw fail('source-receipt','새 원본 일정 번호를 확인해 주세요.');
  if(body.phase==='created'&&body.result_space!==target?.space)throw fail('source-receipt','새 원본의 룸이 일치하지 않습니다.');
  await env.DB.prepare(`UPDATE spacecloud_source_jobs SET phase=?3,result_id=COALESCE(?4,result_id),result_space=COALESCE(?5,result_space),updated_at=?6 WHERE id=?1 AND lease_token=?2`)
   .bind(job.id,body.lease_token,body.phase,body.phase==='created'?body.result_id:null,body.phase==='created'?body.result_space:null,now).run();
  return {ok:true};
 }
 if(body.action==='finish') {
  if(!['succeeded','review','retry'].includes(body.state))throw fail('source-result','원본 처리 결과를 확인해 주세요.');
  if(body.state==='succeeded') {
   const before=JSON.parse(job.before_json),target=job.target_json?JSON.parse(job.target_json):null;
   const resultId=target?.space===before.space?before.id:job.result_id;
   const expectedPhase=job.action==='cancel'||target?.space!==before.space?'deleting':'writing';
   if(job.phase!==expectedPhase || job.action==='update' && (!target||!/^\d{1,20}$/.test(resultId||'')))throw fail('source-receipt','원본 확인을 완료하지 않았습니다.');
   const writes=[];
   if(job.linked_code)writes.push(job.action==='cancel'
    ?env.DB.prepare("UPDATE reservations SET status='cancelled',cancelled_at=datetime('now','+9 hours'),cancel_reason='스페이스클라우드 수기 원본 취소',updated_at=datetime('now','+9 hours') WHERE code=?1 AND channel='spacecloud'").bind(job.linked_code)
    :env.DB.prepare("UPDATE reservations SET space=?2,date=?3,start_min=?4,end_min=?5,customer_name=?6,updated_at=datetime('now','+9 hours') WHERE code=?1 AND channel='spacecloud'")
     .bind(job.linked_code,target.space,target.date,target.start_min,target.end_min,target.title));
   writes.push(env.DB.prepare("UPDATE spacecloud_source_jobs SET state='succeeded',message=NULL,result_id=?3,result_space=?4,updated_at=?5 WHERE id=?1 AND lease_token=?2")
    .bind(job.id,body.lease_token,job.action==='cancel'?null:resultId,target?.space||before.space,now));
   await env.DB.batch(writes);
   // Refresh source occupancy independently; financial totals were never added or
   // removed by the worker. A schedule cancellation is not a refund transaction.
   await env.DB.prepare('UPDATE spacecloud_host_calendar_state SET requested_at=?1 WHERE id=1').bind(now).run();
   return {ok:true};
  }
  const reasons={'source-conflict':'변경할 시간에 다른 예약이 있습니다. 원본은 유지했습니다.',
   'source-stale':'다른 곳에서 원본을 변경했습니다. 최신 원본을 확인해 주세요.',
   'source-creation-uncertain':'새 룸의 등록 결과를 확인하지 못했습니다. 중복 등록하지 않고 보류했습니다.',
   'source-ambiguous':'동일한 원본이 여러 건 있어 자동 변경을 보류했습니다.'};
  const message=body.state==='retry'?'스페이스클라우드 연결을 재시도합니다.':reasons[body.error]||'원본이 바뀌었거나 처리 결과 확인이 필요합니다. 중복 실행하지 않고 보류했습니다.';
  await env.DB.prepare(`UPDATE spacecloud_source_jobs SET state=?3,retry_at=?4,message=?5,updated_at=?6 WHERE id=?1 AND lease_token=?2`)
   .bind(job.id,body.lease_token,body.state==='retry'?'queued':'review',now+Math.max(60000,Math.min(86400000,Number(body.retry_after_ms)||60000)),message,now).run();
  return {ok:true};
 }
 throw fail('source-action','지원하지 않는 원본 처리 요청입니다.',400);
}

export async function retrySourceSync(env,id) {
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(id))throw fail('source-code','원본 작업 번호를 확인해 주세요.',400);
 await ensureSourceSync(env);
 const result=await env.DB.prepare("UPDATE spacecloud_source_jobs SET state='queued',retry_at=0,message=NULL,updated_at=?2 WHERE id=?1 AND state='review'").bind(id,Date.now()).run();
 if(!result.meta?.changes)throw fail('source-state','이미 처리 중이거나 완료된 요청입니다.');
 return {ok:true,job:summary({id,state:'queued'})};
}

export async function guardSourcePaymentRegistration(env,code) {
 try {if(await env.DB.prepare("SELECT id FROM spacecloud_source_jobs WHERE source_code=?1 AND state IN ('queued','leased','review') LIMIT 1").bind(code).first())
  throw fail('source-busy','원본 변경이 완료된 뒤 결제금액을 등록해 주세요.');}
 catch(error){if(!/no such table/.test(error.message))throw error;}
}

export async function guardImportedScheduleChange(env,prev,body) {
 if(!isCalendarLinked(prev))return;
 const scheduleChanged=body.action==='cancel'||body.action==='restore'||body.action==='delete'||body.action==='update'&&
  (body.space!==prev.space||body.date!==prev.date||Number(body.start_min)!==prev.start_min||Number(body.end_min)!==prev.end_min
   ||body.customer_name!==prev.customer_name||body.channel!==prev.channel);
 if(!scheduleChanged)return;
 if(body.action==='update'&&body.customer_name===prev.customer_name&&body.channel===prev.channel) {
  // Preserve the existing no-charge ledger repair after the source itself has
  // already moved. This acknowledgement never modifies a SpaceCloud booking.
  const display=await loadCalendarDisplay(env,{});
  if(!display.results.some(r=>r.code===prev.code)) {
   const moved=display.results.filter(r=>r.code?.slice(4)===prev.code.slice(4)&&r.space===body.space&&r.date===body.date
    &&r.start_min===Number(body.start_min)&&r.end_min===Number(body.end_min)&&r.customer_name===prev.customer_name);
   if(moved.length===1)return;
  }
 }
 throw fail('source-original-required','스페이스클라우드 일정입니다. 예약 상세의 원본 일정 관리에서 변경·취소해 주세요. 결제 예약은 스페이스클라우드에서 직접 확정해야 합니다.');
}
