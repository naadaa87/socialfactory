import {json,sameOrigin,clean,getMember,safeEqual} from '../../_lib/auth.js';
import {orderToken} from '../../_lib/shop.js';
import {rescheduleWebsiteOrder} from '../../_lib/website-reschedule.js';
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);
 if(!env.DB)return json({ok:false,error:'no-db'},503);
 if(Number(request.headers.get('content-length'))>4096)return json({ok:false,error:'invalid'},413);
 let b;try{const raw=await request.text();if(raw.length>4096)return json({ok:false,error:'invalid'},413);b=JSON.parse(raw)}catch{return json({ok:false,error:'invalid'},400)}
 if(!b || typeof b!=='object' || typeof b.oid!=='string' || !/^SF[A-Z0-9]{8,38}$/i.test(b.oid) || !/^[a-f0-9-]{32,36}$/i.test(b.requestId||'') || typeof b.expectedStart!=='string')return json({ok:false,error:'invalid'},400);
 try{
  const order=await env.DB.prepare('SELECT * FROM orders WHERE oid=?').bind(b.oid).first();
  if(!order)return json({ok:false,error:'not-found'},404);
  const member=await getMember(request,env);
  const token=clean(b.token,40),owner=member && order.member_id===member.id;
  if(!owner && !(token && safeEqual(token,await orderToken(env,order.oid))))return json({ok:false,error:'forbidden'},403);
  const r=await rescheduleWebsiteOrder(env,order,{startAt:b.startAt,expectedStart:b.expectedStart,requestId:b.requestId,actor:owner?'member:'+member.id:'guest'});
  return json(r,r.status||200);
 }catch{return json({ok:false,error:'save-failed',message:'변경을 저장하지 못했습니다. 새로 결제하지 말고 같은 내용으로 다시 시도해 주세요.'},500)}
}
