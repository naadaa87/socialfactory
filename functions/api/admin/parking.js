import {adminGate} from '../../_lib/admin.js';
import {json,sameOrigin,clean} from '../../_lib/auth.js';
import {ensureParking,parkingSettings,parkingOrder,parkingAction,PARKING_JOIN,publicParking,validDate,operationText} from '../../_lib/parking.js';
import {parkingTemplateStatus,runParkingQueue} from '../../_lib/parking-notify.js';
import {payConfig} from '../../_lib/shop.js';
export async function onRequestGet({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;await ensureParking(env);
 const q=clean(new URL(request.url).searchParams.get('q'),60),filter=new URL(request.url).searchParams.get('filter')||'queue';let where='',args=[];
 if(filter==='queue')where=" AND o.status='paid' AND (p.status<>'applied' OR p.request_at IS NOT NULL AND p.reviewed_at IS NULL)";
 else if(filter==='requested')where=" AND p.arrival_at IS NOT NULL AND p.status<>'applied' AND o.status='paid'";
 if(q){where+=' AND (p.plate LIKE ? OR p.oid LIKE ? OR p.payment_oid LIKE ? OR o.buyer_phone LIKE ? OR o.buyer_name LIKE ?)';args=Array(5).fill('%'+q+'%');}
 const {results}=await env.DB.prepare(PARKING_JOIN+' WHERE 1=1'+where+" ORDER BY CASE WHEN p.request_at IS NOT NULL AND p.reviewed_at IS NULL THEN 0 WHEN p.arrival_at IS NOT NULL AND p.status<>'applied' THEN 1 ELSE 2 END,p.created_at DESC LIMIT 200").bind(...args).all();
 const {results:events}=await env.DB.prepare("SELECT id,oid,kind,status,message_id,last_error,created_at,sent_at FROM parking_events ORDER BY id DESC LIMIT 100").all();
 const s=await parkingSettings(env);return json({ok:true,settings:s,operation:operationText(s),templates:await parkingTemplateStatus(env),payReady:payConfig(env).ready,events,results:results.map(p=>({...publicParking(p),name:p.buyer_name,phone:p.buyer_phone,entryId:p.entry_id,entryAt:p.entry_at,memo:p.memo,requestReason:p.request_reason}))});
}
export async function onRequestPost({request,env,waitUntil}){
 const deny=await adminGate(request,env);if(deny)return deny;if(!sameOrigin(request))return json({ok:false},403);
 const raw=await request.text();if(raw.length>8192)return json({ok:false},413);let b;try{b=JSON.parse(raw)}catch{return json({ok:false},400)}if(!b||typeof b!=='object')return json({ok:false},400);
 await ensureParking(env);
 if(b.action==='settings'){
  const old=await parkingSettings(env),s={...old,enabled:b.enabled===true,confirmed:b.confirmed===true,daily_enabled:b.dailyEnabled===true,daily_details:clean(b.dailyDetails,400)};
  for(const [key,name]of [['start_min','startMin'],['end_min','endMin'],['cutoff_min','cutoffMin'],['process_minutes','processMinutes']]){if(!Number.isInteger(b[name]))return json({ok:false,message:'운영 시간을 확인해 주세요.'},400);s[key]=b[name];}
  const holidays=Array.isArray(b.holidays)?b.holidays:[];
  if(holidays.length>150||holidays.some(d=>!validDate(d))||s.start_min<0||s.end_min>1440||s.start_min>=s.cutoff_min||s.cutoff_min>=s.end_min||s.process_minutes<1||s.process_minutes>180)return json({ok:false,message:'휴무일과 운영 시간을 확인해 주세요.'},400);
  s.holidays=[...new Set(holidays)].sort();
  if(s.daily_enabled&&!s.daily_details)return json({ok:false,message:'일일권 종료·재입차·초과 정산 조건을 입력해 주세요.'},400);
  if(s.enabled&&(!s.confirmed||(!payConfig(env).ready||payConfig(env).provider!=='payapp')||!(await parkingTemplateStatus(env)).every(t=>t.approved)))return json({ok:false,message:'운영 조건 확인·페이앱 연결·주차 알림톡 4종 승인을 완료한 뒤 판매를 시작해 주세요.'},409);
  await env.DB.prepare('INSERT INTO parking_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(JSON.stringify(s)).run();return json({ok:true});
 }
 const p=await parkingOrder(env,clean(b.oid,40));if(!p)return json({ok:false},404);const r=await parkingAction(env,p,b,true);if(r.ok&&waitUntil)waitUntil(runParkingQueue(env));return json({...r,ok:!!r.ok,...(r.error?{message:r.error}:{})},r.status||200);
}
