import {PARKING_TEMPLATES} from './parking-templates.js';
import {ensureParking,parkingOrder,parkingSettings,operationText,TICKETS} from './parking.js';
import {approvedWebsiteTemplate,sendAligo} from './aligo.js';
import {orderToken} from './shop.js';
import {kstNow} from './admin.js';
export async function parkingTemplateStatus(env){const rows=await Promise.all(Object.entries(PARKING_TEMPLATES).map(async([kind,t])=>({kind,name:t.title,code:env[t.env]||t.code,approved:!!(env[t.env]||t.code)&&await approvedWebsiteTemplate(env,t)})));return rows;}
export function parkingMessage(t,vars){const fill=s=>String(s).replace(/#\{([^}]+)\}/g,(_,k)=>{if(vars[k]===undefined)throw Error('parking-variable');return vars[k]});const buttons={button:t.buttons.button.map(b=>Object.fromEntries(Object.entries(b).map(([k,v])=>[k,fill(v)])))};const text=fill(t.text);return {title:t.title,text,buttons,fallbackText:text+'\n\n'+buttons.button.map(b=>b.name+': '+b.linkMo).join('\n')};}
export async function runParkingQueue(env,{limit=20}={}){
 if(!env.DB)return {sent:0};await ensureParking(env);
 // 재접수 여부를 알 수 없는 전송은 자동 재시도하지 않습니다.
 await env.DB.prepare("UPDATE parking_events SET status='unknown',last_error='전송 결과 미확인 — 알리고 전송내역 확인 필요' WHERE status='sending' AND updated_at<datetime('now','+9 hours','-10 minutes')").run();
 const cfg=await parkingSettings(env),out={sent:0,waiting:0,failed:0,cancelled:0};
 if(!cfg.confirmed||env.ALIMTALK_ENABLED!=='1'||env.ALIMTALK_PROVIDER!=='aligo')return out;
 const {results}=await env.DB.prepare("SELECT * FROM parking_events WHERE status='queued' ORDER BY id LIMIT ?").bind(limit).all();
 for(const e of results){
  const p=await parkingOrder(env,e.oid),t=PARKING_TEMPLATES[e.kind],now=kstNow();
  const stale=!p||!t||p.test_mode||e.created_at<new Date(Date.now()+9*3600e3-864e5).toISOString().slice(0,19).replace('T',' ')||(e.kind!=='refund'&&(p.payment_status!=='paid'||p.refunded_amount>0||p.visit_date<now.slice(0,10)))||(e.kind==='arrival'&&(!p.arrival_at||p.status==='applied'))||(e.kind==='applied'&&!p.applied_at)||(e.kind==='refund'&&p.refunded_amount!==e.refund_amount);
  if(stale){await env.DB.prepare("UPDATE parking_events SET status='cancelled' WHERE id=? AND status='queued'").bind(e.id).run();out.cancelled++;continue;}
  if(!(await approvedWebsiteTemplate(env,t))){out.waiting++;continue;}
  const claimed=await env.DB.prepare("UPDATE parking_events SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").bind(now,e.id).run();if(!claimed.meta.changes)continue;
  // 대기열을 읽은 뒤 환불·연락처가 바뀌었다면 발송을 중지합니다.
  const latest=await parkingOrder(env,e.oid);
  if(!latest || latest.buyer_phone!==p.buyer_phone || latest.refunded_amount!==p.refunded_amount || (e.kind!=='refund'&&latest.payment_status!=='paid')){await env.DB.prepare("UPDATE parking_events SET status='cancelled' WHERE id=?").bind(e.id).run();out.cancelled++;continue;}
  let accepted=false;
  try{
   const refund=e.kind==='refund'?(p.amount===p.payment_amount?e.refund_amount:p.amount):0,vars={주문번호:p.payment_oid,주문토큰:await orderToken(env,p.payment_oid),차량끝번호:p.plate.slice(-4),이용일:p.visit_date,주차권:'주차권 '+TICKETS[p.ticket].label,결제금액:Number(p.amount).toLocaleString('ko-KR'),누적환불금액:Number(refund).toLocaleString('ko-KR'),남은결제금액:Math.max(0,p.amount-refund).toLocaleString('ko-KR'),운영안내:operationText(cfg),처리일시:(e.kind==='applied'?p.applied_at:p.arrival_at||e.created_at).slice(0,16)};
   const result=await sendAligo(env,{phone:p.buyer_phone},parkingMessage(t,vars),t);accepted=true;
   await env.DB.prepare("UPDATE parking_events SET status=?,message_id=?,sent_at=?,updated_at=?,last_error=NULL WHERE id=?").bind(result.test?'test':'accepted',result.messageId,now,now,e.id).run();out.sent++;
  }catch(err){const uncertain=accepted||err.retryable===false;await env.DB.prepare('UPDATE parking_events SET status=?,last_error=?,updated_at=? WHERE id=?').bind(uncertain?'unknown':'failed',uncertain?'접수 여부 미확인 — 알리고 전송내역 확인 필요':'알리고 요청 거절 — 설정과 전송내역 확인 필요',now,e.id).run();out.failed++;}
 }
 await env.DB.prepare("DELETE FROM parking_events WHERE status NOT IN ('queued','sending') AND created_at<datetime('now','+9 hours','-6 months')").run();return out;
}
