import { ensureSpacecloudSales, SALES_SOURCE } from "../../_lib/spacecloud-sales.js";
/**
 * GET /api/admin/dashboard — 관리자 첫 화면 '오늘 확인할 것'
 * 오늘 · 내일 예약, 앞으로 7일 예약, 결제 확인이 필요한 예약(결제 전), 답하지 않은 문의, 환불 요청 주문, 이번 달 매출(결제수단별)
 */
import { json } from "../../_lib/auth.js";
import { adminGate, PAY_METHODS, kstToday, addDaysIso } from "../../_lib/admin.js";

import { loadSpacecloud, filterExternal, mergeCalendarRows } from "../../_lib/spacecloud.js";

const RES = "code, status, space, space_note, date, start_min, end_min, customer_name, phone, people, purpose, channel, amount, pay_method, pay_status, paid_at, refund_amount, memo, inquiry_ref";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  await ensureSpacecloudSales(env);
  const today = kstToday(), tomorrow = addDaysIso(today, 1), in7 = addDaysIso(today, 7), ym = today.slice(0, 7);
  const all = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).all()).results || []; } catch (e) { console.error("dash", e && e.message); return []; } };
  const one = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).first()) || {}; } catch (e) { console.error("dash", e && e.message); return {}; } };
  const NET = "MAX(amount - refund_amount, 0)";

  // 전날 밤에 시작해 오늘 새벽까지 이어지는 예약도 '오늘'에 함께 보여 줍니다.
  const external = await loadSpacecloud(env);
  const near = mergeCalendarRows(await all(`SELECT ${RES} FROM reservations WHERE status = 'confirmed' AND date BETWEEN ?1 AND ?2 ORDER BY date, start_min`, addDaysIso(today, -1), in7), filterExternal(external.results, new URLSearchParams({ from: addDaysIso(today, -1), to: in7 })));
  const todayList = near.filter((r) => r.date === today || (r.date === addDaysIso(today, -1) && r.end_min > 1440));
  const tomorrowList = near.filter((r) => r.date === tomorrow);
  const upcoming = near.filter((r) => r.date > tomorrow);
  const unpaid = await all(`SELECT ${RES} FROM reservations WHERE status = 'confirmed' AND pay_status = 'unpaid' ORDER BY date, start_min LIMIT 20`);
  const unpaidSum = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM reservations WHERE status = 'confirmed' AND pay_status = 'unpaid'");
  const newInq = await all("SELECT id, receipt, created_at, purpose, space, name, phone, when_text, people FROM inquiries WHERE status = 'new' ORDER BY id ASC LIMIT 12");
  const newInqN = await one("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'");
  const refundReq = await one("SELECT COUNT(*) AS n FROM orders WHERE status = 'refund_requested'");

  const byMethod = {}; Object.keys(PAY_METHODS).forEach((k) => { byMethod[k] = 0; });
  let resTotal = 0, resN = 0;
  for (const r of await all(`SELECT pay_method AS k, COUNT(*) AS n, SUM(${NET}) AS s FROM ${SALES_SOURCE} WHERE pay_status IN ('paid', 'refunded') AND substr(date, 1, 7) = ?1 GROUP BY pay_method`, ym)) {
    if (r.k in byMethod) { byMethod[r.k] = Number(r.s) || 0; resTotal += byMethod[r.k]; resN += Number(r.n) || 0; }
  }
  const ord = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM orders WHERE status IN ('paid', 'used') AND test_mode = 0 AND substr(paid_at, 1, 7) = ?1", ym);
  const byChannel = {};
  for (const r of await all(`SELECT COALESCE(NULLIF(channel,''),'none') AS k, COUNT(*) AS n, SUM(${NET}) AS s FROM ${SALES_SOURCE} WHERE pay_status IN ('paid','refunded') AND substr(date,1,7) = ?1 GROUP BY k`, ym)) {
    byChannel[r.k] = { amount: Number(r.s) || 0, n: Number(r.n) || 0 };
  }
  if (!byChannel.web) byChannel.web = { amount: 0, n: 0 };
  byChannel.web.amount += Number(ord.s) || 0; byChannel.web.n += Number(ord.n) || 0;
  const resMonth = await one("SELECT COUNT(*) AS n, COALESCE(SUM(end_min - start_min), 0) AS mins FROM reservations WHERE status = 'confirmed' AND substr(date, 1, 7) = ?1", ym);
  const ordersRecent = await all("SELECT id, oid, created_at, status, product_name, amount, buyer_name, test_mode, paid_at FROM orders WHERE status <> 'pending' ORDER BY id DESC LIMIT 5");

  return json({
    ok: true, today, tomorrow, spacecloud: external.info,
    counts: { today: todayList.length, tomorrow: tomorrowList.length, upcoming: upcoming.length, unpaid: Number(unpaidSum.n) || 0, unpaidAmount: Number(unpaidSum.s) || 0, newInquiries: Number(newInqN.n) || 0, refundRequests: Number(refundReq.n) || 0 },
    todayList, tomorrowList, upcoming, unpaid, newInquiries: newInq, ordersRecent,
    month: { ym, reservations: resTotal, reservationsN: resN, orders: Number(ord.s) || 0, ordersN: Number(ord.n) || 0, total: resTotal + (Number(ord.s) || 0), byMethod, byChannel, booked: Number(resMonth.n) || 0, bookedMinutes: Number(resMonth.mins) || 0 }
  });
}
