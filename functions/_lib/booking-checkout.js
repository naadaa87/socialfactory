import { getBooking, kstTimestamp,applyBookingPayment } from './booking.js';
import { createBookingPayment, cancelBookingPayment, payappConfig, ensurePayappSchema } from './booking-payapp.js';
import { syncEnabled, getSync, enqueueSync, queueRelease, requireVerifiedBlock, syncError } from './booking-spacecloud-sync.js';

export const syncStatusUrl = row => '/booking-status?code='+encodeURIComponent(row.code)+'&t='+encodeURIComponent(row.access_token);

export async function startSynchronizedBooking(env, booking) {
  if (!syncEnabled(env)) return null;
  if (!payappConfig(env).ready) throw syncError('payapp-not-ready','온라인 예약 결제를 준비 중입니다. 담당자에게 문의해 주세요.',503);
  const result=await env.DB.prepare(`UPDATE booking_requests SET status='awaiting_payment',payment_status='sync_pending',
    expires_at=NULL,updated_at=?2 WHERE code=?1 AND status='requested'`).bind(booking.code,kstTimestamp()).run();
  if (!Number(result.meta?.changes) && booking.status!=='awaiting_payment') return null;
  return enqueueSync(env,booking,'block');
}

/** Only a proved external block may reach the provider. Replayed worker acks are safe. */
export async function onSyncCompleted(env, code) {
  const block=await getSync(env,code),booking=await getBooking(env,code);
  if (!block || !booking) return;
  if (block.state==='released' || block.state==='conflict') {
    await ensurePayappSchema(env);
    const payment=await env.DB.prepare('SELECT status FROM booking_payapp_requests WHERE code=?1').bind(code).first();
    if (payment && !['failed','cancelled','refunded'].includes(payment.status)) {
      await env.DB.prepare(`UPDATE booking_requests SET status='payment_review',payment_status='review',
        memo='외부 시간 해제 후 결제내역 확인 필요',updated_at=?2 WHERE code=?1`).bind(code,kstTimestamp()).run();
      return;
    }
    await env.DB.prepare(`UPDATE booking_requests SET status='cancelled',payment_status=CASE WHEN payment_status='refunded' THEN payment_status ELSE 'cancelled' END,
      updated_at=?2 WHERE code=?1 AND status IN ('requested','awaiting_payment','cancelled','expired')
      AND payment_status NOT IN ('paid','paid_verifying','review','refund_pending')
      AND NOT EXISTS (SELECT 1 FROM booking_payapp_requests p WHERE p.code=booking_requests.code AND p.status IN ('paid','review','partial_refund'))`).bind(code,kstTimestamp()).run();
    return;
  }
  if(block.state==='blocked' && !block.cancel_requested && booking.status==='awaiting_payment' && booking.payment_status==='paid_verifying') {
    await requireVerifiedBlock(env,booking);
    await applyBookingPayment(env,{code,id:booking.payment_id,state:'paid',paid_at:booking.paid_at,external_verified:true});
    return;
  }
  if (block.cancel_requested || block.state!=='blocked' || booking.status!=='awaiting_payment' || booking.payment_status!=='sync_pending') return;
  await requireVerifiedBlock(env,booking);
  const transition=await env.DB.prepare(`UPDATE booking_requests SET payment_status='creating',approved_at=?2,external_checked_at=?2,
    updated_at=?2 WHERE code=?1 AND status='awaiting_payment' AND payment_status='sync_pending'`).bind(code,kstTimestamp()).run();
  if (!Number(transition.meta?.changes)) return;
  try {
    const payment=await createBookingPayment(env,{booking});
    await env.DB.prepare(`UPDATE booking_requests SET payment_id=?2,payment_url=?3,
      payment_status=CASE WHEN payment_status='creating' THEN 'pending' ELSE payment_status END,updated_at=?4 WHERE code=?1`)
      .bind(code,String(payment.id),payment.url,kstTimestamp()).run();
  } catch(error) {
    if (error.code==='PAYAPP_REJECTED' || error.code==='PAYAPP_NOT_CONFIGURED') {
      await env.DB.prepare(`UPDATE booking_requests SET payment_status='releasing',memo='결제요청 미발행: 외부 시간 해제 중',updated_at=?2
        WHERE code=?1 AND payment_status='creating'`).bind(code,kstTimestamp()).run();
      await queueRelease(env,await getBooking(env,code));
      return;
    }
    await env.DB.prepare(`UPDATE booking_requests SET payment_status='review',memo='결제요청 결과 확인 필요. 외부 시간 확보 유지.',updated_at=?2
      WHERE code=?1 AND payment_status='creating'`).bind(code,kstTimestamp()).run();
    throw error;
  }
}

export async function cancelSynchronizedBooking(env, booking) {
  const block=await getSync(env,booking.code);
  if (!block) return false;
  if (block.state==='released' || block.state==='conflict') {await onSyncCompleted(env,booking.code);return true;}
  if (['confirmed','payment_review'].includes(booking.status) || ['creating','review','paid','paid_verifying','refund_pending'].includes(booking.payment_status))
    throw syncError('payment-review','결제·환불 결과를 먼저 확인해야 합니다. 시간은 계속 확보됩니다.');
  if(booking.payment_status==='releasing' || block.cancel_requested)return true;
  const claim=await env.DB.prepare(`UPDATE booking_requests SET payment_status='cancelling',updated_at=?2 WHERE code=?1
    AND status IN ('requested','awaiting_payment') AND payment_status IN ('unpaid','sync_pending','pending','failed')`)
    .bind(booking.code,kstTimestamp()).run();
  if(!Number(claim.meta?.changes))throw syncError('payment-state-changed','예약 상태가 변경되었습니다. 다시 확인해 주세요.');
  // A return page or closed browser is never evidence that the provider payment failed.
  try {await cancelBookingPayment(env,{booking});}
  catch(error) {
    await env.DB.prepare(`UPDATE booking_requests SET payment_status='review',memo='결제 취소 결과 확인 필요. 외부 시간 확보 유지.',updated_at=?2
      WHERE code=?1 AND payment_status='cancelling'`).bind(booking.code,kstTimestamp()).run();
    throw error;
  }
  const latest=await getBooking(env,booking.code);
  if(latest.status==='cancelled' && ['cancelled','refunded'].includes(latest.payment_status)) {await queueRelease(env,latest);return true;}
  const release=await env.DB.prepare(`UPDATE booking_requests SET payment_status='releasing',updated_at=?2 WHERE code=?1
    AND status IN ('requested','awaiting_payment') AND payment_status='cancelling'`).bind(booking.code,kstTimestamp()).run();
  if(!Number(release.meta?.changes))throw syncError('payment-state-changed','결제 상태가 변경되어 시간 해제를 보류했습니다. 담당자에게 확인해 주세요.');
  await queueRelease(env,await getBooking(env,booking.code));
  return true;
}

export async function releaseAfterPayment(env, code) {
  const booking=await getBooking(env,code),block=await getSync(env,code);
  if (!booking || !block || !['cancelled','expired'].includes(booking.status)) return;
  if (['paid','review','refund_pending'].includes(booking.payment_status)) return;
  await queueRelease(env,booking);
}

/** The continuously running worker polls this sweep; provider-ready cancellation is required. */
export async function sweepUnpaidBookings(env) {
  if(!syncEnabled(env))return;
  const minutes=Math.max(5,Math.min(60,Number(env.BOOKING_PAYMENT_HOLD_MINUTES) || 15));
  const cutoff=kstTimestamp(Date.now()-minutes*60000);
  const {results}=await env.DB.prepare(`SELECT b.code FROM booking_requests b JOIN spacecloud_blocks s ON s.code=b.code
    WHERE b.status='awaiting_payment' AND b.payment_status IN ('sync_pending','pending','failed')
    AND COALESCE(b.approved_at,b.created_at)<?1 AND s.state IN ('pending','blocking','blocked')
    ORDER BY b.created_at LIMIT 5`).bind(cutoff).all();
  for(const item of results || []) {
    try {await cancelSynchronizedBooking(env,await getBooking(env,item.code));}
    catch(error) {console.error('booking-hold-cleanup',error.code || 'cleanup-pending');}
  }
}
