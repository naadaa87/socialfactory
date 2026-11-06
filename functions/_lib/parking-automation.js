import {json,safeEqual} from './auth.js';
import {kstNow} from './admin.js';
import {ensureParking,parkingSettings,openDate,parkingOrder,parkingAction,PARKING_JOIN,TICKETS,plateOf} from './parking.js';
export const AUTOMATION_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS parking_automation_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,updated_at TEXT)`,
 `INSERT OR IGNORE INTO parking_automation_settings(id,enabled) VALUES(1,0)`,
 `CREATE TABLE IF NOT EXISTS parking_automation_claims(oid TEXT PRIMARY KEY REFERENCES parking_orders(oid),free_hours INTEGER NOT NULL CHECK(free_hours IN (0,1)),paid_hours INTEGER NOT NULL CHECK(paid_hours BETWEEN 0 AND 3),cost INTEGER NOT NULL CHECK(cost>=0),created_at TEXT NOT NULL)`
];
export async function ensureAutomation(env){await ensureParking(env);await env.DB.batch(AUTOMATION_SCHEMA.map(q=>env.DB.prepare(q)));}
export async function automationEnabled(env){await env.DB.batch(AUTOMATION_SCHEMA.map(q=>env.DB.prepare(q)));return !!(await env.DB.prepare('SELECT enabled FROM parking_automation_settings WHERE id=1').first())?.enabled;}
export async function automationSign(secret,body){const e=new TextEncoder(),key=await crypto.subtle.importKey('raw',e.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,e.encode(body))),v=>v.toString(16).padStart(2,'0')).join('');}
export function automationOpen(s,now=kstNow()){const m=Number(now.slice(11,13))*60+Number(now.slice(14,16));return s.confirmed&&openDate(now.slice(0,10),s)&&m>=s.start_min&&m<s.end_min;}
export async function automationRelay(env,action,data={}){
 const secret=String(env.ALIGO_RELAY_SECRET||'');if(secret.length<32)throw Error('기존 서버 연결 설정을 확인해 주세요.');
 const body=JSON.stringify({action,...data,time:Date.now()});const r=await fetch('https://relay.naranhistory.com/socialfactory/amano',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','X-Socialfactory-Signature':await automationSign(secret,body)},body,signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('아마노 자동 등록 서버 연결을 확인해 주세요.');const j=await r.json();if(!j.ok)throw Error('아마노 자동 등록 서버 상태를 확인해 주세요.');return j;
}
export async function automaticParking({request,env,waitUntil}){
 if(!env.DB)return json({ok:false},503);
 const secret=String(env.ALIGO_RELAY_SECRET||'');if(request.method!=='POST'||secret.length<32)return json({ok:false},403);
 const raw=await request.text();if(raw.length>8000)return json({ok:false},413);let b;try{b=JSON.parse(raw);}catch{return json({ok:false},400);}
 if(!b||!Number.isFinite(b.time)||Math.abs(Date.now()-b.time)>60000||!safeEqual(request.headers.get('X-Socialfactory-Signature')||'',await automationSign(secret,raw)))return json({ok:false},403);
 await ensureAutomation(env);const s=await parkingSettings(env),enabled=await automationEnabled(env),operating=enabled&&automationOpen(s),today=kstNow().slice(0,10);
 if(b.action==='orders'){
  if(!operating)return json({ok:true,operating:false,date:today,items:[]});
  const {results}=await env.DB.prepare(PARKING_JOIN+" WHERE p.visit_date=? AND p.status='requested' AND p.arrival_at IS NOT NULL AND (p.request_at IS NULL OR p.reviewed_at IS NOT NULL) AND o.status='paid' AND o.test_mode=0 AND o.paid_at IS NOT NULL AND o.tid=pg.mul_no AND pg.refunded_amount=0 ORDER BY p.created_at,p.oid LIMIT 50").bind(today).all();
  return json({ok:true,operating:true,date:today,items:results.map(p=>({oid:p.oid,plate:p.plate,visit_date:p.visit_date,ticket:p.ticket,hours:TICKETS[p.ticket].hours,status:p.status,price:p.amount}))});
 }
 if(!['order','claim','complete','issue'].includes(b.action)||!/^SF[A-Z0-9]{16}$/.test(b.oid||''))return json({ok:false},400);
 const p=await parkingOrder(env,b.oid);if(!p||p.test_mode||p.visit_date!==today)return json({ok:false,error:'당일의 실제 결제 주문만 처리할 수 있습니다.'},409);
 const claim=await env.DB.prepare('SELECT free_hours,paid_hours,cost FROM parking_automation_claims WHERE oid=?').bind(p.oid).first();
 if(b.action==='order')return json({ok:true,order:{oid:p.oid,plate:p.plate,visit_date:p.visit_date,ticket:p.ticket,hours:TICKETS[p.ticket].hours,status:p.status,price:p.amount,payment_status:p.payment_status,refunded_amount:p.refunded_amount,refund_pending:!enabled||!!(p.request_at&&!p.reviewed_at),entry_id:p.entry_id,entry_at:p.entry_at,...(claim||{})}});
 const d=b.data||{};
 if(b.action==='issue'){
  const r=await parkingAction(env,p,{action:'issue',expectedVersion:p.version,memo:'서버 자동 등록 확인 필요 · '+String(d.memo||'등록 결과 확인 필요').slice(0,400)},true);return json(r,r.status||200);
 }
 if(!operating||p.payment_status!=='paid'||p.refunded_amount||p.request_at&&!p.reviewed_at||!p.paid_at)return json({ok:false,error:'운영시간 또는 결제·환불 상태가 변경되었습니다.'},409);
 if(b.action==='claim'){
  const entry=String(d.entry_id||'').trim().slice(0,80),at=String(d.entry_at||'').replace('T',' ').slice(0,16)+':00',now=kstNow();
  if(p.status!=='requested'||!p.arrival_at||claim||plateOf(d.plate_confirm)!==p.plate||d.confirm_entry!==true||!entry||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(at)||at.slice(0,10)!==today||Number(at.slice(11,13))>23||Number(at.slice(14,16))>59||at>now||d.free_used!==true&&d.confirm_no_free!==true||d.free_used===true&&d.confirm_no_free===true)return json({ok:false,error:'당일 입차·무료 할인 이력을 확인해 주세요.'},409);
  const free=d.free_used?0:1,hours=TICKETS[p.ticket].hours,paid=hours===null?0:hours-free,cost=p.ticket==='daily'?20000:paid*3000;
  if(cost>p.amount||paid<0||paid>3)return json({ok:false},409);
  const operation=crypto.randomUUID(),version=p.version+1;
  const result=await env.DB.batch([
   env.DB.prepare("UPDATE parking_orders SET status='processing',entry_id=?,entry_at=?,version=?,operation_key=?,memo='서버 자동 등록 · 입차와 무료 할인 이력 확인',updated_at=? WHERE oid=? AND version=? AND status='requested' AND (request_at IS NULL OR reviewed_at IS NOT NULL) AND EXISTS(SELECT 1 FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid WHERE o.oid=parking_orders.payment_oid AND o.status='paid' AND o.test_mode=0 AND o.paid_at IS NOT NULL AND o.tid=pg.mul_no AND pg.refunded_amount=0) AND EXISTS(SELECT 1 FROM parking_automation_settings WHERE id=1 AND enabled=1)").bind(entry,at,version,operation,now,p.oid,p.version),
   env.DB.prepare('INSERT INTO parking_automation_claims(oid,free_hours,paid_hours,cost,created_at) SELECT oid,?,?,?,? FROM parking_orders WHERE oid=? AND operation_key=?').bind(free,paid,cost,now,p.oid,operation),
   env.DB.prepare("INSERT INTO parking_history(oid,action,version,note) SELECT oid,'auto-claim',version,'입차·무료 1시간·차감 한도 확인' FROM parking_orders WHERE oid=? AND operation_key=?").bind(p.oid,operation)
  ]);return json(result[0].meta.changes?{ok:true}:{ok:false,error:'처리 상태가 변경되었습니다.'},result[0].meta.changes?200:409);
 }
 if(!claim||p.status!=='processing'||d.cost!==claim.cost||claim.cost>p.amount||d.confirm_paid_applied!==true||claim.free_hours===1&&d.confirm_free_applied!==true)return json({ok:false,error:'무료 우선 적용·실제 등록 결과·차감액을 확인해 주세요.'},409);
 const r=await parkingAction(env,p,{action:'complete',expectedVersion:p.version,confirmApplied:true,memo:'서버 자동 등록 · '+String(d.memo||'실제 할인내역·차감액 확인').slice(0,450)},true);
 if(r.ok&&waitUntil){const {runParkingQueue}=await import('./parking-notify.js');waitUntil(runParkingQueue(env));}return json(r,r.status||200);
}
