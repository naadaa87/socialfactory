// POST /api/auth/password — 비밀번호 변경 (이메일 가입 회원)
import { json, getMember, verifyPassword, hashPassword, passwordProblem, createSession, sameOrigin } from "../../_lib/auth.js";
export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401);
  if (m.provider !== "email") return json({ ok: false, error: "provider" }, 400);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!(await verifyPassword(String(b.current || "").slice(0, 200), m.password_hash))) return json({ ok: false, error: "wrong" }, 401);
  const pp = passwordProblem(b.next);
  if (pp) return json({ ok: false, error: "invalid", fields: { next: pp } }, 400);
  try {
    await env.DB.prepare("UPDATE members SET password_hash = ?1, must_change_pw = 0 WHERE id = ?2").bind(await hashPassword(b.next), m.id).run();
    // 다른 기기의 로그인은 모두 끊고 지금 기기만 새로 로그인
    await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(m.id).run();
    const cookies = await createSession(request, env, m.id);
    return json({ ok: true }, 200, { "Set-Cookie": cookies });
  } catch (e) {
    console.error("password", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
