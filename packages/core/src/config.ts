import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  LINKEDIN_SELECTOR_LOCALES,
  resolveLinkedInSelectorLocaleResolution,
  type LinkedInSelectorLocaleFallbackReason,
  type LinkedInSelectorLocaleResolution,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";
import {
  createEvasionStatus,
  DEFAULT_EVASION_LEVEL,
  EVASION_LEVELS,
  resolveEvasionLevel,
  type EvasionLevel,
  type EvasionStatus
} from "./evasion.js";
import { LinkedInBuddyError } from "./errors.js";
import { isFixtureReplayEnabled } from "./fixtureReplay.js";

/**
 * Default directory used for tool-owned state when no custom home is configured.
 */
export const DEFAULT_LINKEDIN_BUDDY_HOME = path.join(
  os.homedir(),
  ".linkedin-buddy",
  "linkedin-buddy"
);

/**
 * Resolved on-disk locations for profiles, database state, and run artifacts.
 */
export interface ConfigPaths {
  baseDir: string;
  artifactsDir: string;
  profilesDir: string;
  dbPath: string;
}

/**
 * Default maximum trace size captured for confirm-failure artifacts.
 */
export const DEFAULT_CONFIRM_TRACE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Configures confirm-failure artifact capture limits.
 */
export interface ConfirmFailureArtifactConfig {
  traceMaxBytes: number;
}

/**
 * Environment variable that configures the default anti-bot evasion level.
 *
 * @example
 * ```ts
 * process.env[LINKEDIN_BUDDY_EVASION_LEVEL_ENV] = "paranoid";
 * ```
 */
export const LINKEDIN_BUDDY_EVASION_LEVEL_ENV =
  "LINKEDIN_BUDDY_EVASION_LEVEL";

/**
 * Environment variable that enables verbose evasion diagnostics in run logs.
 *
 * @example
 * ```ts
 * process.env[LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV] = "true";
 * ```
 */
export const LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV =
  "LINKEDIN_BUDDY_EVASION_DIAGNOSTICS";

/**
 * Resolved evasion configuration shared across runtime/session diagnostics.
 *
 * @example
 * ```ts
 * const config: EvasionConfig = resolveEvasionConfig({ level: "moderate" });
 * ```
 */
export type EvasionConfig = EvasionStatus;

/**
 * Scheduler lane names accepted by config validation.
 *
 * @remarks
 * Only `followup_preparation` performs useful work in the current build. The
 * remaining names reserve stable config values for future scheduler queues.
 */
export const SCHEDULER_LANES = [
  "inbox_triage",
  "pending_invite_checks",
  "followup_preparation",
  "feed_engagement"
] as const;

/**
 * Union of supported scheduler lane identifiers.
 */
export type SchedulerLane = (typeof SCHEDULER_LANES)[number];

/**
 * Scheduler lanes enabled by default when no explicit env override is set.
 */
export const DEFAULT_SCHEDULER_ENABLED_LANES: SchedulerLane[] = [
  "followup_preparation"
];

/** Default background poll interval for the local scheduler daemon. */
export const DEFAULT_SCHEDULER_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Default number of due jobs claimed and processed in one tick. */
export const DEFAULT_SCHEDULER_MAX_JOBS_PER_TICK = 2;
/** Default cap on active scheduler jobs tracked for one profile. */
export const DEFAULT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE = 100;
/** Default lease TTL applied when a worker claims scheduler jobs. */
export const DEFAULT_SCHEDULER_LEASE_TTL_MS = 2 * 60 * 1000;
/** Default delay between acceptance detection and follow-up preparation. */
export const DEFAULT_SCHEDULER_FOLLOWUP_DELAY_MS = 15 * 60 * 1000;
/** Default lookback window used when refreshing accepted connections. */
export const DEFAULT_SCHEDULER_FOLLOWUP_LOOKBACK_MS =
  30 * 24 * 60 * 60 * 1000;
/** Default maximum retry attempts for a scheduler job. */
export const DEFAULT_SCHEDULER_MAX_ATTEMPTS = 5;
/** Default initial retry backoff for retryable scheduler failures. */
export const DEFAULT_SCHEDULER_INITIAL_BACKOFF_MS = 5 * 60 * 1000;
/** Default cap for exponential scheduler retry backoff. */
export const DEFAULT_SCHEDULER_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** Default local business-hours start used by the scheduler. */
export const DEFAULT_SCHEDULER_BUSINESS_START = "09:00";
/** Default local business-hours end used by the scheduler. */
export const DEFAULT_SCHEDULER_BUSINESS_END = "17:00";
/** Default wake-up interval for the activity webhook daemon loop. */
export const DEFAULT_ACTIVITY_DAEMON_POLL_INTERVAL_MS = 60 * 1000;
/** Default number of due activity watches processed during one tick. */
export const DEFAULT_ACTIVITY_MAX_WATCHES_PER_TICK = 4;
/** Default cap on concurrently active activity watches per profile. */
export const DEFAULT_ACTIVITY_MAX_CONCURRENT_WATCHES = 20;
/** Default lease TTL for claimed activity watches. */
export const DEFAULT_ACTIVITY_WATCH_LEASE_TTL_MS = 2 * 60 * 1000;
/** Default minimum poll interval enforced across activity watches. */
export const DEFAULT_ACTIVITY_MIN_POLL_INTERVAL_MS = 60 * 1000;
/** Default number of webhook deliveries attempted during one tick. */
export const DEFAULT_ACTIVITY_MAX_DELIVERIES_PER_TICK = 12;
/** Default cap on queued webhook deliveries kept ready for dispatch. */
export const DEFAULT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH = 250;
/** Default lease TTL for claimed webhook delivery attempts. */
export const DEFAULT_ACTIVITY_DELIVERY_LEASE_TTL_MS = 60 * 1000;
/** Default request timeout applied to outbound webhook delivery. */
export const DEFAULT_ACTIVITY_DELIVERY_TIMEOUT_MS = 10 * 1000;
/** Default clock-skew allowance used when reclaiming expired activity leases. */
export const DEFAULT_ACTIVITY_CLOCK_SKEW_ALLOWANCE_MS = 5 * 1000;
/** Default maximum number of webhook delivery attempts. */
export const DEFAULT_ACTIVITY_MAX_DELIVERY_ATTEMPTS = 6;
/** Default initial backoff after a retryable webhook delivery failure. */
export const DEFAULT_ACTIVITY_INITIAL_BACKOFF_MS = 60 * 1000;
/** Default maximum backoff used for retryable webhook delivery failures. */
export const DEFAULT_ACTIVITY_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Business-hours window applied before the scheduler may prepare due work.
 */
export interface SchedulerBusinessHoursConfig {
  /** IANA timezone used to interpret the local business-hours window. */
  timeZone: string;
  /** Inclusive local start time in `HH:MM` 24-hour format. */
  startTime: string;
  /** Exclusive local end time in `HH:MM` 24-hour format. */
  endTime: string;
}

/**
 * Retry policy applied when scheduler jobs fail with retryable errors.
 */
export interface SchedulerRetryConfig {
  /** Maximum attempts before a job is marked failed. */
  maxAttempts: number;
  /** Initial retry delay used for the first retryable failure. */
  initialBackoffMs: number;
  /** Upper bound for exponential backoff growth. */
  maxBackoffMs: number;
}

/**
 * Resolved scheduler configuration shared by the CLI daemon and core service.
 */
export interface SchedulerConfig {
  /** Master on/off switch for scheduler work. */
  enabled: boolean;
  /** Delay between background daemon ticks. */
  pollIntervalMs: number;
  /** Maximum number of due jobs processed in one tick. */
  maxJobsPerTick: number;
  /** Maximum number of active jobs tracked for one profile. */
  maxActiveJobsPerProfile: number;
  /** Lease TTL used when a worker claims scheduler jobs. */
  leaseTtlMs: number;
  /** Enabled scheduler lanes after config validation and normalization. */
  enabledLanes: SchedulerLane[];
  /** Local business-hours window used for due-time alignment. */
  businessHours: SchedulerBusinessHoursConfig;
  /** Delay between acceptance detection and follow-up job due time. */
  followupDelayMs: number;
  /** Accepted-connection lookback window used during refresh. */
  followupLookbackMs: number;
  /** Retry policy for retryable scheduler failures. */
  retry: SchedulerRetryConfig;
}

/**
 * Retry policy applied when outbound webhook deliveries fail.
 */
export interface ActivityWebhookRetryConfig {
  /** Maximum attempts before a delivery is marked dead-letter. */
  maxAttempts: number;
  /** Initial retry delay used for the first retryable delivery failure. */
  initialBackoffMs: number;
  /** Upper bound for webhook delivery retry backoff growth. */
  maxBackoffMs: number;
}

/**
 * Resolved configuration shared by the activity watch daemon and core poller.
 */
export interface ActivityWebhookConfig {
  /** Master on/off switch for activity watch polling and delivery. */
  enabled: boolean;
  /** Delay between daemon wake-ups that claim due work. */
  daemonPollIntervalMs: number;
  /** Maximum number of due watches processed during one tick. */
  maxWatchesPerTick: number;
  /** Maximum number of active watches allowed for one profile. */
  maxConcurrentWatches: number;
  /** Lease TTL for claimed activity watches. */
  watchLeaseTtlMs: number;
  /** Minimum interval enforced between successive polls for one watch. */
  minPollIntervalMs: number;
  /** Maximum number of due deliveries processed during one tick. */
  maxDeliveriesPerTick: number;
  /** Maximum number of queued webhook deliveries buffered locally. */
  maxEventQueueDepth: number;
  /** Lease TTL for claimed delivery attempts. */
  deliveryLeaseTtlMs: number;
  /** HTTP timeout for one outbound webhook request. */
  deliveryTimeoutMs: number;
  /** Clock-skew allowance used before expiring leases or schedules. */
  clockSkewAllowanceMs: number;
  /** Retry policy for retryable webhook delivery failures. */
  retry: ActivityWebhookRetryConfig;
}

function isValidTimeZone(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveDefaultSchedulerTimeZone(): string {
  const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(systemTimeZone) ? systemTimeZone : "UTC";
}

function normalizeClockTime(
  value: string | undefined,
  fallback: string
): string {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) {
    return fallback;
  }

  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return fallback;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function compareClockTimes(left: string, right: string): number {
  const [leftHourText = "0", leftMinuteText = "0"] = left.split(":");
  const [rightHourText = "0", rightMinuteText = "0"] = right.split(":");
  const leftHour = Number.parseInt(leftHourText, 10);
  const leftMinute = Number.parseInt(leftMinuteText, 10);
  const rightHour = Number.parseInt(rightHourText, 10);
  const rightMinute = Number.parseInt(rightMinuteText, 10);

  return leftHour * 60 + leftMinute - (rightHour * 60 + rightMinute);
}

function invalidSchedulerConfig(
  message: string,
  details: Record<string, unknown>
): LinkedInBuddyError {
  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    message,
    details
  );
}

function invalidActivityWebhookConfig(
  message: string,
  details: Record<string, unknown>
): LinkedInBuddyError {
  const env = typeof details.env === "string" ? details.env : undefined;
  const guidance = env ? ACTIVITY_WEBHOOK_ENV_GUIDANCE[env] : undefined;
  let suggestion = guidance?.suggestion;
  let example = guidance ? `${env}=${guidance.exampleValue}` : undefined;

  if (
    env === "LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS" &&
    typeof details.initial_backoff_ms === "number"
  ) {
    const minimumSeconds = Math.ceil(details.initial_backoff_ms / 1_000);
    suggestion =
      `Increase ${env} to at least ${minimumSeconds}, or lower LINKEDIN_BUDDY_ACTIVITY_INITIAL_BACKOFF_SECONDS.`;
    example = `${env}=${minimumSeconds}`;
  }

  if (
    env === "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS" &&
    typeof details.delivery_timeout_ms === "number" &&
    typeof details.clock_skew_allowance_ms === "number"
  ) {
    const minimumSeconds = Math.ceil(
      (details.delivery_timeout_ms + details.clock_skew_allowance_ms) / 1_000
    );
    suggestion =
      `Increase ${env} to at least ${minimumSeconds}, or lower the delivery timeout or clock skew allowance.`;
    example = `${env}=${minimumSeconds}`;
  } else if (
    env === "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS" &&
    typeof details.clock_skew_allowance_ms === "number"
  ) {
    const minimumSeconds = Math.floor(details.clock_skew_allowance_ms / 1_000) + 1;
    suggestion =
      `Increase ${env} to more than ${Math.floor(details.clock_skew_allowance_ms / 1_000)}, or lower LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS.`;
    example = `${env}=${minimumSeconds}`;
  }

  if (
    env === "LINKEDIN_BUDDY_ACTIVITY_WATCH_LEASE_SECONDS" &&
    typeof details.clock_skew_allowance_ms === "number"
  ) {
    const minimumSeconds = Math.floor(details.clock_skew_allowance_ms / 1_000) + 1;
    suggestion =
      `Increase ${env} to more than ${Math.floor(details.clock_skew_allowance_ms / 1_000)}, or lower LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS.`;
    example = `${env}=${minimumSeconds}`;
  }

  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    message,
    {
      ...details,
      ...(guidance ? { default_value: guidance.defaultValue } : {}),
      ...(example ? { example } : {}),
      ...(suggestion ? { suggestion } : {})
    }
  );
}

function invalidEvasionConfig(
  message: string,
  details: Record<string, unknown>
): LinkedInBuddyError {
  const env = typeof details.env === "string" ? details.env : undefined;
  const guidance = env ? EVASION_ENV_GUIDANCE[env] : undefined;

  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    message,
    {
      ...details,
      ...(guidance ? { default_value: guidance.defaultValue } : {}),
      ...(guidance ? { example: `${env}=${guidance.exampleValue}` } : {}),
      ...(guidance ? { suggestion: guidance.suggestion } : {})
    }
  );
}

const ACTIVITY_WEBHOOK_ENV_GUIDANCE: Record<
  string,
  {
    defaultValue: string;
    exampleValue: string;
    suggestion: string;
  }
> = {
  LINKEDIN_BUDDY_ACTIVITY_ENABLED: {
    defaultValue: "true",
    exampleValue: "false",
    suggestion:
      "Use true or false to enable or disable activity polling, or unset the variable to restore the default."
  },
  LINKEDIN_BUDDY_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_DAEMON_POLL_INTERVAL_MS / 1_000),
    exampleValue: "120",
    suggestion:
      "Use a whole-number daemon interval in seconds, such as 120, or unset the variable to restore the default cadence."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_WATCHES_PER_TICK: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_WATCHES_PER_TICK),
    exampleValue: "8",
    suggestion:
      "Use a whole-number watch batch size, or unset the variable to restore the default per-tick watch budget."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_CONCURRENT_WATCHES: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_CONCURRENT_WATCHES),
    exampleValue: "50",
    suggestion:
      "Use a whole-number per-profile watch limit, or pause existing watches before raising the limit."
  },
  LINKEDIN_BUDDY_ACTIVITY_WATCH_LEASE_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_WATCH_LEASE_TTL_MS / 1_000),
    exampleValue: "180",
    suggestion:
      "Use a whole-number lease duration in seconds that comfortably exceeds clock skew and expected poll time."
  },
  LINKEDIN_BUDDY_ACTIVITY_MIN_POLL_INTERVAL_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_MIN_POLL_INTERVAL_MS / 1_000),
    exampleValue: "300",
    suggestion:
      "Use a whole-number minimum poll interval in seconds, or unset the variable to restore the default lower bound."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_DELIVERIES_PER_TICK: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_DELIVERIES_PER_TICK),
    exampleValue: "20",
    suggestion:
      "Use a whole-number delivery batch size, or unset the variable to restore the default per-tick delivery budget."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_EVENT_QUEUE_DEPTH: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH),
    exampleValue: "500",
    suggestion:
      "Use a whole-number queue depth large enough for bursts, or unset the variable to restore the default queue cap."
  },
  LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_DELIVERY_LEASE_TTL_MS / 1_000),
    exampleValue: "90",
    suggestion:
      "Use a whole-number delivery lease in seconds that exceeds the HTTP timeout and clock skew allowance."
  },
  LINKEDIN_BUDDY_ACTIVITY_DELIVERY_TIMEOUT_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_DELIVERY_TIMEOUT_MS / 1_000),
    exampleValue: "20",
    suggestion:
      "Use a whole-number webhook timeout in seconds that is lower than the delivery lease duration."
  },
  LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_CLOCK_SKEW_ALLOWANCE_MS / 1_000),
    exampleValue: "10",
    suggestion:
      "Use a whole-number clock-skew allowance in seconds, or unset the variable to restore the default tolerance."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_DELIVERY_ATTEMPTS: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_DELIVERY_ATTEMPTS),
    exampleValue: "8",
    suggestion:
      "Use a whole-number retry-attempt budget, or unset the variable to restore the default delivery retry count."
  },
  LINKEDIN_BUDDY_ACTIVITY_INITIAL_BACKOFF_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_INITIAL_BACKOFF_MS / 1_000),
    exampleValue: "120",
    suggestion:
      "Use a whole-number retry backoff in seconds, or unset the variable to restore the default initial backoff."
  },
  LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS: {
    defaultValue: String(DEFAULT_ACTIVITY_MAX_BACKOFF_MS / 1_000),
    exampleValue: "3600",
    suggestion:
      "Use a whole-number maximum backoff in seconds that is greater than or equal to the initial backoff."
  }
};

const EVASION_ENV_GUIDANCE: Record<
  string,
  {
    defaultValue: string;
    exampleValue: string;
    suggestion: string;
  }
> = {
  [LINKEDIN_BUDDY_EVASION_LEVEL_ENV]: {
    defaultValue: DEFAULT_EVASION_LEVEL,
    exampleValue: "paranoid",
    suggestion:
      "Use minimal for deterministic development and tests, moderate for the default balance, or paranoid for the fullest anti-bot profile."
  },
  [LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV]: {
    defaultValue: "false",
    exampleValue: "true",
    suggestion:
      "Use true to record debug evasion diagnostics in the run log, or unset the variable to restore the default quiet mode."
  }
};

function parseStrictBoolean(
  value: string | undefined,
  fallback: boolean,
  envName: string,
  invalidConfig: typeof invalidSchedulerConfig = invalidSchedulerConfig
): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw invalidConfig(
    `${envName} must use a boolean value: 1, 0, true, false, yes, no, on, or off. Unset it to use the default value.`,
    {
      env: envName,
      value,
      allowed_values: ["1", "0", "true", "false", "yes", "no", "on", "off"]
    }
  );
}

function parseStrictPositiveInteger(input: {
  envName: string;
  fallback: number;
  max?: number;
  min?: number;
  invalidConfig?: typeof invalidSchedulerConfig;
}): number {
  const invalidConfig = input.invalidConfig ?? invalidSchedulerConfig;
  const rawValue = process.env[input.envName];
  if (rawValue === undefined) {
    return input.fallback;
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw invalidConfig(
      `${input.envName} must be a whole number greater than 0. Unset it to use the default value.`,
      {
        env: input.envName,
        value: rawValue
      }
    );
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidConfig(
      `${input.envName} must be a whole number greater than 0. Unset it to use the default value.`,
      {
        env: input.envName,
        value: rawValue
      }
    );
  }

  if (typeof input.min === "number" && parsed < input.min) {
    throw invalidConfig(
      `${input.envName} must be at least ${input.min}. Unset it to use the default value.`,
      {
        env: input.envName,
        min: input.min,
        value: parsed
      }
    );
  }

  if (typeof input.max === "number" && parsed > input.max) {
    throw invalidConfig(
      `${input.envName} must be at most ${input.max}. Unset it to use the default value.`,
      {
        env: input.envName,
        max: input.max,
        value: parsed
      }
    );
  }

  return parsed;
}

function parseStrictClockTime(
  value: string | undefined,
  fallback: string,
  envName: string
): string {
  if (value === undefined) {
    return fallback;
  }

  const normalized = normalizeClockTime(value, "");
  if (!normalized) {
    throw invalidSchedulerConfig(
      `${envName} must use HH:MM 24-hour time, for example 09:00 or 17:30.`,
      {
        env: envName,
        value
      }
    );
  }

  return normalized;
}

function parseSchedulerEnabledLanes(value: string | undefined): SchedulerLane[] {
  if (value === undefined) {
    return [...DEFAULT_SCHEDULER_ENABLED_LANES];
  }

  const supported = new Set<string>(SCHEDULER_LANES);
  const rawEntries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (rawEntries.length === 0) {
    return [];
  }

  const invalidEntries = rawEntries.filter((entry) => !supported.has(entry));
  if (invalidEntries.length > 0) {
    throw invalidSchedulerConfig(
      "LINKEDIN_BUDDY_SCHEDULER_ENABLED_LANES must be a comma-separated list of supported scheduler lanes. Set it to an empty string to disable all lanes.",
      {
        env: "LINKEDIN_BUDDY_SCHEDULER_ENABLED_LANES",
        invalid_lanes: invalidEntries,
        supported_lanes: SCHEDULER_LANES
      }
    );
  }

  return [...new Set(rawEntries)] as SchedulerLane[];
}

function resolveSchedulerBusinessHours(): SchedulerBusinessHoursConfig {
  const startTime = parseStrictClockTime(
    process.env.LINKEDIN_BUDDY_SCHEDULER_BUSINESS_START,
    DEFAULT_SCHEDULER_BUSINESS_START,
    "LINKEDIN_BUDDY_SCHEDULER_BUSINESS_START"
  );
  const endTime = parseStrictClockTime(
    process.env.LINKEDIN_BUDDY_SCHEDULER_BUSINESS_END,
    DEFAULT_SCHEDULER_BUSINESS_END,
    "LINKEDIN_BUDDY_SCHEDULER_BUSINESS_END"
  );
  const rawTimeZone = process.env.LINKEDIN_BUDDY_SCHEDULER_TIMEZONE;
  const timeZone =
    rawTimeZone === undefined ? resolveDefaultSchedulerTimeZone() : rawTimeZone.trim();

  if (!timeZone || !isValidTimeZone(timeZone)) {
    throw invalidSchedulerConfig(
      "LINKEDIN_BUDDY_SCHEDULER_TIMEZONE must be a valid IANA timezone, such as UTC or Europe/Copenhagen. Unset it to use the local system timezone.",
      {
        env: "LINKEDIN_BUDDY_SCHEDULER_TIMEZONE",
        value: rawTimeZone
      }
    );
  }

  if (compareClockTimes(startTime, endTime) >= 0) {
    throw invalidSchedulerConfig(
      "Scheduler business hours must end after they start on the same local day, for example 09:00 to 17:00.",
      {
        start_time: startTime,
        end_time: endTime,
        time_zone: timeZone
      }
    );
  }

  return {
    timeZone,
    startTime,
    endTime
  };
}

/**
 * Environment variable that sets the default selector locale for the current
 * shell or process tree.
 */
export const LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV =
  "LINKEDIN_BUDDY_SELECTOR_LOCALE";

/**
 * Indicates where the effective selector-locale value came from.
 */
export type LinkedInSelectorLocaleConfigSource = "default" | "env" | "option";

/**
 * Detailed selector-locale resolution, including precedence source and any
 * fallback diagnostics.
 */
export interface LinkedInSelectorLocaleConfigResolution
  extends LinkedInSelectorLocaleResolution {
  source: LinkedInSelectorLocaleConfigSource;
}

/**
 * Controls whether selector-locale guidance is formatted for runtime logs or
 * end-user CLI output.
 */
export type LinkedInSelectorLocaleConfigWarningContext = "runtime" | "cli";

/**
 * Human-readable guidance for a selector-locale fallback.
 */
export interface LinkedInSelectorLocaleConfigWarning {
  message: string;
  actionTaken: string;
  guidance: string;
  supportedLocales: LinkedInSelectorLocale[];
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Resolves the base configuration directories for the current process.
 */
export function resolveConfigPaths(baseDir?: string): ConfigPaths {
  const resolvedBaseDir =
    baseDir ??
    process.env.LINKEDIN_BUDDY_HOME ??
    DEFAULT_LINKEDIN_BUDDY_HOME;

  return {
    baseDir: resolvedBaseDir,
    artifactsDir: path.join(resolvedBaseDir, "artifacts"),
    profilesDir: path.join(resolvedBaseDir, "profiles"),
    dbPath: path.join(resolvedBaseDir, "state.sqlite")
  };
}

/**
 * Ensures the configured state directories exist before the runtime writes to
 * them.
 */
export function ensureConfigPaths(paths: ConfigPaths): void {
  mkdirSync(paths.baseDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.profilesDir, { recursive: true });
}

/**
 * Resolves artifact capture limits from the environment.
 */
export function resolveConfirmFailureArtifactConfig(): ConfirmFailureArtifactConfig {
  return {
    traceMaxBytes: parsePositiveInteger(
      process.env.LINKEDIN_BUDDY_CONFIRM_TRACE_MAX_BYTES,
      DEFAULT_CONFIRM_TRACE_MAX_BYTES
    )
  };
}

/**
 * Resolves the effective anti-bot evasion configuration from runtime options
 * and environment variables.
 *
 * @example
 * ```ts
 * const evasion = resolveEvasionConfig({
 *   level: "paranoid",
 *   diagnosticsEnabled: true
 * });
 * ```
 */
export function resolveEvasionConfig(options: {
  diagnosticsEnabled?: boolean;
  level?: string | EvasionLevel;
} = {}): EvasionConfig {
  const defaultLevel = isFixtureReplayEnabled() ? "minimal" : DEFAULT_EVASION_LEVEL;
  const rawLevel =
    typeof options.level === "string"
      ? options.level
      : process.env[LINKEDIN_BUDDY_EVASION_LEVEL_ENV];
  const source =
    typeof options.level === "string"
      ? "option"
      : typeof process.env[LINKEDIN_BUDDY_EVASION_LEVEL_ENV] === "string"
        ? "env"
        : "default";
  const diagnosticsEnabled =
    typeof options.diagnosticsEnabled === "boolean"
      ? options.diagnosticsEnabled
      : parseStrictBoolean(
          process.env[LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV],
          false,
          LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV,
          invalidEvasionConfig
        );

  let level: EvasionLevel;
  try {
    level = resolveEvasionLevel(
      rawLevel,
      source === "option"
        ? "evasionLevel"
        : LINKEDIN_BUDDY_EVASION_LEVEL_ENV,
      defaultLevel
    );
  } catch (error) {
    if (source === "env" && error instanceof LinkedInBuddyError) {
      throw invalidEvasionConfig(
        `${LINKEDIN_BUDDY_EVASION_LEVEL_ENV} must be one of ${EVASION_LEVELS.join(", ")}. Unset it to use the default value.`,
        {
          env: LINKEDIN_BUDDY_EVASION_LEVEL_ENV,
          supported_values: [...EVASION_LEVELS],
          value: rawLevel
        }
      );
    }

    throw error;
  }

  return createEvasionStatus({
    diagnosticsEnabled,
    level,
    source
  });
}

/**
 * Resolves scheduler settings from environment variables.
 *
 * @remarks
 * This function validates business hours, lane names, and retry bounds up
 * front so the CLI can fail fast with actionable guidance before any work is
 * queued or prepared.
 */
export function resolveSchedulerConfig(): SchedulerConfig {
  const pollIntervalMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_SCHEDULER_POLL_INTERVAL_SECONDS",
      fallback: DEFAULT_SCHEDULER_POLL_INTERVAL_MS / 1_000,
      max: 24 * 60 * 60
    }) * 1_000;
  const maxJobsPerTick = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_SCHEDULER_MAX_JOBS_PER_TICK",
    fallback: DEFAULT_SCHEDULER_MAX_JOBS_PER_TICK,
    max: 100
  });
  const maxActiveJobsPerProfile = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE",
    fallback: DEFAULT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE,
    max: 10_000
  });
  const leaseTtlMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_SCHEDULER_LEASE_SECONDS",
      fallback: DEFAULT_SCHEDULER_LEASE_TTL_MS / 1_000,
      max: 24 * 60 * 60
    }) * 1_000;
  const enabledLanes = parseSchedulerEnabledLanes(
    process.env.LINKEDIN_BUDDY_SCHEDULER_ENABLED_LANES
  );
  const businessHours = resolveSchedulerBusinessHours();
  const followupDelayMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_SCHEDULER_FOLLOWUP_DELAY_MINUTES",
      fallback: DEFAULT_SCHEDULER_FOLLOWUP_DELAY_MS / (60 * 1_000),
      max: 30 * 24 * 60
    }) *
    60 *
    1_000;
  const followupLookbackMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_SCHEDULER_FOLLOWUP_LOOKBACK_DAYS",
      fallback: DEFAULT_SCHEDULER_FOLLOWUP_LOOKBACK_MS / (24 * 60 * 60 * 1_000),
      max: 365
    }) *
    24 *
    60 *
    60 *
    1_000;
  const retry = {
    maxAttempts: parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_SCHEDULER_MAX_ATTEMPTS",
      fallback: DEFAULT_SCHEDULER_MAX_ATTEMPTS,
      max: 100
    }),
    initialBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_BUDDY_SCHEDULER_INITIAL_BACKOFF_SECONDS",
        fallback: DEFAULT_SCHEDULER_INITIAL_BACKOFF_MS / 1_000,
        max: 30 * 24 * 60 * 60
      }) * 1_000,
    maxBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_BUDDY_SCHEDULER_MAX_BACKOFF_SECONDS",
        fallback: DEFAULT_SCHEDULER_MAX_BACKOFF_MS / 1_000,
        max: 30 * 24 * 60 * 60
      }) * 1_000
  };

  if (maxJobsPerTick > maxActiveJobsPerProfile) {
    throw invalidSchedulerConfig(
      "LINKEDIN_BUDDY_SCHEDULER_MAX_JOBS_PER_TICK must be less than or equal to LINKEDIN_BUDDY_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE.",
      {
        env: "LINKEDIN_BUDDY_SCHEDULER_MAX_JOBS_PER_TICK",
        max_jobs_per_tick: maxJobsPerTick,
        max_active_jobs_per_profile: maxActiveJobsPerProfile
      }
    );
  }

  if (retry.maxBackoffMs < retry.initialBackoffMs) {
    throw invalidSchedulerConfig(
      "LINKEDIN_BUDDY_SCHEDULER_MAX_BACKOFF_SECONDS must be greater than or equal to LINKEDIN_BUDDY_SCHEDULER_INITIAL_BACKOFF_SECONDS.",
      {
        env: "LINKEDIN_BUDDY_SCHEDULER_MAX_BACKOFF_SECONDS",
        initial_backoff_ms: retry.initialBackoffMs,
        max_backoff_ms: retry.maxBackoffMs
      }
    );
  }

  return {
    enabled: parseStrictBoolean(
      process.env.LINKEDIN_BUDDY_SCHEDULER_ENABLED,
      true,
      "LINKEDIN_BUDDY_SCHEDULER_ENABLED"
    ),
    pollIntervalMs,
    maxJobsPerTick,
    maxActiveJobsPerProfile,
    leaseTtlMs,
    enabledLanes,
    businessHours,
    followupDelayMs,
    followupLookbackMs,
    retry
  };
}

/**
 * Resolves activity watch daemon and webhook delivery settings from
 * environment variables.
 */
export function resolveActivityWebhookConfig(): ActivityWebhookConfig {
  const daemonPollIntervalMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_DAEMON_POLL_INTERVAL_SECONDS",
      fallback: DEFAULT_ACTIVITY_DAEMON_POLL_INTERVAL_MS / 1_000,
      max: 24 * 60 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const maxWatchesPerTick = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_WATCHES_PER_TICK",
    fallback: DEFAULT_ACTIVITY_MAX_WATCHES_PER_TICK,
    max: 100,
    invalidConfig: invalidActivityWebhookConfig
  });
  const maxConcurrentWatches = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_CONCURRENT_WATCHES",
    fallback: DEFAULT_ACTIVITY_MAX_CONCURRENT_WATCHES,
    max: 1_000,
    invalidConfig: invalidActivityWebhookConfig
  });
  const watchLeaseTtlMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_WATCH_LEASE_SECONDS",
      fallback: DEFAULT_ACTIVITY_WATCH_LEASE_TTL_MS / 1_000,
      max: 24 * 60 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const minPollIntervalMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_MIN_POLL_INTERVAL_SECONDS",
      fallback: DEFAULT_ACTIVITY_MIN_POLL_INTERVAL_MS / 1_000,
      max: 24 * 60 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const maxDeliveriesPerTick = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_DELIVERIES_PER_TICK",
    fallback: DEFAULT_ACTIVITY_MAX_DELIVERIES_PER_TICK,
    max: 1_000,
    invalidConfig: invalidActivityWebhookConfig
  });
  const maxEventQueueDepth = parseStrictPositiveInteger({
    envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_EVENT_QUEUE_DEPTH",
    fallback: DEFAULT_ACTIVITY_MAX_EVENT_QUEUE_DEPTH,
    max: 10_000,
    invalidConfig: invalidActivityWebhookConfig
  });
  const deliveryLeaseTtlMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS",
      fallback: DEFAULT_ACTIVITY_DELIVERY_LEASE_TTL_MS / 1_000,
      max: 24 * 60 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const deliveryTimeoutMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_TIMEOUT_SECONDS",
      fallback: DEFAULT_ACTIVITY_DELIVERY_TIMEOUT_MS / 1_000,
      max: 5 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const clockSkewAllowanceMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS",
      fallback: DEFAULT_ACTIVITY_CLOCK_SKEW_ALLOWANCE_MS / 1_000,
      max: 5 * 60,
      invalidConfig: invalidActivityWebhookConfig
    }) * 1_000;
  const retry: ActivityWebhookRetryConfig = {
    maxAttempts: parseStrictPositiveInteger({
      envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_DELIVERY_ATTEMPTS",
      fallback: DEFAULT_ACTIVITY_MAX_DELIVERY_ATTEMPTS,
      max: 25,
      invalidConfig: invalidActivityWebhookConfig
    }),
    initialBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_BUDDY_ACTIVITY_INITIAL_BACKOFF_SECONDS",
        fallback: DEFAULT_ACTIVITY_INITIAL_BACKOFF_MS / 1_000,
        max: 24 * 60 * 60,
        invalidConfig: invalidActivityWebhookConfig
      }) * 1_000,
    maxBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS",
        fallback: DEFAULT_ACTIVITY_MAX_BACKOFF_MS / 1_000,
        max: 7 * 24 * 60 * 60,
        invalidConfig: invalidActivityWebhookConfig
      }) * 1_000
  };

  if (retry.maxBackoffMs < retry.initialBackoffMs) {
    throw invalidActivityWebhookConfig(
      "LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS must be greater than or equal to LINKEDIN_BUDDY_ACTIVITY_INITIAL_BACKOFF_SECONDS.",
      {
        env: "LINKEDIN_BUDDY_ACTIVITY_MAX_BACKOFF_SECONDS",
        initial_backoff_ms: retry.initialBackoffMs,
        max_backoff_ms: retry.maxBackoffMs
      }
    );
  }

  if (deliveryLeaseTtlMs < deliveryTimeoutMs + clockSkewAllowanceMs) {
    throw invalidActivityWebhookConfig(
      "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS must be greater than or equal to LINKEDIN_BUDDY_ACTIVITY_DELIVERY_TIMEOUT_SECONDS plus LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS.",
      {
        env: "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS",
        delivery_lease_ttl_ms: deliveryLeaseTtlMs,
        delivery_timeout_ms: deliveryTimeoutMs,
        clock_skew_allowance_ms: clockSkewAllowanceMs
      }
    );
  }

  if (watchLeaseTtlMs <= clockSkewAllowanceMs) {
    throw invalidActivityWebhookConfig(
      "LINKEDIN_BUDDY_ACTIVITY_WATCH_LEASE_SECONDS must be greater than LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS.",
      {
        env: "LINKEDIN_BUDDY_ACTIVITY_WATCH_LEASE_SECONDS",
        watch_lease_ttl_ms: watchLeaseTtlMs,
        clock_skew_allowance_ms: clockSkewAllowanceMs
      }
    );
  }

  if (deliveryLeaseTtlMs <= clockSkewAllowanceMs) {
    throw invalidActivityWebhookConfig(
      "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS must be greater than LINKEDIN_BUDDY_ACTIVITY_CLOCK_SKEW_SECONDS.",
      {
        env: "LINKEDIN_BUDDY_ACTIVITY_DELIVERY_LEASE_SECONDS",
        delivery_lease_ttl_ms: deliveryLeaseTtlMs,
        clock_skew_allowance_ms: clockSkewAllowanceMs
      }
    );
  }

  return {
    enabled: parseStrictBoolean(
      process.env.LINKEDIN_BUDDY_ACTIVITY_ENABLED,
      true,
      "LINKEDIN_BUDDY_ACTIVITY_ENABLED",
      invalidActivityWebhookConfig
    ),
    daemonPollIntervalMs,
    maxWatchesPerTick,
    maxConcurrentWatches,
    watchLeaseTtlMs,
    minPollIntervalMs,
    maxDeliveriesPerTick,
    maxEventQueueDepth,
    deliveryLeaseTtlMs,
    deliveryTimeoutMs,
    clockSkewAllowanceMs,
    retry
  };
}

/**
 * Resolves the effective selector locale after applying option → env → default
 * precedence.
 */
export function resolveLinkedInSelectorLocaleConfig(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocale {
  return resolveLinkedInSelectorLocaleConfigResolution(selectorLocale).locale;
}

/**
 * Resolves selector-locale config with source and fallback diagnostics.
 *
 * @remarks
 * Explicit `selectorLocale` values win over
 * `LINKEDIN_BUDDY_SELECTOR_LOCALE`, which in turn wins over the default
 * English locale.
 */
export function resolveLinkedInSelectorLocaleConfigResolution(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocaleConfigResolution {
  const envSelectorLocale = process.env[LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV];
  const source: LinkedInSelectorLocaleConfigSource =
    selectorLocale === undefined
      ? envSelectorLocale === undefined
        ? "default"
        : "env"
      : "option";
  const resolution = resolveLinkedInSelectorLocaleResolution(
    source === "option" ? selectorLocale : envSelectorLocale
  );

  return {
    ...resolution,
    source
  };
}

function formatSelectorLocaleSourceLabel(
  source: LinkedInSelectorLocaleConfigSource,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  if (source === "env") {
    return LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV;
  }

  if (source === "option") {
    return context === "cli" ? "--selector-locale" : "selectorLocale option";
  }

  return "default selector locale";
}

function formatSelectorLocalePreview(
  normalizedInput: string | undefined
): string | null {
  return typeof normalizedInput === "string" && normalizedInput.length > 0
    ? `"${normalizedInput}"`
    : null;
}

function formatSelectorLocaleFallbackMessage(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  const sourceLabel = formatSelectorLocaleSourceLabel(resolution.source, context);
  const localePreview = formatSelectorLocalePreview(resolution.normalizedInput);

  switch (resolution.fallbackReason) {
    case "blank":
      return resolution.source === "env"
        ? `${sourceLabel} was set but blank.`
        : `${sourceLabel} was blank.`;
    case "invalid_format":
      return localePreview
        ? `Invalid selector locale ${localePreview} from ${sourceLabel}.`
        : `Invalid selector locale from ${sourceLabel}.`;
    case "too_long":
      return typeof resolution.inputLength === "number"
        ? `Selector locale from ${sourceLabel} is too long (${resolution.inputLength} characters).`
        : `Selector locale from ${sourceLabel} is too long.`;
    case "unsupported_locale":
    default:
      return localePreview
        ? `Unsupported selector locale ${localePreview} from ${sourceLabel}.`
        : `Unsupported selector locale from ${sourceLabel}.`;
  }
}

function formatSelectorLocaleExamples(
  reason: LinkedInSelectorLocaleFallbackReason | undefined
): string {
  return reason === "unsupported_locale"
    ? `Supported locales: ${LINKEDIN_SELECTOR_LOCALES.join(", ")}.`
    : `Supported locales: ${LINKEDIN_SELECTOR_LOCALES.join(", ")}. Use a locale tag like en, da, or da-DK.`;
}

function formatSelectorLocaleGuidance(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  const supportedLocalesMessage = formatSelectorLocaleExamples(
    resolution.fallbackReason
  );
  const normalizedTagMessage = "Region tags like da-DK normalize to da.";

  if (context === "cli") {
    if (resolution.source === "env") {
      return [
        supportedLocalesMessage,
        normalizedTagMessage,
        `Update ${LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV} or override it for one command with --selector-locale <locale>.`
      ].join(" ");
    }

    return [
      supportedLocalesMessage,
      normalizedTagMessage,
      "Pass --selector-locale <locale> or omit the flag to use the default English selectors."
    ].join(" ");
  }

  return [
    supportedLocalesMessage,
    normalizedTagMessage,
    `Pass a supported selectorLocale value or update ${LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV}.`
  ].join(" ");
}

function formatSelectorLocaleActionTaken(
  locale: LinkedInSelectorLocale
): string {
  const localeLabel =
    locale === DEFAULT_LINKEDIN_SELECTOR_LOCALE
      ? 'English ("en")'
      : `selector locale "${locale}"`;

  return `Using ${localeLabel} selector phrases for this run.`;
}

/**
 * Builds a human-readable warning when selector-locale config falls back away
 * from the requested input.
 */
export function getLinkedInSelectorLocaleConfigWarning(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext = "runtime"
): LinkedInSelectorLocaleConfigWarning | null {
  if (!resolution.fallbackUsed || resolution.source === "default") {
    return null;
  }

  return {
    message: formatSelectorLocaleFallbackMessage(resolution, context),
    actionTaken: formatSelectorLocaleActionTaken(resolution.locale),
    guidance: formatSelectorLocaleGuidance(resolution, context),
    supportedLocales: [...LINKEDIN_SELECTOR_LOCALES]
  };
}
