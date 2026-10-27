-- 토스프론트 이용권 (고객 · 결제 · 이용권 · 알림 대기열 · 단말기) 표 — Cloudflare D1
-- 관리자 화면(/admin)에 로그인하거나 프론트가 서버에 처음 연결될 때 자동으로 만들어지므로 보통은 실행하지 않아도 됩니다.
-- 직접 만들고 싶다면 D1 콘솔에 이 파일 내용을 붙여 넣고 실행합니다. (이미 있으면 아무 일도 일어나지 않음)

-- 고객: 전화번호(숫자만) 하나가 고객 한 명입니다. 회원 가입과 상관없이 프론트에서 결제하면 생깁니다.
CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  phone             TEXT    NOT NULL UNIQUE,                         -- 01012345678 (숫자만)
  phone_fmt         TEXT,                                            -- 010-1234-5678 (표시용)
  name              TEXT,                                            -- 관리자가 적는 이름 (프론트에서는 받지 않음)
  memo              TEXT,
  member_id         INTEGER,                                         -- (예비) 홈페이지 회원과 연결
  privacy_agreed_at TEXT,                                            -- 프론트에서 개인정보 수집 · 이용 안내에 동의한 마지막 시각
  notify_off        INTEGER NOT NULL DEFAULT 0,                      -- 1 이면 알림톡을 보내지 않음 (고객 요청)
  created_at        TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at        TEXT
);

-- 이용권 결제: 결제 1번 = 1줄. 결제 전에 서버가 만들고(pending) 결제 결과로 상태를 바꿉니다.
CREATE TABLE IF NOT EXISTS pass_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_key     TEXT    NOT NULL UNIQUE,                           -- 토스 SDK paymentKey (서버가 결제마다 새로 만듦, 취소 · 재조회에 씀)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at      TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending',                -- pending | paid | canceled(고객이 결제창 닫음) | timeout | failed | refunded
  channel         TEXT    NOT NULL DEFAULT 'toss_front',             -- toss_front(프론트 무인 결제) | admin(관리자 직접 등록)
  device_id       INTEGER,                                           -- kiosk_devices.id
  customer_id     INTEGER NOT NULL,
  product_id      TEXT    NOT NULL,                                  -- functions/_lib/kiosk-products.js 의 id
  product_name    TEXT    NOT NULL,
  amount          INTEGER NOT NULL,                                  -- 결제 금액 (서버가 상품표로 계산, 부가세 포함)
  tax             INTEGER NOT NULL DEFAULT 0,
  supply          INTEGER NOT NULL DEFAULT 0,
  pay_method      TEXT,                                              -- CARD | CASH | BARCODE (토스 응답) · 관리자 등록은 card_offline 등
  approval_number TEXT,                                              -- 승인번호 (취소할 때 필요)
  approved_ts     INTEGER,                                           -- 승인 시각 (토스 응답 timestamp, 취소할 때 필요)
  tid             TEXT,
  van_key         TEXT,                                              -- VAN 거래 일련번호
  card_issuer     TEXT,
  masked_card     TEXT,
  installment     INTEGER NOT NULL DEFAULT 0,
  paid_at         TEXT,
  fail_reason     TEXT,
  refund_amount   INTEGER NOT NULL DEFAULT 0,
  refunded_at     TEXT,
  admin_memo      TEXT,
  test_mode       INTEGER NOT NULL DEFAULT 0,                        -- 테스트 단말기 · 시험 결제 (매출에서 뺌)
  raw             TEXT                                               -- 토스 응답 원문 (문제 확인용)
);
CREATE INDEX IF NOT EXISTS idx_pp_customer ON pass_payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_pp_status   ON pass_payments (status, paid_at);

-- 이용권: 결제 1건에 1장 (payment_id UNIQUE → 같은 결제 결과가 여러 번 와도 1장만 생김)
CREATE TABLE IF NOT EXISTS passes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,                              -- 이용권 번호 (예: P261020-7K3QX)
  payment_id   INTEGER NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL,
  product_id   TEXT    NOT NULL,
  product_name TEXT    NOT NULL,
  pass_group   TEXT    NOT NULL DEFAULT 'seat',                      -- 같은 그룹끼리 이어 붙음 (좌석 이용권 = seat)
  starts_at    TEXT    NOT NULL,                                     -- 이용 시작 (결제 시각, 이용 중이면 지금 이용권이 끝나는 시각)
  ends_at      TEXT    NOT NULL,                                     -- 이용 만료
  status       TEXT    NOT NULL DEFAULT 'active',                    -- active | cancelled
  source       TEXT,                                                 -- toss_front | admin
  memo         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_passes_customer ON passes (customer_id, pass_group, status, ends_at);
CREATE INDEX IF NOT EXISTS idx_passes_ends     ON passes (status, ends_at);

-- 알림 대기열 (카카오 알림톡): 보낼 시각이 되면 발송기가 꺼내 보냅니다. dedupe_key 로 같은 알림이 두 번 쌓이지 않습니다.
CREATE TABLE IF NOT EXISTS notification_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key      TEXT    NOT NULL UNIQUE,                           -- purchase:이용권번호 · expire:고객:그룹:만료시각:몇분전
  kind            TEXT    NOT NULL,                                  -- purchase(구매 완료) | expire_soon(만료 예정)
  customer_id     INTEGER,
  pass_id         INTEGER,
  pass_group      TEXT,
  phone           TEXT    NOT NULL,
  vars            TEXT,                                              -- 템플릿 변수 (JSON)
  send_after      TEXT    NOT NULL,                                  -- 이 시각 이후에 보냄
  status          TEXT    NOT NULL DEFAULT 'queued',                 -- queued | sending | sent | failed | cancelled | logged(발송 업체 연결 전, 기록만)
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider        TEXT,
  provider_msg_id TEXT,
  rendered        TEXT,                                              -- 실제로 보낸(보낼) 문구
  sent_at         TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due      ON notification_jobs (status, send_after);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON notification_jobs (customer_id);

-- 프론트 단말기: 관리자 화면에서 만든 연결 코드로 한 번 연결하면 토큰(해시만 저장)으로 서버를 부릅니다.
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pairing',                -- pairing(연결 코드 대기) | active | revoked(연결 해제)
  token_hash      TEXT    UNIQUE,
  pair_hash       TEXT,
  pair_expires_at TEXT,
  serial          TEXT,                                              -- 단말기 시리얼 번호 (토스 SDK getSerialNumber)
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  paired_at       TEXT,
  last_seen_at    TEXT
);
-- 토스프론트 장애 진단: 결제 식별자만 저장하고 전화번호/응답 원문은 저장하지 않습니다.
CREATE TABLE IF NOT EXISTS kiosk_error_logs (
  event_id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  payment_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_kiosk_error_logs_time ON kiosk_error_logs (created_at DESC);
