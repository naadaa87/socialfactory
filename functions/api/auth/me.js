// /api/auth/me — 내 정보 조회(GET) · 수정(PATCH) · 회원 탈퇴(DELETE)
import {
  json, clean, phoneDigits, formatPhone, getMember, publicMember, sameOrigin, clearSessionCookies, verifyPassword, deleteMember
} from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401, { "Set-Cookie": clearSessionCookies(request) });
  return json({ ok: true, member: publicMember(m) });
}

export async function onRequestPatch({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const name = b.name === undefined ? m.name : clean(b.name, 40);
  const phone = b.phone === undefined ? m.phone : formatPhone(b.phone);
  const fields = {};
  if (!name) fields.name = "required";
  const d = phoneDigits(phone);
  if (d.length < 9 || d.length > 15) fields.phone = "phone";
  if (Object.keys(fields).length) return json({ ok: false, error: "invalid", fields }, 400);
  const marketing = b.marketing === undefined ? m.marketing : (b.marketing === true ? 1 : 0);
  try {
    await env.DB.prepare(
      `UPDATE members SET name = ?1, phone = ?2, marketing = ?3,
         marketing_at = CASE WHEN ?3 <> marketing THEN datetime('now', '+9 hours') ELSE marketing_at END
       WHERE id = ?4`
    ).bind(name, phone, marketing, m.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM members WHERE id = ?1").bind(m.id).first();
    return json({ ok: true, member: publicMember(fresh) });
  } catch (e) {
    console.error("me-patch", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401);
  let b = {};
  try { b = await request.json(); } catch { /* 빈 요청 */ }
  if (m.provider === "email") {
    if (!(await verifyPassword(String(b.password || "").slice(0, 200), m.password_hash))) return json({ ok: false, error: "wrong" }, 401);
  } else if (clean(b.confirm, 10) !== "탈퇴") {
    return json({ ok: false, error: "confirm" }, 400);
  }
  try {
    await deleteMember(env, m.id);
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookies(request) });
  } catch (e) {
    console.error("withdraw", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
