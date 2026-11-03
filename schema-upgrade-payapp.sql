

-- 페이앱 주문별 거래 연결 및 중복 취소 통보 방지
CREATE TABLE IF NOT EXISTS payapp_payments (
    oid TEXT PRIMARY KEY REFERENCES orders(oid), mul_no TEXT UNIQUE, nonce TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, payurl TEXT,
    refunded_amount INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
CREATE TABLE IF NOT EXISTS payapp_refunds (
    mul_no TEXT PRIMARY KEY, oid TEXT NOT NULL REFERENCES payapp_payments(oid),
    amount INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
CREATE INDEX IF NOT EXISTS idx_payapp_refunds_oid ON payapp_refunds(oid);
