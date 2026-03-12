import { vi } from "vitest";
import type {
  ConsumeRateLimitInput,
  RateLimiterState,
} from "../rateLimiter.js";

export function createRateLimitState(
  input: ConsumeRateLimitInput,
  overrides: Partial<RateLimiterState> = {},
): RateLimiterState {
  const count = overrides.count ?? 0;
  const limit = overrides.limit ?? input.limit;
  const remaining = overrides.remaining ?? Math.max(0, limit - count);
  const windowStartMs = overrides.windowStartMs ?? 0;
  const windowSizeMs = overrides.windowSizeMs ?? input.windowSizeMs;
  const windowEndsAtMs =
    overrides.windowEndsAtMs ?? windowStartMs + windowSizeMs;
  const retryAfterMs = overrides.retryAfterMs ?? windowSizeMs;

  return {
    counterKey: overrides.counterKey ?? input.counterKey,
    windowStartMs,
    windowSizeMs,
    count,
    limit,
    remaining,
    allowed: overrides.allowed ?? count < limit,
    windowEndsAtMs,
    retryAfterMs,
  };
}

export function createAllowedRateLimiterStub() {
  return {
    peek: vi.fn((input: ConsumeRateLimitInput) => createRateLimitState(input)),
    consume: vi.fn((input: ConsumeRateLimitInput) =>
      createRateLimitState(input, {
        count: 1,
        remaining: Math.max(0, input.limit - 1),
        allowed: true,
      }),
    ),
  };
}

export function createBlockedRateLimiterStub() {
  return {
    peek: vi.fn((input: ConsumeRateLimitInput) =>
      createRateLimitState(input, {
        count: input.limit,
        remaining: 0,
        allowed: false,
      }),
    ),
    consume: vi.fn((input: ConsumeRateLimitInput) =>
      createRateLimitState(input, {
        count: input.limit + 1,
        remaining: 0,
        allowed: false,
      }),
    ),
  };
}
