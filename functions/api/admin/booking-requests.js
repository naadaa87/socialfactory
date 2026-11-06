import { json,clean } from '../../_lib/auth.js';
import { adminGate,kstNow } from '../../_lib/admin.js';
import { prepareBookings,BOOKING_COLUMNS,BOOKING_STATUSES,getBooking,externalBookingConflict,isBookingConflict } from '../../_lib/booking.js';
import { createBookingPayment,cancelBookingPayment,payappConfig } from '../../_lib/booking-payapp.js';
import { syncEnabled,getSync } from '../../_lib/booking-spacecloud-sync.js';
import { startSynchronizedBooking,cancelSynchronizedBooking } from '../../_lib/booking-checkout.js';
import { wakeCloudRunner } from '../../_lib/spacecloud-runner.js';

export async function onRequestGet({request,env}) {
  const denied = await adminGate(request,env); if (denied) return denied;
  try {
    await prepareBookings(env);
    const url = new URL(request.url), status = clean(url.searchParams.get('status'),30);
    const where = BOOKING_STATUSES.includes(status) ? ' WHERE status=?1' : '';
    const statement = env.DB.prepare(`SELECT ${BOOKING_COLUMNS} FROM booking_requests${where} ORDER BY created_at DESC,id DESC LIMIT 500`);
    const {results} = await (where ? statement.bind(status) : statement).all();
    const enriched=await Promise.all((results || []).map(async item=>{
      const sync=await getSync(env,item.code);return {...item,sync_state:sync?.state || null};
    }));
    return json({ok:true,results:enriched,payapp:{ready:payappConfig(env).ready},sync:{enabled:syncEnabled(env),ready:syncEnabled(env) && String(env.SPACECLOUD_WORKER_TOKEN || '').length>=32}});
  } catch (error) {
    console.error('admin-bookings-get',error?.message);
    return json({ok:false,error:'db-error',message:'예약 신청을 불러오지 못했습니다.'},500);
  }
}

export async function onRequestPatch({request,env,waitUntil}) {
  const denied = await adminGate(request,env); if (denied) return denied;
  let body; try { body = await request.json(); } catch { return json({ok:false,error:'bad-json'},400); }
  const code = clean(body?.code,30), action = clean(body?.action,20);
  try {
    await prepareBookings(env);
    const booking = await getBooking(env,code);
    if (!booking) return json({ok:false,error:'not-found',message:'신청을 찾을 수 없습니다.'},404);
    if (action === 'approve') {
      if(syncEnabled(env)) {
        if(booking.status==='requested')await startSynchronizedBooking(env,booking);
        const sync=await getSync(env,code);
        if(!sync)return json({ok:false,message:'자동 연동 상태를 확인해 주세요.'},409);
        await wakeCloudRunner(env,{waitUntil});
        return json({ok:true,item:{...await getBooking(env,code),sync_state:sync.state},pending:!booking.payment_url});
      }
      if (booking.status === 'awaiting_payment' && booking.payment_url) return json({ok:true,item:booking,already:true});
      if (booking.status !== 'requested') return json({ok:false,error:'state',message:'검토 중인 신청만 승인할 수 있습니다.'},409);
      if (body.external_checked !== true) return json({ok:false,error:'external-check',message:'스페이스클라우드 등 외부 채널의 예약과 해당 시간 판매 중지를 확인해 주세요.'},400);
      if (!payappConfig(env).ready) return json({ok:false,error:'payapp-not-ready',message:'페이앱 연결 설정을 먼저 완료해 주세요.'},503);
      if (Date.parse(booking.date+'T00:00:00+09:00') + booking.start_min * 60000 <= Date.now()) return json({ok:false,error:'past',message:'이용 시작시간이 지난 신청은 승인할 수 없습니다.'},409);
      if (await externalBookingConflict(env,booking)) return json({ok:false,error:'conflict',message:'외부 일정과 겹칩니다. 예약 시간을 다시 확인해 주세요.'},409);
      const transition = await env.DB.prepare(`UPDATE booking_requests SET status='awaiting_payment',payment_status='creating',approved_at=?2,
        external_checked_at=?2,updated_at=?2 WHERE code=?1 AND status='requested' AND expires_at > ?2`).bind(code,kstNow()).run();
      if (!Number(transition?.meta?.changes)) return json({ok:false,error:'state',message:'신청 상태가 변경되었습니다. 목록을 새로고침해 주세요.'},409);
      try {
        const payment = await createBookingPayment(env,{booking:await getBooking(env,code),request});
        await env.DB.prepare(`UPDATE booking_requests SET payment_id=?2,payment_url=?3,
          payment_status=CASE WHEN payment_status='creating' THEN 'pending' ELSE payment_status END,updated_at=?4 WHERE code=?1`)
          .bind(code,String(payment.id),payment.url,kstNow()).run();
        return json({ok:true,item:await getBooking(env,code)});
      } catch (error) {
        await env.DB.prepare(`UPDATE booking_requests SET payment_status='review',memo='페이앱 결제요청 결과 확인 필요. 판매자 결제내역 확인 전 시간 점유 해제 금지.',updated_at=?2 WHERE code=?1 AND payment_status='creating'`).bind(code,kstNow()).run();
        return json({ok:false,error:clean(error?.code,60) || 'payment-request',message:clean(error?.message,200) || '결제요청 결과를 확인해 주세요. 중복 발행하지 마세요.'},Number(error?.status) || 502);
      }
    }
    if (action === 'cancel') {
      if(await getSync(env,code)) {
        await cancelSynchronizedBooking(env,booking);
        await wakeCloudRunner(env,{waitUntil});
        return json({ok:true,item:{...await getBooking(env,code),sync_state:(await getSync(env,code)).state},pending:true});
      }
      if (booking.status === 'cancelled' || booking.status === 'expired') return json({ok:true,item:booking,already:true});
      if (booking.status === 'confirmed' || booking.status === 'payment_review') return json({ok:false,error:'payment-review',message:'결제·환불 내역을 먼저 확인해야 합니다. 페이앱 판매자 화면에서 확인해 주세요.'},409);
      if (booking.status === 'awaiting_payment') {
        if (booking.payment_status === 'creating') return json({ok:false,error:'payment-creating',message:'결제요청 생성 중입니다. 잠시 후 다시 확인해 주세요.'},409);
        await cancelBookingPayment(env,{booking,request});
      }
      await env.DB.prepare(`UPDATE booking_requests SET status='cancelled',payment_status=CASE WHEN payment_status='unpaid' THEN 'unpaid' ELSE 'cancelled' END,
        memo=?2,updated_at=?3 WHERE code=?1 AND status IN ('requested','awaiting_payment')`).bind(code,clean(body.reason,500),kstNow()).run();
      return json({ok:true,item:await getBooking(env,code)});
    }
    return json({ok:false,error:'invalid',message:'지원하지 않는 작업입니다.'},400);
  } catch (error) {
    if (isBookingConflict(error)) return json({ok:false,error:'conflict',message:'같은 시간에 다른 예약이 있습니다. 일정을 다시 확인해 주세요.'},409);
    console.error('admin-bookings-change',error?.code || error?.message);
    return json({ok:false,error:clean(error?.code,60) || 'db-error',message:clean(error?.message,200) || '신청을 변경하지 못했습니다.'},Number(error?.status) || 500);
  }
}

export const onRequestPost = onRequestPatch;
