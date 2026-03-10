import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL,
  LINKEDIN_COMPANY_VIEW_TOOL,
  LINKEDIN_JOBS_ALERTS_CREATE_TOOL,
  LINKEDIN_JOBS_ALERTS_LIST_TOOL,
  LINKEDIN_JOBS_ALERTS_REMOVE_TOOL,
  LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL,
  LINKEDIN_JOBS_SAVE_TOOL,
  LINKEDIN_JOBS_UNSAVE_TOOL,
  LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL,
  LINKEDIN_PRIVACY_GET_SETTINGS_TOOL
} from "../index.js";

const runtimeFactory = vi.fn();

vi.mock("@linkedin-assistant/core", async () => {
  const actual =
    await vi.importActual<typeof import("@linkedin-assistant/core")>(
      "@linkedin-assistant/core"
    );

  return {
    ...actual,
    createCoreRuntime: runtimeFactory
  };
});

interface FakeRuntime {
  close: ReturnType<typeof vi.fn>;
  companyPages: {
    prepareFollowCompanyPage: ReturnType<typeof vi.fn>;
    viewCompanyPage: ReturnType<typeof vi.fn>;
  };
  jobs: {
    listJobAlerts: ReturnType<typeof vi.fn>;
    prepareCreateJobAlert: ReturnType<typeof vi.fn>;
    prepareEasyApply: ReturnType<typeof vi.fn>;
    prepareRemoveJobAlert: ReturnType<typeof vi.fn>;
    prepareSaveJob: ReturnType<typeof vi.fn>;
    prepareUnsaveJob: ReturnType<typeof vi.fn>;
  };
  logger: {
    log: ReturnType<typeof vi.fn>;
  };
  members: {
    prepareReportMember: ReturnType<typeof vi.fn>;
  };
  privacySettings: {
    getSettings: ReturnType<typeof vi.fn>;
  };
  runId: string;
}

function createPreparedResult(summary: string) {
  return {
    preparedActionId: "pa_test",
    confirmToken: "ct_test",
    expiresAtMs: 123,
    preview: {
      summary
    }
  };
}

function createFakeRuntime(): FakeRuntime {
  return {
    runId: "run_test",
    close: vi.fn(),
    companyPages: {
      prepareFollowCompanyPage: vi.fn(),
      viewCompanyPage: vi.fn()
    },
    jobs: {
      listJobAlerts: vi.fn(),
      prepareCreateJobAlert: vi.fn(),
      prepareEasyApply: vi.fn(),
      prepareRemoveJobAlert: vi.fn(),
      prepareSaveJob: vi.fn(),
      prepareUnsaveJob: vi.fn()
    },
    logger: {
      log: vi.fn()
    },
    members: {
      prepareReportMember: vi.fn()
    },
    privacySettings: {
      getSettings: vi.fn()
    }
  };
}

function parseToolPayload(result: {
  content: Array<{ text: string; type: "text" }>;
}): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("handleToolCall", () => {
  let fakeRuntime: FakeRuntime;
  let handleToolCall: typeof import("../bin/linkedin-mcp.js").handleToolCall;

  beforeEach(async () => {
    fakeRuntime = createFakeRuntime();
    runtimeFactory.mockReturnValue(fakeRuntime);
    ({ handleToolCall } = await import("../bin/linkedin-mcp.js"));
  });

  it("returns privacy settings payloads through the MCP contract", async () => {
    fakeRuntime.privacySettings.getSettings.mockResolvedValue([
      {
        key: "profile_viewing_mode",
        label: "Profile viewing mode",
        description: "How your profile appears while browsing.",
        allowed_values: [
          "full_profile",
          "private_profile_characteristics",
          "private_mode"
        ],
        current_value: "private_mode",
        status: "available",
        source_url: "https://www.linkedin.com/mypreferences/d/profile-viewing-options",
        selector_key: "profile-viewing-mode-input-index-2",
        message: null
      }
    ]);

    const result = await handleToolCall(LINKEDIN_PRIVACY_GET_SETTINGS_TOOL, {
      profileName: "default"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      settings: [
        expect.objectContaining({
          key: "profile_viewing_mode",
          current_value: "private_mode"
        })
      ]
    });
    expect(fakeRuntime.privacySettings.getSettings).toHaveBeenCalledWith({
      profileName: "default"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares member report actions through the MCP contract", async () => {
    fakeRuntime.members.prepareReportMember.mockReturnValue(
      createPreparedResult("Report LinkedIn member target-user for spam")
    );

    const result = await handleToolCall(LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL, {
      profileName: "default",
      targetProfile: "target-user",
      reason: "spam",
      details: "Repeated unsolicited outreach."
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(fakeRuntime.members.prepareReportMember).toHaveBeenCalledWith({
      profileName: "default",
      targetProfile: "target-user",
      reason: "spam",
      details: "Repeated unsolicited outreach."
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns company page payloads through the MCP contract", async () => {
    fakeRuntime.companyPages.viewCompanyPage.mockResolvedValue({
      company_url: "https://www.linkedin.com/company/openai/",
      about_url: "https://www.linkedin.com/company/openai/about/",
      slug: "openai",
      name: "OpenAI",
      industry: "Research Services",
      location: "San Francisco, CA",
      follower_count: "10M followers",
      employee_count: "201-500 employees",
      associated_members: "7,548 associated members",
      website: "https://openai.com/",
      verified_on: "June 15, 2023",
      headquarters: "San Francisco, CA",
      specialties: "artificial intelligence and machine learning",
      overview: "OpenAI is an AI research and deployment company.",
      follow_state: "following"
    });

    const result = await handleToolCall(LINKEDIN_COMPANY_VIEW_TOOL, {
      profileName: "default",
      target: "openai"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      company: {
        name: "OpenAI",
        follow_state: "following"
      }
    });
    expect(fakeRuntime.companyPages.viewCompanyPage).toHaveBeenCalledWith({
      profileName: "default",
      target: "openai"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares company follow actions through the MCP contract", async () => {
    fakeRuntime.companyPages.prepareFollowCompanyPage.mockReturnValue(
      createPreparedResult("Follow company openai")
    );

    const result = await handleToolCall(LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL, {
      profileName: "default",
      targetCompany: "openai"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(fakeRuntime.companyPages.prepareFollowCompanyPage).toHaveBeenCalledWith({
      profileName: "default",
      targetCompany: "openai"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job save and unsave actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareSaveJob.mockReturnValue(
      createPreparedResult("Save LinkedIn job 1234567890 for later")
    );
    fakeRuntime.jobs.prepareUnsaveJob.mockReturnValue(
      createPreparedResult("Unsave LinkedIn job 1234567890")
    );

    const saveResult = await handleToolCall(LINKEDIN_JOBS_SAVE_TOOL, {
      profileName: "default",
      jobId: "1234567890"
    });
    const unsaveResult = await handleToolCall(LINKEDIN_JOBS_UNSAVE_TOOL, {
      profileName: "jobs-profile",
      jobId: "1234567890",
      operatorNote: "cleanup"
    });

    expect(parseToolPayload(saveResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(parseToolPayload(unsaveResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "jobs-profile",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(fakeRuntime.jobs.prepareSaveJob).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "1234567890"
    });
    expect(fakeRuntime.jobs.prepareUnsaveJob).toHaveBeenCalledWith({
      profileName: "jobs-profile",
      jobId: "1234567890",
      operatorNote: "cleanup"
    });
  });

  it("lists job alerts through the MCP contract", async () => {
    fakeRuntime.jobs.listJobAlerts.mockResolvedValue({
      count: 1,
      alerts: [
        {
          alert_id: "ja_123",
          query: "software engineer",
          location: "Copenhagen",
          search_url:
            "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen",
          filters_text: "Filters: Easy Apply",
          frequency: "daily",
          notification_type: "email",
          frequency_text: "Frequency: Daily via email",
          include_similar_jobs: false
        }
      ]
    });

    const result = await handleToolCall(LINKEDIN_JOBS_ALERTS_LIST_TOOL, {
      profileName: "default"
    });

    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      count: 1,
      alerts: [
        expect.objectContaining({
          alert_id: "ja_123",
          query: "software engineer"
        })
      ]
    });
    expect(fakeRuntime.jobs.listJobAlerts).toHaveBeenCalledWith({
      profileName: "default"
    });
  });

  it("prepares job alert create and remove actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareCreateJobAlert.mockReturnValue(
      createPreparedResult("Create a LinkedIn job alert for software engineer")
    );
    fakeRuntime.jobs.prepareRemoveJobAlert.mockReturnValue(
      createPreparedResult("Remove LinkedIn job alert ja_123")
    );

    const createResult = await handleToolCall(LINKEDIN_JOBS_ALERTS_CREATE_TOOL, {
      profileName: "default",
      query: "software engineer",
      location: "Copenhagen",
      frequency: "weekly",
      notificationType: "email_and_notification",
      includeSimilarJobs: true
    });
    const removeResult = await handleToolCall(LINKEDIN_JOBS_ALERTS_REMOVE_TOOL, {
      profileName: "default",
      alertId: "ja_123"
    });

    expect(parseToolPayload(createResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(parseToolPayload(removeResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(fakeRuntime.jobs.prepareCreateJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      query: "software engineer",
      location: "Copenhagen",
      frequency: "weekly",
      notificationType: "email_and_notification",
      includeSimilarJobs: true
    });
    expect(fakeRuntime.jobs.prepareRemoveJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      alertId: "ja_123"
    });
  });

  it("prepares Easy Apply payloads through the MCP contract", async () => {
    fakeRuntime.jobs.prepareEasyApply.mockResolvedValue(
      createPreparedResult("Prepare LinkedIn Easy Apply for job 1234567890")
    );

    const result = await handleToolCall(LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL, {
      profileName: "default",
      jobId: "1234567890",
      application: {
        email: "person@example.com",
        phoneCountryCode: "+45",
        phoneNumber: "12345678",
        answers: {
          sponsorship_required: false,
          years_of_experience: "5"
        }
      }
    });

    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
    expect(fakeRuntime.jobs.prepareEasyApply).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "1234567890",
      application: {
        email: "person@example.com",
        phoneCountryCode: "+45",
        phoneNumber: "12345678",
        answers: {
          sponsorship_required: false,
          years_of_experience: "5"
        }
      }
    });
  });
});
