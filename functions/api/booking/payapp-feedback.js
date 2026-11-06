import { validateFeedback, recordFeedback, accumulateRefund } from '../../_lib/booking-payapp.js';
import { applyBookingPayment } from '../../_lib/booking.js';
import { releaseAfterPayment } from '../../_lib/booking-checkout.js';
import { wakeCloudRunner } from '../../_lib/spacecloud-runner.js';

const reply=(text,status=200)=>new Response(text,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
export async function onRequestPost({request,env,waitUntil}) {
  if(Number(request.headers.get('content-length') || 0)>65536) return reply('INVALID',413);
  try {
    const body=await request.text();
    if(body.length>65536) return reply('INVALID',413);
    const fields=Object.fromEntries(new URLSearchParams(body));
    const notification=await validateFeedback(env,fields);
    const {row,event}=notification;
    if(notification.stale && ['pending','cancelled'].includes(event.state)) return reply('SUCCESS');
    // Older request notifications must never undo an approved payment or cancellation.
    if(event.state==='pending' && ['paid','cancelled','refunded','partial_refund'].includes(row.status)) return reply('SUCCESS');
    if(event.state==='paid' && ['refunded','partial_refund'].includes(row.status)) return reply('SUCCESS');
    if(event.state==='refund_pending' && row.status==='refunded') return reply('SUCCESS');
    await accumulateRefund(env,notification);
    let result={ok:true};
    if(row.kind==='room') result=await applyBookingPayment(env,event);
    if(!result || result.ok===false) return reply('RETRY',503);
    if(result.review || (row.kind==='office' && event.state==='paid' && row.status==='cancelled')) notification.event={...event,state:'review'};
    await recordFeedback(env,notification);
    if(row.kind==='room' && ['cancelled','refunded'].includes(event.state))await releaseAfterPayment(env,row.code);
    if(row.kind==='room')await wakeCloudRunner(env,{waitUntil});
    return reply('SUCCESS');
  } catch(error) {
    console.error('payapp-feedback',error.code || 'processing-error');
    return reply('RETRY',error.status || 503);
  }
}
