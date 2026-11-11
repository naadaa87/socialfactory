import { ensureSyncSchema, syncEnabled } from './booking-spacecloud-sync.js';

// Immutable versions own separate markers. The saved source survives failed
// HTTP responses, concurrent edits and deletion during an external write.
const direct = a => `${a}.space IN ('r1','r2','r3','r4','r5')
  AND COALESCE(${a}.channel,'')<>'spacecloud' AND ${a}.code NOT LIKE 'SC%'
  AND NOT EXISTS(SELECT 1 FROM booking_requests w WHERE w.code=${a}.code)`;
const current = `EXISTS(SELECT 1 FROM reservations r WHERE r.code=l.reservation_code
  AND r.status='confirmed' AND ${direct('r')}
  AND r.space=l.room AND r.date=l.date AND r.start_min=l.original_start AND r.end_min=l.original_end)`;
const mayRelease = `NOT EXISTS(SELECT 1 FROM spacecloud_admin_links n JOIN spacecloud_blocks b ON b.code=n.sync_code
  WHERE n.reservation_code=l.reservation_code AND n.desired=1 AND b.state<>'blocked')`;

export async function reconcileAdminReservations(env) {
  if (!syncEnabled(env)) return;
  await ensureSyncSchema(env);
  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE spacecloud_admin_links AS l SET desired=0 WHERE desired=1 AND NOT (${current})`),
    env.DB.prepare(`INSERT INTO spacecloud_admin_links
      (sync_code,reservation_code,room,date,original_start,original_end,desired,created_at)
      SELECT 'BADM'||lower(hex(randomblob(16))),r.code,r.space,r.date,r.start_min,r.end_min,1,?1
      FROM reservations r WHERE r.status='confirmed' AND ${direct('r')}
      AND (CAST(strftime('%s',r.date) AS INTEGER)-32400+r.end_min*60)*1000>?1
      AND NOT EXISTS(SELECT 1 FROM spacecloud_admin_links l WHERE l.reservation_code=r.code AND l.desired=1)`).bind(now),
    env.DB.prepare(`INSERT INTO spacecloud_blocks
      (code,room,date,start_min,end_min,marker,access_token,created_at,updated_at)
      SELECT l.sync_code,l.room,l.date,(l.original_start/60)*60,((l.original_end+59)/60)*60,
        'SFWEB:'||l.sync_code,lower(hex(randomblob(24))),?1,?1 FROM spacecloud_admin_links l
      WHERE NOT EXISTS(SELECT 1 FROM spacecloud_blocks b WHERE b.code=l.sync_code)`).bind(now),
    // Superseded, never-leased versions have no external side effects.
    env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state='cancelled',updated_at=?1
      WHERE state='queued' AND action IN ('block','verify') AND booking_code IN
      (SELECT l.sync_code FROM spacecloud_admin_links l WHERE l.desired=0)`).bind(now),
    env.DB.prepare(`UPDATE spacecloud_blocks SET state='released',cancel_requested=1,updated_at=?1
      WHERE state='pending' AND code IN(SELECT sync_code FROM spacecloud_admin_links WHERE desired=0)
      AND NOT EXISTS(SELECT 1 FROM spacecloud_sync_jobs j WHERE j.booking_code=spacecloud_blocks.code AND j.attempts>0)`).bind(now),
    env.DB.prepare(`INSERT INTO spacecloud_sync_jobs(id,booking_code,room,action,created_at,updated_at)
      SELECT lower(hex(randomblob(18))),l.sync_code,l.room,'block',?1,?1
      FROM spacecloud_admin_links l JOIN spacecloud_blocks b ON b.code=l.sync_code
      WHERE l.desired=1 AND b.state='pending' AND NOT EXISTS
      (SELECT 1 FROM spacecloud_sync_jobs j WHERE j.booking_code=l.sync_code AND j.state IN ('queued','leased','review'))`).bind(now),
    // New coverage must be verified before old coverage can be released.
    env.DB.prepare(`UPDATE spacecloud_blocks SET cancel_requested=1,state='releasing',verified_at=NULL,updated_at=?1
      WHERE state IN ('pending','blocking','blocked') AND code IN
      (SELECT l.sync_code FROM spacecloud_admin_links l WHERE l.desired=0 AND ${mayRelease})`).bind(now),
    env.DB.prepare(`INSERT INTO spacecloud_sync_jobs(id,booking_code,room,action,created_at,updated_at)
      SELECT lower(hex(randomblob(18))),l.sync_code,l.room,'release',?1,?1
      FROM spacecloud_admin_links l JOIN spacecloud_blocks b ON b.code=l.sync_code
      WHERE l.desired=0 AND b.state='releasing' AND ${mayRelease} AND NOT EXISTS
      (SELECT 1 FROM spacecloud_sync_jobs j WHERE j.booking_code=l.sync_code AND j.action='release' AND j.state IN ('queued','leased','review'))`).bind(now)
  ]);
  const {results}=await env.DB.prepare(`SELECT l.reservation_code AS code,l.room,l.date,
    b.start_min,b.end_min,l.desired,b.state,b.error FROM spacecloud_admin_links l
    JOIN spacecloud_blocks b ON b.code=l.sync_code ORDER BY l.created_at,l.sync_code LIMIT 1000`).all();
  return results || [];
}

export async function adminReservationSyncStatus(env, rows) {
  if (!rows.length || !syncEnabled(env)) return rows;
  await ensureSyncSchema(env);
  const {results}=await env.DB.prepare(`SELECT l.*,b.state,b.error,b.start_min,b.end_min
    FROM spacecloud_admin_links l JOIN spacecloud_blocks b ON b.code=l.sync_code
    WHERE l.reservation_code IN (SELECT value FROM json_each(?1)) ORDER BY l.created_at,l.sync_code`)
    .bind(JSON.stringify(rows.map(row=>row.code))).all();
  const groups=new Map();
  for(const link of results || []) {
    if(!groups.has(link.reservation_code))groups.set(link.reservation_code,[]);
    groups.get(link.reservation_code).push(link);
  }
  return rows.map(row=>{
    const links=groups.get(row.code);
    if(!links)return row;
    const active=links.find(link=>link.desired);
    const unfinished=links.filter(link=>!['released','conflict'].includes(link.state));
    const problem=links.find(link=>link.state==='review' || (link.desired && link.state==='conflict'));
    const pending=unfinished.some(link=>!link.desired || link.state!=='blocked');
    const state=problem?'review':pending?'pending':active?.state==='blocked'?'blocked':'released';
    const rounded=!!active && (active.original_start!==active.start_min || active.original_end!==active.end_min);
    return {...row,spacecloud_sync:{state,rounded,message:problem
      ? '스페이스클라우드 일정 확인 필요. '+(problem.error || '다른 예약과 겹치는지 확인해 주세요.')
      :state==='pending'?'스페이스클라우드 시간 변경·차단·해제를 처리 중입니다.'
      :state==='blocked'?'스페이스클라우드 시간 확보 완료'+(rounded?' · 30분 단위 예약은 앞뒤 정시까지 확보합니다.':'')
      :'스페이스클라우드 시간 해제 완료'}};
  });
}
