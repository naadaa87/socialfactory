-- 관리자 예약 · 매출 표 추가 (이미 문의 · 회원 · 주문 표를 쓰고 있는 데이터베이스용)
-- 관리자 화면(/admin)에 처음 로그인하면 자동으로 만들어지므로 보통은 실행하지 않아도 됩니다.
-- 직접 만들 때: Cloudflare 대시보드 → D1 → 데이터베이스 → Console 에 이 파일 전체를 붙여 넣고 Run
-- (한 줄만 선택한 채로 실행하면 그 줄만 실행되니, 전체 선택 뒤 실행해 주세요.)

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
