import { reconcileAdminReservations } from '../../_lib/admin-spacecloud-sync.js';
import { json } from '../../_lib/auth.js';
import { prepareBookings } from '../../_lib/booking.js';
import { workerAuthorized,syncEnabled,claimSyncJob,finishSyncJob,heartbeatSyncJob,saveWorkerCalendar } from '../../_lib/booking-spacecloud-sync.js';
import { sweepUnpaidBookings } from '../../_lib/booking-checkout.js';
import { loadSpacecloud } from '../../_lib/spacecloud.js';
import { refreshCalendarDisplay } from '../../_lib/spacecloud-display.js';

import { scheduleBookingNotices } from '../../_lib/booking-notify.js';

const gate = (request,env) => !workerAuthorized(request,env) ? json({ok:false,error:'unauthorized'},401)
  : !syncEnabled(env) ? json({ok:false,error:'sync-disabled'},503) : null;
const failure = error => json({ok:false,error:error?.code || 'sync-error',message:error?.code ? error.message : '예약 연동 작업을 처리하지 못했습니다.'},Number(error?.status) || 503);
export async function onRequestGet({request,env}) {
  const denied=gate(request,env);if(denied)return denied;
  try {await prepareBookings(env);await sweepUnpaidBookings(env);await loadSpacecloud(env);await reconcileAdminReservations(env);return json({ok:true,job:await claimSyncJob(env)});}catch(error){return failure(error);}
}
export async function onRequestPost({request,env,waitUntil}) {
  const denied=gate(request,env);if(denied)return denied;
  let body;try {const text=await request.text();if(text.length>300000)return json({ok:false,error:'too-large'},413);body=JSON.parse(text);}catch{return json({ok:false,error:'bad-json'},400);}
  let noticeOptions;
  try {
    await prepareBookings(env);
    // This action deliberately never claims a job. Payment expiry must keep running
    // even when the browser is logged out, quarantined or out of usage allowance.
    if(body?.action==='maintenance') {
      noticeOptions={};
      await sweepUnpaidBookings(env);await refreshCalendarDisplay(env);
      const adminSync=await reconcileAdminReservations(env);
      return json({ok:true,maintenance:true,admin_sync:adminSync});
    }
    if(body?.action==='heartbeat')return json(await heartbeatSyncJob(env,body));
    if(body?.action==='snapshot')return json(await saveWorkerCalendar(env,body));
    if(body?.action!=='complete')return json({ok:false,error:'invalid-action'},400);
    const result=await finishSyncJob(env,body);
    noticeOptions={code:result.code};
    // A repeated completion also retries a failed post-acknowledgement payment finalization.
    if(result.status==='succeeded' || result.status==='conflict') {
      const {onSyncCompleted}=await import('../../_lib/booking-checkout.js');
      await onSyncCompleted(env,result.code);
      await reconcileAdminReservations(env);
      // A released hold can still be present in the five-minute iCal cache.
      // Refresh the real feed; retain its conservative stale fallback on errors.
      if(result.status==='succeeded' && result.state==='released') await loadSpacecloud(env,{force:true});
    }
    return json(result);
  }catch(error){
    if(error?.code==='cloud-admission-unavailable')await scheduleBookingNotices(env,waitUntil,{integrationFailed:true});
    return failure(error);
  } finally {
    if(noticeOptions)await scheduleBookingNotices(env,waitUntil,noticeOptions);
  }
}
