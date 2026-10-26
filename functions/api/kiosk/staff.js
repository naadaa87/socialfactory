/**
 * POST /api/kiosk/staff { pin } — 프론트 '관리' 화면 들어가기 (단말기 토큰 필요)
 * Cloudflare 설정값 KIOSK_STAFF_PIN(숫자 4~8자리)과 맞으면 10분짜리 직원 토큰과
 * 이 단말기에서 최근 30일 안에 결제된 이용권 결제 목록(취소할 수 있는 것)을 돌려줍니다. 틀리면 15분에 5번까지.
 */
import { json, clean, safeEqual, logEvent, countEvents } from "../../_lib/auth.js";
import { deviceGate, makeStaffToken, maskPhone, kTime } from "../../_lib/kiosk.js";

export async function onRequestPost({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  const pinSet = /^\d{4,8}$/.test(String(env.KIOSK_STAFF_PIN || ""));
  if (!pinSet) return json({ ok: false, error: "no-pin", message: "관리 비밀번호(KIOSK_STAFF_PIN)가 설정되지 않았어요." }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const key = "device:" + device.id;
  if ((await countEvents(env, "kiosk_pin_fail", "ip", key, 15)) >= 5) return json({ ok: false, error: "too-many", message: "잠시 뒤 다시 시도해 주세요." }, 429);
  if (!safeEqual(clean(b && b.pin, 12), String(env.KIOSK_STAFF_PIN))) {
    await logEvent(env, "kiosk_pin_fail", "", key);
    return json({ ok: false, error: "bad-pin", message: "비밀번호가 맞지 않아요." }, 403);
  }
  const { results } = await env.DB.prepare(
    `SELECT pp.payment_key, pp.product_name, pp.amount, pp.paid_at, pp.pay_method, c.phone
     FROM pass_payments pp JOIN customers c ON c.id = pp.customer_id
     WHERE pp.device_id = ?1 AND pp.status = 'paid' AND pp.channel = 'toss_front' AND pp.pay_method IN ('CARD', 'BARCODE')
       AND pp.paid_at > datetime('now', '+9 hours', '-30 days')
     ORDER BY pp.id DESC LIMIT 20`
  ).bind(device.id).all();
  return json({
    ok: true, staffToken: await makeStaffToken(env, device.id),
    payments: results.map((r) => ({ paymentKey: r.payment_key, productName: r.product_name, amount: r.amount, paidAt: r.paid_at, paidText: kTime(r.paid_at), phoneMasked: maskPhone(r.phone), method: r.pay_method }))
  });
}
