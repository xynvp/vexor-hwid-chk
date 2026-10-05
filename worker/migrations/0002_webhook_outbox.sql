CREATE TABLE webhook_outbox (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES verification_sessions(id),
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  failed_at INTEGER
);
CREATE INDEX outbox_pending ON webhook_outbox(delivered_at, failed_at, available_at);
