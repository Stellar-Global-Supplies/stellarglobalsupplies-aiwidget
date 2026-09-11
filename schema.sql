-- Run with: wrangler d1 execute sgs-order-ai-widget-db --file=schema.sql
--
-- No auth on this widget → sessions are keyed by a client-generated UUID
-- (stored in the browser's localStorage), not a real user id.

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,        
  title       TEXT NOT NULL DEFAULT 'New chat',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content     TEXT NOT NULL,
  extracted_json TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- Cleanup is handled by the daily cron in src/index.js (mirrors stellarai's pattern)
