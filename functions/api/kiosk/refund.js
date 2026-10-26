/**
 * POST /api/kiosk/refund — 프론트에서 카드 결제 취소 (단말기 토큰 + 직원 토큰 필요)
 *  { staffToken, paymentKey, stage: "start" }                       → sdk.payment.requestPaymentCancel 에 넣을 값 (승인 때 저장한 값)
 *  { staffToken, paymentKey, stage: "result", type, response }      → 취소 결과 기록. SUCCESS 면 결제를 환불(전액)로, 이용권을 취소로 바꾸고
 *                                                                     뒤에 이어 붙은 이용권은 앞당깁니다. 같은 결과가 여러 번 와도 한 번만 반영됩니다.
 * 플러그인 결제는 토스 POS 에 기록되지 않아 POS 에서 취소할 수 없으므로, 결제한 그 단말기에서 이 기능으로 취소합니다.
 */
import { json, clean } from "../../_lib/auth.js";
import { deviceGate, staffTokenOk, cancelPass } from "../../_lib/kiosk.js";

export async function onRequestPost({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!(await staffTokenOk(env, device.id, b && b.staffToken))) return json({ ok: false, error: "staff-auth", message: "관리 화면에 다시 들어가 주세요." }, 401);
  const pay = await env.DB.prepare("SELECT * FROM pass_payments WHERE payment_key = ?1").bind(clean(b.paymentKey, 64)).first();
  if (!pay) return json({ ok: false, error: "not-found" }, 404);
  if (pay.device_id !== device.id) return json({ ok: false, error: "device-mismatch", message: "결제한 단말기에서만 취소할 수 있어요." }, 403);

  if (b.stage === "start") {
    if (pay.status !== "paid") return json({ ok: false, error: "not-paid", message: "취소할 수 있는 결제가 아니에요." }, 409);
    if (!pay.approval_number || !pay.approved_ts) return json({ ok: false, error: "no-approval", message: "승인 정보가 없어 단말기에서 취소할 수 없어요." }, 409);
    let raw = {}; try { raw = JSON.parse(pay.raw || "{}"); } catch {}
    const params = {
      paymentKey: pay.payment_key, paymentMethod: pay.pay_method, tax: pay.tax, supplyValue: pay.supply, taxExemptValue: 0, tip: 0,
      timestamp: pay.approved_ts, approvalNumber: pay.approval_number, installment: pay.installment || 0
    };
    if (pay.tid) params.tid = pay.tid;
    if (raw.extraData && raw.extraData.vanTransactionManagementId) params.extraData = { vanTransactionManagementId: String(raw.extraData.vanTransactionManagementId) };
    return json({ ok: true, params, amount: pay.amount, productName: pay.product_name });
  }

  if (b.stage === "result") {
    const type = clean(b.type, 12).toUpperCase();
    if (type !== "SUCCESS") return json({ ok: true, status: "unchanged" });            // 취소 안 됨 → 그대로 둡니다
    const r = b.response || {}, d = r.card || r.barcode || {};
    const note = "[프론트 취소 " + (clean(String(d.approvalNumber || ""), 40) || "승인번호 없음") + "]";
    if (pay.status !== "refunded") {
      const pass = await env.DB.prepare("SELECT * FROM passes WHERE payment_id = ?1").bind(pay.id).first();
      if (pass && pass.status !== "cancelled") await cancelPass(env, pass, { refundAmount: pay.amount, rechain: true, refundNote: note, memo: "프론트에서 결제 취소" });
      else await env.DB.prepare("UPDATE pass_payments SET status = 'refunded', refund_amount = amount, refunded_at = datetime('now', '+9 hours'), admin_memo = TRIM(COALESCE(admin_memo, '') || ' ' || ?1), updated_at = datetime('now', '+9 hours') WHERE id = ?2").bind(note, pay.id).run();
    }
    return json({ ok: true, status: "refunded" });
  }
  return json({ ok: false, error: "invalid" }, 400);
}
