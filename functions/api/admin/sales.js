/**
 * GET /api/admin/sales?year=2026&basis=use|paid&orders=1 — 매출 집계 (관리자)
 *
 * - 예약 매출: 결제 완료 · 환불 건의 (금액 − 환불 금액). 결제 전(미수) 건은 매출에 넣지 않고 미수금으로 따로 셉니다.
 *   취소했어도 환불하지 않은 금액(취소 수수료)은 매출로 남습니다.
 * - basis=use  : 이용일 기준 (기본)  · basis=paid : 결제일 기준
 * - orders=1   : 홈페이지에서 KG이니시스로 결제한 이용권 주문도 '이용권 온라인 결제'로 함께 더합니다 (테스트 결제 제외).
 */
import { loadSpacecloud, mergeCalendarRows } from "../../_lib/spacecloud.js";
import { json, clean } from "../../_lib/auth.js";
import { adminGate, PAY_METHODS, SPACES, CHANNELS, kstToday } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const u = new URL(request.url);
  const today = kstToday();
  const year = /^\d{4}$/.test(u.searchParams.get("year") || "") ? u.searchParams.get("year") : today.slice(0, 4);
  const basis = clean(u.searchParams.get("basis") || "", 6) === "paid" ? "paid" : "use";
  const withOrders = u.searchParams.get("orders") !== "0";
  const dcol = basis === "paid" ? "COALESCE(paid_at, date)" : "date";
  const NET = "MAX(amount - refund_amount, 0)";
  const PAID = "pay_status IN ('paid', 'refunded')";
  const all = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).all()).results || []; } catch (e) { console.error("sales", e && e.message); return []; } };
  const one = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).first()) || {}; } catch (e) { console.error("sales", e && e.message); return {}; } };

  const methods = Object.keys(PAY_METHODS).concat(withOrders ? ["orders"] : []);
  const blank = () => { const o = {}; methods.forEach((k) => { o[k] = 0; }); return o; };
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ ym: year + "-" + String(m).padStart(2, "0"), byMethod: blank(), count: blank(), total: 0, n: 0, refunds: 0, unpaid: 0 });
  const byYm = {}; months.forEach((x) => { byYm[x.ym] = x; });

  // 월 · 결제수단별 예약 매출
  for (const r of await all(`SELECT substr(${dcol}, 1, 7) AS ym, pay_method AS k, COUNT(*) AS n, SUM(${NET}) AS s, SUM(refund_amount) AS rf FROM reservations WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY ym, pay_method`, year)) {
    const m = byYm[r.ym]; if (!m || !(r.k in m.byMethod)) continue;
    m.byMethod[r.k] += Number(r.s) || 0; m.count[r.k] += Number(r.n) || 0; m.refunds += Number(r.rf) || 0;
  }
  // 월별 미수금 (결제 전 · 취소 안 한 예약, 이용일 기준)
  for (const r of await all("SELECT substr(date, 1, 7) AS ym, SUM(amount) AS s FROM reservations WHERE pay_status = 'unpaid' AND status = 'confirmed' AND substr(date, 1, 4) = ?1 GROUP BY ym", year)) {
    if (byYm[r.ym]) byYm[r.ym].unpaid = Number(r.s) || 0;
  }
  // 이용권 온라인 결제 (결제일 기준)
  if (withOrders) {
    for (const r of await all("SELECT substr(paid_at, 1, 7) AS ym, COUNT(*) AS n, SUM(amount) AS s FROM orders WHERE status IN ('paid', 'used') AND test_mode = 0 AND paid_at IS NOT NULL AND substr(paid_at, 1, 4) = ?1 GROUP BY ym", year)) {
      const m = byYm[r.ym]; if (!m) continue;
      m.byMethod.orders += Number(r.s) || 0; m.count.orders += Number(r.n) || 0;
    }
  }
  const byMethod = blank(), countBy = blank();
  let total = 0, n = 0, refunds = 0;
  months.forEach((m) => {
    methods.forEach((k) => { m.total += m.byMethod[k]; m.n += m.count[k]; byMethod[k] += m.byMethod[k]; countBy[k] += m.count[k]; });
    total += m.total; n += m.n; refunds += m.refunds;
  });

  // 공간별 · 예약 경로별 (올해, 예약만)
  const bySpace = {}; Object.keys(SPACES).forEach((k) => { bySpace[k] = { amount: 0, n: 0, minutes: 0 }; });
  for (const r of await all(`SELECT space AS k, COUNT(*) AS n, SUM(${NET}) AS s, SUM(end_min - start_min) AS mins FROM reservations WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY space`, year)) {
    if (bySpace[r.k]) bySpace[r.k] = { amount: Number(r.s) || 0, n: Number(r.n) || 0, minutes: Number(r.mins) || 0 };
  }
  const byChannel = {};
  for (const r of await all(`SELECT COALESCE(NULLIF(channel, ''), 'none') AS k, COUNT(*) AS n, SUM(${NET}) AS s FROM reservations WHERE ${PAID} AND substr(${dcol}, 1, 4) = ?1 GROUP BY k`, year)) {
    byChannel[r.k] = { amount: Number(r.s) || 0, n: Number(r.n) || 0, label: CHANNELS[r.k] || "경로 미기록" };
  }

  // 채널 비중의 분모를 총매출과 맞춥니다. 홈페이지 이용권도 홈페이지 채널에 포함합니다.
  if (withOrders) {
    const website = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM orders WHERE status IN ('paid','used') AND test_mode = 0 AND substr(paid_at,1,4) = ?1", year);
    const web = byChannel.web || { amount: 0, n: 0, label: "홈페이지" };
    web.amount += Number(website.s) || 0; web.n += Number(website.n) || 0; web.label = "홈페이지";
    byChannel.web = web;
  }
  Object.values(byChannel).forEach(x => { x.share = total ? x.amount / total * 100 : 0; });

  // 누적(전체 기간) · 미수금 · 이번 달 · 지난달
  const resAll = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(${NET}), 0) AS s FROM reservations WHERE ${PAID}`);
  const ordAll = withOrders ? await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM orders WHERE status IN ('paid', 'used') AND test_mode = 0") : { n: 0, s: 0 };
  const unpaid = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM reservations WHERE pay_status = 'unpaid' AND status = 'confirmed'");
  const monthTotal = async (ym) => {
    const a = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(${NET}), 0) AS s FROM reservations WHERE ${PAID} AND substr(${dcol}, 1, 7) = ?1`, ym);
    const o = withOrders ? await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM orders WHERE status IN ('paid', 'used') AND test_mode = 0 AND substr(paid_at, 1, 7) = ?1", ym) : { n: 0, s: 0 };
    return { ym, total: (Number(a.s) || 0) + (Number(o.s) || 0), n: (Number(a.n) || 0) + (Number(o.n) || 0) };
  };
  const thisYm = today.slice(0, 7);
  const d = new Date(Date.parse(thisYm + "-01T00:00:00Z") - 864e5), lastYm = d.toISOString().slice(0, 7);
  const ys = await all("SELECT DISTINCT substr(date, 1, 4) AS y FROM reservations UNION SELECT DISTINCT substr(paid_at, 1, 4) AS y FROM reservations WHERE paid_at IS NOT NULL UNION SELECT DISTINCT substr(paid_at, 1, 4) AS y FROM orders WHERE paid_at IS NOT NULL AND status IN ('paid', 'used') AND test_mode = 0");
  const years = Array.from(new Set(ys.map((r) => r.y).filter((y) => /^\d{4}$/.test(y || "")).concat([today.slice(0, 4), year]))).sort().reverse();

  const external = await loadSpacecloud(env);
  const recorded = await all("SELECT code, status, channel, space, date, start_min, end_min FROM reservations WHERE channel = 'spacecloud'");
  const missing = mergeCalendarRows(recorded, external.results).filter(x => x.external && x.date.slice(0,4) === year);
  return json({
    ok: true, today, year, basis, withOrders, years,
    methods: methods.map((k) => ({ key: k, label: k === "orders" ? "이용권 온라인 결제" : PAY_METHODS[k] })),
    months, byMethod, countBy, total, n, refunds,
    bySpace, byChannel, channelTotal: total, unrecordedSpacecloud: missing.length, spacecloud: external.info,
    allTime: { total: (Number(resAll.s) || 0) + (Number(ordAll.s) || 0), n: (Number(resAll.n) || 0) + (Number(ordAll.n) || 0) },
    unpaid: { n: Number(unpaid.n) || 0, amount: Number(unpaid.s) || 0 },
    thisMonth: await monthTotal(thisYm), lastMonth: await monthTotal(lastYm)
  });
}
