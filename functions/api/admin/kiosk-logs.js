/** 관리자 전용 토스프론트 오류 기록. */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const key = clean(new URL(request.url).searchParams.get("paymentKey") || "", 64);
  try {
    const { results } = await env.DB.prepare(
      "SELECT l.event_id, l.payment_key, l.kind, l.code, l.http_status, l.created_at, d.name AS device_name FROM kiosk_error_logs l LEFT JOIN kiosk_devices d ON d.id = l.device_id" +
      (key ? " WHERE l.payment_key = ?1" : "") + " ORDER BY l.created_at DESC LIMIT 100"
    ).bind(...(key ? [key] : [])).all();
    return json({ ok: true, results });
  } catch (e) {
    console.error("admin-kiosk-logs", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
