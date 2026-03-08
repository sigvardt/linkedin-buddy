import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Jobs E2E", () => {
  const e2e = setupE2ESuite();

  it("search jobs returns structured results with count", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
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
