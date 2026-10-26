/**
 * 소셜팩토리 관리자 공통 도구 (Cloudflare Pages Functions)
 * ------------------------------------------------------------------
 * - 관리자 로그인: ADMIN_KEY 로 로그인하면 무작위 토큰을 HttpOnly 쿠키(sf_admin, 경로 /api/)로 주고
 *   DB(admin_sessions)에는 토큰의 해시만 저장합니다. ADMIN_KEY 를 바꾸면 모든 기기에서 로그아웃됩니다.
 * - 자동화 · 점검용으로 Authorization: Bearer ADMIN_KEY (또는 X-Admin-Key) 헤더도 계속 받습니다.
 * - 표 자동 준비: 관리자 기능을 처음 쓸 때 필요한 표가 없으면 만듭니다 (D1 콘솔에서 SQL 을 따로 돌리지 않아도 됨).
 * - 예약 · 결제수단 · 매출 집계에 쓰는 값이 여기 모여 있습니다.
 */
import { json, clean, safeEqual, sha256Hex, randomToken, readCookie, ipHashOf, sameOrigin } from "./auth.js";

export const ADMIN_COOKIE = "sf_admin";

/* ---------- 결제수단 · 상태 · 공간 ---------- */
export const PAY_METHODS = {
  bank_blank: "계좌이체(블랭크)",
  bank_other: "계좌이체(별도)",
  spacecloud: "스페이스클라우드",
  card_offline: "카드결제(오프라인)",
  card_online: "카드결제(온라인)"
};
export const PAY_STATUS = { paid: "결제 완료", unpaid: "결제 전", refunded: "환불" };
export const RES_STATUS = { confirmed: "예약 확정", cancelled: "취소" };
export const SPACES = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸", coworking: "코워킹 라운지", office: "독립사무실", other: "기타" };
export const ROOM_KEYS = ["r1", "r2", "r3", "r4", "r5"];          // 시간이 겹치면 안 되는 공간
export const CHANNELS = { kakao: "카카오톡", phone: "전화", web: "홈페이지 문의", spacecloud: "스페이스클라우드", naver: "네이버", visit: "방문", other: "기타" };

/* ---------- 날짜 (한국 시간) ---------- */
export const kstToday = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);
export const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
export const addDaysIso = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const dayIndex = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 864e5);

/* ---------- 표 자동 준비 ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), status TEXT NOT NULL DEFAULT 'new', purpose TEXT NOT NULL, space TEXT, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, company TEXT, when_text TEXT, people TEXT, schedule TEXT, message TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 0, notice_version TEXT, page TEXT, ip_hash TEXT, notify_status TEXT, member_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status)`,
  `CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL DEFAULT 'email', email TEXT, password_hash TEXT, kakao_id TEXT UNIQUE, name TEXT NOT NULL, phone TEXT NOT NULL, marketing INTEGER NOT NULL DEFAULT 0, marketing_at TEXT, terms_version TEXT, privacy_version TEXT, agreed_at TEXT, status TEXT NOT NULL DEFAULT 'active', must_change_pw INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), last_login_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), kind TEXT NOT NULL, email TEXT, ip_hash TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_events ON auth_events (kind, created_at)`,
  `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, oid TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), status TEXT NOT NULL DEFAULT 'pending', product_id TEXT NOT NULL, product_name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, amount INTEGER NOT NULL, buyer_name TEXT NOT NULL, buyer_phone TEXT NOT NULL, buyer_email TEXT, start_date TEXT, memo TEXT, admin_memo TEXT, pay_method TEXT, pg_method TEXT, card_name TEXT, card_num TEXT, tid TEXT, paid_at TEXT, device TEXT, member_id INTEGER, ip_hash TEXT, test_mode INTEGER NOT NULL DEFAULT 0, fail_msg TEXT, pg_raw TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, key_tag TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), expires_at TEXT NOT NULL, ip_hash TEXT, ua TEXT)`,
  `CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT, status TEXT NOT NULL DEFAULT 'confirmed', space TEXT NOT NULL, space_note TEXT, date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, customer_name TEXT NOT NULL, phone TEXT, people INTEGER, purpose TEXT, channel TEXT, amount INTEGER NOT NULL DEFAULT 0, list_amount INTEGER, amount_note TEXT, pay_method TEXT NOT NULL, pay_status TEXT NOT NULL DEFAULT 'paid', paid_at TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, refunded_at TEXT, cancel_reason TEXT, cancelled_at TEXT, inquiry_ref TEXT, memo TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_res_date ON reservations (date, space)`,
  `CREATE INDEX IF NOT EXISTS idx_res_paid ON reservations (paid_at)`,
  `CREATE INDEX IF NOT EXISTS idx_res_status ON reservations (status, pay_status)`,
  // 토스프론트 이용권 (고객 · 결제 · 이용권 · 알림 대기열 · 단말기) — 자세한 설명은 schema-upgrade-passes.sql
  `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, phone_fmt TEXT, name TEXT, memo TEXT, member_id INTEGER, privacy_agreed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS pass_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT, status TEXT NOT NULL DEFAULT 'pending', channel TEXT NOT NULL DEFAULT 'toss_front', device_id INTEGER, customer_id INTEGER NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, amount INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0, supply INTEGER NOT NULL DEFAULT 0, pay_method TEXT, approval_number TEXT, approved_ts INTEGER, tid TEXT, van_key TEXT, card_issuer TEXT, masked_card TEXT, installment INTEGER NOT NULL DEFAULT 0, paid_at TEXT, fail_reason TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, refunded_at TEXT, admin_memo TEXT, test_mode INTEGER NOT NULL DEFAULT 0, raw TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_pp_customer ON pass_payments (customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pp_status ON pass_payments (status, paid_at)`,
  `CREATE TABLE IF NOT EXISTS passes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, payment_id INTEGER NOT NULL UNIQUE, customer_id INTEGER NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, pass_group TEXT NOT NULL DEFAULT 'seat', starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', source TEXT, memo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_passes_customer ON passes (customer_id, pass_group, status, ends_at)`,
  `CREATE INDEX IF NOT EXISTS idx_passes_ends ON passes (status, ends_at)`,
  `CREATE TABLE IF NOT EXISTS notification_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, customer_id INTEGER, pass_id INTEGER, pass_group TEXT, phone TEXT NOT NULL, vars TEXT, send_after TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider TEXT, provider_msg_id TEXT, rendered TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_due ON notification_jobs (status, send_after)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_customer ON notification_jobs (customer_id)`,
  `CREATE TABLE IF NOT EXISTS kiosk_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pairing', token_hash TEXT UNIQUE, pair_hash TEXT, pair_expires_at TEXT, serial TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), paired_at TEXT, last_seen_at TEXT)`
];
// 예전에 만든 표에 나중에 추가한 칸 — 이미 있으면 오류가 나므로 하나씩 실행하고 오류는 무시합니다.
const MIGRATIONS = ["ALTER TABLE inquiries ADD COLUMN member_id INTEGER", "ALTER TABLE customers ADD COLUMN notify_off INTEGER NOT NULL DEFAULT 0"];
let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  let done = false;
  try { await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))); done = true; } catch (e) { /* 하나씩 다시 시도 */ }
  if (!done) for (const s of SCHEMA) { try { await env.DB.prepare(s).run(); } catch (e) { console.error("schema", e && e.message); } }
  for (const s of MIGRATIONS) { try { await env.DB.prepare(s).run(); } catch (e) { /* 이미 있음 */ } }
  schemaReady = true;
}

/* ---------- 관리자 로그인 ---------- */
const keyTag = async (env) => (await sha256Hex("sf-admin|" + String(env.ADMIN_KEY || ""))).slice(0, 16);
export function adminCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/api/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}
export function keyMatches(key, env) {
  return !!env.ADMIN_KEY && typeof key === "string" && key.length > 0 && safeEqual(key, env.ADMIN_KEY);
}
export async function createAdminSession(request, env, remember) {
  const token = randomToken(32);
  const hours = remember ? 24 * 7 : 12;
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token_hash, key_tag, expires_at, ip_hash, ua) VALUES (?1, ?2, datetime('now', '+9 hours', ?3), ?4, ?5)"
  ).bind(await sha256Hex(token), await keyTag(env), `+${hours} hours`, await ipHashOf(request, env), clean(request.headers.get("user-agent") || "", 160)).run();
  if (Math.random() < 0.2) await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now', '+9 hours')").run().catch(() => {});
  return { cookie: adminCookie(request, token, hours * 3600), hours };
}
export async function endAdminSession(request, env) {
  const tok = readCookie(request, ADMIN_COOKIE);
  if (tok && env.DB) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?1").bind(await sha256Hex(tok)).run().catch(() => {});
  return adminCookie(request, "", 0);
}
/** 관리자 요청인지 확인합니다. 헤더 키 또는 로그인 쿠키. 쿠키로 들어온 변경 요청은 같은 사이트에서 보낸 것만 받습니다. */
export async function adminOk(request, env) {
  if (!env.ADMIN_KEY) return false;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerKey = request.headers.get("x-admin-key") || "";
  if (keyMatches(bearer, env) || keyMatches(headerKey, env)) return true;
  const tok = readCookie(request, ADMIN_COOKIE);
  if (!tok || tok.length < 20 || !env.DB) return false;
  if (!["GET", "HEAD"].includes(request.method) && !sameOrigin(request)) return false;
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT key_tag FROM admin_sessions WHERE token_hash = ?1 AND expires_at > datetime('now', '+9 hours')").bind(await sha256Hex(tok)).first();
    return !!row && row.key_tag === (await keyTag(env));
  } catch (e) { console.error("admin-session", e && e.message); return false; }
}
/** 관리자 API 공통 입구 — 통과하면 null, 아니면 바로 돌려줄 응답 */
export async function adminGate(request, env, { needDb = true } = {}) {
  if (!env.ADMIN_KEY) return json({ ok: false, error: "no-admin-key", code: "NO_ADMIN_KEY" }, 503);
  if (!(await adminOk(request, env))) return json({ ok: false, error: "unauthorized", code: "ADMIN_LOGIN" }, 401);
  if (needDb && !env.DB) return json({ ok: false, error: "no-db", code: "NO_DB" }, 503);
  if (env.DB) await ensureSchema(env);
  return null;
}

/* ---------- 예약번호 ---------- */
const ABC = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function makeResCode(dateIso) {
  const b = crypto.getRandomValues(new Uint8Array(4));
  let s = ""; for (const x of b) s += ABC[x % ABC.length];
  return "R" + dateIso.slice(2, 4) + dateIso.slice(5, 7) + dateIso.slice(8, 10) + "-" + s;
}

/* ---------- 시각 표기 (분 → 14:30 / 익일 01:00) ---------- */
export function hm(min) {
  const day = Math.floor(min / 1440), m = min % 1440;
  const s = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  if (min === 1440) return "24:00";
  return (day > 0 ? "익일 " : "") + s;
}
