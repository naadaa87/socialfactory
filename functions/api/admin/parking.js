import {adminGate} from '../../_lib/admin.js';
import {json,sameOrigin,clean} from '../../_lib/auth.js';
import {ensureParking,parkingSettings,parkingOrder,parkingAction,PARKING_JOIN,publicParking,operationText} from '../../_lib/parking.js';
import {parkingTemplateStatus,runParkingQueue} from '../../_lib/parking-notify.js';
import {parkingWorkbook} from '../../_lib/parking-xlsx.js';
import {payConfig} from '../../_lib/shop.js';
export async function onRequestGet({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;await ensureParking(env);
 const params=new URL(request.url).searchParams,q=clean(params.get('q'),60),filter=params.get('filter')||'all',start=params.get('start')||'',end=params.get('end')||'',basis=params.get('basis')||'paid';
 const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 if(start&&!validDate(start)||end&&!validDate(end)||start&&end&&start>end||!['paid','visit'].includes(basis))return json({ok:false,message:'조회 기간을 확인해 주세요.'},400);
 const exporting=params.get('export')==='xlsx';
 if(params.has('export')&&!exporting)return json({ok:false,message:'지원하지 않는 파일 형식입니다.'},400);
 let where='',args=[];
 if(filter==='queue')where=" AND o.status='paid' AND (p.status<>'applied' OR p.request_at IS NOT NULL AND p.reviewed_at IS NULL)";
 else if(filter==='paid')where=" AND o.status='paid'";
 else if(filter==='applied')where=" AND p.status='applied'";
 else if(filter==='requested')where=" AND p.arrival_at IS NOT NULL AND p.status<>'applied' AND o.status='paid'";
 if(q){where+=' AND (p.plate LIKE ? OR p.oid LIKE ? OR p.payment_oid LIKE ? OR o.buyer_phone LIKE ? OR o.buyer_name LIKE ?)';args.push(...Array(5).fill('%'+q+'%'));}
 const dateColumn=basis==='visit'?'p.visit_date':'o.paid_at';
 if(start){where+=' AND '+dateColumn+'>=?';args.push(start);}
 if(end){where+=' AND '+dateColumn+(basis==='visit'?'<=?':"<datetime(?,'+1 day')");args.push(end);}
 const paid="o.test_mode=0 AND o.paid_at IS NOT NULL AND o.tid=pg.mul_no AND o.status IN ('paid','refunded')";
 const summary=await env.DB.prepare("SELECT COUNT(*) AS matchedVehicles,COALESCE(SUM(CASE WHEN "+paid+" THEN 1 ELSE 0 END),0) AS paidVehicles,COUNT(DISTINCT CASE WHEN "+paid+" THEN p.payment_oid END) AS paymentCount,COALESCE(SUM(CASE WHEN "+paid+" THEN p.vehicle_price ELSE 0 END),0) AS selectedVehicleAmount FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid WHERE 1=1"+where).bind(...args).first();
 // 환불은 통합 결제 단위 원장이므로 차량별로 나누거나 중복 차감하지 않습니다.
 const settlement=await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS paidAmount,COALESCE(SUM(refunded),0) AS refundedAmount,COALESCE(SUM(amount-refunded),0) AS netAmount FROM (SELECT o.oid,o.amount,MAX(pg.refunded_amount) AS refunded FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid WHERE "+paid+where+" GROUP BY o.oid,o.amount)").bind(...args).first();
 Object.assign(summary,settlement);
 const {results}=await env.DB.prepare(PARKING_JOIN+' WHERE 1=1'+where+" ORDER BY CASE WHEN p.request_at IS NOT NULL AND p.reviewed_at IS NULL THEN 0 WHEN p.arrival_at IS NOT NULL AND p.status<>'applied' THEN 1 ELSE 2 END,p.created_at DESC"+(exporting?"":" LIMIT 200")).bind(...args).all();
 if(exporting){
  const {results:payments}=await env.DB.prepare("SELECT o.oid,o.paid_at AS paidAt,o.buyer_name AS name,o.buyer_phone AS phone,o.status,o.amount,MAX(pg.refunded_amount) AS refundedAmount,COUNT(*) AS vehicleCount FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid WHERE "+paid+where+" GROUP BY o.oid ORDER BY o.paid_at DESC,o.oid").bind(...args).all();
  const s=await parkingSettings(env),vehicles=results.map(p=>({...publicParking(p,s),name:p.buyer_name,phone:p.buyer_phone,paidAt:p.paid_at,testMode:!!p.test_mode}));
  const body=parkingWorkbook({vehicles,payments,summary,period:{start,end,basis},filter,q,generatedAt:new Date(Date.now()+9*3600e3).toISOString().slice(0,19).replace('T',' ')});
  return new Response(body,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="parking-'+(start||'all')+'_'+(end||'all')+'.xlsx"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 const {results:events}=await env.DB.prepare("SELECT id,oid,kind,status,message_id,last_error,created_at,sent_at FROM parking_events ORDER BY id DESC LIMIT 100").all();
 const s=await parkingSettings(env);return json({ok:true,queryFilter:filter,queryText:q,summary,period:{start,end,basis},settings:s,operation:operationText(s),templates:await parkingTemplateStatus(env),payReady:payConfig(env).ready,events,results:results.map(p=>({...publicParking(p,s),paidAt:p.paid_at,paymentAmount:p.payment_amount,name:p.buyer_name,phone:p.buyer_phone,entryId:p.entry_id,entryAt:p.entry_at,memo:p.memo,requestReason:p.request_reason}))});
}
export async function onRequestPost({request,env,waitUntil}){
 const deny=await adminGate(request,env);if(deny)return deny;if(!sameOrigin(request))return json({ok:false},403);
 const raw=await request.text();if(raw.length>8192)return json({ok:false},413);let b;try{b=JSON.parse(raw)}catch{return json({ok:false},400)}if(!b||typeof b!=='object')return json({ok:false},400);
 await ensureParking(env);
 if(b.action==='settings'){
  const old=await parkingSettings(env),s={...old,enabled:b.enabled===true,confirmed:b.confirmed===true,daily_enabled:b.dailyEnabled===true,daily_details:clean(b.dailyDetails,400)};
  s.process_minutes=b.processMinutes;
  if(!Number.isInteger(s.process_minutes)||s.process_minutes<1||s.process_minutes>180)return json({ok:false,message:'최대 처리 시간을 확인해 주세요.'},400);
  if(s.daily_enabled&&!s.daily_details)return json({ok:false,message:'일일권 종료·재입차·초과 정산 조건을 입력해 주세요.'},400);
  if(s.enabled&&(!s.confirmed||(!payConfig(env).ready||payConfig(env).provider!=='payapp')||!(await parkingTemplateStatus(env)).every(t=>t.approved)))return json({ok:false,message:'운영 조건 확인·페이앱 연결·주차 알림톡 4종 승인을 완료한 뒤 판매를 시작해 주세요.'},409);
  await env.DB.prepare('INSERT INTO parking_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(JSON.stringify(s)).run();return json({ok:true});
 }
 const p=await parkingOrder(env,clean(b.oid,40));if(!p)return json({ok:false},404);const r=await parkingAction(env,p,b,true);if(r.ok&&waitUntil)waitUntil(runParkingQueue(env));return json({...r,ok:!!r.ok,...(r.error?{message:r.error}:{})},r.status||200);
}
