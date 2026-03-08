import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Inbox E2E", () => {
  const e2e = setupE2ESuite();

  it("list threads returns array with thread_id, title", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const threads = await runtime.inbox.listThreads({ limit: 20 });

    expect(Array.isArray(threads)).toBe(true);
    const [first] = threads;
    if (first) {
      expect(first.thread_id.length).toBeGreaterThan(0);
      expect(typeof first.title).toBe("string");
    }
  });

  it("list with limit respects parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const threads = await runtime.inbox.listThreads({ limit: 5 });

    expect(threads.length).toBeLessThanOrEqual(5);
  });
});
