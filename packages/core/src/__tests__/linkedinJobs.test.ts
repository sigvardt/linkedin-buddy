import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_JOB_ALERT_ACTION_TYPE,
  EASY_APPLY_CITY_MAX_LENGTH,
  EASY_APPLY_COVER_LETTER_MAX_LENGTH,
  EASY_APPLY_EMAIL_MAX_LENGTH,
  EASY_APPLY_JOB_ACTION_TYPE,
  EASY_APPLY_PHONE_MAX_LENGTH,
  JOB_ALERTS_LIMIT_MAX,
  JOB_SEARCH_LIMIT_MAX,
  JOB_SEARCH_QUERY_MAX_LENGTH,
  LINKEDIN_JOB_ALERTS_URL,
  LinkedInJobsService,
  REMOVE_JOB_ALERT_ACTION_TYPE,
  SAVE_JOB_ACTION_TYPE,
  UNSAVE_JOB_ACTION_TYPE,
  buildJobAlertsUrl,
  buildJobSearchUrl,
  buildJobViewUrl,
  createJobActionExecutors,
  type LinkedInJobAlert,
  type LinkedInJobPosting,
  type LinkedInJobSearchResult,
  type LinkedInJobsRuntime,
  type SearchJobsInput,
  type ViewJobInput,
} from "../linkedinJobs.js";
import { createBlockedRateLimiterStub } from "./rateLimiterTestUtils.js";

describe("job URL builders", () => {
  it("builds a job search URL with query only", () => {
    expect(buildJobSearchUrl("software engineer")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=software%20engineer",
    );
  });

  it("builds a job search URL with query and location", () => {
    expect(buildJobSearchUrl("developer", "Copenhagen")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=developer&location=Copenhagen",
    );
  });

  it("builds the job detail and alerts URLs", () => {
    expect(buildJobViewUrl("1234567890")).toBe(
      "https://www.linkedin.com/jobs/view/1234567890/",
    );
    expect(buildJobAlertsUrl()).toBe(LINKEDIN_JOB_ALERTS_URL);
  });
});

describe("Jobs action type constants", () => {
  it("exposes the expected action identifiers", () => {
    expect(SAVE_JOB_ACTION_TYPE).toBe("jobs.save");
    expect(UNSAVE_JOB_ACTION_TYPE).toBe("jobs.unsave");
    expect(CREATE_JOB_ALERT_ACTION_TYPE).toBe("jobs.alerts.create");
    expect(REMOVE_JOB_ALERT_ACTION_TYPE).toBe("jobs.alerts.remove");
    expect(EASY_APPLY_JOB_ACTION_TYPE).toBe("jobs.easy_apply");
  });
});

describe("createJobActionExecutors", () => {
  it("registers all job action executors", () => {
    const executors = createJobActionExecutors();
    expect(Object.keys(executors)).toHaveLength(5);
    expect(executors[SAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[UNSAVE_JOB_ACTION_TYPE]).toBeDefined();
    expect(executors[CREATE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
    expect(executors[REMOVE_JOB_ALERT_ACTION_TYPE]).toBeDefined();
    expect(executors[EASY_APPLY_JOB_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInJobsService prepare actions", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      service,
      prepare,
    };
  }

  it("prepares low-risk tracker actions for save, unsave, and alerts", async () => {
    const { service, prepare } = createService();

    const savePrepared = service.prepareSaveJob({
      jobId: "123",
    });
    const unsavePrepared = service.prepareUnsaveJob({
      jobId: "123",
    });
    const createAlertPrepared = service.prepareCreateJobAlert({
      query: "staff engineer",
      location: "Remote",
    });
    const removeAlertPrepared = await service.prepareRemoveJobAlert({
      query: "staff engineer",
      location: "Remote",
    });

    expect(savePrepared.preview).toMatchObject({
      summary:
        "Save LinkedIn job https://www.linkedin.com/jobs/view/123/ for later",
      outbound: {
        action: "save",
      },
      risk_level: "low",
    });
    expect(unsavePrepared.preview).toMatchObject({
      summary: "Unsave LinkedIn job https://www.linkedin.com/jobs/view/123/",
      outbound: {
        action: "unsave",
      },
      risk_level: "low",
    });
    expect(createAlertPrepared.preview).toMatchObject({
      summary: 'Create a LinkedIn job alert for "staff engineer" in Remote',
      outbound: {
        action: "create_alert",
      },
      risk_level: "low",
    });
    expect(removeAlertPrepared.preview).toMatchObject({
      summary: 'Remove LinkedIn job alert for "staff engineer" in Remote',
      outbound: {
        action: "remove_alert",
      },
      risk_level: "low",
    });

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actionType: SAVE_JOB_ACTION_TYPE }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actionType: UNSAVE_JOB_ACTION_TYPE }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ actionType: CREATE_JOB_ALERT_ACTION_TYPE }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ actionType: REMOVE_JOB_ALERT_ACTION_TYPE }),
    );
  });

  it("prepares Easy Apply as a high-risk write with validated fields", () => {
    const { service, prepare } = createService();
    const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-jobs-test-"));
    tempDirs.push(tempDir);
    const resumePath = path.join(tempDir, "resume.pdf");
    writeFileSync(resumePath, "resume");

    const prepared = service.prepareEasyApply({
      jobId: "999",
      email: "candidate@example.com",
      phoneNumber: "+45 1234 5678",
      resumePath,
      answers: {
        "Years of experience": 8,
        "Need visa sponsorship": false,
      },
    });

    expect(prepared.preview).toMatchObject({
      summary:
        "Submit LinkedIn Easy Apply application for https://www.linkedin.com/jobs/view/999/",
      outbound: {
        action: "easy_apply",
        email_supplied: true,
        phone_number_supplied: true,
        resume_filename: "resume.pdf",
        answer_keys: ["Years of experience", "Need visa sponsorship"],
      },
      risk_level: "high",
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: EASY_APPLY_JOB_ACTION_TYPE }),
    );
  });

  it("rejects invalid Easy Apply answers and email values", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        email: "not-an-email",
      }),
    ).toThrow("email must look like a valid email address.");

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        answers: {
          unsupported: {
            nested: true,
          },
        },
      }),
    ).toThrow(
      "answers.unsupported must be a string, boolean, number, or string array.",
    );
  });
});

describe("LinkedInJobsService exports", () => {
  it("exports the service class and interface types", () => {
    expect(LinkedInJobsService).toBeDefined();
    expect(typeof LinkedInJobsService).toBe("function");

    const result: LinkedInJobSearchResult = {
      job_id: "123",
      title: "Software Engineer",
      company: "Acme Corp",
      location: "Remote",
      posted_at: "1 day ago",
      job_url: "https://www.linkedin.com/jobs/view/123/",
      salary_range: "$100k - $150k",
      employment_type: "Full-time",
    };
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
      is_remote: false,
    };
    const alert: LinkedInJobAlert = {
      alert_id: "alert-1",
      query: "Staff Engineer",
      location: "Remote",
      frequency: "Daily",
      search_url:
        "https://www.linkedin.com/jobs/search/?keywords=staff%20engineer&location=Remote",
      enabled: true,
    };
    const searchInput: SearchJobsInput = {
      query: "engineer",
    };
    const viewInput: ViewJobInput = {
      jobId: "789",
    };
    const runtimeKeys: (keyof LinkedInJobsRuntime)[] = [
      "auth",
      "cdpUrl",
      "profileManager",
      "logger",
      "rateLimiter",
      "artifacts",
      "confirmFailureArtifacts",
      "twoPhaseCommit",
    ];

    expect(result.job_id).toBe("123");
    expect(posting.job_id).toBe("456");
    expect(alert.enabled).toBe(true);
    expect(searchInput.query).toBe("engineer");
    expect(viewInput.jobId).toBe("789");
    expect(runtimeKeys).toHaveLength(8);
  });
});

describe("Jobs hardening constants", () => {
  it("exposes a positive finite JOB_SEARCH_QUERY_MAX_LENGTH", () => {
    expect(Number.isFinite(JOB_SEARCH_QUERY_MAX_LENGTH)).toBe(true);
    expect(JOB_SEARCH_QUERY_MAX_LENGTH).toBeGreaterThan(0);
  });

  it("exposes a positive finite JOB_SEARCH_LIMIT_MAX", () => {
    expect(Number.isFinite(JOB_SEARCH_LIMIT_MAX)).toBe(true);
    expect(JOB_SEARCH_LIMIT_MAX).toBeGreaterThan(0);
  });

  it("exposes a positive finite JOB_ALERTS_LIMIT_MAX", () => {
    expect(Number.isFinite(JOB_ALERTS_LIMIT_MAX)).toBe(true);
    expect(JOB_ALERTS_LIMIT_MAX).toBeGreaterThan(0);
  });

  it("exposes a positive finite EASY_APPLY_COVER_LETTER_MAX_LENGTH", () => {
    expect(Number.isFinite(EASY_APPLY_COVER_LETTER_MAX_LENGTH)).toBe(true);
    expect(EASY_APPLY_COVER_LETTER_MAX_LENGTH).toBeGreaterThan(0);
  });

  it("exposes a positive finite EASY_APPLY_PHONE_MAX_LENGTH", () => {
    expect(Number.isFinite(EASY_APPLY_PHONE_MAX_LENGTH)).toBe(true);
    expect(EASY_APPLY_PHONE_MAX_LENGTH).toBeGreaterThan(0);
  });

  it("exposes a positive finite EASY_APPLY_CITY_MAX_LENGTH", () => {
    expect(Number.isFinite(EASY_APPLY_CITY_MAX_LENGTH)).toBe(true);
    expect(EASY_APPLY_CITY_MAX_LENGTH).toBeGreaterThan(0);
  });

  it("exposes a positive finite EASY_APPLY_EMAIL_MAX_LENGTH", () => {
    expect(Number.isFinite(EASY_APPLY_EMAIL_MAX_LENGTH)).toBe(true);
    expect(EASY_APPLY_EMAIL_MAX_LENGTH).toBeGreaterThan(0);
  });
});

describe("LinkedInJobsService searchJobs input validation", () => {
  function createAsyncService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };
    const auth = {
      ensureAuthenticated: vi.fn(async () => undefined),
    };
    const profileManager = {
      runWithContext: vi.fn(
        async (_opts: unknown, cb: (ctx: unknown) => unknown) => {
          return cb({
            pages: () => [],
            newPage: async () => ({ goto: vi.fn(), waitForTimeout: vi.fn() }),
          });
        },
      ),
    };
    const logger = { log: vi.fn() };
    const artifacts = {
      resolve: vi.fn((p: string) => `/tmp/${p}`),
      registerArtifact: vi.fn(),
    };
    const confirmFailureArtifacts = { enabled: false, maxTraceBytes: 0 };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
      auth,
      profileManager,
      logger,
      artifacts,
      confirmFailureArtifacts,
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return { service, prepare, auth };
  }

  it("rejects empty query before authentication", async () => {
    const { service, auth } = createAsyncService();

    await expect(service.searchJobs({ query: "" })).rejects.toThrow(
      "query is required.",
    );
    expect(auth.ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only query before authentication", async () => {
    const { service, auth } = createAsyncService();

    await expect(service.searchJobs({ query: "   \n\t " })).rejects.toThrow(
      "query is required.",
    );
    expect(auth.ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects query exceeding max length before authentication", async () => {
    const { service, auth } = createAsyncService();

    await expect(
      service.searchJobs({
        query: "x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(
      `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
    expect(auth.ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects overlong query even when location and limit are provided", async () => {
    const { service, auth } = createAsyncService();

    await expect(
      service.searchJobs({
        query: "x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH + 1),
        location: "Remote",
        limit: 10,
      }),
    ).rejects.toThrow(
      `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
    expect(auth.ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects overlong trimmed query before authentication", async () => {
    const { service, auth } = createAsyncService();
    const overlongTrimmed = `${"x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH + 1)}   `;

    await expect(
      service.searchJobs({ query: overlongTrimmed }),
    ).rejects.toThrow(
      `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
    expect(auth.ensureAuthenticated).not.toHaveBeenCalled();
  });

  it("accepts query at max length and reaches authentication", async () => {
    const { service, auth } = createAsyncService();

    await expect(
      service.searchJobs({ query: "x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH) }),
    ).rejects.toThrow();
    expect(auth.ensureAuthenticated).toHaveBeenCalledTimes(1);
  });
});

describe("LinkedInJobsService prepareSaveJob and prepareUnsaveJob validation", () => {
  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      service,
      prepare,
    };
  }

  it("rejects empty jobId in prepareSaveJob", () => {
    const { service } = createService();

    expect(() => service.prepareSaveJob({ jobId: "" })).toThrow(
      "jobId is required.",
    );
  });

  it("rejects whitespace-only jobId in prepareSaveJob", () => {
    const { service } = createService();

    expect(() => service.prepareSaveJob({ jobId: " \n\t " })).toThrow(
      "jobId is required.",
    );
  });

  it("rejects empty jobId in prepareUnsaveJob", () => {
    const { service } = createService();

    expect(() => service.prepareUnsaveJob({ jobId: "" })).toThrow(
      "jobId is required.",
    );
  });

  it("passes valid jobId with trimming in prepareSaveJob", () => {
    const { service, prepare } = createService();

    service.prepareSaveJob({ jobId: " 123 " });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: SAVE_JOB_ACTION_TYPE,
        target: expect.objectContaining({
          job_id: "123",
          job_url: "https://www.linkedin.com/jobs/view/123/",
        }),
      }),
    );
  });
});

describe("LinkedInJobsService prepareCreateJobAlert validation", () => {
  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      service,
      prepare,
    };
  }

  it("rejects empty query", () => {
    const { service } = createService();

    expect(() => service.prepareCreateJobAlert({ query: "" })).toThrow(
      "query is required.",
    );
  });

  it("rejects whitespace-only query", () => {
    const { service } = createService();

    expect(() => service.prepareCreateJobAlert({ query: "\n\t " })).toThrow(
      "query is required.",
    );
  });

  it("rejects query exceeding max length", () => {
    const { service } = createService();

    expect(() =>
      service.prepareCreateJobAlert({
        query: "x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH + 1),
      }),
    ).toThrow(
      `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
  });

  it("accepts valid query with location", () => {
    const { service, prepare } = createService();

    service.prepareCreateJobAlert({
      query: " engineer ",
      location: " Remote ",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: CREATE_JOB_ALERT_ACTION_TYPE,
        target: expect.objectContaining({
          query: "engineer",
          location: "Remote",
          search_url:
            "https://www.linkedin.com/jobs/search/?keywords=engineer&location=Remote",
        }),
      }),
    );
  });
});

describe("LinkedInJobsService prepareEasyApply validation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      service,
      prepare,
    };
  }

  it("rejects empty jobId", () => {
    const { service } = createService();

    expect(() => service.prepareEasyApply({ jobId: "" })).toThrow(
      "jobId is required.",
    );
  });

  it("rejects invalid email value without domain separator", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({ jobId: "123", email: "foo" }),
    ).toThrow("email must look like a valid email address.");
  });

  it("rejects invalid email value with missing local-part", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({ jobId: "123", email: "@bar" }),
    ).toThrow("email must look like a valid email address.");
  });

  it("rejects invalid email value with missing domain", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({ jobId: "123", email: "a@" }),
    ).toThrow("email must look like a valid email address.");
  });

  it("rejects email exceeding max length", () => {
    const { service } = createService();
    const tooLongEmail = `${"a".repeat(EASY_APPLY_EMAIL_MAX_LENGTH)}@x.com`;

    expect(() =>
      service.prepareEasyApply({ jobId: "123", email: tooLongEmail }),
    ).toThrow(
      `email must not exceed ${EASY_APPLY_EMAIL_MAX_LENGTH} characters.`,
    );
  });

  it("accepts valid email", () => {
    const { service, prepare } = createService();

    service.prepareEasyApply({
      jobId: "123",
      email: "candidate@example.com",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: EASY_APPLY_JOB_ACTION_TYPE,
        payload: expect.objectContaining({
          email: "candidate@example.com",
        }),
      }),
    );
  });

  it("rejects non-existent resume path", () => {
    const { service } = createService();
    const missingPath = path.join(tmpdir(), `nonexistent-${Date.now()}.pdf`);

    expect(() =>
      service.prepareEasyApply({ jobId: "123", resumePath: missingPath }),
    ).toThrow("resumePath does not exist:");
  });

  it("rejects resume path pointing to directory", () => {
    const { service } = createService();
    const directory = mkdtempSync(path.join(tmpdir(), "linkedin-jobs-dir-"));
    tempDirs.push(directory);

    expect(() =>
      service.prepareEasyApply({ jobId: "123", resumePath: directory }),
    ).toThrow("resumePath must point to a file:");
  });

  it("rejects phone exceeding max length", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        phoneNumber: "1".repeat(EASY_APPLY_PHONE_MAX_LENGTH + 1),
      }),
    ).toThrow(
      `phoneNumber must not exceed ${EASY_APPLY_PHONE_MAX_LENGTH} characters.`,
    );
  });

  it("rejects city exceeding max length", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        city: "x".repeat(EASY_APPLY_CITY_MAX_LENGTH + 1),
      }),
    ).toThrow(`city must not exceed ${EASY_APPLY_CITY_MAX_LENGTH} characters.`);
  });

  it("rejects cover letter exceeding max length", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        coverLetter: "x".repeat(EASY_APPLY_COVER_LETTER_MAX_LENGTH + 1),
      }),
    ).toThrow(
      `coverLetter must not exceed ${EASY_APPLY_COVER_LETTER_MAX_LENGTH} characters.`,
    );
  });

  it("rejects Infinity numeric answers", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        answers: {
          "Years of experience": Number.POSITIVE_INFINITY,
        },
      }),
    ).toThrow("answers.Years of experience must be a finite number.");
  });

  it("rejects empty string array answers", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        answers: {
          technologies: ["", " "],
        },
      }),
    ).toThrow("answers.technologies must be a non-empty array of strings.");
  });

  it("rejects empty answer key name", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        answers: {
          "": "value",
        },
      }),
    ).toThrow("answers contains an empty field name.");
  });
});

describe("job action executors rate-limit rejection", () => {
  function createJobsConfirmRuntime() {
    const rateLimiter = createBlockedRateLimiterStub();
    const page = {
      screenshot: vi.fn(async () => undefined),
      url: vi.fn(() => "https://www.linkedin.com/jobs/view/123/"),
    };
    const context = {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      tracing: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async (options?: { path?: string }) => {
          if (options?.path) {
            writeFileSync(options.path, "trace");
          }
          return undefined;
        }),
      },
    };
    const runtime = {
      auth: { ensureAuthenticated: vi.fn(async () => undefined) },
      cdpUrl: undefined,
      profileManager: {
        runWithContext: vi.fn(
          async (
            _options: unknown,
            callback: (ctx: typeof context) => unknown,
          ) => callback(context),
        ),
      },
      rateLimiter,
      logger: { log: vi.fn() },
      artifacts: {
        resolve: vi.fn((relativePath: string) => `/tmp/${relativePath}`),
        registerArtifact: vi.fn(),
      },
      confirmFailureArtifacts: { enabled: false, maxTraceBytes: 0 },
    };
    return { page, rateLimiter, runtime };
  }

  it("rejects save confirm execution when rate limited", async () => {
    const executors = createJobActionExecutors();
    const { runtime } = createJobsConfirmRuntime();

    await expect(
      executors[SAVE_JOB_ACTION_TYPE]!.execute({
        runtime,
        action: {
          id: "act-save",
          target: {
            profile_name: "default",
            job_id: "123",
            job_url: "https://www.linkedin.com/jobs/view/123/",
          },
          payload: {},
        },
      } as never),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: {
        rate_limit: {
          counter_key: "linkedin.jobs.save",
        },
      },
    });
  });

  it("rejects unsave confirm execution when rate limited", async () => {
    const executors = createJobActionExecutors();
    const { runtime } = createJobsConfirmRuntime();

    await expect(
      executors[UNSAVE_JOB_ACTION_TYPE]!.execute({
        runtime,
        action: {
          id: "act-unsave",
          target: {
            profile_name: "default",
            job_id: "123",
            job_url: "https://www.linkedin.com/jobs/view/123/",
          },
          payload: {},
        },
      } as never),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: {
        rate_limit: {
          counter_key: "linkedin.jobs.unsave",
        },
      },
    });
  });

  it("rejects create alert confirm execution when rate limited", async () => {
    const executors = createJobActionExecutors();
    const { runtime } = createJobsConfirmRuntime();

    await expect(
      executors[CREATE_JOB_ALERT_ACTION_TYPE]!.execute({
        runtime,
        action: {
          id: "act-alert-create",
          target: {
            profile_name: "default",
            query: "engineer",
            search_url:
              "https://www.linkedin.com/jobs/search/?keywords=engineer",
            location: "",
          },
          payload: {},
        },
      } as never),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: {
        rate_limit: {
          counter_key: "linkedin.jobs.alerts.create",
        },
      },
    });
  });

  it("rejects remove alert confirm execution when rate limited", async () => {
    const executors = createJobActionExecutors();
    const { runtime } = createJobsConfirmRuntime();

    await expect(
      executors[REMOVE_JOB_ALERT_ACTION_TYPE]!.execute({
        runtime,
        action: {
          id: "act-alert-remove",
          target: {
            profile_name: "default",
            query: "engineer",
            search_url:
              "https://www.linkedin.com/jobs/search/?keywords=engineer",
            location: "",
          },
          payload: {},
        },
      } as never),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: {
        rate_limit: {
          counter_key: "linkedin.jobs.alerts.remove",
        },
      },
    });
  });

  it("rejects easy apply confirm execution when rate limited", async () => {
    const executors = createJobActionExecutors();
    const { runtime } = createJobsConfirmRuntime();

    await expect(
      executors[EASY_APPLY_JOB_ACTION_TYPE]!.execute({
        runtime,
        action: {
          id: "act-ea",
          target: {
            profile_name: "default",
            job_id: "123",
            job_url: "https://www.linkedin.com/jobs/view/123/",
          },
          payload: {},
        },
      } as never),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: {
        rate_limit: {
          counter_key: "linkedin.jobs.easy_apply",
        },
      },
    });
  });
});

describe("job URL builders edge cases", () => {
  it("encodes special characters in search query", () => {
    expect(buildJobSearchUrl("R&D engineer & manager")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=R%26D%20engineer%20%26%20manager",
    );
  });

  it("omits location when location is whitespace-only", () => {
    expect(buildJobSearchUrl("developer", "  \n\t ")).toBe(
      "https://www.linkedin.com/jobs/search/?keywords=developer",
    );
  });

  it("builds job view URL for numeric string ids", () => {
    expect(buildJobViewUrl("000123")).toBe(
      "https://www.linkedin.com/jobs/view/000123/",
    );
  });

  it("encodes URL-unsafe characters in job view ids", () => {
    expect(buildJobViewUrl("abc/123?#[]")).toBe(
      "https://www.linkedin.com/jobs/view/abc%2F123%3F%23%5B%5D/",
    );
  });

  it("returns stable LinkedIn job alerts URL constant", () => {
    expect(buildJobAlertsUrl()).toBe(LINKEDIN_JOB_ALERTS_URL);
    expect(LINKEDIN_JOB_ALERTS_URL).toBe(
      "https://www.linkedin.com/jobs/job-alerts/",
    );
  });
});

describe("LinkedInJobsService prepareRemoveJobAlert resolution", () => {
  function createService() {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const rateLimiter = {
      peek: vi.fn(
        (config: {
          counterKey: string;
          windowSizeMs: number;
          limit: number;
        }) => ({
          counterKey: config.counterKey,
          windowStartMs: 0,
          windowSizeMs: config.windowSizeMs,
          count: 0,
          limit: config.limit,
          remaining: config.limit,
          allowed: true,
        }),
      ),
    };

    const auth = {
      ensureAuthenticated: vi.fn(async () => undefined),
    };
    const profileManager = {
      runWithContext: vi.fn(
        async (_opts: unknown, cb: (ctx: unknown) => unknown) => cb({}),
      ),
    };

    const service = new LinkedInJobsService({
      twoPhaseCommit: { prepare },
      rateLimiter,
      auth,
      profileManager,
      logger: { log: vi.fn() },
      artifacts: {
        resolve: vi.fn((p: string) => `/tmp/${p}`),
        registerArtifact: vi.fn(),
      },
      confirmFailureArtifacts: { enabled: false, maxTraceBytes: 0 },
    } as unknown as ConstructorParameters<typeof LinkedInJobsService>[0]);

    return {
      service,
      prepare,
    };
  }

  it("resolves by searchUrl when provided", async () => {
    const { service, prepare } = createService();

    await service.prepareRemoveJobAlert({
      searchUrl:
        "https://www.linkedin.com/jobs/search/?keywords=backend%20engineer&location=Remote",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
        target: expect.objectContaining({
          query: "backend engineer",
          location: "Remote",
          search_url:
            "https://www.linkedin.com/jobs/search/?keywords=backend%20engineer&location=Remote",
        }),
      }),
    );
  });

  it("resolves by query when no alertId or searchUrl", async () => {
    const { service, prepare } = createService();

    await service.prepareRemoveJobAlert({
      query: "platform engineer",
      location: "Copenhagen",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
        target: expect.objectContaining({
          query: "platform engineer",
          location: "Copenhagen",
          search_url:
            "https://www.linkedin.com/jobs/search/?keywords=platform%20engineer&location=Copenhagen",
        }),
      }),
    );
  });

  it("rejects when no identifier is provided", async () => {
    const { service } = createService();

    await expect(service.prepareRemoveJobAlert({})).rejects.toThrow(
      "Provide alertId, searchUrl, or query to remove a job alert.",
    );
  });

  it("rejects when query exceeds max length", async () => {
    const { service } = createService();

    await expect(
      service.prepareRemoveJobAlert({
        query: "x".repeat(JOB_SEARCH_QUERY_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(
      `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
    );
  });
});
