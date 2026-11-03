import { ensurePayapp, netOrderAmount } from "../../_lib/payapp.js";
/**
 * /api/admin/orders — 주문 · 결제 관리 (Authorization: Bearer ADMIN_KEY)
 * GET   ?status=paid&q=검색어 : 주문 목록 (최근 500건)
 * PATCH { id, status, memo }   : 상태 변경(used · refund_requested · refunded · cancelled) · 운영 메모
 * ※ 실제 환불은 해당 결제사의 판매자센터에서 처리합니다. 페이앱은 통보 결과를 자동 반영합니다.
 */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { ORDER_STATUS } from "../../_lib/shop.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  await ensurePayapp(env);
  const url = new URL(request.url);
  const status = clean(url.searchParams.get("status") || "", 20), q = clean(url.searchParams.get("q") || "", 60);
  const where = [], args = [];
  if (status && ORDER_STATUS[status]) { args.push(status); where.push(`status = ?${args.length}`); }
  if (q) { args.push("%" + q + "%"); where.push(`(oid LIKE ?${args.length} OR buyer_name LIKE ?${args.length} OR buyer_phone LIKE ?${args.length} OR buyer_email LIKE ?${args.length} OR product_name LIKE ?${args.length})`); }
  const sql = "SELECT id, oid, created_at, status, product_id, product_name, qty, amount, buyer_name, buyer_phone, buyer_email, start_date, memo, admin_memo, pay_method, pg_method, card_name, card_num, tid, paid_at, device, member_id, test_mode, fail_msg, EXISTS(SELECT 1 FROM payapp_payments WHERE payapp_payments.oid=orders.oid) AS payapp, COALESCE((SELECT refunded_amount FROM payapp_payments WHERE payapp_payments.oid=orders.oid),0) AS refunded_amount FROM orders"
    + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT 500";
  try {
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    const sum = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('paid','used','refund_requested') AND test_mode = 0 THEN ${netOrderAmount} ELSE 0 END), 0) AS sales FROM orders`).first();
    return json({ ok: true, count: results.length, total: Number(sum && sum.n) || 0, sales: Number(sum && sum.sales) || 0, results });
  } catch (e) {
    console.error("admin-orders", e && e.message);
    return json({ ok: false, error: /no such table/i.test(String(e && e.message)) ? "no-table" : "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  await ensurePayapp(env);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10);
  const status = clean(b && b.status, 20);
  const memo = b && b.memo !== undefined ? clean(b.memo, 500) : null;
  if (!id) return json({ ok: false, error: "invalid" }, 400);
  if (status && !["used", "refund_requested", "refunded", "cancelled", "paid"].includes(status)) return json({ ok: false, error: "invalid" }, 400);
  try {
    const order=await env.DB.prepare("SELECT o.status,p.oid AS payapp FROM orders o LEFT JOIN payapp_payments p ON p.oid=o.oid WHERE o.id=?").bind(id).first();
    if (!order) return json({ok:false,error:"not-found"},404);
    if (order.payapp && status && status!==order.status && !(["paid","used","refund_requested"].includes(order.status) && ["used","refund_requested"].includes(status))) return json({ok:false,error:"pg-status",message:"페이앱 승인·환불 상태는 판매자센터의 실제 처리 결과로 자동 반영됩니다."},409);
    if (status) {
      const updated=await env.DB.prepare("UPDATE orders SET status=?1 WHERE id=?2 AND status=?3").bind(status,id,order.status).run();
      if (!updated.meta.changes) return json({ok:false,error:"status-changed",message:"결제 상태가 변경되었습니다. 새로고침 후 다시 확인해 주세요."},409);
    }
    if (memo !== null) await env.DB.prepare("UPDATE orders SET admin_memo = ?1 WHERE id = ?2").bind(memo, id).run();
    return json({ ok: true });
  } catch (e) { console.error("admin-orders-patch", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}
