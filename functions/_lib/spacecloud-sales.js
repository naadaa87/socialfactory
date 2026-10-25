// Settlement imports are financial records, separate from room occupancy.
export async function ensureSpacecloudSales(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_sales (
    reservation_id TEXT PRIMARY KEY, use_date TEXT NOT NULL, end_date TEXT NOT NULL,
    paid_at TEXT NOT NULL, amount INTEGER NOT NULL, refund_amount INTEGER NOT NULL,
    linked_code TEXT, space TEXT NOT NULL, sync_seen INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours'))
  )`).run();
}
// A linked manual reservation is counted once, using the imported payment/refund amounts.
export const SALES_SOURCE = `(SELECT code, date, paid_at, amount, refund_amount, pay_method, pay_status, channel, space, start_min, end_min, status
  FROM reservations WHERE code NOT IN (SELECT linked_code FROM spacecloud_sales WHERE linked_code IS NOT NULL)
  UNION ALL SELECT 'SCX-' || reservation_id, use_date, paid_at, amount, refund_amount,
    'spacecloud', CASE WHEN refund_amount > 0 THEN 'refunded' ELSE 'paid' END, 'spacecloud', space, COALESCE((SELECT start_min FROM reservations r WHERE r.code = linked_code),0), COALESCE((SELECT end_min FROM reservations r WHERE r.code = linked_code),0), 'confirmed'
  FROM spacecloud_sales)`;
