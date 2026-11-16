/**
 * GET /api/admin/kpi?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=use|paid — 본사 관리자 KPI (관리자 로그인 필요)
 *
 * 매출   룸 대관은 기존 '매출' 메뉴와 같은 원본(SALES_SOURCE: 관리자 기록 + 홈페이지 결제 + 스페이스클라우드 정산)에서
 *        결제 완료 · 환불 건의 (금액 − 환불)을 셉니다. basis=use 이용일 기준, basis=paid 결제일 기준.
 *        이용권 · 독립사무실 · 단말기 · 페이앱 직접 결제는 이용일이 따로 없어 항상 결제일 기준입니다.
 * 예약률 1~5번룸 × 24시간 × 기간 일수 중 확정 예약(관리자 기록 + 스페이스클라우드 일정)이 차지한 시간.
 * 이용인원 확정 예약의 기록 인원, 기록이 없으면 그 방 최대 인원의 절반.
 * 취소율 이용일이 기간 안인 예약 중 취소(스페이스클라우드는 전액 환불) 비율.
 * 홈페이지 자체 방문 기록(site_visits · site_clicks — functions/_lib/visits.js).
 * 직전 같은 길이 기간의 주요 수치(prev)를 함께 돌려줍니다.
 */
import { json } from '../../_lib/auth.js';
import { adminGate, kstToday, addDaysIso, CHANNELS } from '../../_lib/admin.js';
import { ensurePayapp, netOrderAmount } from '../../_lib/payapp.js';
import { ensurePayappSales, payappSource } from '../../_lib/payapp-sales.js';
import { ensureSpacecloudSales, SALES_SOURCE, calendarReservationId } from '../../_lib/spacecloud-sales.js';
import { ensureTossSales, TOSS_SOURCE, PASS_SALES_SOURCE } from '../../_lib/toss-sales.js';
import { OFFICE_SALES_FROM } from '../../_lib/booking-payapp.js';
import { mergeCalendarRows } from '../../_lib/spacecloud.js';
import { loadCalendarDisplay } from '../../_lib/spacecloud-display.js';
import { ensureVisitSchema, CLICK_KINDS, REF_TYPES } from '../../_lib/visits.js';
import { ROOMS, ROOM_NAMES, RATES, parsePeriod, bucketKeys, bucketOf, occupancy, peopleOf, bookingKey } from '../../_lib/kpi.js';

const ROOM_IN = "('r1','r2','r3','r4','r5')";
const NET = 'MAX(amount - refund_amount, 0)';
const PAID = "pay_status IN ('paid', 'refunded')";
const CATEGORY_LABELS = { rooms: '룸 대관 (1~5번룸)', space_other: '코워킹 · 사무실 등 기타 예약', orders: '홈페이지 이용권', kiosk: '토스프론트 이용권', office: '독립사무실 (페이앱)', terminal: '토스 일반 단말기', payapp: '페이앱 직접 결제' };

export async function onRequestGet({ request, env, waitUntil }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const period = parsePeriod(new URL(request.url).searchParams, kstToday());
  if (period.error) return json({ ok: false, error: 'invalid', message: period.error }, 400);
  await ensurePayapp(env); await ensurePayappSales(env); await ensureSpacecloudSales(env); await ensureTossSales(env);
  await ensureVisitSchema(env).catch(() => {});
  try {
    const current = await compute(env, period, { waitUntil, full: true });
    const prev = await compute(env, { ...period, from: period.prev.from, to: period.prev.to }, { waitUntil, full: false });
    return json({ ok: true, today: kstToday(), period, rooms: ROOMS.map(k => ({ key: k, name: ROOM_NAMES[k], max: RATES.rooms[k].max })), ...current,
      prev: { from: period.prev.from, to: period.prev.to, summary: prev.summary } });
  } catch (error) {
    console.error('kpi', error?.message);
    return json({ ok: false, error: 'kpi-failed', message: 'KPI를 계산하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, 500);
  }
}

async function compute(env, { from, to, basis, bucket }, { waitUntil, full }) {
  const all = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).all()).results || []; } catch (e) { console.error('kpi-q', e?.message); return []; } };
  const one = async (sql, ...a) => (await all(sql, ...a))[0] || {};
  const n = v => Number(v) || 0;
  const keys = bucketKeys(from, to, bucket), len = bucket === 'day' ? 10 : 7;
  const B = col => `substr(${col}, 1, ${len})`;
  const IN = col => `substr(${col}, 1, 10) BETWEEN ?1 AND ?2`;

  /* ---------- 매출 ---------- */
  const dcol = basis === 'paid' ? 'COALESCE(paid_at, date)' : 'date';
  const blankSeries = () => Object.fromEntries(keys.map(k => [k, Object.fromEntries(ROOMS.concat(Object.keys(CATEGORY_LABELS)).map(x => [x, 0]))]));
  const series = blankSeries();
  const byRoom = Object.fromEntries(ROOMS.map(k => [k, { amount: 0, n: 0, refunds: 0 }]));
  const cats = Object.fromEntries(Object.keys(CATEGORY_LABELS).map(k => [k, { amount: 0, n: 0 }]));
  for (const r of await all(`SELECT space AS k, ${B(dcol)} AS b, COUNT(*) AS c, SUM(${NET}) AS s, SUM(refund_amount) AS rf FROM ${SALES_SOURCE}
      WHERE ${PAID} AND ${IN(dcol)} GROUP BY space, b`, from, to)) {
    const room = ROOMS.includes(r.k), cat = room ? 'rooms' : 'space_other';
    cats[cat].amount += n(r.s); cats[cat].n += n(r.c);
    if (room) { byRoom[r.k].amount += n(r.s); byRoom[r.k].n += n(r.c); byRoom[r.k].refunds += n(r.rf); }
    if (series[r.b]) { series[r.b][cat] += n(r.s); if (room) series[r.b][r.k] += n(r.s); }
  }
  const other = async (cat, sql) => {
    for (const r of await all(sql, from, to)) {
      cats[cat].amount += n(r.s); cats[cat].n += n(r.c);
      if (series[r.b]) series[r.b][cat] += n(r.s);
    }
  };
  await other('orders', `SELECT ${B('paid_at')} AS b, COUNT(*) AS c, SUM(${netOrderAmount}) AS s FROM orders WHERE status IN ('paid','used','refund_requested') AND test_mode = 0 AND paid_at IS NOT NULL AND ${IN('paid_at')} GROUP BY b`);
  await other('kiosk', `SELECT ${B('paid_at')} AS b, COUNT(*) AS c, SUM(MAX(amount - sales_refund, 0)) AS s FROM ${PASS_SALES_SOURCE} WHERE channel <> 'website' AND status IN ('paid','refunded') AND test_mode = 0 AND paid_at IS NOT NULL AND ${IN('paid_at')} GROUP BY b`);
  await other('office', `SELECT ${B('paid_kst')} AS b, COUNT(*) AS c, SUM(MAX(amount - refund_amount, 0)) AS s ${OFFICE_SALES_FROM} AND ${IN('paid_kst')} GROUP BY b`);
  await other('terminal', `SELECT ${B('paid_at')} AS b, COUNT(*) AS c, SUM(amount - refund_amount) AS s FROM ${TOSS_SOURCE} WHERE ${IN('paid_at')} GROUP BY b`);
  let payappFrom = ''; try { payappFrom = payappSource(env); } catch { payappFrom = ''; }
  if (payappFrom) await other('payapp', `SELECT ${B('paid_at')} AS b, COUNT(*) AS c, SUM(amount - refund_amount) AS s FROM ${payappFrom} WHERE ${IN('paid_at')} GROUP BY b`);
  const salesTotal = Object.values(cats).reduce((s, x) => s + x.amount, 0);

  /* ---------- 예약 (예약률 · 인원 · 취소) ---------- */
  const relinked = "code NOT IN (SELECT original_code FROM reservation_payment_relinks)";
  const manual = await all(`SELECT code, status, space, date, start_min, end_min, customer_name, channel, people, refund_amount FROM reservations
    WHERE space IN ${ROOM_IN} AND date BETWEEN ?1 AND ?2 AND ${relinked}`, addDaysIso(from, -1), to);
  let external = { results: [], info: { configured: false } };
  try { external = await loadCalendarDisplay(env, { from: addDaysIso(from, -1), to, waitUntil }); } catch { /* 외부 일정 없이 계산 */ }
  const merged = mergeCalendarRows(manual.filter(r => r.status === 'confirmed'), external.results || [], { info: external.info });
  const occ = occupancy(merged, from, to, bucket);
  const sales = await all(`SELECT reservation_id, use_date, space, amount, refund_amount, linked_code FROM spacecloud_sales WHERE space IN ${ROOM_IN} AND use_date BETWEEN ?1 AND ?2`, from, to);
  const imported = new Set(sales.map(s => s.reservation_id));

  // 예약 건 (시작일 기준) — 인원 · 평균 예약 시간
  const bookings = new Map();
  for (const r of merged) {
    if (!ROOMS.includes(r.space)) continue;
    const key = bookingKey(r), mins = r.external ? r.end_min - r.start_min : Math.max(0, r.end_min - r.start_min);
    const b = bookings.get(key);
    if (b) { b.minutes += mins; if (r.date < b.date) b.date = r.date; continue; }
    bookings.set(key, { space: r.space, date: r.date, minutes: mins, people: r.external ? null : r.people, channel: r.external ? 'spacecloud' : (r.channel || ''), external: !!r.external,
      rid: r.external ? calendarReservationId(r.source_url) : null });
  }
  const calendarIds = new Set([...bookings.values()].map(b => b.rid).filter(Boolean));
  let untimed = 0;
  for (const s of sales) {   // 일정에 없는 스페이스클라우드 정산 건 (시간 정보 없음 — 인원에는 넣고 예약률에서는 빠짐)
    if (s.linked_code || calendarIds.has(s.reservation_id) || (n(s.amount) > 0 && n(s.refund_amount) >= n(s.amount))) continue;
    bookings.set('SCX-' + s.reservation_id, { space: s.space, date: s.use_date, minutes: 0, people: null, channel: 'spacecloud', external: true, untimed: true });
    untimed++;
  }
  const people = { total: 0, recorded: 0, estimated: 0, estimatedBookings: 0, bookings: 0, minutes: 0,
    byRoom: Object.fromEntries(ROOMS.map(k => [k, { people: 0, bookings: 0, estimated: 0, minutes: 0 }])),
    series: Object.fromEntries(keys.map(k => [k, { recorded: 0, estimated: 0, bookings: 0 }])) };
  for (const b of bookings.values()) {
    if (b.date < from || b.date > to) continue;
    const p = peopleOf(b), k = bucketOf(b.date, bucket), room = people.byRoom[b.space];
    people.total += p.n; people.bookings++; people.minutes += b.minutes;
    room.people += p.n; room.bookings++; room.minutes += b.minutes;
    if (p.estimated) { people.estimated += p.n; people.estimatedBookings++; room.estimated += p.n; } else people.recorded += p.n;
    if (people.series[k]) { people.series[k][p.estimated ? 'estimated' : 'recorded'] += p.n; people.series[k].bookings++; }
  }
  people.avg = people.bookings ? people.total / people.bookings : 0;
  people.avgHours = people.bookings - untimed > 0 ? people.minutes / 60 / (people.bookings - untimed) : 0;
  // 정원 대비 평균 인원 (방 최대 인원 대비)
  const cap = [...bookings.values()].filter(b => b.date >= from && b.date <= to);
  people.capacityUse = cap.length ? cap.reduce((s, b) => s + peopleOf(b).n / RATES.rooms[b.space].max, 0) / cap.length * 100 : 0;

  // 취소율 — 관리자 기록(취소 상태) + 스페이스클라우드 정산(전액 환불) + 스페이스클라우드 일정(정산 전 확정 건)
  const cancel = { total: 0, cancelled: 0, refunds: 0, byRoom: Object.fromEntries(ROOMS.map(k => [k, { total: 0, cancelled: 0 }])),
    byChannel: {}, series: Object.fromEntries(keys.map(k => [k, { total: 0, cancelled: 0 }])) };
  const addCancel = (space, date, channel, cancelled, refund) => {
    if (date < from || date > to || !ROOMS.includes(space)) return;
    const k = bucketOf(date, bucket), ch = cancel.byChannel[channel] ||= { label: CHANNELS[channel] || (channel === 'spacecloud' ? '스페이스클라우드' : '경로 미기록'), total: 0, cancelled: 0 };
    cancel.total++; cancel.byRoom[space].total++; ch.total++;
    if (cancel.series[k]) cancel.series[k].total++;
    if (cancelled) { cancel.cancelled++; cancel.byRoom[space].cancelled++; ch.cancelled++; if (cancel.series[k]) cancel.series[k].cancelled++; }
    cancel.refunds += n(refund);
  };
  for (const r of manual) if (r.status === 'confirmed' || r.status === 'cancelled') addCancel(r.space, r.date, r.channel || 'none', r.status === 'cancelled', r.refund_amount);
  for (const s of sales) if (!s.linked_code) addCancel(s.space, s.use_date, 'spacecloud', n(s.amount) > 0 && n(s.refund_amount) >= n(s.amount), s.refund_amount);
  for (const b of bookings.values()) if (b.external && !b.untimed && !(b.rid && imported.has(b.rid))) addCancel(b.space, b.date, 'spacecloud', false, 0);
  cancel.rate = cancel.total ? cancel.cancelled / cancel.total * 100 : 0;
  Object.values(cancel.byRoom).forEach(x => { x.rate = x.total ? x.cancelled / x.total * 100 : 0; });
  Object.values(cancel.byChannel).forEach(x => { x.rate = x.total ? x.cancelled / x.total * 100 : 0; });
  Object.values(cancel.series).forEach(x => { x.rate = x.total ? x.cancelled / x.total * 100 : 0; });

  // 홈페이지 예약 신청 흐름 (신청일 기준)
  const req = await one(`SELECT COUNT(*) AS total, SUM(status='confirmed') AS confirmed, SUM(status='cancelled') AS cancelled, SUM(status='expired') AS expired,
    SUM(status IN ('requested','awaiting_payment','payment_review')) AS pending FROM booking_requests WHERE ${IN('created_at')}`, from, to);
  const web = { requests: n(req.total), confirmed: n(req.confirmed), cancelled: n(req.cancelled), expired: n(req.expired), pending: n(req.pending) };
  web.conversion = web.requests ? web.confirmed / web.requests * 100 : 0;

  /* ---------- 홈페이지 방문 ---------- */
  const visits = await visitStats(env, { from, to, bucket, keys, all, one, n, full });
  const inquiries = n((await one(`SELECT COUNT(*) AS c FROM inquiries WHERE ${IN('created_at')}`, from, to)).c);
  // 견적서 표는 견적서 기능을 쓸 때만 있습니다. 없으면 null (화면에서 생략)
  const hasQuotes = (await all("SELECT name FROM sqlite_master WHERE type='table' AND name='quotes'")).length > 0;
  const quotes = hasQuotes ? n((await one(`SELECT COUNT(*) AS c FROM quotes WHERE source='web' AND ${IN('created_at')}`, from, to)).c) : null;
  visits.funnel = { ...visits.funnel, requests: web.requests, confirmed: web.confirmed, inquiries, quotes };

  const summary = {
    sales: salesTotal, rooms: cats.rooms.amount, occupancy: occ.rate, people: people.total, bookings: people.bookings, cancelRate: cancel.rate,
    visitors: visits.visitors, sessions: visits.sessions, pageviews: visits.pageviews, avgSessionMs: visits.avgSessionMs, requests: web.requests, inquiries
  };
  if (!full) return { summary };
  ROOMS.forEach(k => { byRoom[k].hours = occ.byRoom[k].minutes / 60; byRoom[k].perHour = byRoom[k].hours ? byRoom[k].amount / byRoom[k].hours : 0; byRoom[k].share = cats.rooms.amount ? byRoom[k].amount / cats.rooms.amount * 100 : 0; });
  return {
    summary, buckets: keys,
    sales: { total: salesTotal, categories: Object.entries(cats).map(([key, x]) => ({ key, label: CATEGORY_LABELS[key], ...x, share: salesTotal ? x.amount / salesTotal * 100 : 0 })), byRoom, series },
    occupancy: { ...occ, untimed, calendar: { configured: !!external.info?.configured, error: external.info?.error || null } },
    people, cancel, webBooking: web, visits
  };
}

async function visitStats(env, { from, to, bucket, keys, all, one, n, full }) {
  const len = bucket === 'day' ? 10 : 7, W = 'day BETWEEN ?1 AND ?2';
  const base = await one(`SELECT COUNT(*) AS pv, COUNT(DISTINCT sid) AS sessions FROM site_visits WHERE ${W}`, from, to);
  const visitors = n((await one(`SELECT COUNT(*) AS c FROM (SELECT DISTINCT day, vh FROM site_visits WHERE ${W})`, from, to)).c);
  const sess = await one(`SELECT AVG(ms) AS avg_ms, SUM(pages = 1) AS single, COUNT(*) AS c FROM (SELECT sid, SUM(active_ms) AS ms, COUNT(*) AS pages FROM site_visits WHERE ${W} GROUP BY sid)`, from, to);
  const page = await one(`SELECT AVG(active_ms) AS avg_ms FROM site_visits WHERE ${W} AND active_ms > 0`, from, to);
  const out = { pageviews: n(base.pv), sessions: n(base.sessions), visitors, avgSessionMs: n(sess.avg_ms), avgPageMs: n(page.avg_ms),
    bounceRate: n(sess.c) ? n(sess.single) / n(sess.c) * 100 : 0, pagesPerSession: n(base.sessions) ? n(base.pv) / n(base.sessions) : 0 };
  if (!full) return out;
  out.series = Object.fromEntries(keys.map(k => [k, { pageviews: 0, sessions: 0, visitors: 0 }]));
  for (const r of await all(`SELECT substr(day, 1, ${len}) AS b, COUNT(*) AS pv, COUNT(DISTINCT sid) AS s FROM site_visits WHERE ${W} GROUP BY b`, from, to)) {
    if (out.series[r.b]) { out.series[r.b].pageviews = n(r.pv); out.series[r.b].sessions = n(r.s); }
  }
  for (const r of await all(`SELECT substr(day, 1, ${len}) AS b, COUNT(*) AS v FROM (SELECT DISTINCT day, vh FROM site_visits WHERE ${W}) GROUP BY b`, from, to)) {
    if (out.series[r.b]) out.series[r.b].visitors = n(r.v);
  }
  out.topPages = (await all(`SELECT path, MAX(title) AS title, COUNT(*) AS pv, COUNT(DISTINCT sid) AS sessions, AVG(NULLIF(active_ms, 0)) AS avg_ms, SUM(entry) AS entries, AVG(scroll) AS scroll
    FROM site_visits WHERE ${W} GROUP BY path ORDER BY pv DESC, path LIMIT 12`, from, to)).map(r => ({ path: r.path, title: r.title || '', pageviews: n(r.pv), sessions: n(r.sessions), avgMs: n(r.avg_ms), entries: n(r.entries), scroll: n(r.scroll) }));
  out.sources = (await all(`SELECT ref_type AS k, COUNT(*) AS c FROM site_visits WHERE ${W} AND entry = 1 GROUP BY ref_type ORDER BY c DESC`, from, to))
    .map(r => ({ key: r.k, label: REF_TYPES[r.k] || r.k, sessions: n(r.c) }));
  out.referrers = (await all(`SELECT ref_host AS host, COUNT(*) AS c FROM site_visits WHERE ${W} AND entry = 1 AND ref_host IS NOT NULL AND ref_type NOT IN ('internal') GROUP BY ref_host ORDER BY c DESC LIMIT 8`, from, to))
    .map(r => ({ host: r.host, sessions: n(r.c) }));
  out.campaigns = (await all(`SELECT utm_source AS src, COALESCE(utm_campaign, '') AS campaign, COUNT(*) AS c FROM site_visits WHERE ${W} AND entry = 1 AND utm_source IS NOT NULL GROUP BY src, campaign ORDER BY c DESC LIMIT 8`, from, to))
    .map(r => ({ source: r.src, campaign: r.campaign, sessions: n(r.c) }));
  out.devices = Object.fromEntries((await all(`SELECT device AS k, COUNT(*) AS c FROM site_visits WHERE ${W} AND entry = 1 GROUP BY device`, from, to)).map(r => [r.k, n(r.c)]));
  const clicks = await all(`SELECT kind, COUNT(*) AS c, COUNT(DISTINCT sid) AS s FROM site_clicks WHERE ${W} GROUP BY kind ORDER BY c DESC`, from, to);
  out.clicks = { total: clicks.reduce((s, r) => s + n(r.c), 0), byKind: clicks.map(r => ({ kind: r.kind, label: CLICK_KINDS[r.kind] || r.kind, clicks: n(r.c), sessions: n(r.s) })),
    top: (await all(`SELECT kind, label, target, COUNT(*) AS c FROM site_clicks WHERE ${W} AND kind <> 'internal' GROUP BY kind, label, target ORDER BY c DESC LIMIT 12`, from, to))
      .map(r => ({ kind: r.kind, kindLabel: CLICK_KINDS[r.kind] || r.kind, label: r.label || '', target: r.target || '', clicks: n(r.c) })) };
  const bookingSessions = n((await one(`SELECT COUNT(DISTINCT sid) AS c FROM site_visits WHERE ${W} AND path = '/booking'`, from, to)).c);
  const kakao = n((await one(`SELECT COUNT(DISTINCT sid) AS c FROM site_clicks WHERE ${W} AND kind = 'kakao'`, from, to)).c);
  out.funnel = { sessions: out.sessions, bookingSessions, kakaoSessions: kakao };
  return out;
}
