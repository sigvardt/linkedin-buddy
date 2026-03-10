import { describe, expect, it } from "vitest";
import {
  normalizeLinkedInCompanyPageUrl,
  resolveCompanyPageUrl
} from "../linkedinCompanyPages.js";

describe("resolveCompanyPageUrl", () => {
  it("accepts company slugs", () => {
    expect(resolveCompanyPageUrl("openai")).toBe(
      "https://www.linkedin.com/company/openai/"
    );
  });

  it("normalizes /company paths", () => {
    expect(resolveCompanyPageUrl("/company/microsoft/about/")).toBe(
      "https://www.linkedin.com/company/microsoft/"
    );
  });

  it("normalizes absolute LinkedIn company URLs", () => {
    expect(
      resolveCompanyPageUrl("https://www.linkedin.com/company/microsoft/jobs/")
    ).toBe("https://www.linkedin.com/company/microsoft/");
  });

  it("rejects non-company LinkedIn URLs", () => {
    expect(() =>
      resolveCompanyPageUrl("https://www.linkedin.com/in/someone/")
    ).toThrow("Company page URL must point to linkedin.com/company/.");
  });
});

describe("normalizeLinkedInCompanyPageUrl", () => {
  it("strips query strings and hashes", () => {
    expect(
      normalizeLinkedInCompanyPageUrl(
        "https://www.linkedin.com/company/openai/about/?foo=bar#fragment"
      )
    ).toBe("https://www.linkedin.com/company/openai/");
  });
});
