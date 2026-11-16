import {adminGate} from '../../_lib/admin.js';
import {json} from '../../_lib/auth.js';
import {ensurePayappSales,savePayappSales,payappWebsiteMatch,payappSellerSql,payappSellers} from '../../_lib/payapp-sales.js';
export async function onRequestGet({request,env}){
  const deny=await adminGate(request,env);if(deny)return deny;
  await ensurePayappSales(env);const p=new URL(request.url).searchParams,filter=p.get('filter')||'all',page=Number(p.get('page')||1),seller=p.get('sellerId')||'',sellers=payappSellers(env);
  if(!['all','review','include','exclude','duplicate','website'].includes(filter)||!Number.isInteger(page)||page<1||page>20000||(seller&&!sellers.some(s=>s.id===seller)))return json({ok:false,message:'조회 조건을 확인해 주세요.'},400);
  const selected=sellers.filter(s=>!seller||s.id===seller).map(s=>s.id),placeholders=selected.map(()=>'?').join(',')||"''",websiteSeller=payappSellerSql(env,'p');
  const ledger=`SELECT s.seller_id,s.mul_no,s.product_name,s.amount,s.refund_amount,s.paid_at,s.requested_at,s.method,s.state,s.review_note,s.received_at,
    CASE WHEN ${payappWebsiteMatch(env)} THEN 'website' ELSE s.review_state END disposition FROM payapp_sales s WHERE s.seller_id IN (${placeholders})
    UNION ALL SELECT ${websiteSeller},p.mul_no,o.product_name,o.amount,p.refunded_amount,o.paid_at,o.created_at,o.pg_method,o.status,'',o.created_at,'website'
    FROM orders o JOIN payapp_payments p ON p.oid=o.oid WHERE p.mul_no IS NOT NULL
      AND ${websiteSeller} IN (${placeholders})
      AND NOT EXISTS(SELECT 1 FROM payapp_sales s WHERE s.seller_id=${websiteSeller} AND s.mul_no=p.mul_no)`;
  const where=filter==='all'?'':' WHERE disposition=?',args=[...selected,...selected,...(filter==='all'?[]:[filter])];
  const total=await env.DB.prepare('SELECT COUNT(*) n FROM ('+ledger+')'+where).bind(...args).first();
  const rows=(await env.DB.prepare('SELECT * FROM ('+ledger+')'+where+' ORDER BY COALESCE(paid_at,requested_at,received_at) DESC,mul_no DESC LIMIT 50 OFFSET ?').bind(...args,(page-1)*50).all()).results||[];
  const last=await env.DB.prepare(`SELECT MAX(received_at) at FROM payapp_sales WHERE seller_id IN (${placeholders}) AND origin='webhook'`).bind(...selected).first();
  return json({ok:true,rows,total:Number(total.n),page,pageSize:50,sellers,lastWebhook:last?.at||null,configured:sellers.length>0,webhookUrl:new URL('/api/pay/payapp/sales-feedback',request.url).href});
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
    const sellers=payappSellers(env),seller=b.sellerId||(sellers.length===1?sellers[0].id:'');
    if(!sellers.some(s=>s.id===seller))throw Error('처리할 판매자 계정을 선택해 주세요.');
    const row=await env.DB.prepare(`SELECT s.mul_no,${payappWebsiteMatch(env)} AS website FROM payapp_sales s WHERE seller_id=? AND mul_no=?`).bind(seller,b.mulNo).first();
    if(!row||row.website)throw Error('대상 결제를 확인해 주세요. 홈페이지 결제는 기존 주문에서 관리합니다.');
    await env.DB.prepare('UPDATE payapp_sales SET review_state=?,review_note=? WHERE seller_id=? AND mul_no=?').bind(b.decision,b.note.trim(),seller,b.mulNo).run();
    return json({ok:true});
  }catch(e){return json({ok:false,message:e.message||'저장하지 못했습니다.'},400);}
}
