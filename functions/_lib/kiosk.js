/**
 * 토스프론트 이용권 공통 도구 (Cloudflare Pages Functions)
 * ------------------------------------------------------------------
 * - 단말기 인증: 관리자 화면에서 만든 연결 코드(8자리, 30분)를 프론트에 한 번 입력하면 긴 토큰을 받아
 *   단말기 저장소(sdk.storage)에 보관하고, 이후 요청마다 Authorization: Bearer 토큰 으로 보냅니다. DB 에는 토큰의 해시만 저장합니다.
 * - 시각: 다른 표와 같이 한국 시간 문자열 'YYYY-MM-DD HH:MM:SS' 로 저장합니다.
 * - 이용권 발급은 결제 1건당 1장만 생깁니다 (passes.payment_id UNIQUE). 같은 결과가 여러 번 와도 안전합니다.
 * 이 폴더(_lib)는 주소로 열리지 않는 내부 모듈입니다.
 */
import { json, clean, sha256Hex, randomToken, phoneDigits, formatPhone } from "./auth.js";
import { ensureSchema, kstNow } from "./admin.js";
import { termsForPayment } from "./kiosk-catalog.js";

/* ---------- 시각 (한국 시간 문자열 ↔ 계산용 숫자) ---------- */
// 'YYYY-MM-DD HH:MM:SS' 를 UTC 로 읽어 '벽시계 시각'을 그대로 계산합니다 (한국은 서머타임이 없어 안전).
export const toMs = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
export function addDuration(start, d) {
  const ms = toMs(start);
  if (d.hours) return fromMs(ms + d.hours * 3600e3);
  if (d.days) return fromMs(ms + d.days * 864e5);
  if (d.minutes) return fromMs(ms + d.minutes * 6e4);
  if (d.months) {
    const t = new Date(ms);
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + d.months;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();          // 목표 달의 마지막 날
    const day = Math.min(t.getUTCDate(), last);
    return fromMs(Date.UTC(y, m, day, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()));
  }
  throw new Error("bad-duration");
}
export function durationText(d) {
  if (d.hours) return d.hours + "시간";
  if (d.days) return d.days + "일";
  if (d.months) return d.months + "개월";
  return "";
}
/** '2026-11-20 14:00:00' → '11월 20일 14:00' (알림 · 화면 표시용) */
export function kTime(s) {
  if (!s) return "";
  return (+s.slice(5, 7)) + "월 " + (+s.slice(8, 10)) + "일 " + s.slice(11, 16);
}

/* ---------- 전화번호 ---------- */
export const validMobile = (v) => /^01[016789]\d{7,8}$/.test(phoneDigits(v));
export const maskPhone = (v) => { const d = phoneDigits(v); return d.length >= 8 ? d.slice(0, 3) + "-****-" + d.slice(-4) : "****"; };

/* ---------- 번호 ---------- */
const ABC = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const rand = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (const x of b) s += ABC[x % ABC.length]; return s; };
const ymdhms = () => kstNow().replace(/[^0-9]/g, "").slice(2);              // 261020143005
export const makePaymentKey = () => "SFK" + ymdhms() + rand(8);               // 토스 paymentKey: 64자 이하, 결제마다 새 값
export const makePassCode = () => "P" + ymdhms().slice(0, 6) + "-" + rand(5);
export const makePairCode = () => rand(8);

/* ---------- 응답 · 단말기 인증 ---------- */
export const kjson = json;
// 인증은 매번 DB에서 확인하고, 최근 접속 시각 기록만 단말기별 최대 분당 한 번으로 줄입니다.
const lastSeenWrites = new WeakMap();
function touchDevice(env, deviceId) {
  let writes = lastSeenWrites.get(env.DB);
  if (!writes) { writes = new Map(); lastSeenWrites.set(env.DB, writes); }
  const now = Date.now(), previous = writes.get(deviceId);
  if (previous != null && now - previous < 60000) return;
  writes.set(deviceId, now);
  env.DB.prepare("UPDATE kiosk_devices SET last_seen_at = datetime('now', '+9 hours') WHERE id = ?1").bind(deviceId).run().catch(() => {
    if (writes.get(deviceId) === now) writes.delete(deviceId);
  });
}
export async function deviceFromRequest(request, env) {
  const tok = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok.length < 20 || tok.length > 200 || !env.DB) return null;
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT id, name, status FROM kiosk_devices WHERE token_hash = ?1").bind(await sha256Hex("kiosk|" + tok)).first().catch(() => null);
  if (!row || row.status !== "active") return null;
  touchDevice(env, row.id);
  return row;
}
export async function deviceGate(request, env) {
  if (!env.DB) return { deny: json({ ok: false, error: "no-db" }, 503) };
  const device = await deviceFromRequest(request, env);
  if (!device) return { deny: json({ ok: false, error: "device-auth", code: "DEVICE_AUTH" }, 401) };
  return { device };
}
export const newDeviceToken = () => "sfk_" + randomToken(32);
export const deviceTokenHash = (tok) => sha256Hex("kiosk|" + tok);
export const pairCodeHash = (code) => sha256Hex("kiosk-pair|" + String(code).toUpperCase());

/* ---------- 고객 ---------- */
/** 전화번호로 고객을 찾고 없으면 만듭니다. 반환: customers 행 */
export async function upsertCustomer(env, phone, { name = "", privacy = false } = {}) {
  const digits = phoneDigits(phone);
  const fmt = formatPhone(digits);
  await env.DB.prepare(
    `INSERT INTO customers (phone, phone_fmt, name, privacy_agreed_at) VALUES (?1, ?2, ?3, CASE WHEN ?4 = 1 THEN datetime('now', '+9 hours') END)
     ON CONFLICT(phone) DO UPDATE SET updated_at = datetime('now', '+9 hours'),
       name = CASE WHEN COALESCE(customers.name, '') = '' THEN excluded.name ELSE customers.name END,
       privacy_agreed_at = CASE WHEN ?4 = 1 THEN datetime('now', '+9 hours') ELSE customers.privacy_agreed_at END`
  ).bind(digits, fmt, clean(name, 40), privacy ? 1 : 0).run();
  return env.DB.prepare("SELECT * FROM customers WHERE phone = ?1").bind(digits).first();
}

/** 같은 그룹 이용권이 지금 이어지고 있으면 그 마지막 만료 시각, 아니면 지금 */
export async function nextStart(env, customerId, group, now = kstNow()) {
  const r = await env.DB.prepare("SELECT MAX(ends_at) AS e FROM passes WHERE customer_id = ?1 AND pass_group = ?2 AND status = 'active'").bind(customerId, group).first();
  return r && r.e && r.e > now ? r.e : now;
}

/**
 * 결제 1건(pass_payments)에 이용권 1장을 발급합니다. 이미 발급됐으면 그 이용권을 그대로 돌려줍니다.
 * 새로 발급한 경우에만 알림(구매 완료 · 만료 예정)을 대기열에 넣습니다.
 */
export async function issuePassForPayment(env, pay, { startAt = null, purchaseNotice = true } = {}) {
  const found = await env.DB.prepare("SELECT * FROM passes WHERE payment_id = ?1").bind(pay.id).first();
  if (found) return { pass: found, created: false };
  const product = await termsForPayment(env, pay);
  if (!product) throw new Error("unknown-product");
  const now = kstNow();
  const starts = startAt || await nextStart(env, pay.customer_id, product.group, now);
  const ends = addDuration(starts, product.duration);
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO passes (code, payment_id, customer_id, product_id, product_name, pass_group, starts_at, ends_at, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(makePassCode(), pay.id, pay.customer_id, product.id, pay.product_name || product.name, product.group, starts, ends, pay.channel || "toss_front").run();
  const pass = await env.DB.prepare("SELECT * FROM passes WHERE payment_id = ?1").bind(pay.id).first();
  const created = !!(res.meta && res.meta.changes);
  if (created) await queuePassNotices(env, pass, pay, { purchaseNotice }).catch((e) => console.error("queue-notice", e && e.message));
  return { pass, created };
}

/* ---------- 알림 대기열 ---------- */
/** 구매 완료 알림 1건 + 만료 예정 알림(마지막 만료 시각 기준)을 다시 계산해 넣습니다. */
export async function queuePassNotices(env, pass, pay, { purchaseNotice = true } = {}) {
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?1").bind(pass.customer_id).first();
  if (!c) return;
  const now = kstNow();
  const stmts = [];
  if (pay && purchaseNotice) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO notification_jobs (dedupe_key, kind, customer_id, pass_id, phone, vars, send_after) VALUES (?1, 'purchase', ?2, ?3, ?4, ?5, ?6)`
    ).bind("purchase:" + pass.id, c.id, pass.id, c.phone, JSON.stringify({
      고객: c.name || "고객", 이용권: pass.product_name, 시작: kTime(pass.starts_at), 만료: kTime(pass.ends_at),
      금액: Number(pay.amount || 0).toLocaleString("ko-KR")
    }), now));
  }
  stmts.push(...(await expiryNoticeStmts(env, c, pass.pass_group, now)));
  if (stmts.length) await env.DB.batch(stmts);
}

/** 이 고객 · 그룹의 아직 안 보낸 만료 알림을 지우고, 지금 기준 마지막 만료 시각으로 다시 만듭니다 (이어 붙이기 · 기간 조정 · 취소 후 호출). */
export async function expiryNoticeStmts(env, c, group, now = kstNow()) {
  const out = [env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled', updated_at = datetime('now', '+9 hours') WHERE customer_id = ?1 AND kind = 'expire_soon' AND status = 'queued' AND pass_group = ?2").bind(c.id, group)];
  const last = await env.DB.prepare("SELECT * FROM passes WHERE customer_id = ?1 AND pass_group = ?2 AND status = 'active' AND ends_at > ?3 ORDER BY ends_at DESC LIMIT 1").bind(c.id, group, now).first();
  if (!last) return out;
  const lastPay = await env.DB.prepare("SELECT * FROM pass_payments WHERE id = ?1").bind(last.payment_id).first();
  const product = lastPay ? (await termsForPayment(env, lastPay) || {}) : {};
  for (const before of product.remind || []) {
    const at = fromMs(toMs(last.ends_at) - before * 6e4);
    if (at <= now) continue;
    out.push(env.DB.prepare(
      `INSERT INTO notification_jobs (dedupe_key, kind, customer_id, pass_id, pass_group, phone, vars, send_after) VALUES (?1, 'expire_soon', ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(dedupe_key) DO UPDATE SET status = 'queued', send_after = excluded.send_after, vars = excluded.vars, updated_at = datetime('now', '+9 hours')
       WHERE notification_jobs.status = 'cancelled'`
    ).bind(`expire:${c.id}:${group}:${last.ends_at}:${before}`, c.id, last.id, group, c.phone, JSON.stringify({
      고객: c.name || "고객", 이용권: last.product_name, 만료: kTime(last.ends_at), 남은시간: beforeText(before)
    }), at));
  }
  return out;
}
const beforeText = (min) => min >= 1440 ? Math.round(min / 1440) + "일" : min >= 60 ? Math.round(min / 60) + "시간" : min + "분";

/* ---------- 결제 결과 정리 (토스 SDK requestPayment 응답에서 저장할 값) ---------- */
export function paymentFields(response) {
  const r = response && typeof response === "object" ? response : {};
  const method = ["CARD", "CASH", "BARCODE"].includes(r.paymentMethod) ? r.paymentMethod : "";
  const card = r.card || r.barcode || {};
  const cash = r.cash || {};
  const receipt = cash.cashReceipt || {};
  return {
    method,
    approvalNumber: clean(String(card.approvalNumber || receipt.approvalNumber || ""), 40),
    approvedTs: Number(card.timestamp || receipt.timestamp || 0) || null,
    tid: clean(String(r.tid || ""), 40),
    vanKey: clean(String(r.vanTransactionKey || ""), 80),
    issuer: clean(String(card.issuerName || (r.easyPay && r.easyPay.provider) || ""), 40),
    masked: clean(String(card.maskedCardNumber || ""), 40),
    installment: Number(card.installment || 0) || 0,
    // 카드 · 간편결제는 승인번호가 꼭 있어야 성공으로 봅니다 (현금은 영수증을 안 받으면 승인번호가 없음)
    valid: method === "CASH" ? true : !!(method && (card.approvalNumber))
  };
}

/* ---------- 이용권 취소 (관리자 화면 · 프론트 결제 취소 공통) ---------- */
/**
 * 이용권을 취소하고, 환불 금액이 있으면 결제를 환불로 기록합니다.
 * rechain 이면 뒤에 이어 붙어 있던 같은 그룹 이용권을 취소한 자리로 앞당기고(기간은 상품 규칙대로 다시 계산), 만료 알림을 다시 계산합니다.
 */
export async function cancelPass(env, p, { refundAmount = 0, rechain = true, memo = null, refundNote = null } = {}) {
  const pay = await env.DB.prepare("SELECT * FROM pass_payments WHERE id = ?1").bind(p.payment_id).first();
  const refund = Math.max(0, Math.min(refundAmount || 0, pay ? pay.amount : 0));
  const stmts = [env.DB.prepare("UPDATE passes SET status = 'cancelled', memo = COALESCE(?1, memo), updated_at = datetime('now', '+9 hours') WHERE id = ?2 AND status <> 'cancelled'").bind(memo, p.id)];
  if (refund > 0) stmts.push(env.DB.prepare(
    "UPDATE pass_payments SET status = 'refunded', refund_amount = ?1, refunded_at = datetime('now', '+9 hours'), admin_memo = CASE WHEN ?2 IS NULL THEN admin_memo ELSE TRIM(COALESCE(admin_memo, '') || ' ' || ?2) END, updated_at = datetime('now', '+9 hours') WHERE id = ?3"
  ).bind(refund, refundNote, p.payment_id));
  if (rechain) {
    const { results: later } = await env.DB.prepare("SELECT * FROM passes WHERE customer_id = ?1 AND pass_group = ?2 AND status = 'active' AND id <> ?3 AND starts_at >= ?4 ORDER BY starts_at").bind(p.customer_id, p.pass_group, p.id, p.ends_at).all();
    let cursor = p.starts_at > kstNow() ? p.starts_at : kstNow();
    for (const x of later) {
      const laterPay = await env.DB.prepare("SELECT * FROM pass_payments WHERE id = ?1").bind(x.payment_id).first();
      const prod = laterPay ? await termsForPayment(env, laterPay) : null; if (!prod) continue;
      const ends = addDuration(cursor, prod.duration);
      stmts.push(env.DB.prepare("UPDATE passes SET starts_at = ?1, ends_at = ?2, updated_at = datetime('now', '+9 hours') WHERE id = ?3").bind(cursor, ends, x.id));
      cursor = ends;
    }
  }
  await env.DB.batch(stmts);
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?1").bind(p.customer_id).first();
  if (c) await env.DB.batch(await expiryNoticeStmts(env, c, p.pass_group));
}

/* ---------- 매장 직원 확인 (프론트의 '관리' → 결제 취소) ---------- */
// KIOSK_STAFF_PIN(숫자 4~8자리)이 맞으면 10분짜리 서명 토큰을 줍니다. 토큰은 그 단말기에서만 쓸 수 있습니다.
const staffSecret = (env) => "staff|" + String(env.SESSION_SECRET || env.ADMIN_KEY || "");
export async function makeStaffToken(env, deviceId) {
  const exp = Date.now() + 10 * 60e3;
  return exp + "." + (await sha256Hex(staffSecret(env) + "|" + deviceId + "|" + exp)).slice(0, 40);
}
export async function staffTokenOk(env, deviceId, tok) {
  const [exp, sig] = String(tok || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = (await sha256Hex(staffSecret(env) + "|" + deviceId + "|" + exp)).slice(0, 40);
  return want.length === sig.length && want === sig;
}
