CREATE TABLE IF NOT EXISTS cloud_session (id TEXT PRIMARY KEY, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS cloud_budget (id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL DEFAULT '', month TEXT NOT NULL DEFAULT '',
    day_ms INTEGER NOT NULL DEFAULT 0, month_ms INTEGER NOT NULL DEFAULT 0,last_id TEXT);

INSERT OR IGNORE INTO cloud_budget(id) VALUES(1);

CREATE TABLE IF NOT EXISTS cloud_budget_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL,reserved_ms INTEGER NOT NULL,
    charged_ms INTEGER,started_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved', closed_at INTEGER);

CREATE INDEX IF NOT EXISTS idx_cloud_budget_started ON cloud_budget_reservations(started_at);

CREATE TABLE IF NOT EXISTS cloud_runner_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0);

INSERT OR IGNORE INTO cloud_runner_lock(id) VALUES(1);

CREATE TABLE IF NOT EXISTS cloud_login (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active');

CREATE TABLE IF NOT EXISTS cloud_guest_login (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active');

CREATE TABLE IF NOT EXISTS cloud_browser_runs (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'active');
