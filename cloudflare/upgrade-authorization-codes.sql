-- 仅新增授权码表和索引，可重复执行；保留原有账号、作品、图片、流水及余额。
CREATE TABLE IF NOT EXISTS authorization_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT UNIQUE NOT NULL, code_hint TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  used_by TEXT UNIQUE REFERENCES users(id), used_at TEXT,
  CHECK ((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS authorization_codes_created_by ON authorization_codes(created_by);
