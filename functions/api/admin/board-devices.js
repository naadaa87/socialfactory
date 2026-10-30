import { adminGate } from '../../_lib/admin.js';
import { clean, json } from '../../_lib/auth.js';
import { boardOrigin, createBoardDevice, ensureBoardDevices } from '../../_lib/board-device.js';

export async function onRequestGet({request,env}) {
  const deny=await adminGate(request,env); if(deny) return deny;
  await ensureBoardDevices(env);
  const {results}=await env.DB.prepare(`SELECT id,name,status,created_at,paired_at,last_seen_at,token_until,pair_until FROM board_devices
    ORDER BY CASE WHEN status='active' AND token_until>?1 THEN 0 WHEN status='pairing' AND pair_until>?1 THEN 1 ELSE 2 END,created_at DESC LIMIT 100`).bind(Date.now()).all();
  return json({ok:true,devices:results,now:Date.now()});
}
export async function onRequestPost({request,env}) {
  const deny=await adminGate(request,env); if(deny) return deny;
  if(!boardOrigin(request)) return json({ok:false,error:'forbidden'},403);
  let b; try{b=await request.json();}catch{return json({ok:false,error:'bad-json'},400);}
  if(!b || typeof b!=='object' || Array.isArray(b)) return json({ok:false,error:'bad-json'},400);
  if(b.action==='create') {
    const name=clean(b.name,40); if(!name) return json({ok:false,message:'모니터 이름을 적어 주세요.'},400);
    const device=await createBoardDevice(env,name);
    if(!device) return json({ok:false,message:'연결된 모니터가 많습니다. 사용하지 않는 연결을 해제해 주세요.'},409);
    return json({ok:true,id:device.id,expires_at:device.expires_at,
      link:new URL('/reservation-board',request.url).href+'#pair='+device.code});
  }
  if(b.action==='revoke') {
    await ensureBoardDevices(env);
    const id=clean(b.id,30);
    await env.DB.prepare("UPDATE board_devices SET status='revoked',token_hash=NULL,token_until=NULL,pair_hash=NULL,pair_until=NULL WHERE id=?1").bind(id).run();
    return json({ok:true});
  }
  return json({ok:false,error:'invalid'},400);
}
