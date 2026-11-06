import {adminGate} from '../../_lib/admin.js';
import {json} from '../../_lib/auth.js';
import {payappConfig} from '../../_lib/payapp.js';
import {ensurePayappSales,savePayappSales,PAYAPP_WEBSITE_MATCH} from '../../_lib/payapp-sales.js';
export async function onRequestGet({request,env}){
  const deny=await adminGate(request,env);if(deny)return deny;
  await ensurePayappSales(env);const p=new URL(request.url).searchParams,filter=p.get('filter')||'all',page=Number(p.get('page')||1);
  if(!['all','review','include','exclude','duplicate','website'].includes(filter)||!Number.isInteger(page)||page<1||page>20000)return json({ok:false,message:'조회 조건을 확인해 주세요.'},400);
  const ledger=`SELECT s.mul_no,s.product_name,s.amount,s.refund_amount,s.paid_at,s.requested_at,s.method,s.state,s.review_note,s.received_at,
    CASE WHEN ${PAYAPP_WEBSITE_MATCH} THEN 'website' ELSE s.review_state END disposition FROM payapp_sales s WHERE seller_id=?1
    UNION ALL SELECT p.mul_no,o.product_name,o.amount,p.refunded_amount,o.paid_at,o.created_at,o.pg_method,o.status,'',o.created_at,'website'
    FROM orders o JOIN payapp_payments p ON p.oid=o.oid WHERE p.mul_no IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM payapp_sales s WHERE s.seller_id=?1 AND s.mul_no=p.mul_no)`;
  const where=filter==='all'?'':' WHERE disposition=?',args=[payappConfig(env).userid,...(filter==='all'?[]:[filter])];
  const total=await env.DB.prepare('SELECT COUNT(*) n FROM ('+ledger+')'+where).bind(...args).first();
  const rows=(await env.DB.prepare('SELECT * FROM ('+ledger+')'+where+' ORDER BY COALESCE(paid_at,requested_at,received_at) DESC,mul_no DESC LIMIT 50 OFFSET ?').bind(...args,(page-1)*50).all()).results||[];
  const last=await env.DB.prepare("SELECT MAX(received_at) at FROM payapp_sales WHERE seller_id=? AND origin='webhook'").bind(payappConfig(env).userid).first();
  return json({ok:true,rows,total:Number(total.n),page,pageSize:50,lastWebhook:last?.at||null,configured:payappConfig(env).configured,webhookUrl:new URL('/api/pay/payapp/sales-feedback',request.url).href});
}
export async function onRequestPost({request,env}){
  const deny=await adminGate(request,env);if(deny)return deny;
  if(Number(request.headers.get('content-length'))>1000000)return json({ok:false,message:'1MB 이하로 가져와 주세요.'},413);
  const raw=await request.text();if(raw.length>1000000)return json({ok:false,message:'1MB 이하로 가져와 주세요.'},413);
  let b;try{b=JSON.parse(raw);}catch{return json({ok:false,message:'요청 형식을 확인해 주세요.'},400);}
  await ensurePayappSales(env);
  try{
    if(b?.action==='import')return json({ok:true,changed:await savePayappSales(env,b.rows)});
    if(b?.action!=='review'||typeof b.mulNo!=='string'||!/^\d{1,30}$/.test(b.mulNo)||!['include','exclude','duplicate','review'].includes(b.decision)||typeof b.note!=='string'||b.note.trim().length<3||b.note.length>300)throw Error('결제번호·처리 방식·사유(3~300자)를 확인해 주세요.');
    const seller=payappConfig(env).userid;
    const row=await env.DB.prepare(`SELECT s.mul_no,${PAYAPP_WEBSITE_MATCH} AS website FROM payapp_sales s WHERE seller_id=? AND mul_no=?`).bind(seller,b.mulNo).first();
    if(!row||row.website)throw Error('대상 결제를 확인해 주세요. 홈페이지 결제는 기존 주문에서 관리합니다.');
    await env.DB.prepare('UPDATE payapp_sales SET review_state=?,review_note=? WHERE seller_id=? AND mul_no=?').bind(b.decision,b.note.trim(),seller,b.mulNo).run();
    return json({ok:true});
  }catch(e){return json({ok:false,message:e.message||'저장하지 못했습니다.'},400);}
}
