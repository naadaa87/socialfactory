// POST /api/auth/signup — 이메일 회원가입
import {
  json, clean, normEmail, validEmail, phoneDigits, formatPhone, passwordProblem, hashPassword, createSession,
  sameOrigin, ipHashOf, logEvent, countEvents, publicMember, TERMS_VERSION, PRIVACY_VERSION, safeNext
} from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!b || typeof b !== "object") return json({ ok: false, error: "bad-json" }, 400);
  if (clean(b.website)) return json({ ok: false, error: "invalid", fields: {} }, 400); // 자동 가입 봇

  const email = normEmail(b.email);
  const name = clean(b.name, 40);
  const digits = phoneDigits(b.phone);
  const fields = {};
  if (!validEmail(email)) fields.email = "email";
  const pp = passwordProblem(b.password);
  if (pp) fields.password = pp;
  if (!name) fields.name = "required";
  if (digits.length < 9 || digits.length > 15) fields.phone = "phone";
  if (b.agreeAge !== true) fields.agreeAge = "required";
  if (b.agreeTerms !== true) fields.agreeTerms = "required";
  if (b.agreePrivacy !== true) fields.agreePrivacy = "required";
  if (Object.keys(fields).length) return json({ ok: false, error: "invalid", fields }, 400);

  const ipHash = await ipHashOf(request, env);
  if ((await countEvents(env, "signup", "ip", ipHash, 60)) >= 5) return json({ ok: false, error: "too-many" }, 429);

  try {
    const exists = await env.DB.prepare("SELECT id FROM members WHERE provider = 'email' AND email = ?1").bind(email).first();
    if (exists) return json({ ok: false, error: "exists" }, 409);
    const marketing = b.marketing === true ? 1 : 0;
    const res = await env.DB.prepare(
      `INSERT INTO members (provider, email, password_hash, name, phone, marketing, marketing_at, terms_version, privacy_version, agreed_at)
       VALUES ('email', ?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 1 THEN datetime('now', '+9 hours') ELSE NULL END, ?6, ?7, datetime('now', '+9 hours'))`
    ).bind(email, await hashPassword(b.password), name, formatPhone(b.phone), marketing, TERMS_VERSION, PRIVACY_VERSION).run();
    const id = res.meta.last_row_id;
    await logEvent(env, "signup", email, ipHash);
    const cookies = await createSession(request, env, id);
    const m = await env.DB.prepare("SELECT * FROM members WHERE id = ?1").bind(id).first();
    return json({ ok: true, member: publicMember(m), next: safeNext(b.next) }, 200, { "Set-Cookie": cookies });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/UNIQUE/i.test(msg)) return json({ ok: false, error: "exists" }, 409);
    console.error("signup", msg);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
