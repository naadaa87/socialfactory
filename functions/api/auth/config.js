// GET /api/auth/config — 회원 기능 준비 상태 (데이터베이스 연결 여부)
import { json } from "../../_lib/auth.js";
export async function onRequestGet({ env }) {
  return json({ ok: true, db: !!env.DB });
}
