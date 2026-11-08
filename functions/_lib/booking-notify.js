import {approvedWebsiteTemplate,renderAligoMessage,sendAligo} from './aligo.js';
import {phoneDigits} from './auth.js';
import {guestSmsConfig,sendAligoSms} from './guest-sms.js';
import {prepareBookings,kstTimestamp} from './booking.js';
import {validPayappUrl} from './booking-payapp.js';
import {bookingPaymentDeadline,bookingPaymentOpen} from './booking-checkout.js';
import {assertCloudAdmission} from './booking-cloud-admission.js';
import {BOOKING_TEMPLATES} from './booking-templates.js';

const channelLabels = {confirmed:'확정',cancelled:'취소',partial:'부분환불',review:'확인필요'};
const phonePattern = /^01[016789]\d{7,8}$/;
const kst = "datetime('now','+9 hours')";
const paidNotices = `
  SELECT b.code,b.updated_at AS event_at,p.token AS checkout_token,p.pay_url,b.refund_amount,
    CASE
      WHEN b.status='cancelled' AND p.status='refunded' AND b.refund_amount=p.refund_amount AND b.refund_amount>0 THEN 'cancelled'
      WHEN b.status='confirmed' AND p.status='partial_refund' AND b.refund_amount=p.refund_amount AND b.refund_amount>0 THEN 'partial'
      WHEN b.status='confirmed' AND b.payment_status='paid' AND p.status='paid' AND b.refund_amount=0 THEN 'confirmed'
      WHEN b.status='payment_review' AND (p.status IN ('review','paid') OR p.provider_state='4') THEN 'review'
    END AS notice
  FROM booking_requests b JOIN booking_payapp_requests p ON p.code=b.code AND p.kind='room'
  WHERE b.payment_id=p.mul_no AND p.paid_at IS NOT NULL
`;
const systemCode = 'spacecloud-system';
const customerLifecycleKinds = ['received','payment_ready','unpaid_expired'];
const staffUrgentKinds = ['review','paid_delay','sync_issue','sync_outage'];
const listSql = values => values.map(value=>"'"+value+"'").join(',');
const customerLifecycleSql = listSql(customerLifecycleKinds);
const staffUrgentSql = listSql(staffUrgentKinds);
const paidDelayMs = 120000;
const syncDelayMs = 300000;

// Re-evaluate the current state both when enqueueing and just before sending.
const bookingEvents = `
  WITH candidates AS (
    SELECT b.*,p.token,p.pay_url,p.mul_no,p.status AS provider_status,p.paid_at AS provider_paid_at,
      s.code AS sync_code,s.state AS sync_state,s.cancel_requested,s.updated_at AS sync_updated_at,
      checks.after_ms AS verification_started_at
    FROM booking_requests b
    LEFT JOIN booking_payapp_requests p ON p.code=b.code AND p.kind='room'
    LEFT JOIN spacecloud_blocks s ON s.code=b.code
    LEFT JOIN spacecloud_payment_checks checks ON checks.code=b.code
  ), events AS (
    SELECT code,notice,CASE WHEN notice='partial' THEN refund_amount ELSE 0 END AS version,event_at,checkout_token,pay_url
      FROM (${paidNotices}) WHERE notice IS NOT NULL
    UNION ALL
    SELECT code,'received',0,created_at,NULL,NULL FROM candidates
      WHERE status IN ('requested','awaiting_payment') AND payment_status IN ('unpaid','sync_pending','creating','pending')
        AND (sync_state IS NULL OR sync_state IN ('pending','blocking','blocked'))
    UNION ALL
    SELECT code,'payment_ready',0,updated_at,token,pay_url FROM candidates
      WHERE status='awaiting_payment' AND payment_status='pending' AND provider_status IN ('requested','pending')
        AND paid_at IS NULL AND provider_paid_at IS NULL AND token IS NOT NULL AND payment_id=mul_no
        AND (sync_code IS NULL OR (sync_state='blocked' AND cancel_requested=0))
        AND (payment_expires_at IS NULL OR payment_expires_at>${kst})
        AND datetime(date,'+'||start_min||' minutes')>${kst}
    UNION ALL
    SELECT code,'unpaid_expired',0,updated_at,NULL,NULL FROM candidates
      WHERE status='expired' AND paid_at IS NULL AND provider_paid_at IS NULL
        AND (provider_status IS NULL OR provider_status='cancelled')
        AND (sync_code IS NULL OR sync_state='released')
    UNION ALL
    SELECT code,'paid_delay',0,COALESCE(updated_at,created_at),NULL,NULL FROM candidates
      WHERE status='awaiting_payment' AND payment_status='paid_verifying'
        AND sync_state='blocked' AND provider_status IN ('paid','partial_refund')
        AND COALESCE(verification_started_at,unixepoch(paid_at||'+09:00')*1000)<=unixepoch()*1000-${paidDelayMs}
    UNION ALL
    SELECT code,'sync_issue',0,MAX(COALESCE(updated_at,created_at),
        COALESCE(datetime(sync_updated_at/1000,'unixepoch','+9 hours'),created_at)),NULL,NULL
      FROM candidates WHERE status<>'confirmed' AND NOT (
        status='payment_review' AND provider_paid_at IS NOT NULL AND provider_status IN ('paid','review'))
        AND (payment_status='review' OR sync_state IN ('review','conflict') OR
          (sync_state IN ('pending','blocking','releasing') AND sync_updated_at<=unixepoch()*1000-${syncDelayMs}) OR
          (payment_status IN ('creating','cancelling','sync_pending') AND updated_at<=datetime('now','+9 hours','-5 minutes')))
    UNION ALL
    SELECT '${systemCode}','sync_outage',incident_at,datetime(incident_at/1000,'unixepoch','+9 hours'),NULL,NULL
      FROM booking_integration_health WHERE unavailable=1
  )
`;

export async function ensureBookingNotifications(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS booking_notifications (
    code TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
    recipient TEXT NOT NULL, last4 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (${kst}), updated_at TEXT NOT NULL DEFAULT (${kst}),
    PRIMARY KEY(code,kind,version,recipient))`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_booking_notice_queue ON booking_notifications(state,created_at)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS booking_integration_health (
    id INTEGER PRIMARY KEY CHECK(id=1), unavailable INTEGER NOT NULL,
    incident_at INTEGER NOT NULL, checked_at INTEGER NOT NULL)`).run();
}

function config(env) {
  const start = String(env.BOOKING_NOTIFY_START || '');
  const staff = [...new Set(String(env.BOOKING_NOTIFY_STAFF || '').split(',').map(phone=>phone.trim()).filter(phone=>phonePattern.test(phone)))];
  return {start:/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start) ? start : '',staff,
    customer:env.BOOKING_NOTIFY_CUSTOMER==='1'};
}

async function bookingStaffReady(env, staff) {
  if(env.BOOKING_NOTIFY_REQUIRE_SMS_TEST!=='1')return staff.length>0;
  if(staff.length!==2)return false;
  const {results}=await env.DB.prepare("SELECT recipient,last4 FROM booking_notifications WHERE code='operator-test' AND state='accepted'").all();
  return staff.every((phone,index)=>results.some(row=>row.recipient==='staff'+index && row.last4===phone.slice(-4)));
}

export async function bookingNotificationSettings(env) {
  const {start,staff,customer}=config(env);
  return {
    started:!!start,
    live:env.BOOKING_NOTIFY_LIVE==='1',
    smsReady:guestSmsConfig(env).configured,
    customer,
    lifecycleTemplatesConfigured:customerLifecycleKinds.filter(kind=>String(env[BOOKING_TEMPLATES[kind].env] || '').trim()).length,
    staffReady:await bookingStaffReady(env,staff),
    staffCount:staff.length
  };
}

async function recordIntegrationHealth(env, unavailable, checkedAt) {
  await env.DB.prepare(`INSERT INTO booking_integration_health(id,unavailable,incident_at,checked_at) VALUES(1,?1,?2,?2)
    ON CONFLICT(id) DO UPDATE SET unavailable=excluded.unavailable,checked_at=excluded.checked_at,
      incident_at=CASE WHEN booking_integration_health.unavailable=0 THEN MAX(excluded.incident_at,booking_integration_health.incident_at+1) ELSE booking_integration_health.incident_at END
    WHERE excluded.checked_at>=booking_integration_health.checked_at`).bind(unavailable ? 1 : 0,checkedAt).run();
}

export async function scheduleBookingNotices(env, waitUntil, options = {}) {
  if (!config(env).start) return;
  const scope = options.integrationFailed ? {...options,code:systemCode} : options;
  const task = runBookingNotifications(env,scope).catch(()=>console.error('booking-notifications: queue unavailable'));
  if (typeof waitUntil === 'function') {
    try {waitUntil(task);return;}catch {}
  }
  await task;
}

function slotTime(minutes) {
  return (minutes>=1440?'익일 ':'')+String(Math.floor((minutes%1440)/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
}

const won = amount => Number(amount).toLocaleString('ko-KR');

function customerNotice(env, booking, kind, template) {
  return renderAligoMessage(template,{
    예약번호:booking.code,
    조회키:booking.checkout_token,
    공간:booking.room.slice(1)+'번룸',
    이용일시:booking.date+' '+slotTime(booking.start_min)+'~'+slotTime(booking.end_min),
    인원:booking.people,
    결제금액:won(booking.amount),
    결제기한:kind==='payment_ready' ? kstTimestamp(bookingPaymentDeadline(env,booking,!!booking.sync_code)).slice(0,16) : undefined,
    환불금액:won(booking.refund_amount),
    남은금액:won(Math.max(0,booking.amount-booking.refund_amount))
  });
}

function staffNotice(booking, kind) {
  if(kind==='sync_outage')return {text:'[소셜팩토리] 대관 연동 장애. 관리자 예약 메뉴에서 클라우드 상태를 확인해 주세요.',long:true};
  if(kind==='paid_delay')return {text:`[소셜팩토리] 결제 후 예약 확정 지연 ${booking.code}. 예약 상태를 확인해 주세요.`,long:true};
  if(kind==='sync_issue')return {text:`[소셜팩토리] 대관 연동 확인 필요 ${booking.code}. 관리자 예약 메뉴를 확인해 주세요.`,long:true};
  if(kind==='review')return {text:`[소셜팩토리] 결제 확인필요 ${booking.code} ${won(booking.amount)}원`};
  const space = booking.room.slice(1)+'번룸';
  const time = slotTime(booking.start_min)+'~'+slotTime(booking.end_min);
  const shortDate=booking.date.slice(5).replace('-','/');
  const amount=won(kind==='confirmed'?booking.amount:booking.refund_amount);
  return {text:`[소셜팩토리] ${space} ${shortDate} ${time} ${channelLabels[kind]} ${amount}원 ${booking.code}`};
}

export async function runBookingNotifications(env,{limit=15,code=null,checkIntegration=false,integrationFailed=false}={}) {
  const {start,staff,customer}=config(env);
  const test=env.BOOKING_NOTIFY_LIVE!=='1';
  const sendEnv={...env,ALIGO_TEST_MODE:test?'Y':'N'};
  if(!start)return {enabled:false};
  await prepareBookings(env);
  await ensureBookingNotifications(env);
  const staffReady=await bookingStaffReady(env,staff);
  const targets=staffReady ? staff.map((phone,index)=>({key:'staff'+index,phone})) : [];
  if(customer)targets.push({key:'customer'});
  if(staffReady && (integrationFailed || (checkIntegration && env.SPACECLOUD_SYNC_ENABLED==='true' && env.SPACECLOUD_BOOKING_OPEN!=='false'))) {
    const checkedAt=Date.now();
    let unavailable=integrationFailed;
    if(!unavailable)try {await assertCloudAdmission(env);}catch {unavailable=true;}
    await recordIntegrationHealth(env,unavailable,checkedAt);
  }

  for(const {key,phone} of targets) {
    await env.DB.prepare(`${bookingEvents}
      INSERT OR IGNORE INTO booking_notifications (code,kind,version,recipient,last4)
      SELECT e.code,e.notice,e.version,?1,CASE WHEN ?1='customer' THEN substr(b.phone,-4) ELSE ?2 END
      FROM events e LEFT JOIN booking_requests b ON b.code=e.code
      WHERE e.event_at>=?3 AND e.event_at>=datetime('now','+9 hours','-1 day')
        AND (?4 IS NULL OR e.code=?4)
        AND (CASE WHEN ?1='customer' THEN e.notice NOT IN (${staffUrgentSql})
          ELSE e.notice NOT IN (${customerLifecycleSql}) END)`)
      .bind(key,phone?.slice(-4)||'',start,code).run();
  }
  await env.DB.prepare(`UPDATE booking_notifications SET state='unknown',updated_at=${kst}
    WHERE state='sending' AND (?1 IS NULL OR code=?1) AND updated_at<datetime('now','+9 hours','-10 minutes')`).bind(code).run();
  await env.DB.prepare(`${bookingEvents}
    UPDATE booking_notifications SET state='skipped',updated_at=${kst}
    WHERE state='queued' AND (?1 IS NULL OR code=?1) AND (created_at<datetime('now','+9 hours','-1 day') OR NOT EXISTS (
      SELECT 1 FROM events e LEFT JOIN booking_requests b ON b.code=e.code
      WHERE e.code=booking_notifications.code AND e.notice=booking_notifications.kind AND e.version=booking_notifications.version
        AND (booking_notifications.recipient<>'customer' OR substr(b.phone,-4)=booking_notifications.last4)
    ))`).bind(code).run();

  const {results}=await env.DB.prepare(`SELECT DISTINCT kind FROM booking_notifications
    WHERE state='queued' AND recipient='customer' AND (?1 IS NULL OR code=?1)`).bind(code).all();
  const approvals=new Set();
  if(customer)await Promise.all(results.map(async ({kind})=>{
    const template=BOOKING_TEMPLATES[kind];
    if(template && (env[template.env] || template.code) && await approvedWebsiteTemplate(env,template))approvals.add(kind);
  }));
  const allowedKinds=JSON.stringify([...approvals]);
  const activeRecipients=JSON.stringify(targets.map(target=>target.key));
  const {results:jobs}=await env.DB.prepare(`SELECT * FROM booking_notifications WHERE state='queued'
    AND (?1 IS NULL OR code=?1) AND recipient IN (SELECT value FROM json_each(?2))
    AND (recipient<>'customer' OR kind IN (SELECT value FROM json_each(?3)))
    ORDER BY CASE WHEN kind IN (${staffUrgentSql}) THEN 0 WHEN kind IN (${customerLifecycleSql}) THEN 1 ELSE 2 END,
      created_at,CASE kind WHEN 'received' THEN 0 WHEN 'payment_ready' THEN 1 ELSE 2 END,recipient
    LIMIT ?4`).bind(code,activeRecipients,allowedKinds,limit).all();
  const out={enabled:true,accepted:0,test:0,failed:0,unknown:0,waiting:results.length-approvals.size};
  if(!staffReady && env.BOOKING_NOTIFY_REQUIRE_SMS_TEST==='1')out.waitingForOperatorTest=true;
  const sendJob=async job=>{
    const update=(state,id=null)=>env.DB.prepare(`UPDATE booking_notifications SET state=?,message_id=?,updated_at=${kst}
      WHERE code=? AND kind=? AND version=? AND recipient=? AND state='sending'`)
      .bind(state,id,job.code,job.kind,job.version,job.recipient).run();
    const claim=await env.DB.prepare(`UPDATE booking_notifications SET state='sending',updated_at=${kst}
      WHERE code=? AND kind=? AND version=? AND recipient=? AND state='queued'`)
      .bind(job.code,job.kind,job.version,job.recipient).run();
    if(!claim.meta.changes)return;
    const booking=await env.DB.prepare(`${bookingEvents}
      SELECT b.*,e.checkout_token,e.pay_url,s.code AS sync_code FROM events e
      LEFT JOIN booking_requests b ON b.code=e.code LEFT JOIN spacecloud_blocks s ON s.code=e.code
      WHERE e.code=? AND e.notice=? AND e.version=?`).bind(job.code,job.kind,job.version).first();
    const isCustomer=job.recipient==='customer';
    const phone=isCustomer?phoneDigits(booking?.phone):targets.find(target=>target.key===job.recipient)?.phone;
    if(!booking || !phonePattern.test(phone||'') || phone.slice(-4)!==job.last4 ||
      (job.kind==='payment_ready' && (!validPayappUrl(booking.pay_url) || !bookingPaymentOpen(env,booking,!!booking.sync_code)))) {
      await update('skipped');
      return;
    }
    let result;
    try {
      if(isCustomer) {
        const template=BOOKING_TEMPLATES[job.kind];
        result=await sendAligo(sendEnv,{phone},customerNotice(env,booking,job.kind,template),template);
      } else {
        const {text,long}=staffNotice(booking,job.kind);
        result=await sendAligoSms(env,phone,text,{test,long});
      }
    } catch(error) {
      const failure=isCustomer?error.retryable!==false:error.confirmedFailure===true;
      const state=failure?'failed':'unknown';
      await update(state);
      out[state]++;
      return;
    }
    const state=result.test?'test':'accepted';
    await update(state,result.messageId);
    out[state]++;
  };
  const urgent=jobs.filter(job=>staffUrgentKinds.includes(job.kind));
  for(let i=0;i<urgent.length;i+=4) {
    const results=await Promise.allSettled(urgent.slice(i,i+4).map(sendJob));
    if(results.some(result=>result.status==='rejected'))console.error('booking-notifications: staff result unavailable');
  }
  for(const job of jobs)if(!staffUrgentKinds.includes(job.kind))await sendJob(job);
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
