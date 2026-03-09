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
import { LinkedInAssistantError } from "./errors.js";

/**
 * Default directory used for tool-owned state when no custom home is configured.
 */
export const DEFAULT_LINKEDIN_ASSISTANT_HOME = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "linkedin-owa-agentools"
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
): LinkedInAssistantError {
  return new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    message,
    details
  );
}

function parseStrictBoolean(
  value: string | undefined,
  fallback: boolean,
  envName: string
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

  throw invalidSchedulerConfig(
    `${envName} must use a scheduler boolean value: 1, 0, true, false, yes, no, on, or off. Unset it to use the default value.`,
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
}): number {
  const rawValue = process.env[input.envName];
  if (rawValue === undefined) {
    return input.fallback;
  }

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw invalidSchedulerConfig(
      `${input.envName} must be a whole number greater than 0. Unset it to use the default value.`,
      {
        env: input.envName,
        value: rawValue
      }
    );
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidSchedulerConfig(
      `${input.envName} must be a whole number greater than 0. Unset it to use the default value.`,
      {
        env: input.envName,
        value: rawValue
      }
    );
  }

  if (typeof input.min === "number" && parsed < input.min) {
    throw invalidSchedulerConfig(
      `${input.envName} must be at least ${input.min}. Unset it to use the default value.`,
      {
        env: input.envName,
        min: input.min,
        value: parsed
      }
    );
  }

  if (typeof input.max === "number" && parsed > input.max) {
    throw invalidSchedulerConfig(
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
      "LINKEDIN_ASSISTANT_SCHEDULER_ENABLED_LANES must be a comma-separated list of supported scheduler lanes. Set it to an empty string to disable all lanes.",
      {
        env: "LINKEDIN_ASSISTANT_SCHEDULER_ENABLED_LANES",
        invalid_lanes: invalidEntries,
        supported_lanes: SCHEDULER_LANES
      }
    );
  }

  return [...new Set(rawEntries)] as SchedulerLane[];
}

function resolveSchedulerBusinessHours(): SchedulerBusinessHoursConfig {
  const startTime = parseStrictClockTime(
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_START,
    DEFAULT_SCHEDULER_BUSINESS_START,
    "LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_START"
  );
  const endTime = parseStrictClockTime(
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_END,
    DEFAULT_SCHEDULER_BUSINESS_END,
    "LINKEDIN_ASSISTANT_SCHEDULER_BUSINESS_END"
  );
  const rawTimeZone = process.env.LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE;
  const timeZone =
    rawTimeZone === undefined ? resolveDefaultSchedulerTimeZone() : rawTimeZone.trim();

  if (!timeZone || !isValidTimeZone(timeZone)) {
    throw invalidSchedulerConfig(
      "LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE must be a valid IANA timezone, such as UTC or Europe/Copenhagen. Unset it to use the local system timezone.",
      {
        env: "LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE",
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
export const LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV =
  "LINKEDIN_ASSISTANT_SELECTOR_LOCALE";

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
    process.env.LINKEDIN_ASSISTANT_HOME ??
    DEFAULT_LINKEDIN_ASSISTANT_HOME;

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
      process.env.LINKEDIN_ASSISTANT_CONFIRM_TRACE_MAX_BYTES,
      DEFAULT_CONFIRM_TRACE_MAX_BYTES
    )
  };
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
      envName: "LINKEDIN_ASSISTANT_SCHEDULER_POLL_INTERVAL_SECONDS",
      fallback: DEFAULT_SCHEDULER_POLL_INTERVAL_MS / 1_000,
      max: 24 * 60 * 60
    }) * 1_000;
  const maxJobsPerTick = parseStrictPositiveInteger({
    envName: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK",
    fallback: DEFAULT_SCHEDULER_MAX_JOBS_PER_TICK,
    max: 100
  });
  const maxActiveJobsPerProfile = parseStrictPositiveInteger({
    envName: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE",
    fallback: DEFAULT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE,
    max: 10_000
  });
  const leaseTtlMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_ASSISTANT_SCHEDULER_LEASE_SECONDS",
      fallback: DEFAULT_SCHEDULER_LEASE_TTL_MS / 1_000,
      max: 24 * 60 * 60
    }) * 1_000;
  const enabledLanes = parseSchedulerEnabledLanes(
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_ENABLED_LANES
  );
  const businessHours = resolveSchedulerBusinessHours();
  const followupDelayMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_DELAY_MINUTES",
      fallback: DEFAULT_SCHEDULER_FOLLOWUP_DELAY_MS / (60 * 1_000),
      max: 30 * 24 * 60
    }) *
    60 *
    1_000;
  const followupLookbackMs =
    parseStrictPositiveInteger({
      envName: "LINKEDIN_ASSISTANT_SCHEDULER_FOLLOWUP_LOOKBACK_DAYS",
      fallback: DEFAULT_SCHEDULER_FOLLOWUP_LOOKBACK_MS / (24 * 60 * 60 * 1_000),
      max: 365
    }) *
    24 *
    60 *
    60 *
    1_000;
  const retry = {
    maxAttempts: parseStrictPositiveInteger({
      envName: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_ATTEMPTS",
      fallback: DEFAULT_SCHEDULER_MAX_ATTEMPTS,
      max: 100
    }),
    initialBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_ASSISTANT_SCHEDULER_INITIAL_BACKOFF_SECONDS",
        fallback: DEFAULT_SCHEDULER_INITIAL_BACKOFF_MS / 1_000,
        max: 30 * 24 * 60 * 60
      }) * 1_000,
    maxBackoffMs:
      parseStrictPositiveInteger({
        envName: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_BACKOFF_SECONDS",
        fallback: DEFAULT_SCHEDULER_MAX_BACKOFF_MS / 1_000,
        max: 30 * 24 * 60 * 60
      }) * 1_000
  };

  if (maxJobsPerTick > maxActiveJobsPerProfile) {
    throw invalidSchedulerConfig(
      "LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK must be less than or equal to LINKEDIN_ASSISTANT_SCHEDULER_MAX_ACTIVE_JOBS_PER_PROFILE.",
      {
        env: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_JOBS_PER_TICK",
        max_jobs_per_tick: maxJobsPerTick,
        max_active_jobs_per_profile: maxActiveJobsPerProfile
      }
    );
  }

  if (retry.maxBackoffMs < retry.initialBackoffMs) {
    throw invalidSchedulerConfig(
      "LINKEDIN_ASSISTANT_SCHEDULER_MAX_BACKOFF_SECONDS must be greater than or equal to LINKEDIN_ASSISTANT_SCHEDULER_INITIAL_BACKOFF_SECONDS.",
      {
        env: "LINKEDIN_ASSISTANT_SCHEDULER_MAX_BACKOFF_SECONDS",
        initial_backoff_ms: retry.initialBackoffMs,
        max_backoff_ms: retry.maxBackoffMs
      }
    );
  }

  return {
    enabled: parseStrictBoolean(
      process.env.LINKEDIN_ASSISTANT_SCHEDULER_ENABLED,
      true,
      "LINKEDIN_ASSISTANT_SCHEDULER_ENABLED"
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
 * `LINKEDIN_ASSISTANT_SELECTOR_LOCALE`, which in turn wins over the default
 * English locale.
 */
export function resolveLinkedInSelectorLocaleConfigResolution(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocaleConfigResolution {
  const envSelectorLocale = process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
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
    return LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV;
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
        `Update ${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV} or override it for one command with --selector-locale <locale>.`
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
    `Pass a supported selectorLocale value or update ${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV}.`
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
