import {json} from './auth.js';
import {parkingItems,validDate,TICKETS} from './parking.js';

const stamp = value => typeof value === 'string' &&
 /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) && validDate(value.slice(0,10));
const orderId = value => /^SF[A-Z0-9]{16}$/.test(value || '');

export async function parkingPaidFeed(env,body) {
 if (!stamp(body.since)) return json({ok:false},400);
 const args=[body.since];
 let filter='';
 if (body.action==='payment') {
  if (!orderId(body.oid)) return json({ok:false},400);
  filter=' AND o.oid=?';
  args.push(body.oid);
 } else if (body.after) {
  if (!stamp(body.after.paid_at) || !orderId(body.after.oid)) return json({ok:false},400);
  filter=' AND (o.paid_at>? OR (o.paid_at=? AND o.oid>?))';
  args.push(body.after.paid_at,body.after.paid_at,body.after.oid);
 }
 const {results}=await env.DB.prepare(`SELECT o.oid,o.amount,o.qty,o.paid_at
  FROM orders o JOIN payapp_payments pg ON pg.oid=o.oid
  WHERE o.paid_at>=? AND o.status='paid' AND o.test_mode=0
  AND o.tid=pg.mul_no AND pg.refunded_amount=0
  AND EXISTS(SELECT 1 FROM parking_orders p WHERE p.payment_oid=o.oid)
  ${filter} ORDER BY o.paid_at,o.oid LIMIT 10`).bind(...args).all();
 const payments=[];
 for (const order of results) {
  const rows=await parkingItems(env,order.oid);
  if(rows.some(p=>p.payment_status!=='paid'||p.refunded_amount>0||p.test_mode))continue;
  if (!rows.length || rows.length>10 || rows.length!==order.qty ||
      rows.reduce((total,p)=>total+p.amount,0)!==order.amount ||
      rows.some(p=>!TICKETS[p.ticket])) throw Error('주차 결제 구성 확인 필요');
  payments.push({...order,vehicles:rows.map(p=>({plate:p.plate,date:p.visit_date,
   ticket:p.ticket,price:p.amount,status:p.status}))});
 }
 const last=results.at(-1);
 return json({ok:true,payments,next:last?{paid_at:last.paid_at,oid:last.oid}:null});
}
