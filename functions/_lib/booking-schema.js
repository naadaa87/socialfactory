/* D1의 단일 쓰기 문장 안에서 웹 예약과 관리자 예약의 시간 충돌을 차단합니다. */
const absolute = (alias, field) => `(CAST(strftime('%s', ${alias}.date) AS INTEGER) / 60 + ${alias}.${field})`;
const overlaps = (a, b) => `${absolute(a, 'start_min')} < ${absolute(b, 'end_min')} AND ${absolute(b, 'start_min')} < ${absolute(a, 'end_min')}`;
const active = alias => `(${alias}.status IN ('awaiting_payment', 'confirmed') OR (${alias}.status = 'requested' AND ${alias}.expires_at > datetime('now', '+9 hours')))`;

export const BOOKING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS booking_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')), updated_at TEXT,
    status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','awaiting_payment','confirmed','cancelled','expired','payment_review')),
    room TEXT NOT NULL CHECK(room IN ('r1','r2','r3','r4','r5')), date TEXT NOT NULL,
    start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, people INTEGER NOT NULL,
    customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, company TEXT,
    purpose TEXT NOT NULL, purpose_detail TEXT, requests TEXT, amount INTEGER NOT NULL,
    consent INTEGER NOT NULL, notice_version TEXT NOT NULL, ip_hash TEXT,
    expires_at TEXT, approved_at TEXT, external_checked_at TEXT,
    payment_status TEXT NOT NULL DEFAULT 'unpaid', payment_id TEXT, payment_url TEXT,
    paid_at TEXT, payment_expires_at TEXT, expiry_requested_at TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, memo TEXT,
    CHECK(start_min >= 0 AND start_min < 1440 AND start_min % 30 = 0),
    CHECK(end_min > start_min AND end_min - start_min BETWEEN 120 AND 1440 AND end_min % 30 = 0),
    CHECK(people > 0 AND amount >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_booking_date ON booking_requests (date, room, status)`,
  `CREATE INDEX IF NOT EXISTS idx_booking_created ON booking_requests (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_booking_ip ON booking_requests (ip_hash, created_at)`,
  ...['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER IF NOT EXISTS booking_guard_${action.toLowerCase()}
    BEFORE ${action} ON booking_requests WHEN ${active('NEW')}
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.room AND ${active('b')} AND ${overlaps('b', 'NEW')})
        THEN RAISE(ABORT, 'booking-conflict') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.status = 'confirmed'
        AND r.code <> NEW.code AND r.space = NEW.room AND ${overlaps('r', 'NEW')})
        THEN RAISE(ABORT, 'booking-conflict') END;
    END`),
  ...['INSERT', 'UPDATE'].map(action => `CREATE TRIGGER IF NOT EXISTS reservation_booking_guard_${action.toLowerCase()}
    BEFORE ${action} ON reservations WHEN NEW.status = 'confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.space AND ${active('b')} AND ${overlaps('b', 'NEW')})
        THEN RAISE(ABORT, 'booking-conflict') END;
    END`)
];

const prepared = new WeakMap();
export async function ensureBookingSchema(env) {
  if (!env.DB) throw new Error('no-db');
  if (!prepared.has(env.DB)) {
    const task = (async () => {
      await env.DB.batch(BOOKING_SCHEMA.map(sql => env.DB.prepare(sql)));
      const {results} = await env.DB.prepare('PRAGMA table_info(booking_requests)').all();
      for (const name of ['payment_expires_at','expiry_requested_at']) {
        if (results.some(column => column.name === name)) continue;
        try { await env.DB.prepare('ALTER TABLE booking_requests ADD COLUMN '+name+' TEXT').run(); }
        catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
      }
    })();
    prepared.set(env.DB, task);
    task.catch(() => prepared.delete(env.DB));
  }
  await prepared.get(env.DB);
}

/** 결제 링크를 발행한 요청은 외부 취소 확인 전까지 점유를 해제하지 않습니다. */
export async function expireBookingRequests(env) {
  await env.DB.prepare(`UPDATE booking_requests SET status = 'expired', updated_at = datetime('now', '+9 hours')
    WHERE status = 'requested' AND expires_at <= datetime('now', '+9 hours')`).run();
}
