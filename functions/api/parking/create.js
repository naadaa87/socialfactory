import {json,sameOrigin,ipHashOf,getMember} from '../../_lib/auth.js';
import {payConfig,makeOid} from '../../_lib/shop.js';
import {preparePayapp} from '../orders/index.js';
import {ensureParking,parkingSettings,validateParkingVehicles,operationText,PARKING_POLICY,parkingPolicyTag} from '../../_lib/parking.js';
export async function onRequestPost({request,env}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);
 if(!env.DB)return json({ok:false,error:'no-db'},503);
 const raw=await request.text();if(raw.length>8192)return json({ok:false,error:'size'},413);let b;try{b=JSON.parse(raw)}catch{return json({ok:false,error:'json'},400)}if(!b||typeof b!=='object')return json({ok:false},400);
 await ensureParking(env);const s=await parkingSettings(env),cfg=payConfig(env);
 if(!s.enabled||!s.confirmed||!cfg.ready||cfg.provider!=='payapp')return json({ok:false,error:'not-ready',message:'주차권 온라인 구매를 준비하고 있습니다. 카카오톡으로 문의해 주세요.'},503);
 if(b.termsVersion!==await parkingPolicyTag(s))return json({ok:false,error:'terms-changed',message:'주차 운영 조건이 변경되었습니다. 새로고침 후 다시 확인해 주세요.'},409);
 const input=validateParkingVehicles(b,s);if(input.error)return json({ok:false,error:'invalid',message:input.error},400);
 if(!/^[a-f0-9-]{32,36}$/i.test(b.requestId||''))return json({ok:false,error:'invalid'},400);
 const items=input.items,first=items[0],multi=items.length>1,member=await getMember(request,env);
 const order={oid:makeOid(),product_id:multi?'parking-multi':'parking-'+first.ticket,product_name:multi?'주차권 '+items.length+'대 통합 구매':'주차권 '+first.label,qty:items.length,amount:items.reduce((n,v)=>n+v.price,0),buyer_name:first.name,buyer_phone:first.phone,buyer_email:'',start_date:first.date,memo:'',pay_method:'card',device:b.device==='mobile'?'mobile':'pc',member_id:member?.id||null};
 const lines=items.map(v=>({...v,terms:JSON.stringify({operation:operationText(s),policy:PARKING_POLICY,dailyDetails:v.ticket==='daily'?s.daily_details:'',ticket:v.ticket,price:v.price})}));
 return preparePayapp(request,env,cfg,order,await ipHashOf(request,env),b.requestId,{fingerprint:multi?lines.map(v=>[v.plate,v.terms]):[first.plate,lines[0].terms],statements:lines.map((v,i)=>env.DB.prepare('INSERT INTO parking_orders(oid,payment_oid,vehicle_price,ticket,plate,visit_date,terms) VALUES (?,?,?,?,?,?,?)').bind(i===0?order.oid:makeOid(),order.oid,v.price,v.ticket,v.plate,v.date,v.terms))});
}
