import { describe, expect, it, vi } from "vitest";
import {
  AssistantDatabase,
  LinkedInBuddyError,
  RateLimiter,
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  formatRateLimitState,
  formatRetryAfter,
  peekRateLimitPreview,
  type ConsumeRateLimitInput,
  type RateLimiterState,
} from "../src/index.js";

describe("rate limit counters", () => {
  it("increments counters inside the same window and blocks above limit", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const first = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 101,
    });
    const second = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 550,
    });
    const third = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 999,
    });
    const fourth = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 999,
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(third.count).toBe(3);
    expect(third.allowed).toBe(true);
    expect(fourth.count).toBe(4);
    expect(fourth.allowed).toBe(false);

    db.close();
  });

  it("resets counter at the next window boundary", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 10,
      nowMs: 999,
    });

    const nextWindow = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 10,
      nowMs: 1_000,
    });

    expect(nextWindow.count).toBe(1);
    expect(nextWindow.windowStartMs).toBe(1_000);

    db.close();
  });

  it("tracks keys independently", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const a = limiter.consume({
      counterKey: "tool.a",
      windowSizeMs: 60_000,
      limit: 5,
      nowMs: 10,
    });
    const b = limiter.consume({
      counterKey: "tool.b",
      windowSizeMs: 60_000,
      limit: 5,
      nowMs: 10,
    });

    expect(a.count).toBe(1);
    expect(b.count).toBe(1);

    db.close();
  });

  it("peek does not consume", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const peekBefore = limiter.peek({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000,
    });
    const consume = limiter.consume({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000,
    });
    const peekAfter = limiter.peek({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000,
    });

    expect(peekBefore.count).toBe(0);
    expect(consume.count).toBe(1);
    expect(peekAfter.count).toBe(1);
    expect(peekAfter.remaining).toBe(1);

    db.close();
  });

  it("consume at exact limit is allowed, next call is blocked", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const atLimit = limiter.consume({
      counterKey: "tool.boundary",
      windowSizeMs: 1_000,
      limit: 1,
      nowMs: 100,
    });
    const overLimit = limiter.consume({
      counterKey: "tool.boundary",
      windowSizeMs: 1_000,
      limit: 1,
      nowMs: 100,
    });

    expect(atLimit.count).toBe(1);
    expect(atLimit.allowed).toBe(true);
    expect(atLimit.remaining).toBe(0);
    expect(overLimit.count).toBe(2);
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.remaining).toBe(0);

    db.close();
  });

  it("same key with different window sizes are treated as same counter", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    limiter.consume({
      counterKey: "tool.shared",
      windowSizeMs: 60_000,
      limit: 10,
      nowMs: 1_000,
    });
    const result = limiter.peek({
      counterKey: "tool.shared",
      windowSizeMs: 120_000,
      limit: 10,
      nowMs: 1_000,
    });

    expect(result.count).toBe(0);

    db.close();
  });

  it("handles exact window boundary transition", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const inWindow = limiter.consume({
      counterKey: "tool.exact",
      windowSizeMs: 1_000,
      limit: 5,
      nowMs: 999,
    });
    const atBoundary = limiter.consume({
      counterKey: "tool.exact",
      windowSizeMs: 1_000,
      limit: 5,
      nowMs: 1_000,
    });

    expect(inWindow.windowStartMs).toBe(0);
    expect(inWindow.count).toBe(1);
    expect(atBoundary.windowStartMs).toBe(1_000);
    expect(atBoundary.count).toBe(1);

    db.close();
  });

  it("populates windowEndsAtMs and retryAfterMs", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const result = limiter.consume({
      counterKey: "tool.timing",
      windowSizeMs: 10_000,
      limit: 5,
      nowMs: 3_000,
    });

    expect(result.windowStartMs).toBe(0);
    expect(result.windowEndsAtMs).toBe(10_000);
    expect(result.retryAfterMs).toBe(7_000);

    const peek = limiter.peek({
      counterKey: "tool.timing",
      windowSizeMs: 10_000,
      limit: 5,
      nowMs: 8_000,
    });

    expect(peek.windowEndsAtMs).toBe(10_000);
    expect(peek.retryAfterMs).toBe(2_000);

    db.close();
  });
});

describe("formatRetryAfter", () => {
  it("returns 'now' for zero or negative values", () => {
    expect(formatRetryAfter(0)).toBe("now");
    expect(formatRetryAfter(-1_000)).toBe("now");
  });

  it("formats seconds only", () => {
    expect(formatRetryAfter(5_000)).toBe("5s");
    expect(formatRetryAfter(59_000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatRetryAfter(90_000)).toBe("1m 30s");
    expect(formatRetryAfter(60_000)).toBe("1m 0s");
  });

  it("formats hours and minutes", () => {
    expect(formatRetryAfter(3_600_000)).toBe("1h 0m");
    expect(formatRetryAfter(5_400_000)).toBe("1h 30m");
    expect(formatRetryAfter(86_400_000)).toBe("24h 0m");
  });

  it("rounds up partial seconds", () => {
    expect(formatRetryAfter(500)).toBe("1s");
    expect(formatRetryAfter(1_500)).toBe("2s");
  });
});

describe("formatRateLimitState", () => {
  it("maps camelCase state to snake_case record with timing fields", () => {
    const state: RateLimiterState = {
      counterKey: "linkedin.feed.like_post",
      windowStartMs: 3_600_000,
      windowSizeMs: 3_600_000,
      count: 5,
      limit: 30,
      remaining: 25,
      allowed: true,
      windowEndsAtMs: 7_200_000,
      retryAfterMs: 3_600_000,
    };

    const formatted = formatRateLimitState(state);

    expect(formatted).toEqual({
      counter_key: "linkedin.feed.like_post",
      window_start_ms: 3_600_000,
      window_size_ms: 3_600_000,
      window_ends_at_ms: 7_200_000,
      retry_after_ms: 3_600_000,
      count: 5,
      limit: 30,
      remaining: 25,
      allowed: true,
    });
  });

  it("includes all required fields for a blocked state", () => {
    const state: RateLimiterState = {
      counterKey: "test.key",
      windowStartMs: 0,
      windowSizeMs: 1_000,
      count: 10,
      limit: 5,
      remaining: 0,
      allowed: false,
      windowEndsAtMs: 1_000,
      retryAfterMs: 500,
    };

    const formatted = formatRateLimitState(state);
    expect(formatted.allowed).toBe(false);
    expect(formatted.remaining).toBe(0);
    expect(formatted.count).toBe(10);
    expect(formatted.window_ends_at_ms).toBe(1_000);
    expect(formatted.retry_after_ms).toBe(500);
  });
});

describe("peekRateLimitPreview", () => {
  it("returns formatted state from peek without consuming", () => {
    const peekState: RateLimiterState = {
      counterKey: "test.action",
      windowStartMs: 0,
      windowSizeMs: 60_000,
      count: 3,
      limit: 10,
      remaining: 7,
      allowed: true,
      windowEndsAtMs: 60_000,
      retryAfterMs: 59_000,
    };

    const rateLimiter = {
      peek: vi.fn().mockReturnValue(peekState),
    };

    const config: ConsumeRateLimitInput = {
      counterKey: "test.action",
      windowSizeMs: 60_000,
      limit: 10,
    };

    const preview = peekRateLimitPreview(rateLimiter, config);

    expect(rateLimiter.peek).toHaveBeenCalledWith(config);
    expect(preview).toEqual({
      counter_key: "test.action",
      window_start_ms: 0,
      window_size_ms: 60_000,
      window_ends_at_ms: 60_000,
      retry_after_ms: 59_000,
      count: 3,
      limit: 10,
      remaining: 7,
      allowed: true,
    });
  });
});

describe("createConfirmRateLimitMessage", () => {
  it("extracts last segment from dotted action type", () => {
    expect(createConfirmRateLimitMessage("feed.like_post")).toBe(
      "LinkedIn like_post confirm is rate limited for the current window.",
    );
  });

  it("extracts last segment from deeply nested action type", () => {
    expect(createConfirmRateLimitMessage("jobs.alerts.create")).toBe(
      "LinkedIn create confirm is rate limited for the current window.",
    );
  });

  it("returns full string for single-segment action type", () => {
    expect(createConfirmRateLimitMessage("like")).toBe(
      "LinkedIn like confirm is rate limited for the current window.",
    );
  });

  it("handles action type with leading dot", () => {
    expect(createConfirmRateLimitMessage(".send_message")).toBe(
      "LinkedIn send_message confirm is rate limited for the current window.",
    );
  });

  it("falls back to full string for empty action type", () => {
    expect(createConfirmRateLimitMessage("")).toBe(
      "LinkedIn  confirm is rate limited for the current window.",
    );
  });
});

describe("consumeRateLimitOrThrow", () => {
  it("returns state when allowed", () => {
    const allowedState: RateLimiterState = {
      counterKey: "test.action",
      windowStartMs: 0,
      windowSizeMs: 60_000,
      count: 1,
      limit: 10,
      remaining: 9,
      allowed: true,
      windowEndsAtMs: 60_000,
      retryAfterMs: 59_000,
    };

    const rateLimiter = {
      consume: vi.fn().mockReturnValue(allowedState),
    };

    const config: ConsumeRateLimitInput = {
      counterKey: "test.action",
      windowSizeMs: 60_000,
      limit: 10,
    };

    const result = consumeRateLimitOrThrow(rateLimiter, {
      config,
      message: "Test rate limited.",
      details: { action_id: "pa_123" },
    });

    expect(result).toBe(allowedState);
    expect(rateLimiter.consume).toHaveBeenCalledWith(config);
  });

  it("throws LinkedInBuddyError with RATE_LIMITED code when blocked", () => {
    const blockedState: RateLimiterState = {
      counterKey: "test.action",
      windowStartMs: 0,
      windowSizeMs: 60_000,
      count: 11,
      limit: 10,
      remaining: 0,
      allowed: false,
      windowEndsAtMs: 60_000,
      retryAfterMs: 30_000,
    };

    const rateLimiter = {
      consume: vi.fn().mockReturnValue(blockedState),
    };

    const config: ConsumeRateLimitInput = {
      counterKey: "test.action",
      windowSizeMs: 60_000,
      limit: 10,
    };

    try {
      consumeRateLimitOrThrow(rateLimiter, {
        config,
        message: "Test rate limited.",
        details: { action_id: "pa_456" },
      });
      expect.fail("Expected error to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      const buddyError = error as LinkedInBuddyError;
      expect(buddyError.code).toBe("RATE_LIMITED");
      expect(buddyError.message).toContain("Test rate limited.");
      expect(buddyError.message).toContain("Try again in 30s");
      expect(buddyError.details.action_id).toBe("pa_456");
      expect(buddyError.details.rate_limit).toEqual(
        formatRateLimitState(blockedState),
      );
    }
  });

  it("works without details", () => {
    const blockedState: RateLimiterState = {
      counterKey: "test.action",
      windowStartMs: 0,
      windowSizeMs: 60_000,
      count: 11,
      limit: 10,
      remaining: 0,
      allowed: false,
      windowEndsAtMs: 60_000,
      retryAfterMs: 0,
    };

    const rateLimiter = {
      consume: vi.fn().mockReturnValue(blockedState),
    };

    try {
      consumeRateLimitOrThrow(rateLimiter, {
        config: {
          counterKey: "test.action",
          windowSizeMs: 60_000,
          limit: 10,
        },
        message: "No details provided.",
      });
      expect.fail("Expected error to be thrown");
    } catch (error) {
      const buddyError = error as LinkedInBuddyError;
      expect(buddyError.details.rate_limit).toBeDefined();
      expect(Object.keys(buddyError.details)).toEqual(["rate_limit"]);
    }
  });

  it("omits retry hint when retryAfterMs is 0", () => {
    const blockedState: RateLimiterState = {
      counterKey: "test.action",
      windowStartMs: 0,
      windowSizeMs: 60_000,
      count: 11,
      limit: 10,
      remaining: 0,
      allowed: false,
      windowEndsAtMs: 60_000,
      retryAfterMs: 0,
    };

    const rateLimiter = {
      consume: vi.fn().mockReturnValue(blockedState),
    };

    try {
      consumeRateLimitOrThrow(rateLimiter, {
        config: {
          counterKey: "test.action",
          windowSizeMs: 60_000,
          limit: 10,
        },
        message: "Rate limited.",
      });
      expect.fail("Expected error to be thrown");
    } catch (error) {
      const buddyError = error as LinkedInBuddyError;
      expect(buddyError.message).toBe("Rate limited.");
      expect(buddyError.message).not.toContain("Try again");
    }
  });
});
