/**
 * POST /api/admin/login  { key, remember }  — 관리자 로그인
 * ADMIN_KEY 와 같으면 HttpOnly 쿠키(sf_admin)를 줍니다. 로그인 유지: 12시간, '7일 유지'를 고르면 7일.
 * 같은 IP 에서 15분 안에 8번 틀리면 15분 동안 막습니다.
 */
import { json, clean, sameOrigin, ipHashOf, logEvent, countEvents } from "../../_lib/auth.js";
import { ensureSchema, keyMatches, createAdminSession } from "../../_lib/admin.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db", code: "NO_DB" }, 503);
  if (!env.ADMIN_KEY) return json({ ok: false, error: "no-admin-key", code: "NO_ADMIN_KEY" }, 503);
  await ensureSchema(env);
  const ip = await ipHashOf(request, env);
  if (ip && (await countEvents(env, "admin_fail", "ip", ip, 15)) >= 8) return json({ ok: false, error: "too-many", code: "RATE_LIMIT" }, 429);
  let b = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const key = typeof b.key === "string" ? b.key.trim().slice(0, 200) : "";
  if (!keyMatches(key, env)) {
    await logEvent(env, "admin_fail", "", ip);
    return json({ ok: false, error: "wrong-key", code: "UNAUTHORIZED" }, 401);
  }
  const s = await createAdminSession(request, env, !!b.remember);
  await logEvent(env, "admin_login", clean(b.remember ? "remember" : "", 20), ip);
  return json({ ok: true, hours: s.hours }, 200, { "Set-Cookie": s.cookie });
}
