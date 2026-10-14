-- 소셜팩토리 회원 표 추가 (문의 표 inquiries 를 이미 만들어 쓰고 있는 경우에만 실행 · 주문 표는 schema-upgrade-orders.sql)
-- D1 데이터베이스의 Console 탭에 이 파일 내용 전체를 붙여 넣고 실행합니다. 기존 문의는 그대로 남습니다.
-- "duplicate column name: member_id" 오류가 나오면 이미 추가된 것이니 무시하고, 첫 줄을 지운 뒤 나머지만 다시 실행하면 됩니다.

ALTER TABLE inquiries ADD COLUMN member_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_inquiries_member ON inquiries (member_id);

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
