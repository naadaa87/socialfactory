// 홈페이지 주문을 고객·이용권에 연결합니다. 매출 원장은 orders이며 website 결제 사본은 합산하지 않습니다.
import {ensureSchema,kstNow} from './admin.js';
import {phoneDigits,formatPhone} from './auth.js';
import {addDuration,fromMs,toMs,validMobile,queuePassNotices,expiryNoticeStmts,queueRefundNotice} from './kiosk.js';
import {PRODUCT_MAP} from './products.js';
import {splitVat} from './kiosk-products.js';

export const WEBSITE_PASS_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS website_order_terms (oid TEXT PRIMARY KEY REFERENCES orders(oid),terms TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS website_order_passes (oid TEXT NOT NULL REFERENCES orders(oid),unit INTEGER NOT NULL,payment_key TEXT NOT NULL UNIQUE,redeem_by TEXT,PRIMARY KEY(oid,unit))`
];
export async function ensureWebsitePasses(env){
 await ensureSchema(env);
 await env.DB.batch(WEBSITE_PASS_SCHEMA.map(s=>env.DB.prepare(s)));
}
export function websiteTerms(product,startAt=null){
 const rules={
  'cowork-2h':{group:'seat',duration:{hours:2},activation:'checkin',redeemDays:90,remind:[20]},
  'cowork-day':{group:'seat',duration:{days:1},activation:'checkin',redeemDays:90,endOfDay:true,remind:[120]},
  'cowork-month':{group:'seat',duration:{months:1},activation:'date',remind:[4320,1440]},
  'locker-month':{group:'locker',duration:{months:1},activation:'date',remind:[4320,1440]}
 };
 const rule=product && rules[product.id];
 return rule ? {id:product.id,name:product.name,...rule,...(rule.activation==='checkin' && startAt ? {activation:'scheduled',startAt} : {})} : null;
}
const eligible="o.status IN ('paid','refund_requested') AND o.paid_at IS NOT NULL AND EXISTS(SELECT 1 FROM payapp_payments pg WHERE pg.oid=o.oid AND pg.mul_no=o.tid)";
const payKey=(oid,unit)=>'WEB_'+oid+'_'+unit;
// 기존 주문도 서버에 저장된 승인 결과로만 복구합니다. 브라우저의 금액·상태는 사용하지 않습니다.
export async function syncWebsiteOrder(env,oid){
 await ensureWebsitePasses(env);
 const order=await env.DB.prepare('SELECT o.*,COALESCE(pg.refunded_amount,0) AS refunded_amount FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid WHERE o.oid=?').bind(oid).first();
 if(!order) return {issued:0};
 let saved=await env.DB.prepare('SELECT terms FROM website_order_terms WHERE oid=?').bind(oid).first();
 const terms=saved ? JSON.parse(saved.terms) : websiteTerms(PRODUCT_MAP[order.product_id]);
 if(!terms) return {issued:0}; // 노트북 대여 옵션은 좌석 이용권으로 바꾸지 않습니다.
 if(!validMobile(order.buyer_phone)) throw Error('invalid-website-customer');
 const qty=Number(order.qty);if(!Number.isInteger(qty)||qty<1||qty>10) throw Error('invalid-website-quantity');
 const phone=phoneDigits(order.buyer_phone),sql=(s,...args)=>env.DB.prepare(s).bind(...args);
 const batch=[sql(`INSERT INTO customers(phone,phone_fmt,name,privacy_agreed_at)
  SELECT ?,?,?,o.created_at FROM orders o WHERE o.oid=? AND ${eligible}
  ON CONFLICT(phone) DO UPDATE SET name=CASE WHEN COALESCE(customers.name,'')='' THEN excluded.name ELSE customers.name END,updated_at=datetime('now','+9 hours')`,phone,formatPhone(phone),order.buyer_name,oid)];
 if(!saved) batch.push(sql('INSERT OR IGNORE INTO website_order_terms(oid,terms) VALUES (?,?)',oid,JSON.stringify(terms)));
 const now=order.paid_at||kstNow(),redeem=terms.activation==='checkin'?fromMs(toMs(now)+terms.redeemDays*864e5):null;
 const base=terms.activation==='scheduled' ? terms.startAt : terms.activation==='date' && /^\d{4}-\d{2}-\d{2}$/.test(order.start_date||'') ? order.start_date+' 00:00:00' : now;
 const unitAmount=Math.floor(order.amount/qty),before=await env.DB.prepare('SELECT COUNT(*) AS n FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=?').bind(oid).first();
 let scheduledCursor=base;
 for(let n=1;n<=qty;n++){
  const key=payKey(oid,n),amount=unitAmount+(n<=order.amount%qty?1:0),{tax,supplyValue}=splitVat(amount);
  const starts=terms.activation==='checkin'?now:scheduledCursor;
  const ends=redeem||(terms.activation==='scheduled' && terms.endOfDay ? fromMs(toMs(starts.slice(0,10)+' 00:00:00')+864e5) : addDuration(starts,terms.duration));
  if(!redeem)scheduledCursor=ends;
  batch.push(sql(`INSERT OR IGNORE INTO website_order_passes(oid,unit,payment_key,redeem_by) SELECT o.oid,?,?,? FROM orders o WHERE o.oid=? AND ${eligible}`,n,key,redeem,oid));
  batch.push(sql(`INSERT OR IGNORE INTO pass_payments(payment_key,status,channel,customer_id,product_id,product_name,amount,tax,supply,pay_method,tid,card_issuer,masked_card,paid_at,test_mode,admin_memo)
   SELECT ?,'paid','website',c.id,o.product_id,?,?,?,?,o.pg_method,o.tid,o.card_name,o.card_num,o.paid_at,o.test_mode,?
   FROM orders o JOIN customers c ON c.phone=? JOIN website_order_passes w ON w.oid=o.oid AND w.payment_key=? WHERE o.oid=? AND ${eligible}`,key,terms.name,amount,tax,supplyValue,'홈페이지 주문 '+oid+' ('+n+'/'+qty+')',phone,key,oid));
  batch.push(sql(`INSERT OR IGNORE INTO kiosk_payment_terms(payment_key,terms) SELECT ?,? WHERE EXISTS(SELECT 1 FROM pass_payments WHERE payment_key=?)`,key,JSON.stringify(terms),key));
  batch.push(sql(`INSERT OR IGNORE INTO passes(code,payment_id,customer_id,product_id,product_name,pass_group,starts_at,ends_at,status,source,memo)
   SELECT ?,pp.id,pp.customer_id,pp.product_id,pp.product_name,?,?,?,?, 'website',?
   FROM pass_payments pp JOIN orders o ON o.oid=? WHERE pp.payment_key=? AND ${eligible}`,
   'W'+oid.slice(2)+'-'+n,terms.group,starts,ends,terms.activation==='checkin'?'ready':'active','홈페이지 주문 '+oid,oid,key));
 }
 await env.DB.batch(batch);
 // 환불은 현재 DB 원장을 다시 읽어 반영합니다. 승인/취소 통보 순서가 뒤바뀌어도 복구됩니다.
 await syncWebsiteRefund(env,oid);
 const after=await env.DB.prepare('SELECT COUNT(*) AS n FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=?').bind(oid).first();
 const {results:active}=await env.DB.prepare("SELECT p.* FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=? AND p.status='active' AND pp.status='paid'").bind(oid).all();
 for(const pass of active){const pay=await env.DB.prepare('SELECT * FROM pass_payments WHERE id=?').bind(pass.payment_id).first();await queuePassNotices(env,pass,pay,{purchaseNotice:terms.activation==='scheduled'});}
 return {issued:Math.max(0,after.n-before.n)};
}
export async function syncWebsiteRefund(env,oid){
 const order=await env.DB.prepare('SELECT o.status,o.amount,pg.refunded_amount FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid WHERE o.oid=?').bind(oid).first();
 if(!order)return;
 const {results:items}=await env.DB.prepare('SELECT p.*,pp.amount,pp.payment_key,w.unit FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=? ORDER BY w.unit').bind(oid).all();
 const sql=(s,...a)=>env.DB.prepare(s).bind(...a),batch=[];
 let preceding=0;
 for(const p of items){
  const offset=preceding;preceding+=p.amount;
  const refundExpr="MAX(refund_amount,MIN(amount,MAX(0,(SELECT refunded_amount FROM payapp_payments WHERE oid=?1)-?2)))";
  batch.push(sql(`UPDATE pass_payments SET refund_amount=${refundExpr},status=CASE WHEN ${refundExpr}>=amount THEN 'refunded' ELSE status END,
   refunded_at=CASE WHEN ${refundExpr}>0 THEN COALESCE(refunded_at,datetime('now','+9 hours')) ELSE refunded_at END,updated_at=datetime('now','+9 hours') WHERE id=?3`,oid,offset,p.payment_id));
  // 부분 환불은 이용 기간을 임의로 줄이지 않습니다. 전액 환불된 단위 이용권만 취소합니다.
  batch.push(sql("UPDATE passes SET status='cancelled',updated_at=datetime('now','+9 hours') WHERE id=? AND EXISTS(SELECT 1 FROM pass_payments WHERE id=passes.payment_id AND refund_amount>=amount)",p.id));
  batch.push(sql("UPDATE notification_jobs SET status='cancelled' WHERE pass_id=? AND status='queued' AND EXISTS(SELECT 1 FROM passes WHERE id=? AND status='cancelled')",p.id,p.id));
 }
 if(batch.length) await env.DB.batch(batch);
 for(const p of items){if(order.refunded_amount>0){await queueRefundNotice(env,p);const c=await env.DB.prepare('SELECT * FROM customers WHERE id=?').bind(p.customer_id).first();if(c)await env.DB.batch(await expiryNoticeStmts(env,c,p.pass_group));}}
}
export async function checkInWebsitePass(env,id){
 await ensureWebsitePasses(env);
 const p=await env.DB.prepare(`SELECT p.*,pp.payment_key,w.redeem_by,t.terms FROM passes p JOIN pass_payments pp ON pp.id=p.payment_id
 JOIN website_order_passes w ON w.payment_key=pp.payment_key JOIN website_order_terms t ON t.oid=w.oid WHERE p.id=?`).bind(id).first();
 if(!p)return {error:'not-found'};
 if(p.status!=='ready'){
  if(p.status!=='active')return {error:'not-ready'};
  const pay=await env.DB.prepare('SELECT * FROM pass_payments WHERE id=?').bind(p.payment_id).first();
  await queuePassNotices(env,p,pay,{purchaseNotice:false});
  return {pass:p,duplicate:true};
 }
 const now=kstNow();if(p.redeem_by<=now || p.ends_at<=now)return {error:'expired'};
 const t=JSON.parse(p.terms),end=t.endOfDay ? fromMs(toMs(now.slice(0,10)+' 00:00:00')+864e5):addDuration(now,t.duration);
 const r=await env.DB.prepare(`UPDATE passes SET status='active',starts_at=?,ends_at=?,updated_at=datetime('now','+9 hours') WHERE id=? AND status='ready' AND ends_at>?
 AND EXISTS(SELECT 1 FROM pass_payments pp JOIN website_order_passes w ON w.payment_key=pp.payment_key JOIN orders o ON o.oid=w.oid JOIN payapp_payments pg ON pg.oid=o.oid WHERE pp.id=passes.payment_id AND pp.status='paid' AND o.status IN ('paid','refund_requested') AND pg.refunded_amount<o.amount) AND NOT EXISTS(SELECT 1 FROM passes other WHERE other.customer_id=passes.customer_id AND other.pass_group=passes.pass_group AND other.status='active' AND other.id<>passes.id AND other.starts_at<=?5 AND other.ends_at>?5)`).bind(now,end,id,now,now).run();
 const pass=await env.DB.prepare('SELECT * FROM passes WHERE id=?').bind(id).first();
 if(pass.status!=='active')return {error:'not-ready'};
 if(r.meta.changes){const pay=await env.DB.prepare('SELECT * FROM pass_payments WHERE id=?').bind(pass.payment_id).first();await queuePassNotices(env,pass,pay,{purchaseNotice:false});}
 return {pass,duplicate:!r.meta.changes};
}
// 관리자 화면의 자동 복구. PG 승인이 저장된 주문만 대상으로 하며 요청마다 제한합니다.
export async function syncWebsiteOrders(env,{limit=50}={}){
 await ensureWebsitePasses(env);
 const {results:rows}=await env.DB.prepare(`SELECT o.oid FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid WHERE (${eligible} OR (o.status='refunded' AND EXISTS(SELECT 1 FROM website_order_passes WHERE oid=o.oid)))
 AND o.product_id IN ('cowork-2h','cowork-day','cowork-month','locker-month') AND (
 (SELECT COUNT(*) FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key JOIN passes p ON p.payment_id=pp.id WHERE w.oid=o.oid)<o.qty
 OR (SELECT COALESCE(SUM(pp.refund_amount),0) FROM website_order_passes w JOIN pass_payments pp ON pp.payment_key=w.payment_key WHERE w.oid=o.oid)<>pg.refunded_amount) ORDER BY o.id LIMIT ?`).bind(limit).all();
 let issued=0;for(const row of rows)issued+=(await syncWebsiteOrder(env,row.oid)).issued;
 return {orders:rows.length,issued};
}
