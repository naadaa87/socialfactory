-- 소셜팩토리 문의 · 회원 · 주문 저장 테이블 (Cloudflare D1)
-- 처음 설정할 때: Cloudflare 대시보드 → Storage & databases → D1 SQL database → 데이터베이스 만들기
--   → 만든 데이터베이스의 Console 탭에 이 파일 내용 전체를 붙여 넣고 실행합니다.
-- 그다음 Pages 프로젝트 → Settings → Bindings → Add → D1 database 에 변수 이름 "DB" 로 연결하고 다시 배포합니다.
-- ※ 이미 표를 만들어 쓰고 있었다면 이 파일 대신 schema-upgrade-members.sql(회원) · schema-upgrade-orders.sql(주문) 을 실행합니다.
-- ※ 관리자 예약 · 매출 표(reservations · admin_sessions)는 관리자 화면(/admin)에 처음 로그인할 때 자동으로 만들어집니다.
--    직접 만들고 싶다면 schema-upgrade-reservations.sql 을 실행해도 됩니다. (이미 있으면 아무 일도 일어나지 않음)

CREATE TABLE IF NOT EXISTS inquiries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt        TEXT    NOT NULL UNIQUE,                            -- 접수번호 (고객에게 보여 주는 값, 예: SF-261009-7K3Q)
  submission_id  TEXT    NOT NULL UNIQUE,                            -- 중복 제출 방지용 (브라우저가 만든 고유값)
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  status         TEXT    NOT NULL DEFAULT 'new',                     -- new | in_progress | done
  purpose        TEXT    NOT NULL,                                   -- rental | regular | business | coworking | office | partner | proposal | other
  space          TEXT,                                               -- r1~r5 | coworking | office | undecided
  name           TEXT    NOT NULL,
  phone          TEXT    NOT NULL,
  email          TEXT,
  company        TEXT,
  when_text      TEXT,
  people         TEXT,
  schedule       TEXT,                                               -- 정기대관: 요일·주기·기간
  message        TEXT    NOT NULL,
  consent        INTEGER NOT NULL DEFAULT 0,                         -- 개인정보 수집·이용 동의 (1)
  notice_version TEXT,                                               -- 동의 당시 안내문 버전
  page           TEXT,
  ip_hash        TEXT,                                               -- 접속 IP의 해시 일부 (스팸·중복 방지용, 원본 IP는 저장하지 않음)
  notify_status  TEXT,                                               -- 운영자 알림 전송 결과 (sent | failed:... | skipped)
  member_id      INTEGER                                             -- 로그인한 회원이 보낸 문의면 회원 번호
);

CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_status  ON inquiries (status);
CREATE INDEX IF NOT EXISTS idx_inquiries_iphash  ON inquiries (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_inquiries_member  ON inquiries (member_id);

-- 회원 ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT    NOT NULL DEFAULT 'email',                  -- email (나중에 소셜 로그인을 붙일 때 확장)
  email           TEXT,                                              -- 소문자로 저장 (카카오 회원은 없을 수 있음)
  password_hash   TEXT,                                              -- 이메일 회원만. PBKDF2 해시 (원래 비밀번호는 저장하지 않음)
  kakao_id        TEXT    UNIQUE,                                    -- (예비) 나중에 카카오 로그인을 붙일 때 쓰는 자리
  name            TEXT    NOT NULL,
  phone           TEXT    NOT NULL,
  marketing       INTEGER NOT NULL DEFAULT 0,                        -- 소식 · 혜택 수신 동의 (선택)
  marketing_at    TEXT,                                              -- 수신 동의 · 철회 시각
  terms_version   TEXT,                                              -- 동의한 이용약관 버전
  privacy_version TEXT,                                              -- 동의한 개인정보 안내 버전
  agreed_at       TEXT,
  status          TEXT    NOT NULL DEFAULT 'active',                 -- active | blocked
  must_change_pw  INTEGER NOT NULL DEFAULT 0,                        -- 관리자가 임시 비밀번호를 준 경우 1
  created_at      TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  last_login_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email ON members (email) WHERE provider = 'email';
CREATE INDEX IF NOT EXISTS idx_members_created ON members (created_at DESC);

-- 로그인 유지 (토큰의 해시만 저장)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  member_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions (member_id);

-- 로그인 · 가입 기록 (과다 시도 차단용, 90일 뒤 자동 정리)
CREATE TABLE IF NOT EXISTS auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
  kind        TEXT NOT NULL,                                         -- signup | login_ok | login_fail
  email       TEXT,
  ip_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_events ON auth_events (kind, created_at);

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

-- 관리자 로그인 (쿠키 토큰의 해시만 저장, ADMIN_KEY 를 바꾸면 모두 로그아웃) ---------------
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  key_tag     TEXT NOT NULL,                                         -- 로그인할 때의 ADMIN_KEY 확인값 (키를 바꾸면 무효)
  created_at  TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
  expires_at  TEXT NOT NULL,
  ip_hash     TEXT,
  ua          TEXT
);

-- 예약 (관리자 화면에서 등록 · 결제수단별 매출 집계) ---------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,                            -- 예약번호 (예: R261024-7K3Q, 앞 6자리는 이용일)
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at     TEXT,
  status         TEXT    NOT NULL DEFAULT 'confirmed',               -- confirmed(예약 확정) | cancelled(취소)
  space          TEXT    NOT NULL,                                   -- r1~r5 | coworking | office | other
  space_note     TEXT,                                               -- 기타 공간 이름 등
  date           TEXT    NOT NULL,                                   -- 이용일 (시작 날짜, YYYY-MM-DD)
  start_min      INTEGER NOT NULL,                                   -- 시작 시각: 이용일 0시부터 분 (30분 단위, 14:30 = 870)
  end_min        INTEGER NOT NULL,                                   -- 끝 시각: 1440 이상이면 다음 날 (익일 01:00 = 1500)
  customer_name  TEXT    NOT NULL,
  phone          TEXT,
  people         INTEGER,
  purpose        TEXT,
  channel        TEXT,                                               -- 예약 경로 kakao | phone | web | spacecloud | naver | visit | other
  amount         INTEGER NOT NULL DEFAULT 0,                         -- 받은(받을) 금액 (원, 부가세 포함)
  list_amount    INTEGER,                                            -- 요금표로 계산한 금액 (참고)
  amount_note    TEXT,                                               -- 할인 · 추가 내역
  pay_method     TEXT    NOT NULL,                                   -- bank_blank 계좌이체(블랭크) | bank_other 계좌이체(별도) | spacecloud 스페이스클라우드 | card_offline 카드결제(오프라인) | card_online 카드결제(온라인)
  pay_status     TEXT    NOT NULL DEFAULT 'paid',                    -- paid 결제 완료 | unpaid 결제 전 | refunded 환불
  paid_at        TEXT,                                               -- 결제일 (YYYY-MM-DD)
  refund_amount  INTEGER NOT NULL DEFAULT 0,
  refunded_at    TEXT,
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  inquiry_ref    TEXT,                                               -- 연결한 문의 접수번호
  memo           TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_date   ON reservations (date, space);
CREATE INDEX IF NOT EXISTS idx_res_paid   ON reservations (paid_at);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations (status, pay_status);

-- 토스프론트 이용권 (고객 · 결제 · 이용권 · 알림 대기열 · 단말기) ---------------------------------------
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
  kind            TEXT    NOT NULL,                                  -- purchase(구매 완료) | expire_soon(만료 예정) | renewal(연장 완료) | refund(취소·환불 완료)
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

-- Spacecloud HOST settlement XLSX imports (financial records; calendar occupancy remains separate)
CREATE TABLE IF NOT EXISTS spacecloud_sales (
  reservation_id TEXT PRIMARY KEY,
  use_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  refund_amount INTEGER NOT NULL,
  linked_code TEXT,
  space TEXT NOT NULL,
  sync_seen INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now','+9 hours'))
);

-- Historical occupancy from SpaceCloud iCal or verified HOST completed bookings.
-- Financial amounts stay exclusively in spacecloud_sales.
CREATE TABLE IF NOT EXISTS spacecloud_calendar_history (
  space TEXT NOT NULL,
  uid TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (space, uid)
);
CREATE INDEX IF NOT EXISTS idx_spacecloud_history_reservation ON spacecloud_calendar_history (reservation_id, space);
CREATE INDEX IF NOT EXISTS idx_spacecloud_history_end ON spacecloud_calendar_history (end_ms);

CREATE TABLE IF NOT EXISTS spacecloud_sync_device (
 id INTEGER PRIMARY KEY CHECK(id=1),code_hash TEXT,code_until INTEGER,token_hash TEXT,token_until INTEGER,
 enabled INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER,last_success INTEGER,status TEXT,message TEXT,counts TEXT
);
CREATE TABLE IF NOT EXISTS spacecloud_sync_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,reservation_id TEXT NOT NULL,observed_at INTEGER NOT NULL,
 before_refund INTEGER,after_refund INTEGER,action TEXT NOT NULL,reason TEXT,created_at TEXT DEFAULT (datetime('now','+9 hours'))
);
-- 토스프론트 상품은 관리자에서 관리하고, 결제 당시 조건을 보존합니다.
CREATE TABLE IF NOT EXISTS kiosk_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS kiosk_category_images (
  category_id TEXT PRIMARY KEY,
  data_base64 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);
CREATE TABLE IF NOT EXISTS kiosk_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  list_price INTEGER,
  duration_unit TEXT NOT NULL,
  duration_value INTEGER NOT NULL,
  pass_group TEXT NOT NULL,
  image TEXT NOT NULL,
  short TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS kiosk_payment_terms (
  payment_key TEXT PRIMARY KEY,
  terms TEXT NOT NULL
);
-- 프론트 상품 아이콘: 관리자가 업로드한 작고 메타데이터가 제거된 WebP 이미지.
CREATE TABLE IF NOT EXISTS kiosk_product_images (
  product_id TEXT PRIMARY KEY,
  data_base64 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
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

-- 프론트 화면 구성 (어드민에서 저장, 다음 구매 시작부터 적용)
CREATE TABLE IF NOT EXISTS kiosk_ui_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  category_layout TEXT NOT NULL,
  product_layout TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
