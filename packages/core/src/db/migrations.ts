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
  },
  {
    id: "004_prepared_action_sealed_fields",
    sql: `
ALTER TABLE prepared_action ADD COLUMN sealed_target_json TEXT;
ALTER TABLE prepared_action ADD COLUMN sealed_payload_json TEXT;
`
  },
  {
    id: "005_scheduler_jobs",
    sql: `
CREATE TABLE IF NOT EXISTS scheduler_job (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  lane TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  leased_at INTEGER,
  lease_expires_at INTEGER,
  prepared_action_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_attempt_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scheduler_job_profile_status_schedule_idx
  ON scheduler_job(profile_name, status, scheduled_at);

CREATE INDEX IF NOT EXISTS scheduler_job_status_schedule_idx
  ON scheduler_job(status, scheduled_at);

CREATE INDEX IF NOT EXISTS scheduler_job_lane_schedule_idx
  ON scheduler_job(lane, scheduled_at);

CREATE INDEX IF NOT EXISTS scheduler_job_prepared_action_idx
  ON scheduler_job(prepared_action_id);
`
  },
  {
    id: "006_activity_webhooks",
    sql: `
CREATE TABLE IF NOT EXISTS activity_watch (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_json TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,
  poll_interval_ms INTEGER,
  cron_expression TEXT,
  status TEXT NOT NULL,
  next_poll_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  lease_owner TEXT,
  leased_at INTEGER,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (schedule_kind = 'interval' AND poll_interval_ms IS NOT NULL AND cron_expression IS NULL)
    OR (schedule_kind = 'cron' AND poll_interval_ms IS NULL AND cron_expression IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS activity_watch_profile_status_next_poll_idx
  ON activity_watch(profile_name, status, next_poll_at);

CREATE INDEX IF NOT EXISTS activity_watch_status_next_poll_idx
  ON activity_watch(status, next_poll_at);

CREATE TABLE IF NOT EXISTS activity_entity_state (
  watch_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_emitted_event_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (watch_id, entity_key),
  FOREIGN KEY (watch_id) REFERENCES activity_watch(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS activity_entity_state_watch_type_idx
  ON activity_entity_state(watch_id, entity_type);

CREATE TABLE IF NOT EXISTS activity_event (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (watch_id) REFERENCES activity_watch(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS activity_event_fingerprint_idx
  ON activity_event(fingerprint);

CREATE INDEX IF NOT EXISTS activity_event_watch_created_idx
  ON activity_event(watch_id, created_at);

CREATE INDEX IF NOT EXISTS activity_event_profile_created_idx
  ON activity_event(profile_name, created_at);

CREATE TABLE IF NOT EXISTS webhook_subscription (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  delivery_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 6,
  last_delivered_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (watch_id) REFERENCES activity_watch(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS webhook_subscription_watch_status_idx
  ON webhook_subscription(watch_id, status);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempt (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  delivery_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body_excerpt TEXT,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  leased_at INTEGER,
  lease_expires_at INTEGER,
  last_attempt_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscription_id, event_id, attempt_number),
  FOREIGN KEY (watch_id) REFERENCES activity_watch(id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscription(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES activity_event(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS webhook_delivery_attempt_profile_status_next_idx
  ON webhook_delivery_attempt(profile_name, status, next_attempt_at);

CREATE INDEX IF NOT EXISTS webhook_delivery_attempt_subscription_created_idx
  ON webhook_delivery_attempt(subscription_id, created_at);

CREATE INDEX IF NOT EXISTS webhook_delivery_attempt_event_attempt_idx
  ON webhook_delivery_attempt(event_id, attempt_number);
`
  }
];
