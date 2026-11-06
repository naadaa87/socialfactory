/** PayApp server REST integration. Secrets never leave the server; no automatic SMS. */
import { clean, randomToken, safeEqual, sha256Hex } from './auth.js';

const API = 'https://api.payapp.kr/oapi/v2';
export const OFFICE_SALES_FROM = `FROM (SELECT amount,COALESCE(refund_amount,0) AS refund_amount,CASE
  WHEN length(paid_at)=14 AND paid_at NOT GLOB '*[^0-9]*' THEN datetime(substr(paid_at,1,4)||'-'||substr(paid_at,5,2)||'-'||substr(paid_at,7,2)||' '||substr(paid_at,9,2)||':'||substr(paid_at,11,2)||':'||substr(paid_at,13,2))
  WHEN upper(substr(paid_at,-1))='Z' OR (substr(paid_at,-6,1) IN ('+','-') AND substr(paid_at,-3,1)=':') THEN datetime(paid_at,'+9 hours')
  ELSE datetime(paid_at) END AS paid_kst FROM booking_payapp_requests
  WHERE kind='office' AND status IN ('paid','partial_refund','refunded') AND paid_at IS NOT NULL) WHERE paid_kst IS NOT NULL`;
const readyDatabases = new WeakMap();
export const PAYAPP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS booking_payapp_requests (
    code TEXT PRIMARY KEY, kind TEXT NOT NULL, inquiry_id INTEGER, label TEXT NOT NULL,
    amount INTEGER NOT NULL, token TEXT NOT NULL, mul_no TEXT UNIQUE, pay_url TEXT,
    status TEXT NOT NULL DEFAULT 'creating', provider_state TEXT, provider_stamp TEXT,
    paid_at TEXT, accepted_at TEXT, consent_version TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, failure TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')), updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_booking_payapp_status ON booking_payapp_requests(status, created_at)',
  `CREATE TABLE IF NOT EXISTS booking_payapp_refunds (mul_no TEXT PRIMARY KEY, code TEXT NOT NULL, amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')))`
];
export function paymentError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
export function payappConfig(env) {
  const userid = String(env.PAYAPP_USERID || '').trim();
  const linkkey = String(env.PAYAPP_LINK_KEY || env.PAYAPP_LINKKEY || '').trim();
  const linkval = String(env.PAYAPP_LINK_VALUE || env.PAYAPP_LINKVAL || '').trim();
  const requestkey = String(env.PAYAPP_REQUEST_KEY || env.PAYAPP_REQUESTKEY || '').trim();
  const origin = String(env.PAYAPP_SITE_URL || '').replace(/\/$/, '');
  let validOrigin = false;
  try { const u = new URL(origin); validOrigin = u.protocol === 'https:' && u.origin === origin && !u.username && !u.password; } catch {}
  return { ready: !!(userid && linkkey && linkval && requestkey && validOrigin && env.PAYAPP_ENABLED === '1'), userid, linkkey, linkval, requestkey, origin };
}
export async function ensurePayappSchema(env) {
  if (!env.DB) throw paymentError('NO_DB', '데이터베이스 연결이 필요합니다.', 503);
  if (!readyDatabases.has(env.DB)) {
    const task=env.DB.batch(PAYAPP_SCHEMA.map(sql=>env.DB.prepare(sql)));
    readyDatabases.set(env.DB,task);
    task.catch(()=>readyDatabases.delete(env.DB));
  }
  await readyDatabases.get(env.DB);
}
const stamp = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace(/\D/g, '');
export function validPayappUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'payapp.kr' || u.hostname.endsWith('.payapp.kr')); } catch { return false; }
}
export const checkoutUrl = (env,row) => payappConfig(env).origin + '/booking-status?code=' + encodeURIComponent(row.code) + '&t=' + encodeURIComponent(row.token);
async function callPayapp(env, fields) {
  const cfg = payappConfig(env);
  if (!cfg.ready) throw paymentError('PAYAPP_NOT_CONFIGURED', '페이앱 연결 설정을 먼저 완료해 주세요.', 503);
  const requestdate = stamp();
  const form = new URLSearchParams({ ...fields, userid: cfg.userid, linkkey: cfg.linkkey, requestdate,
    hash: await sha256Hex(cfg.userid + requestdate + cfg.requestkey) });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(API, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: form, signal: controller.signal });
    if (!response.ok) throw paymentError('PAYAPP_UNCERTAIN', '페이앱 응답을 확인하지 못했습니다. 관리자 결제내역을 확인해 주세요.', 502);
    const text = await response.text();
    if (text.length > 65536) throw paymentError('PAYAPP_UNCERTAIN', '페이앱 응답을 확인하지 못했습니다.', 502);
    const result = Object.fromEntries(new URLSearchParams(text));
    if (result.state === '0') throw paymentError('PAYAPP_REJECTED', '페이앱 요청이 거절되었습니다. 판매자 설정과 결제내역을 확인해 주세요.', 502);
    if (result.state !== '1') throw paymentError('PAYAPP_UNCERTAIN', '페이앱 응답 형식을 확인하지 못했습니다. 판매자 결제내역을 확인해 주세요.', 502);
    return result;
  } catch (error) {
    if (error.code) throw error;
    throw paymentError('PAYAPP_UNCERTAIN', '페이앱 처리 결과를 확인하지 못했습니다. 중복 발급 전에 판매자 결제내역을 확인해 주세요.', 502);
  } finally { clearTimeout(timer); }
}
export async function createPayment(env, { code, kind, label, amount, phone, email = '', inquiry_id = null }) {
  await ensurePayappSchema(env);
  const cfg = payappConfig(env);
  if (!cfg.ready) throw paymentError('PAYAPP_NOT_CONFIGURED', '페이앱 연결 설정을 먼저 완료해 주세요.', 503);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code) || !['room','office'].includes(kind) || !Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000 || !/^0\d{8,10}$/.test(phone.replace(/\D/g, '')))
    throw paymentError('INVALID_PAYMENT', '청구금액과 연락처를 확인해 주세요.', 400);
  const token = randomToken(32);
  await env.DB.prepare('INSERT OR IGNORE INTO booking_payapp_requests (code,kind,inquiry_id,label,amount,token) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(code, kind, inquiry_id, clean(label, 80), amount, token).run();
  let row = await env.DB.prepare('SELECT * FROM booking_payapp_requests WHERE code=?1').bind(code).first();
  if (row.amount !== amount || row.kind !== kind) throw paymentError('PAYMENT_MISMATCH', '이미 생성한 청구 내용과 다릅니다. 기존 결제내역을 확인해 주세요.');
  if (row.token !== token) {
    if (row.mul_no && validPayappUrl(row.pay_url) && ['requested','pending','paid'].includes(row.status)) return { id: row.mul_no, url: checkoutUrl(env,row) };
    throw paymentError('PAYAPP_REVIEW', '이미 결제요청을 처리한 기록이 있습니다. 페이앱 판매자 결제내역을 확인해 주세요.');
  }
  try {
    const result = await callPayapp(env, { cmd: 'payrequest', goodname: row.label, price: String(amount), recvphone: phone.replace(/\D/g, ''),
      recvemail: email, reqaddr: '0', feedbackurl: cfg.origin + '/api/booking/payapp-feedback', var1: code, var2: token,
      smsuse: 'n', checkretry: 'y', openpaytype: 'card,kakaopay,naverpay,applepay,tosspay,rbank',
      returnurl: cfg.origin + '/booking-status?code=' + encodeURIComponent(code) + '&t=' + encodeURIComponent(token) });
    if (!/^\d+$/.test(result.mul_no || '') || !validPayappUrl(result.payurl)) throw paymentError('PAYAPP_UNCERTAIN', '결제요청 결과 확인이 필요합니다.', 502);
    if (row.mul_no && row.mul_no !== result.mul_no) throw paymentError('PAYAPP_UNCERTAIN', '결제번호 확인이 필요합니다.', 502);
    await env.DB.prepare("UPDATE booking_payapp_requests SET mul_no=COALESCE(mul_no,?1),pay_url=?2,status=CASE WHEN status='creating' THEN 'requested' ELSE status END,updated_at=datetime('now','+9 hours') WHERE code=?3 AND (mul_no IS NULL OR mul_no=?1)")
      .bind(result.mul_no, result.payurl, code).run();
    row = await env.DB.prepare('SELECT * FROM booking_payapp_requests WHERE code=?1').bind(code).first();
    if (row.mul_no !== result.mul_no) throw paymentError('PAYAPP_UNCERTAIN', '결제번호 확인이 필요합니다.', 502);
    return { id: result.mul_no, url: checkoutUrl(env,row) };
  } catch (error) {
    await env.DB.prepare("UPDATE booking_payapp_requests SET status=CASE WHEN status='creating' THEN ?3 ELSE status END,failure=?1,updated_at=datetime('now','+9 hours') WHERE code=?2")
      .bind(error.code || 'PAYAPP_UNCERTAIN', code,error.code==='PAYAPP_REJECTED'?'failed':'review').run();
    throw error;
  }
}
export function createBookingPayment(env, { booking }) {
  return createPayment(env, { code: booking.code, kind: 'room', label: `소셜팩토리 ${booking.room.replace('r','')}번룸 ${booking.date}`, amount: booking.amount, phone: booking.phone, email: booking.email || '' });
}
export async function cancelBookingPayment(env, { booking }) {
  await ensurePayappSchema(env);
  const row = await env.DB.prepare('SELECT * FROM booking_payapp_requests WHERE code=?1').bind(booking.code).first();
  if (!row) return { ok: true };
  if (row.status === 'cancelled') return { ok: true };
  if (row.status === 'failed' && !row.mul_no) {
    await env.DB.prepare("UPDATE booking_payapp_requests SET status='cancelled',updated_at=datetime('now','+9 hours') WHERE code=?1 AND status='failed' AND mul_no IS NULL").bind(row.code).run();
    return {ok:true};
  }
  if (!row.mul_no || ['paid','refunded','partial_refund','review'].includes(row.status)) throw paymentError('PAYAPP_REVIEW', '페이앱 결제내역을 확인해야 합니다. 시간은 계속 확보됩니다.');
  await callPayapp(env, { cmd: 'paycancel', mul_no: row.mul_no, cancelmemo: '예약 신청 취소', cancelmode: 'ready', partcancel: '0' });
  await env.DB.prepare("UPDATE booking_payapp_requests SET status='cancelled',updated_at=datetime('now','+9 hours') WHERE code=?1 AND status IN ('creating','requested','pending','cancelled')").bind(row.code).run();
  const latest = await env.DB.prepare('SELECT status FROM booking_payapp_requests WHERE code=?1').bind(row.code).first();
  if (latest.status !== 'cancelled') throw paymentError('PAYAPP_REVIEW', '결제 상태가 변경되었습니다. 판매자 내역을 확인해 주세요.');
  return { ok: true };
}
export function parseProviderTime(value) {
  if (!/^\d{14}$/.test(value || '')) return null;
  const v = value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8)+'T'+value.slice(8,10)+':'+value.slice(10,12)+':'+value.slice(12,14)+'+09:00';
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n + 9 * 3600e3).toISOString().slice(0,19).replace(/\D/g,'') === value ? n : null;
}
export async function validateFeedback(env, fields) {
  const cfg = payappConfig(env);
  if (!cfg.ready) throw paymentError('PAYAPP_NOT_CONFIGURED', '페이앱 설정이 필요합니다.', 503);
  const ms = parseProviderTime(fields.responsedate);
  if (ms === null || Math.abs(Date.now() - ms) > 15 * 60e3 || !safeEqual(fields.userid || '',cfg.userid) || !safeEqual(fields.linkkey || '',cfg.linkkey) || !safeEqual(fields.linkval || '',cfg.linkval)
    || !safeEqual(String(fields.hash || '').toLowerCase(),await sha256Hex(cfg.userid + fields.responsedate + cfg.requestkey))) throw paymentError('INVALID_FEEDBACK','결제통보 인증 실패',403);
  await ensurePayappSchema(env);
  const row = await env.DB.prepare('SELECT * FROM booking_payapp_requests WHERE code=?1').bind(clean(fields.var1,64)).first();
  if (!row || !safeEqual(fields.var2 || '', row.token)) throw paymentError('INVALID_FEEDBACK','결제요청 연결 실패',403);
  const partial = ['70','71'].includes(fields.pay_state);
  const id = partial ? fields.orig_mul_no : fields.mul_no;
  const expected = partial ? fields.orig_price : fields.price;
  if (!/^\d+$/.test(id || '') || (row.mul_no && row.mul_no !== id) || !/^\d+$/.test(expected || '') || Number(expected) !== row.amount)
    throw paymentError('INVALID_FEEDBACK','결제번호 또는 금액 불일치',403);
  if (partial && (!/^\d+$/.test(fields.price || '') || Number(fields.price) > row.amount)) throw paymentError('INVALID_FEEDBACK','취소 금액 오류',403);
  const state = { '1':'pending','4':'paid','8':'cancelled','32':'cancelled','9':'refunded','64':'refunded','10':'pending','70':'refund_pending','71':'refund_pending' }[fields.pay_state];
  if (!state) throw paymentError('UNSUPPORTED_FEEDBACK','확인되지 않은 결제상태',400);
  return { row, event: { code: row.code, id, state, paid_at: fields.pay_date || null, refund_amount: partial ? Number(fields.price) : state === 'refunded' ? row.amount : 0 },
    fields, stale: !!(row.provider_stamp && fields.responsedate < row.provider_stamp) };
}
export async function recordFeedback(env, { row, event, fields }) {
  const status = event.state === 'refund_pending' ? 'partial_refund' : event.state;
  await env.DB.prepare(`UPDATE booking_payapp_requests SET mul_no=COALESCE(mul_no,?1),status=CASE
      WHEN ?2='pending' AND status IN ('paid','cancelled','refunded','partial_refund','review') THEN status
      WHEN ?2='paid' AND status IN ('refunded','partial_refund') THEN status
      WHEN ?2='paid' AND status='cancelled' THEN 'review'
      WHEN ?2='partial_refund' AND status='refunded' THEN status
      WHEN ?2 IN ('pending','cancelled') AND provider_stamp > ?4 THEN status
      ELSE ?2 END,
    provider_state=CASE WHEN provider_stamp > ?4 THEN provider_state ELSE ?3 END,
    provider_stamp=MAX(COALESCE(provider_stamp,''),?4),
    paid_at=COALESCE(paid_at,?5),refund_amount=MAX(refund_amount,?6),updated_at=datetime('now','+9 hours') WHERE code=?7`)
    .bind(event.id,status,fields.pay_state,fields.responsedate,normalizePayappDate(event.paid_at),event.refund_amount,row.code).run();
}
export function normalizePayappDate(value) {
  if (!value) return null;
  if (parseProviderTime(value) !== null) return value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8)+' '+value.slice(8,10)+':'+value.slice(10,12)+':'+value.slice(12,14);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value : null;
}
/** Provider partial-cancellation transaction IDs make repeated notifications idempotent. */
export async function accumulateRefund(env, notification) {
  if(notification.event.state!=='refund_pending') return;
  const {fields,row,event}=notification;
  if(!/^\d+$/.test(fields.mul_no || '')) throw paymentError('INVALID_FEEDBACK','부분취소번호 오류',403);
  await env.DB.prepare(`INSERT OR IGNORE INTO booking_payapp_refunds (mul_no,code,amount)
    SELECT ?1,?2,?3 WHERE COALESCE((SELECT SUM(amount) FROM booking_payapp_refunds WHERE code=?2),0)+?3 <= ?4`)
    .bind(fields.mul_no,row.code,Number(fields.price),row.amount).run();
  const refund=await env.DB.prepare('SELECT code,amount FROM booking_payapp_refunds WHERE mul_no=?1').bind(fields.mul_no).first();
  if(!refund || refund.code!==row.code || refund.amount!==Number(fields.price)) throw paymentError('INVALID_FEEDBACK','부분취소 내역 불일치',403);
  const total=await env.DB.prepare('SELECT SUM(amount) AS amount FROM booking_payapp_refunds WHERE code=?1').bind(row.code).first();
  if(Number(total.amount)>row.amount) throw paymentError('INVALID_FEEDBACK','부분취소 합계 오류',403);
  event.refund_amount=Number(total.amount);
}

// Namespaced public helper for production revenue integration.
export const ensureBookingPayappSchema=ensurePayappSchema;
