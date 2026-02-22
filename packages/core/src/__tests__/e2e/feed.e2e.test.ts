import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Feed E2E", () => {
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

  it("view feed returns posts array with author, text", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const posts = await runtime.feed.viewFeed({ limit: 5 });

    expect(Array.isArray(posts)).toBe(true);
    const [first] = posts;
    if (first) {
      expect(first.author_name.length).toBeGreaterThan(0);
      expect(typeof first.text).toBe("string");
    }
  });

  it("view feed with limit respects parameter", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const posts = await runtime.feed.viewFeed({ limit: 3 });

    expect(posts.length).toBeLessThanOrEqual(3);
  });
});
