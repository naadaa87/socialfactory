// GET /api/shop/products — 판매 상품 목록과 공통 안내, 결제 준비 상태
import { PRODUCTS, POLICY } from "../../_lib/products.js";
import { payConfig } from "../../_lib/shop.js";
import { json } from "../../_lib/auth.js";
export async function onRequestGet({ env }) {
  const cfg = payConfig(env);
  return json({ ok: true, products: PRODUCTS, policy: POLICY, pay: { ready: cfg.ready && !!env.DB, test: cfg.test, mobile: !!cfg.mobileKey } });
}
