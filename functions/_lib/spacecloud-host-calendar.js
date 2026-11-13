import { readFeedConfig, calendarRows } from './spacecloud.js';
import { calendarEventIdentity } from './spacecloud-identity.js';
import { sha256Hex } from './auth.js';
import { ensureCalendarHistory } from './spacecloud-history.js';
const INTERVAL=10000, FIRST='2026-10', KST=9*3600000;
const day=ms=>new Date(ms+KST).toISOString().slice(0,10);
const nextMonth=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),1)).toISOString().slice(0,7);
const problem=code=>Object.assign(new Error(code),{code,status:409});
const interval=r=>{const midnight=Date.parse(r.date+'T00:00:00+09:00');return {start:midnight+r.start_min*60000,end:midnight+r.end_min*60000,title:r.title,source_url:r.reservation_id?`https://partner.spacecloud.kr/reservation/${r.reservation_id}`:''};};
const paidId=event=>/^https:\/\/partner\.spacecloud\.kr\/reservation\/(\d+)\/?$/.exec(event.source_url||'')?.[1]||null;
export async function ensureHostCalendar(env){
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_host_calendar_state(id INTEGER PRIMARY KEY CHECK(id=1),requested_at INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,last_success INTEGER,status TEXT,plan_json TEXT,counts TEXT,error TEXT)`).run();
 await env.DB.prepare('INSERT OR IGNORE INTO spacecloud_host_calendar_state(id) VALUES(1)').run();
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_host_calendars(space TEXT NOT NULL,month TEXT NOT NULL,config_hash TEXT NOT NULL,checked_at INTEGER NOT NULL,events_json TEXT NOT NULL,PRIMARY KEY(space,month))`).run();
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_host_calendar_removed(space TEXT NOT NULL,identity TEXT NOT NULL,config_hash TEXT NOT NULL,checked_at INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(space,identity))`).run();
}
export async function hostCalendarSummary(env){await ensureHostCalendar(env);const r=await env.DB.prepare('SELECT * FROM spacecloud_host_calendar_state WHERE id=1').first();return {status:r.requested_at>r.last_attempt?'queued':r.status,last_attempt:r.last_attempt,last_success:r.last_success,counts:r.counts?JSON.parse(r.counts):null,error:r.error,interval_ms:INTERVAL};}
export async function requestHostCalendar(env,now=Date.now()){await ensureHostCalendar(env);await env.DB.prepare('UPDATE spacecloud_host_calendar_state SET requested_at=?1 WHERE id=1').bind(now).run();}
export async function beginHostCalendar(env,{now=Date.now()}={}){
 await ensureHostCalendar(env);await ensureCalendarHistory(env);
 const s=await env.DB.prepare('SELECT * FROM spacecloud_host_calendar_state WHERE id=1').first();
 if(s.status==='running' && now-s.last_attempt<180000)return null;
 const requested=s.requested_at>s.last_attempt;
 if(!requested && s.last_success && now-s.last_success<INTERVAL && s.status!=='error')return null;
 if(!requested && s.status==='error') {
  const authOrBudget=/login|profile|budget|binding|configured/.test(s.error||'');
  const retryAt=JSON.parse(s.plan_json||'{}').retry_at||0;
  if(now<Math.max(retryAt,s.last_attempt+(authOrBudget?5*60000:30000)))return null;
 }
 const feeds=await readFeedConfig(env);if(feeds.length!==5)throw problem('host-calendar-five-rooms-required');
 let last=nextMonth(day(now).slice(0,7));
 // The iCal includes upcoming bookings; inspect every intervening month in all
 // rooms so moving a manual booking does not depend on matching a customer name.
 const cache=await env.DB.prepare('SELECT space,events_json FROM spacecloud_calendar_cache').all();
 for(const c of cache.results||[])for(const e of JSON.parse(c.events_json))if(Number.isFinite(e.end))last=[last,day(e.end-1).slice(0,7)].sort().pop();
 const scopes=[];let month=FIRST;
 for(let n=0;month<=last && n<36;n++,month=nextMonth(month))for(const f of feeds)scopes.push({space:f.space,month,product_id:new URL(f.url).searchParams.get('product_id'),config_hash:await sha256Hex(f.url)});
 if(month<=last)throw problem('host-calendar-range');
 const plan={observed_at:now,scopes};
 const update=await env.DB.prepare(`UPDATE spacecloud_host_calendar_state SET last_attempt=?1,status='running',error=NULL,plan_json=?2 WHERE id=1 AND last_attempt=?3`).bind(now,JSON.stringify(plan),s.last_attempt).run();
 return update.meta?.changes?plan:null;
}
export async function failHostCalendar(env,observedAt,code,retryAfterMs=0){
 await ensureHostCalendar(env);
 const row=await env.DB.prepare('SELECT plan_json FROM spacecloud_host_calendar_state WHERE id=1 AND last_attempt=?1').bind(observedAt).first();
 if(!row)return;
 const plan=JSON.parse(row.plan_json||'{}');
 if(Number.isFinite(retryAfterMs)&&retryAfterMs>0)plan.retry_at=Date.now()+Math.min(retryAfterMs,86400000);
 await env.DB.prepare(`UPDATE spacecloud_host_calendar_state SET status='error',error=?2,plan_json=?3 WHERE id=1 AND last_attempt=?1 AND status='running'`)
  .bind(observedAt,String(code||'collection-error').replace(/[^a-z0-9-]/g,'').slice(0,80),JSON.stringify(plan)).run();
}
export async function finishHostCalendar(env,body){
 await ensureHostCalendar(env);await ensureCalendarHistory(env);
 const s=await env.DB.prepare('SELECT * FROM spacecloud_host_calendar_state WHERE id=1').first();
 if(s.status!=='running' || s.last_attempt!==body.observed_at)throw problem('host-calendar-stale');
 const plan=JSON.parse(s.plan_json), now=plan.observed_at;
 if(body.complete!==true || !Array.isArray(body.snapshots) || body.snapshots.length!==plan.scopes.length)throw problem('host-calendar-incomplete');
 const snapshots=new Map(),expected=new Map(plan.scopes.map(s=>[s.space+'|'+s.month,s]));
 for(const snapshot of body.snapshots){
  const key=snapshot?.space+'|'+snapshot?.month,scope=expected.get(key);
  if(!scope || snapshots.has(key) || String(snapshot.product_id)!==scope.product_id || !Array.isArray(snapshot.events) || snapshot.events.length>3000)throw problem('host-calendar-scope');
  if(snapshot.paid_ids!==undefined && (!Array.isArray(snapshot.paid_ids)||snapshot.paid_ids.length>5000||snapshot.paid_ids.some(id=>!/^\d{1,20}$/.test(id))))throw problem('host-calendar-paid-ids');
  const events=[],seen=new Set();
  for(const r of snapshot.events){
   if(!r || !/^[0-9]{1,20}$/.test(String(r.id)) || typeof r.title!=='string' || !r.title.trim() || r.title.length>200
    || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date.slice(0,7)!==scope.month || !Number.isFinite(Date.parse(r.date+'T00:00:00Z'))
    || !Number.isInteger(r.start_min) || !Number.isInteger(r.end_min) || r.start_min<0 || r.start_min>=1440 || r.start_min%30 || r.end_min%30 || r.end_min<=r.start_min || r.end_min-r.start_min>1440)throw problem('host-calendar-event');
   if(r.kind!==undefined && r.kind!=='reservation')throw problem('host-calendar-kind');
   if(r.kind==='reservation' && !snapshot.paid_ids?.includes(String(r.id)))throw problem('host-calendar-paid-ids');
   const item={id:String(r.id),date:r.date,start_min:r.start_min,end_min:r.end_min,title:r.title.normalize('NFC').trim(),...(r.kind==='reservation'?{reservation_id:String(r.id)}:{})};
   const identity=calendarEventIdentity(interval(item));if(seen.has(identity))continue;seen.add(identity);events.push(item);
  }
  snapshots.set(key,{...scope,events,paid_ids:snapshot.paid_ids});
 }
 // Check the current feed configuration before applying a possibly delayed run.
 const hashes=new Map(await Promise.all((await readFeedConfig(env)).map(async f=>[f.space,await sha256Hex(f.url)])));
 if(plan.scopes.some(s=>hashes.get(s.space)!==s.config_hash))throw problem('host-calendar-config-changed');
 const candidates=[];
 const cache=(await env.DB.prepare('SELECT space,config_hash,events_json FROM spacecloud_calendar_cache').all()).results||[];
 for(const c of cache)for(const e of JSON.parse(c.events_json))candidates.push({space:c.space,hash:c.config_hash,event:e});
 const history=(await env.DB.prepare("SELECT * FROM spacecloud_calendar_history WHERE source NOT IN ('host_cancelled','feed_cancelled')").all()).results||[];
 for(const h of history)candidates.push({space:h.space,hash:h.config_hash,event:{start:h.start_ms,end:h.end_ms,title:h.title,source_url:h.reservation_id?`https://partner.spacecloud.kr/reservation/${h.reservation_id}`:''}});
 const previous=(await env.DB.prepare('SELECT * FROM spacecloud_host_calendars').all()).results||[];
 for(const p of previous)for(const e of JSON.parse(p.events_json))candidates.push({space:p.space,hash:p.config_hash,event:interval(e)});
 const writes=[],removed=new Map();
 const positioned=new Set([...snapshots.values()].flatMap(s=>s.events.map(e=>e.reservation_id).filter(Boolean)));
 const protectedPaid=new Set([...snapshots.values()].flatMap(s=>(s.paid_ids||[]).filter(id=>!positioned.has(id))));
 for(const c of candidates){
  const scope=snapshots.get(c.space+'|'+day(c.event.start).slice(0,7));
  if(!scope || scope.config_hash!==c.hash)continue;
  const identity=calendarEventIdentity(c.event);
  if(scope.events.some(e=>calendarEventIdentity(interval(e))===identity))continue;
  const id=paidId(c.event);
  if(id && (protectedPaid.has(id)||!scope.paid_ids))continue;
  removed.set(c.space+'|'+identity,c);
 }
 for(const {space,hash,event} of removed.values())writes.push(env.DB.prepare(`INSERT INTO spacecloud_host_calendar_removed(space,identity,config_hash,checked_at,event_json) VALUES(?1,?2,?3,?4,?5)
  ON CONFLICT(space,identity) DO UPDATE SET config_hash=excluded.config_hash,checked_at=excluded.checked_at,event_json=excluded.event_json WHERE excluded.checked_at>=checked_at`)
  .bind(space,calendarEventIdentity(event),hash,now,JSON.stringify(event)));
 for(const scope of snapshots.values()){
  writes.push(env.DB.prepare(`INSERT INTO spacecloud_host_calendars(space,month,config_hash,checked_at,events_json) VALUES(?1,?2,?3,?4,?5)
   ON CONFLICT(space,month) DO UPDATE SET config_hash=excluded.config_hash,checked_at=excluded.checked_at,events_json=excluded.events_json WHERE excluded.checked_at>=checked_at`).bind(scope.space,scope.month,scope.config_hash,now,JSON.stringify(scope.events)));
  for(const e of scope.events)writes.push(env.DB.prepare('DELETE FROM spacecloud_host_calendar_removed WHERE space=?1 AND identity=?2 AND checked_at<=?3').bind(scope.space,calendarEventIdentity(interval(e)),now));
 }
 // One D1 batch is transactional: incomplete snapshots never remove any slots.
 const counts={transport:body.transport==='api'?'api':'browser',rooms:new Set(plan.scopes.map(s=>s.space)).size,months:new Set(plan.scopes.map(s=>s.month)).size,manual:body.snapshots.reduce((n,s)=>n+s.events.filter(e=>e.kind!=='reservation').length,0),reservations:body.snapshots.reduce((n,s)=>n+s.events.filter(e=>e.kind==='reservation').length,0),removed:removed.size};
 writes.push(env.DB.prepare(`UPDATE spacecloud_host_calendar_state SET last_success=?1,status='success',counts=?2,error=NULL WHERE id=1 AND last_attempt=?1 AND status='running'`).bind(now,JSON.stringify(counts)));
 await env.DB.batch(writes);
 return {ok:true,counts};
}
export async function loadHostCalendar(env,feeds,{from,to}={}){
 await ensureHostCalendar(env);
 const hashes=new Map(feeds.map(f=>[f.space,f.hash]));
 const saved=(await env.DB.prepare('SELECT * FROM spacecloud_host_calendars').all()).results||[];
 const ownTable=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spacecloud_blocks'").first();
 const ownMarkers=new Set(ownTable?((await env.DB.prepare('SELECT marker FROM spacecloud_blocks').all()).results||[]).map(r=>r.marker):[]);
 const rows=[],events=new Map();
 for(const s of saved){if(hashes.get(s.space)!==s.config_hash)continue;for(const e of JSON.parse(s.events_json)){
  const event=interval(e);if(!events.has(s.space))events.set(s.space,[]);events.get(s.space).push(event);
  // Registered website holds are governed by their local release state and the
  // live feed, never by a six-hour-old mirror of the host's month.
  if(!ownMarkers.has(e.title))rows.push(...await calendarRows([event],s.space,s.checked_at,{from,to}));
 }}
 const exclusions=(await env.DB.prepare('SELECT * FROM spacecloud_host_calendar_removed').all()).results||[];
 const removed=[];
 for(const e of exclusions){if(hashes.get(e.space)!==e.config_hash)continue;removed.push(...(await calendarRows([JSON.parse(e.event_json)],e.space,e.checked_at)).map(row=>({...row,authoritative:true})));}
 return {rows,events,removed,summary:await hostCalendarSummary(env)};
}
