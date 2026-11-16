// PayApp REST 요청과 서버 통보 검증. 키·통보 원문은 브라우저나 로그에 보내지 않습니다.
import { sha256Hex as sha256 } from './auth.js';

// Keep PAYAPP_* attached to Blank permanently. Changing the active account only
// affects new requests; neither old requests nor their refund callbacks move.
export function payappConfig(env, account = String(env.PAYAPP_ACTIVE_ACCOUNT || 'blank').trim()) {
  const known = account === 'blank' || account === 'gu';
  const prefix = account === 'gu' ? 'PAYAPP_GU_' : 'PAYAPP_';
  const value = (...names) => names.map(name => typeof env[prefix + name] === 'string' ? env[prefix + name].trim() : '').find(Boolean) || '';
  const userid = known ? value('USERID') : '';
  const linkkey = known ? value('LINKKEY', 'LINK_KEY') : '';
  const linkval = known ? value('LINKVAL', 'LINK_VALUE') : '';
  const requestkey = known ? value('REQUESTKEY', 'REQUEST_KEY') : '';
  const distinct = account !== 'gu' || !env.PAYAPP_USERID || userid !== String(env.PAYAPP_USERID).trim();
  const configured = !!(known && distinct && userid && linkkey && linkval && requestkey);
  return { account, configured, live: configured && env.PAYAPP_ENABLED === '1', userid, linkkey, linkval, requestkey };
}
export const payappAccounts = env => ['blank', 'gu'].map(account => payappConfig(env, account));
export function payappPaymentMatches(config, row) {
  return !!row && config.account === (row.merchant_account || 'blank')
    && (row.merchant_userid ? equalSecret(config.userid, row.merchant_userid) : config.account === 'blank');
}
export function payappPaymentConfig(env, row) {
  const config = payappConfig(env, row?.merchant_account || 'blank');
  const configured = config.configured && payappPaymentMatches(config, row);
  return { ...config, configured, live: config.live && configured };
}
export function kstStamp(ms = Date.now()) {
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, '');
}
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function payappUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !(u.hostname === 'payapp.kr' || u.hostname.endsWith('.payapp.kr'))) return null;
    return u.href;
  } catch { return null; }
}
export async function requestPayment(C, fields) {
  if (!C.live) throw new Error('PAYAPP_NOT_CONFIGURED');
  const requestdate = kstStamp();
  const body = new URLSearchParams({ ...fields, cmd: 'payrequest', userid: C.userid,
    linkkey: C.linkkey, requestdate, hash: await sha256(C.userid + requestdate + C.requestkey) });
  const response = await fetch('https://api.payapp.kr/oapi/v2', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    // Workers는 redirect:error를 지원하지 않습니다. 리다이렉트는 따라가지 않고 상태를 검증합니다.
    redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('PAYAPP_HTTP');
  const r = new URLSearchParams(await response.text());
  if (r.get('state') !== '1') return { ok: false, code: r.get('errno') || 'PAYAPP_REJECTED' };
  const mulNo = r.get('mul_no') || '', payurl = payappUrl(r.get('payurl'));
  if (!/^\d{1,30}$/.test(mulNo) || !payurl) throw new Error('PAYAPP_RESPONSE');
  return { ok: true, mulNo, payurl };
}
export async function validFeedback(C, f) {
  if (!C.configured || !equalSecret(f.userid, C.userid) || !equalSecret(f.linkkey, C.linkkey) || !equalSecret(f.linkval, C.linkval)) return false;
  const stamp = f.responsedate || '';
  if (!/^\d{14}$/.test(stamp)) return false;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || kstStamp(ms) !== stamp || Math.abs(Date.now() - ms) > 15 * 60e3) return false;
  return equalSecret((f.hash || '').toLowerCase(), await sha256(C.userid + stamp + C.requestkey));
}
export async function payappFeedbackConfig(env, fields) {
  for (const config of payappAccounts(env)) if (await validFeedback(config, fields)) return config;
  return null;
}


// 기존 주문 테이블은 변경하지 않습니다. 구 DB도 첫 요청 때 안전하게 준비합니다.
export const PAYAPP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payapp_payments (
    oid TEXT PRIMARY KEY REFERENCES orders(oid), mul_no TEXT UNIQUE, nonce TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, payurl TEXT,
    refunded_amount INTEGER NOT NULL DEFAULT 0,
    merchant_account TEXT NOT NULL DEFAULT 'blank' CHECK(merchant_account IN ('blank','gu')), merchant_userid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  )`,
  `CREATE TABLE IF NOT EXISTS payapp_refunds (
    mul_no TEXT PRIMARY KEY, oid TEXT NOT NULL REFERENCES payapp_payments(oid),
    amount INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payapp_refunds_oid ON payapp_refunds(oid)`
];
export async function ensurePayapp(env) {
  await env.DB.batch(PAYAPP_SCHEMA.map(sql => env.DB.prepare(sql)));
  await ensurePayappMerchantColumns(env, 'payapp_payments');
}

// Additive migration: old rows keep their original provider IDs, URLs and nonce.
// Only duplicate-column races may be ignored, never a failed database upgrade.
export async function ensurePayappMerchantColumns(env, table) {
  if (!['payapp_payments', 'booking_payapp_requests'].includes(table)) throw new Error('PAYAPP_TABLE');
  const columns = async () => (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results || [];
  let present = await columns();
  for (const [name, definition] of [
    ['merchant_account', "TEXT NOT NULL DEFAULT 'blank' CHECK(merchant_account IN ('blank','gu'))"],
    ['merchant_userid', 'TEXT']
  ]) {
    if (present.some(column => column.name === name)) continue;
    try { await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run(); }
    catch (error) { if (!(await columns()).some(column => column.name === name)) throw error; }
    present = await columns();
  }
  const legacy = payappConfig(env, 'blank');
  if (legacy.configured) await env.DB.prepare(`UPDATE ${table} SET merchant_userid=? WHERE merchant_account='blank' AND merchant_userid IS NULL`).bind(legacy.userid).run();
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS ${table}_merchant_guard
    BEFORE UPDATE OF merchant_account,merchant_userid ON ${table}
    WHEN NEW.merchant_account IS NOT OLD.merchant_account
      OR (OLD.merchant_userid IS NOT NULL AND NEW.merchant_userid IS NOT OLD.merchant_userid)
    BEGIN SELECT RAISE(ABORT,'payapp-merchant-immutable'); END`).run();
}
// 환불 통보가 먼저 도착해도 뒤늦은 승인 통보로 매출을 되살리지 않습니다.
export const netOrderAmount = `(amount - COALESCE((SELECT refunded_amount FROM payapp_payments WHERE payapp_payments.oid = orders.oid), 0))`;
