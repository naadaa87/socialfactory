import {sourceJobSummary,SOURCE_DELAYED_MS} from './spacecloud-source-sync.js';
const PRODUCTS={r1:140236,r2:140235,r3:140486,r4:140487,r5:140492};
const calendar=room=>PRODUCTS[room]?'https://partner.spacecloud.kr/reservation-calendar?space=82026&product='+PRODUCTS[room]:null;
const point=value=>{const p=typeof value==='string'?JSON.parse(value):value;return p?{space:p.space,date:p.date,start_min:p.start_min,end_min:p.end_min,title:p.title}:null;};
async function rows(env,sql,args=[]) {
 try{return (await env.DB.prepare(sql).bind(...args).all()).results||[];}
 catch(error){if(/no such table/.test(error.message))return [];throw error;}
}
// Read only: polling never leases work, resets a retry, or contacts SpaceCloud.
// Active work is independent of the displayed month and survives source deletion.
export async function readSyncAlerts(env,{now=Date.now()}={}) {
 const [sources,links]=await Promise.all([
  rows(env,"SELECT * FROM spacecloud_source_jobs WHERE state IN ('queued','leased','review') ORDER BY created_at,id"),
  rows(env,`SELECT l.sync_code,l.reservation_code,l.desired,l.room,l.date,l.original_start,l.original_end,
   b.state,b.updated_at,r.customer_name,
   COALESCE((SELECT MIN(created_at) FROM spacecloud_sync_jobs j WHERE j.booking_code=l.sync_code AND j.state IN ('queued','leased','review')),b.updated_at) created_at,
   COALESCE((SELECT MAX(attempts) FROM spacecloud_sync_jobs j WHERE j.booking_code=l.sync_code AND j.state IN ('queued','leased','review')),0) attempts
   FROM spacecloud_admin_links l JOIN spacecloud_blocks b ON b.code=l.sync_code
   LEFT JOIN reservations r ON r.code=l.reservation_code
   WHERE b.state IN ('pending','blocking','releasing','review') OR b.state='conflict' AND l.desired=1`)
 ]);
 const items=sources.map(row=>{
  const before=point(row.before_json),target=point(row.target_json),s=sourceJobSummary(row,now);
  return {...s,kind:'source',code:row.linked_code||row.source_code,action:row.action,before,target,source_url:calendar(row.result_space||row.source_space)};
 }).concat(links.map(row=>{
  const review=['review','conflict'].includes(row.state),delayed=now-row.created_at>=SOURCE_DELAYED_MS;
  return {id:row.sync_code,kind:'admin',code:row.reservation_code,action:row.desired?'update':'cancel',
   state:review?'review':'queued',attempts:row.attempts,created_at:row.created_at,updated_at:row.updated_at,
   needs_attention:review||delayed,retrying:false,next_retry_at:null,
   before:{space:row.room,date:row.date,start_min:row.original_start,end_min:row.original_end,title:row.customer_name||'삭제된 어드민 예약'},target:null,
   message:review?'스페이스클라우드 시간 확보·해제 결과를 확인해 주세요.':delayed?'스페이스클라우드 시간 확보·해제가 지연되고 있습니다.':'스페이스클라우드 시간 확보·해제를 처리 중입니다.',source_url:calendar(row.room)};
 }));
 const counts={pending:items.length,review:items.filter(r=>r.state==='review').length,
  delayed:items.filter(r=>r.needs_attention&&r.state!=='review').length,retrying:items.filter(r=>r.retrying).length};
 items.sort((a,b)=>Number(b.needs_attention)-Number(a.needs_attention)||a.created_at-b.created_at||a.id.localeCompare(b.id));
 return {ok:true,now,counts,items:items.slice(0,30),more:Math.max(0,items.length-30)};
}
