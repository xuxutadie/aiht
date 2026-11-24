-- 旧 Cloudflare D1 数据结构的合成迁移测试资料。现版 Python 会自动创建 SQLite；不要用此 SQL 安装现版。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL, school TEXT NOT NULL, grade TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','admin')), password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits >= 0),
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0 AND reserved_credits <= credits),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS only_initial_admin ON users(role) WHERE role = 'admin';

-- 完整授权码仅在生成时返回；状态根据used_by推导，已使用的码不可再注册。
CREATE TABLE IF NOT EXISTS authorization_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT UNIQUE NOT NULL, code_hint TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  used_by TEXT UNIQUE REFERENCES users(id), used_at TEXT,
  CHECK ((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS authorization_codes_created_by ON authorization_codes(created_by);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  answers TEXT NOT NULL, step INTEGER NOT NULL CHECK (step BETWEEN 0 AND 6),
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_user ON plans(user_id, updated_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL REFERENCES plans(id),
  request_key TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL,
  snapshot_answers TEXT NOT NULL, snapshot_title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','uncertain','settled')),
  reservation_active INTEGER NOT NULL DEFAULT 1 CHECK (reservation_active IN (0,1)),
  storage_reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_reservation_bytes >= 0),
  error_message TEXT, artwork_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  upstream_request_id TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id,request_key),
  CHECK ((status IN ('queued','running','uncertain') AND reservation_active = 1)
      OR (status IN ('succeeded','failed','settled') AND reservation_active = 0))
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_stale ON jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS artworks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  plan_id TEXT NOT NULL REFERENCES plans(id), title TEXT NOT NULL, image_path TEXT NOT NULL,
  mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, prompt TEXT NOT NULL,
  answers TEXT NOT NULL, description TEXT NOT NULL, reflection TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artworks_user ON artworks(user_id, created_at);

-- 原始图片每768KiB分一片，base64文本每行至多1MiB。
CREATE TABLE IF NOT EXISTS image_objects (
  object_key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  mime TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  encoded_size INTEGER NOT NULL CHECK (encoded_size > 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0), metadata_json TEXT NOT NULL,
  sha256 TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS image_objects_job ON image_objects(job_id);
CREATE TABLE IF NOT EXISTS image_chunks (
  object_key TEXT NOT NULL REFERENCES image_objects(object_key) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0), body_base64 TEXT NOT NULL,
  PRIMARY KEY (object_key,chunk_index)
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, job_id TEXT REFERENCES jobs(id),
  note TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS single_welcome_grant ON ledger(user_id, kind) WHERE kind = 'grant';
CREATE UNIQUE INDEX IF NOT EXISTS single_job_event ON ledger(job_id, kind) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), admin_user_id TEXT NOT NULL REFERENCES users(id),
  consume INTEGER NOT NULL CHECK (consume IN (0,1)), reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(resets_at);
