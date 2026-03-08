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
  },
  {
    id: "002_prepared_action_preview_and_execution",
    sql: `
ALTER TABLE prepared_action RENAME TO prepared_action_v1;

CREATE TABLE prepared_action (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  confirm_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  operator_note TEXT,
  executed_at INTEGER,
  execution_result_json TEXT,
  error_code TEXT,
  error_message TEXT
);

INSERT INTO prepared_action (
  id,
  action_type,
  target_json,
  payload_json,
  preview_json,
  payload_hash,
  preview_hash,
  status,
  confirm_token_hash,
  expires_at,
  created_at,
  confirmed_at,
  operator_note,
  executed_at,
  execution_result_json,
  error_code,
  error_message
)
SELECT
  id,
  action_type,
  '{}',
  payload_json,
  '{}',
  '',
  '',
  status,
  confirm_token_hash,
  expires_at,
  created_at,
  confirmed_at,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL
FROM prepared_action_v1;

DROP TABLE prepared_action_v1;

CREATE INDEX IF NOT EXISTS prepared_action_status_idx
  ON prepared_action(status, expires_at);

CREATE INDEX IF NOT EXISTS prepared_action_confirm_token_hash_idx
  ON prepared_action(confirm_token_hash);
`
  },
  {
    id: "003_sent_invitation_state",
    sql: `
CREATE TABLE IF NOT EXISTS sent_invitation_state (
  profile_name TEXT NOT NULL,
  profile_url_key TEXT NOT NULL,
  vanity_name TEXT,
  full_name TEXT NOT NULL,
  headline TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  first_seen_sent_at INTEGER NOT NULL,
  last_seen_sent_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_reason TEXT,
  accepted_at INTEGER,
  accepted_detection TEXT,
  followup_prepared_at INTEGER,
  followup_prepared_action_id TEXT,
  followup_confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_name, profile_url_key)
);

CREATE INDEX IF NOT EXISTS sent_invitation_state_profile_last_seen_idx
  ON sent_invitation_state(profile_name, last_seen_sent_at);

CREATE INDEX IF NOT EXISTS sent_invitation_state_profile_accepted_idx
  ON sent_invitation_state(profile_name, accepted_at);

CREATE INDEX IF NOT EXISTS sent_invitation_state_followup_action_idx
  ON sent_invitation_state(followup_prepared_action_id);
`
  }
];
