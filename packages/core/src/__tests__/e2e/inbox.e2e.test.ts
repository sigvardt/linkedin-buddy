import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Inbox E2E", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  it("list threads returns array with thread_id, title", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const threads = await runtime.inbox.listThreads({ limit: 20 });

    expect(Array.isArray(threads)).toBe(true);
    const [first] = threads;
    if (first) {
      expect(first.thread_id.length).toBeGreaterThan(0);
      expect(typeof first.title).toBe("string");
    }
  });

  it("list with limit respects parameter", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const threads = await runtime.inbox.listThreads({ limit: 5 });

    expect(threads.length).toBeLessThanOrEqual(5);
  });
});
