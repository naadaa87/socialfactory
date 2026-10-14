// GET /api/auth/config — 회원 기능 준비 상태 (화면에서 카카오 버튼 표시 여부 등에 사용)
import { json } from "../../_lib/auth.js";
export async function onRequestGet({ env }) {
  return json({ ok: true, db: !!env.DB, kakao: !!(env.KAKAO_REST_KEY && env.SESSION_SECRET) });
}
