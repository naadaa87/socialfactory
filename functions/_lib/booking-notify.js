import {approvedWebsiteTemplate,sendAligo} from './aligo.js';
import {phoneDigits} from './auth.js';
import {sendAligoSms} from './guest-sms.js';
import {prepareBookings} from './booking.js';
import {ensurePayappSchema} from './booking-payapp.js';
import {BOOKING_TEMPLATES} from './booking-templates.js';
import {renderAligoMessage} from './aligo.js';

const channelLabels = {confirmed:'확정',cancelled:'취소',partial:'부분환불',review:'확인필요'};
const phonePattern = /^01[016789]\d{7,8}$/;
const kst = "datetime('now','+9 hours')";
const eligibleBookings = `
  SELECT b.*, p.token AS checkout_token,
    CASE
      WHEN b.status='cancelled' AND p.status='refunded' AND b.refund_amount=p.refund_amount AND b.refund_amount>0 THEN 'cancelled'
      WHEN b.status='confirmed' AND p.status='partial_refund' AND b.refund_amount=p.refund_amount AND b.refund_amount>0 THEN 'partial'
      WHEN b.status='confirmed' AND b.payment_status='paid' AND p.status='paid' AND b.refund_amount=0 THEN 'confirmed'
      WHEN b.status='payment_review' AND (p.status IN ('review','paid') OR p.provider_state='4') THEN 'review'
    END AS notice
  FROM booking_requests b JOIN booking_payapp_requests p ON p.code=b.code AND p.kind='room'
  WHERE b.payment_id=p.mul_no AND p.paid_at IS NOT NULL
`;
const version = "CASE WHEN b.notice='partial' THEN b.refund_amount ELSE 0 END";

export async function ensureBookingNotifications(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS booking_notifications (
    code TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
    recipient TEXT NOT NULL, last4 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (${kst}), updated_at TEXT NOT NULL DEFAULT (${kst}),
    PRIMARY KEY(code,kind,version,recipient))`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_booking_notice_queue ON booking_notifications(state,created_at)').run();
}

function config(env) {
  const start = String(env.BOOKING_NOTIFY_START || '');
  const staff = [...new Set(String(env.BOOKING_NOTIFY_STAFF || '').split(',').map(phone=>phone.trim()).filter(phone=>phonePattern.test(phone)))];
  return {start:/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start) ? start : '',staff,
    customer:env.BOOKING_NOTIFY_CUSTOMER==='1'};
}

function slotTime(minutes) {
  return (minutes>=1440?'익일 ':'')+String(Math.floor((minutes%1440)/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
}

const won = amount => Number(amount).toLocaleString('ko-KR');

export function bookingNoticeMessage(booking, kind) {
  const space = booking.room.slice(1)+'번룸';
  const time = slotTime(booking.start_min)+'~'+slotTime(booking.end_min);
  if(kind==='review')return {sms:`[소셜팩토리] 결제 확인필요 ${booking.code} ${won(booking.amount)}원`};
  const template=BOOKING_TEMPLATES[kind];
  const shortDate=booking.date.slice(5).replace('-','/');
  const amount=won(kind==='confirmed'?booking.amount:booking.refund_amount);
  const sms=`[소셜팩토리] ${space} ${shortDate} ${time} ${channelLabels[kind]} ${amount}원 ${booking.code}`;
  const message=renderAligoMessage(template,{
    예약번호:booking.code,조회키:booking.checkout_token,공간:space,
    이용일시:booking.date+' '+time,인원:booking.people,
    결제금액:won(booking.amount),환불금액:won(booking.refund_amount),
    남은금액:won(Math.max(0,booking.amount-booking.refund_amount))
  });
  // The direct SMS is kept short. AlimTalk fallback includes the protected booking link.
  return {sms,template,message};
}

export async function runBookingNotifications(env,{limit=15}={}) {
  const {start,staff,customer}=config(env);
  const test=env.BOOKING_NOTIFY_LIVE!=='1';
  const sendEnv={...env,ALIGO_TEST_MODE:test?'Y':'N'};
  if(!start)return {enabled:false};
  await prepareBookings(env);
  await ensurePayappSchema(env);
  await ensureBookingNotifications(env);
  if(env.BOOKING_NOTIFY_REQUIRE_SMS_TEST==='1') {
    const {results}=await env.DB.prepare("SELECT recipient,last4 FROM booking_notifications WHERE code='operator-test' AND state='accepted'").all();
    if(staff.length!==2 || !staff.every((phone,index)=>results.some(row=>row.recipient==='staff'+index && row.last4===phone.slice(-4)))) {
      return {enabled:false,waitingForOperatorTest:true};
    }
  }
  const targets=staff.map((phone,index)=>({key:'staff'+index,phone}));
  if(customer)targets.push({key:'customer'});
  for(const {key,phone} of targets) {
    await env.DB.prepare(`INSERT OR IGNORE INTO booking_notifications (code,kind,version,recipient,last4)
      SELECT b.code,b.notice,${version},?1,CASE WHEN ?1='customer' THEN substr(b.phone,-4) ELSE ?2 END
      FROM (${eligibleBookings}) b WHERE b.updated_at>=?3
      AND b.updated_at>=datetime('now','+9 hours','-1 day')
      AND b.notice IS NOT NULL AND (?1<>'customer' OR b.notice<>'review')`)
      .bind(key,phone?.slice(-4)||'',start).run();
  }
  await env.DB.prepare(`UPDATE booking_notifications SET state='unknown',updated_at=${kst}
    WHERE state='sending' AND updated_at<datetime('now','+9 hours','-10 minutes')`).run();
  await env.DB.prepare(`UPDATE booking_notifications SET state='skipped',updated_at=${kst}
    WHERE state='queued' AND (created_at<datetime('now','+9 hours','-1 day') OR NOT EXISTS (
      SELECT 1 FROM (${eligibleBookings}) b WHERE b.code=booking_notifications.code
        AND b.notice=booking_notifications.kind AND ${version}=booking_notifications.version
        AND (booking_notifications.recipient<>'customer' OR substr(b.phone,-4)=booking_notifications.last4)
    ))`).run();

  const {results}=await env.DB.prepare("SELECT DISTINCT kind FROM booking_notifications WHERE state='queued' AND recipient='customer'").all();
  const approvals=new Set();
  if(customer)await Promise.all(results.map(async ({kind})=>{
    const template=BOOKING_TEMPLATES[kind];
    if(template && (env[template.env] || template.code) && await approvedWebsiteTemplate(env,template))approvals.add(kind);
  }));
  const allow=[...approvals];
  const {results:jobs}=await env.DB.prepare(`SELECT * FROM booking_notifications WHERE state='queued'
    AND ((recipient<>'customer') OR kind IN (?1,?2,?3))
    ORDER BY created_at,recipient LIMIT ?4`).bind(allow[0]||'',allow[1]||'',allow[2]||'',limit).all();
  const out={enabled:true,accepted:0,test:0,failed:0,unknown:0,waiting:results.length-allow.length};
  for(const job of jobs) {
    const update=(state,id=null)=>env.DB.prepare(`UPDATE booking_notifications SET state=?,message_id=?,updated_at=${kst}
      WHERE code=? AND kind=? AND version=? AND recipient=? AND state='sending'`)
      .bind(state,id,job.code,job.kind,job.version,job.recipient).run();
    const claim=await env.DB.prepare(`UPDATE booking_notifications SET state='sending',updated_at=${kst}
      WHERE code=? AND kind=? AND version=? AND recipient=? AND state='queued'`)
      .bind(job.code,job.kind,job.version,job.recipient).run();
    if(!claim.meta.changes)continue;
    const booking=await env.DB.prepare(`SELECT b.* FROM (${eligibleBookings}) b
      WHERE b.code=? AND b.notice=? AND ${version}=?`).bind(job.code,job.kind,job.version).first();
    const isCustomer=job.recipient==='customer';
    const phone=isCustomer?phoneDigits(booking?.phone):targets.find(target=>target.key===job.recipient)?.phone;
    if(!booking || !phonePattern.test(phone||'') || phone.slice(-4)!==job.last4) {
      await update('skipped');
      continue;
    }
    let result;
    try {
      const {sms,template,message}=bookingNoticeMessage(booking,job.kind);
      result=isCustomer?await sendAligo(sendEnv,{phone},message,template):await sendAligoSms(env,phone,sms,{test});
    } catch(error) {
      const failure=isCustomer?error.retryable!==false:error.confirmedFailure===true;
      const state=failure?'failed':'unknown';
      await update(state);
      out[state]++;
      continue;
    }
    const state=result.test?'test':'accepted';
    await update(state,result.messageId);
    out[state]++;
  }
  return out;
}

export async function testBookingOperatorSms(env) {
  const {staff}=config(env);
  if(staff.length!==2)return {configured:false,results:[]};
  await ensureBookingNotifications(env);
  const results=[];
  // One live connection test per destination. Production booking events use their own keys.
  for(const [index,phone] of staff.entries()) {
    const key='staff'+index;
    const last4=phone.slice(-4);
    const claim=await env.DB.prepare(`INSERT OR IGNORE INTO booking_notifications
      (code,kind,version,recipient,last4,state) VALUES ('operator-test','test',0,?,?,'sending')`)
      .bind(key,last4).run();
    if(claim.meta.changes) {
      let state,id=null;
      try {
        const result=await sendAligoSms(env,phone,'[소셜팩토리] 공간대관 운영자 문자 수신 시험');
        id=result.messageId;
        state='accepted';
      } catch(error) {
        state=error.confirmedFailure?'failed':'unknown';
      }
      await env.DB.prepare(`UPDATE booking_notifications SET state=?,message_id=?,updated_at=${kst}
        WHERE code='operator-test' AND recipient=?`).bind(state,id,key).run();
    }
    const row=await env.DB.prepare("SELECT last4,state FROM booking_notifications WHERE code='operator-test' AND recipient=?").bind(key).first();
    results.push(row);
  }
  return {configured:true,results};
}
