-- 소셜팩토리 주문 · 결제 표 추가 (문의 · 회원 표를 이미 만들어 쓰고 있는 경우)
-- D1 데이터베이스의 Console 탭에 이 파일 내용 전체를 붙여 넣고 실행합니다. 기존 데이터는 그대로 남습니다.
-- 주문 · 결제 (이용권 온라인 판매, KG이니시스) ------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  oid           TEXT    NOT NULL UNIQUE,                             -- 주문번호 (결제사에도 같은 값 전달)
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  status        TEXT    NOT NULL DEFAULT 'pending',                  -- pending | paid | used | refund_requested | refunded | cancelled | failed
  product_id    TEXT    NOT NULL,                                    -- functions/_lib/products.js 의 id
  product_name  TEXT    NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  amount        INTEGER NOT NULL,                                    -- 결제 금액 (원, 서버에서 계산)
  buyer_name    TEXT    NOT NULL,
  buyer_phone   TEXT    NOT NULL,
  buyer_email   TEXT,
  start_date    TEXT,                                                -- 이용 시작일 · 이용일 (해당 상품만)
  memo          TEXT,                                                -- 구매자 요청사항
  admin_memo    TEXT,                                                -- 운영 메모 (관리 화면)
  pay_method    TEXT,                                                -- 구매자가 고른 수단 card | bank
  pg_method     TEXT,                                                -- 결제사가 알려 준 실제 수단
  card_name     TEXT,
  card_num      TEXT,                                                -- 결제사가 가린 카드번호
  tid           TEXT,                                                -- 결제사 거래번호
  paid_at       TEXT,
  device        TEXT,                                                -- pc | mobile
  member_id     INTEGER,
  ip_hash       TEXT,
  test_mode     INTEGER NOT NULL DEFAULT 0,                          -- 테스트 상점으로 결제한 건
  fail_msg      TEXT,
  pg_raw        TEXT                                                 -- 결제사 응답 원문 (문제 확인용)
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_member  ON orders (member_id);
