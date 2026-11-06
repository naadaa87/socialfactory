import { json,clean,sameOrigin,sha256Hex,ipHashOf,randomToken } from '../../_lib/auth.js';
import { prepareBookings,validateBooking,calculateBookingAmount,externalBookingConflict,getBooking,kstTimestamp,isBookingConflict } from '../../_lib/booking.js';
import { syncEnabled,getSync } from '../../_lib/booking-spacecloud-sync.js';
import { startSynchronizedBooking,syncStatusUrl } from '../../_lib/booking-checkout.js';
import { payappConfig } from '../../_lib/booking-payapp.js';
import { wakeCloudRunner } from '../../_lib/spacecloud-runner.js';
import { assertCloudAdmission } from '../../_lib/booking-cloud-admission.js';

const success = (booking,duplicate = false,sync = null) => json({ok:true,code:booking.code,status:booking.status,amount:booking.amount,duplicate,
  ...(sync ? {status_url:syncStatusUrl(sync),sync:{state:sync.state}} : {}),
  expires_at:booking.expires_at,message:booking.status === 'requested'
    ? '신청이 접수되었습니다. 운영자가 외부 일정을 확인한 뒤 페이앱 결제를 안내합니다. 결제 전에는 예약이 확정되지 않습니다.'
    : booking.status === 'confirmed' ? '이미 예약이 확정된 신청입니다.'
    : booking.status === 'awaiting_payment' ? '일정 확인이 완료되었습니다. 운영자가 안내한 결제 링크를 확인해 주세요.'
    : '이전에 접수한 신청입니다. 현재 상태는 운영자에게 문의해 주세요.'});

export async function onRequestPost({request,env,waitUntil}) {
  if(env.SPACECLOUD_BOOKING_OPEN==='false')return json({ok:false,error:'booking-preparing',message:'온라인 예약을 준비 중입니다. 잠시 후 다시 확인하거나 담당자에게 문의해 주세요.'},503);
  if (!sameOrigin(request)) return json({ok:false,error:'origin',message:'홈페이지에서 다시 신청해 주세요.'},403);
  let body;
  try { const text = await request.text(); if (text.length > 16000) return json({ok:false,error:'too-large',message:'입력 내용이 너무 깁니다.'},413); body = JSON.parse(text); }
  catch { return json({ok:false,error:'bad-json',message:'예약 정보를 확인해 주세요.'},400); }
  if (clean(body?.website,100)) return json({ok:true,code:'B000000-000000',status:'requested',amount:0});
  const parsed = validateBooking(body);
  if (!parsed.value) return json({ok:false,error:'invalid',field:parsed.field,message:parsed.message},400);
  if (!env.DB) return json({ok:false,error:'no-db',message:'예약 신청을 준비 중입니다. 카카오톡으로 문의해 주세요.'},503);
  const value = parsed.value;
  if(syncEnabled(env) && (value.start_min%60 || value.end_min%60))return json({ok:false,error:'sync-time-step',field:'start_min',message:'자동 연동 예약은 1시간 단위로 선택해 주세요.'},400);
  if(syncEnabled(env) && (!payappConfig(env).ready || String(env.SPACECLOUD_WORKER_TOKEN || '').length<32))return json({ok:false,error:'sync-not-ready',message:'온라인 예약 결제를 준비 중입니다. 담당자에게 문의해 주세요.'},503);
  try {
    await prepareBookings(env);
    const fingerprint = await sha256Hex(JSON.stringify(value));
    const previous = await env.DB.prepare('SELECT code,fingerprint FROM booking_requests WHERE submission_id=?1').bind(value.submission_id).first();
    if (previous) {
      if (previous.fingerprint !== fingerprint) return json({ok:false,error:'submission-reused',message:'이전 신청과 입력 내용이 달라졌습니다. 화면을 새로고침한 뒤 다시 신청해 주세요.'},409);
      let booking=await getBooking(env,previous.code),sync=syncEnabled(env) ? await getSync(env,previous.code) : null;
      if(syncEnabled(env) && !sync && (booking.status==='requested' || (booking.status==='awaiting_payment' && booking.payment_status==='sync_pending'))) {sync=await startSynchronizedBooking(env,booking);booking=await getBooking(env,previous.code);}
      if(sync && ['pending','blocking'].includes(sync.state))await wakeCloudRunner(env,{waitUntil});
      return success(booking,true,sync);
    }
    const ip = await ipHashOf(request,env);
    const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM booking_requests
      WHERE created_at > datetime('now','+9 hours','-10 minutes') AND (phone=?1 OR (?2 <> '' AND ip_hash=?2))`).bind(value.phone,ip).first();
    if (Number(recent?.n) >= 5) return json({ok:false,error:'too-many',message:'신청이 많이 접수되었습니다. 10분 뒤 다시 시도하거나 카카오톡으로 문의해 주세요.'},429);
    // Existing receipts remain accessible; only a new hold needs live readiness.
    if(syncEnabled(env))await assertCloudAdmission(env);
    if (await externalBookingConflict(env,value)) return json({ok:false,error:'conflict',field:'start_min',message:'선택한 시간에 다른 예약이 있습니다. 다른 시간을 골라 주세요.'},409);
    const amount = calculateBookingAmount(value);
    const start = Date.parse(value.date+'T00:00:00+09:00') + value.start_min * 60000;
    const expires = kstTimestamp(Math.min(Date.now() + 24 * 3600000,start));
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = 'B'+value.date.replace(/-/g,'').slice(2)+'-'+randomToken(8).replace(/[^A-Za-z0-9]/g,'').slice(0,10).toUpperCase();
      try {
        await env.DB.prepare(`INSERT INTO booking_requests
          (code,submission_id,fingerprint,room,date,start_min,end_min,people,customer_name,phone,email,company,purpose,purpose_detail,requests,amount,consent,notice_version,ip_hash,expires_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,1,'2026-11-06',?17,?18)`)
          .bind(code,value.submission_id,fingerprint,value.room,value.date,value.start_min,value.end_min,value.people,value.customer_name,value.phone,value.email,value.company,
            value.purpose,value.purpose_detail,value.requests,amount,ip,expires).run();
        const sync=syncEnabled(env) ? await startSynchronizedBooking(env,await getBooking(env,code)) : null;
        if(sync)await wakeCloudRunner(env,{waitUntil});
        return success(await getBooking(env,code),false,sync);
      } catch (error) {
        if (isBookingConflict(error)) return json({ok:false,error:'conflict',field:'start_min',message:'선택한 시간에 예약 또는 검토 중인 신청이 있습니다. 다른 시간을 골라 주세요.'},409);
        if (/UNIQUE.*submission_id/i.test(String(error?.message))) {
          const duplicate = await env.DB.prepare('SELECT code,fingerprint FROM booking_requests WHERE submission_id=?1').bind(value.submission_id).first();
          if (duplicate?.fingerprint === fingerprint) return success(await getBooking(env,duplicate.code),true,syncEnabled(env) ? await getSync(env,duplicate.code) : null);
          return json({ok:false,error:'submission-reused',message:'신청 정보를 새로 확인한 뒤 다시 시도해 주세요.'},409);
        }
        if (/UNIQUE.*code/i.test(String(error?.message))) continue;
        throw error;
      }
    }
    throw new Error('booking-code-collision');
  } catch (error) {
    if(error?.code==='cloud-admission-unavailable')return json({ok:false,error:error.code,message:error.message},503);
    console.error('booking-request',error?.message);
    return json({ok:false,error:'unavailable',message:'신청을 저장하지 못했습니다. 잠시 후 다시 시도하거나 카카오톡으로 문의해 주세요.'},503);
  }
}
