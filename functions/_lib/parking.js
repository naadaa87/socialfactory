import {json,clean,phoneDigits,formatPhone,safeEqual,getMember,sha256Hex} from './auth.js';
import {ensurePayapp} from './payapp.js';
import {kstNow} from './admin.js';
import {orderToken} from './shop.js';
import {getGuest,ownsGuestOrder} from './guest-orders.js';
export const PARKING_POLICY='sf-parking-20261114-instant-v3';
export const TICKETS={'1h':{label:'1시간권',price:4000,hours:1},'2h':{label:'2시간권',price:8000,hours:2},'3h':{label:'3시간권',price:12000,hours:3},daily:{label:'일일권',price:30000,hours:null}};
export const PARKING_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS parking_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS parking_orders(oid TEXT PRIMARY KEY,payment_oid TEXT NOT NULL REFERENCES orders(oid),vehicle_price INTEGER NOT NULL CHECK(vehicle_price>0),ticket TEXT NOT NULL,plate TEXT NOT NULL,visit_date TEXT NOT NULL,terms TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',version INTEGER NOT NULL DEFAULT 0,operation_key TEXT,arrival_at TEXT,entry_id TEXT,entry_at TEXT,applied_at TEXT,request_at TEXT,request_reason TEXT,reviewed_at TEXT,memo TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT)`,
 `CREATE INDEX IF NOT EXISTS idx_parking_payment ON parking_orders(payment_oid)`,
 `CREATE INDEX IF NOT EXISTS idx_parking_queue ON parking_orders(status,visit_date)`,
 `CREATE TABLE IF NOT EXISTS parking_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,oid TEXT NOT NULL REFERENCES parking_orders(oid),kind TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,refund_amount INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,message_id TEXT,last_error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT,sent_at TEXT)`,
 `CREATE INDEX IF NOT EXISTS idx_parking_events_due ON parking_events(status,id)`,
 `CREATE TABLE IF NOT EXISTS parking_history(id INTEGER PRIMARY KEY AUTOINCREMENT,oid TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),UNIQUE(oid,version))`
];
// 기존 1차량 주문·알림 ID를 그대로 보존하며 결제와 차량 등록을 분리합니다.
export const PARKING_MULTI_MIGRATION=[
 `CREATE TABLE parking_multi_guard(version INTEGER CHECK(version=0))`,
 `INSERT INTO parking_multi_guard SELECT COUNT(*) FROM pragma_table_info('parking_orders') WHERE name='payment_oid'`,
 `CREATE TABLE parking_orders_multi AS SELECT p.*,p.oid AS payment_oid,o.amount AS vehicle_price FROM parking_orders p JOIN orders o ON o.oid=p.oid`,
 `CREATE TABLE parking_events_multi AS SELECT * FROM parking_events`,
 `DROP TABLE parking_events`, `DROP TABLE parking_orders`,
 PARKING_SCHEMA[1],
 `INSERT INTO parking_orders(oid,payment_oid,vehicle_price,ticket,plate,visit_date,terms,status,version,operation_key,arrival_at,entry_id,entry_at,applied_at,request_at,request_reason,reviewed_at,memo,created_at,updated_at) SELECT oid,payment_oid,vehicle_price,ticket,plate,visit_date,terms,status,version,operation_key,arrival_at,entry_id,entry_at,applied_at,request_at,request_reason,reviewed_at,memo,created_at,updated_at FROM parking_orders_multi`,
 PARKING_SCHEMA[4],
 `INSERT INTO parking_events SELECT * FROM parking_events_multi`,
 `DROP TABLE parking_events_multi`, `DROP TABLE parking_orders_multi`, `DROP TABLE parking_multi_guard`
];
export async function ensureParking(env){
 await ensurePayapp(env);
 const {results}=await env.DB.prepare('PRAGMA table_info(parking_orders)').all();
 if(results.length&&!results.some(c=>c.name==='payment_oid')){
  try{await env.DB.batch(PARKING_MULTI_MIGRATION.map(q=>env.DB.prepare(q)));}
  catch(e){const latest=await env.DB.prepare('PRAGMA table_info(parking_orders)').all();if(!latest.results.some(c=>c.name==='payment_oid'))throw e;}
 }
 await env.DB.batch(PARKING_SCHEMA.map(q=>env.DB.prepare(q)));
}
export const defaults={enabled:false,confirmed:false,daily_enabled:false,process_minutes:10,daily_details:"이용일 당일 23:59까지(한국시간). 입차 후 24시간권이 아닙니다. 재입차는 구매 전에 문의해 주세요. 결제 후 구매 내역에서 차량별 입차 등록을 요청해 주세요. 주말·공휴일·야간에도 자동 등록합니다. 익일·초과 정산: 자정 이후 계속 주차하려면 다음 날 날짜의 시간권 또는 일일권을 별도로 구매해야 합니다. 할인 적용 완료를 확인하고 출차해 주세요.",holidays:[]};
export async function parkingSettings(env){const row=await env.DB.prepare('SELECT value FROM parking_settings WHERE id=1').first();let v={};try{v=JSON.parse(row?.value||'{}')}catch{}const s={...defaults,...v};return {...s,daily_details:registrationDetails(s.daily_details)};}
export const registrationDetails=text=>String(text||'').replace('결제 후 입차 알림과 운영자의 등록이 필요합니다.','결제 후 구매 내역에서 차량별 입차 등록을 요청해 주세요. 주말·공휴일·야간에도 자동 등록합니다.').replace('야간·운영시간 외 등록·출차는 구매 전에 문의해 주세요.','할인 적용 완료를 확인하고 출차해 주세요.');
export const parkingPolicyTag=s=>sha256Hex(JSON.stringify([PARKING_POLICY,'24/7',s.process_minutes,s.daily_enabled,registrationDetails(s.daily_details),TICKETS]));
export const hhmm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
export const operationText=s=>'자동 등록: 매일 24시간 (주말·공휴일·야간 포함). 결제 승인 후 바로 입차를 확인해 등록하며, 미입차 차량은 1분 간격으로 다시 확인합니다.';
export function validDate(s){try{return /^\d{4}-\d{2}-\d{2}$/.test(s||'') && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}catch{return false}}
// 과거 수동 운영 시간·휴무일 설정은 보존하지만 자동 등록을 제한하지 않습니다.
export function openDate(s){return validDate(s);}
export function arrivalOpen(s,now=kstNow()){return s.confirmed&&openDate(now.slice(0,10));}
export function plateOf(v){const s=String(v||'').normalize('NFKC').replace(/[\s-]/g,'');return /^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/.test(s)?s:null;}
export function validateParking(b,s){
 const ticket=typeof b.ticket==='string'&&Object.hasOwn(TICKETS,b.ticket)?TICKETS[b.ticket]:null,plate=plateOf(b.plate),date=clean(b.date,10),name=clean(b.name,30),phone=phoneDigits(b.phone);
 if(!ticket)return {error:'주차권을 선택해 주세요.'};
 if(b.ticket==='daily'&&!s.daily_enabled)return {error:'일일권 판매 조건을 확인 중입니다. 카카오톡으로 문의해 주세요.'};
 if(!plate||plateOf(b.plateConfirm)!==plate)return {error:'차량번호 전체를 두 번 동일하게 입력해 주세요. 예: 123가4567'};
 const today=kstNow().slice(0,10),limit=new Date(Date.now()+9*3600e3+90*864e5).toISOString().slice(0,10);
 if(!openDate(date)||date<today||date>limit)return {error:'오늘부터 90일 안의 유효한 이용일을 선택해 주세요. 주말·공휴일도 이용할 수 있습니다.'};
 if(date===today&&!arrivalOpen(s))return {error:'주차 등록 운영 조건을 확인 중입니다. 잠시 후 다시 확인해 주세요.'};
 if(!name||!/^01[016789]\d{7,8}$/.test(phone))return {error:'이름과 휴대폰 번호를 확인해 주세요.'};
 if(b.agreeTerms!==true||b.agreePrivacy!==true||b.agreeRefund!==true||b.confirmed!==true||b.policy!==PARKING_POLICY)return {error:'구매 내용과 주차 등록·취소 안내를 확인해 주세요.'};
 return {ticket:b.ticket,plate,date,name,phone:formatPhone(phone),...ticket};
}
export function validateParkingVehicles(b,s){
 const vehicles=b.vehicles===undefined?[{ticket:b.ticket,plate:b.plate,plateConfirm:b.plateConfirm}]:b.vehicles;
 if(!Array.isArray(vehicles)||vehicles.length<1||vehicles.length>10)return {error:'차량은 1대부터 최대 10대까지 구매할 수 있습니다.'};
 const items=[],seen=new Set();
 for(const [i,v]of vehicles.entries()){
  if(!v||typeof v!=='object'||Array.isArray(v))return {error:'차량 정보를 확인해 주세요.'};
  const item=validateParking({...b,ticket:v.ticket,plate:v.plate,plateConfirm:v.plateConfirm},s);
  if(item.error)return {error:'차량 '+(i+1)+': '+item.error};
  if(seen.has(item.plate))return {error:'같은 차량번호를 두 번 입력했습니다. 차량마다 한 번씩 입력해 주세요.'};
  seen.add(item.plate);items.push(item);
 }
 return {items};
}
export const PARKING_JOIN=`SELECT p.*,o.id AS order_id,o.status AS payment_status,o.product_id,o.product_name,o.amount AS payment_amount,p.vehicle_price AS amount,o.buyer_name,o.buyer_phone,o.member_id,o.paid_at,o.test_mode,pg.refunded_amount,pg.payurl FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid`;
export async function parkingOrder(env,oid){return env.DB.prepare(PARKING_JOIN+' WHERE p.oid=?').bind(oid).first();}
export async function parkingItems(env,oid){const {results}=await env.DB.prepare(PARKING_JOIN+' WHERE p.payment_oid=? ORDER BY p.created_at,p.rowid').bind(oid).all();return results;}
export const PARKING_STATUS={waiting:'아마노 입차 확인 대기',requested:'입차 요청 접수',processing:'등록 처리 중',applied:'할인 적용 완료',issue:'등록 확인 필요'};
export function publicParking(p,s=defaults){let terms={};try{terms=JSON.parse(p.terms)}catch{}return {oid:p.oid,paymentOid:p.payment_oid,ticket:p.ticket,ticketLabel:TICKETS[p.ticket]?.label,plate:p.plate,date:p.visit_date,status:p.status,statusLabel:PARKING_STATUS[p.status],paymentStatus:p.payment_status,amount:p.amount,refundedAmount:p.payment_amount===p.amount?p.refunded_amount:p.refunded_amount>=p.payment_amount?p.amount:0,paymentRefundedAmount:p.refunded_amount,refundHold:p.refunded_amount>0&&p.refunded_amount<p.payment_amount,arrivalAt:p.arrival_at,appliedAt:p.applied_at,requestedAt:p.request_at,reviewedAt:p.reviewed_at,version:p.version,operation:operationText(s),dailyDetails:registrationDetails(terms.dailyDetails),createdAt:p.created_at};}
export async function parkingAccess(request,env,oid,token){const p=await parkingOrder(env,oid);if(!p)return false;const o=await env.DB.prepare('SELECT * FROM orders WHERE oid=?').bind(p.payment_oid).first();if(!o)return false;const m=await getMember(request,env);return safeEqual(String(token||''),await orderToken(env,p.payment_oid))||safeEqual(String(token||''),await orderToken(env,oid))||!!(m&&m.id===o.member_id)||ownsGuestOrder(await getGuest(request,env),o);}
export function eventStmt(env,p,kind,{version=p.version,refund=p.refunded_amount||0,operation=null}={}){const key=p.oid+':'+kind+':'+(kind==='refund'?refund:kind==='paid'||kind==='arrival'?0:version);return env.DB.prepare(`INSERT OR IGNORE INTO parking_events(event_key,oid,kind,version,refund_amount) SELECT ?,?,?,?,? FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid WHERE p.oid=? AND p.version=? AND (? IS NULL OR p.operation_key=?) AND o.test_mode=0 AND (CASE WHEN ?='refund' THEN pg.refunded_amount>=? AND ?>0 AND (p.vehicle_price=o.amount OR pg.refunded_amount>=o.amount) ELSE o.status='paid' AND o.paid_at IS NOT NULL AND o.tid=pg.mul_no AND pg.refunded_amount=0 END)`).bind(key,p.oid,kind,version,refund,p.oid,version,operation,operation,kind,refund,refund);}
// 콜백 재시도·누락 복구도 동일 이벤트 키를 쓰므로 한 번만 발송 대기열에 들어갑니다.
export async function syncParkingOrder(env,oid){await ensureParking(env);const items=await parkingItems(env,oid),batch=[];for(const p of items){if(p.payment_status==='paid'&&p.paid_at&&!p.refunded_amount)batch.push(eventStmt(env,p,'paid'));if(p.refunded_amount>0)batch.push(eventStmt(env,p,'refund'));}if(batch.length)await env.DB.batch(batch);}
export async function parkingAction(env,p,b,admin=false){
 const s=await parkingSettings(env),now=kstNow(),action=b.action,version=p.version+1,operation=crypto.randomUUID(),sql=(q,...a)=>env.DB.prepare(q.startsWith('UPDATE parking_orders SET ')?q.replace(' SET '," SET operation_key='"+operation+"',"):q).bind(...a);let update,event,note='';
 if(!Number.isInteger(b.expectedVersion)||b.expectedVersion!==p.version)return {error:'상태가 변경되었습니다. 새로고침 후 확인해 주세요.',status:409};
 const paid="EXISTS(SELECT 1 FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid WHERE o.oid=parking_orders.payment_oid AND o.status='paid' AND o.paid_at IS NOT NULL AND pg.refunded_amount=0)";
 if(action==='arrival'&&!admin){
  if(p.arrival_at)return {ok:true,duplicate:true};
  if(!arrivalOpen(s)||p.visit_date!==now.slice(0,10))return {error:'이용일 당일의 등록 접수 시간에 요청해 주세요. '+operationText(s),status:409};
  update=sql(`UPDATE parking_orders SET status='requested',arrival_at=?,version=?,updated_at=? WHERE oid=? AND version=? AND status='waiting' AND (request_at IS NULL OR reviewed_at IS NOT NULL) AND ${paid}`,now,version,now,p.oid,p.version);event='arrival';
 }else if(action==='request'&&!admin){
  note=clean(b.reason,300);if(!note)return {error:'취소·정정 문의 내용을 입력해 주세요.',status:400};
  if(p.request_at&&!p.reviewed_at)return {ok:true,duplicate:true};
  update=sql(`UPDATE parking_orders SET request_at=?,request_reason=?,reviewed_at=NULL,version=?,updated_at=? WHERE oid=? AND version=? AND ${paid}`,now,note,version,now,p.oid,p.version);
 }else if(admin&&action==='claim'){
  const at=String(b.entryAt||'').replace('T',' ').slice(0,16)+':00',entry=clean(b.entryId,80);
  if(!['requested','issue'].includes(p.status)||p.visit_date!==now.slice(0,10)||!s.confirmed)return {error:'이용일 당일 접수된 입차 요청만 처리해 주세요.',status:409};
  if(plateOf(b.plateConfirm)!==p.plate||b.confirmEntry!==true||!entry||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(at)||!validDate(at.slice(0,10))||at.slice(0,10)!==p.visit_date||at>now)return {error:'아마노 입차번호·입차시각·차량번호를 확인해 주세요.',status:400};
  update=sql(`UPDATE parking_orders SET status='processing',arrival_at=COALESCE(arrival_at,?),entry_id=?,entry_at=?,version=?,memo=?,updated_at=? WHERE oid=? AND version=? AND (request_at IS NULL OR reviewed_at IS NOT NULL) AND ${paid}`,now,entry,at,version,clean(b.memo,500),now,p.oid,p.version);
 }else if(admin&&action==='complete'){
  if(p.status!=='processing'||b.confirmApplied!==true||!p.entry_id||!p.entry_at)return {error:'아마노에서 실제 할인 적용을 완료했는지 확인해 주세요.',status:409};
  update=sql(`UPDATE parking_orders SET status='applied',applied_at=?,version=?,memo=?,updated_at=? WHERE oid=? AND version=? AND status='processing' AND (request_at IS NULL OR reviewed_at IS NOT NULL) AND ${paid}`,now,version,clean(b.memo,500),now,p.oid,p.version);event='applied';
 }else if(admin&&action==='issue'){
  note=clean(b.memo,500);if(!note||p.status==='applied')return {error:'확인이 필요한 사유를 입력해 주세요. 이미 적용된 주문은 되돌리지 않습니다.',status:400};
  update=sql(`UPDATE parking_orders SET status='issue',memo=?,version=?,updated_at=? WHERE oid=? AND version=? AND ${paid}`,note,version,now,p.oid,p.version);
 }else if(admin&&action==='review'){
  note=clean(b.memo,500);if(!p.request_at||p.reviewed_at||!note)return {error:'문의 처리 메모를 입력해 주세요.',status:400};
  update=sql('UPDATE parking_orders SET reviewed_at=?,memo=?,version=?,updated_at=? WHERE oid=? AND version=?',now,note,version,now,p.oid,p.version);
 }else return {error:'지원하지 않는 요청입니다.',status:400};
 const batch=[update,sql('INSERT OR IGNORE INTO parking_history(oid,action,version,note) SELECT oid,?,?,? FROM parking_orders WHERE oid=? AND version=? AND operation_key=?',action,version,note,p.oid,version,operation)];
 if(event)batch.push(eventStmt(env,p,event,{version,operation}));
 const result=await env.DB.batch(batch);if(!result[0].meta.changes)return {error:'결제·처리 상태가 변경되었습니다. 새로고침 후 확인해 주세요.',status:409};return {ok:true};
}
