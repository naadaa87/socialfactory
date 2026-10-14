// GET /api/member/inquiries — 로그인한 회원이 남긴 문의와 처리 상태
import { json, getMember } from "../../_lib/auth.js";
export async function onRequestGet({ request, env }) {
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401);
  try {
    const { results } = await env.DB.prepare(
      `SELECT receipt, created_at, status, purpose, space, when_text, people, substr(message, 1, 300) AS message
       FROM inquiries WHERE member_id = ?1 ORDER BY id DESC LIMIT 50`
    ).bind(m.id).all();
    return json({ ok: true, results });
  } catch (e) {
    // 문의 표에 회원 칸(member_id)이 아직 없으면 빈 목록
    console.error("member-inquiries", e && e.message);
    return json({ ok: true, results: [], note: "upgrade" });
  }
}
