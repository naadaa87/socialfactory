// GET /api/member/orders — 로그인한 회원의 주문 내역
import { json, getMember } from "../../_lib/auth.js";
import { ORDER_STATUS, PAY_METHOD } from "../../_lib/shop.js";
export async function onRequestGet({ request, env }) {
  const m = await getMember(request, env);
  if (!m) return json({ ok: false, error: "login" }, 401);
  try {
    const { results } = await env.DB.prepare(
      "SELECT oid, created_at, status, product_name, qty, amount, start_date, pg_method, paid_at FROM orders WHERE member_id = ?1 AND status <> 'pending' ORDER BY id DESC LIMIT 50"
    ).bind(m.id).all();
    return json({ ok: true, results: results.map((o) => ({ ...o, statusLabel: ORDER_STATUS[o.status] || o.status, payLabel: PAY_METHOD[o.pg_method] || "" })) });
  } catch (e) { return json({ ok: true, results: [], note: "upgrade" }); }
}
