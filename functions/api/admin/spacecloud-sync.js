import {json} from '../../_lib/auth.js';
import {adminGate} from '../../_lib/admin.js';
import {ensureSync,createCode} from '../../_lib/spacecloud-sync.js';
export async function onRequestGet({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;await ensureSync(env);
 const device=await env.DB.prepare('SELECT enabled,token_until,last_attempt,last_success,status,message,counts FROM spacecloud_sync_device WHERE id=1').first();
 const review=(await env.DB.prepare("SELECT reservation_id,observed_at,reason FROM spacecloud_sync_audit WHERE action='review' ORDER BY id DESC LIMIT 20").all()).results;
 return json({ok:true,device:device||null,review:review||[],now:Date.now()});
}
export async function onRequestPost({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;let b;try{b=await request.json();}catch{return json({ok:false},400);}
 if(b.action==='pair')return json({ok:true,code:await createCode(env),expires_in:600});
 if(b.action==='revoke'){await ensureSync(env);await env.DB.prepare("UPDATE spacecloud_sync_device SET enabled=0,token_hash=NULL,code_hash=NULL,status='revoked',message='연결 해제' WHERE id=1").run();return json({ok:true});}
 return json({ok:false},400);
}
