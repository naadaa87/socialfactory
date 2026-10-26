/**
 * POST /api/notify/run — 알림 대기열에서 보낼 때가 된 알림을 보냅니다.
 * - 5분마다 도는 Cloudflare Worker(workers/notify-cron)가 X-Cron-Key: CRON_KEY 헤더로 부릅니다.
 * - 관리자 화면의 '지금 보내기' 버튼도 같은 주소를 씁니다 (관리자 로그인).
 */
import { json, safeEqual } from "../../_lib/auth.js";
import { adminOk, ensureSchema } from "../../_lib/admin.js";
import { runQueue } from "../../_lib/notify.js";

export async function onRequestPost({ request, env }) {
  const key = request.headers.get("x-cron-key") || "";
  const byCron = !!env.CRON_KEY && key.length > 0 && safeEqual(key, env.CRON_KEY);
  if (!byCron && !(await adminOk(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  await ensureSchema(env);
  return json(await runQueue(env, { limit: 50 }));
}
