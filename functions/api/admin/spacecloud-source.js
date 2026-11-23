import {adminGate} from '../../_lib/admin.js';
import {json} from '../../_lib/auth.js';
import {enqueueSourceSync,retrySourceSync} from '../../_lib/spacecloud-source-sync.js';
import {readSyncAlerts} from '../../_lib/spacecloud-sync-alerts.js';
export async function onRequestGet({request,env}) {
 const denied=await adminGate(request,env);if(denied)return denied;
 try{return json(await readSyncAlerts(env));}
 catch{return json({ok:false,error:'source-status',message:'스페이스클라우드 연동 상태를 확인하지 못했습니다.'},503);}
}
export async function onRequestPost({request,env}) {
 const denied=await adminGate(request,env);if(denied)return denied;
 try {
  const raw=await request.text();if(raw.length>8000)return json({ok:false,error:'too-large'},413);
  const body=JSON.parse(raw);
  return json(body.action==='retry'?await retrySourceSync(env,body.id):await enqueueSourceSync(env,body),202);
 }catch(error){return json({ok:false,error:error.code||'source-error',message:error.code?error.message:'원본 변경 요청을 저장하지 못했습니다.'},error.status||400);}
}
