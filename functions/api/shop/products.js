// GET /api/shop/products — 판매 상품 목록과 공통 안내, 결제 준비 상태
import { PRODUCTS, POLICY } from "../../_lib/products.js";
import { payConfig } from "../../_lib/shop.js";
import { json } from "../../_lib/auth.js";
export async function onRequestGet({ env }) {
  const cfg = payConfig(env);
  return json({ ok: true, products: PRODUCTS.filter(p=>!["cowork-2h","cowork-day","cowork-month","locker-month","laptop-day"].includes(p.id)),channels:{coworking:"onsite-kiosk",rooms:"/booking",office:"consultation-payapp"}, policy: POLICY, pay: { ready: false, test: cfg.test, provider:cfg.provider, mobile:cfg.provider === "payapp" || !!cfg.mobileKey } });
}
