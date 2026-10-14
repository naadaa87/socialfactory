/**
 * 소셜팩토리 회원 기능 공통 도구 (Cloudflare Pages Functions)
 * ------------------------------------------------------------------
 * - 비밀번호: PBKDF2-SHA256 100,000회 + 회원별 소금값 (원래 비밀번호는 어디에도 저장하지 않음)
 * - 로그인 유지: 무작위 토큰을 HttpOnly 쿠키(sf_session)로 주고, DB에는 토큰의 해시만 저장
 * - 화면 표시용 쿠키 sf_m=1 (로그인 여부만 알려 주며 개인정보 없음)
 * - 다른 사이트에서 보낸 요청 차단: 변경 요청은 Origin 이 같은 주소일 때만 받음
 * 이 폴더(_lib)는 주소로 열리지 않는 내부 모듈입니다.
 */

export const json = (data, status = 200, headers = {}) => {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else h.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers: h });
};

export const clean = (v, max = 500) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array((h.match(/.{2}/g) || []).map((x) => parseInt(x, 16)));
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256Hex = async (text) => hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));

export function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- 비밀번호 ---------- */
const ITER = 100000; // Cloudflare Workers 에서 허용하는 최댓값
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${hex(salt)}$${await pbkdf2(password, salt, ITER)}`;
}
const DUMMY = "pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
export async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const got = await pbkdf2(password, fromHex(parts[2]), parseInt(parts[1], 10) || ITER);
  return stored ? safeEqual(got, parts[3]) : false; // 없는 계정도 같은 시간만큼 계산
}
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "short";
  if (pw.length > 72) return "long";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "weak";
  return "";
}
export function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = ""; for (const b of bytes) s += abc[b % abc.length];
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) ? s : s.slice(0, 8) + "7k";
}

/* ---------- 입력 검사 ---------- */
export const normEmail = (v) => clean(v, 120).toLowerCase();
export const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
export const phoneDigits = (v) => clean(v, 40).replace(/[^0-9]/g, "");
export function formatPhone(v) {
  const d = phoneDigits(v);
  if (/^01\d{8,9}$/.test(d)) return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return clean(v, 40);
}

/* ---------- 요청 출처 확인 (다른 사이트에서 대신 보내는 요청 막기) ---------- */
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // 같은 사이트의 일반 요청은 Origin 이 없을 수 있음 (SameSite 쿠키로 한 번 더 막힘)
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

/* ---------- 쿠키 ---------- */
export function readCookie(request, name) {
  const all = request.headers.get("cookie") || "";
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return "";
}
function cookie(request, name, value, maxAge, httpOnly = true) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure}`;
}
export const SESSION_DAYS = 30;

export async function createSession(request, env, memberId) {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?1, ?2, datetime('now', '+9 hours', ?3))"
  ).bind(hash, memberId, `+${SESSION_DAYS} days`).run();
  await env.DB.prepare("UPDATE members SET last_login_at = datetime('now', '+9 hours') WHERE id = ?1").bind(memberId).run();
  // 오래된 로그인 기록 정리 (가끔)
  if (Math.random() < 0.1) {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now', '+9 hours')").run().catch(() => {});
    await env.DB.prepare("DELETE FROM auth_events WHERE created_at < datetime('now', '+9 hours', '-90 days')").run().catch(() => {});
  }
  const age = SESSION_DAYS * 86400;
  return [cookie(request, "sf_session", token, age), cookie(request, "sf_m", "1", age, false)];
}
export function clearSessionCookies(request) {
  return [cookie(request, "sf_session", "", 0), cookie(request, "sf_m", "", 0, false)];
}
export async function getMember(request, env) {
  if (!env.DB) return null;
  const token = readCookie(request, "sf_session");
  if (!token || token.length < 20) return null;
  try {
    const hash = await sha256Hex(token);
    const m = await env.DB.prepare(
      `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.token_hash = ?1 AND s.expires_at > datetime('now', '+9 hours') AND m.status = 'active'`
    ).bind(hash).first();
    return m || null;
  } catch (e) { console.error("session", e && e.message); return null; }
}
export async function endSession(request, env) {
  const token = readCookie(request, "sf_session");
  if (token && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run().catch(() => {});
}

/* ---------- 서명한 짧은 쿠키 (카카오 가입 마무리용) ---------- */
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}
export async function signedCookie(request, env, name, payload, maxAge) {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + maxAge * 1000 })));
  return cookie(request, name, body + "." + (await hmac(env.SESSION_SECRET, body)), maxAge);
}
export async function readSigned(request, env, name) {
  const v = readCookie(request, name);
  if (!v || !env.SESSION_SECRET) return null;
  const [body, sig] = v.split(".");
  if (!body || !sig || !safeEqual(sig, await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
export const clearCookie = (request, name) => cookie(request, name, "", 0);
export const plainCookie = (request, name, value, maxAge) => cookie(request, name, value, maxAge);

/* ---------- 접속 기록 · 과다 시도 제한 ---------- */
export async function ipHashOf(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  return ip ? (await sha256Hex(ip + "|" + (env.IP_SALT || "socialfactory"))).slice(0, 24) : "";
}
export async function logEvent(env, kind, email, ipHash) {
  try { await env.DB.prepare("INSERT INTO auth_events (kind, email, ip_hash) VALUES (?1, ?2, ?3)").bind(kind, email || "", ipHash || "").run(); } catch (e) { console.error("auth-log", e && e.message); }
}
export async function countEvents(env, kind, field, value, minutes) {
  if (!value) return 0;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM auth_events WHERE kind = ?1 AND ${field === "email" ? "email" : "ip_hash"} = ?2 AND created_at > datetime('now', '+9 hours', ?3)`
    ).bind(kind, value, `-${minutes} minutes`).first();
    return Number(r && r.n) || 0;
  } catch { return 0; }
}

/* ---------- 관리자 ---------- */
export function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const headerKey = request.headers.get("x-admin-key") || "";
  return safeEqual(bearer, env.ADMIN_KEY) || safeEqual(headerKey, env.ADMIN_KEY);
}

/* ---------- 회원 정보를 화면에 보낼 때 (비밀번호 해시 등 제외) ---------- */
export function publicMember(m) {
  return {
    id: m.id, provider: m.provider, email: m.email || "", name: m.name, phone: m.phone,
    marketing: !!m.marketing, marketingAt: m.marketing_at || "", createdAt: m.created_at,
    mustChangePassword: !!m.must_change_pw
  };
}
export const TERMS_VERSION = "2026-10-11";
export const PRIVACY_VERSION = "2026-10-11";
export const safeNext = (v) => (typeof v === "string" && /^\/[A-Za-z0-9/_\-?=&#.%]*$/.test(v) && !v.startsWith("//") ? v.slice(0, 200) : "/mypage");

/* ---------- 회원 삭제 (탈퇴 · 관리자 삭제 공통) ---------- */
export async function deleteMember(env, id) {
  // 남긴 문의는 운영 기록으로 보관 기간까지 두되 회원과의 연결은 끊는다
  try { await env.DB.prepare("UPDATE inquiries SET member_id = NULL WHERE member_id = ?1").bind(id).run(); } catch (e) { /* 예전 표에는 member_id 칸이 없을 수 있음 */ }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM members WHERE id = ?1").bind(id)
  ]);
}

