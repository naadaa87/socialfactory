-- 페이앱 승인 후 청구 및 부분취소 원장 (기존 주문 보존)
CREATE TABLE IF NOT EXISTS booking_payapp_requests (
    code TEXT PRIMARY KEY, kind TEXT NOT NULL, inquiry_id INTEGER, label TEXT NOT NULL,
    amount INTEGER NOT NULL, token TEXT NOT NULL, mul_no TEXT UNIQUE, pay_url TEXT,
    status TEXT NOT NULL DEFAULT 'creating', provider_state TEXT, provider_stamp TEXT,
    paid_at TEXT, accepted_at TEXT, consent_version TEXT, refund_amount INTEGER NOT NULL DEFAULT 0, failure TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')), updated_at TEXT);

CREATE INDEX IF NOT EXISTS idx_booking_payapp_status ON booking_payapp_requests(status, created_at);

CREATE TABLE IF NOT EXISTS booking_payapp_refunds (mul_no TEXT PRIMARY KEY, code TEXT NOT NULL, amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours')));
