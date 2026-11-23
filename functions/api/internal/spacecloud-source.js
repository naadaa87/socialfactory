import {json} from '../../_lib/auth.js';
import {workerAuthorized,syncEnabled} from '../../_lib/booking-spacecloud-sync.js';
import {claimSourceSync,checkpointSourceSync} from '../../_lib/spacecloud-source-sync.js';
export async function onRequestPost({request,env}) {
 if(!workerAuthorized(request,env))return json({ok:false,error:'unauthorized'},401);
 if(!syncEnabled(env))return json({ok:false,error:'sync-disabled'},503);
 try {
  const raw=await request.text();if(raw.length>8000)return json({ok:false,error:'too-large'},413);
  const body=JSON.parse(raw);
  return json(body.action==='claim'?{ok:true,job:await claimSourceSync(env)}:await checkpointSourceSync(env,body));
 }catch(error){return json({ok:false,error:error.code||'source-error'},error.status||503);}
}
