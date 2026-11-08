import { isCalendarLinked } from './spacecloud-links.js';

export const SAME_DAY_REVIEW = '같은 이용일의 기존 스페이스클라우드 매출 확인 필요';

// Settlement imports are financial records, separate from room occupancy.
export async function ensureSpacecloudSales(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_sales (
    reservation_id TEXT PRIMARY KEY, use_date TEXT NOT NULL, end_date TEXT NOT NULL,
    paid_at TEXT NOT NULL, amount INTEGER NOT NULL, refund_amount INTEGER NOT NULL,
    linked_code TEXT, space TEXT NOT NULL, sync_seen INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS reservation_payment_relinks (
    original_code TEXT PRIMARY KEY, replacement_code TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')),
    CHECK(original_code<>replacement_code)
  )`).run();
}

// Calendar links are the only shared key with the host payment report.
export function calendarReservationId(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'partner.spacecloud.kr' || url.port || url.username || url.password || url.search || url.hash) return null;
    return /^\/reservation\/(\d{1,16})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}

// A legacy calendar code may differ from the current code for the same slot.
export function calendarManualSources(manual, events) {
  const byCode = new Map(events.map(event => [event.code, event]));
  const bySlot = new Map();
  const key = row => JSON.stringify([row.space, row.date, row.start_min, row.end_min,
    (row.customer_name || '').normalize('NFC').trim()]);
  for (const event of events) {
    const slot = key(event);
    bySlot.set(slot, bySlot.has(slot) ? null : event);
  }
  const sources = new Map();
  for (const row of manual) {
    const source = byCode.get(row.code) || (isCalendarLinked(row) && bySlot.get(key(row)));
    if (source) sources.set(row.code, source);
  }
  return sources;
}

// Reconcile the payment ledger with original calendar IDs before display
// merging can hide a booking behind another manually entered slot.
export function calendarPaymentGaps(events, manual, imported, year) {
  const byId = new Map(imported.map(payment => [payment.reservation_id, payment]));
  const linked = new Set(imported.map(payment => payment.linked_code).filter(Boolean));
  const paidManual = manual.filter(row => ['paid', 'refunded'].includes(row.pay_status) && !linked.has(row.code));
  const sources = calendarManualSources(paidManual, events);
  const manualIds = new Set([...sources.values()].map(event => calendarReservationId(event.source_url)).filter(Boolean));
  const gaps = new Map();
  for (const event of events) {
    if (!event.date.startsWith(year + '-')) continue;
    const id = calendarReservationId(event.source_url);
    if (!id || manualIds.has(id)) continue;
    const payment = byId.get(id);
    if (payment && event.date >= payment.use_date && event.date <= payment.end_date) continue;
    const current = gaps.get(id);
    if (!current || event.date < current.date) {
      gaps.set(id, { reservation_id:id, date:event.date, space:event.space, date_conflict:!!payment });
    }
  }
  const rows = [...gaps.values()].sort((a,b) => b.date.localeCompare(a.date) || a.reservation_id.localeCompare(b.reservation_id));
  return { count:rows.length, rows:rows.slice(0,20) };
}

// Enrich occupancy rows for display only. Sales aggregation continues to read
// spacecloud_sales once, so multi-room/day calendar rows cannot multiply revenue.
export async function attachCalendarPayments(env, rows) {
  const ids = [...new Set(rows.filter(row => row.external).map(row => calendarReservationId(row.source_url)).filter(Boolean))];
  if (!ids.length) return rows;
  await ensureSpacecloudSales(env);
  const payments = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const found = (await env.DB.prepare(`SELECT reservation_id,use_date,end_date,paid_at,amount,refund_amount FROM spacecloud_sales WHERE reservation_id IN (${chunk.map((_, n) => '?' + (n + 1)).join(',')})`).bind(...chunk).all()).results || [];
    found.forEach(payment => payments.set(payment.reservation_id, payment));
  }
  return rows.map(row => {
    if (!row.external) return row;
    const id = calendarReservationId(row.source_url), payment = payments.get(id);
    if (!payment) return row;
    if (row.date < payment.use_date || row.date > payment.end_date) return { ...row, payment_conflict: true };
    return { ...row, payment: {
      reservation_id: id, amount: payment.amount, refund_amount: payment.refund_amount,
      paid_at: payment.paid_at, use_date: payment.use_date, end_date: payment.end_date
    } };
  });
}
// A linked manual reservation is counted once, using the imported payment/refund amounts.
export const SALES_SOURCE = `(SELECT code, date, paid_at, amount, refund_amount, pay_method, pay_status, channel, space, start_min, end_min, status
  FROM reservations WHERE code NOT IN (SELECT linked_code FROM spacecloud_sales WHERE linked_code IS NOT NULL)
    AND code NOT IN (SELECT original_code FROM reservation_payment_relinks)
  UNION ALL SELECT 'SCX-' || reservation_id, use_date, paid_at, amount, refund_amount,
    'spacecloud', CASE WHEN refund_amount > 0 THEN 'refunded' ELSE 'paid' END, 'spacecloud', space, COALESCE((SELECT start_min FROM reservations r WHERE r.code = linked_code),0), COALESCE((SELECT end_min FROM reservations r WHERE r.code = linked_code),0), 'confirmed'
  FROM spacecloud_sales WHERE linked_code IS NULL OR linked_code NOT IN (SELECT original_code FROM reservation_payment_relinks))`;
