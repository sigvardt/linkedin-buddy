import { describe, expect, it } from "vitest";
import { buildSearchUrl } from "../linkedinSearch.js";

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
      "https://www.linkedin.com/search/results/jobs/?keywords=engineer"
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
});
