import {json,sameOrigin} from '../../_lib/auth.js';
import {verifyGuestCode} from '../../_lib/guest-orders.js';
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);if(!env.DB)return json({ok:false,error:'not-ready'},503);
 try{const text=await request.text();if(text.length>1024)return json({ok:false,error:'invalid'},400);const r=await verifyGuestCode(request,env,JSON.parse(text));return json(r.data,r.status,r.cookie?{'Set-Cookie':r.cookie}:{})}catch{return json({ok:false,error:'unavailable',message:'인증을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503)}
}
