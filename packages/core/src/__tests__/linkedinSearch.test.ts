import { describe, expect, it } from "vitest";
import {
  SEARCH_CATEGORIES,
  buildSearchUrl,
  isSearchCategory
} from "../linkedinSearch.js";

describe("buildSearchUrl", () => {
  it("builds people search URL", () => {
    expect(buildSearchUrl("john doe", "people")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=john%20doe"
    );
  });

  it("builds companies search URL", () => {
    expect(buildSearchUrl("google", "companies")).toBe(
      "https://www.linkedin.com/search/results/companies/?keywords=google"
    );
  });

  it("builds jobs search URL", () => {
    expect(buildSearchUrl("engineer", "jobs")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=engineer"
    );
  });

  it("builds posts search URL", () => {
    expect(buildSearchUrl("OpenAI", "posts")).toBe(
      "https://www.linkedin.com/search/results/content/?keywords=OpenAI"
    );
  });

  it("builds groups search URL", () => {
    expect(buildSearchUrl("marketing", "groups")).toBe(
      "https://www.linkedin.com/search/results/groups/?keywords=marketing"
    );
  });

  it("builds events search URL", () => {
    expect(buildSearchUrl("AI", "events")).toBe(
      "https://www.linkedin.com/search/results/events/?keywords=AI"
    );
  });

  it("defaults to people when no category given", () => {
    expect(buildSearchUrl("test")).toBe(
      "https://www.linkedin.com/search/results/people/?keywords=test"
    );
  });

  it("encodes special characters", () => {
    const url = buildSearchUrl("C++ developer", "people");
    expect(url).toContain("C%2B%2B");
  });

  it("exports the supported search categories", () => {
    expect(SEARCH_CATEGORIES).toEqual([
      "people",
      "companies",
      "jobs",
      "posts",
      "groups",
      "events"
    ]);
  });

  it("detects supported search categories", () => {
    expect(isSearchCategory("groups")).toBe(true);
    expect(isSearchCategory("topics")).toBe(false);
  });
});
