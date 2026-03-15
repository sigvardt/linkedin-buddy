import { describe, expect, it } from "vitest";
import {
  SEARCH_CATEGORIES,
  buildSearchUrl,
  extractVanityName,
  readSearchLimit,
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

describe("readSearchLimit", () => {
  it("returns 10 for undefined", () => {
    expect(readSearchLimit(undefined)).toBe(10);
  });

  it("returns 10 for NaN", () => {
    expect(readSearchLimit(NaN)).toBe(10);
  });

  it("returns 10 for Infinity", () => {
    expect(readSearchLimit(Infinity)).toBe(10);
  });

  it("clamps to 1 for zero", () => {
    expect(readSearchLimit(0)).toBe(1);
  });

  it("clamps to 1 for negative values", () => {
    expect(readSearchLimit(-5)).toBe(1);
  });

  it("returns the value for valid positive integers", () => {
    expect(readSearchLimit(5)).toBe(5);
  });

  it("floors non-integer values", () => {
    expect(readSearchLimit(7.9)).toBe(7);
  });
});

describe("extractVanityName", () => {
  it("extracts from standard profile URL", () => {
    expect(extractVanityName("https://www.linkedin.com/in/johndoe")).toBe("johndoe");
  });

  it("extracts from URL with query params", () => {
    expect(extractVanityName("https://www.linkedin.com/in/johndoe?miniProfileUrn=abc")).toBe("johndoe");
  });

  it("extracts from URL with hash", () => {
    expect(extractVanityName("https://www.linkedin.com/in/johndoe#section")).toBe("johndoe");
  });

  it("returns null for company URL", () => {
    expect(extractVanityName("https://www.linkedin.com/company/google")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractVanityName("")).toBeNull();
  });

  it("decodes URI-encoded vanity names", () => {
    expect(extractVanityName("https://www.linkedin.com/in/caf%C3%A9")).toBe("café");
  });

  it("extracts from relative URL", () => {
    expect(extractVanityName("/in/janedoe")).toBe("janedoe");
  });
});
