import {json,sameOrigin,readCookie,sha256Hex} from '../../_lib/auth.js';
import {getGuest,guestReady,guestCookie,maskGuestPhone} from '../../_lib/guest-orders.js';
export async function onRequestGet({request,env}){const g=await getGuest(request,env);return json({ok:true,ready:guestReady(env),verified:!!g,...(g?{maskedPhone:maskGuestPhone(g.phone),expiresAt:g.expires_at}:{})})}
export async function onRequestDelete({request,env}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);const token=readCookie(request,'sf_guest');if(token&&env.DB)await env.DB.prepare('DELETE FROM guest_order_sessions WHERE token_hash=?').bind(await sha256Hex(token)).run();return json({ok:true},200,{'Set-Cookie':[guestCookie(request,'sf_guest','',0),guestCookie(request,'sf_guest_challenge','',0)]});
}
