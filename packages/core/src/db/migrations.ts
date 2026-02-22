export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "001_initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prepared_action (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  confirm_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS prepared_action_status_idx
  ON prepared_action(status, expires_at);

CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS run_log_run_id_idx
  ON run_log(run_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS artifact_index_run_id_idx
  ON artifact_index(run_id, created_at);

CREATE TABLE IF NOT EXISTS rate_limit_counter (
  counter_key TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  window_size_ms INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`
  }
];
