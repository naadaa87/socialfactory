// GET /api/admin/session — 로그인되어 있는지 확인 (관리자 화면을 열 때 가장 먼저 부릅니다)
import { json } from "../../_lib/auth.js";
import { adminGate, kstToday } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env);
  if (deny) return deny;
  return json({ ok: true, today: kstToday() });
}
