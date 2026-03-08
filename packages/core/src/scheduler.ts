import {
  resolveSchedulerConfig,
  type SchedulerBusinessHoursConfig,
  type SchedulerConfig,
  type SchedulerLane
} from "./config.js";
import type {
  AssistantDatabase,
  SchedulerJobRow
} from "./db/database.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError,
  type LinkedInAssistantErrorCode
} from "./errors.js";
import {
  FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
  type LinkedInAcceptedConnection,
  type PreparedAcceptedConnectionFollowup,
  type PrepareAcceptedConnectionFollowupInput
} from "./linkedinFollowups.js";
import { normalizeLinkedInProfileUrl } from "./linkedinProfile.js";
import type { JsonEventLogger } from "./logging.js";
import { createRunId } from "./run.js";

const FOLLOWUP_PREPARATION_LANE = "followup_preparation";
const SCHEDULER_OPERATOR_NOTE = "Prepared by local scheduler.";

interface TimeZoneDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface TimeOfDay {
  hour: number;
  minute: number;
}

interface SchedulerFollowupService {
  listAcceptedConnections(input: {
    profileName?: string;
    sinceMs?: number;
  }): Promise<LinkedInAcceptedConnection[]>;
  prepareFollowupForAcceptedConnection(
    input: PrepareAcceptedConnectionFollowupInput
  ): Promise<PreparedAcceptedConnectionFollowup | null>;
}

export interface LinkedInSchedulerRuntime {
  db: AssistantDatabase;
  logger: JsonEventLogger;
  followups: SchedulerFollowupService;
  schedulerConfig?: SchedulerConfig;
}

export interface SchedulerTickJobResult {
  jobId: string;
  lane: SchedulerLane;
  outcome: "prepared" | "rescheduled" | "failed" | "cancelled";
  preparedActionId?: string;
  errorCode?: string | null;
  errorMessage?: string;
  scheduledAtMs?: number;
}

export type SchedulerTickSkippedReason =
  | "disabled"
  | "outside_business_hours"
  | "profile_busy"
  | null;

export interface SchedulerTickResult {
  profileName: string;
  workerId: string;
  windowOpen: boolean;
  nextWindowStartAt: string | null;
  skippedReason: SchedulerTickSkippedReason;
  discoveredAcceptedConnections: number;
  queuedJobs: number;
  updatedJobs: number;
  reopenedJobs: number;
  cancelledJobs: number;
  claimedJobs: number;
  preparedJobs: number;
  rescheduledJobs: number;
  failedJobs: number;
  processedJobs: SchedulerTickJobResult[];
}

const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = timeFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  timeFormatterCache.set(timeZone, formatter);
  return formatter;
}

function getTimeZoneDateTimeParts(
  utcMs: number,
  timeZone: string
): TimeZoneDateTimeParts {
  const parts = getTimeFormatter(timeZone).formatToParts(new Date(utcMs));
  const entries = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number.parseInt(entries.year ?? "0", 10),
    month: Number.parseInt(entries.month ?? "0", 10),
    day: Number.parseInt(entries.day ?? "0", 10),
    hour: Number.parseInt(entries.hour ?? "0", 10),
    minute: Number.parseInt(entries.minute ?? "0", 10),
    second: Number.parseInt(entries.second ?? "0", 10)
  };
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getTimeZoneDateTimeParts(utcMs, timeZone);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asUtcMs - utcMs;
}

function resolveUtcMsForLocalTime(
  localDateTime: TimeZoneDateTimeParts,
  timeZone: string
): number {
  const initialGuess = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second
  );
  const firstOffset = getTimeZoneOffsetMs(initialGuess, timeZone);
  let resolvedMs = initialGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(resolvedMs, timeZone);

  if (secondOffset !== firstOffset) {
    resolvedMs = initialGuess - secondOffset;
  }

  return resolvedMs;
}

function addDays(
  parts: Pick<TimeZoneDateTimeParts, "year" | "month" | "day">,
  days: number
): Pick<TimeZoneDateTimeParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function parseClockTime(value: string): TimeOfDay {
  const [hourText, minuteText] = value.split(":");
  return {
    hour: Number.parseInt(hourText ?? "0", 10),
    minute: Number.parseInt(minuteText ?? "0", 10)
  };
}

function toMinutesSinceMidnight(value: TimeOfDay): number {
  return value.hour * 60 + value.minute;
}

function getLocalMinutesSinceMidnight(
  utcMs: number,
  businessHours: SchedulerBusinessHoursConfig
): number {
  const parts = getTimeZoneDateTimeParts(utcMs, businessHours.timeZone);
  return parts.hour * 60 + parts.minute;
}

export function isWithinBusinessHours(
  utcMs: number,
  businessHours: SchedulerBusinessHoursConfig
): boolean {
  const currentMinutes = getLocalMinutesSinceMidnight(utcMs, businessHours);
  const startMinutes = toMinutesSinceMidnight(parseClockTime(businessHours.startTime));
  const endMinutes = toMinutesSinceMidnight(parseClockTime(businessHours.endTime));

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

export function alignToBusinessHours(
  utcMs: number,
  businessHours: SchedulerBusinessHoursConfig
): number {
  if (isWithinBusinessHours(utcMs, businessHours)) {
    return utcMs;
  }

  const local = getTimeZoneDateTimeParts(utcMs, businessHours.timeZone);
  const currentMinutes = local.hour * 60 + local.minute;
  const start = parseClockTime(businessHours.startTime);
  const startMinutes = toMinutesSinceMidnight(start);

  const nextDate =
    currentMinutes < startMinutes
      ? { year: local.year, month: local.month, day: local.day }
      : addDays(local, 1);

  return resolveUtcMsForLocalTime(
    {
      ...nextDate,
      hour: start.hour,
      minute: start.minute,
      second: 0
    },
    businessHours.timeZone
  );
}

export function calculateSchedulerBackoffMs(
  failureCount: number,
  retry: SchedulerConfig["retry"]
): number {
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(retry.maxBackoffMs, retry.initialBackoffMs * 2 ** exponent);
}

export function scheduleAcceptedConnectionFollowupAtMs(input: {
  connection: LinkedInAcceptedConnection;
  nowMs: number;
  config: SchedulerConfig;
}): number {
  const baseMs =
    input.connection.followup_status === "not_prepared"
      ? input.connection.accepted_at_ms + input.config.followupDelayMs
      : input.nowMs;

  return alignToBusinessHours(
    Math.max(baseMs, input.nowMs),
    input.config.businessHours
  );
}

function buildFollowupSchedulerDedupeKey(
  profileName: string,
  profileUrlKey: string
): string {
  return `${FOLLOWUP_PREPARATION_LANE}:${profileName}:${profileUrlKey}`;
}

function isActiveSchedulerJobStatus(status: SchedulerJobRow["status"]): boolean {
  return status === "pending" || status === "leased" || status === "prepared";
}

function isDuplicateSchedulerJobError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique constraint failed:\s*scheduler_job\.dedupe_key/i.test(error.message)
  );
}

function createSchedulerJobId(): string {
  return `scheduler_job_${createRunId()}`;
}

function isFollowupPreparationCandidate(
  connection: LinkedInAcceptedConnection
): boolean {
  return (
    connection.followup_status === "not_prepared" ||
    connection.followup_status === "failed" ||
    connection.followup_status === "expired"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRequiredTargetField(
  target: Record<string, unknown>,
  key: string,
  jobId: string
): string {
  const value = target[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Scheduler job ${jobId} is missing target.${key}.`,
    {
      job_id: jobId,
      key
    }
  );
}

function parseFollowupSchedulerTarget(job: SchedulerJobRow): {
  profileName: string;
  profileUrlKey: string;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(job.target_json);
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Scheduler job ${job.id} target_json is not valid JSON.`,
      {
        job_id: job.id,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }

  if (!isRecord(parsed)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Scheduler job ${job.id} target_json must be an object.`,
      {
        job_id: job.id
      }
    );
  }

  const targetProfileName = getRequiredTargetField(parsed, "profile_name", job.id);
  if (targetProfileName !== job.profile_name) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Scheduler job ${job.id} target.profile_name does not match the claimed profile.`,
      {
        job_id: job.id,
        job_profile_name: job.profile_name,
        target_profile_name: targetProfileName
      }
    );
  }

  return {
    profileName: job.profile_name,
    profileUrlKey: normalizeLinkedInProfileUrl(
      getRequiredTargetField(parsed, "profile_url_key", job.id)
    )
  };
}

function getSchedulerJobLeaseOwner(job: SchedulerJobRow): string {
  if (typeof job.lease_owner === "string" && job.lease_owner.length > 0) {
    return job.lease_owner;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Scheduler job ${job.id} is missing an active lease owner.`,
    {
      job_id: job.id,
      lane: job.lane,
      status: job.status
    }
  );
}

function isProfileBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /profile is busy|lock file is already being held/i.test(error.message)
  );
}

function normalizeSchedulerError(error: unknown): {
  code: LinkedInAssistantErrorCode | null;
  message: string;
  retryable: boolean;
} {
  const normalized = asLinkedInAssistantError(error);
  const retryableCodes: LinkedInAssistantErrorCode[] = [
    "AUTH_REQUIRED",
    "CAPTCHA_OR_CHALLENGE",
    "RATE_LIMITED",
    "NETWORK_ERROR",
    "TIMEOUT"
  ];

  if (retryableCodes.includes(normalized.code)) {
    return {
      code: normalized.code,
      message: normalized.message,
      retryable: true
    };
  }

  if (normalized.code === "ACTION_PRECONDITION_FAILED" && isProfileBusyError(error)) {
    return {
      code: normalized.code,
      message: normalized.message,
      retryable: true
    };
  }

  return {
    code: normalized.code,
    message: normalized.message,
    retryable: false
  };
}

function toIsoStringOrNull(utcMs: number | null): string | null {
  return utcMs === null ? null : new Date(utcMs).toISOString();
}

export class LinkedInSchedulerService {
  private readonly config: SchedulerConfig;

  constructor(private readonly runtime: LinkedInSchedulerRuntime) {
    this.config = runtime.schedulerConfig ?? resolveSchedulerConfig();
  }

  async runTick(input: {
    profileName?: string;
    nowMs?: number;
    workerId?: string;
  } = {}): Promise<SchedulerTickResult> {
    const profileName = input.profileName ?? "default";
    const nowMs = input.nowMs ?? Date.now();
    const workerId = input.workerId ?? `scheduler:${createRunId()}`;
    const windowOpen = isWithinBusinessHours(nowMs, this.config.businessHours);
    const nextWindowStartMs = windowOpen
      ? null
      : alignToBusinessHours(nowMs, this.config.businessHours);

    const summary: SchedulerTickResult = {
      profileName,
      workerId,
      windowOpen,
      nextWindowStartAt: toIsoStringOrNull(nextWindowStartMs),
      skippedReason: null,
      discoveredAcceptedConnections: 0,
      queuedJobs: 0,
      updatedJobs: 0,
      reopenedJobs: 0,
      cancelledJobs: 0,
      claimedJobs: 0,
      preparedJobs: 0,
      rescheduledJobs: 0,
      failedJobs: 0,
      processedJobs: []
    };

    if (
      !this.config.enabled ||
      !this.config.enabledLanes.includes(FOLLOWUP_PREPARATION_LANE)
    ) {
      summary.skippedReason = "disabled";
      return summary;
    }

    if (!windowOpen) {
      summary.skippedReason = "outside_business_hours";
      return summary;
    }

    this.runtime.logger.log("info", "scheduler.tick.start", {
      profile_name: profileName,
      worker_id: workerId,
      business_hours: this.config.businessHours,
      max_jobs_per_tick: this.config.maxJobsPerTick
    });

    let acceptedConnections: LinkedInAcceptedConnection[];

    try {
      acceptedConnections = await this.runtime.followups.listAcceptedConnections({
        profileName,
        sinceMs: this.config.followupLookbackMs
      });
    } catch (error) {
      if (isProfileBusyError(error)) {
        this.runtime.logger.log("info", "scheduler.tick.skipped_profile_busy", {
          profile_name: profileName,
          worker_id: workerId,
          message: error instanceof Error ? error.message : String(error)
        });
        summary.skippedReason = "profile_busy";
        return summary;
      }

      throw error;
    }

    summary.discoveredAcceptedConnections = acceptedConnections.length;

    const syncResult = this.syncFollowupJobs({
      acceptedConnections,
      nowMs,
      profileName
    });
    summary.queuedJobs = syncResult.queuedJobs;
    summary.updatedJobs = syncResult.updatedJobs;
    summary.reopenedJobs = syncResult.reopenedJobs;
    summary.cancelledJobs = syncResult.cancelledJobs;

    const claimedJobs = this.runtime.db.claimDueSchedulerJobs({
      profileName,
      nowMs,
      limit: this.config.maxJobsPerTick,
      leaseOwner: workerId,
      leaseTtlMs: this.config.leaseTtlMs
    });
    summary.claimedJobs = claimedJobs.length;

    for (const job of claimedJobs) {
      const result = await this.processClaimedJob(job, nowMs);
      summary.processedJobs.push(result);

      if (result.outcome === "prepared") {
        summary.preparedJobs += 1;
      } else if (result.outcome === "rescheduled") {
        summary.rescheduledJobs += 1;
      } else if (result.outcome === "failed") {
        summary.failedJobs += 1;
      } else if (result.outcome === "cancelled") {
        summary.cancelledJobs += 1;
      }
    }

    this.runtime.logger.log("info", "scheduler.tick.done", {
      profile_name: profileName,
      worker_id: workerId,
      queued_jobs: summary.queuedJobs,
      updated_jobs: summary.updatedJobs,
      reopened_jobs: summary.reopenedJobs,
      cancelled_jobs: summary.cancelledJobs,
      claimed_jobs: summary.claimedJobs,
      prepared_jobs: summary.preparedJobs,
      rescheduled_jobs: summary.rescheduledJobs,
      failed_jobs: summary.failedJobs,
      discovered_accepted_connections: summary.discoveredAcceptedConnections,
      skipped_reason: summary.skippedReason
    });

    return summary;
  }

  private syncFollowupJobs(input: {
    acceptedConnections: LinkedInAcceptedConnection[];
    nowMs: number;
    profileName: string;
  }): {
    queuedJobs: number;
    updatedJobs: number;
    reopenedJobs: number;
    cancelledJobs: number;
  } {
    const candidates = [...input.acceptedConnections].sort((left, right) => {
      return (
        left.accepted_at_ms - right.accepted_at_ms ||
        left.first_seen_sent_at_ms - right.first_seen_sent_at_ms
      );
    });
    let queuedJobs = 0;
    let updatedJobs = 0;
    let reopenedJobs = 0;
    let cancelledJobs = 0;

    const existingJobs = this.runtime.db.listSchedulerJobs({
      profileName: input.profileName
    });
    const existingJobsByDedupeKey = new Map(
      existingJobs.map((job) => [job.dedupe_key, job])
    );
    let activeJobCount = existingJobs.filter((job) =>
      isActiveSchedulerJobStatus(job.status)
    ).length;

    for (const connection of candidates) {
      const dedupeKey = buildFollowupSchedulerDedupeKey(
        input.profileName,
        connection.profile_url_key
      );
      let existing = existingJobsByDedupeKey.get(dedupeKey);

      if (!isFollowupPreparationCandidate(connection)) {
        if (existing?.status === "pending") {
          const cancelled = this.runtime.db.cancelSchedulerJob({
            id: existing.id,
            nowMs: input.nowMs,
            reason: `Follow-up already ${connection.followup_status}.`
          });
          if (cancelled) {
            cancelledJobs += 1;
            activeJobCount = Math.max(0, activeJobCount - 1);
            existingJobsByDedupeKey.set(dedupeKey, {
              ...existing,
              status: "cancelled",
              lease_owner: null,
              leased_at: null,
              lease_expires_at: null,
              last_error_code: null,
              last_error_message: `Follow-up already ${connection.followup_status}.`,
              last_attempt_at: input.nowMs,
              completed_at: input.nowMs,
              updated_at: input.nowMs
            });
          }
        }
        continue;
      }

      const scheduledAtMs = scheduleAcceptedConnectionFollowupAtMs({
        connection,
        nowMs: input.nowMs,
        config: this.config
      });
      const targetJson = JSON.stringify({
        profile_name: input.profileName,
        profile_url_key: connection.profile_url_key
      });

      if (!existing) {
        if (activeJobCount >= this.config.maxActiveJobsPerProfile) {
          this.runtime.logger.log("warn", "scheduler.queue.limit_reached", {
            profile_name: input.profileName,
            max_active_jobs_per_profile: this.config.maxActiveJobsPerProfile,
            target_profile_url_key: connection.profile_url_key,
            lane: FOLLOWUP_PREPARATION_LANE
          });
          continue;
        }

        const insertedJob: SchedulerJobRow = {
          id: createSchedulerJobId(),
          profile_name: input.profileName,
          lane: FOLLOWUP_PREPARATION_LANE,
          action_type: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
          target_json: targetJson,
          dedupe_key: dedupeKey,
          scheduled_at: scheduledAtMs,
          status: "pending",
          attempt_count: 0,
          max_attempts: this.config.retry.maxAttempts,
          lease_owner: null,
          leased_at: null,
          lease_expires_at: null,
          prepared_action_id: null,
          last_error_code: null,
          last_error_message: null,
          last_attempt_at: null,
          completed_at: null,
          created_at: input.nowMs,
          updated_at: input.nowMs
        };

        try {
          this.runtime.db.insertSchedulerJob({
            id: insertedJob.id,
            profileName: insertedJob.profile_name,
            lane: insertedJob.lane,
            actionType: insertedJob.action_type,
            targetJson: insertedJob.target_json,
            dedupeKey: insertedJob.dedupe_key,
            scheduledAtMs: insertedJob.scheduled_at,
            maxAttempts: insertedJob.max_attempts,
            createdAtMs: insertedJob.created_at,
            updatedAtMs: insertedJob.updated_at
          });
          existingJobsByDedupeKey.set(dedupeKey, insertedJob);
          queuedJobs += 1;
          activeJobCount += 1;
          continue;
        } catch (error) {
          if (!isDuplicateSchedulerJobError(error)) {
            throw error;
          }

          existing = this.runtime.db.getSchedulerJobByDedupeKey({
            profileName: input.profileName,
            dedupeKey
          });

          if (!existing) {
            throw error;
          }

          existingJobsByDedupeKey.set(dedupeKey, existing);
        }
      }

      if (existing.status === "pending") {
        if (scheduledAtMs < existing.scheduled_at || targetJson !== existing.target_json) {
          const updated = this.runtime.db.updateSchedulerJobSchedule({
            id: existing.id,
            scheduledAtMs,
            targetJson,
            updatedAtMs: input.nowMs
          });
          if (updated) {
            updatedJobs += 1;
            existingJobsByDedupeKey.set(dedupeKey, {
              ...existing,
              scheduled_at: scheduledAtMs,
              target_json: targetJson,
              updated_at: input.nowMs
            });
          }
        }
        continue;
      }

      if (
        existing.status === "cancelled" ||
        (existing.status === "prepared" && connection.followup_status !== "prepared" && connection.followup_status !== "executed")
      ) {
        const requiresActiveSlot = existing.status === "cancelled";
        if (
          requiresActiveSlot &&
          activeJobCount >= this.config.maxActiveJobsPerProfile
        ) {
          this.runtime.logger.log("warn", "scheduler.queue.limit_reached", {
            profile_name: input.profileName,
            max_active_jobs_per_profile: this.config.maxActiveJobsPerProfile,
            target_profile_url_key: connection.profile_url_key,
            lane: FOLLOWUP_PREPARATION_LANE,
            existing_status: existing.status
          });
          continue;
        }

        const reopened = this.runtime.db.requeueSchedulerJob({
          id: existing.id,
          scheduledAtMs,
          targetJson,
          updatedAtMs: input.nowMs
        });
        if (reopened) {
          reopenedJobs += 1;
          if (requiresActiveSlot) {
            activeJobCount += 1;
          }
          existingJobsByDedupeKey.set(dedupeKey, {
            ...existing,
            status: "pending",
            scheduled_at: scheduledAtMs,
            target_json: targetJson,
            lease_owner: null,
            leased_at: null,
            lease_expires_at: null,
            prepared_action_id: null,
            last_error_code: null,
            last_error_message: null,
            completed_at: null,
            updated_at: input.nowMs
          });
        }
      }
    }

    return {
      queuedJobs,
      updatedJobs,
      reopenedJobs,
      cancelledJobs
    };
  }

  private async processClaimedJob(
    job: SchedulerJobRow,
    nowMs: number
  ): Promise<SchedulerTickJobResult> {
    const leaseOwner = getSchedulerJobLeaseOwner(job);

    if (job.lane !== FOLLOWUP_PREPARATION_LANE) {
      const cancelled = this.runtime.db.cancelSchedulerJob({
        id: job.id,
        nowMs,
        reason: `Lane ${job.lane} is not executable in this scheduler build.`,
        leaseOwner
      });

      if (!cancelled) {
        this.runtime.logger.log("info", "scheduler.job.superseded", {
          job_id: job.id,
          lane: job.lane,
          lease_owner: leaseOwner,
          outcome: "cancelled_unsupported_lane"
        });
      }

      return {
        jobId: job.id,
        lane: job.lane,
        outcome: "cancelled"
      };
    }

    try {
      const target = parseFollowupSchedulerTarget(job);
      const prepared = await this.runtime.followups.prepareFollowupForAcceptedConnection({
        profileName: job.profile_name,
        profileUrlKey: target.profileUrlKey,
        operatorNote: SCHEDULER_OPERATOR_NOTE,
        refreshState: false
      });

      if (!prepared) {
        const cancelled = this.runtime.db.cancelSchedulerJob({
          id: job.id,
          nowMs,
          reason: "Follow-up no longer needs preparation.",
          leaseOwner
        });

        if (!cancelled) {
          this.runtime.logger.log("info", "scheduler.job.superseded", {
            job_id: job.id,
            lane: job.lane,
            lease_owner: leaseOwner,
            outcome: "cancelled_no_longer_needed"
          });
        }

        this.runtime.logger.log("info", "scheduler.job.cancelled", {
          job_id: job.id,
          lane: job.lane,
          profile_name: target.profileName,
          profile_url_key: target.profileUrlKey,
          reason: "Follow-up no longer needs preparation."
        });
        return {
          jobId: job.id,
          lane: job.lane,
          outcome: "cancelled"
        };
      }

      const markedPrepared = this.runtime.db.markSchedulerJobPrepared({
        id: job.id,
        nowMs,
        preparedActionId: prepared.preparedActionId,
        leaseOwner
      });

      if (!markedPrepared) {
        this.runtime.logger.log("info", "scheduler.job.superseded", {
          job_id: job.id,
          lane: job.lane,
          lease_owner: leaseOwner,
          prepared_action_id: prepared.preparedActionId,
          outcome: "prepared"
        });
        return {
          jobId: job.id,
          lane: job.lane,
          outcome: "cancelled"
        };
      }

      this.runtime.logger.log("info", "scheduler.job.prepared", {
        job_id: job.id,
        lane: job.lane,
        prepared_action_id: prepared.preparedActionId,
        target_profile_url_key: target.profileUrlKey
      });
      return {
        jobId: job.id,
        lane: job.lane,
        outcome: "prepared",
        preparedActionId: prepared.preparedActionId
      };
    } catch (error) {
      const normalizedError = normalizeSchedulerError(error);
      const nextAttempt = job.attempt_count + 1;

      try {
        if (normalizedError.retryable && nextAttempt < job.max_attempts) {
          const backoffMs = calculateSchedulerBackoffMs(nextAttempt, this.config.retry);
          const scheduledAtMs = alignToBusinessHours(
            nowMs + backoffMs,
            this.config.businessHours
          );

          const rescheduled = this.runtime.db.rescheduleSchedulerJob({
            id: job.id,
            scheduledAtMs,
            nowMs,
            leaseOwner,
            errorCode: normalizedError.code,
            errorMessage: normalizedError.message
          });

          if (!rescheduled) {
            this.runtime.logger.log("info", "scheduler.job.superseded", {
              job_id: job.id,
              lane: job.lane,
              lease_owner: leaseOwner,
              error_code: normalizedError.code,
              outcome: "rescheduled"
            });
            return {
              jobId: job.id,
              lane: job.lane,
              outcome: "cancelled"
            };
          }

          this.runtime.logger.log("warn", "scheduler.job.rescheduled", {
            job_id: job.id,
            lane: job.lane,
            error_code: normalizedError.code,
            error_message: normalizedError.message,
            next_attempt: nextAttempt,
            scheduled_at: new Date(scheduledAtMs).toISOString()
          });
          return {
            jobId: job.id,
            lane: job.lane,
            outcome: "rescheduled",
            errorCode: normalizedError.code,
            errorMessage: normalizedError.message,
            scheduledAtMs
          };
        }

        const failed = this.runtime.db.failSchedulerJob({
          id: job.id,
          nowMs,
          leaseOwner,
          errorCode: normalizedError.code,
          errorMessage: normalizedError.message
        });

        if (!failed) {
          this.runtime.logger.log("info", "scheduler.job.superseded", {
            job_id: job.id,
            lane: job.lane,
            lease_owner: leaseOwner,
            error_code: normalizedError.code,
            outcome: "failed"
          });
          return {
            jobId: job.id,
            lane: job.lane,
            outcome: "cancelled"
          };
        }

        this.runtime.logger.log("error", "scheduler.job.failed", {
          job_id: job.id,
          lane: job.lane,
          error_code: normalizedError.code,
          error_message: normalizedError.message,
          attempt_count: nextAttempt,
          max_attempts: job.max_attempts,
          dead_lettered: true
        });
        return {
          jobId: job.id,
          lane: job.lane,
          outcome: "failed",
          errorCode: normalizedError.code,
          errorMessage: normalizedError.message
        };
      } catch (transitionError) {
        const transitionFailure = asLinkedInAssistantError(transitionError);

        this.runtime.logger.log("error", "scheduler.job.transition_failed", {
          job_id: job.id,
          lane: job.lane,
          lease_owner: leaseOwner,
          original_error_code: normalizedError.code,
          original_error_message: normalizedError.message,
          transition_error_code: transitionFailure.code,
          transition_error_message: transitionFailure.message,
          attempt_count: nextAttempt,
          max_attempts: job.max_attempts
        });

        return {
          jobId: job.id,
          lane: job.lane,
          outcome: "failed",
          errorCode: transitionFailure.code,
          errorMessage: transitionFailure.message
        };
      }
    }
  }
}
