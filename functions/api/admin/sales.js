import { netOrderAmount } from "../../_lib/payapp.js";
import { ensureAutomation } from "../../_lib/parking-automation.js";
import {ensurePayappSales,payappSource,payappOnlySummary} from '../../_lib/payapp-sales.js';
import { calendarPaymentGaps, calendarReservationId, ensureSpacecloudSales, SALES_SOURCE } from "../../_lib/spacecloud-sales.js";
/**
 * GET /api/admin/sales?year=2026&basis=use|paid&orders=1 — 매출 집계 (관리자)
 *
 * - 예약 매출: 결제 완료 · 환불 건의 (금액 − 환불 금액). 결제 전(미수) 건은 매출에 넣지 않고 미수금으로 따로 셉니다.
 *   취소했어도 환불하지 않은 금액(취소 수수료)은 매출로 남습니다.
 * - basis=use  : 이용일 기준  · basis=paid : 결제일 기준 (기본)
 * - orders=1   : 홈페이지에서 온라인으로 결제한 주문도 '홈페이지 온라인 결제'로 함께 더합니다 (테스트 결제 제외).
 *               토스프론트 · 관리자 직접 발급 이용권(pass_payments)도 '토스프론트 이용권'으로 함께 더합니다 (결제일 기준, 환불 차감).
 */
import { loadSpacecloudForDisplay, mergeCalendarRows } from "../../_lib/spacecloud.js";
import { json, clean } from "../../_lib/auth.js";
import { adminGate, PAY_METHODS, SPACES, CHANNELS, kstToday } from "../../_lib/admin.js";
import { ensureTossSales, TOSS_SOURCE, PASS_SALES_SOURCE } from "../../_lib/toss-sales.js";
import { OFFICE_SALES_FROM } from '../../_lib/booking-payapp.js';

async function parkingSalesSummary(env, year, thisYm, lastYm) {
  // A payment can cover several vehicles. Count the sale and its refunds once per payment.
  // Until registration confirms the cost, hourly tickets assume the first hour is free.
  const row = await env.DB.prepare(`
    WITH parking_payments AS (
      SELECT substr(o.paid_at, 1, 7) AS ym,
        o.amount - pg.refunded_amount AS sales,
        SUM(CASE
          WHEN pg.refunded_amount > 0 THEN 0
          WHEN p.ticket = 'daily' THEN 10000
          WHEN p.ticket = '24h' THEN 20000
          WHEN p.ticket IN ('1h', '2h', '3h') THEN p.vehicle_price - COALESCE(claim.cost,
            CASE p.ticket WHEN '1h' THEN 0 WHEN '2h' THEN 3000 WHEN '3h' THEN 6000 END)
          ELSE 0
        END) AS margin
      FROM parking_orders p
      JOIN orders o ON o.oid = p.payment_oid
      JOIN payapp_payments pg ON pg.oid = p.payment_oid
      LEFT JOIN parking_automation_claims claim ON claim.oid = p.oid AND p.status = 'applied'
      WHERE o.test_mode = 0 AND o.status IN ('paid', 'used', 'refund_requested')
        AND o.paid_at IS NOT NULL AND o.tid = pg.mul_no
      GROUP BY o.oid
    )
    SELECT COALESCE(SUM(margin), 0) AS allMargin,
      COALESCE(SUM(margin) FILTER (WHERE substr(ym, 1, 4) = ?1), 0) AS annualMargin,
      COALESCE(SUM(margin) FILTER (WHERE ym = ?2), 0) AS thisMonthMargin,
      COALESCE(SUM(margin) FILTER (WHERE ym = ?3), 0) AS lastMonthMargin,
      COALESCE(SUM(sales), 0) AS allSales,
      COALESCE(SUM(sales) FILTER (WHERE substr(ym, 1, 4) = ?1), 0) AS annualSales,
      COALESCE(SUM(sales) FILTER (WHERE ym = ?2), 0) AS thisMonthSales,
      COALESCE(SUM(sales) FILTER (WHERE ym = ?3), 0) AS lastMonthSales
    FROM parking_payments
  `).bind(year, thisYm, lastYm).first();
  return {
    parkingMargin: { allTime: row.allMargin, annual: row.annualMargin, thisMonth: row.thisMonthMargin, lastMonth: row.lastMonthMargin },
    parkingSales: { allTime: row.allSales, annual: row.annualSales, thisMonth: row.thisMonthSales, lastMonth: row.lastMonthSales }
  };
}

async function spacecloudPaymentSummary(env, year) {
  const external = await loadSpacecloudForDisplay(env);
  const [{ results: recorded }, { results: imported }] = await Promise.all([
    env.DB.prepare("SELECT code, status, channel, space, date, start_min, end_min, customer_name, pay_status FROM reservations WHERE channel = 'spacecloud'").all(),
    env.DB.prepare("SELECT reservation_id, use_date, end_date, linked_code FROM spacecloud_sales").all()
  ]);
  const importedIds = new Set(imported.map(x => x.reservation_id));
  const missing = mergeCalendarRows(recorded, external.results).filter(x =>
    x.external && x.date.slice(0, 4) === year && !importedIds.has(calendarReservationId(x.source_url)));
  return {
    unrecordedSpacecloud: missing.length,
    spacecloud: external.info,
    spacecloudPaymentGaps: calendarPaymentGaps(external.results, recorded, imported, year)
  };
}

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const u = new URL(request.url);
  const today = kstToday();
  const year = /^\d{4}$/.test(u.searchParams.get("year") || "") ? u.searchParams.get("year") : today.slice(0, 4);
  const provider=u.searchParams.get('provider')||'all';
  if(!['all','payapp'].includes(provider))return json({ok:false,message:'결제사 필터를 확인해 주세요.'},400);
  await ensureSpacecloudSales(env);
  const part = u.searchParams.get("part");
  if (part === "spacecloud") return json({ ok: true, year, ...await spacecloudPaymentSummary(env, year) });
  await ensureAutomation(env);
  await ensurePayappSales(env);
  await ensureTossSales(env);
  const thisYm = today.slice(0, 7);
  const lastYm = new Date(Date.parse(thisYm + "-01T00:00:00Z") - 864e5).toISOString().slice(0, 7);
  const withOrders = u.searchParams.get("orders") !== "0";
  const parking = provider === "payapp" || withOrders
    ? await parkingSalesSummary(env, year, thisYm, lastYm) : { parkingMargin: null, parkingSales: null };
  if (provider === "payapp") return json({ ...await payappOnlySummary(env, year, today), ...parking });
  const PAYAPP_DIRECT=payappSource(env);
  const basis = clean(u.searchParams.get("basis") || "", 6) === "use" ? "use" : "paid";
  const dcol = basis === "paid" ? "COALESCE(paid_at, date)" : "date";
  const NET = "MAX(amount - refund_amount, 0)";
  const PAID = "pay_status IN ('paid', 'refunded')";
  const all = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).all()).results || []; } catch (e) { console.error("sales", e && e.message); return []; } };
  const one = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).first()) || {}; } catch (e) { console.error("sales", e && e.message); return {}; } };

  const methods = Object.keys(PAY_METHODS).concat(['toss_terminal','payapp_direct'], withOrders ? ["orders", "kiosk", "office_payapp"] : []);
  const KIOSK = `FROM ${PASS_SALES_SOURCE} WHERE channel <> 'website' AND status IN ('paid', 'refunded') AND test_mode = 0 AND paid_at IS NOT NULL`;
  const KNET = "MAX(amount - sales_refund, 0)";
  const ONET = 'MAX(amount-refund_amount,0)',OFFICE=OFFICE_SALES_FROM;
  const blank = () => { const o = {}; methods.forEach((k) => { o[k] = 0; }); return o; };
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ ym: year + "-" + String(m).padStart(2, "0"), byMethod: blank(), count: blank(), total: 0, n: 0, refunds: 0, unpaid: 0 });
  const byYm = {}; months.forEach((x) => { byYm[x.ym] = x; });

  // 월 · 결제수단별 예약 매출
  for (const r of await all(`SELECT substr(${dcol}, 1, 7) AS ym, pay_method AS k, COUNT(*) AS n, SUM(${NET}) AS s, SUM(refund_amount) AS rf FROM ${SALES_SOURCE} WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY ym, pay_method`, year)) {
    const m = byYm[r.ym]; if (!m || !(r.k in m.byMethod)) continue;
    m.byMethod[r.k] += Number(r.s) || 0; m.count[r.k] += Number(r.n) || 0; m.refunds += Number(r.rf) || 0;
  }
  // 월별 미수금 (결제 전 · 취소 안 한 예약, 이용일 기준)
  for (const r of await all(`SELECT substr(date, 1, 7) AS ym, SUM(amount) AS s FROM ${SALES_SOURCE} WHERE pay_status = 'unpaid' AND status = 'confirmed' AND substr(date, 1, 4) = ?1 GROUP BY ym`, year)) {
    if (byYm[r.ym]) byYm[r.ym].unpaid = Number(r.s) || 0;
  }
  // 홈페이지 온라인 결제 (결제일 기준)
  if (withOrders) {
    for (const r of await all(`SELECT substr(paid_at, 1, 7) AS ym, COUNT(*) AS n, SUM(${netOrderAmount}) AS s FROM orders WHERE status IN ('paid', 'used', 'refund_requested') AND test_mode = 0 AND paid_at IS NOT NULL AND substr(paid_at, 1, 4) = ?1 GROUP BY ym`, year)) {
      const m = byYm[r.ym]; if (!m) continue;
      m.byMethod.orders += Number(r.s) || 0; m.count.orders += Number(r.n) || 0;
    }
    for (const r of await all(`SELECT substr(paid_at, 1, 7) AS ym, COUNT(*) AS n, SUM(${KNET}) AS s, SUM(sales_refund) AS rf ${KIOSK} AND substr(paid_at, 1, 4) = ?1 GROUP BY ym`, year)) {
      const m = byYm[r.ym]; if (!m) continue;
      m.byMethod.kiosk += Number(r.s) || 0; m.count.kiosk += Number(r.n) || 0; m.refunds += Number(r.rf) || 0;
    }
    for(const r of await all(`SELECT substr(paid_kst,1,7) ym,COUNT(*) n,SUM(${ONET}) s,SUM(refund_amount) rf ${OFFICE} AND substr(paid_kst,1,4)=?1 GROUP BY ym`,year)){
      const m=byYm[r.ym];if(!m)continue;m.byMethod.office_payapp+=Number(r.s)||0;m.count.office_payapp+=Number(r.n)||0;m.refunds+=Number(r.rf)||0;
    }
  }
  // General terminal sales always remain included, independently of the website/pass checkbox.
  for (const r of await all(`SELECT substr(paid_at,1,7) AS ym,COUNT(*) AS n,SUM(amount-refund_amount) AS s,SUM(refund_amount) AS rf FROM ${TOSS_SOURCE} WHERE substr(paid_at,1,4)=?1 GROUP BY ym`,year)) {
    const m=byYm[r.ym]; if (!m) continue;
    m.byMethod.toss_terminal=Number(r.s)||0; m.count.toss_terminal=Number(r.n)||0; m.refunds+=Number(r.rf)||0;
  }
  const byMethod = blank(), countBy = blank();
  for(const r of await all(`SELECT substr(paid_at,1,7) ym,COUNT(*) n,SUM(amount-refund_amount) s,SUM(refund_amount) rf FROM ${PAYAPP_DIRECT} WHERE substr(paid_at,1,4)=?1 GROUP BY ym`,year)){
    const m=byYm[r.ym];if(!m)continue;m.byMethod.payapp_direct=r.s||0;m.count.payapp_direct=r.n||0;m.refunds+=r.rf||0;
  }
  let total = 0, n = 0, refunds = 0;
  months.forEach((m) => {
    methods.forEach((k) => { m.total += m.byMethod[k]; m.n += m.count[k]; byMethod[k] += m.byMethod[k]; countBy[k] += m.count[k]; });
    total += m.total; n += m.n; refunds += m.refunds;
  });

  // 공간별 · 예약 경로별 (올해, 예약만)
  const bySpace = {}; Object.keys(SPACES).forEach((k) => { bySpace[k] = { amount: 0, n: 0, minutes: 0 }; });
  for (const r of await all(`SELECT space AS k, COUNT(*) AS n, SUM(${NET}) AS s, SUM(end_min - start_min) AS mins FROM ${SALES_SOURCE} WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY space`, year)) {
    if (bySpace[r.k]) bySpace[r.k] = { amount: Number(r.s) || 0, n: Number(r.n) || 0, minutes: Number(r.mins) || 0 };
  }
  if (withOrders) {
    bySpace.office.amount += byMethod.office_payapp;
    bySpace.office.n += countBy.office_payapp;
  }
  const byChannel = {};
  for (const r of await all(`SELECT COALESCE(NULLIF(channel, ''), 'none') AS k, COUNT(*) AS n, SUM(${NET}) AS s FROM ${SALES_SOURCE} WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY k`, year)) {
    byChannel[r.k] = { amount: Number(r.s) || 0, n: Number(r.n) || 0, label: CHANNELS[r.k] || "경로 미기록" };
  }

  // 채널 비중의 분모를 총매출과 맞춥니다. 홈페이지 이용권도 홈페이지 채널에 포함합니다.
  if (withOrders) {
    const web = byChannel.web || { amount: 0, n: 0 };
    byChannel.web = {
      amount: web.amount + byMethod.orders + byMethod.office_payapp,
      n: web.n + countBy.orders + countBy.office_payapp,
      label: "홈페이지"
    };
  }
  byChannel.toss_terminal = { amount: byMethod.toss_terminal, n: countBy.toss_terminal, label: "토스 일반 단말기" };
  if(withOrders) byChannel.kiosk={amount:byMethod.kiosk||0,n:countBy.kiosk||0,label:'토스프론트 이용권'};
  byChannel.payapp_direct={amount:byMethod.payapp_direct||0,n:countBy.payapp_direct||0,label:'페이앱 직접 결제'};
  Object.values(byChannel).forEach(x => { x.share = total ? x.amount / total * 100 : 0; });

  // 각 결제 원장을 한 번씩 읽고, 기간별 결과를 합칩니다.
  const periodTotals = (date, amount, source) => env.DB.prepare(`
    SELECT COALESCE(SUM(${amount}), 0) AS total, COUNT(*) AS n,
      COALESCE(SUM(${amount}) FILTER (WHERE substr(${date}, 1, 7) = ?1), 0) AS thisTotal,
      COUNT(*) FILTER (WHERE substr(${date}, 1, 7) = ?1) AS thisCount,
      COALESCE(SUM(${amount}) FILTER (WHERE substr(${date}, 1, 7) = ?2), 0) AS lastTotal,
      COUNT(*) FILTER (WHERE substr(${date}, 1, 7) = ?2) AS lastCount
    ${source}`).bind(thisYm, lastYm).first();
  const requests = [
    periodTotals(dcol, NET, `FROM ${SALES_SOURCE} WHERE ${PAID}`),
    periodTotals("paid_at", "amount-refund_amount", `FROM ${TOSS_SOURCE}`),
    periodTotals("paid_at", "amount-refund_amount", `FROM ${PAYAPP_DIRECT}`)
  ];
  if (withOrders) requests.push(
    periodTotals("paid_at", netOrderAmount, "FROM orders WHERE status IN ('paid', 'used', 'refund_requested') AND test_mode = 0"),
    periodTotals("paid_at", KNET, KIOSK),
    periodTotals("paid_kst", ONET, OFFICE)
  );
  const totals = { total: 0, n: 0, thisTotal: 0, thisCount: 0, lastTotal: 0, lastCount: 0 };
  for (const row of await Promise.all(requests)) {
    for (const key of Object.keys(totals)) totals[key] += Number(row[key]) || 0;
  }
  const unpaid = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM ${SALES_SOURCE} WHERE pay_status = 'unpaid' AND status = 'confirmed'`);
  const ys = (await all(`SELECT DISTINCT substr(date, 1, 4) AS y FROM ${SALES_SOURCE} UNION SELECT DISTINCT substr(paid_at, 1, 4) AS y FROM ${SALES_SOURCE} WHERE paid_at IS NOT NULL UNION SELECT DISTINCT substr(paid_at, 1, 4) AS y FROM orders WHERE paid_at IS NOT NULL AND status IN ('paid', 'used', 'refund_requested') AND test_mode = 0`))
    .concat(await all(`SELECT DISTINCT substr(paid_at, 1, 4) AS y ${KIOSK}`),await all(`SELECT DISTINCT substr(paid_at,1,4) AS y FROM ${TOSS_SOURCE}`));
  ys.push(...await all(`SELECT DISTINCT substr(paid_at,1,4) y FROM ${PAYAPP_DIRECT}`));
  if(withOrders)ys.push(...await all(`SELECT DISTINCT substr(paid_kst,1,4) y ${OFFICE}`));
  const years = Array.from(new Set(ys.map((r) => r.y).filter((y) => /^\d{4}$/.test(y || "")).concat([today.slice(0, 4), year]))).sort().reverse();

  const calendar = part === "summary" ? {} : await spacecloudPaymentSummary(env, year);
  return json({
    ok: true, today, year, basis, withOrders, years,
    methods: methods.map((k) => ({ key: k, label: k==='office_payapp'?'독립사무실 페이앱':k==='payapp_direct'?'페이앱 직접 결제':k === 'toss_terminal' ? '토스 일반 단말기' : k === "orders" ? "홈페이지 온라인 결제" : k === "kiosk" ? "토스프론트 이용권" : PAY_METHODS[k] })),
    months, byMethod, countBy, total, n, refunds, ...parking,
    bySpace, byChannel, channelTotal: total, ...calendar,
    allTime: { total: Number(totals.total) || 0, n: Number(totals.n) || 0 },
    unpaid: { n: Number(unpaid.n) || 0, amount: Number(unpaid.s) || 0 },
    thisMonth: { ym: thisYm, total: Number(totals.thisTotal) || 0, n: Number(totals.thisCount) || 0 },
    lastMonth: { ym: lastYm, total: Number(totals.lastTotal) || 0, n: Number(totals.lastCount) || 0 }
  });
}
