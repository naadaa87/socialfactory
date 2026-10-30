import { json } from '../../_lib/auth.js';
import { boardOrigin, boardCookie, pairBoardDevice } from '../../_lib/board-device.js';

export async function onRequestPost({request,env}) {
  if(!boardOrigin(request)) return json({ok:false,error:'forbidden'},403);
  let b; try{b=await request.json();}catch{return json({ok:false,error:'bad-json'},400);}
  if(!b || typeof b!=='object' || Array.isArray(b)) return json({ok:false,error:'bad-json'},400);
  try {
    const paired=await pairBoardDevice(env,b.code);
    if(!paired) return json({ok:false,message:'모니터 연결 링크가 만료됐거나 이미 사용되었습니다. 관리자에서 새 링크를 발급해 주세요.'},401);
    return json({ok:true,expires_at:paired.until},200,{'Set-Cookie':boardCookie(request,paired.token)});
  } catch {return json({ok:false,message:'모니터를 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'},503);}
}
