-- 소셜팩토리 문의 · 회원 저장 테이블 (Cloudflare D1)
-- 처음 설정할 때: Cloudflare 대시보드 → Storage & databases → D1 SQL database → 데이터베이스 만들기
--   → 만든 데이터베이스의 Console 탭에 이 파일 내용 전체를 붙여 넣고 실행합니다.
-- 그다음 Pages 프로젝트 → Settings → Bindings → Add → D1 database 에 변수 이름 "DB" 로 연결하고 다시 배포합니다.
-- ※ 문의 표(inquiries)를 이미 만들어 쓰고 있었다면 이 파일 대신 schema-upgrade-members.sql 을 실행합니다.

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
  provider        TEXT    NOT NULL DEFAULT 'email',                  -- email | kakao
  email           TEXT,                                              -- 소문자로 저장 (카카오 회원은 없을 수 있음)
  password_hash   TEXT,                                              -- 이메일 회원만. PBKDF2 해시 (원래 비밀번호는 저장하지 않음)
  kakao_id        TEXT    UNIQUE,                                    -- 카카오 회원번호
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
