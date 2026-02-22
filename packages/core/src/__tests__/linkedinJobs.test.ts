import { describe, expect, it } from "vitest";
import {
  LinkedInJobsService,
  buildJobSearchUrl,
  buildJobViewUrl,
  type LinkedInJobSearchResult,
  type LinkedInJobPosting,
  type SearchJobsInput,
  type ViewJobInput,
  type LinkedInJobsRuntime
} from "../linkedinJobs.js";

describe("buildJobSearchUrl", () => {
  it("builds a job search URL with query only", () => {
    expect(buildJobSearchUrl("software engineer")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=software%20engineer"
    );
  });

  it("builds a job search URL with query and location", () => {
    expect(buildJobSearchUrl("developer", "Copenhagen")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=developer&location=Copenhagen"
    );
  });

  it("encodes special characters in query", () => {
    const url = buildJobSearchUrl("C++ developer");
    expect(url).toContain("C%2B%2B");
  });

  it("encodes special characters in location", () => {
    const url = buildJobSearchUrl("engineer", "São Paulo");
    expect(url).toContain("S%C3%A3o%20Paulo");
  });

  it("ignores empty location", () => {
    const url = buildJobSearchUrl("tester", "");
    expect(url).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=tester"
    );
  });

  it("ignores whitespace-only location", () => {
    const url = buildJobSearchUrl("tester", "   ");
    expect(url).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=tester"
    );
  });
});

describe("buildJobViewUrl", () => {
  it("builds a job view URL from a numeric ID", () => {
    expect(buildJobViewUrl("1234567890")).toBe(
      "https://www.linkedin.com/jobs/view/1234567890/"
    );
  });

  it("encodes special characters in job ID", () => {
    const url = buildJobViewUrl("abc/def");
    expect(url).toContain("abc%2Fdef");
  });
});

describe("LinkedInJobsService", () => {
  it("exports the service class", () => {
    expect(LinkedInJobsService).toBeDefined();
    expect(typeof LinkedInJobsService).toBe("function");
  });

  it("search result interface types are importable", () => {
    const result: LinkedInJobSearchResult = {
      job_id: "123",
      title: "Software Engineer",
      company: "Acme Corp",
      location: "Remote",
      posted_at: "1 day ago",
      job_url: "https://www.linkedin.com/jobs/view/123/",
      salary_range: "$100k - $150k",
      employment_type: "Full-time"
    };

    expect(result.job_id).toBe("123");
    expect(result.title).toBe("Software Engineer");
  });

  it("job posting interface types are importable", () => {
    const posting: LinkedInJobPosting = {
      job_id: "456",
      title: "Senior Developer",
      company: "Tech Inc",
      company_url: "https://www.linkedin.com/company/tech-inc/",
      location: "Copenhagen, Denmark",
      posted_at: "2 days ago",
      description: "We are looking for a senior developer...",
      salary_range: "",
      employment_type: "Full-time",
      job_url: "https://www.linkedin.com/jobs/view/456/",
      applicant_count: "25 applicants",
      seniority_level: "Mid-Senior level",
      is_remote: false
    };

    expect(posting.job_id).toBe("456");
    expect(posting.is_remote).toBe(false);
  });

  it("search input accepts optional fields", () => {
    const input: SearchJobsInput = {
      query: "engineer"
    };
    expect(input.profileName).toBeUndefined();
    expect(input.location).toBeUndefined();
    expect(input.limit).toBeUndefined();
  });

  it("view input requires jobId", () => {
    const input: ViewJobInput = {
      jobId: "789"
    };
    expect(input.jobId).toBe("789");
    expect(input.profileName).toBeUndefined();
  });

  it("runtime interface shape is correct", () => {
    const runtimeKeys: (keyof LinkedInJobsRuntime)[] = [
      "auth",
      "cdpUrl",
      "profileManager",
      "logger"
    ];
    expect(runtimeKeys).toHaveLength(4);
  });
});
