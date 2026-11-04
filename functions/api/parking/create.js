import {json,sameOrigin,ipHashOf,getMember} from '../../_lib/auth.js';
import {payConfig,makeOid} from '../../_lib/shop.js';
import {preparePayapp} from '../orders/index.js';
import {ensureParking,parkingSettings,validateParking,operationText,PARKING_POLICY} from '../../_lib/parking.js';
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);
 if(!env.DB)return json({ok:false,error:'no-db'},503);
 const raw=await request.text();if(raw.length>8192)return json({ok:false,error:'size'},413);let b;try{b=JSON.parse(raw)}catch{return json({ok:false,error:'json'},400)}if(!b||typeof b!=='object')return json({ok:false},400);
 await ensureParking(env);const s=await parkingSettings(env),cfg=payConfig(env);
 if(!s.enabled||!s.confirmed||!cfg.ready||cfg.provider!=='payapp')return json({ok:false,error:'not-ready',message:'주차권 온라인 구매를 준비하고 있습니다. 카카오톡으로 문의해 주세요.'},503);
 const input=validateParking(b,s);if(input.error)return json({ok:false,error:'invalid',message:input.error},400);
 if(!/^[a-f0-9-]{32,36}$/i.test(b.requestId||''))return json({ok:false,error:'invalid'},400);
 const member=await getMember(request,env),terms=JSON.stringify({operation:operationText(s),policy:PARKING_POLICY,dailyDetails:input.ticket==='daily'?s.daily_details:'',ticket:input.ticket,price:input.price});
 const order={oid:makeOid(),product_id:'parking-'+input.ticket,product_name:'주차권 '+input.label,qty:1,amount:input.price,buyer_name:input.name,buyer_phone:input.phone,buyer_email:'',start_date:input.date,memo:'',pay_method:'card',device:b.device==='mobile'?'mobile':'pc',member_id:member?.id||null};
 return preparePayapp(request,env,cfg,order,await ipHashOf(request,env),b.requestId,{fingerprint:[input.plate,terms],statements:[env.DB.prepare('INSERT INTO parking_orders(oid,ticket,plate,visit_date,terms) VALUES (?,?,?,?,?)').bind(order.oid,input.ticket,input.plate,input.date,terms)]});
}
