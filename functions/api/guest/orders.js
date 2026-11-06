import {json} from '../../_lib/auth.js';
import {getGuest,maskGuestPhone} from '../../_lib/guest-orders.js';
import {kstNow} from "../../_lib/admin.js";
import {fromMs,toMs} from "../../_lib/kiosk.js";
import {ORDER_STATUS,PAY_METHOD} from '../../_lib/shop.js';

const paymentLabels={creating:'결제요청 준비 중',requested:'결제 대기',pending:'결제 대기',paid:'결제 완료',cancelled:'결제요청 취소',refunded:'환불 완료',partial_refund:'부분 환불',review:'결제 상태 확인 중',failed:'결제요청 실패'};
function roomStatus(row,now){
 if(row.sync_state==='review')return ['sync_review','예약 일정 확인 중'];
 if(row.sync_state==='conflict')return ['sync_conflict','일정 중복 · 결제 불가'];
 if(row.sync_state==='releasing' || row.payment_status==='releasing' || (row.cancel_requested && row.sync_state!=='released'))return ['releasing','예약 취소 처리 중'];
 if(row.pay_status==='refunded' || row.payment_status==='refunded')return ['refunded','환불 완료'];
 if(row.pay_status==='partial_refund')return ['partial_refund','부분 환불 · 예약 상태 확인'];
 if(row.status==='payment_review' || ['review','refund_pending'].includes(row.payment_status) || row.pay_status==='review')return ['review','예약·결제 상태 확인 중'];
 if(row.status==='cancelled' || row.sync_state==='released')return ['cancelled','예약 신청 취소'];
 if(row.status==='expired' || (row.status==='requested' && row.expires_at && row.expires_at<=now))return ['expired','예약 신청 만료'];
 if(row.pay_status==='failed')return ['failed','결제요청 실패'];
 if(row.payment_status==='paid_verifying')return ['paid_verifying','결제 확인 · 예약 확정 중'];
 if(row.status==='confirmed')return ['confirmed','예약 확정'];
 if(row.pay_status==='paid' || row.payment_status==='paid')return ['paid_verifying','결제 확인 · 예약 확정 중'];
 if(['pending','blocking'].includes(row.sync_state) || row.payment_status==='sync_pending')return ['sync_pending','예약 일정 확보 중'];
 if(row.status==='awaiting_payment')return ['pending','결제 대기'];
 return ['requested','예약 신청 접수'];
}
const detailUrl=(code,token)=>token?'/booking-status?code='+encodeURIComponent(code)+'&t='+encodeURIComponent(token):null;

// Only the server-side, phone-verified guest session authorizes recovery links.
// Do not migrate schemas or expire holds from this read-only lookup endpoint.
async function bookingOrders(env,phone,since,now){
 const {results:tables}=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('booking_requests','booking_payapp_requests','spacecloud_blocks','inquiries')").all();
 const names=new Set(tables.map(t=>t.name)),orders=[];
 if(names.has('booking_requests') && names.has('booking_payapp_requests') && names.has('spacecloud_blocks')){
  const {results}=await env.DB.prepare(`SELECT b.code,b.status,b.room,b.date,b.start_min,b.end_min,b.people,b.amount,b.created_at,b.expires_at,b.payment_status,b.paid_at,
    p.status AS pay_status,p.label,p.token AS payment_token,s.access_token,s.state AS sync_state,s.cancel_requested
    FROM booking_requests b LEFT JOIN booking_payapp_requests p ON p.code=b.code AND p.kind='room'
    LEFT JOIN spacecloud_blocks s ON s.code=b.code
    WHERE replace(replace(b.phone,'-',''),' ','')=? AND b.created_at>=? ORDER BY b.created_at DESC,b.id DESC LIMIT 50`).bind(phone,since).all();
  for(const row of results){
   const [status,statusLabel]=roomStatus(row,now);
   orders.push({kind:'room',oid:row.code,status,statusLabel,product_id:'booking-room',product_name:row.label || '소셜팩토리 '+row.room.replace('r','')+'번룸 공간대관',
    amount:row.amount,created_at:row.created_at,paid_at:row.paid_at,date:row.date,start_min:row.start_min,end_min:row.end_min,people:row.people,
    detail_url:detailUrl(row.code,row.access_token || row.payment_token)});
  }
 }
 if(names.has('booking_payapp_requests') && names.has('inquiries')){
  const {results}=await env.DB.prepare(`SELECT p.code,p.label,p.amount,p.status,p.paid_at,p.created_at,p.token
    FROM booking_payapp_requests p JOIN inquiries i ON i.id=p.inquiry_id AND i.purpose='office'
    WHERE p.kind='office' AND (
      WITH RECURSIVE phone_digits(rest,digits) AS (
        SELECT i.phone,''
        UNION ALL SELECT substr(rest,2),digits || CASE WHEN substr(rest,1,1) GLOB '[0-9]' THEN substr(rest,1,1) ELSE '' END
        FROM phone_digits WHERE rest<>''
      ) SELECT digits FROM phone_digits WHERE rest=''
    )=? AND p.created_at>=? ORDER BY p.created_at DESC,p.code DESC LIMIT 50`).bind(phone,since).all();
  for(const row of results)orders.push({kind:'office',oid:row.code,status:row.status,statusLabel:paymentLabels[row.status] || '결제 상태 확인 중',product_id:'booking-office',product_name:row.label,
   amount:row.amount,created_at:row.created_at,paid_at:row.paid_at,detail_url:detailUrl(row.code,row.token)});
 }
 return orders;
}
export async function onRequestGet({request,env}){
 const session=await getGuest(request,env);if(!session)return json({ok:false,error:'verify-required'},401);
 try{
  const now=kstNow(),since=fromMs(toMs(now)-90*864e5);
  const {results}=await env.DB.prepare("SELECT oid,status,product_id,product_name,qty,amount,start_date,paid_at,created_at,pg_method FROM orders WHERE member_id IS NULL AND replace(buyer_phone,'-','')=? AND status<>'pending' AND created_at>=? ORDER BY id DESC LIMIT 50").bind(session.phone,since).all();
  const bookings=await bookingOrders(env,session.phone,since,now);
  const combined=[...results.map(o=>({...o,statusLabel:ORDER_STATUS[o.status]||o.status,payLabel:PAY_METHOD[o.pg_method]||''})),...bookings]
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)) || String(b.oid).localeCompare(String(a.oid))).slice(0,50);
  return json({ok:true,maskedPhone:maskGuestPhone(session.phone),expiresAt:session.expires_at,results:combined});
 }catch{return json({ok:false,error:'unavailable',message:'주문을 불러오지 못했습니다. 다시 조회해 주세요.'},503)}
}
