import type { AssistantDatabase } from "./db/database.js";

export interface ConsumeRateLimitInput {
  counterKey: string;
  windowSizeMs: number;
  limit: number;
  nowMs?: number;
}

export interface RateLimitState {
  counterKey: string;
  windowStartMs: number;
  windowSizeMs: number;
  count: number;
  limit: number;
  remaining: number;
  allowed: boolean;
}

export class RateLimiter {
  constructor(private readonly db: AssistantDatabase) {}

  consume(input: ConsumeRateLimitInput): RateLimitState {
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
