-- 홈페이지 주문과 고객·이용권 연결
CREATE TABLE IF NOT EXISTS website_order_terms (oid TEXT PRIMARY KEY REFERENCES orders(oid),terms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS website_order_passes (oid TEXT NOT NULL REFERENCES orders(oid),unit INTEGER NOT NULL,payment_key TEXT NOT NULL UNIQUE,redeem_by TEXT,PRIMARY KEY(oid,unit));
