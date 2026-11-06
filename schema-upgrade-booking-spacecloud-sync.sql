-- Own Spacecloud worker: durable jobs, receipts and occupancy guards.
CREATE TABLE IF NOT EXISTS spacecloud_blocks (
    code TEXT PRIMARY KEY, room TEXT NOT NULL, date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
    marker TEXT NOT NULL UNIQUE, access_token TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','blocking','blocked','releasing','released','review','conflict')),
    cancel_requested INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, verified_at INTEGER,
    error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS spacecloud_sync_jobs (
    id TEXT PRIMARY KEY, booking_code TEXT NOT NULL, room TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('block','verify','release')),
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','succeeded','conflict','review','cancelled')),
    lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_active_job ON spacecloud_sync_jobs (booking_code,action) WHERE state IN ('queued','leased');

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_room_lease ON spacecloud_sync_jobs (room) WHERE state='leased';

CREATE INDEX IF NOT EXISTS idx_sc_jobs_state ON spacecloud_sync_jobs (state,created_at);

CREATE TABLE IF NOT EXISTS spacecloud_worker_calendar (
    room TEXT NOT NULL, date TEXT NOT NULL, events_json TEXT NOT NULL, checked_at INTEGER NOT NULL,
    PRIMARY KEY(room,date)
  );

CREATE TRIGGER IF NOT EXISTS sc_booking_hold_insert
    BEFORE INSERT ON booking_requests WHEN NEW.status IN ('requested','awaiting_payment','confirmed','payment_review')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND b.room=NEW.room AND b.state IN ('pending','blocking','blocked','releasing','review') AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
      THEN RAISE(ABORT,'booking-conflict') END; END;

CREATE TRIGGER IF NOT EXISTS sc_booking_hold_update
    BEFORE UPDATE ON booking_requests WHEN NEW.status IN ('requested','awaiting_payment','confirmed','payment_review')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND b.room=NEW.room AND b.state IN ('pending','blocking','blocked','releasing','review') AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
      THEN RAISE(ABORT,'booking-conflict') END; END;

CREATE TRIGGER IF NOT EXISTS sc_reservation_hold_insert
    BEFORE INSERT ON reservations WHEN NEW.status='confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND b.room=NEW.space AND b.state IN ('pending','blocking','blocked','releasing','review') AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
      THEN RAISE(ABORT,'booking-conflict') END; END;

CREATE TRIGGER IF NOT EXISTS sc_reservation_hold_update
    BEFORE UPDATE ON reservations WHEN NEW.status='confirmed' AND NEW.space IN ('r1','r2','r3','r4','r5')
    BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM spacecloud_blocks b WHERE b.code <> NEW.code
      AND b.room=NEW.space AND b.state IN ('pending','blocking','blocked','releasing','review') AND (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.start_min) < (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.end_min) AND (CAST(strftime('%s', NEW.date) AS INTEGER) / 60 + NEW.start_min) < (CAST(strftime('%s', b.date) AS INTEGER) / 60 + b.end_min))
      THEN RAISE(ABORT,'booking-conflict') END; END;

CREATE TABLE IF NOT EXISTS spacecloud_payment_checks (code TEXT PRIMARY KEY, after_ms INTEGER NOT NULL);
