import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Jobs E2E", () => {
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

  it("search jobs returns structured results with count", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      limit: 5
    });

    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.results)).toBe(true);
    const [first] = result.results;
    if (first) {
      expect(first.title.length).toBeGreaterThan(0);
      expect(typeof first.company).toBe("string");
    }
  });
});
