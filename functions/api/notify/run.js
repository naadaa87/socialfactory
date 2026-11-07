import {runBookingNotifications} from '../../_lib/booking-notify.js';
import {runParkingQueue} from '../../_lib/parking-notify.js';
import {ensureParking,syncParkingOrder} from '../../_lib/parking.js';
/**
 * POST /api/notify/run — 알림 대기열에서 보낼 때가 된 알림을 보냅니다.
 * - 5분마다 도는 Cloudflare Worker(workers/notify-cron)가 X-Cron-Key: CRON_KEY 헤더로 부릅니다.
 * - 관리자 화면의 '지금 보내기' 버튼도 같은 주소를 씁니다 (관리자 로그인).
 */
import { json, safeEqual } from "../../_lib/auth.js";
import { adminOk, ensureSchema } from "../../_lib/admin.js";
import {cleanupGuest} from "../../_lib/guest-orders.js";
import { runQueue } from "../../_lib/notify.js";

export async function onRequestPost({ request, env }) {
  const key = request.headers.get("x-cron-key") || "";
  const byCron = !!env.CRON_KEY && key.length > 0 && safeEqual(key, env.CRON_KEY);
  if (!byCron && !(await adminOk(request, env))) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  await ensureSchema(env);
  await cleanupGuest(env).catch(()=>{});
  await ensureParking(env);
  // 누락 여부는 차량마다 검사하고, 같은 통합 결제는 한 번만 복구합니다.
  const {results}=await env.DB.prepare("SELECT p.payment_oid AS oid FROM parking_orders p JOIN orders o ON o.oid=p.payment_oid JOIN payapp_payments pg ON pg.oid=p.payment_oid WHERE (o.status='paid' AND pg.refunded_amount=0 AND NOT EXISTS(SELECT 1 FROM parking_events e WHERE e.oid=p.oid AND e.kind='paid')) OR (pg.refunded_amount>0 AND (p.vehicle_price=o.amount OR pg.refunded_amount>=o.amount) AND NOT EXISTS(SELECT 1 FROM parking_events e WHERE e.oid=p.oid AND e.kind='refund' AND e.refund_amount=pg.refunded_amount)) GROUP BY p.payment_oid ORDER BY MIN(p.created_at) LIMIT 100").all();
  for(const p of results)await syncParkingOrder(env,p.oid);
  const normal=await runQueue(env, { limit: 50 });
  const booking=await runBookingNotifications(env).catch(()=>{
    console.error('booking-notifications: queue unavailable');
    return {error:'queue-unavailable'};
  });
  return json({...normal,parking:await runParkingQueue(env),booking});
}
