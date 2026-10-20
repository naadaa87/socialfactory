/**
 * POST /api/kiosk/intents { productId, phone, agreePrivacy } — 결제 준비 (단말기 토큰 필요)
 * 전화번호로 고객을 찾거나 만들고, 금액 · 부가세를 서버 상품표로 계산한 뒤 결제 식별자(paymentKey)를 발급합니다.
 * 프론트는 돌려받은 값 그대로 sdk.payment.requestPayment 를 부릅니다. 화면에서 보낸 금액은 쓰지 않습니다.
 */
import { json, clean } from "../../_lib/auth.js";
import { kstNow } from "../../_lib/admin.js";
import { KIOSK_PRODUCT_MAP, splitVat } from "../../_lib/kiosk-products.js";
import { deviceGate, upsertCustomer, validMobile, maskPhone, makePaymentKey, nextStart, addDuration, kTime } from "../../_lib/kiosk.js";

export async function onRequestPost({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const product = KIOSK_PRODUCT_MAP[clean(b && b.productId, 40)];
  const phone = clean(b && b.phone, 20);
  if (!product) return json({ ok: false, error: "invalid", field: "productId" }, 400);
  if (!validMobile(phone)) return json({ ok: false, error: "invalid", field: "phone", message: "휴대폰 번호를 다시 확인해 주세요." }, 400);
  if (b.agreePrivacy !== true) return json({ ok: false, error: "invalid", field: "agree" }, 400);

  // 같은 단말기에서 짧은 시간에 결제 준비가 지나치게 많으면 막습니다 (오작동 · 장난 방지)
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM pass_payments WHERE device_id = ?1 AND created_at > datetime('now', '+9 hours', '-10 minutes')").bind(device.id).first();
  if (recent && recent.n >= 30) return json({ ok: false, error: "too-many" }, 429);

  const customer = await upsertCustomer(env, phone, { privacy: true });
  const { tax, supplyValue } = splitVat(product.price);
  const paymentKey = makePaymentKey();
  await env.DB.prepare(
    `INSERT INTO pass_payments (payment_key, status, channel, device_id, customer_id, product_id, product_name, amount, tax, supply, test_mode)
     VALUES (?1, 'pending', 'toss_front', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(paymentKey, device.id, customer.id, product.id, product.name, product.price, tax, supplyValue, env.KIOSK_TEST === "1" ? 1 : 0).run();

  // 결제 전 확인 화면에 보여 줄 예상 이용 기간 (실제 기간은 결제가 끝난 시각으로 다시 계산합니다)
  const start = await nextStart(env, customer.id, product.group, kstNow());
  const end = addDuration(start, product.duration);
  return json({
    ok: true, paymentKey,
    payment: { tax, supplyValue, taxExemptValue: 0, tip: 0 },
    amount: product.price, productName: product.name, listPrice: product.listPrice || null,
    phoneMasked: maskPhone(phone),
    preview: { startsAt: start, endsAt: end, startsText: kTime(start), endsText: kTime(end), extends: start > kstNow() }
  });
}
