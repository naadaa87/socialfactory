// POST /api/admin/logout — 이 기기의 관리자 로그인을 끝냅니다.
import { json, sameOrigin } from "../../_lib/auth.js";
import { endAdminSession } from "../../_lib/admin.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  const cookie = await endAdminSession(request, env);
  return json({ ok: true }, 200, { "Set-Cookie": cookie });
}
