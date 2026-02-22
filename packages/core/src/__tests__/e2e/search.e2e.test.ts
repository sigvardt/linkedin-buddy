import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Search E2E", () => {
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

  it("search people Simon Miller returns results with name, headline", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
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

  it("search companies Power International returns results", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
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

  it("search jobs software engineer copenhagen returns results", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
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
