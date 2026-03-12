import { LinkedInBuddyError } from "./errors.js";
import type { AssistantDatabase } from "./db/database.js";

export interface ConsumeRateLimitInput {
  counterKey: string;
  windowSizeMs: number;
  limit: number;
  nowMs?: number;
}

export interface RateLimiterState {
  counterKey: string;
  windowStartMs: number;
  windowSizeMs: number;
  count: number;
  limit: number;
  remaining: number;
  allowed: boolean;
  /** Millisecond timestamp when the current rate-limit window ends. */
  windowEndsAtMs: number;
  /** Milliseconds until the current window resets (0 when already past). */
  retryAfterMs: number;
}

export interface ConsumeRateLimitOrThrowInput {
  config: ConsumeRateLimitInput;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Formats a human-readable description of the retry-after duration.
 *
 * @example
 * ```ts
 * formatRetryAfter(90_000);  // "1m 30s"
 * formatRetryAfter(3_600_000); // "1h 0m"
 * formatRetryAfter(0); // "now"
 * ```
 */
export function formatRetryAfter(retryAfterMs: number): string {
  if (retryAfterMs <= 0) {
    return "now";
  }

  const totalSeconds = Math.ceil(retryAfterMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function formatRateLimitState(
  state: RateLimiterState,
): Record<string, number | boolean | string> {
  return {
    counter_key: state.counterKey,
    window_start_ms: state.windowStartMs,
    window_size_ms: state.windowSizeMs,
    window_ends_at_ms: state.windowEndsAtMs,
    retry_after_ms: state.retryAfterMs,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    allowed: state.allowed,
  };
}

export function peekRateLimitPreview(
  rateLimiter: Pick<RateLimiter, "peek">,
  config: ConsumeRateLimitInput,
): Record<string, number | boolean | string> {
  return formatRateLimitState(rateLimiter.peek(config));
}

export function createConfirmRateLimitMessage(actionType: string): string {
  const actionName =
    actionType
      .split(".")
      .filter((segment) => segment.length > 0)
      .at(-1) ?? actionType;

  return `LinkedIn ${actionName} confirm is rate limited for the current window.`;
}

export function consumeRateLimitOrThrow(
  rateLimiter: Pick<RateLimiter, "consume">,
  input: ConsumeRateLimitOrThrowInput,
): RateLimiterState {
  const rateLimitState = rateLimiter.consume(input.config);

  if (!rateLimitState.allowed) {
    const retryHint =
      rateLimitState.retryAfterMs > 0
        ? ` Try again in ${formatRetryAfter(rateLimitState.retryAfterMs)}.`
        : "";

    throw new LinkedInBuddyError(
      "RATE_LIMITED",
      `${input.message}${retryHint}`,
      {
        ...(input.details ?? {}),
        rate_limit: formatRateLimitState(rateLimitState),
      },
    );
  }

  return rateLimitState;
}

function buildRateLimiterState(
  input: ConsumeRateLimitInput,
  windowStartMs: number,
  count: number,
  nowMs: number,
): RateLimiterState {
  const windowEndsAtMs = windowStartMs + input.windowSizeMs;
  const retryAfterMs = Math.max(0, windowEndsAtMs - nowMs);

  return {
    counterKey: input.counterKey,
    windowStartMs,
    windowSizeMs: input.windowSizeMs,
    count,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    allowed: count < input.limit,
    windowEndsAtMs,
    retryAfterMs,
  };
}

function buildConsumeRateLimiterState(
  input: ConsumeRateLimitInput,
  windowStartMs: number,
  count: number,
  nowMs: number,
): RateLimiterState {
  const windowEndsAtMs = windowStartMs + input.windowSizeMs;
  const retryAfterMs = Math.max(0, windowEndsAtMs - nowMs);

  return {
    counterKey: input.counterKey,
    windowStartMs,
    windowSizeMs: input.windowSizeMs,
    count,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    allowed: count <= input.limit,
    windowEndsAtMs,
    retryAfterMs,
  };
}

export class RateLimiter {
  constructor(private readonly db: AssistantDatabase) {}

  peek(input: ConsumeRateLimitInput): RateLimiterState {
    const nowMs = input.nowMs ?? Date.now();
    const windowStartMs =
      Math.floor(nowMs / input.windowSizeMs) * input.windowSizeMs;
    const existing = this.db.getRateLimitCounter(input.counterKey);

    const inSameWindow =
      existing &&
      existing.windowStartMs === windowStartMs &&
      existing.windowSizeMs === input.windowSizeMs;

    const count = inSameWindow ? existing.count : 0;

    return buildRateLimiterState(input, windowStartMs, count, nowMs);
  }

  consume(input: ConsumeRateLimitInput): RateLimiterState {
    const nowMs = input.nowMs ?? Date.now();
    const windowStartMs =
      Math.floor(nowMs / input.windowSizeMs) * input.windowSizeMs;
    const existing = this.db.getRateLimitCounter(input.counterKey);

    const inSameWindow =
      existing &&
      existing.windowStartMs === windowStartMs &&
      existing.windowSizeMs === input.windowSizeMs;

    const count = inSameWindow ? existing.count + 1 : 1;

    this.db.upsertRateLimitCounter({
      counterKey: input.counterKey,
      windowStartMs,
      windowSizeMs: input.windowSizeMs,
      count,
      updatedAtMs: nowMs,
    });

    return buildConsumeRateLimiterState(input, windowStartMs, count, nowMs);
  }
}
