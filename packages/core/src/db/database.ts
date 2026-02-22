import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrations, type Migration } from "./migrations.js";

interface MigrationRow {
  id: string;
}

export interface RunLogInsert {
  runId: string;
  level: string;
  eventName: string;
  payloadJson: string;
  createdAtMs: number;
}

export interface ArtifactIndexInsert {
  runId: string;
  artifactPath: string;
  artifactType: string;
  metadataJson: string;
  createdAtMs: number;
}

export interface PreparedActionInsert {
  id: string;
  actionType: string;
  targetJson: string;
  payloadJson: string;
  previewJson: string;
  payloadHash: string;
  previewHash: string;
  status: string;
  confirmTokenHash: string;
  expiresAtMs: number;
  createdAtMs: number;
  operatorNote: string | null;
}

export interface PreparedActionRow {
  id: string;
  action_type: string;
  target_json: string;
  payload_json: string;
  preview_json: string;
  payload_hash: string;
  preview_hash: string;
  status: string;
  confirm_token_hash: string;
  expires_at: number;
  created_at: number;
  confirmed_at: number | null;
  operator_note: string | null;
  executed_at: number | null;
  execution_result_json: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface PreparedActionExecutedUpdate {
  id: string;
  confirmedAtMs: number;
  executedAtMs: number;
  executionResultJson: string;
}

export interface PreparedActionFailedUpdate {
  id: string;
  confirmedAtMs: number;
  executedAtMs: number;
  errorCode: string;
  errorMessage: string;
}

export interface RateLimitCounterRow {
  counterKey: string;
  windowStartMs: number;
  windowSizeMs: number;
  count: number;
  updatedAtMs: number;
}

export class AssistantDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dbDir = path.dirname(dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.ensureMigrationsTable();
    this.applyMigrations();
  }

  close(): void {
    this.db.close();
  }

  insertRunLog(input: RunLogInsert): void {
    this.db
      .prepare(
        `
INSERT INTO run_log (run_id, level, event_name, payload_json, created_at)
VALUES (@runId, @level, @eventName, @payloadJson, @createdAtMs)
`
      )
      .run(input);
  }

  insertArtifactIndex(input: ArtifactIndexInsert): void {
    this.db
      .prepare(
        `
INSERT INTO artifact_index (run_id, artifact_path, artifact_type, metadata_json, created_at)
VALUES (@runId, @artifactPath, @artifactType, @metadataJson, @createdAtMs)
`
      )
      .run(input);
  }

  insertPreparedAction(input: PreparedActionInsert): void {
    this.db
      .prepare(
        `
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
  operator_note
)
VALUES (
  @id,
  @actionType,
  @targetJson,
  @payloadJson,
  @previewJson,
  @payloadHash,
  @previewHash,
  @status,
  @confirmTokenHash,
  @expiresAtMs,
  @createdAtMs,
  @operatorNote
)
`
      )
      .run(input);
  }

  getPreparedActionById(id: string): PreparedActionRow | undefined {
    return this.db
      .prepare<unknown[], PreparedActionRow>(
        `
SELECT
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
FROM prepared_action
WHERE id = ?
`
      )
      .get(id);
  }

  getPreparedActionByConfirmTokenHash(
    confirmTokenHash: string
  ): PreparedActionRow | undefined {
    return this.db
      .prepare<unknown[], PreparedActionRow>(
        `
SELECT
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
FROM prepared_action
WHERE confirm_token_hash = ?
ORDER BY created_at DESC
LIMIT 1
`
      )
      .get(confirmTokenHash);
  }

  markPreparedActionExecuted(input: PreparedActionExecutedUpdate): boolean {
    const result = this.db
      .prepare(
        `
UPDATE prepared_action
SET
  status = 'executed',
  confirmed_at = @confirmedAtMs,
  executed_at = @executedAtMs,
  execution_result_json = @executionResultJson,
  error_code = NULL,
  error_message = NULL
WHERE id = @id AND status = 'prepared'
`
      )
      .run(input);

    return result.changes === 1;
  }

  markPreparedActionFailed(input: PreparedActionFailedUpdate): boolean {
    const result = this.db
      .prepare(
        `
UPDATE prepared_action
SET
  status = 'failed',
  confirmed_at = @confirmedAtMs,
  executed_at = @executedAtMs,
  execution_result_json = NULL,
  error_code = @errorCode,
  error_message = @errorMessage
WHERE id = @id AND status = 'prepared'
`
      )
      .run(input);

    return result.changes === 1;
  }

  getRateLimitCounter(counterKey: string): RateLimitCounterRow | undefined {
    const row = this.db
      .prepare<unknown[], {
        counter_key: string;
        window_start_ms: number;
        window_size_ms: number;
        count: number;
        updated_at_ms: number;
      }>(
        `
SELECT counter_key, window_start_ms, window_size_ms, count, updated_at_ms
FROM rate_limit_counter
WHERE counter_key = ?
`
      )
      .get(counterKey);

    if (!row) {
      return undefined;
    }

    return {
      counterKey: row.counter_key,
      windowStartMs: row.window_start_ms,
      windowSizeMs: row.window_size_ms,
      count: row.count,
      updatedAtMs: row.updated_at_ms
    };
  }

  upsertRateLimitCounter(counter: RateLimitCounterRow): void {
    this.db
      .prepare(
        `
INSERT INTO rate_limit_counter (counter_key, window_start_ms, window_size_ms, count, updated_at_ms)
VALUES (@counterKey, @windowStartMs, @windowSizeMs, @count, @updatedAtMs)
ON CONFLICT(counter_key) DO UPDATE SET
  window_start_ms = excluded.window_start_ms,
  window_size_ms = excluded.window_size_ms,
  count = excluded.count,
  updated_at_ms = excluded.updated_at_ms
`
      )
      .run(counter);
  }

  private ensureMigrationsTable(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`);
  }

  private applyMigrations(): void {
    const appliedRows = this.db
      .prepare<unknown[], MigrationRow>("SELECT id FROM schema_migrations")
      .all();
    const applied = new Set(appliedRows.map((row) => row.id));

    const applyMigration = this.db.transaction((migration: Migration) => {
      this.db.exec(migration.sql);
      this.db
        .prepare(
          "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
        )
        .run(migration.id, Date.now());
    });

    for (const migration of migrations) {
      if (!applied.has(migration.id)) {
        applyMigration(migration);
      }
    }
  }
}
