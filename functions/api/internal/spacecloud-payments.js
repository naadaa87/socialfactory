import { json } from '../../_lib/auth.js';
import { workerAuthorized } from '../../_lib/booking-spacecloud-sync.js';
import { beginCloudSales, cloudSalesState, cloudSalesSummary, finishCloudSales } from '../../_lib/spacecloud-cloud-sales.js';
import { ensureSync } from '../../_lib/spacecloud-sync.js';
import { syncSnapshot } from '../spacecloud-sync.js';

const failures = {
  'login-required':'클라우드 호스트 로그인 다시 연결이 필요합니다. 재연결하면 지난 내역부터 확인합니다.',
  'daily-budget':'클라우드 브라우저 사용 한도에 도달했습니다. 예산이 확보되면 재시도합니다.',
  'runner-busy':'다른 클라우드 예약 작업을 처리 중입니다. 다음 주기에 재시도합니다.',
  'browser-deadline':'수집 제한 시간에 도달했습니다. 같은 기간을 다시 확인합니다.',
  'host-layout':'정산 화면과 조회 결과가 일치하지 않습니다. 확인 후 같은 기간을 다시 수집합니다.',
  'sync-rejected':'수집한 결제의 저장을 완료하지 못했습니다. 같은 기간을 다시 확인합니다.'
};
export async function onRequestPost({request,env}) {
  if(!workerAuthorized(request,env))return json({ok:false,error:'unauthorized'},401);
  if(!env.DB || !env.ADMIN_KEY)return json({ok:false,error:'not-configured'},503);
  let b;try {
    const text=await request.text();
    if(text.length>2000000)return json({ok:false,error:'too-large'},413);
    b=JSON.parse(text);
  }catch{return json({ok:false,error:'bad-json'},400);}
  if(b?.action==='status')return json({ok:true,cloud:await cloudSalesSummary(env)});
  if(b?.action==='begin')return json({ok:true,plan:await beginCloudSales(env,{retry:b.retry===true})});
  if(!['sync','error'].includes(b?.action))return json({ok:false,error:'invalid-action'},400);
  const state=await cloudSalesState(env);
  if(state.status!=='running' || !Number.isSafeInteger(b.observed_at) || b.observed_at!==state.last_attempt)
    return json({ok:false,error:'stale-attempt'},409);
  if(b.action==='error'){
    const code=typeof b.error==='string' && b.error.startsWith('host-')?'host-layout':b.error;
    const message=Object.hasOwn(failures,code)?failures[code]:'클라우드 결제 수집을 완료하지 못했습니다. 같은 기간을 다시 확인합니다.';
    await finishCloudSales(env,state,'error',message);
    return json({ok:true});
  }
  if(!Array.isArray(b.rows) || b.rows.some(row=>!row || row.paid_at<state.scan_from || row.paid_at>state.scan_to))
    return json({ok:false,error:'out-of-range'},400);
  await ensureSync(env);
  return syncSnapshot({request,env,b,report:(status,message,counts)=>finishCloudSales(env,state,
    status==='collection_error'?'error':status,message,counts)});
}
