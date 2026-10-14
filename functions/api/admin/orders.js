/**
 * /api/admin/orders — 주문 · 결제 관리 (Authorization: Bearer ADMIN_KEY)
 * GET   ?status=paid&q=검색어 : 주문 목록 (최근 500건)
 * PATCH { id, status, memo }   : 상태 변경(used · refund_requested · refunded · cancelled) · 운영 메모
 * ※ 실제 결제 취소(환불)는 KG이니시스 가맹점관리자(iniweb.inicis.com)에서 처리하고, 여기에는 결과만 기록합니다.
 */
import { json, clean, isAdmin } from "../../_lib/auth.js";
import { ORDER_STATUS } from "../../_lib/shop.js";

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const url = new URL(request.url);
  const status = clean(url.searchParams.get("status") || "", 20), q = clean(url.searchParams.get("q") || "", 60);
  const where = [], args = [];
  if (status && ORDER_STATUS[status]) { args.push(status); where.push(`status = ?${args.length}`); }
  if (q) { args.push("%" + q + "%"); where.push(`(oid LIKE ?${args.length} OR buyer_name LIKE ?${args.length} OR buyer_phone LIKE ?${args.length} OR buyer_email LIKE ?${args.length} OR product_name LIKE ?${args.length})`); }
  const sql = "SELECT id, oid, created_at, status, product_id, product_name, qty, amount, buyer_name, buyer_phone, buyer_email, start_date, memo, admin_memo, pay_method, pg_method, card_name, card_num, tid, paid_at, device, member_id, test_mode, fail_msg FROM orders"
    + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT 500";
  try {
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    const sum = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('paid','used') AND test_mode = 0 THEN amount ELSE 0 END), 0) AS sales FROM orders").first();
    return json({ ok: true, count: results.length, total: Number(sum && sum.n) || 0, sales: Number(sum && sum.sales) || 0, results });
  } catch (e) {
    console.error("admin-orders", e && e.message);
    return json({ ok: false, error: /no such table/i.test(String(e && e.message)) ? "no-table" : "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10);
  const status = clean(b && b.status, 20);
  const memo = b && b.memo !== undefined ? clean(b.memo, 500) : null;
  if (!id) return json({ ok: false, error: "invalid" }, 400);
  if (status && !["used", "refund_requested", "refunded", "cancelled", "paid"].includes(status)) return json({ ok: false, error: "invalid" }, 400);
  try {
    if (status) await env.DB.prepare("UPDATE orders SET status = ?1 WHERE id = ?2").bind(status, id).run();
    if (memo !== null) await env.DB.prepare("UPDATE orders SET admin_memo = ?1 WHERE id = ?2").bind(memo, id).run();
    return json({ ok: true });
  } catch (e) { console.error("admin-orders-patch", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}
