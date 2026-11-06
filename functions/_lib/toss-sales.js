// Toss Place Open API. General payments are revenue records, never reservations or passes.
import { safeEqual } from './auth.js';

const API = 'https://open-api.tossplace.com/api-public/openapi/v1';
const id = value => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const text = (value, max = 80) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
export function stamp(value) {
  // Toss's Java timestamps include up to nine fractional digits in live events.
  // Date.parse retains milliseconds, which is the precision used by our ledger.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  const local = value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, '');
  const check = Date.parse(local + 'Z');
  if (!Number.isFinite(check) || new Date(check).toISOString().slice(0, 19) !== local.slice(0, 19)) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + '+09:00');
  return Number.isFinite(ms) ? { ms, kst: new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') } : null;
}

export async function ensureTossSales(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS toss_payments (
    merchant_id TEXT NOT NULL, payment_id TEXT NOT NULL, order_id TEXT NOT NULL,
    state TEXT NOT NULL, source_type TEXT NOT NULL, payment_method TEXT NOT NULL,
    amount INTEGER NOT NULL, refund_amount INTEGER NOT NULL, approval_no TEXT NOT NULL,
    transaction_id TEXT NOT NULL, paid_at TEXT NOT NULL, cancelled_at TEXT,
    provider_updated INTEGER NOT NULL, origin TEXT NOT NULL,
    review_state TEXT NOT NULL DEFAULT 'auto', review_note TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')),
    PRIMARY KEY(merchant_id,payment_id)
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_toss_paid ON toss_payments(paid_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_toss_approval ON toss_payments(approval_no,amount,paid_at)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_toss_transaction ON toss_payments(transaction_id)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS toss_webhook_events (
    event_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, payment_id TEXT NOT NULL,
    event_type TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS toss_installations (
    merchant_id TEXT PRIMARY KEY, merchant_name TEXT NOT NULL DEFAULT '', installed INTEGER NOT NULL,
    provider_updated INTEGER NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours'))
  )`).run();
}

export function tossConfig(env) {
  const merchantId = id(env.TOSS_PLACE_MERCHANT_ID);
  return { merchantId, apiReady: !!(merchantId && env.TOSS_PLACE_ACCESS_KEY && env.TOSS_PLACE_SECRET_KEY),
    webhookReady: !!(merchantId && env.TOSS_PLACE_WEBHOOK_SECRET), signingReady:!!env.TOSS_PLACE_WEBHOOK_SECRET };
}

// Discover the Open API merchant ID from a signed installation event. A candidate
// never becomes the configured merchant automatically and contains no owner/contact data.
export function installationFields(event) {
  const merchantId=id(event.merchantId), at=stamp(event.createdAt);
  const installed=event.type==='app.installation.created.v1';
  if (!merchantId || !at || !['app.installation.created.v1','app.installation.deleted.v1'].includes(event.type)) return null;
  if (installed && id(event.data?.merchant?.id)!==merchantId) return null;
  if (!installed && id(event.data?.merchantId)!==merchantId) return null;
  return {merchantId,updated:at.ms,installed:installed?1:0,name:installed?text(event.data.merchant.displayName||event.data.merchant.name,120):''};
}

export function normalizePayment(raw, merchantId) {
  if (!raw || typeof raw !== 'object' || id(raw.merchantId) !== merchantId) throw Error('매장 ID가 일치하지 않습니다.');
  const paid = stamp(raw.approvedAt), updated = stamp(raw.updatedAt), cancelled = raw.cancelledAt ? stamp(raw.cancelledAt) : null;
  if (!id(raw.id) || !id(raw.orderId) || !['APPROVED', 'CANCELLED'].includes(raw.state) || !money(raw.amount) || !paid || !updated ||
      updated.ms < paid.ms || (raw.state === 'CANCELLED' && (!cancelled || cancelled.ms < paid.ms)))
    throw Error('결제 ID·주문 ID·상태·금액·승인/취소 시각을 확인해 주세요.');
  if (!['CARD', 'CASH', 'BARCODE', 'ACCOUNT_TRANSFER', 'PREPAID_VALUE', 'EXTERNAL'].includes(raw.sourceType)) throw Error('지원하지 않는 결제수단입니다.');
  const approval = text(raw.approvedNo, 40), transaction = text(raw.pgDetails?.transactionId, 80);
  // EXTERNAL can be another system's recorded sale; do not count it automatically.
  const review = raw.sourceType === 'EXTERNAL' || (['CARD', 'BARCODE'].includes(raw.sourceType) && (!approval || /^0+$/.test(approval)) && !transaction);
  return { merchant_id: merchantId, payment_id: id(raw.id), order_id: id(raw.orderId), state: raw.state,
    source_type: raw.sourceType, payment_method: text(raw.paymentMethod, 40), amount: raw.amount,
    refund_amount: raw.state === 'CANCELLED' ? raw.amount : 0, approval_no: approval, transaction_id: transaction,
    paid_at: paid.kst, cancelled_at: cancelled?.kst || null, provider_updated: Math.max(updated.ms, cancelled?.ms || 0),
    review_state: review ? 'review' : 'auto', review_note: review ? '외부 결제수단 또는 승인 식별정보 확인 필요' : '' };
}

// Match only provider transaction identifiers or approval + original amount + approval date.
// A later plugin result is also recognized, so webhook/result delivery order cannot double-count.
export const PASS_MATCH = `(p.channel <> 'website' AND ((t.transaction_id <> '' AND p.tid = t.transaction_id)
  OR (ltrim(t.approval_no,'0') <> '' AND p.approval_number = t.approval_no
    AND p.amount = t.amount AND substr(CASE WHEN p.approved_ts > 1000000000000 THEN datetime(p.approved_ts / 1000,'unixepoch','+9 hours') ELSE p.paid_at END,1,10) = substr(t.paid_at,1,10))))`;
export const MANUAL_CANDIDATE = `(EXISTS (SELECT 1 FROM reservations r
  WHERE r.pay_method='card_offline' AND r.pay_status IN ('paid','refunded') AND t.source_type IN ('CARD','BARCODE')
    AND r.amount=t.amount AND substr(COALESCE(r.paid_at,r.date),1,10)=substr(t.paid_at,1,10))
  OR EXISTS (SELECT 1 FROM pass_payments p WHERE p.channel='admin' AND p.status IN ('paid','refunded')
    -- Directly issued passes can be registered several days after the terminal
    -- charge. Hold nearby equal amounts for review rather than count both.
    AND p.amount=t.amount AND ABS(julianday(substr(p.paid_at,1,10))-julianday(substr(t.paid_at,1,10)))<=7
    AND ((p.pay_method='card_offline' AND t.source_type IN ('CARD','BARCODE'))
      OR (p.pay_method='cash' AND t.source_type='CASH') OR (p.pay_method='bank_other' AND t.source_type='ACCOUNT_TRANSFER'))))`;
export const TOSS_SOURCE = `(SELECT t.* FROM toss_payments t
  WHERE t.review_state IN ('auto','include') AND t.source_type <> 'EXTERNAL'
    AND NOT EXISTS (SELECT 1 FROM pass_payments p WHERE ${PASS_MATCH})
    AND (t.review_state = 'include' OR NOT ${MANUAL_CANDIDATE}) )`;

// If a plugin payment is cancelled through Toss outside our plugin, revenue still follows
// the authoritative cancellation. This read model does not send notifications or issue passes.
export const PASS_SALES_SOURCE = `(SELECT p.*, MAX(p.refund_amount, COALESCE((SELECT MAX(t.refund_amount)
  FROM toss_payments t WHERE ${PASS_MATCH}),0)) AS sales_refund FROM pass_payments p)`;

export async function preparePayments(env, rawRows) {
  const cfg = tossConfig(env);
  if (!cfg.merchantId) throw Error('서버에 TOSS_PLACE_MERCHANT_ID를 먼저 연결해 주세요.');
  if (!Array.isArray(rawRows) || !rawRows.length || rawRows.length > 200) throw Error('한 번에 1~200건을 가져올 수 있습니다.');
  const seen = new Set(), rows = [];
  for (const raw of rawRows) {
    const p = normalizePayment(raw, cfg.merchantId);
    if (seen.has(p.payment_id)) throw Error('가져올 내역 안에 결제 ID가 중복됩니다.');
    seen.add(p.payment_id);
    const before = await env.DB.prepare('SELECT * FROM toss_payments WHERE merchant_id=? AND payment_id=?').bind(p.merchant_id, p.payment_id).first();
    let result = before ? 'updated' : 'new', reason = p.review_note;
    if (before) {
      p.review_state=before.review_state;p.review_note=before.review_note;
      if (['amount','paid_at','order_id','source_type','approval_no','transaction_id'].some(k => before[k] !== p[k])) {
        result = 'blocked'; reason = '같은 결제 ID의 원거래 정보가 다릅니다.';
      } else if (p.provider_updated < before.provider_updated || (before.refund_amount > p.refund_amount) ||
          (p.provider_updated === before.provider_updated && before.state === p.state)) result = 'unchanged';
    }
    const matches = (await env.DB.prepare(`SELECT p.id,p.test_mode FROM pass_payments p, (SELECT ? AS transaction_id,? AS approval_no,? AS amount,? AS paid_at) t WHERE ${PASS_MATCH}`)
      .bind(p.transaction_id,p.approval_no,p.amount,p.paid_at).all()).results || [];
    const manual = await env.DB.prepare(`SELECT ${MANUAL_CANDIDATE} AS found FROM (SELECT ? AS amount,? AS paid_at,? AS source_type) t`).bind(p.amount,p.paid_at,p.source_type).first();
    if (matches.length) reason = matches.some(x => x.test_mode) ? '기존 테스트 결제: 매출 제외' : '기존 이용권 결제와 일치: 중복 합산 제외';
    else if(p.review_state==='exclude')reason='관리자 확인으로 합산 제외';
    else if (manual?.found && p.review_state!=='include') reason = '같은 금액의 수기 매출/직접 발급 이용권: 확인 전 합산 보류';
    rows.push({ ...p, result, reason, duplicate: matches.length > 0,
      counted: !matches.length && p.source_type!=='EXTERNAL' && ['auto','include'].includes(p.review_state) && (!manual?.found || p.review_state==='include') });
  }
  return rows;
}

export function paymentStatement(env, p, origin) {
  return env.DB.prepare(`INSERT INTO toss_payments (merchant_id,payment_id,order_id,state,source_type,payment_method,
    amount,refund_amount,approval_no,transaction_id,paid_at,cancelled_at,provider_updated,origin,review_state,review_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(merchant_id,payment_id) DO UPDATE SET
      state=excluded.state,refund_amount=MAX(toss_payments.refund_amount,excluded.refund_amount),
      cancelled_at=COALESCE(excluded.cancelled_at,toss_payments.cancelled_at),
      provider_updated=MAX(toss_payments.provider_updated,excluded.provider_updated),origin=excluded.origin,
      received_at=datetime('now','+9 hours')
    WHERE excluded.provider_updated >= toss_payments.provider_updated
      AND excluded.refund_amount >= toss_payments.refund_amount AND excluded.amount=toss_payments.amount
      AND excluded.paid_at=toss_payments.paid_at AND excluded.order_id=toss_payments.order_id
      AND excluded.source_type=toss_payments.source_type AND excluded.approval_no=toss_payments.approval_no
      AND excluded.transaction_id=toss_payments.transaction_id`)
    .bind(p.merchant_id,p.payment_id,p.order_id,p.state,p.source_type,p.payment_method,p.amount,p.refund_amount,
      p.approval_no,p.transaction_id,p.paid_at,p.cancelled_at,p.provider_updated,origin,p.review_state,p.review_note);
}

export async function savePayments(env, rows, origin = 'api') {
  if (rows.some(p=>p.result === 'blocked')) throw Error('원거래 정보가 다른 결제가 있어 반영하지 않았습니다.');
  const statements=rows.filter(p=>p.result !== 'unchanged').map(p=>paymentStatement(env,p,origin));
  if(!statements.length)return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((n,r)=>n + (Number(r.meta?.changes) || 0),0);
}

export async function tossGet(env, path) {
  const cfg = tossConfig(env);
  if (!cfg.apiReady) throw Error('토스 Open API 키와 매장 연결이 필요합니다.');
  const response = await fetch(API + '/merchants/' + cfg.merchantId + path, {
    headers: { 'x-access-key':env.TOSS_PLACE_ACCESS_KEY, 'x-secret-key':env.TOSS_PLACE_SECRET_KEY, 'Content-Type':'application/json',
      'User-Agent':'SocialfactorySales/1.0 (+https://socialfactory.co.kr)' },
    // Workers supports manual/follow, not error. Reject 3xx below so keys are
    // never forwarded to a redirected destination.
    redirect:'manual', signal:AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    const failure = await response.json().catch(()=>null);
    const code = /^\d{1,10}$/.test(String(failure?.error?.errorCode)) ? String(failure.error.errorCode) : '';
    let reason = text(failure?.error?.reason,300);
    for(const secret of [env.TOSS_PLACE_ACCESS_KEY,env.TOSS_PLACE_SECRET_KEY,env.TOSS_PLACE_WEBHOOK_SECRET])if(secret)reason=reason.replaceAll(secret,'[redacted]');
    reason=reason.replace(/[A-Za-z0-9_=-]{24,}/g,'[redacted]');
    console.warn('toss-api-failed',{status:response.status,code,reason,
      traceId:response.headers.get('x-toss-event-id'),ray:response.headers.get('cf-ray'),contentType:response.headers.get('content-type')});
    throw Error(response.status === 429 ? '토스 조회 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.' : '토스 조회 실패 (HTTP '+response.status+(code?', 코드 '+code:'')+'): API 키·앱 설치·매장 권한을 확인해 주세요.');
  }
  const body = await response.json();
  if (body.resultType !== 'SUCCESS') throw Error('토스에서 조회를 처리하지 못했습니다. 연결 권한을 확인해 주세요.');
  return body.success;
}

export async function verifyWebhook(request, raw, secret, now = Date.now()) {
  const time = request.headers.get('x-toss-timestamp') || '', signature = request.headers.get('x-toss-signature') || '';
  if (!secret || !/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > 300000 || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const enc = new TextEncoder(), key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes = await crypto.subtle.sign('HMAC',key,enc.encode(time + '.' + raw));
  const expected = 'v1=' + Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  return safeEqual(signature, expected);
}
