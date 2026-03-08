import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SchedulerLane } from "../config.js";
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

export interface RunLogRow {
  id: number;
  run_id: string;
  level: string;
  event_name: string;
  payload_json: string;
  created_at: number;
}

export interface ArtifactIndexInsert {
  runId: string;
  artifactPath: string;
  artifactType: string;
  metadataJson: string;
  createdAtMs: number;
}

export interface ArtifactIndexRow {
  id: number;
  run_id: string;
  artifact_path: string;
  artifact_type: string;
  metadata_json: string;
  created_at: number;
}

export interface PreparedActionInsert {
  id: string;
  actionType: string;
  targetJson: string;
  sealedTargetJson: string | null;
  payloadJson: string;
  sealedPayloadJson: string | null;
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
  sealed_target_json: string | null;
  payload_json: string;
  sealed_payload_json: string | null;
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

export interface SentInvitationStateUpsert {
  profileName: string;
  profileUrlKey: string;
  vanityName: string | null;
  fullName: string;
  headline: string;
  profileUrl: string;
  firstSeenSentAtMs: number;
  lastSeenSentAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SentInvitationStateRow {
  profile_name: string;
  profile_url_key: string;
  vanity_name: string | null;
  full_name: string;
  headline: string;
  profile_url: string;
  first_seen_sent_at: number;
  last_seen_sent_at: number;
  closed_at: number | null;
  closed_reason: string | null;
  accepted_at: number | null;
  accepted_detection: string | null;
  followup_prepared_at: number | null;
  followup_prepared_action_id: string | null;
  followup_confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SentInvitationAcceptedUpdate {
  profileName: string;
  profileUrlKey: string;
  vanityName: string | null;
  fullName: string;
  headline: string;
  profileUrl: string;
  acceptedAtMs: number;
  acceptedDetection: string;
  updatedAtMs: number;
}

export interface SentInvitationClosedUpdate {
  profileName: string;
  profileUrlKey: string;
  closedAtMs: number;
  closedReason: string;
  updatedAtMs: number;
}

export interface SentInvitationFollowupPreparedUpdate {
  profileName: string;
  profileUrlKey: string;
  preparedAtMs: number;
  preparedActionId: string;
  updatedAtMs: number;
}

export interface SentInvitationFollowupConfirmedUpdate {
  profileName: string;
  profileUrlKey: string;
  confirmedAtMs: number;
  preparedActionId: string;
  updatedAtMs: number;
}

export const SCHEDULER_JOB_STATUSES = [
  "pending",
  "leased",
  "prepared",
  "failed",
  "cancelled"
] as const;

export type SchedulerJobStatus = (typeof SCHEDULER_JOB_STATUSES)[number];

export interface SchedulerJobInsert {
  id: string;
  profileName: string;
  lane: SchedulerLane;
  actionType: string;
  targetJson: string;
  dedupeKey: string;
  scheduledAtMs: number;
  status?: SchedulerJobStatus;
  attemptCount?: number;
  maxAttempts: number;
  leaseOwner?: string | null;
  leasedAtMs?: number | null;
  leaseExpiresAtMs?: number | null;
  preparedActionId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastAttemptAtMs?: number | null;
  completedAtMs?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SchedulerJobRow {
  id: string;
  profile_name: string;
  lane: SchedulerLane;
  action_type: string;
  target_json: string;
  dedupe_key: string;
  scheduled_at: number;
  status: SchedulerJobStatus;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  leased_at: number | null;
  lease_expires_at: number | null;
  prepared_action_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_attempt_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimDueSchedulerJobsInput {
  profileName: string;
  nowMs: number;
  limit: number;
  leaseOwner: string;
  leaseTtlMs: number;
}

export interface UpdateSchedulerJobScheduleInput {
  id: string;
  scheduledAtMs: number;
  targetJson?: string;
  updatedAtMs: number;
}

export interface RequeueSchedulerJobInput {
  id: string;
  scheduledAtMs: number;
  targetJson?: string;
  updatedAtMs: number;
}

export interface CompleteSchedulerJobInput {
  id: string;
  nowMs: number;
  preparedActionId: string;
}

export interface RescheduleSchedulerJobInput {
  id: string;
  scheduledAtMs: number;
  nowMs: number;
  errorCode?: string | null;
  errorMessage: string;
}

export interface FailSchedulerJobInput {
  id: string;
  nowMs: number;
  errorCode?: string | null;
  errorMessage: string;
}

export interface CancelSchedulerJobInput {
  id: string;
  nowMs: number;
  reason: string;
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
  sealed_target_json,
  payload_json,
  sealed_payload_json,
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
  @sealedTargetJson,
  @payloadJson,
  @sealedPayloadJson,
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
  sealed_target_json,
  payload_json,
  sealed_payload_json,
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
  sealed_target_json,
  payload_json,
  sealed_payload_json,
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

  listRunLogs(runId: string): RunLogRow[] {
    return this.db
      .prepare<unknown[], RunLogRow>(
        `
SELECT id, run_id, level, event_name, payload_json, created_at
FROM run_log
WHERE run_id = ?
ORDER BY created_at ASC, id ASC
`
      )
      .all(runId);
  }

  listArtifactIndex(runId: string): ArtifactIndexRow[] {
    return this.db
      .prepare<unknown[], ArtifactIndexRow>(
        `
SELECT id, run_id, artifact_path, artifact_type, metadata_json, created_at
FROM artifact_index
WHERE run_id = ?
ORDER BY created_at ASC, id ASC
`
      )
      .all(runId);
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

  upsertSentInvitationState(input: SentInvitationStateUpsert): void {
    this.db
      .prepare(
        `
INSERT INTO sent_invitation_state (
  profile_name,
  profile_url_key,
  vanity_name,
  full_name,
  headline,
  profile_url,
  first_seen_sent_at,
  last_seen_sent_at,
  closed_at,
  closed_reason,
  accepted_at,
  accepted_detection,
  followup_prepared_at,
  followup_prepared_action_id,
  followup_confirmed_at,
  created_at,
  updated_at
)
VALUES (
  @profileName,
  @profileUrlKey,
  @vanityName,
  @fullName,
  @headline,
  @profileUrl,
  @firstSeenSentAtMs,
  @lastSeenSentAtMs,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  @createdAtMs,
  @updatedAtMs
)
ON CONFLICT(profile_name, profile_url_key) DO UPDATE SET
  vanity_name = excluded.vanity_name,
  full_name = CASE
    WHEN length(excluded.full_name) > 0 THEN excluded.full_name
    ELSE sent_invitation_state.full_name
  END,
  headline = CASE
    WHEN length(excluded.headline) > 0 THEN excluded.headline
    ELSE sent_invitation_state.headline
  END,
  profile_url = CASE
    WHEN length(excluded.profile_url) > 0 THEN excluded.profile_url
    ELSE sent_invitation_state.profile_url
  END,
  last_seen_sent_at = CASE
    WHEN excluded.last_seen_sent_at > sent_invitation_state.last_seen_sent_at
      THEN excluded.last_seen_sent_at
    ELSE sent_invitation_state.last_seen_sent_at
  END,
  closed_at = NULL,
  closed_reason = NULL,
  updated_at = excluded.updated_at
`
      )
      .run(input);
  }

  listSentInvitationAcceptanceCandidates(input: {
    profileName: string;
    lastSeenBeforeMs: number;
  }): SentInvitationStateRow[] {
    return this.db
      .prepare<
        {
          profileName: string;
          lastSeenBeforeMs: number;
        },
        SentInvitationStateRow
      >(
        `
SELECT
  profile_name,
  profile_url_key,
  vanity_name,
  full_name,
  headline,
  profile_url,
  first_seen_sent_at,
  last_seen_sent_at,
  closed_at,
  closed_reason,
  accepted_at,
  accepted_detection,
  followup_prepared_at,
  followup_prepared_action_id,
  followup_confirmed_at,
  created_at,
  updated_at
FROM sent_invitation_state
WHERE profile_name = @profileName
  AND closed_at IS NULL
  AND accepted_at IS NULL
  AND last_seen_sent_at < @lastSeenBeforeMs
ORDER BY last_seen_sent_at DESC
`
      )
      .all(input);
  }

  listAcceptedSentInvitations(input: {
    profileName: string;
    sinceMs: number;
  }): SentInvitationStateRow[] {
    return this.db
      .prepare<
        {
          profileName: string;
          sinceMs: number;
        },
        SentInvitationStateRow
      >(
        `
SELECT
  profile_name,
  profile_url_key,
  vanity_name,
  full_name,
  headline,
  profile_url,
  first_seen_sent_at,
  last_seen_sent_at,
  closed_at,
  closed_reason,
  accepted_at,
  accepted_detection,
  followup_prepared_at,
  followup_prepared_action_id,
  followup_confirmed_at,
  created_at,
  updated_at
FROM sent_invitation_state
WHERE profile_name = @profileName
  AND closed_at IS NULL
  AND accepted_at IS NOT NULL
  AND accepted_at >= @sinceMs
ORDER BY accepted_at DESC, last_seen_sent_at DESC
`
      )
      .all(input);
  }

  markSentInvitationAccepted(input: SentInvitationAcceptedUpdate): boolean {
    const result = this.db
      .prepare(
        `
UPDATE sent_invitation_state
SET
  vanity_name = COALESCE(@vanityName, vanity_name),
  full_name = CASE
    WHEN length(@fullName) > 0 THEN @fullName
    ELSE full_name
  END,
  headline = CASE
    WHEN length(@headline) > 0 THEN @headline
    ELSE headline
  END,
  profile_url = CASE
    WHEN length(@profileUrl) > 0 THEN @profileUrl
    ELSE profile_url
  END,
  accepted_at = COALESCE(accepted_at, @acceptedAtMs),
  accepted_detection = @acceptedDetection,
  updated_at = @updatedAtMs
WHERE profile_name = @profileName
  AND profile_url_key = @profileUrlKey
  AND closed_at IS NULL
`
      )
      .run(input);

    return result.changes === 1;
  }

  markSentInvitationClosed(input: SentInvitationClosedUpdate): boolean {
    const result = this.db
      .prepare(
        `
UPDATE sent_invitation_state
SET
  closed_at = COALESCE(closed_at, @closedAtMs),
  closed_reason = COALESCE(closed_reason, @closedReason),
  updated_at = @updatedAtMs
WHERE profile_name = @profileName
  AND profile_url_key = @profileUrlKey
`
      )
      .run(input);

    return result.changes === 1;
  }

  markSentInvitationFollowupPrepared(
    input: SentInvitationFollowupPreparedUpdate
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE sent_invitation_state
SET
  followup_prepared_at = @preparedAtMs,
  followup_prepared_action_id = @preparedActionId,
  updated_at = @updatedAtMs
WHERE profile_name = @profileName
  AND profile_url_key = @profileUrlKey
  AND closed_at IS NULL
  AND accepted_at IS NOT NULL
`
      )
      .run(input);

    return result.changes === 1;
  }

  markSentInvitationFollowupConfirmed(
    input: SentInvitationFollowupConfirmedUpdate
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE sent_invitation_state
SET
  followup_confirmed_at = @confirmedAtMs,
  updated_at = @updatedAtMs
WHERE profile_name = @profileName
  AND profile_url_key = @profileUrlKey
  AND followup_prepared_action_id = @preparedActionId
`
      )
      .run(input);

    return result.changes === 1;
  }

  getSentInvitationState(input: {
    profileName: string;
    profileUrlKey: string;
  }): SentInvitationStateRow | undefined {
    return this.db
      .prepare<
        {
          profileName: string;
          profileUrlKey: string;
        },
        SentInvitationStateRow
      >(
        `
SELECT
  profile_name,
  profile_url_key,
  vanity_name,
  full_name,
  headline,
  profile_url,
  first_seen_sent_at,
  last_seen_sent_at,
  closed_at,
  closed_reason,
  accepted_at,
  accepted_detection,
  followup_prepared_at,
  followup_prepared_action_id,
  followup_confirmed_at,
  created_at,
  updated_at
FROM sent_invitation_state
WHERE profile_name = @profileName
  AND profile_url_key = @profileUrlKey
LIMIT 1
`
      )
      .get(input);
  }

  insertSchedulerJob(input: SchedulerJobInsert): void {
    this.db
      .prepare(
        `
INSERT INTO scheduler_job (
  id,
  profile_name,
  lane,
  action_type,
  target_json,
  dedupe_key,
  scheduled_at,
  status,
  attempt_count,
  max_attempts,
  lease_owner,
  leased_at,
  lease_expires_at,
  prepared_action_id,
  last_error_code,
  last_error_message,
  last_attempt_at,
  completed_at,
  created_at,
  updated_at
)
VALUES (
  @id,
  @profileName,
  @lane,
  @actionType,
  @targetJson,
  @dedupeKey,
  @scheduledAtMs,
  @status,
  @attemptCount,
  @maxAttempts,
  @leaseOwner,
  @leasedAtMs,
  @leaseExpiresAtMs,
  @preparedActionId,
  @lastErrorCode,
  @lastErrorMessage,
  @lastAttemptAtMs,
  @completedAtMs,
  @createdAtMs,
  @updatedAtMs
)
`
      )
      .run({
        ...input,
        attemptCount: input.attemptCount ?? 0,
        status: input.status ?? "pending",
        leaseOwner: input.leaseOwner ?? null,
        leasedAtMs: input.leasedAtMs ?? null,
        leaseExpiresAtMs: input.leaseExpiresAtMs ?? null,
        preparedActionId: input.preparedActionId ?? null,
        lastErrorCode: input.lastErrorCode ?? null,
        lastErrorMessage: input.lastErrorMessage ?? null,
        lastAttemptAtMs: input.lastAttemptAtMs ?? null,
        completedAtMs: input.completedAtMs ?? null
      });
  }

  getSchedulerJobById(id: string): SchedulerJobRow | undefined {
    return this.db
      .prepare<unknown[], SchedulerJobRow>(
        `
SELECT
  id,
  profile_name,
  lane,
  action_type,
  target_json,
  dedupe_key,
  scheduled_at,
  status,
  attempt_count,
  max_attempts,
  lease_owner,
  leased_at,
  lease_expires_at,
  prepared_action_id,
  last_error_code,
  last_error_message,
  last_attempt_at,
  completed_at,
  created_at,
  updated_at
FROM scheduler_job
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  getSchedulerJobByDedupeKey(dedupeKey: string): SchedulerJobRow | undefined {
    return this.db
      .prepare<unknown[], SchedulerJobRow>(
        `
SELECT
  id,
  profile_name,
  lane,
  action_type,
  target_json,
  dedupe_key,
  scheduled_at,
  status,
  attempt_count,
  max_attempts,
  lease_owner,
  leased_at,
  lease_expires_at,
  prepared_action_id,
  last_error_code,
  last_error_message,
  last_attempt_at,
  completed_at,
  created_at,
  updated_at
FROM scheduler_job
WHERE dedupe_key = ?
LIMIT 1
`
      )
      .get(dedupeKey);
  }

  listSchedulerJobs(input: { profileName: string }): SchedulerJobRow[] {
    return this.db
      .prepare<{ profileName: string }, SchedulerJobRow>(
        `
SELECT
  id,
  profile_name,
  lane,
  action_type,
  target_json,
  dedupe_key,
  scheduled_at,
  status,
  attempt_count,
  max_attempts,
  lease_owner,
  leased_at,
  lease_expires_at,
  prepared_action_id,
  last_error_code,
  last_error_message,
  last_attempt_at,
  completed_at,
  created_at,
  updated_at
FROM scheduler_job
WHERE profile_name = @profileName
ORDER BY
  CASE lane
    WHEN 'inbox_triage' THEN 0
    WHEN 'pending_invite_checks' THEN 1
    WHEN 'followup_preparation' THEN 2
    WHEN 'feed_engagement' THEN 3
    ELSE 99
  END ASC,
  scheduled_at ASC,
  created_at ASC
`
      )
      .all(input);
  }

  updateSchedulerJobSchedule(
    input: UpdateSchedulerJobScheduleInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  scheduled_at = @scheduledAtMs,
  target_json = COALESCE(@targetJson, target_json),
  updated_at = @updatedAtMs
WHERE id = @id
  AND status = 'pending'
`
      )
      .run({
        ...input,
        targetJson: input.targetJson ?? null
      });

    return result.changes === 1;
  }

  requeueSchedulerJob(input: RequeueSchedulerJobInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  status = 'pending',
  scheduled_at = @scheduledAtMs,
  target_json = COALESCE(@targetJson, target_json),
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  prepared_action_id = NULL,
  last_error_code = NULL,
  last_error_message = NULL,
  completed_at = NULL,
  updated_at = @updatedAtMs
WHERE id = @id
  AND (status = 'prepared' OR status = 'cancelled')
`
      )
      .run({
        ...input,
        targetJson: input.targetJson ?? null
      });

    return result.changes === 1;
  }

  claimDueSchedulerJobs(input: ClaimDueSchedulerJobsInput): SchedulerJobRow[] {
    const claimJobs = this.db.transaction(
      (claimInput: ClaimDueSchedulerJobsInput): SchedulerJobRow[] => {
        const candidates = this.db
          .prepare<ClaimDueSchedulerJobsInput, SchedulerJobRow>(
            `
SELECT
  id,
  profile_name,
  lane,
  action_type,
  target_json,
  dedupe_key,
  scheduled_at,
  status,
  attempt_count,
  max_attempts,
  lease_owner,
  leased_at,
  lease_expires_at,
  prepared_action_id,
  last_error_code,
  last_error_message,
  last_attempt_at,
  completed_at,
  created_at,
  updated_at
FROM scheduler_job
WHERE profile_name = @profileName
  AND scheduled_at <= @nowMs
  AND (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < @nowMs)
  )
ORDER BY
  CASE lane
    WHEN 'inbox_triage' THEN 0
    WHEN 'pending_invite_checks' THEN 1
    WHEN 'followup_preparation' THEN 2
    WHEN 'feed_engagement' THEN 3
    ELSE 99
  END ASC,
  scheduled_at ASC,
  created_at ASC
LIMIT @limit
`
          )
          .all(claimInput);

        const claimed: SchedulerJobRow[] = [];
        const leaseExpiresAtMs = claimInput.nowMs + claimInput.leaseTtlMs;

        for (const candidate of candidates) {
          const result = this.db
            .prepare(
              `
UPDATE scheduler_job
SET
  status = 'leased',
  lease_owner = @leaseOwner,
  leased_at = @nowMs,
  lease_expires_at = @leaseExpiresAtMs,
  updated_at = @nowMs
WHERE id = @id
  AND scheduled_at <= @nowMs
  AND (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < @nowMs)
  )
`
            )
            .run({
              id: candidate.id,
              leaseExpiresAtMs,
              leaseOwner: claimInput.leaseOwner,
              nowMs: claimInput.nowMs
            });

          if (result.changes === 1) {
            claimed.push({
              ...candidate,
              status: "leased",
              lease_owner: claimInput.leaseOwner,
              leased_at: claimInput.nowMs,
              lease_expires_at: leaseExpiresAtMs,
              updated_at: claimInput.nowMs
            });
          }
        }

        return claimed;
      }
    );

    return claimJobs(input);
  }

  markSchedulerJobPrepared(input: CompleteSchedulerJobInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  status = 'prepared',
  prepared_action_id = @preparedActionId,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  last_error_code = NULL,
  last_error_message = NULL,
  last_attempt_at = @nowMs,
  completed_at = @nowMs,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
`
      )
      .run(input);

    return result.changes === 1;
  }

  rescheduleSchedulerJob(input: RescheduleSchedulerJobInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  status = 'pending',
  attempt_count = attempt_count + 1,
  scheduled_at = @scheduledAtMs,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  last_attempt_at = @nowMs,
  completed_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
`
      )
      .run({
        ...input,
        errorCode: input.errorCode ?? null
      });

    return result.changes === 1;
  }

  failSchedulerJob(input: FailSchedulerJobInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  status = 'failed',
  attempt_count = attempt_count + 1,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  last_attempt_at = @nowMs,
  completed_at = @nowMs,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
`
      )
      .run({
        ...input,
        errorCode: input.errorCode ?? null
      });

    return result.changes === 1;
  }

  cancelSchedulerJob(input: CancelSchedulerJobInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE scheduler_job
SET
  status = 'cancelled',
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  last_error_code = NULL,
  last_error_message = @reason,
  last_attempt_at = @nowMs,
  completed_at = @nowMs,
  updated_at = @nowMs
WHERE id = @id
  AND (status = 'pending' OR status = 'leased')
`
      )
      .run(input);

    return result.changes === 1;
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
