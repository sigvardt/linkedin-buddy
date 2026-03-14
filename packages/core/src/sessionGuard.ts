import type { SessionHealthCheckResult } from "./auth/sessionHealthCheck.js";
import { checkStoredSessionHealth } from "./auth/sessionHealthCheck.js";
import { LinkedInBuddyError } from "./errors.js";
import { samplePoissonInterval } from "./evasion/math.js";
import type { IntervalSampleOptions } from "./evasion/types.js";

/**
 * Context provided to the session guard on each confirm call.
 */
export interface SessionGuardContext {
  /** The prepared action type (e.g. "inbox.send-message"). */
  actionType: string;
  /** The prepared action ID. */
  actionId: string;
  /** Override for `Date.now()` used in TTL calculations. */
  nowMs?: number;
}

/**
 * A guard function called before action executor dispatch.
 *
 * Implementations should throw `LinkedInBuddyError` with `AUTH_REQUIRED`
 * when the session is known to be unhealthy, and apply any inter-operation
 * pacing delay before returning.
 */
export type SessionGuardFn = (context: SessionGuardContext) => Promise<void>;

/**
 * Options for {@link createSessionGuard}.
 */
export interface SessionGuardOptions {
  /** Enable/disable the guard entirely. Default: `true`. */
  enabled?: boolean;
  /**
   * How long to cache a successful health-check result in milliseconds.
   * Set to `0` to disable caching (check every time).
   * Default: `60_000` (1 minute).
   */
  healthCacheTtlMs?: number;
  /**
   * Mean inter-operation delay in milliseconds (Poisson-distributed).
   * Set to `0` to disable pacing.
   * Default: `1_500`.
   */
  pacingMeanMs?: number;
  /** Minimum inter-operation delay. Default: `500`. */
  pacingMinMs?: number;
  /** Maximum inter-operation delay. Default: `5_000`. */
  pacingMaxMs?: number;
  /**
   * Sliding-window duration for operation frequency tracking in ms.
   * Default: `300_000` (5 minutes).
   */
  frequencyWindowMs?: number;
  /**
   * Number of operations within the frequency window that triggers a warning.
   * Default: `10`.
   */
  frequencyWarningThreshold?: number;
  /** Session name for health check. Default: `"default"`. */
  sessionName?: string;
  /** Base directory for session store. */
  baseDir?: string | undefined;
}

/** Minimal logger interface used by the session guard. */
export interface SessionGuardLogger {
  log(
    level: string,
    event: string,
    payload?: Record<string, unknown>
  ): unknown;
}

/**
 * Dependencies injected into {@link createSessionGuard}.
 *
 * All fields except `logger` are optional and fall back to production
 * implementations. Tests can inject stubs for `checkHealth`, `sleep`, and
 * `sampleInterval` to avoid side-effects and control timing.
 */
export interface SessionGuardDeps {
  logger: SessionGuardLogger;
  /** Override for `checkStoredSessionHealth`. */
  checkHealth?: (
    sessionName?: string,
    baseDir?: string
  ) => Promise<SessionHealthCheckResult>;
  /** Override for the async sleep used in pacing delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for `samplePoissonInterval`. */
  sampleInterval?: (
    meanMs: number,
    options?: IntervalSampleOptions
  ) => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HEALTH_CACHE_TTL_MS = 60_000;
const DEFAULT_PACING_MEAN_MS = 1_500;
const DEFAULT_PACING_MIN_MS = 500;
const DEFAULT_PACING_MAX_MS = 5_000;
const DEFAULT_FREQUENCY_WINDOW_MS = 300_000;
const DEFAULT_FREQUENCY_WARNING_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveNonNegative(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function resolvePositive(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Evict timestamps older than `windowMs` from the array and return the
 * pruned result. Mutates the source array to avoid allocation on the hot
 * path.
 */
function evictOldTimestamps(
  timestamps: number[],
  nowMs: number,
  windowMs: number
): number[] {
  const cutoff = nowMs - windowMs;
  let writeIndex = 0;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i]! > cutoff) {
      timestamps[writeIndex] = timestamps[i]!;
      writeIndex++;
    }
  }
  timestamps.length = writeIndex;
  return timestamps;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a session guard function that validates the stored session health
 * and applies inter-operation pacing before action executor dispatch.
 *
 * The returned function is designed to be passed as the `sessionGuard`
 * option to {@link TwoPhaseCommitService}.
 *
 * @example
 * ```ts
 * const guard = createSessionGuard(
 *   { logger },
 *   { pacingMeanMs: 2_000, frequencyWarningThreshold: 8 }
 * );
 * const tpc = new TwoPhaseCommitService(db, { sessionGuard: guard, ... });
 * ```
 */
export function createSessionGuard(
  deps: SessionGuardDeps,
  options?: SessionGuardOptions
): SessionGuardFn {
  const enabled = options?.enabled !== false;
  if (!enabled) {
    return async () => undefined;
  }

  const healthCacheTtlMs = resolveNonNegative(
    options?.healthCacheTtlMs,
    DEFAULT_HEALTH_CACHE_TTL_MS
  );
  const pacingMeanMs = resolveNonNegative(
    options?.pacingMeanMs,
    DEFAULT_PACING_MEAN_MS
  );
  const pacingMinMs = resolveNonNegative(
    options?.pacingMinMs,
    DEFAULT_PACING_MIN_MS
  );
  const pacingMaxMs = resolvePositive(
    options?.pacingMaxMs,
    DEFAULT_PACING_MAX_MS
  );
  const frequencyWindowMs = resolvePositive(
    options?.frequencyWindowMs,
    DEFAULT_FREQUENCY_WINDOW_MS
  );
  const frequencyWarningThreshold = resolvePositive(
    options?.frequencyWarningThreshold,
    DEFAULT_FREQUENCY_WARNING_THRESHOLD
  );
  const sessionName = options?.sessionName ?? "default";
  const baseDir = options?.baseDir;

  const logger = deps.logger;
  const checkHealth = deps.checkHealth ?? checkStoredSessionHealth;
  const sleep = deps.sleep ?? defaultSleep;
  const sampleInterval = deps.sampleInterval ?? samplePoissonInterval;

  // Closure-captured mutable state
  let cachedHealth: SessionHealthCheckResult | null = null;
  let cachedHealthAtMs = 0;
  let lastOperationMs = 0;
  const operationTimestamps: number[] = [];

  return async (context: SessionGuardContext): Promise<void> => {
    const nowMs = context.nowMs ?? Date.now();

    // -----------------------------------------------------------------
    // 1. Session health validation (with TTL cache)
    // -----------------------------------------------------------------
    const cacheExpired =
      healthCacheTtlMs === 0 ||
      cachedHealth === null ||
      nowMs - cachedHealthAtMs > healthCacheTtlMs;

    if (cacheExpired) {
      try {
        cachedHealth = await checkHealth(sessionName, baseDir);
        cachedHealthAtMs = nowMs;
      } catch (error) {
        // Health-check I/O failure: log and allow the operation to proceed.
        // The executor's own ensureAuthenticated() will catch real auth
        // failures during browser interaction.
        logger.log(
          "warn",
          "session_guard.health_check.io_error",
          {
            action_id: context.actionId,
            action_type: context.actionType,
            error:
              error instanceof Error ? error.message : String(error)
          }
        );
        cachedHealth = null;
      }
    }

    if (cachedHealth !== null && !cachedHealth.healthy) {
      logger.log("warn", "session_guard.health_check.unhealthy", {
        action_id: context.actionId,
        action_type: context.actionType,
        reason: cachedHealth.reason,
        guidance: cachedHealth.guidance,
        session_name: cachedHealth.sessionName,
        has_auth_cookie: cachedHealth.hasAuthCookie,
        auth_cookie_expires_in_ms: cachedHealth.authCookieExpiresInMs
      });

      throw new LinkedInBuddyError(
        "AUTH_REQUIRED",
        `Session guard: ${cachedHealth.reason} ${cachedHealth.guidance}`,
        {
          session_name: cachedHealth.sessionName,
          has_auth_cookie: cachedHealth.hasAuthCookie,
          auth_cookie_expires_at: cachedHealth.authCookieExpiresAt,
          auth_cookie_expires_in_ms: cachedHealth.authCookieExpiresInMs,
          guard_source: "session_guard"
        }
      );
    }

    // -----------------------------------------------------------------
    // 2. Operation frequency tracking + warning
    // -----------------------------------------------------------------
    evictOldTimestamps(operationTimestamps, nowMs, frequencyWindowMs);
    operationTimestamps.push(nowMs);

    if (operationTimestamps.length >= frequencyWarningThreshold) {
      logger.log("warn", "session_guard.frequency.high", {
        action_id: context.actionId,
        action_type: context.actionType,
        operations_in_window: operationTimestamps.length,
        window_ms: frequencyWindowMs,
        threshold: frequencyWarningThreshold,
        guidance:
          "High operation frequency may trigger LinkedIn bot detection. " +
          "Consider increasing delays between operations."
      });
    }

    // -----------------------------------------------------------------
    // 3. Inter-operation pacing delay
    // -----------------------------------------------------------------
    if (pacingMeanMs > 0 && lastOperationMs > 0) {
      const elapsedMs = nowMs - lastOperationMs;
      const targetDelayMs = sampleInterval(pacingMeanMs, {
        minIntervalMs: pacingMinMs,
        maxIntervalMs: pacingMaxMs
      });
      const remainingDelayMs = Math.max(0, targetDelayMs - elapsedMs);

      if (remainingDelayMs > 0) {
        logger.log("debug", "session_guard.pacing.delay", {
          action_id: context.actionId,
          action_type: context.actionType,
          target_delay_ms: targetDelayMs,
          elapsed_ms: elapsedMs,
          actual_delay_ms: remainingDelayMs
        });
        await sleep(remainingDelayMs);
      }
    }

    lastOperationMs = context.nowMs ?? Date.now();
  };
}
