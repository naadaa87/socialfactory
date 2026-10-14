/**
 * POST /api/orders — 주문 만들기 (결제 대기) → 결제창 요청값 반환
 * 금액은 화면 값을 믿지 않고 서버의 상품표(_lib/products.js)로 다시 계산합니다.
 */
import { PRODUCT_MAP } from "../../_lib/products.js";
import { payConfig, makeOid, orderToken, pcPayFields, mobilePayFields, pcJsUrl } from "../../_lib/shop.js";
import { json, clean, normEmail, validEmail, phoneDigits, formatPhone, sameOrigin, getMember, ipHashOf } from "../../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const cfg = payConfig(env);
  if (!cfg.ready) return json({ ok: false, error: "pay-off" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!b || typeof b !== "object") return json({ ok: false, error: "bad-json" }, 400);
  if (clean(b.website)) return json({ ok: false, error: "invalid" }, 400);

  const product = PRODUCT_MAP[clean(b.productId, 40)];
  const qty = Math.max(1, Math.min(10, parseInt(b.qty, 10) || 1));
  const name = clean(b.name, 30), phone = clean(b.phone, 20), email = normEmail(b.email);
  const startDate = clean(b.startDate, 10), memo = clean(b.memo, 300);
  const payMethod = clean(b.payMethod, 10) === "bank" ? "bank" : "card";
  const device = clean(b.device, 10) === "mobile" && cfg.mobileKey ? "mobile" : "pc";
  const fields = {};
  if (!product) fields.productId = "required";
  if (!name) fields.name = "required";
  const d = phoneDigits(phone);
  if (d.length < 9 || d.length > 15) fields.phone = "phone";
  if (email && !validEmail(email)) fields.email = "email";
  if (product && product.start === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) fields.startDate = "required";
    else {
      const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const limit = new Date(Date.now() + 9 * 3600 * 1000 + 30 * 86400000).toISOString().slice(0, 10);
      if (startDate < today) fields.startDate = "past";
      else if (startDate > limit) fields.startDate = "far";
    }
  }
  if (b.agreeTerms !== true || b.agreePrivacy !== true || b.agreeRefund !== true) fields.agree = "required";
  if (Object.keys(fields).length) return json({ ok: false, error: "invalid", fields }, 400);

  const member = await getMember(request, env);
  const ipHash = await ipHashOf(request, env);
  const order = {
    oid: makeOid(), product_id: product.id, product_name: product.name + (qty > 1 ? ` × ${qty}` : ""), qty,
    amount: product.price * qty, buyer_name: name, buyer_phone: formatPhone(phone), buyer_email: email,
    start_date: product.start === "date" ? startDate : "", memo, pay_method: payMethod, device, member_id: member ? member.id : null
  };
  try {
    await env.DB.prepare(
      `INSERT INTO orders (oid, status, product_id, product_name, qty, amount, buyer_name, buyer_phone, buyer_email, start_date, memo, pay_method, device, member_id, ip_hash, test_mode)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(order.oid, order.product_id, order.product_name, order.qty, order.amount, order.buyer_name, order.buyer_phone, order.buyer_email,
      order.start_date, order.memo, order.pay_method, order.device, order.member_id, ipHash, cfg.test ? 1 : 0).run();
  } catch (e) {
    console.error("order-insert", e && e.message);
    return json({ ok: false, error: /no such table/i.test(String(e && e.message)) ? "no-table" : "db-error" }, 500);
  }
  const origin = new URL(request.url).origin;
  const token = await orderToken(env, order.oid);
  const pay = device === "mobile"
    ? { mode: "mobile", ...(await mobilePayFields(cfg, order, origin)) }
    : { mode: "pc", js: pcJsUrl(cfg), fields: await pcPayFields(cfg, order, origin) };
  return json({ ok: true, oid: order.oid, token, amount: order.amount, test: cfg.test, pay });
}
