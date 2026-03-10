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
    fakeRuntime.members.prepareReportMember.mockReturnValue({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: {
        summary: "Report LinkedIn member target-user for spam"
      }
    });

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
    fakeRuntime.companyPages.prepareFollowCompanyPage.mockReturnValue({
      preparedActionId: "pa_company",
      confirmToken: "ct_company",
      expiresAtMs: 456,
      preview: {
        summary: "Follow company openai"
      }
    });

    const result = await handleToolCall(LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL, {
      profileName: "default",
      targetCompany: "openai"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_company",
      confirmToken: "ct_company"
    });
    expect(fakeRuntime.companyPages.prepareFollowCompanyPage).toHaveBeenCalledWith({
      profileName: "default",
      targetCompany: "openai"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job save actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareSaveJob.mockReturnValue({
      preparedActionId: "pa_job_save",
      confirmToken: "ct_job_save",
      expiresAtMs: 789,
      preview: {
        summary: "Save LinkedIn job 123"
      }
    });

    const result = await handleToolCall(LINKEDIN_JOBS_SAVE_TOOL, {
      profileName: "default",
      jobId: "123"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_save",
      confirmToken: "ct_job_save"
    });
    expect(fakeRuntime.jobs.prepareSaveJob).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job unsave actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareUnsaveJob.mockReturnValue({
      preparedActionId: "pa_job_unsave",
      confirmToken: "ct_job_unsave",
      expiresAtMs: 790,
      preview: {
        summary: "Unsave LinkedIn job 123"
      }
    });

    const result = await handleToolCall(LINKEDIN_JOBS_UNSAVE_TOOL, {
      profileName: "default",
      jobId: "123"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_unsave",
      confirmToken: "ct_job_unsave"
    });
    expect(fakeRuntime.jobs.prepareUnsaveJob).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job alert creation through the MCP contract", async () => {
    fakeRuntime.jobs.prepareCreateJobAlert.mockReturnValue({
      preparedActionId: "pa_job_alert_create",
      confirmToken: "ct_job_alert_create",
      expiresAtMs: 791,
      preview: {
        summary: "Create LinkedIn job alert for software engineer"
      }
    });

    const result = await handleToolCall(LINKEDIN_JOBS_ALERTS_CREATE_TOOL, {
      profileName: "default",
      query: "software engineer",
      location: "Copenhagen"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_alert_create",
      confirmToken: "ct_job_alert_create"
    });
    expect(fakeRuntime.jobs.prepareCreateJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      query: "software engineer",
      location: "Copenhagen"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("lists job alerts through the MCP contract", async () => {
    fakeRuntime.jobs.listJobAlerts.mockResolvedValue([
      {
        alert_key: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer",
        query: "software engineer",
        location: "Copenhagen",
        search_url: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer",
        filters: ["Remote"],
        frequency: "daily",
        notification_type: "email_and_notification"
      }
    ]);

    const result = await handleToolCall(LINKEDIN_JOBS_ALERTS_LIST_TOOL, {
      profileName: "default",
      limit: 10
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      count: 1,
      alerts: [
        expect.objectContaining({
          query: "software engineer",
          frequency: "daily"
        })
      ]
    });
    expect(fakeRuntime.jobs.listJobAlerts).toHaveBeenCalledWith({
      profileName: "default",
      limit: 10
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job alert removal through the MCP contract", async () => {
    fakeRuntime.jobs.prepareRemoveJobAlert.mockReturnValue({
      preparedActionId: "pa_job_alert_remove",
      confirmToken: "ct_job_alert_remove",
      expiresAtMs: 792,
      preview: {
        summary: "Remove LinkedIn job alert"
      }
    });

    const result = await handleToolCall(LINKEDIN_JOBS_ALERTS_REMOVE_TOOL, {
      profileName: "default",
      searchUrl:
        "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_alert_remove",
      confirmToken: "ct_job_alert_remove"
    });
    expect(fakeRuntime.jobs.prepareRemoveJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      searchUrl:
        "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("previews easy apply requirements through the MCP contract", async () => {
    fakeRuntime.jobs.prepareEasyApply.mockResolvedValue({
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
      fields: [],
      preview_only: true
    });

    const result = await handleToolCall(LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL, {
      profileName: "default",
      jobId: "123"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preview: {
        job_id: "123",
        current_step: "Contact info",
        preview_only: true
      }
    });
    expect(fakeRuntime.jobs.prepareEasyApply).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });
});
