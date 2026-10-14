/**
 * POST /api/pay/inicis/mobile — 모바일 결제 인증 결과(P_NEXT_URL) → 승인요청 → 주문 상태 반영
 */
import { payConfig, orderToken, validInicisUrl, postForm, parseNvp, notify, PAY_METHOD } from "../../../_lib/shop.js";

const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  const form = Object.fromEntries((await request.formData()).entries());
  const oid = String(form.P_NOTI || form.P_OID || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const done = async (query) => redirect(origin + "/order-complete?oid=" + encodeURIComponent(oid) + "&t=" + (oid ? await orderToken(env, oid) : "") + (query || ""));
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
  if (String(form.P_STATUS) !== "00") return fail(form.P_RMESG1 || "결제가 완료되지 않았습니다", JSON.stringify(form));
  const reqUrl = String(form.P_REQ_URL || ""), idc = String(form.idc_name || "");
  if (!validInicisUrl(reqUrl, idc)) return fail("승인 주소를 확인할 수 없습니다", JSON.stringify(form));
  let res;
  try { res = parseNvp(await postForm(reqUrl, { P_MID: cfg.mid, P_TID: String(form.P_TID || "") }, env)); }
  catch (e) { console.error("inicis-mobile-auth", e && e.message); return fail("승인 요청 중 오류가 생겼습니다"); }
  const okCode = String(res.P_STATUS) === "00";
  const amountOk = String(res.P_AMT) === String(order.amount) && String(res.P_OID) === oid;
  if (!okCode || !amountOk) return fail(okCode ? "결제 금액이 주문과 달라 확인이 필요합니다. 문의해 주세요" : (res.P_RMESG1 || "결제 승인에 실패했습니다"), JSON.stringify(res));
  const method = String(res.P_TYPE || ""), card = String(res.P_FN_NM || "");
  await env.DB.prepare(
    `UPDATE orders SET status = 'paid', tid = ?1, pg_method = ?2, card_name = ?3, card_num = ?4, paid_at = datetime('now', '+9 hours'), pg_raw = ?5, fail_msg = NULL WHERE oid = ?6`
  ).bind(String(res.P_TID || ""), method === "CARD" ? "Card" : method === "BANK" ? "DirectBank" : method, card, String(res.P_CARD_NUM || ""), JSON.stringify(res).slice(0, 4000), oid).run();
  await notify(env, `[소셜팩토리 결제 완료 ${oid}] ${order.product_name} ${Number(order.amount).toLocaleString("ko-KR")}원 · ${PAY_METHOD[method === "CARD" ? "Card" : method] || method} · ${order.buyer_name} ${order.buyer_phone}` + (order.start_date ? ` · 시작일 ${order.start_date}` : "") + (order.test_mode ? " (테스트)" : ""));
  return done();
}
export function onRequestGet({ request }) { return redirect(new URL(request.url).origin + "/shop"); }
