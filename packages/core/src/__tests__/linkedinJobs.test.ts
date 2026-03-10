import { describe, expect, it, vi } from "vitest";
import {
  CREATE_JOB_ALERT_ACTION_TYPE,
  EASY_APPLY_ACTION_TYPE,
  LINKEDIN_JOB_ALERT_FREQUENCIES,
  LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES,
  LinkedInJobsService,
  REMOVE_JOB_ALERT_ACTION_TYPE,
  SAVE_JOB_ACTION_TYPE,
  UNSAVE_JOB_ACTION_TYPE,
  buildJobSearchUrl,
  buildJobViewUrl,
  createJobActionExecutors,
  normalizeLinkedInJobAlertFrequency,
  normalizeLinkedInJobAlertNotificationType,
  resolveLinkedInJobId,
  type LinkedInJobPosting,
  type LinkedInJobsRuntime,
  type LinkedInJobSearchResult,
  type SearchJobsInput,
  type ViewJobInput
} from "../linkedinJobs.js";

function createRateLimitState(counterKey: string) {
  return {
    counterKey,
    windowStartMs: 0,
    windowSizeMs: 60_000,
    count: 0,
    limit: 10,
    remaining: 10,
    allowed: true
  };
}

function createPrepareResult(preview: Record<string, unknown>) {
  return {
    preparedActionId: "pa_test",
    confirmToken: "ct_test",
    expiresAtMs: 123,
    preview
  };
}

function createJobsServiceRuntime() {
  const prepare = vi.fn((input: { preview: Record<string, unknown> }) =>
    createPrepareResult(input.preview)
  );
  const ensureAuthenticated = vi.fn().mockResolvedValue(undefined);
  const runWithContext = vi.fn().mockResolvedValue({
    readyToConfirm: false,
    steps: [
      {
        stepIndex: 0,
        stepTitle: "Contact info",
        fields: [],
        availableActions: ["Continue to next step"]
      }
    ],
    fields: [
      {
        field_key: "resume",
        label: "Resume",
        input_type: "file",
        required: true,
        step_index: 0,
        step_title: "Contact info",
        supplied: false
      }
    ],
    blockingFields: [
      {
        field_key: "resume",
        label: "Resume",
        input_type: "file",
        required: true,
        step_index: 0,
        step_title: "Contact info",
        supplied: false
      }
    ]
  });
  const peek = vi.fn((input: { counterKey: string }) =>
    createRateLimitState(input.counterKey)
  );

  const runtime = {
    auth: {
      ensureAuthenticated
    },
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {
      runWithContext
    },
    logger: {
      log: vi.fn()
    },
    rateLimiter: {
      peek
    },
    artifacts: {},
    confirmFailureArtifacts: {},
    twoPhaseCommit: {
      prepare
    }
  } as unknown as LinkedInJobsRuntime;

  return {
    runtime,
    prepare,
    ensureAuthenticated,
    runWithContext,
    peek
  };
}

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
    expect(buildJobSearchUrl("tester", "")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=tester"
    );
  });

  it("ignores whitespace-only location", () => {
    expect(buildJobSearchUrl("tester", "   ")).toBe(
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

describe("Job action types and executors", () => {
  it("exports the expected action type constants", () => {
    expect(SAVE_JOB_ACTION_TYPE).toBe("jobs.save_job");
    expect(UNSAVE_JOB_ACTION_TYPE).toBe("jobs.unsave_job");
    expect(CREATE_JOB_ALERT_ACTION_TYPE).toBe("jobs.create_alert");
    expect(REMOVE_JOB_ALERT_ACTION_TYPE).toBe("jobs.remove_alert");
    expect(EASY_APPLY_ACTION_TYPE).toBe("jobs.easy_apply");
  });

  it("registers all five job action executors", () => {
    const executors = createJobActionExecutors();

    expect(Object.keys(executors)).toHaveLength(5);
    expect(executors[SAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[UNSAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
    expect(executors[EASY_APPLY_ACTION_TYPE]).toBeDefined();
  });

  it("exposes execute methods for every job action executor", () => {
    const executors = createJobActionExecutors();

    for (const executor of Object.values(executors)) {
      expect(typeof executor.execute).toBe("function");
    }
  });
});

describe("Job alert normalization", () => {
  it("exports the supported alert frequency and notification enums", () => {
    expect(LINKEDIN_JOB_ALERT_FREQUENCIES).toEqual(["daily", "weekly"]);
    expect(LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES).toEqual([
      "email_and_notification",
      "email",
      "notification"
    ]);
  });

  it("normalizes friendly job alert values", () => {
    expect(normalizeLinkedInJobAlertFrequency("weekly")).toBe("weekly");
    expect(normalizeLinkedInJobAlertFrequency("day")).toBe("daily");
    expect(normalizeLinkedInJobAlertNotificationType("both")).toBe(
      "email_and_notification"
    );
    expect(normalizeLinkedInJobAlertNotificationType("notification_only")).toBe(
      "notification"
    );
  });
});

describe("resolveLinkedInJobId", () => {
  it("keeps numeric job IDs intact", () => {
    expect(resolveLinkedInJobId("1234567890")).toBe("1234567890");
  });

  it("extracts the job ID from a LinkedIn job URL", () => {
    expect(
      resolveLinkedInJobId(
        "https://www.linkedin.com/jobs/view/1234567890/?trackingId=test"
      )
    ).toBe("1234567890");
  });

  it("falls back to currentJobId query parameters when needed", () => {
    expect(
      resolveLinkedInJobId(
        "https://www.linkedin.com/jobs/search/?currentJobId=987654321"
      )
    ).toBe("987654321");
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

  it("runtime interface shape includes confirm, locale, rate limit, and artifact dependencies", () => {
    const runtimeKeys: (keyof LinkedInJobsRuntime)[] = [
      "auth",
      "cdpUrl",
      "selectorLocale",
      "profileManager",
      "logger",
      "rateLimiter",
      "artifacts",
      "confirmFailureArtifacts",
      "twoPhaseCommit"
    ];
    expect(runtimeKeys).toHaveLength(9);
  });

  it("prepares save, unsave, create-alert, and remove-alert actions with targeted previews", () => {
    const { runtime, prepare, peek } = createJobsServiceRuntime();
    const service = new LinkedInJobsService(runtime);

    const savePrepared = service.prepareSaveJob({
      jobId: "1234567890"
    });
    const unsavePrepared = service.prepareUnsaveJob({
      profileName: "jobs-profile",
      jobId: "https://www.linkedin.com/jobs/view/1234567890/"
    });
    const createAlertPrepared = service.prepareCreateJobAlert({
      query: "software engineer",
      location: "Copenhagen",
      frequency: "weekly",
      notificationType: "email",
      includeSimilarJobs: true
    });
    const removeAlertPrepared = service.prepareRemoveJobAlert({
      alertId: "ja_abc123"
    });

    expect(savePrepared.preview).toMatchObject({
      summary: "Save LinkedIn job 1234567890 for later",
      target: {
        profile_name: "default",
        job_id: "1234567890"
      },
      outbound: {
        action: "save"
      }
    });
    expect(unsavePrepared.preview).toMatchObject({
      summary: "Unsave LinkedIn job 1234567890",
      target: {
        profile_name: "jobs-profile",
        job_id: "1234567890"
      },
      outbound: {
        action: "unsave"
      }
    });
    expect(createAlertPrepared.preview).toMatchObject({
      summary: "Create a LinkedIn job alert for software engineer in Copenhagen",
      target: {
        profile_name: "default",
        query: "software engineer",
        location: "Copenhagen"
      },
      outbound: {
        action: "create_alert",
        frequency: "weekly",
        notification_type: "email",
        include_similar_jobs: true
      }
    });
    expect(removeAlertPrepared.preview).toMatchObject({
      summary: "Remove LinkedIn job alert ja_abc123",
      target: {
        profile_name: "default",
        alert_id: "ja_abc123"
      },
      outbound: {
        action: "remove_alert"
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
    expect(peek).toHaveBeenCalledTimes(4);
  });

  it("prepares Easy Apply previews with surfaced blocking fields", async () => {
    const { runtime, prepare, ensureAuthenticated, runWithContext } =
      createJobsServiceRuntime();
    const service = new LinkedInJobsService(runtime);

    const prepared = await service.prepareEasyApply({
      profileName: "jobs-profile",
      jobId: "1234567890",
      application: {
        email: "person@example.com",
        answers: {
          sponsorship_required: false
        }
      }
    });

    expect(prepared.preview).toMatchObject({
      summary: "Prepare LinkedIn Easy Apply for job 1234567890",
      target: {
        profile_name: "jobs-profile",
        job_id: "1234567890"
      },
      outbound: {
        action: "easy_apply"
      },
      ready_to_confirm: false,
      blocking_fields: [
        expect.objectContaining({
          field_key: "resume",
          label: "Resume"
        })
      ],
      application_inputs_present: {
        email: true,
        phone_country_code: false,
        phone_number: false,
        resume_path: false,
        cover_letter_path: false,
        answer_count: 1
      }
    });

    expect(ensureAuthenticated).toHaveBeenCalledWith({
      profileName: "jobs-profile",
      cdpUrl: undefined
    });
    expect(runWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "jobs-profile",
        headless: true
      }),
      expect.any(Function)
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: EASY_APPLY_ACTION_TYPE })
    );
  });
});
