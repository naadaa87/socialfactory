import { json } from '../../_lib/auth.js';
import { adminGate, isIsoDate } from '../../_lib/admin.js';
import { loadSpacecloud } from '../../_lib/spacecloud.js';
import { ensureSpacecloudSales } from '../../_lib/spacecloud-sales.js';

const validMoney = n => Number.isSafeInteger(n) && n >= 0 && n <= 100000000;
export async function onRequestPost({request,env}) {
  const deny = await adminGate(request,env); if (deny) return deny;
  if (Number(request.headers.get('content-length')) > 2000000) return json({ok:false,message:'파일이 너무 큽니다.'},413);
  let b; try { const text=await request.text(); if(text.length>2000000) throw Error(); b=JSON.parse(text); }
  catch { return json({ok:false,message:'가져오기 데이터를 읽을 수 없습니다.'},400); }
  if (!['preview','commit'].includes(b.action) || !Array.isArray(b.rows) || !b.rows.length || b.rows.length>5000 || b.rows.some(r=>!r || typeof r!=='object'))
    return json({ok:false,message:'한 번에 1~5,000건을 가져올 수 있습니다.'},400);
  await ensureSpacecloudSales(env);
  const external = await loadSpacecloud(env);
  const manual = (await env.DB.prepare("SELECT code,channel,date,space,amount,refund_amount,paid_at FROM reservations WHERE channel='spacecloud'").all()).results || [];
  const imported = (await env.DB.prepare('SELECT * FROM spacecloud_sales').all()).results || [];
  const byId = new Map(imported.map(x=>[x.reservation_id,x]));
  const seen=new Set(), rows=[];
  for (const x of b.rows) {
    const r={reservation_id:String(x.reservation_id||''),use_date:x.use_date,end_date:x.end_date,paid_at:x.paid_at,amount:x.amount,refund_amount:x.refund_amount,space:'other',linked_code:null};
    let reason='';
    if(!/^\d{1,16}$/.test(r.reservation_id) || !isIsoDate(r.use_date) || !isIsoDate(r.end_date) || r.end_date<r.use_date || !isIsoDate(r.paid_at) || !validMoney(r.amount) || !validMoney(r.refund_amount) || r.refund_amount>r.amount) reason='예약번호·날짜·결제/취소금액 오류';
    if(x.venue !== '소셜팩토리 건대 (초특가)') reason='다른 공간 또는 확인되지 않은 공간';
    if(seen.has(r.reservation_id)) reason='파일 안에 예약번호 중복'; seen.add(r.reservation_id);
    const matches=external.results.filter(e=>(e.source_url||'').split('/').pop()===r.reservation_id);
    if(matches.length) r.space=matches[0].space;
    const codes=new Set(matches.map(e=>e.code));
    const linked=manual.filter(m=>codes.has(m.code));
    // Calendar hashes already saved manually are recognized even after the feed no longer contains them only via the saved import link.
    const prev=byId.get(r.reservation_id);
    if(prev) { r.linked_code=prev.linked_code; r.space=prev.space; }
    else if(linked.length===1) {
      r.linked_code=linked[0].code;
      if(linked[0].amount!==r.amount || linked[0].refund_amount!==r.refund_amount || linked[0].paid_at!==r.paid_at)
        reason='기존 수기 매출과 결제금액·환불금액·결제일이 다름';
    }
    const ambiguous=manual.filter(m=>m.date>=r.use_date && m.date<=r.end_date && m.code!==r.linked_code);
    if(ambiguous.length) reason='같은 이용일의 기존 스페이스클라우드 매출 확인 필요';
    let state=reason?'blocked':'new';
    if(!reason && prev) {
      state=['use_date','end_date','paid_at','amount','refund_amount'].every(k=>prev[k]===r[k])?'unchanged':'blocked';
      if(state==='blocked') reason='기존 가져오기 금액/날짜와 다름: 환불 또는 변경 확인 필요';
    }
    rows.push({...r,state,reason});
  }
  if(b.action==='commit') {
    // Re-evaluate conflicts on every request; UNIQUE reservation_id also protects repeat/concurrent uploads.
    const ready=rows.filter(r=>r.state==='new');
    if(rows.some(r=>r.state==='blocked')) return json({ok:false,message:'확인이 필요한 행이 있습니다. 해당 행을 제외한 파일로 다시 가져와 주세요.',rows},409);
    if(ready.length) await env.DB.batch(ready.map(r=>env.DB.prepare(`INSERT INTO spacecloud_sales
      (reservation_id,use_date,end_date,paid_at,amount,refund_amount,linked_code,space)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(reservation_id) DO NOTHING`)
      .bind(r.reservation_id,r.use_date,r.end_date,r.paid_at,r.amount,r.refund_amount,r.linked_code,r.space)));
    return json({ok:true,rows,message:'가져오기를 완료했습니다. 같은 예약번호는 한 번만 합산합니다.'});
  }
  return json({ok:true,rows,total:rows.filter(r=>r.state==='new').reduce((s,r)=>s+r.amount-r.refund_amount,0)});
}
