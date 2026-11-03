import {ensureWebsitePasses} from './website-passes.js';
import {validateWebsiteStart} from './website-start.js';
import {kstNow} from './admin.js';
import {toMs,fromMs,addDuration,kTime} from './kiosk.js';
import {KIOSK_PRODUCT_MAP} from './kiosk-products.js';

export const CHANGE_SCHEMA=`CREATE TABLE IF NOT EXISTS website_schedule_changes (
 request_id TEXT PRIMARY KEY, oid TEXT NOT NULL REFERENCES orders(oid), old_start TEXT NOT NULL,
 new_start TEXT NOT NULL, actor TEXT NOT NULL, operation_token TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')))`;
export const scheduledPeriods=(terms,qty,start)=>{
 const periods=[];let cursor=start;
 for(let unit=1;unit<=qty;unit++){
  const end=terms.endOfDay ? fromMs(toMs(cursor.slice(0,10)+' 00:00:00')+864e5) : addDuration(cursor,terms.duration);
  periods.push({unit,starts_at:cursor,ends_at:end});cursor=end;
 }
 return periods;
};
const reason={unsupported:'이 상품은 홈페이지에서 이용 시간을 변경할 수 없습니다. 카카오톡으로 문의해 주세요.',
 unavailable:'취소·환불 중이거나 일정이 조정된 이용권은 직접 변경할 수 없습니다. 카카오톡으로 문의해 주세요.',
 started:'이용이 이미 시작되어 시간을 변경할 수 없습니다.',
 sending:'알림을 발송하고 있습니다. 잠시 후 다시 시도해 주세요.'};
export async function websiteSchedule(env,order){
 const now=kstNow();
 const saved=await env.DB.prepare('SELECT terms FROM website_order_terms WHERE oid=?').bind(order.oid).first().catch(()=>null);
 let terms;try{terms=JSON.parse(saved?.terms||'null')}catch{}
 const base={supported:terms?.activation==='scheduled',allowed:false,now};
 if(!base.supported)return {...base,message:reason.unsupported};
 const maxStart=fromMs(toMs(order.created_at)+90*864e5);
 const {results:passes}=await env.DB.prepare(`SELECT p.*,pp.status AS payment_status,pp.refund_amount,pp.amount,w.unit,pp.payment_key FROM website_order_passes w
 JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=? ORDER BY w.unit`).bind(order.oid).all();
 const payment=await env.DB.prepare('SELECT mul_no,refunded_amount FROM payapp_payments WHERE oid=?').bind(order.oid).first();
 const result={...base,maxStart,startAt:order.start_date,terms,passes};
 if(order.status!=='paid' || !payment || payment.mul_no!==order.tid || payment.refunded_amount || passes.length!==order.qty || passes.some(p=>p.status!=='active'||p.payment_status!=='paid'||p.refund_amount))return {...result,message:reason.unavailable};
 if(order.start_date<=now || passes.some(p=>p.starts_at<=now))return {...result,message:reason.started};
 const expected=scheduledPeriods(terms,order.qty,order.start_date);
 if(terms.startAt!==order.start_date || passes.some((p,i)=>p.unit!==expected[i].unit || p.starts_at!==expected[i].starts_at || p.ends_at!==expected[i].ends_at))return {...result,message:reason.unavailable};
 const sending=await env.DB.prepare(`SELECT id FROM notification_jobs WHERE status='sending' AND pass_id IN
 (SELECT p.id FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=?) LIMIT 1`).bind(order.oid).first();
 return {...result,allowed:!sending,message:sending?reason.sending:''};
}
export function publicSchedule(schedule){
 const {supported,allowed,now,maxStart,startAt,message}=schedule;
 return {supported,allowed,now,maxStart,startAt,message};
}

// 이용 기간과 알림 재계산을 같은 D1 트랜잭션에서 처리해 오래된 예약을 남기지 않습니다.
// SQL이 현재 기간을 직접 읽으므로 다른 주문이 동시에 발급돼도 예전 기간을 다시 넣지 않습니다.
function expiryStmts(env,cid,group,op,now){
 const gate='EXISTS(SELECT 1 FROM website_schedule_changes WHERE operation_token=?4)';
 const at="MAX(p.starts_at,datetime(p.ends_at,'-'||r.value||' minutes'))";
 const remaining=`CAST(ROUND((julianday(p.ends_at)-julianday(${at}))*1440) AS INTEGER)`;
 const display="CAST(substr(p.ends_at,6,2) AS INTEGER)||'월 '||CAST(substr(p.ends_at,9,2) AS INTEGER)||'일 '||substr(p.ends_at,12,5)";
 return [env.DB.prepare(`UPDATE notification_jobs SET status='cancelled',updated_at=datetime('now','+9 hours') WHERE customer_id=?1 AND pass_group=?2 AND kind='expire_soon' AND status='queued' AND EXISTS(SELECT 1 FROM website_schedule_changes WHERE operation_token=?3)`).bind(cid,group,op),
 env.DB.prepare(`INSERT INTO notification_jobs(dedupe_key,kind,customer_id,pass_id,pass_group,phone,vars,send_after)
 SELECT 'expire:'||p.customer_id||':'||p.pass_group||':'||p.ends_at||':'||r.value,'expire_soon',p.customer_id,p.id,p.pass_group,c.phone,
 json_object('고객',COALESCE(NULLIF(c.name,''),'고객'),'이용권',p.product_name,'만료',${display},'__endsAt',p.ends_at,
 '남은시간',CASE WHEN ${remaining}>=1440 THEN CAST(ROUND(${remaining}/1440.0) AS INTEGER)||'일' WHEN ${remaining}>=60 THEN CAST(ROUND(${remaining}/60.0) AS INTEGER)||'시간' ELSE ${remaining}||'분' END),${at}
 FROM passes p JOIN customers c ON c.id=p.customer_id JOIN pass_payments pp ON pp.id=p.payment_id
 LEFT JOIN kiosk_payment_terms t ON t.payment_key=pp.payment_key
 JOIN json_each(COALESCE(t.terms,json_extract(?5,'$."'||pp.product_id||'"'),'{}'),'$.remind') r
 WHERE p.customer_id=?1 AND p.pass_group=?2 AND p.status='active' AND p.ends_at>?3 AND ${at}>?3 AND ${gate}
 AND NOT EXISTS(SELECT 1 FROM passes other WHERE other.customer_id=p.customer_id AND other.pass_group=p.pass_group AND other.status='active' AND other.ends_at>?3
 AND other.starts_at<=p.ends_at AND (other.ends_at>p.ends_at OR (other.ends_at=p.ends_at AND other.id>p.id)))
 ON CONFLICT(dedupe_key) DO UPDATE SET status='queued',send_after=excluded.send_after,vars=excluded.vars,updated_at=datetime('now','+9 hours') WHERE notification_jobs.status='cancelled'`).bind(cid,group,now,op,JSON.stringify(KIOSK_PRODUCT_MAP))];
}
export async function rescheduleWebsiteOrder(env,order,{startAt,expectedStart,requestId,actor}){
 await ensureWebsitePasses(env);await env.DB.prepare(CHANGE_SCHEMA).run();
 const original=await env.DB.prepare('SELECT * FROM website_schedule_changes WHERE request_id=?').bind(requestId).first();
 const chosen=validateWebsiteStart(startAt);
 if(original){
  if(original.oid!==order.oid || original.old_start!==expectedStart || original.new_start!==chosen.value)return {error:'conflict',status:409,message:'다른 변경 요청입니다. 최신 일정을 확인해 주세요.'};
  return {ok:true,duplicate:true};
 }
 if(chosen.error)return {error:'invalid',status:400,field:chosen.error};
 const s=await websiteSchedule(env,order);
 if(!s.allowed)return {error:'unavailable',status:409,message:s.message};
 if(chosen.value>s.maxStart)return {error:'invalid',status:400,field:'originalLimit'};
 if(order.start_date!==expectedStart)return {error:'conflict',status:409,message:'다른 화면에서 일정이 변경되었습니다. 최신 일정을 확인해 주세요.'};
 if(chosen.value===order.start_date)return {ok:true,unchanged:true};
 const op=crypto.randomUUID(),now=kstNow(),terms={...s.terms,startAt:chosen.value},next=scheduledPeriods(terms,order.qty,chosen.value);
 const sql=(q,...a)=>env.DB.prepare(q).bind(...a),gate='EXISTS(SELECT 1 FROM website_schedule_changes WHERE operation_token=?)';
 const guards=[],args=[requestId,order.start_date,chosen.value,actor,op,order.oid,order.start_date,now,chosen.value,now,s.passes.length];
 for(const p of s.passes){guards.push(`EXISTS(SELECT 1 FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=o.oid AND w.unit=? AND p.id=? AND p.customer_id=? AND p.status='active' AND pp.status='paid' AND pp.refund_amount=0 AND p.starts_at=? AND p.ends_at=? AND p.starts_at>MAX(?,datetime('now','+9 hours')))`);args.push(p.unit,p.id,p.customer_id,p.starts_at,p.ends_at,now)}
 const batch=[sql(`INSERT OR IGNORE INTO website_schedule_changes(request_id,oid,old_start,new_start,actor,operation_token)
 SELECT ?,o.oid,?,?,?,? FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid
 WHERE o.oid=? AND o.start_date=? AND o.status='paid' AND o.start_date>MAX(?,datetime('now','+9 hours')) AND pg.mul_no=o.tid AND pg.refunded_amount=0 AND ?>MAX(?,datetime('now','+9 hours'))
 AND (SELECT COUNT(*) FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=o.oid)=?
 AND NOT EXISTS(SELECT 1 FROM notification_jobs j WHERE j.status='sending' AND j.pass_id IN (SELECT p.id FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=o.oid))
 AND ${guards.join(' AND ')}`, ...args),
 sql(`UPDATE orders SET start_date=? WHERE oid=? AND ${gate}`,chosen.value,order.oid,op),
 sql(`UPDATE website_order_terms SET terms=? WHERE oid=? AND ${gate}`,JSON.stringify(terms),order.oid,op)];
 for(let i=0;i<s.passes.length;i++){
  const p=s.passes[i],n=next[i];
  batch.push(sql(`UPDATE passes SET starts_at=?,ends_at=?,updated_at=datetime('now','+9 hours') WHERE id=? AND ${gate}`,n.starts_at,n.ends_at,p.id,op),
   sql(`UPDATE kiosk_payment_terms SET terms=? WHERE payment_key=? AND ${gate}`,JSON.stringify(terms),p.payment_key,op),
   sql(`UPDATE notification_jobs SET vars=json_set(vars,'$.시작',?,'$.만료',?),updated_at=datetime('now','+9 hours') WHERE pass_id=? AND kind='purchase' AND status='queued' AND ${gate}`,kTime(n.starts_at),kTime(n.ends_at),p.id,op));
 }
 // 승인 처리와 일정 변경이 겹쳐 구매 안내가 아직 없더라도 최신 시각으로 한 건만 만듭니다.
 for(const p of s.passes){
  const vars="json_object('고객',COALESCE(NULLIF(c.name,''),'고객'),'이용권',p.product_name,'시작',CAST(substr(p.starts_at,6,2) AS INTEGER)||'월 '||CAST(substr(p.starts_at,9,2) AS INTEGER)||'일 '||substr(p.starts_at,12,5),'만료',CAST(substr(p.ends_at,6,2) AS INTEGER)||'월 '||CAST(substr(p.ends_at,9,2) AS INTEGER)||'일 '||substr(p.ends_at,12,5),'금액',?)";
  batch.push(sql(`INSERT OR IGNORE INTO notification_jobs(dedupe_key,kind,customer_id,pass_id,phone,vars,send_after)
   SELECT 'purchase:'||p.id,'purchase',p.customer_id,p.id,c.phone,${vars},? FROM passes p JOIN customers c ON c.id=p.customer_id WHERE p.id=? AND ${gate}`,Number(p.amount).toLocaleString('ko-KR'),now,p.id,op));
 }
 for(const key of new Set(s.passes.map(p=>p.customer_id+'|'+p.pass_group))){const [cid,group]=key.split('|');batch.push(...expiryStmts(env,Number(cid),group,op,now));}
 await env.DB.batch(batch);
 const applied=await env.DB.prepare('SELECT * FROM website_schedule_changes WHERE request_id=?').bind(requestId).first();
 if(!applied || applied.oid!==order.oid || applied.old_start!==expectedStart || applied.new_start!==chosen.value)return {error:'conflict',status:409,message:'이용이 시작되었거나 일정·결제 상태가 변경되었습니다. 최신 내역을 확인해 주세요.'};
 return {ok:true,duplicate:applied.operation_token!==op};
}
