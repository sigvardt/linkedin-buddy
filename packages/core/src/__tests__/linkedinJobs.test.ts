import { describe, expect, it, vi } from "vitest";
import {
  CREATE_JOB_ALERT_ACTION_TYPE,
  LinkedInJobsService,
  LINKEDIN_JOB_ALERT_FREQUENCIES,
  LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES,
  REMOVE_JOB_ALERT_ACTION_TYPE,
  SAVE_JOB_ACTION_TYPE,
  UNSAVE_JOB_ACTION_TYPE,
  buildJobAlertsManagementUrl,
  buildJobEasyApplyUrl,
  buildJobSearchUrl,
  buildJobViewUrl,
  createJobActionExecutors,
  normalizeLinkedInJobSearchUrl,
  type LinkedInEasyApplyPreview,
  type LinkedInJobAlert,
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

describe("buildJobAlertsManagementUrl", () => {
  it("builds the alerts management URL", () => {
    expect(buildJobAlertsManagementUrl()).toBe("https://www.linkedin.com/jobs/jam/");
  });
});

describe("buildJobEasyApplyUrl", () => {
  it("builds an easy apply URL from a job ID", () => {
    expect(buildJobEasyApplyUrl("1234567890")).toBe(
      "https://www.linkedin.com/jobs/view/1234567890/apply/?openSDUIApplyFlow=true"
    );
  });
});

describe("normalizeLinkedInJobSearchUrl", () => {
  it("normalizes relative LinkedIn search paths", () => {
    expect(
      normalizeLinkedInJobSearchUrl(
        "/jobs/search?keywords=software%20engineer&location=Copenhagen"
      )
    ).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=software+engineer&location=Copenhagen"
    );
  });

  it("drops tracking params and sorts remaining params", () => {
    expect(
      normalizeLinkedInJobSearchUrl(
        "https://www.linkedin.com/jobs/search?trk=foo&location=Copenhagen&keywords=software%20engineer&currentJobId=123"
      )
    ).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=software+engineer&location=Copenhagen"
    );
  });

  it("rejects non-LinkedIn URLs", () => {
    expect(() =>
      normalizeLinkedInJobSearchUrl("https://example.com/jobs/search?q=engineer")
    ).toThrow("searchUrl must point to a LinkedIn jobs search page.");
  });
});

describe("createJobActionExecutors", () => {
  it("registers all confirmable jobs action executors", () => {
    const executors = createJobActionExecutors();
    expect(Object.keys(executors)).toHaveLength(4);
    expect(executors[SAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[UNSAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInJobsService", () => {
  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = {
      peek: vi.fn((config: { counterKey: string; windowSizeMs: number; limit: number }) => ({
        counterKey: config.counterKey,
        windowStartMs: 0,
        windowSizeMs: config.windowSizeMs,
        count: 0,
        limit: config.limit,
        remaining: config.limit,
        allowed: true
      }))
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      prepare,
      service
    };
  }

  it("exports the service class", () => {
    expect(LinkedInJobsService).toBeDefined();
    expect(typeof LinkedInJobsService).toBe("function");
  });

  it("prepares save, unsave, and alert actions with rate-limited previews", () => {
    const { service, prepare } = createService();

    const savePrepared = service.prepareSaveJob({
      jobId: "123"
    });
    const unsavePrepared = service.prepareUnsaveJob({
      jobId: "123"
    });
    const createAlertPrepared = service.prepareCreateJobAlert({
      query: "software engineer",
      location: "Copenhagen"
    });
    const removeAlertPrepared = service.prepareRemoveJobAlert({
      searchUrl:
        "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
    });

    expect(savePrepared.preview).toMatchObject({
      summary: "Save LinkedIn job 123 for later",
      outbound: {
        action: "save_job"
      },
      target: {
        job_id: "123",
        profile_name: "default"
      }
    });
    expect(unsavePrepared.preview).toMatchObject({
      summary: "Remove LinkedIn job 123 from your saved jobs",
      outbound: {
        action: "unsave_job"
      }
    });
    expect(createAlertPrepared.preview).toMatchObject({
      summary: "Create LinkedIn job alert for software engineer in Copenhagen",
      outbound: {
        action: "create_job_alert"
      }
    });
    expect(removeAlertPrepared.preview).toMatchObject({
      summary:
        "Remove LinkedIn job alert https://www.linkedin.com/jobs/search/?keywords=software+engineer&location=Copenhagen",
      outbound: {
        action: "remove_job_alert"
      }
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: SAVE_JOB_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: UNSAVE_JOB_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ actionType: CREATE_JOB_ALERT_ACTION_TYPE })
    );
    expect(prepare).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ actionType: REMOVE_JOB_ALERT_ACTION_TYPE })
    );
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

  it("job alert interface types are importable", () => {
    const alert: LinkedInJobAlert = {
      alert_key: "https://www.linkedin.com/jobs/search/?keywords=software+engineer",
      query: "software engineer",
      location: "Copenhagen",
      search_url: "https://www.linkedin.com/jobs/search/?keywords=software+engineer",
      filters: ["Remote"],
      frequency: "daily",
      notification_type: "email_and_notification"
    };

    expect(alert.filters).toContain("Remote");
    expect(alert.frequency).toBe("daily");
  });

  it("easy apply preview interface types are importable", () => {
    const preview: LinkedInEasyApplyPreview = {
      job_id: "123",
      job_url: "https://www.linkedin.com/jobs/view/123/",
      application_url:
        "https://www.linkedin.com/jobs/view/123/apply/?openSDUIApplyFlow=true",
      title: "Senior Frontend Engineer",
      company: "Anthill",
      current_step: "Contact info",
      progress_percent: 0,
      next_action_label: "Next",
      submit_available: false,
      field_count: 2,
      required_field_count: 2,
      fields: [
        {
          field_key: "email::select",
          label: "Email address",
          input_type: "select",
          required: true,
          has_value: true,
          option_count: 3
        }
      ],
      preview_only: true
    };

    expect(preview.preview_only).toBe(true);
    expect(preview.required_field_count).toBe(2);
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
      "logger",
      "rateLimiter",
      "artifacts",
      "confirmFailureArtifacts",
      "twoPhaseCommit"
    ];
    expect(runtimeKeys).toHaveLength(8);
  });

  it("exports the supported alert frequency and notification enums", () => {
    expect(LINKEDIN_JOB_ALERT_FREQUENCIES).toContain("daily");
    expect(LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES).toContain(
      "email_and_notification"
    );
  });
});
