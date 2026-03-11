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
}

export interface ConsumeRateLimitOrThrowInput {
  config: ConsumeRateLimitInput;
  message: string;
  details?: Record<string, unknown>;
}

export function formatRateLimitState(
  state: RateLimiterState
): Record<string, number | boolean | string> {
  return {
    counter_key: state.counterKey,
    window_start_ms: state.windowStartMs,
    window_size_ms: state.windowSizeMs,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    allowed: state.allowed
  };
}

export function peekRateLimitPreview(
  rateLimiter: Pick<RateLimiter, "peek">,
  config: ConsumeRateLimitInput
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
  input: ConsumeRateLimitOrThrowInput
): RateLimiterState {
  const rateLimitState = rateLimiter.consume(input.config);

  if (!rateLimitState.allowed) {
    throw new LinkedInBuddyError("RATE_LIMITED", input.message, {
      ...(input.details ?? {}),
      rate_limit: formatRateLimitState(rateLimitState)
    });
  }

  return rateLimitState;
}

export class RateLimiter {
  constructor(private readonly db: AssistantDatabase) {}

  peek(input: ConsumeRateLimitInput): RateLimiterState {
    const nowMs = input.nowMs ?? Date.now();
    const windowStartMs = Math.floor(nowMs / input.windowSizeMs) * input.windowSizeMs;
    const existing = this.db.getRateLimitCounter(input.counterKey);

    const inSameWindow =
      existing &&
      existing.windowStartMs === windowStartMs &&
      existing.windowSizeMs === input.windowSizeMs;

    const count = inSameWindow ? existing.count : 0;

    return {
      counterKey: input.counterKey,
      windowStartMs,
      windowSizeMs: input.windowSizeMs,
      count,
      limit: input.limit,
      remaining: Math.max(0, input.limit - count),
      allowed: count < input.limit
    };
  }

  get(input: ConsumeRateLimitInput): RateLimiterState {
    return this.peek(input);
  }

  consume(input: ConsumeRateLimitInput): RateLimiterState {
    const nowMs = input.nowMs ?? Date.now();
    const windowStartMs = Math.floor(nowMs / input.windowSizeMs) * input.windowSizeMs;
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
      updatedAtMs: nowMs
    });

    return {
      counterKey: input.counterKey,
      windowStartMs,
      windowSizeMs: input.windowSizeMs,
      count,
      limit: input.limit,
      remaining: Math.max(0, input.limit - count),
      allowed: count <= input.limit
    };
  }
}
