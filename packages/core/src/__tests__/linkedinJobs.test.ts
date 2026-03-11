import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREATE_JOB_ALERT_ACTION_TYPE,
  EASY_APPLY_JOB_ACTION_TYPE,
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
  type ViewJobInput
} from "../linkedinJobs.js";

describe("job URL builders", () => {
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

  it("builds the job detail and alerts URLs", () => {
    expect(buildJobViewUrl("1234567890")).toBe(
      "https://www.linkedin.com/jobs/view/1234567890/"
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
      service,
      prepare
    };
  }

  it("prepares low-risk tracker actions for save, unsave, and alerts", async () => {
    const { service, prepare } = createService();

    const savePrepared = service.prepareSaveJob({
      jobId: "123"
    });
    const unsavePrepared = service.prepareUnsaveJob({
      jobId: "123"
    });
    const createAlertPrepared = service.prepareCreateJobAlert({
      query: "staff engineer",
      location: "Remote"
    });
    const removeAlertPrepared = await service.prepareRemoveJobAlert({
      query: "staff engineer",
      location: "Remote"
    });

    expect(savePrepared.preview).toMatchObject({
      summary: "Save LinkedIn job https://www.linkedin.com/jobs/view/123/ for later",
      outbound: {
        action: "save"
      },
      risk_level: "low"
    });
    expect(unsavePrepared.preview).toMatchObject({
      summary: "Unsave LinkedIn job https://www.linkedin.com/jobs/view/123/",
      outbound: {
        action: "unsave"
      },
      risk_level: "low"
    });
    expect(createAlertPrepared.preview).toMatchObject({
      summary: 'Create a LinkedIn job alert for "staff engineer" in Remote',
      outbound: {
        action: "create_alert"
      },
      risk_level: "low"
    });
    expect(removeAlertPrepared.preview).toMatchObject({
      summary: 'Remove LinkedIn job alert for "staff engineer" in Remote',
      outbound: {
        action: "remove_alert"
      },
      risk_level: "low"
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
        "Need visa sponsorship": false
      }
    });

    expect(prepared.preview).toMatchObject({
      summary: "Submit LinkedIn Easy Apply application for https://www.linkedin.com/jobs/view/999/",
      outbound: {
        action: "easy_apply",
        email_supplied: true,
        phone_number_supplied: true,
        resume_filename: "resume.pdf",
        answer_keys: ["Years of experience", "Need visa sponsorship"]
      },
      risk_level: "high"
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: EASY_APPLY_JOB_ACTION_TYPE })
    );
  });

  it("rejects invalid Easy Apply answers and email values", () => {
    const { service } = createService();

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        email: "not-an-email"
      })
    ).toThrow("email must look like a valid email address.");

    expect(() =>
      service.prepareEasyApply({
        jobId: "123",
        answers: {
          unsupported: {
            nested: true
          }
        }
      })
    ).toThrow("answers.unsupported must be a string, boolean, number, or string array.");
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
      employment_type: "Full-time"
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
      is_remote: false
    };
    const alert: LinkedInJobAlert = {
      alert_id: "alert-1",
      query: "Staff Engineer",
      location: "Remote",
      frequency: "Daily",
      search_url: "https://www.linkedin.com/jobs/search/?keywords=staff%20engineer&location=Remote",
      enabled: true
    };
    const searchInput: SearchJobsInput = {
      query: "engineer"
    };
    const viewInput: ViewJobInput = {
      jobId: "789"
    };
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

    expect(result.job_id).toBe("123");
    expect(posting.job_id).toBe("456");
    expect(alert.enabled).toBe(true);
    expect(searchInput.query).toBe("engineer");
    expect(viewInput.jobId).toBe("789");
    expect(runtimeKeys).toHaveLength(8);
  });
});
