// POST /api/auth/logout — 로그아웃
import { json, endSession, clearSessionCookies, sameOrigin } from "../../_lib/auth.js";
export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  await endSession(request, env);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookies(request) });
}
