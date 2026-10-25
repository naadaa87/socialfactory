import {json} from '../_lib/auth.js';
import {syncDevice,exchange,validRows,markSync} from '../_lib/spacecloud-sync.js';
import {onRequestPost as previewImport} from './admin/spacecloud-import.js';
export async function onRequestPost({request,env}){
 if(!env.DB||!env.ADMIN_KEY)return json({ok:false,message:'동기화 서버 설정 필요'},503);
 let b;try{const text=await request.text();if(text.length>2000000)throw Error();b=JSON.parse(text);}catch{return json({ok:false,message:'요청 형식 오류'},400);}
 if(!b||typeof b!=='object')return json({ok:false},400);
 if(b.action==='pair'){
  const result=await exchange(env,b.code);return result?json({ok:true,...result}):json({ok:false,message:'연결 코드가 만료됐거나 이미 사용됐습니다.'},401);
 }
 const device=await syncDevice(request,env);if(!device)return json({ok:false,message:'동기화 연결이 만료되거나 해제됐습니다.'},401);
 if(b.action==='error'){
  const status=['login_required','collection_error','paused'].includes(b.status)?b.status:'collection_error';
  await markSync(env,status,({login_required:'호스트센터 재로그인이 필요합니다.',paused:'자동 동기화 일시 중지',collection_error:'수집 실패: 확장 도구 상태를 확인해 주세요.'})[status]);return json({ok:true});
 }
 if(b.action!=='sync'||b.complete!==true||!Number.isSafeInteger(b.observed_at)||b.observed_at>Date.now()+60000||b.observed_at<Date.now()-600000)
  return json({ok:false,message:'전체 수집 완료 또는 최신 수집 시각을 확인할 수 없습니다.'},400);
 let rows;try{rows=validRows(b.rows);}catch(e){await markSync(env,'collection_error',e.message);return json({ok:false,message:e.message},400);}
 const counts={added:0,refunded:0,unchanged:0,review:0,stale:0};
 // The existing importer validates calendar links and potential manual-sale duplicates for new IDs.
 let preview=[];
 if(rows.length){const r=await previewImport({env,request:new Request(new URL('/api/admin/spacecloud-import',request.url),{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_KEY,'content-type':'application/json'},body:JSON.stringify({action:'preview',rows})})});const p=await r.json();if(!r.ok)return json({ok:false,message:p.message||'가져오기 검증 실패'},r.status);preview=p.rows;}
 const ops=[];
 for(const row of rows){
  const prev=await env.DB.prepare('SELECT * FROM spacecloud_sales WHERE reservation_id=?1').bind(row.reservation_id).first();
  let reason='';const p=preview.find(x=>x.reservation_id===row.reservation_id);
  if(prev&&prev.sync_seen>=b.observed_at){counts.stale++;continue;}
  if(row.after_settlement_refund>0)reason='정산 후 별도 취소금액: 취소금액과의 중복 여부 확인 필요';
  if(prev){
   if(['amount','paid_at','use_date','end_date'].some(k=>row[k]!==prev[k]))reason='기존 결제금액 또는 날짜와 다름';
   if(row.refund_amount<prev.refund_amount)reason='기록된 환불금액보다 작은 자료: 자동 환불 복원 차단';
  }else if(p?.state==='blocked')reason=p.reason;
  if(reason){counts.review++;ops.push(env.DB.prepare(`INSERT INTO spacecloud_sync_audit(reservation_id,observed_at,before_refund,after_refund,action,reason)
 SELECT ?1,?2,?3,?4,'review',?5 WHERE NOT EXISTS(SELECT 1 FROM spacecloud_sync_audit WHERE reservation_id=?1 AND action='review' AND reason=?5 AND after_refund=?4)`)
 .bind(row.reservation_id,b.observed_at,prev?.refund_amount??null,row.refund_amount,reason));continue;}
  if(prev){
   const changed=row.refund_amount>prev.refund_amount;counts[changed?'refunded':'unchanged']++;
   ops.push(env.DB.prepare(`UPDATE spacecloud_sales SET refund_amount=?2,sync_seen=?3 WHERE reservation_id=?1 AND sync_seen<?3 AND refund_amount<=?2 AND amount=?4 AND paid_at=?5 AND use_date=?6 AND end_date=?7`)
    .bind(row.reservation_id,row.refund_amount,b.observed_at,row.amount,row.paid_at,row.use_date,row.end_date));
   if(changed)ops.push(env.DB.prepare(`INSERT INTO spacecloud_sync_audit(reservation_id,observed_at,before_refund,after_refund,action) VALUES(?1,?2,?3,?4,'refund')`).bind(row.reservation_id,b.observed_at,prev.refund_amount,row.refund_amount));
  }else{
   counts.added++;ops.push(env.DB.prepare(`INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,linked_code,space,sync_seen)
 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(reservation_id) DO NOTHING`).bind(row.reservation_id,row.use_date,row.end_date,row.paid_at,row.amount,row.refund_amount,p?.linked_code||null,p?.space||'other',b.observed_at));
  }
 }
 // No missing booking is deleted or changed to zero. A failed retry can safely repeat completed writes.
 try{for(let i=0;i<ops.length;i+=50)await env.DB.batch(ops.slice(i,i+50));}
 catch{await markSync(env,'collection_error','서버 저장 실패. 다음 주기에 중복 없이 재시도합니다.');return json({ok:false,message:'서버 저장 실패'},500);}
 await markSync(env,counts.review?'review':'ok',counts.review?'일부 기록은 관리자 확인이 필요합니다.':'자동 동기화 완료',counts,true);
 return json({ok:true,counts});
}
