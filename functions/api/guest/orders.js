import {json} from '../../_lib/auth.js';
import {getGuest,maskGuestPhone} from '../../_lib/guest-orders.js';
import {kstNow} from "../../_lib/admin.js";
import {fromMs,toMs} from "../../_lib/kiosk.js";
import {ORDER_STATUS,PAY_METHOD} from '../../_lib/shop.js';
export async function onRequestGet({request,env}){
 const session=await getGuest(request,env);if(!session)return json({ok:false,error:'verify-required'},401);
 try{const {results}=await env.DB.prepare("SELECT oid,status,product_name,qty,amount,start_date,paid_at,created_at,pg_method FROM orders WHERE member_id IS NULL AND replace(buyer_phone,'-','')=? AND status<>'pending' AND created_at>=? ORDER BY id DESC LIMIT 50").bind(session.phone,fromMs(toMs(kstNow())-90*864e5)).all();return json({ok:true,maskedPhone:maskGuestPhone(session.phone),expiresAt:session.expires_at,results:results.map(o=>({...o,statusLabel:ORDER_STATUS[o.status]||o.status,payLabel:PAY_METHOD[o.pg_method]||''}))})}catch{return json({ok:false,error:'unavailable',message:'주문을 불러오지 못했습니다. 다시 조회해 주세요.'},503)}
}
