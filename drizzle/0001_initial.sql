CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  accepting INTEGER NOT NULL DEFAULT 1 CHECK (accepting IN (0, 1)),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (recipient_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_answers ON messages (recipient_id, answered_at DESC, id DESC)
  WHERE answered_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS app_settings (
  name TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rate_limits_expiration ON rate_limits (expires_at);
