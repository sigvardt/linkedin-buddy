import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  ActivityEntityType,
  ActivityEventType,
  ActivityScheduleKind,
  ActivityWatchKind,
  ActivityWatchStatus,
  WebhookDeliveryAttemptStatus,
  WebhookSubscriptionStatus
} from "../activityTypes.js";
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

export interface GetSchedulerJobByDedupeKeyInput {
  profileName: string;
  dedupeKey: string;
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
  leaseOwner: string;
}

export interface RescheduleSchedulerJobInput {
  id: string;
  scheduledAtMs: number;
  nowMs: number;
  leaseOwner: string;
  errorCode?: string | null;
  errorMessage: string;
}

export interface FailSchedulerJobInput {
  id: string;
  nowMs: number;
  leaseOwner: string;
  errorCode?: string | null;
  errorMessage: string;
}

export interface CancelSchedulerJobInput {
  id: string;
  nowMs: number;
  reason: string;
  leaseOwner?: string | null;
}

export interface ActivityWatchInsert {
  id: string;
  profileName: string;
  kind: ActivityWatchKind;
  targetJson: string;
  scheduleKind: ActivityScheduleKind;
  pollIntervalMs?: number | null;
  cronExpression?: string | null;
  status: ActivityWatchStatus;
  nextPollAtMs: number;
  lastPolledAtMs?: number | null;
  lastSuccessAtMs?: number | null;
  consecutiveFailures?: number;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  leaseOwner?: string | null;
  leasedAtMs?: number | null;
  leaseExpiresAtMs?: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ActivityWatchRow {
  id: string;
  profile_name: string;
  kind: ActivityWatchKind;
  target_json: string;
  schedule_kind: ActivityScheduleKind;
  poll_interval_ms: number | null;
  cron_expression: string | null;
  status: ActivityWatchStatus;
  next_poll_at: number;
  last_polled_at: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  last_error_code: string | null;
  last_error_message: string | null;
  lease_owner: string | null;
  leased_at: number | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimDueActivityWatchesInput {
  profileName?: string;
  nowMs: number;
  limit: number;
  leaseOwner: string;
  leaseTtlMs: number;
}

export interface UpdateActivityWatchStatusInput {
  id: string;
  status: ActivityWatchStatus;
  updatedAtMs: number;
  nextPollAtMs?: number | null;
}

export interface CompleteActivityWatchPollInput {
  id: string;
  nowMs: number;
  nextPollAtMs: number;
  leaseOwner: string;
}

export interface FailActivityWatchPollInput {
  id: string;
  nowMs: number;
  nextPollAtMs: number;
  leaseOwner: string;
  errorCode?: string | null;
  errorMessage: string;
}

export interface ActivityEntityStateUpsert {
  watchId: string;
  entityKey: string;
  entityType: ActivityEntityType;
  fingerprint: string;
  snapshotJson: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastEmittedEventId?: string | null;
  updatedAtMs: number;
}

export interface ActivityEntityStateRow {
  watch_id: string;
  entity_key: string;
  entity_type: ActivityEntityType;
  fingerprint: string;
  snapshot_json: string;
  first_seen_at: number;
  last_seen_at: number;
  last_emitted_event_id: string | null;
  updated_at: number;
}

export interface ActivityEventInsert {
  id: string;
  watchId: string;
  profileName: string;
  eventType: ActivityEventType;
  entityKey: string;
  payloadJson: string;
  fingerprint: string;
  occurredAtMs: number;
  createdAtMs: number;
}

export interface ActivityEventRow {
  id: string;
  watch_id: string;
  profile_name: string;
  event_type: ActivityEventType;
  entity_key: string;
  payload_json: string;
  fingerprint: string;
  occurred_at: number;
  created_at: number;
}

export interface WebhookSubscriptionInsert {
  id: string;
  watchId: string;
  status: WebhookSubscriptionStatus;
  eventTypesJson: string;
  deliveryUrl: string;
  signingSecret: string;
  maxAttempts: number;
  lastDeliveredAtMs?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookSubscriptionRow {
  id: string;
  watch_id: string;
  status: WebhookSubscriptionStatus;
  event_types_json: string;
  delivery_url: string;
  signing_secret: string;
  max_attempts: number;
  last_delivered_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpdateWebhookSubscriptionStatusInput {
  id: string;
  status: WebhookSubscriptionStatus;
  updatedAtMs: number;
}

export interface RecordWebhookSubscriptionDeliveryInput {
  id: string;
  deliveredAtMs: number;
  updatedAtMs: number;
}

export interface RecordWebhookSubscriptionErrorInput {
  id: string;
  errorCode?: string | null;
  errorMessage: string;
  updatedAtMs: number;
}

export interface WebhookDeliveryAttemptInsert {
  id: string;
  watchId: string;
  profileName: string;
  subscriptionId: string;
  eventId: string;
  eventType: ActivityEventType;
  deliveryUrl: string;
  payloadJson: string;
  attemptNumber: number;
  status: WebhookDeliveryAttemptStatus;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
  nextAttemptAtMs: number;
  leaseOwner?: string | null;
  leasedAtMs?: number | null;
  leaseExpiresAtMs?: number | null;
  lastAttemptAtMs?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookDeliveryAttemptRow {
  id: string;
  watch_id: string;
  profile_name: string;
  subscription_id: string;
  event_id: string;
  event_type: ActivityEventType;
  delivery_url: string;
  payload_json: string;
  attempt_number: number;
  status: WebhookDeliveryAttemptStatus;
  response_status: number | null;
  response_body_excerpt: string | null;
  next_attempt_at: number;
  lease_owner: string | null;
  leased_at: number | null;
  lease_expires_at: number | null;
  last_attempt_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimDueWebhookDeliveryAttemptsInput {
  profileName?: string;
  nowMs: number;
  limit: number;
  leaseOwner: string;
  leaseTtlMs: number;
}

export interface CompleteWebhookDeliveryAttemptInput {
  id: string;
  leaseOwner: string;
  nowMs: number;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
}

export interface RetryWebhookDeliveryAttemptInput {
  id: string;
  leaseOwner: string;
  nowMs: number;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
  errorCode?: string | null;
  errorMessage: string;
}

export interface FailWebhookDeliveryAttemptInput {
  id: string;
  leaseOwner: string;
  nowMs: number;
  responseStatus?: number | null;
  responseBodyExcerpt?: string | null;
  errorCode?: string | null;
  errorMessage: string;
  deadLetter?: boolean;
}

const PREPARED_ACTION_SELECT_COLUMNS = `
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
`;

const SCHEDULER_JOB_SELECT_COLUMNS = `
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
`;

const SCHEDULER_JOB_ORDER_BY = `
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
`;

const ACTIVITY_WATCH_SELECT_COLUMNS = `
  id,
  profile_name,
  kind,
  target_json,
  schedule_kind,
  poll_interval_ms,
  cron_expression,
  status,
  next_poll_at,
  last_polled_at,
  last_success_at,
  consecutive_failures,
  last_error_code,
  last_error_message,
  lease_owner,
  leased_at,
  lease_expires_at,
  created_at,
  updated_at
`;

const ACTIVITY_ENTITY_STATE_SELECT_COLUMNS = `
  watch_id,
  entity_key,
  entity_type,
  fingerprint,
  snapshot_json,
  first_seen_at,
  last_seen_at,
  last_emitted_event_id,
  updated_at
`;

const ACTIVITY_EVENT_SELECT_COLUMNS = `
  id,
  watch_id,
  profile_name,
  event_type,
  entity_key,
  payload_json,
  fingerprint,
  occurred_at,
  created_at
`;

const WEBHOOK_SUBSCRIPTION_SELECT_COLUMNS = `
  id,
  watch_id,
  status,
  event_types_json,
  delivery_url,
  signing_secret,
  max_attempts,
  last_delivered_at,
  last_error_code,
  last_error_message,
  created_at,
  updated_at
`;

const WEBHOOK_DELIVERY_ATTEMPT_SELECT_COLUMNS = `
  id,
  watch_id,
  profile_name,
  subscription_id,
  event_id,
  event_type,
  delivery_url,
  payload_json,
  attempt_number,
  status,
  response_status,
  response_body_excerpt,
  next_attempt_at,
  lease_owner,
  leased_at,
  lease_expires_at,
  last_attempt_at,
  last_error_code,
  last_error_message,
  created_at,
  updated_at
`;

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
${PREPARED_ACTION_SELECT_COLUMNS}
FROM prepared_action
WHERE id = ?
`
      )
      .get(id);
  }

  listPreparedActionsByIds(ids: string[]): PreparedActionRow[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");

    return this.db
      .prepare<unknown[], PreparedActionRow>(
        `
SELECT
${PREPARED_ACTION_SELECT_COLUMNS}
FROM prepared_action
WHERE id IN (${placeholders})
`
      )
      .all(...ids);
  }

  getPreparedActionByConfirmTokenHash(
    confirmTokenHash: string
  ): PreparedActionRow | undefined {
    return this.db
      .prepare<unknown[], PreparedActionRow>(
        `
SELECT
${PREPARED_ACTION_SELECT_COLUMNS}
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
${SCHEDULER_JOB_SELECT_COLUMNS}
FROM scheduler_job
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  getSchedulerJobByDedupeKey(
    input: GetSchedulerJobByDedupeKeyInput
  ): SchedulerJobRow | undefined {
    return this.db
      .prepare<GetSchedulerJobByDedupeKeyInput, SchedulerJobRow>(
        `
SELECT
${SCHEDULER_JOB_SELECT_COLUMNS}
FROM scheduler_job
WHERE profile_name = @profileName
  AND dedupe_key = @dedupeKey
LIMIT 1
`
      )
      .get(input);
  }

  listSchedulerJobs(input: { profileName: string }): SchedulerJobRow[] {
    return this.db
      .prepare<{ profileName: string }, SchedulerJobRow>(
        `
SELECT
${SCHEDULER_JOB_SELECT_COLUMNS}
FROM scheduler_job
WHERE profile_name = @profileName
${SCHEDULER_JOB_ORDER_BY}
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
${SCHEDULER_JOB_SELECT_COLUMNS}
FROM scheduler_job
WHERE profile_name = @profileName
  AND scheduled_at <= @nowMs
  AND (
    status = 'pending'
    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < @nowMs)
  )
${SCHEDULER_JOB_ORDER_BY}
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
  AND lease_owner = @leaseOwner
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
  AND lease_owner = @leaseOwner
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
  AND lease_owner = @leaseOwner
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
  AND (
    (status = 'pending' AND @leaseOwner IS NULL)
    OR (status = 'leased' AND lease_owner = @leaseOwner)
  )
`
      )
      .run({
        ...input,
        leaseOwner: input.leaseOwner ?? null
      });

    return result.changes === 1;
  }

  insertActivityWatch(input: ActivityWatchInsert): void {
    this.db
      .prepare(
        `
INSERT INTO activity_watch (
  id,
  profile_name,
  kind,
  target_json,
  schedule_kind,
  poll_interval_ms,
  cron_expression,
  status,
  next_poll_at,
  last_polled_at,
  last_success_at,
  consecutive_failures,
  last_error_code,
  last_error_message,
  lease_owner,
  leased_at,
  lease_expires_at,
  created_at,
  updated_at
)
VALUES (
  @id,
  @profileName,
  @kind,
  @targetJson,
  @scheduleKind,
  @pollIntervalMs,
  @cronExpression,
  @status,
  @nextPollAtMs,
  @lastPolledAtMs,
  @lastSuccessAtMs,
  @consecutiveFailures,
  @lastErrorCode,
  @lastErrorMessage,
  @leaseOwner,
  @leasedAtMs,
  @leaseExpiresAtMs,
  @createdAtMs,
  @updatedAtMs
)
`
      )
      .run({
        ...input,
        pollIntervalMs: input.pollIntervalMs ?? null,
        cronExpression: input.cronExpression ?? null,
        lastPolledAtMs: input.lastPolledAtMs ?? null,
        lastSuccessAtMs: input.lastSuccessAtMs ?? null,
        consecutiveFailures: input.consecutiveFailures ?? 0,
        lastErrorCode: input.lastErrorCode ?? null,
        lastErrorMessage: input.lastErrorMessage ?? null,
        leaseOwner: input.leaseOwner ?? null,
        leasedAtMs: input.leasedAtMs ?? null,
        leaseExpiresAtMs: input.leaseExpiresAtMs ?? null
      });
  }

  getActivityWatchById(id: string): ActivityWatchRow | undefined {
    return this.db
      .prepare<unknown[], ActivityWatchRow>(
        `
SELECT
${ACTIVITY_WATCH_SELECT_COLUMNS}
FROM activity_watch
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  listActivityWatches(input: {
    profileName?: string;
    status?: ActivityWatchStatus;
  } = {}): ActivityWatchRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (input.profileName) {
      clauses.push("profile_name = @profileName");
      params.profileName = input.profileName;
    }

    if (input.status) {
      clauses.push("status = @status");
      params.status = input.status;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare<Record<string, unknown>, ActivityWatchRow>(
        `
SELECT
${ACTIVITY_WATCH_SELECT_COLUMNS}
FROM activity_watch
${where}
ORDER BY profile_name ASC, next_poll_at ASC, created_at ASC
`
      )
      .all(params);
  }

  deleteActivityWatch(id: string): boolean {
    const result = this.db
      .prepare(
        `
DELETE FROM activity_watch
WHERE id = ?
`
      )
      .run(id);

    return result.changes === 1;
  }

  updateActivityWatchStatus(input: UpdateActivityWatchStatusInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE activity_watch
SET
  status = @status,
  next_poll_at = COALESCE(@nextPollAtMs, next_poll_at),
  updated_at = @updatedAtMs
WHERE id = @id
`
      )
      .run({
        ...input,
        nextPollAtMs: input.nextPollAtMs ?? null
      });

    return result.changes === 1;
  }

  claimDueActivityWatches(
    input: ClaimDueActivityWatchesInput
  ): ActivityWatchRow[] {
    const claimWatches = this.db.transaction(
      (claimInput: ClaimDueActivityWatchesInput): ActivityWatchRow[] => {
        const profileFilter = claimInput.profileName
          ? "AND profile_name = @profileName"
          : "";
        const candidates = this.db
          .prepare<ClaimDueActivityWatchesInput, ActivityWatchRow>(
            `
SELECT
${ACTIVITY_WATCH_SELECT_COLUMNS}
FROM activity_watch
WHERE status = 'active'
  ${profileFilter}
  AND next_poll_at <= @nowMs
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at < @nowMs
  )
ORDER BY next_poll_at ASC, created_at ASC
LIMIT @limit
`
          )
          .all(claimInput);

        const claimed: ActivityWatchRow[] = [];
        const leaseExpiresAtMs = claimInput.nowMs + claimInput.leaseTtlMs;

        for (const candidate of candidates) {
          const result = this.db
            .prepare(
              `
UPDATE activity_watch
SET
  lease_owner = @leaseOwner,
  leased_at = @nowMs,
  lease_expires_at = @leaseExpiresAtMs,
  last_polled_at = @nowMs,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'active'
  AND next_poll_at <= @nowMs
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at < @nowMs
  )
`
            )
            .run({
              id: candidate.id,
              leaseOwner: claimInput.leaseOwner,
              leaseExpiresAtMs,
              nowMs: claimInput.nowMs
            });

          if (result.changes === 1) {
            claimed.push({
              ...candidate,
              lease_owner: claimInput.leaseOwner,
              leased_at: claimInput.nowMs,
              lease_expires_at: leaseExpiresAtMs,
              last_polled_at: claimInput.nowMs,
              updated_at: claimInput.nowMs
            });
          }
        }

        return claimed;
      }
    );

    return claimWatches(input);
  }

  markActivityWatchPollSucceeded(
    input: CompleteActivityWatchPollInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE activity_watch
SET
  next_poll_at = @nextPollAtMs,
  last_success_at = @nowMs,
  consecutive_failures = 0,
  last_error_code = NULL,
  last_error_message = NULL,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND lease_owner = @leaseOwner
`
      )
      .run(input);

    return result.changes === 1;
  }

  markActivityWatchPollFailed(input: FailActivityWatchPollInput): boolean {
    const result = this.db
      .prepare(
        `
UPDATE activity_watch
SET
  next_poll_at = @nextPollAtMs,
  consecutive_failures = consecutive_failures + 1,
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND lease_owner = @leaseOwner
`
      )
      .run({
        ...input,
        errorCode: input.errorCode ?? null
      });

    return result.changes === 1;
  }

  listActivityEntityStates(input: { watchId: string }): ActivityEntityStateRow[] {
    return this.db
      .prepare<{ watchId: string }, ActivityEntityStateRow>(
        `
SELECT
${ACTIVITY_ENTITY_STATE_SELECT_COLUMNS}
FROM activity_entity_state
WHERE watch_id = @watchId
ORDER BY entity_type ASC, entity_key ASC
`
      )
      .all(input);
  }

  upsertActivityEntityState(input: ActivityEntityStateUpsert): void {
    this.db
      .prepare(
        `
INSERT INTO activity_entity_state (
  watch_id,
  entity_key,
  entity_type,
  fingerprint,
  snapshot_json,
  first_seen_at,
  last_seen_at,
  last_emitted_event_id,
  updated_at
)
VALUES (
  @watchId,
  @entityKey,
  @entityType,
  @fingerprint,
  @snapshotJson,
  @firstSeenAtMs,
  @lastSeenAtMs,
  @lastEmittedEventId,
  @updatedAtMs
)
ON CONFLICT(watch_id, entity_key) DO UPDATE SET
  entity_type = excluded.entity_type,
  fingerprint = excluded.fingerprint,
  snapshot_json = excluded.snapshot_json,
  last_seen_at = excluded.last_seen_at,
  last_emitted_event_id = COALESCE(excluded.last_emitted_event_id, activity_entity_state.last_emitted_event_id),
  updated_at = excluded.updated_at
`
      )
      .run({
        ...input,
        lastEmittedEventId: input.lastEmittedEventId ?? null
      });
  }

  insertActivityEvent(input: ActivityEventInsert): boolean {
    const result = this.db
      .prepare(
        `
INSERT OR IGNORE INTO activity_event (
  id,
  watch_id,
  profile_name,
  event_type,
  entity_key,
  payload_json,
  fingerprint,
  occurred_at,
  created_at
)
VALUES (
  @id,
  @watchId,
  @profileName,
  @eventType,
  @entityKey,
  @payloadJson,
  @fingerprint,
  @occurredAtMs,
  @createdAtMs
)
`
      )
      .run(input);

    return result.changes === 1;
  }

  getActivityEventById(id: string): ActivityEventRow | undefined {
    return this.db
      .prepare<unknown[], ActivityEventRow>(
        `
SELECT
${ACTIVITY_EVENT_SELECT_COLUMNS}
FROM activity_event
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  listActivityEvents(input: {
    profileName?: string;
    watchId?: string;
    limit?: number;
  } = {}): ActivityEventRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      limit: input.limit ?? 50
    };

    if (input.profileName) {
      clauses.push("profile_name = @profileName");
      params.profileName = input.profileName;
    }

    if (input.watchId) {
      clauses.push("watch_id = @watchId");
      params.watchId = input.watchId;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare<Record<string, unknown>, ActivityEventRow>(
        `
SELECT
${ACTIVITY_EVENT_SELECT_COLUMNS}
FROM activity_event
${where}
ORDER BY created_at DESC
LIMIT @limit
`
      )
      .all(params);
  }

  insertWebhookSubscription(input: WebhookSubscriptionInsert): void {
    this.db
      .prepare(
        `
INSERT INTO webhook_subscription (
  id,
  watch_id,
  status,
  event_types_json,
  delivery_url,
  signing_secret,
  max_attempts,
  last_delivered_at,
  last_error_code,
  last_error_message,
  created_at,
  updated_at
)
VALUES (
  @id,
  @watchId,
  @status,
  @eventTypesJson,
  @deliveryUrl,
  @signingSecret,
  @maxAttempts,
  @lastDeliveredAtMs,
  @lastErrorCode,
  @lastErrorMessage,
  @createdAtMs,
  @updatedAtMs
)
`
      )
      .run({
        ...input,
        lastDeliveredAtMs: input.lastDeliveredAtMs ?? null,
        lastErrorCode: input.lastErrorCode ?? null,
        lastErrorMessage: input.lastErrorMessage ?? null
      });
  }

  getWebhookSubscriptionById(id: string): WebhookSubscriptionRow | undefined {
    return this.db
      .prepare<unknown[], WebhookSubscriptionRow>(
        `
SELECT
${WEBHOOK_SUBSCRIPTION_SELECT_COLUMNS}
FROM webhook_subscription
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  listWebhookSubscriptions(input: {
    watchId?: string;
    profileName?: string;
    status?: WebhookSubscriptionStatus;
  } = {}): WebhookSubscriptionRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    let join = "";

    if (input.watchId) {
      clauses.push("webhook_subscription.watch_id = @watchId");
      params.watchId = input.watchId;
    }

    if (input.profileName) {
      join = "INNER JOIN activity_watch ON activity_watch.id = webhook_subscription.watch_id";
      clauses.push("activity_watch.profile_name = @profileName");
      params.profileName = input.profileName;
    }

    if (input.status) {
      clauses.push("webhook_subscription.status = @status");
      params.status = input.status;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare<Record<string, unknown>, WebhookSubscriptionRow>(
        `
SELECT
${WEBHOOK_SUBSCRIPTION_SELECT_COLUMNS}
FROM webhook_subscription
${join}
${where}
ORDER BY webhook_subscription.created_at ASC
`
      )
      .all(params);
  }

  listActiveWebhookSubscriptionsByWatchId(
    watchId: string
  ): WebhookSubscriptionRow[] {
    return this.db
      .prepare<{ watchId: string }, WebhookSubscriptionRow>(
        `
SELECT
${WEBHOOK_SUBSCRIPTION_SELECT_COLUMNS}
FROM webhook_subscription
WHERE watch_id = @watchId
  AND status = 'active'
ORDER BY created_at ASC
`
      )
      .all({ watchId });
  }

  deleteWebhookSubscription(id: string): boolean {
    const result = this.db
      .prepare(
        `
DELETE FROM webhook_subscription
WHERE id = ?
`
      )
      .run(id);

    return result.changes === 1;
  }

  updateWebhookSubscriptionStatus(
    input: UpdateWebhookSubscriptionStatusInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_subscription
SET
  status = @status,
  updated_at = @updatedAtMs
WHERE id = @id
`
      )
      .run(input);

    return result.changes === 1;
  }

  recordWebhookSubscriptionDelivered(
    input: RecordWebhookSubscriptionDeliveryInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_subscription
SET
  last_delivered_at = @deliveredAtMs,
  last_error_code = NULL,
  last_error_message = NULL,
  updated_at = @updatedAtMs
WHERE id = @id
`
      )
      .run(input);

    return result.changes === 1;
  }

  recordWebhookSubscriptionError(
    input: RecordWebhookSubscriptionErrorInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_subscription
SET
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  updated_at = @updatedAtMs
WHERE id = @id
`
      )
      .run({
        ...input,
        errorCode: input.errorCode ?? null
      });

    return result.changes === 1;
  }

  insertWebhookDeliveryAttempt(input: WebhookDeliveryAttemptInsert): boolean {
    const result = this.db
      .prepare(
        `
INSERT OR IGNORE INTO webhook_delivery_attempt (
  id,
  watch_id,
  profile_name,
  subscription_id,
  event_id,
  event_type,
  delivery_url,
  payload_json,
  attempt_number,
  status,
  response_status,
  response_body_excerpt,
  next_attempt_at,
  lease_owner,
  leased_at,
  lease_expires_at,
  last_attempt_at,
  last_error_code,
  last_error_message,
  created_at,
  updated_at
)
VALUES (
  @id,
  @watchId,
  @profileName,
  @subscriptionId,
  @eventId,
  @eventType,
  @deliveryUrl,
  @payloadJson,
  @attemptNumber,
  @status,
  @responseStatus,
  @responseBodyExcerpt,
  @nextAttemptAtMs,
  @leaseOwner,
  @leasedAtMs,
  @leaseExpiresAtMs,
  @lastAttemptAtMs,
  @lastErrorCode,
  @lastErrorMessage,
  @createdAtMs,
  @updatedAtMs
)
`
      )
      .run({
        ...input,
        responseStatus: input.responseStatus ?? null,
        responseBodyExcerpt: input.responseBodyExcerpt ?? null,
        leaseOwner: input.leaseOwner ?? null,
        leasedAtMs: input.leasedAtMs ?? null,
        leaseExpiresAtMs: input.leaseExpiresAtMs ?? null,
        lastAttemptAtMs: input.lastAttemptAtMs ?? null,
        lastErrorCode: input.lastErrorCode ?? null,
        lastErrorMessage: input.lastErrorMessage ?? null
      });

    return result.changes === 1;
  }

  getWebhookDeliveryAttemptById(
    id: string
  ): WebhookDeliveryAttemptRow | undefined {
    return this.db
      .prepare<unknown[], WebhookDeliveryAttemptRow>(
        `
SELECT
${WEBHOOK_DELIVERY_ATTEMPT_SELECT_COLUMNS}
FROM webhook_delivery_attempt
WHERE id = ?
LIMIT 1
`
      )
      .get(id);
  }

  listWebhookDeliveryAttempts(input: {
    profileName?: string;
    watchId?: string;
    subscriptionId?: string;
    status?: WebhookDeliveryAttemptStatus;
    limit?: number;
  } = {}): WebhookDeliveryAttemptRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      limit: input.limit ?? 50
    };

    if (input.profileName) {
      clauses.push("profile_name = @profileName");
      params.profileName = input.profileName;
    }

    if (input.watchId) {
      clauses.push("watch_id = @watchId");
      params.watchId = input.watchId;
    }

    if (input.subscriptionId) {
      clauses.push("subscription_id = @subscriptionId");
      params.subscriptionId = input.subscriptionId;
    }

    if (input.status) {
      clauses.push("status = @status");
      params.status = input.status;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .prepare<Record<string, unknown>, WebhookDeliveryAttemptRow>(
        `
SELECT
${WEBHOOK_DELIVERY_ATTEMPT_SELECT_COLUMNS}
FROM webhook_delivery_attempt
${where}
ORDER BY created_at DESC
LIMIT @limit
`
      )
      .all(params);
  }

  claimDueWebhookDeliveryAttempts(
    input: ClaimDueWebhookDeliveryAttemptsInput
  ): WebhookDeliveryAttemptRow[] {
    const claimAttempts = this.db.transaction(
      (
        claimInput: ClaimDueWebhookDeliveryAttemptsInput
      ): WebhookDeliveryAttemptRow[] => {
        const profileFilter = claimInput.profileName
          ? "AND profile_name = @profileName"
          : "";
        const candidates = this.db
          .prepare<
            ClaimDueWebhookDeliveryAttemptsInput,
            WebhookDeliveryAttemptRow
          >(
            `
SELECT
${WEBHOOK_DELIVERY_ATTEMPT_SELECT_COLUMNS}
FROM webhook_delivery_attempt
WHERE status = 'pending'
  ${profileFilter}
  AND next_attempt_at <= @nowMs
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at < @nowMs
  )
ORDER BY next_attempt_at ASC, created_at ASC
LIMIT @limit
`
          )
          .all(claimInput);

        const claimed: WebhookDeliveryAttemptRow[] = [];
        const leaseExpiresAtMs = claimInput.nowMs + claimInput.leaseTtlMs;

        for (const candidate of candidates) {
          const result = this.db
            .prepare(
              `
UPDATE webhook_delivery_attempt
SET
  status = 'leased',
  lease_owner = @leaseOwner,
  leased_at = @nowMs,
  lease_expires_at = @leaseExpiresAtMs,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'pending'
  AND next_attempt_at <= @nowMs
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at < @nowMs
  )
`
            )
            .run({
              id: candidate.id,
              leaseOwner: claimInput.leaseOwner,
              leaseExpiresAtMs,
              nowMs: claimInput.nowMs
            });

          if (result.changes === 1) {
            claimed.push({
              ...candidate,
              status: 'leased',
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

    return claimAttempts(input);
  }

  markWebhookDeliveryAttemptDelivered(
    input: CompleteWebhookDeliveryAttemptInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_delivery_attempt
SET
  status = 'delivered',
  response_status = @responseStatus,
  response_body_excerpt = @responseBodyExcerpt,
  last_attempt_at = @nowMs,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
  AND lease_owner = @leaseOwner
`
      )
      .run({
        ...input,
        responseStatus: input.responseStatus ?? null,
        responseBodyExcerpt: input.responseBodyExcerpt ?? null
      });

    return result.changes === 1;
  }

  markWebhookDeliveryAttemptRetrying(
    input: RetryWebhookDeliveryAttemptInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_delivery_attempt
SET
  status = 'retrying',
  response_status = @responseStatus,
  response_body_excerpt = @responseBodyExcerpt,
  last_attempt_at = @nowMs,
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
  AND lease_owner = @leaseOwner
`
      )
      .run({
        ...input,
        responseStatus: input.responseStatus ?? null,
        responseBodyExcerpt: input.responseBodyExcerpt ?? null,
        errorCode: input.errorCode ?? null
      });

    return result.changes === 1;
  }

  markWebhookDeliveryAttemptFailed(
    input: FailWebhookDeliveryAttemptInput
  ): boolean {
    const result = this.db
      .prepare(
        `
UPDATE webhook_delivery_attempt
SET
  status = @status,
  response_status = @responseStatus,
  response_body_excerpt = @responseBodyExcerpt,
  last_attempt_at = @nowMs,
  last_error_code = @errorCode,
  last_error_message = @errorMessage,
  lease_owner = NULL,
  leased_at = NULL,
  lease_expires_at = NULL,
  updated_at = @nowMs
WHERE id = @id
  AND status = 'leased'
  AND lease_owner = @leaseOwner
`
      )
      .run({
        ...input,
        status: input.deadLetter ? 'dead_letter' : 'failed',
        responseStatus: input.responseStatus ?? null,
        responseBodyExcerpt: input.responseBodyExcerpt ?? null,
        errorCode: input.errorCode ?? null
      });

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
