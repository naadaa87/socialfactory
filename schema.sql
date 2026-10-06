-- 소셜팩토리 문의 저장 테이블 (Cloudflare D1)
-- Cloudflare 대시보드 → Workers & Pages → D1 → 데이터베이스 생성 후 Console 탭에 아래 내용을 붙여 넣고 실행합니다.
-- 그다음 Pages 프로젝트 → Settings → Bindings → D1 database 에 변수 이름 "DB" 로 연결합니다.

CREATE TABLE IF NOT EXISTS inquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now', '+9 hours')),
  name       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  email      TEXT,
  type       TEXT,
  when_text  TEXT,
  people     TEXT,
  message    TEXT    NOT NULL,
  page       TEXT,
  ua         TEXT,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS idx_inquiries_created ON inquiries (created_at DESC);
