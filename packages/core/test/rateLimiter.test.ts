import { describe, expect, it } from "vitest";
import { AssistantDatabase, RateLimiter } from "../src/index.js";

describe("rate limit counters", () => {
  it("increments counters inside the same window and blocks above limit", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const first = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 101
    });
    const second = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 550
    });
    const third = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 999
    });
    const fourth = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 3,
      nowMs: 999
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
      nowMs: 999
    });

    const nextWindow = limiter.consume({
      counterKey: "linkedin.session.status",
      windowSizeMs: 1_000,
      limit: 10,
      nowMs: 1_000
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
      nowMs: 10
    });
    const b = limiter.consume({
      counterKey: "tool.b",
      windowSizeMs: 60_000,
      limit: 5,
      nowMs: 10
    });

    expect(a.count).toBe(1);
    expect(b.count).toBe(1);

    db.close();
  });

  it("peek does not consume and get mirrors peek state", () => {
    const db = new AssistantDatabase(":memory:");
    const limiter = new RateLimiter(db);

    const peekBefore = limiter.peek({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000
    });
    const getBefore = limiter.get({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000
    });
    const consume = limiter.consume({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000
    });
    const peekAfter = limiter.peek({
      counterKey: "tool.peek",
      windowSizeMs: 60_000,
      limit: 2,
      nowMs: 1_000
    });

    expect(peekBefore.count).toBe(0);
    expect(getBefore.count).toBe(0);
    expect(consume.count).toBe(1);
    expect(peekAfter.count).toBe(1);
    expect(peekAfter.remaining).toBe(1);

    db.close();
  });
});
