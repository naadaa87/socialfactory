/**
 * POST /api/kiosk/lookup { phone } — 프론트 '남은 시간 확인' (단말기 토큰 필요)
 * 이용권 만료 시각만 알려 주고 이름 · 결제 내역은 보여 주지 않습니다.
 */
import { json, clean, phoneDigits } from "../../_lib/auth.js";
import { kstNow } from "../../_lib/admin.js";
import { deviceGate, validMobile, maskPhone, kTime } from "../../_lib/kiosk.js";

export async function onRequestPost({ request, env }) {
  const { deny } = await deviceGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const phone = clean(b && b.phone, 20);
  if (!validMobile(phone)) return json({ ok: false, error: "invalid", field: "phone" }, 400);
  const now = kstNow();
  const r = await env.DB.prepare(
    `SELECT MIN(p.starts_at) AS s, MAX(p.ends_at) AS e FROM passes p JOIN customers c ON c.id = p.customer_id
     WHERE c.phone = ?1 AND p.pass_group = 'seat' AND p.status = 'active' AND p.ends_at > ?2`
  ).bind(phoneDigits(phone), now).first();
  const active = !!(r && r.e);
  return json({ ok: true, phoneMasked: maskPhone(phone), active, endsAt: active ? r.e : null, endsText: active ? kTime(r.e) : "", startsLater: active && r.s > now });
}
