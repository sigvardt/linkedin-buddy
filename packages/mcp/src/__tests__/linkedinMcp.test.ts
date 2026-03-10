import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL,
  LINKEDIN_COMPANY_VIEW_TOOL,
  LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL,
  LINKEDIN_NOTIFICATIONS_DISMISS_TOOL,
  LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
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
  logger: {
    log: ReturnType<typeof vi.fn>;
  };
  notifications: {
    getPreferences: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
    prepareDismissNotification: ReturnType<typeof vi.fn>;
    prepareUpdatePreference: ReturnType<typeof vi.fn>;
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
    logger: {
      log: vi.fn()
    },
    notifications: {
      getPreferences: vi.fn(),
      markRead: vi.fn(),
      prepareDismissNotification: vi.fn(),
      prepareUpdatePreference: vi.fn()
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

  it("marks notifications as read through the MCP contract", async () => {
    fakeRuntime.notifications.markRead.mockResolvedValue({
      marked_read: true,
      was_already_read: false,
      notification_id: "notif_1",
      link: "https://www.linkedin.com/feed/update/urn:li:activity:1",
      selector_key: "headline-link"
    });

    const result = await handleToolCall(LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL, {
      profileName: "default",
      notificationId: "notif_1"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      marked_read: true,
      notification_id: "notif_1"
    });
    expect(fakeRuntime.notifications.markRead).toHaveBeenCalledWith({
      profileName: "default",
      notificationId: "notif_1"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares notification dismiss actions through the MCP contract", async () => {
    fakeRuntime.notifications.prepareDismissNotification.mockResolvedValue({
      preparedActionId: "pa_notif",
      confirmToken: "ct_notif",
      expiresAtMs: 789,
      preview: {
        summary: "Dismiss notification"
      }
    });

    const result = await handleToolCall(LINKEDIN_NOTIFICATIONS_DISMISS_TOOL, {
      profileName: "default",
      notificationId: "notif_1"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_notif",
      confirmToken: "ct_notif"
    });
    expect(fakeRuntime.notifications.prepareDismissNotification).toHaveBeenCalledWith({
      profileName: "default",
      notificationId: "notif_1"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns notification preferences payloads through the MCP contract", async () => {
    fakeRuntime.notifications.getPreferences.mockResolvedValue({
      view_type: "overview",
      title: "Notifications",
      preference_url: "https://www.linkedin.com/mypreferences/d/categories/notifications",
      categories: [
        {
          title: "Posting and commenting",
          slug: "posting-and-commenting",
          preference_url:
            "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting"
        }
      ]
    });

    const result = await handleToolCall(
      LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
      {
        profileName: "default"
      }
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preferences: {
        view_type: "overview",
        categories: [
          expect.objectContaining({
            slug: "posting-and-commenting"
          })
        ]
      }
    });
    expect(fakeRuntime.notifications.getPreferences).toHaveBeenCalledWith({
      profileName: "default"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares notification preference updates through the MCP contract", async () => {
    fakeRuntime.notifications.prepareUpdatePreference.mockResolvedValue({
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref",
      expiresAtMs: 999,
      preview: {
        summary: "Update notification preference"
      }
    });

    const result = await handleToolCall(
      LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
      {
        profileName: "default",
        preferenceUrl:
          "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
        enabled: false,
        channel: "push"
      }
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref"
    });
    expect(fakeRuntime.notifications.prepareUpdatePreference).toHaveBeenCalledWith({
      profileName: "default",
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
      enabled: false,
      channel: "push"
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
});
