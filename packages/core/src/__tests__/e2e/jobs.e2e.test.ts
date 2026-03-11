import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Jobs E2E", () => {
  const e2e = setupE2ESuite();
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("search jobs returns structured results with count", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.jobs.searchJobs({
      query: "software engineer",
      limit: 5
    });

    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.results)).toBe(true);
    const [first] = result.results;
    if (first) {
      expect(first.title.length).toBeGreaterThan(0);
      expect(typeof first.company).toBe("string");
    }
  });

  it("prepares low-risk job tracker actions", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(runtime.jobs.prepareSaveJob({ jobId: "123" }).preview).toMatchObject({
      risk_level: "low",
      outbound: {
        action: "save"
      }
    });
    expect(runtime.jobs.prepareUnsaveJob({ jobId: "123" }).preview).toMatchObject({
      risk_level: "low",
      outbound: {
        action: "unsave"
      }
    });
    expect(
      runtime.jobs.prepareCreateJobAlert({
        query: "software engineer",
        location: "Remote"
      }).preview
    ).toMatchObject({
      risk_level: "low",
      outbound: {
        action: "create_alert"
      }
    });
    expect(
      await runtime.jobs.prepareRemoveJobAlert({
        query: "software engineer",
        location: "Remote"
      })
    ).toMatchObject({
      preview: expect.objectContaining({
        risk_level: "low",
        outbound: {
          action: "remove_alert"
        }
      })
    });
  });

  it("prepares high-risk Easy Apply actions", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const tempDir = mkdtempSync(path.join(tmpdir(), "linkedin-jobs-e2e-"));
    tempDirs.push(tempDir);
    const resumePath = path.join(tempDir, "resume.pdf");
    writeFileSync(resumePath, "resume");

    const prepared = runtime.jobs.prepareEasyApply({
      jobId: "123",
      email: "candidate@example.com",
      resumePath,
      answers: {
        "Years of experience": 5
      }
    });

    expect(prepared.preview).toMatchObject({
      risk_level: "high",
      outbound: expect.objectContaining({
        action: "easy_apply",
        email_supplied: true,
        resume_filename: "resume.pdf"
      })
    });
  });
});
