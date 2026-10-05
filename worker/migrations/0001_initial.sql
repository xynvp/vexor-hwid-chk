PRAGMA foreign_keys = ON;
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE verification_sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','reset_marked','completed','mismatch','expired','cancelled')),
  vexor_username TEXT NOT NULL,
  vexor_uid TEXT NOT NULL,
  license_suffix TEXT NOT NULL,
  old_hwid_preview TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  current_hwid TEXT,
  current_hwid_preview TEXT,
  expected_hwid TEXT,
  expected_hwid_preview TEXT,
  claimed_hwid_preview TEXT,
  machine_guid_fingerprint TEXT,
  volume_serial_fingerprint TEXT,
  computer_name_fingerprint TEXT,
  machine_guid_changed INTEGER NOT NULL DEFAULT 0,
  volume_serial_changed INTEGER NOT NULL DEFAULT 0,
  computer_name_changed INTEGER NOT NULL DEFAULT 0,
  identity_changed_after_reset INTEGER NOT NULL DEFAULT 0,
  windows_install_date INTEGER,
  windows_product TEXT,
  windows_version TEXT,
  windows_build TEXT,
  checker_version TEXT,
  checker_token_hash TEXT UNIQUE,
  checker_online INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  first_connected_at INTEGER,
  last_seen_at INTEGER,
  reset_at INTEGER,
  verified_at INTEGER,
  completed_at INTEGER,
  created_by_admin_id TEXT NOT NULL REFERENCES admins(id),
  revision INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT
);
CREATE INDEX verification_status_expiry ON verification_sessions(status, expires_at);
CREATE INDEX admin_expiry ON admin_sessions(expires_at);
CREATE TABLE verification_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES verification_sessions(id),
  server_timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX event_session_time ON verification_events(session_id, server_timestamp);
CREATE TRIGGER immutable_event_update BEFORE UPDATE ON verification_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON verification_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_at INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
