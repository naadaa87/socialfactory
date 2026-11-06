import { json,clean } from '../../_lib/auth.js';
import { isIsoDate,addDaysIso,kstToday } from '../../_lib/admin.js';
import { BOOKING_RATES,prepareBookings,bookingAvailability } from '../../_lib/booking.js';

export async function onRequestGet({request,env}) {
  const url = new URL(request.url), room = clean(url.searchParams.get('room'),20), date = clean(url.searchParams.get('date'),10);
  if (!BOOKING_RATES.rooms[room]) return json({ok:false,error:'invalid',field:'room',message:'이용할 방을 골라 주세요.'},400);
  if (!isIsoDate(date) || date < kstToday() || date > addDaysIso(kstToday(),365)) return json({ok:false,error:'invalid',field:'date',message:'오늘부터 1년 이내의 이용일을 골라 주세요.'},400);
  if (!env.DB) return json({ok:false,error:'no-db',message:'예약 신청을 준비 중입니다. 카카오톡으로 문의해 주세요.'},503);
  try {
    await prepareBookings(env);
    return json(await bookingAvailability(env,room,date));
  } catch (error) {
    console.error('booking-availability',error?.message);
    return json({ok:false,error:'unavailable',message:'예약 시간을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503);
  }
}
