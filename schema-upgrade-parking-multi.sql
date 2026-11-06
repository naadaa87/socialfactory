-- 기존 1차량 DB 전용. 백업 후 모든 구문을 한 D1 트랜잭션으로 실행합니다.
-- 자동 이관한 DB에는 다시 실행하지 않습니다(스키마 가드가 재실행을 차단합니다).
CREATE TABLE parking_multi_guard(version INTEGER CHECK(version=0));
INSERT INTO parking_multi_guard SELECT COUNT(*) FROM pragma_table_info('parking_orders') WHERE name='payment_oid';
CREATE TABLE parking_orders_multi AS SELECT p.*,p.oid AS payment_oid,o.amount AS vehicle_price FROM parking_orders p JOIN orders o ON o.oid=p.oid;
CREATE TABLE parking_events_multi AS SELECT * FROM parking_events;
DROP TABLE parking_events;
DROP TABLE parking_orders;
CREATE TABLE IF NOT EXISTS parking_orders(oid TEXT PRIMARY KEY,payment_oid TEXT NOT NULL REFERENCES orders(oid),vehicle_price INTEGER NOT NULL CHECK(vehicle_price>0),ticket TEXT NOT NULL,plate TEXT NOT NULL,visit_date TEXT NOT NULL,terms TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',version INTEGER NOT NULL DEFAULT 0,operation_key TEXT,arrival_at TEXT,entry_id TEXT,entry_at TEXT,applied_at TEXT,request_at TEXT,request_reason TEXT,reviewed_at TEXT,memo TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT);
INSERT INTO parking_orders(oid,payment_oid,vehicle_price,ticket,plate,visit_date,terms,status,version,operation_key,arrival_at,entry_id,entry_at,applied_at,request_at,request_reason,reviewed_at,memo,created_at,updated_at) SELECT oid,payment_oid,vehicle_price,ticket,plate,visit_date,terms,status,version,operation_key,arrival_at,entry_id,entry_at,applied_at,request_at,request_reason,reviewed_at,memo,created_at,updated_at FROM parking_orders_multi;
CREATE TABLE IF NOT EXISTS parking_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,oid TEXT NOT NULL REFERENCES parking_orders(oid),kind TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,refund_amount INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,message_id TEXT,last_error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT,sent_at TEXT);
INSERT INTO parking_events SELECT * FROM parking_events_multi;
DROP TABLE parking_events_multi;
DROP TABLE parking_orders_multi;
DROP TABLE parking_multi_guard;
CREATE TABLE IF NOT EXISTS parking_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parking_orders(oid TEXT PRIMARY KEY,payment_oid TEXT NOT NULL REFERENCES orders(oid),vehicle_price INTEGER NOT NULL CHECK(vehicle_price>0),ticket TEXT NOT NULL,plate TEXT NOT NULL,visit_date TEXT NOT NULL,terms TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',version INTEGER NOT NULL DEFAULT 0,operation_key TEXT,arrival_at TEXT,entry_id TEXT,entry_at TEXT,applied_at TEXT,request_at TEXT,request_reason TEXT,reviewed_at TEXT,memo TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_parking_payment ON parking_orders(payment_oid);
CREATE INDEX IF NOT EXISTS idx_parking_queue ON parking_orders(status,visit_date);
CREATE TABLE IF NOT EXISTS parking_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,oid TEXT NOT NULL REFERENCES parking_orders(oid),kind TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,refund_amount INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,message_id TEXT,last_error TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),updated_at TEXT,sent_at TEXT);
CREATE INDEX IF NOT EXISTS idx_parking_events_due ON parking_events(status,id);
CREATE TABLE IF NOT EXISTS parking_history(id INTEGER PRIMARY KEY AUTOINCREMENT,oid TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now','+9 hours')),UNIQUE(oid,version));
