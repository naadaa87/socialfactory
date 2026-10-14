/**
 * POST /api/pay/inicis/return — PC 결제창 인증 결과 → 승인요청 → 주문 상태 반영
 * 이니시스가 결제창 안에서 이 주소로 POST 합니다. 처리 뒤 맨 위 창을 주문 완료 화면으로 보냅니다.
 */
import { payConfig, orderToken, pcAuthFields, validInicisUrl, postForm, htmlRedirect, notify, PAY_METHOD } from "../../../_lib/shop.js";

export async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  const form = Object.fromEntries((await request.formData()).entries());
  const oid = String(form.merchantData || form.orderNumber || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const done = async (query) => htmlRedirect(origin + "/order-complete?oid=" + encodeURIComponent(oid) + "&t=" + (oid ? await orderToken(env, oid) : "") + (query || ""));
  if (!env.DB || !oid) return done("&fail=" + encodeURIComponent("주문 정보를 찾지 못했습니다"));
  const cfg = payConfig(env);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE oid = ?1").bind(oid).first().catch(() => null);
  if (!order) return done("&fail=" + encodeURIComponent("주문 정보를 찾지 못했습니다"));
  if (order.status === "paid") return done();
  const fail = async (msg, raw) => {
    await env.DB.prepare("UPDATE orders SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END, fail_msg = ?1, pg_raw = ?2 WHERE oid = ?3")
      .bind(String(msg).slice(0, 200), raw ? String(raw).slice(0, 4000) : null, oid).run().catch(() => {});
    return done("&fail=" + encodeURIComponent(msg));
  };

  if (String(form.resultCode) !== "0000") return fail(form.resultMsg || "결제가 완료되지 않았습니다", JSON.stringify(form));
  const authUrl = String(form.authUrl || ""), netCancelUrl = String(form.netCancelUrl || ""), idc = String(form.idc_name || "");
  if (!validInicisUrl(authUrl, idc)) return fail("승인 주소를 확인할 수 없습니다", JSON.stringify(form));

  let res;
  try {
    const text = await postForm(authUrl, await pcAuthFields(cfg, String(form.authToken || "")), env);
    res = JSON.parse(text);
  } catch (e) {
    console.error("inicis-auth", e && e.message);
    return fail("승인 요청 중 오류가 생겼습니다. 결제가 되었다면 곧 취소됩니다.");
  }
  const okCode = String(res.resultCode) === "0000";
  const amountOk = String(res.TotPrice) === String(order.amount) && String(res.MOID) === oid;
  if (!okCode || !amountOk) {
    // 승인됐지만 금액 · 주문번호가 다르면 망취소로 되돌린다
    if (okCode && validInicisUrl(netCancelUrl, idc)) {
      try { await postForm(netCancelUrl, await pcAuthFields(cfg, String(form.authToken || "")), env); } catch (e) { console.error("inicis-netcancel", e && e.message); }
    }
    return fail(okCode ? "결제 금액이 주문과 달라 취소했습니다" : (res.resultMsg || "결제 승인에 실패했습니다"), JSON.stringify(res));
  }
  const method = String(res.payMethod || ""), card = String(res.P_FN_NM || res.CARD_BankName || res.ACCT_BankName || "");
  await env.DB.prepare(
    `UPDATE orders SET status = 'paid', tid = ?1, pg_method = ?2, card_name = ?3, card_num = ?4, paid_at = datetime('now', '+9 hours'), pg_raw = ?5, fail_msg = NULL WHERE oid = ?6`
  ).bind(String(res.tid || ""), method, card, String(res.CARD_Num || ""), JSON.stringify(res).slice(0, 4000), oid).run();
  await notify(env, `[소셜팩토리 결제 완료 ${oid}] ${order.product_name} ${Number(order.amount).toLocaleString("ko-KR")}원 · ${PAY_METHOD[method] || method} · ${order.buyer_name} ${order.buyer_phone}` + (order.start_date ? ` · 시작일 ${order.start_date}` : "") + (order.test_mode ? " (테스트)" : ""));
  return done();
}
export function onRequestGet({ request }) {
  return htmlRedirect(new URL(request.url).origin + "/shop");
}
