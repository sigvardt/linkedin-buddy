import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Search E2E", () => {
  const e2e = setupE2ESuite();

  it("search people Simon Miller returns results with name, headline", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.search.search({
      query: "Simon Miller",
      category: "people",
      limit: 5
    });

    if (result.category !== "people") {
      throw new Error("Expected people search result.");
    }

    expect(result.results.length).toBeGreaterThan(0);
    const [first] = result.results;
    expect(first).toBeDefined();
    if (first) {
      expect(first.name.length).toBeGreaterThan(0);
      expect(typeof first.headline).toBe("string");
    }
  });

  it("search companies Power International returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.search.search({
      query: "Power International",
      category: "companies",
      limit: 5
    });

    if (result.category !== "companies") {
      throw new Error("Expected companies search result.");
    }

    expect(result.results.length).toBeGreaterThan(0);
    const [first] = result.results;
    expect(first).toBeDefined();
    if (first) {
      expect(first.name.length).toBeGreaterThan(0);
    }
  });

  it("search jobs software engineer copenhagen returns results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.search.search({
      query: "software engineer copenhagen",
      category: "jobs",
      limit: 5
    });

    if (result.category !== "jobs") {
      throw new Error("Expected jobs search result.");
    }

    expect(result.results.length).toBeGreaterThan(0);
    const [first] = result.results;
    expect(first).toBeDefined();
    if (first) {
      expect(first.title.length).toBeGreaterThan(0);
      expect(typeof first.company).toBe("string");
    }
  });
});
