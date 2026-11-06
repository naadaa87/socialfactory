import {adminGate,kstNow} from '../../_lib/admin.js';
import {json,sameOrigin} from '../../_lib/auth.js';
import {ensureAutomation,automationEnabled,automationRelay} from '../../_lib/parking-automation.js';
export async function onRequestGet({request,env}){const deny=await adminGate(request,env);if(deny)return deny;await ensureAutomation(env);try{const r=await automationRelay(env,'status');return json({...r,site_enabled:await automationEnabled(env)});}catch{return json({ok:false,error:'아마노 자동 등록 서버 연결을 확인해 주세요.'},502);}}
export async function onRequestPost({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;if(!sameOrigin(request))return json({ok:false},403);await ensureAutomation(env);
 let b;try{const raw=await request.text();if(raw.length>2000)return json({ok:false},413);b=JSON.parse(raw);}catch{return json({ok:false},400);}
 if(!b||!['check','settings'].includes(b.action))return json({ok:false},400);
 try{
  if(b.action==='check')return json(await automationRelay(env,'check'));
  if(b.enabled===true&&b.confirm_policy!==true)return json({ok:false,error:'무료 우선 적용과 주문별 차감 한도를 확인해 주세요.'},400);
  if(b.enabled!==true)await env.DB.prepare('UPDATE parking_automation_settings SET enabled=0,updated_at=? WHERE id=1').bind(kstNow()).run();
  const r=await automationRelay(env,'settings',{enabled:b.enabled===true,confirm_policy:b.confirm_policy===true});
  if(r.enabled!==(b.enabled===true))throw Error();
  await env.DB.prepare('UPDATE parking_automation_settings SET enabled=?,updated_at=? WHERE id=1').bind(r.enabled?1:0,kstNow()).run();return json({ok:true,enabled:r.enabled});
 }catch{return json({ok:false,error:'아마노 서버 연결을 확인해 주세요. 자동 처리 상태를 다시 확인해 주세요.'},502);}
}
