import { describe, expect, it } from "vitest";
import { setupE2ESuite } from "./setup.js";

describe("Jobs E2E", () => {
  const e2e = setupE2ESuite();

  it("search jobs returns structured results with count", async () => {
    if (!e2e.canRun()) return;
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
