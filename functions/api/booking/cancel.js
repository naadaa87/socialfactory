import { json,clean,sameOrigin } from '../../_lib/auth.js';
import { paymentContext } from './payment-status.js';
import { cancelBookingRequest } from '../../_lib/booking-checkout.js';
import { wakeCloudRunner } from '../../_lib/spacecloud-runner.js';
import { scheduleBookingNotices } from '../../_lib/booking-notify.js';

export async function onRequestPost({request,env,waitUntil}) {
  if(!sameOrigin(request))return json({ok:false,message:'홈페이지에서 다시 진행해 주세요.'},403);
  let body;try{body=await request.json();}catch{return json({ok:false,message:'예약 정보를 확인해 주세요.'},400);}
  let bookingCode;
  try {
    const context=await paymentContext(env,clean(body?.code,64),clean(body?.t,128));
    if(!context?.booking || !context.block)return json({ok:false,message:'예약 확인 링크를 확인해 주세요.'},404);
    bookingCode=context.booking.code;
    await cancelBookingRequest(env,context.booking);
    await wakeCloudRunner(env,{waitUntil});
    return json({ok:true,pending:true,message:'예약 시간 확보를 해제하고 있습니다.'},202);
  } catch(error) {return json({ok:false,message:error.code ? error.message : '취소 결과를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.'},error.status || 503);}
  finally {if(bookingCode)await scheduleBookingNotices(env,waitUntil,{code:bookingCode});}
}
