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
