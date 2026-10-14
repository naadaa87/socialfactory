// POST /api/auth/login — 이메일 로그인
import { json, normEmail, verifyPassword, createSession, sameOrigin, ipHashOf, logEvent, countEvents, publicMember, safeNext } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const email = normEmail(b && b.email);
  const password = typeof (b && b.password) === "string" ? b.password.slice(0, 200) : "";
  if (!email || !password) return json({ ok: false, error: "invalid" }, 400);

  const ipHash = await ipHashOf(request, env);
  // 15분 안에 같은 접속에서 20번, 같은 이메일로 8번 넘게 틀리면 잠시 막는다
  if ((await countEvents(env, "login_fail", "ip", ipHash, 15)) >= 20 || (await countEvents(env, "login_fail", "email", email, 15)) >= 8) {
    return json({ ok: false, error: "too-many" }, 429);
  }
  try {
    const m = await env.DB.prepare("SELECT * FROM members WHERE provider = 'email' AND email = ?1").bind(email).first();
    const ok = await verifyPassword(password, m && m.password_hash);
    if (!m || !ok) { await logEvent(env, "login_fail", email, ipHash); return json({ ok: false, error: "wrong" }, 401); }
    if (m.status !== "active") return json({ ok: false, error: "blocked" }, 403);
    await logEvent(env, "login_ok", email, ipHash);
    const cookies = await createSession(request, env, m.id);
    return json({ ok: true, member: publicMember(m), next: safeNext(b.next) }, 200, { "Set-Cookie": cookies });
  } catch (e) {
    console.error("login", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
