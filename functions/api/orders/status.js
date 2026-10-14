// GET /api/orders/status?oid=…&t=… — 주문 결과 조회 (주문 완료 화면)
import { orderToken, ORDER_STATUS, PAY_METHOD } from "../../_lib/shop.js";
import { PRODUCT_MAP } from "../../_lib/products.js";
import { json, clean, safeEqual, getMember } from "../../_lib/auth.js";
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const url = new URL(request.url);
  const oid = clean(url.searchParams.get("oid") || "", 40), t = clean(url.searchParams.get("t") || "", 40);
  if (!oid) return json({ ok: false, error: "invalid" }, 400);
  const o = await env.DB.prepare("SELECT * FROM orders WHERE oid = ?1").bind(oid).first().catch(() => null);
  if (!o) return json({ ok: false, error: "not-found" }, 404);
  const member = await getMember(request, env);
  const allowed = safeEqual(t, await orderToken(env, oid)) || (member && o.member_id === member.id);
  if (!allowed) return json({ ok: false, error: "forbidden" }, 403);
  const p = PRODUCT_MAP[o.product_id] || {};
  return json({ ok: true, order: {
    oid: o.oid, status: o.status, statusLabel: ORDER_STATUS[o.status] || o.status, productId: o.product_id, productName: o.product_name, qty: o.qty, amount: o.amount,
    buyerName: o.buyer_name, buyerPhone: o.buyer_phone, buyerEmail: o.buyer_email || "", startDate: o.start_date || "", startLabel: p.startLabel || "",
    payMethod: PAY_METHOD[o.pg_method] || o.pg_method || (o.pay_method === "bank" ? "실시간 계좌이체" : "신용 · 체크카드"), paidAt: o.paid_at || "", tid: o.tid || "",
    cardName: o.card_name || "", failMsg: o.fail_msg || "", createdAt: o.created_at, test: !!o.test_mode, validity: p.validity || ""
  } });
}
