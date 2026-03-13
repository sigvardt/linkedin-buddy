import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkedInBuddyError } from "../../errors.js";
import {
  expectPreparedAction,
  expectRateLimitPreview,
  getJob
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

function expectJobSearchResultDataQuality(result: {
  job_id: string;
  title: string;
  company: string;
  location: string;
  posted_at: string;
  job_url: string;
}): void {
  expect(result.job_id.trim().length).toBeGreaterThan(0);
  expect(result.title.trim().length).toBeGreaterThan(0);
  expect(typeof result.company).toBe("string");
  expect(typeof result.location).toBe("string");
  expect(result.job_url).toContain("linkedin.com");
  expect(result.job_url.startsWith("https://")).toBe(true);
  expect(typeof result.posted_at).toBe("string");
}

function expectJobPostingDataQuality(posting: {
  title: string;
  company: string;
  company_url: string;
  location: string;
  description: string;
  posted_at: string;
  job_url: string;
}): void {
  expect(posting.title.trim().length).toBeGreaterThan(0);
  expect(posting.company.trim().length).toBeGreaterThan(0);
  expect(typeof posting.location).toBe("string");
  expect(posting.description.length).toBeGreaterThan(0);
  expect(posting.job_url).toContain("linkedin.com");
  expect(typeof posting.posted_at).toBe("string");
  expect(typeof posting.company_url).toBe("string");
}

function expectActionPreconditionFailed(error: unknown): void {
  expect(error).toBeInstanceOf(LinkedInBuddyError);
  if (error instanceof LinkedInBuddyError) {
    expect(error.code).toBe("ACTION_PRECONDITION_FAILED");
  }
}

describe("Jobs E2E", () => {
  const e2e = setupE2ESuite();
  const tempDirs: string[] = [];

  function createTempResumeFile(): string {
    const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-jobs-e2e-"));
    tempDirs.push(tempDir);
    const resumePath = path.join(tempDir, "resume.pdf");
    writeFileSync(resumePath, "resume");
    return resumePath;
  }

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("search jobs returns results with complete populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      location: "Copenhagen",
      limit: 5
    });

    expect(result.query).toBe("software engineer");
    expect(result.location).toBe("Copenhagen");
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.count).toBe(result.results.length);

    for (const entry of result.results) {
      expectJobSearchResultDataQuality(entry);
    }
  }, 60_000);

  it("search jobs respects requested limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      limit: 3
    });

    expect(result.results.length).toBeLessThanOrEqual(3);
    expect(result.count).toBe(result.results.length);
    for (const entry of result.results) {
      expectJobSearchResultDataQuality(entry);
    }
  }, 60_000);

  it("search jobs has no duplicate job ids", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      limit: 20
    });

    const nonEmptyIds = result.results
      .map((entry) => entry.job_id.trim())
      .filter((id) => id.length > 0);
    const uniqueIds = new Set(nonEmptyIds);

    expect(uniqueIds.size).toBe(nonEmptyIds.length);
  }, 60_000);

  it("search jobs returns job urls on linkedin domain", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      limit: 5
    });

    for (const entry of result.results) {
      expect(entry.job_url.startsWith("https://")).toBe(true);
      expect(entry.job_url).toContain("linkedin.com");
    }
  }, 60_000);

  it("view job returns complete populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const posting = await runtime.jobs.viewJob({ jobId: job.job_id });

    expectJobPostingDataQuality(posting);
    expect(posting.job_id).toBe(job.job_id);
  }, 60_000);

  it("view job keeps stable linkedin url and company string fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const posting = await runtime.jobs.viewJob({ jobId: job.job_id });

    expect(posting.job_url).toContain("linkedin.com");
    expect(typeof posting.company_url).toBe("string");
    expect(typeof posting.posted_at).toBe("string");
  }, 60_000);

  it("list job alerts returns array and count shape", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const alerts = await runtime.jobs.listJobAlerts({ limit: 5 });

    expect(Array.isArray(alerts.alerts)).toBe(true);
    expect(alerts.count).toBe(alerts.alerts.length);
    for (const alert of alerts.alerts) {
      expect(typeof alert.alert_id).toBe("string");
      expect(typeof alert.query).toBe("string");
      expect(typeof alert.location).toBe("string");
      expect(typeof alert.frequency).toBe("string");
      expect(typeof alert.search_url).toBe("string");
      expect(typeof alert.enabled).toBe("boolean");
    }
  }, 60_000);

  it("prepareSaveJob returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const prepared = runtime.jobs.prepareSaveJob({
      jobId: job.job_id
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.save");
    expect(prepared.preview.target).toMatchObject({
      job_id: job.job_id
    });
  }, 60_000);

  it("prepareUnsaveJob returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const prepared = runtime.jobs.prepareUnsaveJob({
      jobId: job.job_id
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.unsave");
  }, 60_000);

  it("prepareCreateJobAlert returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = runtime.jobs.prepareCreateJobAlert({
      query: "software engineer",
      location: "Copenhagen"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.alerts.create");
    expect(prepared.preview.target).toMatchObject({
      query: "software engineer"
    });
  }, 60_000);

  it("prepareRemoveJobAlert returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const prepared = await runtime.jobs.prepareRemoveJobAlert({
      query: "software engineer",
      location: "Copenhagen"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.alerts.remove");
  }, 60_000);

  it("prepareEasyApply returns valid preview with rate limit", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const resumePath = createTempResumeFile();
    const prepared = runtime.jobs.prepareEasyApply({
      jobId: job.job_id,
      email: "candidate@example.com",
      resumePath,
      answers: {
        "Years of experience": 5
      }
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.easy_apply");
    expect(prepared.preview.outbound).toMatchObject({
      action: "easy_apply",
      email_supplied: true,
      resume_filename: "resume.pdf"
    });
  }, 60_000);

  it("prepareEasyApply accepts structured answers in preview", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);
    const resumePath = createTempResumeFile();
    const prepared = runtime.jobs.prepareEasyApply({
      jobId: job.job_id,
      resumePath,
      answers: {
        "Years of experience": 7,
        Relocation: true
      }
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.jobs.easy_apply");
    expect(prepared.preview.outbound).toMatchObject({
      answer_keys: expect.arrayContaining(["Years of experience", "Relocation"])
    });
  }, 60_000);

  it("searchJobs rejects empty query with precondition error", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    await expect(runtime.jobs.searchJobs({ query: "" })).rejects.toBeInstanceOf(
      LinkedInBuddyError
    );
    await runtime.jobs.searchJobs({ query: "" }).catch((error: unknown) => {
      expectActionPreconditionFailed(error);
    });
  }, 60_000);

  it("prepareSaveJob rejects empty jobId with precondition error", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    try {
      runtime.jobs.prepareSaveJob({ jobId: "" });
      throw new Error("Expected prepareSaveJob to throw");
    } catch (error) {
      expectActionPreconditionFailed(error);
    }
  }, 60_000);

  it("prepareEasyApply rejects invalid email with precondition error", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const job = await getJob(runtime);

    try {
      runtime.jobs.prepareEasyApply({
        jobId: job.job_id,
        email: "not-an-email"
      });
      throw new Error("Expected prepareEasyApply to throw");
    } catch (error) {
      expectActionPreconditionFailed(error);
    }
  }, 60_000);
});
