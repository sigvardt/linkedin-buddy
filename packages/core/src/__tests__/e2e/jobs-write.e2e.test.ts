import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectRateLimitPreview,
  getCliCoverageFixtures,
  getOptInEasyApplyJobId,
  isOptInEnabled
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const trackerConfirmTest = isOptInEnabled("LINKEDIN_E2E_ENABLE_JOB_TRACKER_CONFIRM")
  ? it
  : it.skip;
const easyApplyJobId = getOptInEasyApplyJobId();
const easyApplyPreviewTest =
  typeof easyApplyJobId === "string" && easyApplyJobId.length > 0 ? it : it.skip;

describe("Jobs Write E2E (tracker flows)", () => {
  const e2e = setupE2ESuite({
    fixtures: getCliCoverageFixtures,
    timeoutMs: 180_000
  });

  it("prepare returns valid previews for save, unsave, and alert actions", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const fixtures = e2e.fixtures();

    const save = runtime.jobs.prepareSaveJob({
      jobId: fixtures.jobId
    });
    const unsave = runtime.jobs.prepareUnsaveJob({
      jobId: fixtures.jobId
    });
    const createAlert = runtime.jobs.prepareCreateJobAlert({
      query: "software engineer",
      location: "Copenhagen"
    });
    const removeAlert = runtime.jobs.prepareRemoveJobAlert({
      searchUrl:
        "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
    });

    for (const prepared of [save, unsave, createAlert, removeAlert]) {
      expectPreparedAction(prepared);
    }

    expectRateLimitPreview(save.preview, "linkedin.jobs.save");
    expectRateLimitPreview(unsave.preview, "linkedin.jobs.unsave");
    expectRateLimitPreview(createAlert.preview, "linkedin.jobs.alerts.create");
    expectRateLimitPreview(removeAlert.preview, "linkedin.jobs.alerts.remove");
  });

  trackerConfirmTest("confirms save, unsave, alert create, and alert remove", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const fixtures = e2e.fixtures();

    const savePrepared = runtime.jobs.prepareSaveJob({
      jobId: fixtures.jobId,
      operatorNote: "Automated E2E job save write test"
    });
    const saveResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: savePrepared.confirmToken
    });
    expect(saveResult.status).toBe("executed");
    expect(saveResult.actionType).toBe("jobs.save");
    expect(saveResult.result).toMatchObject({
      job_id: fixtures.jobId,
      saved: true
    });

    const unsavePrepared = runtime.jobs.prepareUnsaveJob({
      jobId: fixtures.jobId,
      operatorNote: "Automated E2E job unsave write test"
    });
    const unsaveResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: unsavePrepared.confirmToken
    });
    expect(unsaveResult.status).toBe("executed");
    expect(unsaveResult.actionType).toBe("jobs.unsave");
    expect(unsaveResult.result).toMatchObject({
      job_id: fixtures.jobId,
      saved: false
    });

    const createAlertPrepared = runtime.jobs.prepareCreateJobAlert({
      query: "software engineer",
      location: "Copenhagen",
      operatorNote: "Automated E2E job alert create test"
    });
    const createAlertResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: createAlertPrepared.confirmToken
    });
    expect(createAlertResult.status).toBe("executed");
    expect(createAlertResult.actionType).toBe("jobs.alerts.create");
    expect(createAlertResult.result).toMatchObject({
      alert_created: true,
      query: "software engineer"
    });

    const createdSearchUrl =
      typeof createAlertResult.result.search_url === "string"
        ? createAlertResult.result.search_url
        : "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen";

    const removeAlertPrepared = runtime.jobs.prepareRemoveJobAlert({
      searchUrl: createdSearchUrl,
      operatorNote: "Automated E2E job alert remove test"
    });
    const removeAlertResult = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: removeAlertPrepared.confirmToken
    });
    expect(removeAlertResult.status).toBe("executed");
    expect(removeAlertResult.actionType).toBe("jobs.alerts.remove");
    expect(removeAlertResult.result).toMatchObject({
      removed: true
    });
  }, 180_000);

  easyApplyPreviewTest("inspects the current Easy Apply requirements without submitting", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const preview = await runtime.jobs.prepareEasyApply({
      jobId: easyApplyJobId!
    });

    expect(preview.job_id).toBe(easyApplyJobId);
    expect(preview.preview_only).toBe(true);
    expect(preview.field_count).toBeGreaterThan(0);
    expect(preview.required_field_count).toBeGreaterThan(0);
    expect(preview.current_step.length).toBeGreaterThan(0);
  }, 120_000);
});
