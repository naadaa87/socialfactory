
-- 비회원 휴대폰 인증과 만료 세션
CREATE TABLE IF NOT EXISTS guest_otp_challenges(id TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,phone TEXT NOT NULL,phone_hash TEXT NOT NULL,code_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending');
CREATE INDEX IF NOT EXISTS idx_guest_otp_phone ON guest_otp_challenges(phone_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_guest_otp_ip ON guest_otp_challenges(ip_hash,created_at);
CREATE TABLE IF NOT EXISTS guest_order_sessions(token_hash TEXT PRIMARY KEY,phone TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
