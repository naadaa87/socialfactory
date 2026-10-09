-- 소셜팩토리 문의 저장 테이블 (Cloudflare D1)
-- Cloudflare 대시보드 → Workers & Pages → D1 → 데이터베이스 생성 후 Console 탭에 아래 내용을 붙여 넣고 실행합니다.
-- 그다음 Pages 프로젝트 → Settings → Bindings → D1 database 에 변수 이름 "DB" 로 연결합니다.

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
  notify_status  TEXT                                                -- 운영자 알림 전송 결과 (sent | failed:... | skipped)
);

CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_status  ON inquiries (status);
CREATE INDEX IF NOT EXISTS idx_inquiries_iphash  ON inquiries (ip_hash, created_at);

-- --------------------------------------------------------------------------
-- 이전 버전(2026-10-06 이전)의 inquiries 테이블을 이미 만들어 둔 경우에만 아래를 실행합니다.
-- (새로 만드는 경우에는 위 CREATE TABLE 만 실행하면 됩니다.)
-- --------------------------------------------------------------------------
-- ALTER TABLE inquiries RENAME TO inquiries_old;
-- (그다음 위 CREATE TABLE 과 CREATE INDEX 를 실행)
-- INSERT INTO inquiries (receipt, submission_id, created_at, purpose, space, name, phone, email, when_text, people, message, page, consent)
--   SELECT 'OLD-' || id, 'old-' || id, created_at, COALESCE(type, 'other'), NULL, name, phone, email, when_text, people, message, page, 0 FROM inquiries_old;
-- DROP TABLE inquiries_old;
