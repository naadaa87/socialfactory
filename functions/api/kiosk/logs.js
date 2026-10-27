/** 단말기 오류 로그. 허용한 진단 코드만 기록하며 전화번호·PIN·SDK 응답은 받지 않습니다. */
import { json } from "../../_lib/auth.js";
import { deviceGate } from "../../_lib/kiosk.js";

const KINDS = new Set(["PAYMENT_RESULT_REPORT_FAILED", "PAYMENT_RECOVERY_FAILED", "CANCEL_RECOVERY_FAILED"]);
const SAFE = /^[A-Z0-9_-]{1,40}$/;
const KEY = /^SFK[A-Z0-9]{8,40}$/;

export async function onRequestPost({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  if (Number(request.headers.get("content-length") || 0) > 8192) return json({ ok: false, error: "too-large" }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const events = body && body.events;
  if (!Array.isArray(events) || !events.length || events.length > 10) return json({ ok: false, error: "invalid" }, 400);
  for (const e of events) {
    if (!e || !/^K[a-z0-9]{12,40}$/.test(e.eventId) || !KINDS.has(e.kind) ||
        !KEY.test(e.paymentKey) || !SAFE.test(e.code) ||
        !Number.isInteger(e.httpStatus) || e.httpStatus < 0 || e.httpStatus > 599)
      return json({ ok: false, error: "invalid" }, 400);
  }
  try {
    for (const e of events) {
      const payment = await env.DB.prepare("SELECT id FROM pass_payments WHERE payment_key = ?1 AND device_id = ?2")
        .bind(e.paymentKey, device.id).first();
      if (!payment) return json({ ok: false, error: "unknown-payment" }, 400);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO kiosk_error_logs (event_id, device_id, payment_key, kind, code, http_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      ).bind(e.eventId, device.id, e.paymentKey, e.kind, e.code, e.httpStatus).run();
    }
    return json({ ok: true });
  } catch (e) {
    console.error("kiosk-logs", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
