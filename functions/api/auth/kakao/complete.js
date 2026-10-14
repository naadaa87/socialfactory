// /api/auth/kakao/complete — 처음 온 카카오 회원의 가입 마무리
// GET: 카카오에서 받은 이름(닉네임)·이메일 미리 보기 / POST: 약관 동의 + 이름·연락처로 가입
import {
  json, clean, normEmail, validEmail, phoneDigits, formatPhone, readSigned, clearCookie, createSession,
  sameOrigin, publicMember, TERMS_VERSION, PRIVACY_VERSION, ipHashOf, logEvent
} from "../../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const p = await readSigned(request, env, "sf_kp");
  if (!p) return json({ ok: false, error: "expired" }, 404);
  return json({ ok: true, nickname: p.nickname || "", email: p.email || "" });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const p = await readSigned(request, env, "sf_kp");
  if (!p) return json({ ok: false, error: "expired" }, 410);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const name = clean(b.name, 40);
  const digits = phoneDigits(b.phone);
  const email = p.email || normEmail(b.email);
  const fields = {};
  if (!name) fields.name = "required";
  if (digits.length < 9 || digits.length > 15) fields.phone = "phone";
  if (email && !validEmail(email)) fields.email = "email";
  if (b.agreeAge !== true) fields.agreeAge = "required";
  if (b.agreeTerms !== true) fields.agreeTerms = "required";
  if (b.agreePrivacy !== true) fields.agreePrivacy = "required";
  if (Object.keys(fields).length) return json({ ok: false, error: "invalid", fields }, 400);
  const marketing = b.marketing === true ? 1 : 0;
  try {
    let m = await env.DB.prepare("SELECT * FROM members WHERE kakao_id = ?1").bind(p.kid).first();
    if (!m) {
      const res = await env.DB.prepare(
        `INSERT INTO members (provider, kakao_id, email, name, phone, marketing, marketing_at, terms_version, privacy_version, agreed_at)
         VALUES ('kakao', ?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 1 THEN datetime('now', '+9 hours') ELSE NULL END, ?6, ?7, datetime('now', '+9 hours'))`
      ).bind(p.kid, email || null, name, formatPhone(b.phone), marketing, TERMS_VERSION, PRIVACY_VERSION).run();
      m = await env.DB.prepare("SELECT * FROM members WHERE id = ?1").bind(res.meta.last_row_id).first();
      await logEvent(env, "signup", "kakao:" + p.kid, await ipHashOf(request, env));
    }
    if (m.status !== "active") return json({ ok: false, error: "blocked" }, 403);
    const cookies = await createSession(request, env, m.id);
    return json({ ok: true, member: publicMember(m), next: p.next || "/mypage" }, 200, { "Set-Cookie": [...cookies, clearCookie(request, "sf_kp")] });
  } catch (e) {
    console.error("kakao-complete", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
