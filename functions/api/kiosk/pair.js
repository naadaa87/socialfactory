/**
 * POST /api/kiosk/pair { code, serialNumber } — 프론트 단말기 연결
 * 관리자 화면(고객 · 이용권 → 단말기)에서 만든 8자리 연결 코드를 프론트에 입력하면 단말기 토큰을 한 번만 돌려줍니다.
 * 틀린 코드를 여러 번 넣으면 15분 동안 막습니다.
 */
import { json, clean, ipHashOf, logEvent, countEvents } from "../../_lib/auth.js";
import { ensureSchema } from "../../_lib/admin.js";
import { newDeviceToken, deviceTokenHash, pairCodeHash } from "../../_lib/kiosk.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  await ensureSchema(env);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const code = clean(b && b.code, 20).toUpperCase().replace(/[^0-9A-Z]/g, "");
  const serial = clean(b && b.serialNumber, 60);
  const ipHash = await ipHashOf(request, env);
  if ((await countEvents(env, "kiosk_pair_fail", "ip", ipHash, 15)) >= 8) return json({ ok: false, error: "too-many" }, 429);
  if (code.length !== 8) return json({ ok: false, error: "invalid" }, 400);

  const dev = await env.DB.prepare("SELECT id, name FROM kiosk_devices WHERE pair_hash = ?1 AND status = 'pairing' AND pair_expires_at > datetime('now', '+9 hours')").bind(await pairCodeHash(code)).first();
  if (!dev) { await logEvent(env, "kiosk_pair_fail", "", ipHash); return json({ ok: false, error: "bad-code" }, 400); }

  const token = newDeviceToken();
  const res = await env.DB.prepare(
    "UPDATE kiosk_devices SET status = 'active', token_hash = ?1, pair_hash = NULL, pair_expires_at = NULL, serial = ?2, paired_at = datetime('now', '+9 hours'), last_seen_at = datetime('now', '+9 hours') WHERE id = ?3 AND status = 'pairing'"
  ).bind(await deviceTokenHash(token), serial, dev.id).run();
  if (!res.meta || !res.meta.changes) return json({ ok: false, error: "bad-code" }, 400);
  return json({ ok: true, token, device: { id: dev.id, name: dev.name } });
}
