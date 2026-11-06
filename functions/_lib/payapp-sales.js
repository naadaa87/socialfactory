import {ensurePayapp,payappConfig} from './payapp.js';
import {stamp} from './toss-sales.js';

export async function ensurePayappSales(env){
  await ensurePayapp(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payapp_sales (
      seller_id TEXT NOT NULL,mul_no TEXT NOT NULL,product_name TEXT NOT NULL,state TEXT NOT NULL,
      amount INTEGER NOT NULL,refund_amount INTEGER NOT NULL DEFAULT 0,requested_at TEXT,paid_at TEXT,
      approval_no TEXT NOT NULL DEFAULT '',method TEXT NOT NULL DEFAULT '',origin TEXT NOT NULL,
      review_state TEXT NOT NULL DEFAULT 'review',review_note TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')),PRIMARY KEY(seller_id,mul_no))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payapp_sales_refunds (
      seller_id TEXT NOT NULL,event_no TEXT NOT NULL,mul_no TEXT NOT NULL,amount INTEGER NOT NULL,
      PRIMARY KEY(seller_id,event_no))`)
  ]);
}
const text=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const number=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000000;
export function payappTime(v){
  if(!v)return null;
  const s=/^\d{14}$/.test(v)?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(8,10)}:${v.slice(10,12)}:${v.slice(12,14)}+09:00`:String(v).replace(' ','T');
  return stamp(s)?.kst||null;
}
export function normalizePayappSale(raw,seller){
  if(!seller||!raw||raw.sellerId!==seller||typeof raw.mulNo!=='string'||!/^\d{1,30}$/.test(raw.mulNo)||!number(raw.amount)||!number(raw.refundAmount)||raw.refundAmount>raw.amount||!['paid','refunded','pending','cancelled'].includes(raw.state))throw Error('페이앱 판매자·결제번호·금액·상태를 확인해 주세요.');
  const paid=payappTime(raw.paidAt),requested=payappTime(raw.requestedAt);
  if((raw.paidAt&&!paid)||(raw.requestedAt&&!requested)||(raw.state==='paid'&&!paid)||(raw.state==='refunded'&&raw.refundAmount!==raw.amount))throw Error('페이앱 승인일시·환불금액을 확인해 주세요.');
  return {seller,mulNo:raw.mulNo,productName:text(raw.productName,200)||'상품명 없음',state:raw.state,amount:raw.amount,refund:raw.refundAmount,paid,requested,approval:text(raw.approvalNo,40),method:text(raw.method,80)};
}
export async function savePayappSales(env,raw,origin='import',partial=null){
  const seller=payappConfig(env).userid;
  if(!Array.isArray(raw)||!raw.length||raw.length>200)throw Error('1~200건의 페이앱 내역을 선택해 주세요.');
  const rows=raw.map(r=>normalizePayappSale(r,seller));
  if(new Set(rows.map(r=>r.mulNo)).size!==rows.length)throw Error('같은 페이앱 결제번호가 여러 번 있습니다.');
  for(const r of rows){
    const before=await env.DB.prepare('SELECT amount,approval_no FROM payapp_sales WHERE seller_id=? AND mul_no=?').bind(seller,r.mulNo).first();
    if(before&&(before.amount!==r.amount||(before.approval_no&&r.approval&&before.approval_no!==r.approval)))throw Error('저장된 원거래와 다른 결제입니다. 반영을 중지했습니다.');
  }
  const statements=rows.map(r=>env.DB.prepare(`INSERT INTO payapp_sales(seller_id,mul_no,product_name,state,amount,refund_amount,requested_at,paid_at,approval_no,method,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(seller_id,mul_no) DO UPDATE SET
      product_name=CASE WHEN excluded.product_name='상품명 없음' THEN payapp_sales.product_name ELSE excluded.product_name END,
      state=CASE WHEN payapp_sales.state='refunded' OR excluded.state='refunded' THEN 'refunded' WHEN payapp_sales.paid_at IS NOT NULL AND excluded.state IN ('pending','cancelled') THEN payapp_sales.state ELSE excluded.state END,
      refund_amount=MAX(payapp_sales.refund_amount,excluded.refund_amount),paid_at=COALESCE(payapp_sales.paid_at,excluded.paid_at),requested_at=COALESCE(payapp_sales.requested_at,excluded.requested_at),
      approval_no=CASE WHEN excluded.approval_no='' THEN payapp_sales.approval_no ELSE excluded.approval_no END,method=CASE WHEN excluded.method='' THEN payapp_sales.method ELSE excluded.method END,
      origin=excluded.origin,received_at=datetime('now','+9 hours')
    WHERE payapp_sales.amount=excluded.amount AND (payapp_sales.approval_no='' OR excluded.approval_no='' OR payapp_sales.approval_no=excluded.approval_no)`)
    .bind(seller,r.mulNo,r.productName,r.state,r.amount,r.refund,r.requested,r.paid,r.approval,r.method,origin));
  if(partial){
    const r=rows[0];
    if(rows.length!==1||!/^\d{1,30}$/.test(partial.id)||partial.id===r.mulNo||!number(partial.amount)||partial.amount<=0||partial.amount>r.amount)throw Error('부분 환불 내역을 확인해 주세요.');
    const before=await env.DB.prepare('SELECT mul_no,amount FROM payapp_sales_refunds WHERE seller_id=? AND event_no=?').bind(seller,partial.id).first();
    if(before&&(before.mul_no!==r.mulNo||before.amount!==partial.amount))throw Error('기존 부분 환불과 다른 내역입니다.');
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO payapp_sales_refunds(seller_id,event_no,mul_no,amount) VALUES(?,?,?,?)').bind(seller,partial.id,r.mulNo,partial.amount));
    statements.push(env.DB.prepare(`UPDATE payapp_sales SET refund_amount=MIN(amount,MAX(refund_amount,(SELECT COALESCE(SUM(amount),0) FROM payapp_sales_refunds WHERE seller_id=? AND mul_no=?))) WHERE seller_id=? AND mul_no=?`).bind(seller,r.mulNo,seller,r.mulNo));
  }
  await env.DB.batch(statements);return rows.length;
}
// Website orders already contribute revenue. Collecting the common notification must not count them twice.
export const PAYAPP_WEBSITE_MATCH=`EXISTS(SELECT 1 FROM payapp_payments p WHERE p.mul_no=s.mul_no)`;
export function payappSource(env,withReservationDuplicates=false){
  const seller=payappConfig(env).userid.replace(/'/g,"''");
  return `(SELECT s.* FROM payapp_sales s WHERE s.seller_id='${seller}' AND s.review_state IN (${withReservationDuplicates?"'include','duplicate'":"'include'"}) AND s.state IN ('paid','refunded') AND s.paid_at IS NOT NULL AND NOT ${PAYAPP_WEBSITE_MATCH})`;
}

export async function payappOnlySummary(env,year,today){
  const direct=payappSource(env,true),web=`SELECT o.paid_at,o.amount-p.refunded_amount AS net,'orders' AS method FROM orders o JOIN payapp_payments p ON p.oid=o.oid WHERE o.status IN ('paid','used','refund_requested') AND o.test_mode=0 AND o.paid_at IS NOT NULL`;
  const source=`(${web} UNION ALL SELECT paid_at,amount-refund_amount AS net,'payapp_direct' AS method FROM ${direct})`;
  const all=async(sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results||[];
  const methods=[{key:'orders',label:'페이앱 · 홈페이지'},{key:'payapp_direct',label:'페이앱 · 직접 결제'}];
  const blank=()=>({orders:0,payapp_direct:0}),months=Array.from({length:12},(_,i)=>({ym:year+'-'+String(i+1).padStart(2,'0'),byMethod:blank(),count:blank(),total:0,n:0,refunds:0,unpaid:0}));
  const grouped=await all(`SELECT substr(paid_at,1,7) ym,method,COUNT(*) n,SUM(net) amount FROM ${source} GROUP BY ym,method`);
  const byMethod=blank(),countBy=blank();let allTotal=0,allN=0;
  for(const r of grouped){allTotal+=r.amount;allN+=r.n;const m=months.find(m=>m.ym===r.ym);if(!m)continue;m.byMethod[r.method]=r.amount;m.count[r.method]=r.n;m.total+=r.amount;m.n+=r.n;byMethod[r.method]+=r.amount;countBy[r.method]+=r.n;}
  const month=ym=>({ym,total:grouped.filter(r=>r.ym===ym).reduce((n,r)=>n+r.amount,0),n:grouped.filter(r=>r.ym===ym).reduce((n,r)=>n+r.n,0)});
  const total=months.reduce((n,m)=>n+m.total,0),n=months.reduce((n,m)=>n+m.n,0),byChannel={};
  methods.forEach(m=>byChannel[m.key]={label:m.label,amount:byMethod[m.key],n:countBy[m.key],share:total?byMethod[m.key]/total*100:0});
  const thisYm=today.slice(0,7),lastYm=new Date(Date.parse(thisYm+'-01T00:00:00Z')-864e5).toISOString().slice(0,7);
  const refundRows=await all(`SELECT substr(o.paid_at,1,7) ym,SUM(p.refunded_amount) amount FROM orders o JOIN payapp_payments p ON p.oid=o.oid WHERE o.test_mode=0 AND o.paid_at IS NOT NULL AND o.status IN ('paid','used','refund_requested','refunded') GROUP BY ym UNION ALL SELECT substr(paid_at,1,7) ym,SUM(refund_amount) amount FROM ${direct} GROUP BY ym`);
  refundRows.forEach(r=>{const m=months.find(m=>m.ym===r.ym);if(m)m.refunds+=r.amount||0;});
  return {ok:true,today,year,basis:'paid',withOrders:true,provider:'payapp',years:[...new Set([year,today.slice(0,4),...grouped.map(r=>r.ym.slice(0,4))])].sort().reverse(),methods,months,byMethod,countBy,total,n,refunds:months.reduce((n,m)=>n+m.refunds,0),bySpace:{},byChannel,channelTotal:total,unrecordedSpacecloud:0,allTime:{total:allTotal,n:allN},unpaid:{n:0,amount:0},thisMonth:month(thisYm),lastMonth:month(lastYm)};
}
