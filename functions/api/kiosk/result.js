/**
 * POST /api/kiosk/result { paymentKey, type, response } — 결제 결과 보고 (단말기 토큰 필요)
 * type: SUCCESS | CANCELED | TIMEOUT | FAILED  (토스 SDK requestPayment / getPayment 결과의 type)
 *
 * - SUCCESS: 결제 준비한 단말기와 같은지, 승인번호가 있는지 확인한 뒤 결제 완료로 바꾸고 이용권을 1장 발급합니다.
 *   같은 결과가 여러 번 와도(재시도 · 응답 유실 후 재조회) 이용권은 1장만 생기고 같은 이용권을 돌려줍니다.
 * - CANCELED · TIMEOUT · FAILED: 아직 결제 대기인 건만 그 상태로 기록합니다. 이용권은 만들지 않습니다.
 */
import { json, clean } from "../../_lib/auth.js";
import { deviceGate, paymentFields, issuePassForPayment, maskPhone, kTime } from "../../_lib/kiosk.js";
import { runQueue } from "../../_lib/notify.js";
import { notify } from "../../_lib/shop.js";

const LOST = { CANCELED: "canceled", TIMEOUT: "timeout", FAILED: "failed" };

export async function onRequestPost({ request, env, waitUntil }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const key = clean(b && b.paymentKey, 64);
  const type = clean(b && b.type, 12).toUpperCase();
  const pay = key ? await env.DB.prepare("SELECT * FROM pass_payments WHERE payment_key = ?1").bind(key).first() : null;
  if (!pay) return json({ ok: false, error: "not-found" }, 404);
  if (pay.device_id !== device.id) return json({ ok: false, error: "device-mismatch" }, 403);

  if (type !== "SUCCESS") {
    if (!LOST[type]) return json({ ok: false, error: "invalid" }, 400);
    await env.DB.prepare("UPDATE pass_payments SET status = ?1, fail_reason = ?2, updated_at = datetime('now', '+9 hours') WHERE id = ?3 AND status = 'pending'")
      .bind(LOST[type], clean(b.message, 200) || null, pay.id).run();
    return json({ ok: true, status: LOST[type] });
  }

  if (pay.status === "refunded") return json({ ok: false, error: "refunded" }, 409);
  const f = paymentFields(b.response);
  if (!f.valid) {
    await env.DB.prepare("UPDATE pass_payments SET fail_reason = ?1, raw = ?2, updated_at = datetime('now', '+9 hours') WHERE id = ?3 AND status <> 'paid'")
      .bind("승인 정보 없음", JSON.stringify(b.response || {}).slice(0, 4000), pay.id).run();
    return json({ ok: false, error: "bad-response" }, 400);
  }

  // 결제 완료로 바꾸기 — 이미 paid 면 아무것도 바뀌지 않습니다 (CANCELED 로 기록된 뒤 늦게 성공이 확인된 경우도 받아 줍니다)
  const upd = await env.DB.prepare(
    `UPDATE pass_payments SET status = 'paid', paid_at = datetime('now', '+9 hours'), updated_at = datetime('now', '+9 hours'),
       pay_method = ?1, approval_number = ?2, approved_ts = ?3, tid = ?4, van_key = ?5, card_issuer = ?6, masked_card = ?7, installment = ?8, raw = ?9, fail_reason = NULL
     WHERE id = ?10 AND status IN ('pending', 'canceled', 'timeout', 'failed')`
  ).bind(f.method, f.approvalNumber, f.approvedTs, f.tid, f.vanKey, f.issuer, f.masked, f.installment, JSON.stringify(b.response).slice(0, 4000), pay.id).run();
  const firstReport = !!(upd.meta && upd.meta.changes);

  const paid = await env.DB.prepare("SELECT * FROM pass_payments WHERE id = ?1").bind(pay.id).first();
  const { pass, created } = await issuePassForPayment(env, paid);
  const c = await env.DB.prepare("SELECT phone FROM customers WHERE id = ?1").bind(paid.customer_id).first();

  if (created) {
    // 구매 완료 알림은 바로 한 번 보내 보고, 실패하면 5분마다 도는 발송기가 다시 보냅니다.
    const after = Promise.all([
      runQueue(env, { limit: 3 }).catch((e) => console.error("notify-run", e && e.message)),
      notify(env, `[소셜팩토리 프론트 결제] ${paid.product_name} ${Number(paid.amount).toLocaleString("ko-KR")}원 · ${maskPhone(c && c.phone)} · ${kTime(pass.starts_at)} ~ ${kTime(pass.ends_at)}` + (paid.test_mode ? " (테스트)" : ""))
    ]);
    if (waitUntil) waitUntil(after); else await after;
  }
  return json({
    ok: true, duplicate: !firstReport,
    pass: { code: pass.code, productName: pass.product_name, startsAt: pass.starts_at, endsAt: pass.ends_at, startsText: kTime(pass.starts_at), endsText: kTime(pass.ends_at) },
    phoneMasked: maskPhone(c && c.phone)
  });
}
