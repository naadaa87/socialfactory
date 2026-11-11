import { clean, randomToken, safeEqual } from './auth.js';

const LEASE_MS = 120000;
const REVIEW_HOLD = "('pending','blocking','blocked','releasing','review')";
const absolute = (a, field) => `(CAST(strftime('%s', ${a}.date) AS INTEGER) / 60 + ${a}.${field})`;
const overlaps = (a,b) => `${absolute(a,'start_min')} < ${absolute(b,'end_min')} AND ${absolute(b,'start_min')} < ${absolute(a,'end_min')}`;
export const SYNC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spacecloud_admin_links (
    sync_code TEXT PRIMARY KEY, reservation_code TEXT NOT NULL,room TEXT NOT NULL,date TEXT NOT NULL,
    original_start INTEGER NOT NULL,original_end INTEGER NOT NULL,
    desired INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_admin_desired ON spacecloud_admin_links(reservation_code) WHERE desired=1`,
  `CREATE INDEX IF NOT EXISTS idx_sc_admin_parent ON spacecloud_admin_links(reservation_code)`,
  `DROP TRIGGER IF EXISTS sc_reservation_hold_insert`,
  `DROP TRIGGER IF EXISTS sc_reservation_hold_update`,
  `CREATE TABLE IF NOT EXISTS spacecloud_payment_checks (code TEXT PRIMARY KEY, after_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS spacecloud_blocks (
    code TEXT PRIMARY KEY, room TEXT NOT NULL, date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
    marker TEXT NOT NULL UNIQUE, access_token TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','blocking','blocked','releasing','released','review','conflict')),
    cancel_requested INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, verified_at INTEGER,
    error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS spacecloud_sync_jobs (
    id TEXT PRIMARY KEY, booking_code TEXT NOT NULL, room TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('block','verify','release')),
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','succeeded','conflict','review','cancelled')),
    lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_active_job ON spacecloud_sync_jobs (booking_code,action) WHERE state IN ('queued','leased')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_room_lease ON spacecloud_sync_jobs (room) WHERE state='leased'`,
  `CREATE INDEX IF NOT EXISTS idx_sc_jobs_state ON spacecloud_sync_jobs (state,created_at)`,
  `CREATE TABLE IF NOT EXISTS spacecloud_worker_calendar (
    room TEXT NOT NULL, date TEXT NOT NULL, events_json TEXT NOT NULL, checked_at INTEGER NOT NULL,
    PRIMARY KEY(room,date)
  )`,
  ...['INSERT','UPDATE'].map(action => `CREATE TRIGGER IF NOT EXISTS sc_booking_hold_${action.toLowerCase()}
    BEFORE ${action} ON booking_requests WHEN NEW.status IN ('requested','awaiting_payment','confirmed','payment_review')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND b.room=NEW.room AND b.state IN ${REVIEW_HOLD} AND ${overlaps('b','NEW')})
      THEN RAISE(ABORT,'booking-conflict') END; END`),
  ...['INSERT','UPDATE'].map(action => `CREATE TRIGGER IF NOT EXISTS sc_reservation_hold_v2_${action.toLowerCase()}
    BEFORE ${action} ON reservations WHEN NEW.status='confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND NOT EXISTS(SELECT 1 FROM spacecloud_admin_links l WHERE l.sync_code=b.code AND l.reservation_code=NEW.code)
      AND b.room=NEW.space AND b.state IN ${REVIEW_HOLD} AND ${overlaps('b','NEW')})
      THEN RAISE(ABORT,'booking-conflict') END; END`)
];

const prepared = new WeakMap();
export async function ensureSyncSchema(env) {
  if (!env.DB) throw syncError('sync-not-ready','예약 데이터베이스 연결을 확인해 주세요.',503);
  if (!prepared.has(env.DB)) {
    const task = env.DB.batch(SYNC_SCHEMA.map(sql => env.DB.prepare(sql)));
    prepared.set(env.DB,task); task.catch(() => prepared.delete(env.DB));
  }
  await prepared.get(env.DB);
}
export const syncEnabled = env => env.SPACECLOUD_SYNC_ENABLED === 'true';
export const syncError = (code,message,status=409) => Object.assign(new Error(message),{code,status});
export function workerAuthorized(request,env) {
  const token = String(env.SPACECLOUD_WORKER_TOKEN || '');
  const supplied = request.headers.get('authorization') || '';
  return token.length >= 32 && supplied.startsWith('Bearer ') && safeEqual(supplied.slice(7),token);
}
const isoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===value;
};
const nextDate = value => new Date(Date.parse(value+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function bookingSegments(booking) {
  if (!/^r[1-5]$/.test(booking?.room) || !isoDate(booking.date) || !Number.isInteger(booking.start_min)
    || !Number.isInteger(booking.end_min) || booking.start_min < 0 || booking.start_min >= 1440
    || booking.end_min <= booking.start_min || booking.end_min-booking.start_min > (/^BADM[a-f0-9]{32}$/.test(booking.code || '')?1500:1440)
    || booking.start_min%60 || booking.end_min%60)
    throw syncError('sync-time-step','스페이스클라우드 자동 연동 예약은 1시간 단위로 선택해 주세요.',400);
  const marker = 'SFWEB:'+booking.code;
  const segments = [{date:booking.date,start_min:booking.start_min,end_min:Math.min(1440,booking.end_min),marker}];
  if (booking.end_min > 1440) segments.push({date:nextDate(booking.date),start_min:0,end_min:booking.end_min-1440,marker});
  return segments;
}
const unpack = row => {
  if (!row) return null;
  let receipt=null; try { receipt=JSON.parse(row.receipt_json || 'null'); } catch {}
  return {...row,receipt,segments:bookingSegments(row)};
};
export async function getSync(env,code) {
  await ensureSyncSchema(env);
  return unpack(await env.DB.prepare('SELECT * FROM spacecloud_blocks WHERE code=?1').bind(code).first());
}
const sameScope = (a,b) => a.room===b.room && a.date===b.date && a.start_min===b.start_min && a.end_min===b.end_min;
export async function enqueueSync(env,booking,action='block') {
  if (!syncEnabled(env)) throw syncError('sync-disabled','예약 자동 연동이 준비되지 않았습니다.',503);
  if (String(env.SPACECLOUD_WORKER_TOKEN || '').length<32) throw syncError('sync-not-configured','예약 연동 작업자 연결을 먼저 설정해 주세요.',503);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(booking?.code || '') || !['block','verify','release'].includes(action)) throw syncError('sync-invalid','예약 연동 정보를 확인해 주세요.',400);
  bookingSegments(booking);
  await ensureSyncSchema(env);
  const now=Date.now();
  await env.DB.prepare(`INSERT INTO spacecloud_blocks (code,room,date,start_min,end_min,marker,access_token,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8) ON CONFLICT(code) DO NOTHING`)
    .bind(booking.code,booking.room,booking.date,booking.start_min,booking.end_min,'SFWEB:'+booking.code,randomToken(),now).run();
  const current=await getSync(env,booking.code);
  if (!sameScope(current,booking)) throw syncError('sync-scope','연동된 예약의 시간은 변경할 수 없습니다. 취소 후 다시 신청해 주세요.');
  if (current.state==='review') throw syncError('sync-review','외부 예약 처리 결과를 담당자가 확인하고 있습니다.');
  if (action==='block' && ['blocked','releasing','released','conflict'].includes(current.state)) return current;
  if (action==='verify' && (current.state!=='blocked' || current.cancel_requested)) throw syncError('sync-not-ready','외부 예약 시간 확보를 확인하고 있습니다.');
  if (action==='release' && current.state==='released') return current;
  const statements=[];
  if (action==='release') {
    statements.push(env.DB.prepare(`UPDATE spacecloud_blocks SET cancel_requested=1,state='releasing',verified_at=NULL,updated_at=?2 WHERE code=?1`).bind(booking.code,now));
    statements.push(env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state='cancelled',updated_at=?2 WHERE booking_code=?1 AND state='queued' AND action<>'release'`).bind(booking.code,now));
  }
  statements.push(env.DB.prepare(`INSERT INTO spacecloud_sync_jobs (id,booking_code,room,action,created_at,updated_at)
    SELECT ?1,?2,?3,?4,?5,?5 WHERE NOT EXISTS (SELECT 1 FROM spacecloud_sync_jobs WHERE booking_code=?2 AND action=?4 AND state IN ('queued','leased'))`)
    .bind(randomToken(18),booking.code,booking.room,action,now));
  if (action==='verify') statements.push(env.DB.prepare('UPDATE spacecloud_blocks SET verified_at=NULL,updated_at=?2 WHERE code=?1').bind(booking.code,now));
  await env.DB.batch(statements);
  return getSync(env,booking.code);
}
export const queueRelease = (env,booking) => enqueueSync(env,booking,'release');

function validateReceipt(receipt,block,action) {
  if (!receipt || !sameScope(receipt,block) || receipt.marker!==block.marker || !Array.isArray(receipt.segments)) return false;
  const expected=bookingSegments(block);
  if (receipt.segments.length!==expected.length || !expected.every((e,i)=>{
    const r=receipt.segments[i]; return r && r.date===e.date && r.start_min===e.start_min && r.end_min===e.end_min && r.marker===e.marker;
  })) return false;
  return action==='release' ? receipt.verified_released===true : receipt.verified_blocked===true && receipt.no_conflicts===true;
}
export async function requireVerifiedBlock(env,booking,{maxAgeMs=30000}={}) {
  if (!syncEnabled(env)) throw syncError('sync-disabled','예약 자동 연동이 준비되지 않았습니다.',503);
  const block=await getSync(env,booking.code),now=Date.now();
  if (!block || !sameScope(block,booking) || block.state!=='blocked' || block.cancel_requested
    || !validateReceipt(block.receipt,block,'block') || !Number.isFinite(block.verified_at)
    || block.verified_at>now || now-block.verified_at>Math.max(0,Math.min(maxAgeMs,30000)))
    throw syncError('sync-not-ready','스페이스클라우드 최신 일정과 시간 확보를 확인하고 있습니다. 잠시 후 다시 진행해 주세요.');
  return block;
}

async function quarantineExpired(env,now) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE spacecloud_blocks SET state='review',verified_at=NULL,error='연동 작업자 응답 지연: 외부 처리 여부 확인 필요',updated_at=?1
      WHERE code IN (SELECT booking_code FROM spacecloud_sync_jobs WHERE state='leased' AND lease_until<=?1)`).bind(now),
    env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state='review',updated_at=?1 WHERE state='leased' AND lease_until<=?1`).bind(now)
  ]);
}
export async function claimSyncJob(env) {
  await ensureSyncSchema(env);
  const now=Date.now(); await quarantineExpired(env,now);
  // The partial unique index is the final arbiter when two worker polls race.
  const token=randomToken(),until=now+LEASE_MS;
  try {
    await env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state='leased',lease_token=?1,lease_until=?2,attempts=attempts+1,updated_at=?3
      WHERE id=(SELECT j.id FROM spacecloud_sync_jobs j JOIN spacecloud_blocks b ON b.code=j.booking_code
        WHERE j.state='queued' AND b.state NOT IN ('review','released','conflict')
        AND NOT EXISTS (SELECT 1 FROM spacecloud_sync_jobs l WHERE l.room=j.room AND l.state IN ('leased','review'))
        ORDER BY CASE j.action WHEN 'release' THEN 0 WHEN 'verify' THEN 1 ELSE 2 END,CASE WHEN j.booking_code LIKE 'BADM%' THEN 1 ELSE 0 END,j.created_at,j.id LIMIT 1)
        AND state='queued'`).bind(token,until,now).run();
  } catch(error) {
    if (/UNIQUE.*spacecloud_sync_jobs.room/i.test(String(error?.message))) return null;
    throw error;
  }
  const job=await env.DB.prepare("SELECT * FROM spacecloud_sync_jobs WHERE lease_token=?1 AND state='leased'").bind(token).first();
  if (!job) return null;
  const block=await getSync(env,job.booking_code);
  if (job.action==='block') await env.DB.prepare("UPDATE spacecloud_blocks SET state=CASE WHEN cancel_requested=1 THEN 'releasing' ELSE 'blocking' END,updated_at=?2 WHERE code=?1 AND state<>'review'").bind(block.code,now).run();
  return {id:job.id,job_id:job.id,lease_token:token,lease_until:until,action:job.action,code:block.code,
    room:block.room,date:block.date,start_min:block.start_min,end_min:block.end_min,marker:block.marker,segments:block.segments,replaces:job.action!=='release'?await adminReplacements(env,block):[]};
}
async function adminReplacements(env,block) {
  const {results}=await env.DB.prepare(`SELECT b.* FROM spacecloud_admin_links own
    JOIN spacecloud_admin_links old ON old.reservation_code=own.reservation_code AND old.sync_code<>own.sync_code
    JOIN spacecloud_blocks b ON b.code=old.sync_code
    WHERE own.sync_code=?1 AND old.desired=0 AND b.room=?2 AND b.state IN ('blocked','blocking','releasing')`)
    .bind(block.code,block.room).all();
  return (results || []).flatMap(row=>bookingSegments(row));
}
async function leasedJob(env,body,{allowComplete=false}={}) {
  const id=clean(body?.job_id,100),token=clean(body?.lease_token,100);
  const job=await env.DB.prepare('SELECT * FROM spacecloud_sync_jobs WHERE id=?1').bind(id).first();
  if (!job || !token || !safeEqual(token,job.lease_token)) throw syncError('sync-lease','연동 작업 권한을 확인해 주세요.',409);
  if (allowComplete && ['succeeded','conflict','review'].includes(job.state)) return job;
  if (job.state!=='leased' || job.lease_until<=Date.now()) throw syncError('sync-lease-expired','연동 작업 유효시간이 지났습니다. 추가 변경을 중단해 주세요.',409);
  return job;
}
export async function heartbeatSyncJob(env,body) {
  await ensureSyncSchema(env);
  const job=await leasedJob(env,body),now=Date.now(),until=now+LEASE_MS;
  const result=await env.DB.prepare(`UPDATE spacecloud_sync_jobs SET lease_until=?3,updated_at=?4 WHERE id=?1 AND lease_token=?2 AND state='leased' AND lease_until>?4`)
    .bind(job.id,job.lease_token,until,now).run();
  if (!Number(result.meta?.changes)) throw syncError('sync-lease-expired','연동 작업 유효시간이 지났습니다.',409);
  return {ok:true,lease_until:until};
}
export async function finishSyncJob(env,body) {
  await ensureSyncSchema(env);
  const job=await leasedJob(env,body,{allowComplete:true});
  if (job.state!=='leased') return {ok:true,already:true,code:job.booking_code,status:job.state};
  const block=await getSync(env,job.booking_code),now=Date.now();
  let status=body.status;
  if (!['succeeded','conflict','review'].includes(status)) throw syncError('sync-result','연동 처리 결과를 확인해 주세요.',400);
  // A conflict is safe to release only when the worker proves it created no block.
  if (status==='conflict' && !(job.action==='block' && body.receipt?.verified_released===true && validateReceipt(body.receipt,block,'release'))) status='review';
  if (status==='succeeded' && !validateReceipt(body.receipt,block,job.action)) status='review';
  // The observation time belongs to the final browser check, not to a delayed HTTP acknowledgement.
  const observedAt=body.receipt?.observed_at;
  if(status==='succeeded' && job.action!=='release' && (typeof observedAt!=='number' || !Number.isFinite(observedAt)
    || observedAt<now-30000 || observedAt>now+5000)) status='review';
  const state=status==='review' ? 'review' : status==='conflict' ? 'conflict'
    : job.action==='release' ? 'released' : block.cancel_requested ? 'releasing' : 'blocked';
  const receipt=status==='succeeded' ? JSON.stringify({marker:block.marker,room:block.room,date:block.date,
    start_min:block.start_min,end_min:block.end_min,segments:bookingSegments(block),
    no_conflicts:body.receipt.no_conflicts===true,verified_blocked:body.receipt.verified_blocked===true,
    verified_released:body.receipt.verified_released===true,
    observed_at:typeof observedAt==='number' && Number.isFinite(observedAt) ? Math.min(now,observedAt) : null,
    job_created_at:job.created_at}) : null;
  const error=status==='succeeded' ? null : clean(body.message,300) || (status==='conflict' ? '외부 예약 일정과 겹칩니다.' : '외부 처리 결과 확인이 필요합니다.');
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state=?3,result_json=?4,updated_at=?5 WHERE id=?1 AND lease_token=?2 AND state='leased' AND lease_until>?5`)
      .bind(job.id,job.lease_token,status,JSON.stringify({status,message:error}),now),
    env.DB.prepare(`UPDATE spacecloud_blocks SET state=CASE WHEN ?3='blocked' AND cancel_requested=1 THEN 'releasing' ELSE ?3 END,
      receipt_json=COALESCE(?4,receipt_json),verified_at=CASE WHEN cancel_requested=1 THEN NULL ELSE ?5 END,error=?6,updated_at=?7
      WHERE code=?1 AND EXISTS (SELECT 1 FROM spacecloud_sync_jobs WHERE id=?2 AND state=?8 AND updated_at=?7)`)
      .bind(block.code,job.id,state,receipt,status==='succeeded' && job.action!=='release' && !block.cancel_requested ? Math.min(now,observedAt) : null,error,now,status)
  ]);
  if (!Number(results[0]?.meta?.changes)) throw syncError('sync-lease-expired','연동 작업 유효시간이 지났습니다.',409);
  return {ok:true,code:block.code,status,state};
}

export async function saveWorkerCalendar(env,body) {
  await ensureSyncSchema(env);
  const room=clean(body.room,10),start=body.range_start,end=body.range_end;
  if (!/^r[1-5]$/.test(room) || !isoDate(start) || !isoDate(end) || end<start || Date.parse(end)-Date.parse(start)>31*86400000
    || !Array.isArray(body.events) || body.events.length>2000) throw syncError('sync-snapshot','일정 수집 범위를 확인해 주세요.',400);
  const byDay=new Map();
  for (let date=start;date<=end;date=nextDate(date)) byDay.set(date,[]);
  for (const event of body.events) {
    if (!byDay.has(event.date) || !Number.isInteger(event.start_min) || !Number.isInteger(event.end_min)
      || event.start_min<0 || event.end_min>1440 || event.end_min<=event.start_min) throw syncError('sync-snapshot','일정 수집 결과를 확인해 주세요.',400);
    // Never retain names, phone numbers, purpose or arbitrary host calendar text.
    byDay.get(event.date).push({date:event.date,start_min:event.start_min,end_min:event.end_min,
      marker:/^SFWEB:[A-Za-z0-9_-]{8,64}$/.test(event.marker || '') ? event.marker : null});
  }
  const now=Date.now();
  await env.DB.batch([...byDay].map(([date,events])=>env.DB.prepare(`INSERT INTO spacecloud_worker_calendar (room,date,events_json,checked_at)
    VALUES (?1,?2,?3,?4) ON CONFLICT(room,date) DO UPDATE SET events_json=excluded.events_json,checked_at=excluded.checked_at`)
    .bind(room,date,JSON.stringify(events),now)));
  return {ok:true,room,range_start:start,range_end:end,checked_at:now};
}
export async function loadWorkerCalendar(env,{room,date}={}) {
  await ensureSyncSchema(env);
  const conditions=[],values=[];
  if (room) {values.push(room);conditions.push('room=?'+values.length);}
  if (date) {values.push(date);conditions.push('date=?'+values.length);}
  const stmt=env.DB.prepare('SELECT * FROM spacecloud_worker_calendar'+(conditions.length ? ' WHERE '+conditions.join(' AND ') : ''));
  const {results}=await (values.length ? stmt.bind(...values) : stmt).all();
  const rows=[];
  for (const row of results || []) {
    let events=[];try{events=JSON.parse(row.events_json);}catch{}
    for (const event of events) rows.push({space:row.room,date:event.date,start_min:event.start_min,end_min:event.end_min,
      marker:event.marker,source:'spacecloud_worker',checked_at:row.checked_at});
  }
  return {results:rows,rooms:(results || []).map(row=>({space:row.room,date:row.date,checked_at:row.checked_at,stale:Date.now()-row.checked_at>300000}))};
}
