import { json,clean,safeEqual,sameOrigin } from '../../_lib/auth.js';
import { ensurePayappSchema,validPayappUrl } from '../../_lib/booking-payapp.js';
import { prepareBookings,getBooking,externalBookingConflict } from '../../_lib/booking.js';
import { getSync,requireVerifiedBlock,enqueueSync } from '../../_lib/booking-spacecloud-sync.js';
import { wakeCloudRunner } from '../../_lib/spacecloud-runner.js';
import { assertCloudAdmission } from '../../_lib/booking-cloud-admission.js';

const capacityFailure=()=>json({ok:false,error:'cloud-admission-unavailable',message:'온라인 예약 연동을 점검 중입니다. 잠시 후 다시 시도하거나 담당자에게 문의해 주세요.'},503);

export async function paymentContext(env,code,token) {
  await prepareBookings(env);await ensurePayappSchema(env);
  const row=await env.DB.prepare('SELECT * FROM booking_payapp_requests WHERE code=?1').bind(code).first();
  const block=await getSync(env,code);
  if (!token || !((row && safeEqual(token,row.token)) || (block && safeEqual(token,block.access_token)))) return null;
  const booking=(row?.kind==='room' || block) ? await getBooking(env,code) : null;
  return {row,block,booking};
}
const future = booking => booking && Date.parse(booking.date+'T00:00:00+09:00')+booking.start_min*60000>Date.now();
const publicSync = block => block ? {state:block.state,message:({pending:'외부 예약 시간을 확인하고 있습니다.',blocking:'스페이스클라우드 시간을 확보하고 있습니다.',
  blocked:'예약 시간을 확보했습니다. 결제 직전 일정을 다시 확인합니다.',releasing:'결제 취소를 확인했습니다. 예약 시간 확보를 해제하고 있습니다.',
  released:'예약 시간 확보가 해제되었습니다.',review:'담당자가 외부 예약 상태를 확인하고 있습니다. 추가 결제 없이 기다려 주세요.',conflict:'선택한 시간에 다른 예약이 있어 결제를 진행할 수 없습니다.'})[block.state]} : null;

export async function onRequestGet({request,env}) {
  if(!env.DB)return json({ok:false,message:'연결을 확인하고 다시 시도해 주세요.'},503);
  const url=new URL(request.url),code=clean(url.searchParams.get('code'),64),token=clean(url.searchParams.get('t'),128);
  const context=await paymentContext(env,code,token);
  if(!context)return json({ok:false,message:'결제 확인 링크를 확인해 주세요.'},404);
  const {row,block,booking}=context;
  const eligible=!!(row && ['requested','pending'].includes(row.status) && validPayappUrl(row.pay_url)
    && (!booking || (booking.status==='awaiting_payment' && future(booking))) && (!block || (block.state==='blocked' && !block.cancel_requested)));
  let fresh=!block;
  if(block && eligible) {try{await requireVerifiedBlock(env,booking);fresh=true;}catch{}}
  let status=row?.status || 'sync_pending';
  if(booking?.payment_status==='paid_verifying')status='paid_verifying';
  if(block?.state==='review')status='sync_review';
  else if(block?.state==='conflict')status='sync_conflict';
  else if(block?.state==='releasing')status='releasing';
  else if(block?.state==='released' && (!row || row.status==='failed'))status='cancelled';
  const canCancel=!!(booking && block && ['requested','awaiting_payment'].includes(booking.status)
    && !['creating','paid','paid_verifying','cancelling','review','refund_pending'].includes(booking.payment_status) && !['review','released','releasing','conflict'].includes(block.state));
  return json({ok:true,code,kind:row?.kind || 'room',label:row?.label || `소셜팩토리 ${booking.room.replace('r','')}번룸 ${booking.date}`,
    amount:row?.amount ?? booking.amount,refund_amount:row?.refund_amount || 0,status,paid_at:row?.paid_at || null,
    booking:booking ? {room:booking.room,date:booking.date,start_min:booking.start_min,end_min:booking.end_min,people:booking.people,status:booking.status,payment_status:booking.payment_status} : null,
    sync:publicSync(block),can_start_payment:eligible,can_pay:eligible && fresh,can_cancel:canCancel});
}

export async function onRequestPost({request,env,waitUntil}) {
  if(!sameOrigin(request))return json({ok:false,message:'홈페이지에서 다시 진행해 주세요.'},403);
  if(!env.DB)return json({ok:false,message:'연결을 확인하고 다시 시도해 주세요.'},503);
  let body;try{body=await request.json();}catch{return json({ok:false,message:'입력값을 확인해 주세요.'},400);}
  if(body?.consent!==true)return json({ok:false,message:'예약·청구 조건과 개인정보 안내를 확인해 주세요.'},400);
  const context=await paymentContext(env,clean(body.code,64),clean(body.t,128));
  if(!context)return json({ok:false,message:'결제 확인 링크를 확인해 주세요.'},404);
  const {row,block,booking}=context;
  if(!row || !['requested','pending'].includes(row.status) || !validPayappUrl(row.pay_url))return json({ok:false,message:'현재 결제를 진행할 수 없습니다. 담당자에게 확인해 주세요.'},409);
  if(row.kind==='room') {
    if(!booking || booking.status!=='awaiting_payment' || !future(booking))return json({ok:false,message:'예약 상태나 이용시간이 변경되었습니다. 담당자에게 확인해 주세요.'},409);
    if(block) {
      try {await requireVerifiedBlock(env,booking);}
      catch(error) {
        if(block.state!=='blocked' || block.cancel_requested)return json({ok:false,message:'외부 예약 시간을 확인하고 있습니다. 현재 결제를 진행할 수 없습니다.'},409);
        try{await assertCloudAdmission(env);}catch{return capacityFailure();}
        await enqueueSync(env,booking,'verify');
        await wakeCloudRunner(env,{waitUntil});
        return json({ok:true,pending:true,message:'스페이스클라우드 최신 일정을 확인하고 있습니다.'},202);
      }
    } else if(await externalBookingConflict(env,booking))return json({ok:false,message:'외부 일정이 변경되었습니다. 담당자에게 확인해 주세요.'},409);
  }
  const accepted=await env.DB.prepare(`UPDATE booking_payapp_requests SET accepted_at=datetime('now','+9 hours'),consent_version='2026-11-06'
    WHERE code=?1 AND status IN ('requested','pending')`).bind(row.code).run();
  if(!Number(accepted.meta?.changes))return json({ok:false,message:'결제 상태가 변경되었습니다. 다시 확인해 주세요.'},409);
  if(block) {
    try{await assertCloudAdmission(env);}catch{return capacityFailure();}
    const latest=await getBooking(env,row.code);
    if(latest?.status!=='awaiting_payment' || latest.payment_status!=='pending')return json({ok:false,message:'예약 상태가 변경되었습니다. 다시 확인해 주세요.'},409);
    // The status request can take time: its response cannot refresh calendar proof.
    try{await requireVerifiedBlock(env,latest);}catch{return json({ok:false,message:'스페이스클라우드 최신 일정을 다시 확인한 뒤 결제를 진행해 주세요.'},409);}
  }
  return json({ok:true,url:row.pay_url});
}
