import '../../js/booking-rates.js';
import { clean, formatPhone, phoneDigits, validEmail } from './auth.js';
import { ensureSchema, isIsoDate, addDaysIso, dayIndex, kstToday } from './admin.js';
import { loadSpacecloud } from './spacecloud.js';
import { ensureBookingSchema, expireBookingRequests } from './booking-schema.js';
import { ensurePayappSchema } from './booking-payapp.js';
import { ensureSyncSchema,syncEnabled,loadWorkerCalendar,getSync,enqueueSync,requireVerifiedBlock } from './booking-spacecloud-sync.js';

export const BOOKING_RATES = globalThis.SF_BOOKING_RATES;
export const BOOKING_NOTICE = '2026-11-06';
export const BOOKING_PURPOSES = ['meeting','education','seminar','study','workshop','shooting','other'];
export const BOOKING_STATUSES = ['requested','awaiting_payment','confirmed','cancelled','expired','payment_review'];
export const BOOKING_COLUMNS = 'code, created_at, updated_at, status, room, date, start_min, end_min, people, customer_name, phone, email, company, purpose, purpose_detail, requests, amount, expires_at, payment_expires_at, approved_at, external_checked_at, payment_status, payment_id, payment_url, paid_at, refund_amount, memo';
export const isBookingConflict = error => /booking-conflict/.test(String(error?.message || error));
export const kstTimestamp = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0,19).replace('T',' ');
const paidTimestamp = value => {
  let text = typeof value === 'string' ? value : '';
  if (/^\d{14}$/.test(text)) text = text.slice(0,4)+'-'+text.slice(4,6)+'-'+text.slice(6,8)+' '+text.slice(8,10)+':'+text.slice(10,12)+':'+text.slice(12,14);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return kstTimestamp();
  const time = Date.parse(text.replace(' ','T')+'+09:00');
  return Number.isFinite(time) && kstTimestamp(time) === text ? text : kstTimestamp();
};

export async function prepareBookings(env) {
  await ensureSchema(env);
  await ensureBookingSchema(env);
  await ensurePayappSchema(env);
  await ensureSyncSchema(env);
  await expireBookingRequests(env);
}

const whole = value => typeof value === 'number' && Number.isInteger(value) ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
export function validateBooking(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { field: '', message: '예약 정보를 확인해 주세요.' };
  const v = { room: clean(body.room,20), date: clean(body.date,10), start_min: whole(body.start_min), end_min: whole(body.end_min),
    people: whole(body.people), customer_name: clean(body.name,80), phone: formatPhone(body.phone),
    email: clean(body.email,120), company: clean(body.company,120), purpose: clean(body.purpose,40),
    purpose_detail: clean(body.purpose_detail,500), requests: clean(body.requests,2000),
    submission_id: clean(body.submissionId,64) };
  const error = (field,message) => ({ field,message });
  if (!BOOKING_RATES.rooms[v.room]) return error('room','이용할 방을 골라 주세요.');
  const today = new Date(now + 9 * 3600000).toISOString().slice(0,10);
  if (!isIsoDate(v.date) || v.date < today || v.date > addDaysIso(today,365)) return error('date','오늘부터 1년 이내의 이용일을 골라 주세요.');
  if (!Number.isInteger(v.start_min) || v.start_min < 0 || v.start_min >= 1440 || v.start_min % 30) return error('start_min','시작 시각은 30분 단위로 골라 주세요.');
  if (!Number.isInteger(v.end_min) || v.end_min % 30 || v.end_min - v.start_min < 120 || v.end_min - v.start_min > 1440) return error('end_min','최소 2시간부터 최대 24시간까지 선택할 수 있습니다.');
  if (Date.parse(v.date + 'T00:00:00+09:00') + v.start_min * 60000 <= now) return error('start_min','현재 시각 이후의 이용시간을 골라 주세요.');
  if (!Number.isInteger(v.people) || v.people < 1 || v.people > BOOKING_RATES.rooms[v.room].max) return error('people',`이 방은 1명부터 최대 ${BOOKING_RATES.rooms[v.room].max}명까지 이용할 수 있습니다.`);
  if (!v.customer_name) return error('name','예약자 이름을 적어 주세요.');
  if (!/^0\d{8,10}$/.test(phoneDigits(body.phone))) return error('phone','연락 가능한 전화번호를 확인해 주세요.');
  if (v.email && !validEmail(v.email)) return error('email','이메일 주소를 확인해 주세요.');
  if (!BOOKING_PURPOSES.includes(v.purpose)) return error('purpose','공간 활용 목적을 골라 주세요.');
  if (v.purpose === 'other' && !v.purpose_detail) return error('purpose_detail','기타 이용 목적을 적어 주세요.');
  if (body.consent !== true) return error('consent','예약 정보 수집 및 이용 안내에 동의해 주세요.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v.submission_id)) return error('submissionId','화면을 새로고침한 후 다시 신청해 주세요.');
  return { value: v };
}

export function calculateBookingAmount({ room, date, start_min, end_min }) {
  const price = BOOKING_RATES.rooms[room];
  if (!price || !isIsoDate(date) || start_min % 30 || end_min % 30 || end_min <= start_min) throw new Error('invalid-quote');
  const holidays = new Set(BOOKING_RATES.holidays);
  const isHoliday = day => { const weekday = new Date(day + 'T00:00:00Z').getUTCDay(); return weekday === 0 || weekday === 6 || holidays.has(day); };
  let amount = 0;
  for (let minute = start_min; minute < end_min; minute += 30) {
    const day = addDaysIso(date,Math.floor(minute / 1440)), hour = (minute % 1440) / 60;
    const holiday = hour < 7 ? isHoliday(addDaysIso(day,-1)) && isHoliday(day) : isHoliday(day);
    const key = (holiday ? 'hd' : 'wd') + (hour < 12 ? 'Early' : 'Std');
    amount += price[key] / 2;
  }
  return Math.round(amount);
}

const overlap = (a,b) => {
  const start = dayIndex(a.date) * 1440 + a.start_min, end = dayIndex(a.date) * 1440 + a.end_min;
  const otherStart = dayIndex(b.date) * 1440 + b.start_min, otherEnd = dayIndex(b.date) * 1440 + b.end_min;
  return start < otherEnd && otherStart < end;
};

export async function bookingAvailability(env, room, date, { force = false } = {}) {
  const previous = addDaysIso(date,-1), next = addDaysIso(date,1);
  const [reservations, requests, external,worker,holds] = await Promise.all([
    env.DB.prepare(`SELECT date,start_min,end_min FROM reservations WHERE space=?1 AND status='confirmed' AND date BETWEEN ?2 AND ?3`).bind(room,previous,next).all(),
    env.DB.prepare(`SELECT date,start_min,end_min FROM booking_requests WHERE room=?1 AND date BETWEEN ?2 AND ?3
      AND (status IN ('awaiting_payment','confirmed') OR (status='requested' AND expires_at > datetime('now','+9 hours')))`)
      .bind(room,previous,next).all(),
    loadSpacecloud(env,{force}),
    loadWorkerCalendar(env,{room}),
    env.DB.prepare(`SELECT date,start_min,end_min FROM spacecloud_blocks WHERE room=?1 AND state IN ('pending','blocking','blocked','releasing','review')
      AND date BETWEEN ?2 AND ?3`).bind(room,previous,next).all()
  ]);
  const rows = [...(reservations.results || []), ...(requests.results || []), ...(holds.results || []), ...external.results.filter(r => r.space === room),...worker.results];
  const base = dayIndex(date) * 1440;
  const blocked = rows.map(r => ({ start_min: dayIndex(r.date) * 1440 + r.start_min - base, end_min: dayIndex(r.date) * 1440 + r.end_min - base }))
    .filter(r => r.end_min > 0 && r.start_min < 2880).sort((a,b) => a.start_min - b.start_min);
  const merged = [];
  for (const row of blocked) { const last = merged[merged.length-1]; if (last && row.start_min <= last.end_min) last.end_min = Math.max(last.end_min,row.end_min); else merged.push({...row}); }
  if (date === kstToday()) {
    const wall = new Date(Date.now() + 9 * 3600000);
    const past = Math.ceil((wall.getUTCHours() * 60 + wall.getUTCMinutes() + 1) / 30) * 30;
    merged.push({start_min:0,end_min:past});
  }
  const roomInfo = external.info.rooms?.find(r => r.space === room);
  const configured = !!roomInfo, stale = !configured || !!roomInfo.stale || !!external.info.error;
  const automatic=syncEnabled(env);
  return { ok:true, room,date,booking_open:env.SPACECLOUD_BOOKING_OPEN!=='false',today:kstToday(),capacity:BOOKING_RATES.rooms[room].max,min_minutes:120,step_minutes:automatic ? 60 : 30,
    blocked:merged, external:{configured,stale,checked_at:roomInfo?.checked_at || null,
      message:automatic ? '스페이스클라우드 예약을 함께 반영합니다. 신청 후 최신 일정과 시간 확보를 확인해야 결제할 수 있습니다.' : stale ? '외부 예약 일정은 운영자가 다시 확인합니다. 신청만으로 예약이 확정되지 않습니다.' : '외부 일정에는 반영 지연이 있을 수 있어 운영자 확인 후 결제를 안내합니다.'},
    message:automatic ? '예약 신청 → 외부 시간 확보 → 페이앱 결제 → 예약 확정' : '예약 신청 → 운영자 일정 확인 → 페이앱 결제 → 예약 확정' };
}

export async function externalBookingConflict(env, booking, { force = true } = {}) {
  const snapshot = await loadSpacecloud(env,{force});
  const worker=await loadWorkerCalendar(env,{room:booking.room});
  return snapshot.results.some(row => row.space === booking.room && overlap(booking,row))
    || worker.results.some(row => row.marker!=='SFWEB:'+booking.code && overlap(booking,row));
}

export async function getBooking(env, code) {
  return env.DB.prepare(`SELECT ${BOOKING_COLUMNS} FROM booking_requests WHERE code=?1`).bind(code).first();
}

async function paymentReview(env,{code,id,paidTime,time,memo}) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE booking_requests SET status='payment_review',payment_status='review',payment_id=?2,paid_at=?3,memo=?5,updated_at=?4 WHERE code=?1`)
      .bind(code,String(id),paidTime,time,memo),
    env.DB.prepare(`UPDATE spacecloud_blocks SET state='review',verified_at=NULL,error='결제 결과와 외부 시간 확보 확인 필요',updated_at=?2 WHERE code=?1`)
      .bind(code,Date.now()),
    env.DB.prepare(`UPDATE spacecloud_sync_jobs SET state=CASE WHEN state='leased' THEN 'review' ELSE 'cancelled' END,updated_at=?2
      WHERE booking_code=?1 AND state IN ('queued','leased')`).bind(code,Date.now())
  ]);
  return {ok:true,review:true};
}

/** 페이앱 통보 인증·금액 검증은 호출자가 먼저 완료해야 합니다. */
export async function applyBookingPayment(env, { code,id,state,paid_at,refund_amount = 0,external_verified = false }) {
  await prepareBookings(env);
  const booking = await getBooking(env,code);
  if (!booking) return { ok:false, error:'not-found' };
  if (booking.payment_id && String(booking.payment_id) !== String(id)) return { ok:false,error:'payment-mismatch' };
  const time = kstTimestamp(), paidTime = paidTimestamp(paid_at);
  if (state === 'paid') {
    if (booking.status === 'confirmed' && ['paid','refund_pending'].includes(booking.payment_status)) return { ok:true,already:true };
    if (booking.status !== 'awaiting_payment' || ['cancelling','releasing'].includes(booking.payment_status)) {
      return paymentReview(env,{code,id,paidTime,time,memo:'취소·만료 후 결제 통보: 일정과 환불 확인 필요'});
    }
    const block=await getSync(env,code);
    if(block && (block.state!=='blocked' || block.cancel_requested || ['cancelling','releasing'].includes(booking.payment_status))) {
      return paymentReview(env,{code,id,paidTime,time,memo:'외부 시간 확보 해제 중 결제 통보: 일정·환불 확인 필요'});
    }
    if(block && !external_verified) {
      await env.DB.prepare(`INSERT INTO spacecloud_payment_checks(code,after_ms) VALUES(?1,?2) ON CONFLICT(code) DO NOTHING`).bind(code,Date.now()).run();
      const checking=await env.DB.prepare(`UPDATE booking_requests SET payment_status='paid_verifying',payment_id=?2,paid_at=?3,updated_at=?4
        WHERE code=?1 AND status='awaiting_payment' AND payment_status IN ('creating','pending','paid_verifying')
        AND EXISTS (SELECT 1 FROM spacecloud_blocks s WHERE s.code=booking_requests.code AND s.state='blocked' AND s.cancel_requested=0)`)
        .bind(code,String(id),paidTime,time).run();
      if(!Number(checking.meta?.changes))return paymentReview(env,{code,id,paidTime,time,memo:'결제 통보 중 상태 변경: 일정·결제내역 확인 필요'});
      await enqueueSync(env,booking,'verify');
      return {ok:true,pending:true};
    }
    if(block) {
      const verified=await requireVerifiedBlock(env,booking);
      const after=await env.DB.prepare('SELECT after_ms FROM spacecloud_payment_checks WHERE code=?1').bind(code).first();
      if(after && (verified.verified_at<after.after_ms || Number(verified.receipt?.job_created_at || 0)<after.after_ms)) {await enqueueSync(env,booking,'verify');return {ok:true,pending:true};}
    }
    try {
      const payable=`status='awaiting_payment' AND payment_status NOT IN ('cancelling','releasing','review')
        AND NOT EXISTS (SELECT 1 FROM spacecloud_blocks s WHERE s.code=booking_requests.code AND (s.state<>'blocked' OR s.cancel_requested=1))`;
      const applied=await env.DB.batch([
        env.DB.prepare(`INSERT INTO reservations (code,status,space,date,start_min,end_min,customer_name,phone,people,purpose,channel,amount,pay_method,pay_status,paid_at,inquiry_ref,memo,refund_amount)
          SELECT code,'confirmed',room,date,start_min,end_min,customer_name,phone,people,purpose,'web',amount,'card_online',CASE WHEN refund_amount>0 THEN 'refunded' ELSE 'paid' END,?2,code,
          '홈페이지 페이앱 결제 · ' || COALESCE(company,'') || ' · ' || COALESCE(requests,''),refund_amount FROM booking_requests
          WHERE code=?1 AND ${payable} ON CONFLICT(code) DO NOTHING`).bind(code,paidTime.slice(0,10)),
        env.DB.prepare(`UPDATE booking_requests SET status='confirmed',payment_status=CASE WHEN refund_amount>0 THEN 'refund_pending' ELSE 'paid' END,payment_id=?2,paid_at=?3,
          expires_at=NULL,updated_at=?4 WHERE code=?1 AND ${payable}`).bind(code,String(id),paidTime,time)
      ]);
      if(!Number(applied[1]?.meta?.changes)) {
        const latest=await getBooking(env,code);
        if(latest.status==='confirmed' && latest.payment_status==='paid')return {ok:true,already:true};
        return paymentReview(env,{code,id,paidTime,time,memo:'동시 취소·결제 통보: 일정과 결제내역 확인 필요'});
      }
      return {ok:true};
    } catch (error) {
      if (!isBookingConflict(error)) throw error;
      return paymentReview(env,{code,id,paidTime,time,memo:'결제 후 일정 충돌: 자동 확정 보류, 운영자 환불 확인 필요'});
    }
  }
  if (state === 'refunded' || state === 'cancelled') {
    const refund = Math.max(booking.refund_amount || 0,Math.min(booking.amount,Number(refund_amount) || (state === 'refunded' ? booking.amount : 0)));
    if (booking.status === 'confirmed' && state === 'cancelled' && refund < booking.amount) {
      return {ok:false,error:'refund-confirmation-required'};
    }
    const full = booking.status !== 'confirmed' || refund >= booking.amount;
    await env.DB.batch([
      env.DB.prepare(`UPDATE reservations SET status=CASE WHEN ?2 THEN 'cancelled' ELSE status END,
        pay_status=CASE WHEN ?3 > 0 THEN 'refunded' ELSE pay_status END,refund_amount=?3,
        refunded_at=CASE WHEN ?3 > 0 THEN ?4 ELSE refunded_at END,
        cancelled_at=CASE WHEN ?2 THEN ?4 ELSE cancelled_at END,updated_at=?4 WHERE code=?1`).bind(code,full ? 1 : 0,refund,time),
      env.DB.prepare(`UPDATE booking_requests SET status=CASE
          WHEN ?2 AND ?5=0 AND paid_at IS NULL AND (status='expired' OR (expiry_requested_at IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM spacecloud_blocks WHERE code=?1))) THEN 'expired'
          WHEN ?2 THEN 'cancelled' ELSE status END,
        payment_status=?3,payment_id=?4,refund_amount=?5,updated_at=?6 WHERE code=?1`)
        .bind(code,full ? 1 : 0,refund > 0 ? 'refunded' : 'cancelled',String(id),refund,time)
    ]);
    return {ok:true};
  }
  if (state === 'refund_pending') {
    const refund = Math.max(0,Math.min(booking.amount,Number(refund_amount) || 0));
    await env.DB.batch([
      env.DB.prepare(`UPDATE reservations SET refund_amount=MAX(refund_amount,?2),
        pay_status=CASE WHEN ?2 > 0 THEN 'refunded' ELSE pay_status END,
        refunded_at=CASE WHEN ?2 > 0 THEN ?3 ELSE refunded_at END,updated_at=?4 WHERE code=?1`).bind(code,refund,time.slice(0,10),time),
      env.DB.prepare(`UPDATE booking_requests SET payment_status=CASE WHEN payment_status IN ('refunded','paid_verifying','review','cancelling','releasing') THEN payment_status ELSE 'refund_pending' END,
        refund_amount=MAX(refund_amount,?2),updated_at=?3 WHERE code=?1`).bind(code,refund,time)
    ]);
    if(booking.status==='awaiting_payment' && booking.payment_status!=='paid_verifying')
      return paymentReview(env,{code,id,paidTime,time,memo:'결제 확인 전 부분취소 통보: 결제내역과 예약 상태 확인 필요'});
    return {ok:true};
  }
  if (state === 'pending' || state === 'failed') {
    await env.DB.prepare(`UPDATE booking_requests SET payment_status=?2,payment_id=?3,updated_at=?4
      WHERE code=?1 AND status='awaiting_payment' AND payment_status IN ('unpaid','creating','pending')`).bind(code,state,String(id),time).run();
    return {ok:true};
  }
  return {ok:false,error:'unknown-state'};
}
