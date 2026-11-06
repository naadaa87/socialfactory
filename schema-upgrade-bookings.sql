-- 방별 온라인 예약 신청 및 원자적 중복 방지. API 첫 이용 때도 자동 준비됩니다.

CREATE TABLE IF NOT EXISTS booking_requests (
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
    paid_at TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, memo TEXT,
    CHECK(start_min >= 0 AND start_min < 1440 AND start_min % 30 = 0),
    CHECK(end_min > start_min AND end_min - start_min BETWEEN 120 AND 1440 AND end_min % 30 = 0),
    CHECK(people > 0 AND amount >= 0)
  );

CREATE INDEX IF NOT EXISTS idx_booking_date ON booking_requests (date, room, status);

CREATE INDEX IF NOT EXISTS idx_booking_created ON booking_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_ip ON booking_requests (ip_hash, created_at);

CREATE TRIGGER IF NOT EXISTS booking_guard_insert
    BEFORE INSERT ON booking_requests WHEN (NEW.status IN ('awaiting_payment', 'confirmed') OR (NEW.status = 'requested' AND NEW.expires_at > datetime('now', '+9 hours')))
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.room AND (b.status IN ('awaiting_payment', 'confirmed') OR (b.status = 'requested' AND b.expires_at > datetime('now', '+9 hours'))) AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.status = 'confirmed'
        AND r.code <> NEW.code AND r.space = NEW.room AND (CAST(strftime('%s', r.date) AS INTEGER) / 60 + r.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', r.date) AS INTEGER) / 60 + r.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
    END;

CREATE TRIGGER IF NOT EXISTS booking_guard_update
    BEFORE UPDATE ON booking_requests WHEN (NEW.status IN ('awaiting_payment', 'confirmed') OR (NEW.status = 'requested' AND NEW.expires_at > datetime('now', '+9 hours')))
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.room AND (b.status IN ('awaiting_payment', 'confirmed') OR (b.status = 'requested' AND b.expires_at > datetime('now', '+9 hours'))) AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM reservations r WHERE r.status = 'confirmed'
        AND r.code <> NEW.code AND r.space = NEW.room AND (CAST(strftime('%s', r.date) AS INTEGER) / 60 + r.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', r.date) AS INTEGER) / 60 + r.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
    END;

CREATE TRIGGER IF NOT EXISTS reservation_booking_guard_insert
    BEFORE INSERT ON reservations WHEN NEW.status = 'confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.space AND (b.status IN ('awaiting_payment', 'confirmed') OR (b.status = 'requested' AND b.expires_at > datetime('now', '+9 hours'))) AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
    END;

CREATE TRIGGER IF NOT EXISTS reservation_booking_guard_update
    BEFORE UPDATE ON reservations WHEN NEW.status = 'confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM booking_requests b WHERE b.code <> NEW.code
        AND b.room = NEW.space AND (b.status IN ('awaiting_payment', 'confirmed') OR (b.status = 'requested' AND b.expires_at > datetime('now', '+9 hours'))) AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
        THEN RAISE(ABORT, 'booking-conflict') END;
    END;
