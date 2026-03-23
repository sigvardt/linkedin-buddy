import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_ANALYTICS_CONTENT_METRICS_TOOL,
  LINKEDIN_ANALYTICS_POST_METRICS_TOOL,
  LINKEDIN_ANALYTICS_PROFILE_VIEWS_TOOL,
  LINKEDIN_ANALYTICS_SEARCH_APPEARANCES_TOOL,
  LINKEDIN_ARTICLE_PREPARE_CREATE_TOOL,
  LINKEDIN_ARTICLE_PREPARE_PUBLISH_TOOL,
  LINKEDIN_COMPANY_VIEW_TOOL,
  LINKEDIN_EVENTS_SEARCH_TOOL,
  LINKEDIN_EVENTS_VIEW_TOOL,
  LINKEDIN_EVENTS_PREPARE_RSVP_TOOL,
  LINKEDIN_GROUPS_PREPARE_JOIN_TOOL,
  LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL,
  LINKEDIN_GROUPS_PREPARE_POST_TOOL,
  LINKEDIN_GROUPS_SEARCH_TOOL,
  LINKEDIN_GROUPS_VIEW_TOOL,
  LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
  LINKEDIN_JOBS_ALERTS_CREATE_TOOL,
  LINKEDIN_JOBS_ALERTS_LIST_TOOL,
  LINKEDIN_JOBS_ALERTS_REMOVE_TOOL,
  LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL,
  LINKEDIN_JOBS_SAVE_TOOL,
  LINKEDIN_JOBS_UNSAVE_TOOL,
  LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL,
  LINKEDIN_NEWSLETTER_LIST_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
  LINKEDIN_NOTIFICATIONS_DISMISS_TOOL,
  LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
  LINKEDIN_PRIVACY_GET_SETTINGS_TOOL,
} from "../index.js";

const runtimeFactory = vi.fn();

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await vi.importActual<typeof import("@linkedin-buddy/core")>(
    "@linkedin-buddy/core",
  );

  return {
    ...actual,
    createCoreRuntime: runtimeFactory,
  };
});

interface FakeRuntime {
  analytics: {
    getContentMetrics: ReturnType<typeof vi.fn>;
    getPostMetrics: ReturnType<typeof vi.fn>;
    getProfileViews: ReturnType<typeof vi.fn>;
    getSearchAppearances: ReturnType<typeof vi.fn>;
  };
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
  groups: {
    searchGroups: ReturnType<typeof vi.fn>;
    viewGroup: ReturnType<typeof vi.fn>;
    prepareJoinGroup: ReturnType<typeof vi.fn>;
    prepareLeaveGroup: ReturnType<typeof vi.fn>;
    preparePostToGroup: ReturnType<typeof vi.fn>;
  };
  articles: {
    prepareCreate: ReturnType<typeof vi.fn>;
    preparePublish: ReturnType<typeof vi.fn>;
  };
  newsletters: {
    prepareCreate: ReturnType<typeof vi.fn>;
    preparePublishIssue: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  events: {
    searchEvents: ReturnType<typeof vi.fn>;
    viewEvent: ReturnType<typeof vi.fn>;
    prepareRsvp: ReturnType<typeof vi.fn>;
  };
  privacySettings: {
    getSettings: ReturnType<typeof vi.fn>;
  };
  jobs: {
    listJobAlerts: ReturnType<typeof vi.fn>;
    prepareCreateJobAlert: ReturnType<typeof vi.fn>;
    prepareEasyApply: ReturnType<typeof vi.fn>;
    prepareRemoveJobAlert: ReturnType<typeof vi.fn>;
    prepareSaveJob: ReturnType<typeof vi.fn>;
    prepareUnsaveJob: ReturnType<typeof vi.fn>;
  };
  runId: string;
}

function createFakeRuntime(): FakeRuntime {
  return {
    runId: "run_test",
    analytics: {
      getContentMetrics: vi.fn(),
      getPostMetrics: vi.fn(),
      getProfileViews: vi.fn(),
      getSearchAppearances: vi.fn(),
    },
    close: vi.fn(),
    companyPages: {
      prepareFollowCompanyPage: vi.fn(),
      viewCompanyPage: vi.fn(),
    },
    logger: {
      log: vi.fn(),
    },
    notifications: {
      getPreferences: vi.fn(),
      markRead: vi.fn(),
      prepareDismissNotification: vi.fn(),
      prepareUpdatePreference: vi.fn(),
    },
    members: {
      prepareReportMember: vi.fn(),
    },
    groups: {
      searchGroups: vi.fn(),
      viewGroup: vi.fn(),
      prepareJoinGroup: vi.fn(),
      prepareLeaveGroup: vi.fn(),
      preparePostToGroup: vi.fn(),
    },
    articles: {
      prepareCreate: vi.fn(),
      preparePublish: vi.fn(),
    },
    newsletters: {
      prepareCreate: vi.fn(),
      preparePublishIssue: vi.fn(),
      list: vi.fn(),
    },
    events: {
      searchEvents: vi.fn(),
      viewEvent: vi.fn(),
      prepareRsvp: vi.fn(),
    },
    privacySettings: {
      getSettings: vi.fn(),
    },
    jobs: {
      listJobAlerts: vi.fn(),
      prepareCreateJobAlert: vi.fn(),
      prepareEasyApply: vi.fn(),
      prepareRemoveJobAlert: vi.fn(),
      prepareSaveJob: vi.fn(),
      prepareUnsaveJob: vi.fn(),
    },
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

  it("rejects invalid arguments before creating a runtime", async () => {
    runtimeFactory.mockClear();

    const result = await handleToolCall(LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL, {
      query: "Simon Miller",
      limit: "5" as unknown as number,
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(parseToolPayload(result)).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      message: "limit must be a finite number.",
      details: {
        path: "limit",
        actual_type: "string",
      },
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
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
          "private_mode",
        ],
        current_value: "private_mode",
        status: "available",
        source_url:
          "https://www.linkedin.com/mypreferences/d/profile-viewing-options",
        selector_key: "profile-viewing-mode-input-index-2",
        message: null,
      },
    ]);

    const result = await handleToolCall(LINKEDIN_PRIVACY_GET_SETTINGS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      settings: [
        expect.objectContaining({
          key: "profile_viewing_mode",
          current_value: "private_mode",
        }),
      ],
    });
    expect(fakeRuntime.privacySettings.getSettings).toHaveBeenCalledWith({
      profileName: "default",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns profile-view analytics payloads through the MCP contract", async () => {
    fakeRuntime.analytics.getProfileViews.mockResolvedValue({
      surface: "profile_views",
      source_url: "https://www.linkedin.com/in/me/",
      observed_at: "2026-03-11T12:00:00.000Z",
      metrics: [
        {
          metric_key: "profile_views",
          label: "Profile views",
          value: 42,
          value_text: "42",
          delta_value: null,
          delta_text: null,
          unit: "count",
          trend: "unknown",
          observed_at: "2026-03-11T12:00:00.000Z",
        },
      ],
      cards: [
        {
          card_key: "profile_views",
          title: "Profile views",
          description: "See who's viewed your profile.",
          href: "https://www.linkedin.com/in/me/",
          metrics: [
            {
              metric_key: "profile_views",
              label: "Profile views",
              value: 42,
              value_text: "42",
              delta_value: null,
              delta_text: null,
              unit: "count",
              trend: "unknown",
              observed_at: "2026-03-11T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    const result = await handleToolCall(LINKEDIN_ANALYTICS_PROFILE_VIEWS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      surface: "profile_views",
      metrics: [
        expect.objectContaining({
          metric_key: "profile_views",
          value: 42,
        }),
      ],
    });
    expect(fakeRuntime.analytics.getProfileViews).toHaveBeenCalledWith({
      profileName: "default",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns search-appearances analytics payloads through the MCP contract", async () => {
    fakeRuntime.analytics.getSearchAppearances.mockResolvedValue({
      surface: "search_appearances",
      source_url: "https://www.linkedin.com/in/me/",
      observed_at: "2026-03-11T12:00:00.000Z",
      metrics: [
        {
          metric_key: "search_appearances",
          label: "Search appearances",
          value: 28,
          value_text: "28",
          delta_value: null,
          delta_text: null,
          unit: "count",
          trend: "unknown",
          observed_at: "2026-03-11T12:00:00.000Z",
        },
      ],
      cards: [
        {
          card_key: "search_appearances",
          title: "Search appearances",
          description: "How often your profile appears in search.",
          href: "https://www.linkedin.com/in/me/",
          metrics: [
            {
              metric_key: "search_appearances",
              label: "Search appearances",
              value: 28,
              value_text: "28",
              delta_value: null,
              delta_text: null,
              unit: "count",
              trend: "unknown",
              observed_at: "2026-03-11T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    const result = await handleToolCall(
      LINKEDIN_ANALYTICS_SEARCH_APPEARANCES_TOOL,
      {
        profileName: "default",
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      surface: "search_appearances",
      metrics: [
        expect.objectContaining({
          metric_key: "search_appearances",
          value: 28,
        }),
      ],
    });
    expect(fakeRuntime.analytics.getSearchAppearances).toHaveBeenCalledWith({
      profileName: "default",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns content-metrics analytics payloads through the MCP contract", async () => {
    fakeRuntime.analytics.getContentMetrics.mockResolvedValue({
      surface: "content_metrics",
      source_url: "https://www.linkedin.com/in/me/",
      observed_at: "2026-03-11T12:00:00.000Z",
      metrics: [
        {
          metric_key: "impressions",
          label: "Impressions",
          value: 350,
          value_text: "350",
          delta_value: null,
          delta_text: null,
          unit: "count",
          trend: "unknown",
          observed_at: "2026-03-11T12:00:00.000Z",
        },
      ],
      cards: [
        {
          card_key: "content_metrics",
          title: "Creator analytics",
          description: "Performance summary for your content.",
          href: "https://www.linkedin.com/in/me/",
          metrics: [
            {
              metric_key: "impressions",
              label: "Impressions",
              value: 350,
              value_text: "350",
              delta_value: null,
              delta_text: null,
              unit: "count",
              trend: "unknown",
              observed_at: "2026-03-11T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    const result = await handleToolCall(
      LINKEDIN_ANALYTICS_CONTENT_METRICS_TOOL,
      {
        profileName: "default",
        limit: 3,
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      surface: "content_metrics",
      metrics: [
        expect.objectContaining({
          metric_key: "impressions",
          value: 350,
        }),
      ],
    });
    expect(fakeRuntime.analytics.getContentMetrics).toHaveBeenCalledWith({
      profileName: "default",
      limit: 3,
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares member report actions through the MCP contract", async () => {
    fakeRuntime.members.prepareReportMember.mockReturnValue({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: {
        summary: "Report LinkedIn member target-user for spam",
      },
    });

    const result = await handleToolCall(LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL, {
      profileName: "default",
      targetProfile: "target-user",
      reason: "spam",
      details: "Repeated unsolicited outreach.",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
    });
    expect(fakeRuntime.members.prepareReportMember).toHaveBeenCalledWith({
      profileName: "default",
      targetProfile: "target-user",
      reason: "spam",
      details: "Repeated unsolicited outreach.",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("marks notifications as read through the MCP contract", async () => {
    fakeRuntime.notifications.markRead.mockResolvedValue({
      marked_read: true,
      was_already_read: false,
      notification_id: "notif_1",
      link: "https://www.linkedin.com/feed/update/urn:li:activity:1",
      selector_key: "headline-link",
    });

    const result = await handleToolCall(LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL, {
      profileName: "default",
      notificationId: "notif_1",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      marked_read: true,
      notification_id: "notif_1",
    });
    expect(fakeRuntime.notifications.markRead).toHaveBeenCalledWith({
      profileName: "default",
      notificationId: "notif_1",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares notification dismiss actions through the MCP contract", async () => {
    fakeRuntime.notifications.prepareDismissNotification.mockResolvedValue({
      preparedActionId: "pa_notif",
      confirmToken: "ct_notif",
      expiresAtMs: 789,
      preview: {
        summary: "Dismiss notification",
      },
    });

    const result = await handleToolCall(LINKEDIN_NOTIFICATIONS_DISMISS_TOOL, {
      profileName: "default",
      notificationId: "notif_1",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_notif",
      confirmToken: "ct_notif",
    });
    expect(
      fakeRuntime.notifications.prepareDismissNotification,
    ).toHaveBeenCalledWith({
      profileName: "default",
      notificationId: "notif_1",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns notification preferences payloads through the MCP contract", async () => {
    fakeRuntime.notifications.getPreferences.mockResolvedValue({
      view_type: "overview",
      title: "Notifications",
      preference_url:
        "https://www.linkedin.com/mypreferences/d/categories/notifications",
      categories: [
        {
          title: "Posting and commenting",
          slug: "posting-and-commenting",
          preference_url:
            "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
        },
      ],
    });

    const result = await handleToolCall(
      LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
      {
        profileName: "default",
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preferences: {
        view_type: "overview",
        categories: [
          expect.objectContaining({
            slug: "posting-and-commenting",
          }),
        ],
      },
    });
    expect(fakeRuntime.notifications.getPreferences).toHaveBeenCalledWith({
      profileName: "default",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares notification preference updates through the MCP contract", async () => {
    fakeRuntime.notifications.prepareUpdatePreference.mockResolvedValue({
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref",
      expiresAtMs: 999,
      preview: {
        summary: "Update notification preference",
      },
    });

    const result = await handleToolCall(
      LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
      {
        profileName: "default",
        preferenceUrl:
          "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
        enabled: false,
        channel: "push",
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref",
    });
    expect(
      fakeRuntime.notifications.prepareUpdatePreference,
    ).toHaveBeenCalledWith({
      profileName: "default",
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
      enabled: false,
      channel: "push",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns group search payloads through the MCP contract", async () => {
    fakeRuntime.groups.searchGroups.mockResolvedValue({
      query: "technology",
      count: 1,
      results: [
        {
          group_id: "9806731",
          name: "Next Generation - Community",
          group_url: "https://www.linkedin.com/groups/9806731/",
          visibility: "Private Listed",
          member_count: "706,250 members",
          description: "Community for next-generation leaders.",
          membership_state: "member",
        },
      ],
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_SEARCH_TOOL, {
      profileName: "default",
      query: "technology",
      limit: 5,
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "technology",
      results: [
        expect.objectContaining({
          group_id: "9806731",
        }),
      ],
    });
    expect(fakeRuntime.groups.searchGroups).toHaveBeenCalledWith({
      profileName: "default",
      query: "technology",
      limit: 5,
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
      follow_state: "following",
    });

    const result = await handleToolCall(LINKEDIN_COMPANY_VIEW_TOOL, {
      profileName: "default",
      target: "openai",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      company: {
        name: "OpenAI",
        follow_state: "following",
      },
    });
    expect(fakeRuntime.companyPages.viewCompanyPage).toHaveBeenCalledWith({
      profileName: "default",
      target: "openai",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns group view payloads through the MCP contract", async () => {
    fakeRuntime.groups.viewGroup.mockResolvedValue({
      group_id: "9806731",
      name: "Next Generation - Community",
      group_url: "https://www.linkedin.com/groups/9806731/",
      visibility: "Private Listed",
      member_count: "706,250 members",
      description: "Community for next-generation leaders.",
      about: "Community for next-generation leaders.",
      joined_at: "Apr 2024",
      membership_state: "member",
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_VIEW_TOOL, {
      profileName: "default",
      group: "9806731",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      group: expect.objectContaining({
        group_id: "9806731",
        membership_state: "member",
      }),
    });
    expect(fakeRuntime.groups.viewGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group join actions through the MCP contract", async () => {
    fakeRuntime.groups.prepareJoinGroup.mockReturnValue({
      preparedActionId: "pa_group_join",
      confirmToken: "ct_group_join",
      expiresAtMs: 123,
      preview: {
        summary: "Join LinkedIn group 63979",
      },
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_JOIN_TOOL, {
      profileName: "default",
      group: "63979",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_join",
      confirmToken: "ct_group_join",
    });
    expect(fakeRuntime.groups.prepareJoinGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "63979",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group leave actions through the MCP contract", async () => {
    fakeRuntime.groups.prepareLeaveGroup.mockReturnValue({
      preparedActionId: "pa_group_leave",
      confirmToken: "ct_group_leave",
      expiresAtMs: 123,
      preview: {
        summary: "Leave LinkedIn group 9806731",
      },
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL, {
      profileName: "default",
      group: "9806731",
      operatorNote: "Validation",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_leave",
      confirmToken: "ct_group_leave",
    });
    expect(fakeRuntime.groups.prepareLeaveGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731",
      operatorNote: "Validation",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group post actions through the MCP contract", async () => {
    fakeRuntime.groups.preparePostToGroup.mockReturnValue({
      preparedActionId: "pa_group_post",
      confirmToken: "ct_group_post",
      expiresAtMs: 123,
      preview: {
        summary: "Post to LinkedIn group 9806731",
      },
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_POST_TOOL, {
      profileName: "default",
      group: "9806731",
      text: "Thanks for sharing this perspective.",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_post",
      confirmToken: "ct_group_post",
    });
    expect(fakeRuntime.groups.preparePostToGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731",
      text: "Thanks for sharing this perspective.",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares article draft actions through the MCP contract", async () => {
    fakeRuntime.articles.prepareCreate.mockResolvedValue({
      preparedActionId: "pa_article_create",
      confirmToken: "ct_article_create",
      expiresAtMs: 123,
      preview: {
        summary: 'Create LinkedIn article draft "Launch notes"',
      },
    });

    const result = await handleToolCall(LINKEDIN_ARTICLE_PREPARE_CREATE_TOOL, {
      profileName: "default",
      title: "Launch notes",
      body: "A longer article body.",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_article_create",
      confirmToken: "ct_article_create",
    });
    expect(fakeRuntime.articles.prepareCreate).toHaveBeenCalledWith({
      profileName: "default",
      title: "Launch notes",
      body: "A longer article body.",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares article publish actions through the MCP contract", async () => {
    fakeRuntime.articles.preparePublish.mockResolvedValue({
      preparedActionId: "pa_article_publish",
      confirmToken: "ct_article_publish",
      expiresAtMs: 123,
      preview: {
        summary: 'Publish LinkedIn article draft "Launch notes"',
      },
    });

    const result = await handleToolCall(LINKEDIN_ARTICLE_PREPARE_PUBLISH_TOOL, {
      profileName: "default",
      draftUrl: "https://www.linkedin.com/pulse/article/123/edit/",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_article_publish",
      confirmToken: "ct_article_publish",
    });
    expect(fakeRuntime.articles.preparePublish).toHaveBeenCalledWith({
      profileName: "default",
      draftUrl: "https://www.linkedin.com/pulse/article/123/edit/",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares newsletter creation actions through the MCP contract", async () => {
    fakeRuntime.newsletters.prepareCreate.mockResolvedValue({
      preparedActionId: "pa_newsletter_create",
      confirmToken: "ct_newsletter_create",
      expiresAtMs: 123,
      preview: {
        summary: 'Create LinkedIn newsletter "Builder Brief"',
      },
    });

    const result = await handleToolCall(
      LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
      {
        profileName: "default",
        title: "Builder Brief",
        description: "Weekly notes from the product team.",
        cadence: "weekly",
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_newsletter_create",
      confirmToken: "ct_newsletter_create",
    });
    expect(fakeRuntime.newsletters.prepareCreate).toHaveBeenCalledWith({
      profileName: "default",
      title: "Builder Brief",
      description: "Weekly notes from the product team.",
      cadence: "weekly",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares newsletter issue publish actions through the MCP contract", async () => {
    fakeRuntime.newsletters.preparePublishIssue.mockResolvedValue({
      preparedActionId: "pa_newsletter_issue",
      confirmToken: "ct_newsletter_issue",
      expiresAtMs: 123,
      preview: {
        summary:
          'Publish LinkedIn newsletter issue "March update" in Builder Brief',
      },
    });

    const result = await handleToolCall(
      LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
      {
        profileName: "default",
        newsletter: "Builder Brief",
        title: "March update",
        body: "Long-form issue body.",
      },
    );

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_newsletter_issue",
      confirmToken: "ct_newsletter_issue",
    });
    expect(fakeRuntime.newsletters.preparePublishIssue).toHaveBeenCalledWith({
      profileName: "default",
      newsletter: "Builder Brief",
      title: "March update",
      body: "Long-form issue body.",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns newsletter list payloads through the MCP contract", async () => {
    fakeRuntime.newsletters.list.mockResolvedValue({
      count: 1,
      newsletters: [
        {
          title: "Builder Brief",
          selected: false,
        },
      ],
    });

    const result = await handleToolCall(LINKEDIN_NEWSLETTER_LIST_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      count: 1,
      newsletters: [
        expect.objectContaining({
          title: "Builder Brief",
        }),
      ],
    });
    expect(fakeRuntime.newsletters.list).toHaveBeenCalledWith({
      profileName: "default",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns event search payloads through the MCP contract", async () => {
    fakeRuntime.events.searchEvents.mockResolvedValue({
      query: "leadership",
      count: 1,
      results: [
        {
          event_id: "7433954919704973312",
          title: "How to Lead When the Stakes Are High",
          date_time: "Tue, Mar 10, 5:00 PM",
          location: "Online",
          organizer: "LinkedIn",
          attendee_count: "1,234 attendees",
          description: "A live session on leadership under pressure.",
          event_url: "https://www.linkedin.com/events/7433954919704973312/",
          is_online: true,
        },
      ],
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_SEARCH_TOOL, {
      profileName: "default",
      query: "leadership",
      limit: 5,
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "leadership",
      results: [
        expect.objectContaining({
          event_id: "7433954919704973312",
        }),
      ],
    });
    expect(fakeRuntime.events.searchEvents).toHaveBeenCalledWith({
      profileName: "default",
      query: "leadership",
      limit: 5,
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns event view payloads through the MCP contract", async () => {
    fakeRuntime.events.viewEvent.mockResolvedValue({
      event_id: "7433954919704973312",
      title: "How to Lead When the Stakes Are High",
      event_url: "https://www.linkedin.com/events/7433954919704973312/",
      organizer: "LinkedIn",
      date_time: "Tue, Mar 10, 5:00 PM",
      location: "Online",
      attendee_count: "1,234 attendees",
      description: "A live session on leadership under pressure.",
      is_online: true,
      rsvp_state: "not_responded",
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_VIEW_TOOL, {
      profileName: "default",
      event: "7433954919704973312",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      event: expect.objectContaining({
        event_id: "7433954919704973312",
        rsvp_state: "not_responded",
      }),
    });
    expect(fakeRuntime.events.viewEvent).toHaveBeenCalledWith({
      profileName: "default",
      event: "7433954919704973312",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares event RSVP actions through the MCP contract", async () => {
    fakeRuntime.events.prepareRsvp.mockReturnValue({
      preparedActionId: "pa_event",
      confirmToken: "ct_event",
      expiresAtMs: 123,
      preview: {
        summary: "RSVP attend for LinkedIn event 7433954919704973312",
      },
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_PREPARE_RSVP_TOOL, {
      profileName: "default",
      event: "7433954919704973312",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_event",
      confirmToken: "ct_event",
    });
    expect(fakeRuntime.events.prepareRsvp).toHaveBeenCalledWith({
      profileName: "default",
      event: "7433954919704973312",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns post-metrics payloads through the MCP contract", async () => {
    fakeRuntime.analytics.getPostMetrics.mockResolvedValue({
      surface: "post_metrics",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      observed_at: "2026-03-11T12:00:00.000Z",
      metrics: [
        {
          metric_key: "reactions",
          label: "Reactions",
          value: 12,
          value_text: "12",
          delta_value: null,
          delta_text: null,
          unit: "count",
          trend: "unknown",
          observed_at: "2026-03-11T12:00:00.000Z",
        },
      ],
      cards: [
        {
          card_key: "post_engagement",
          title: "Post engagement",
          description: "Read from the live LinkedIn post surface.",
          href: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
          metrics: [
            {
              metric_key: "reactions",
              label: "Reactions",
              value: 12,
              value_text: "12",
              delta_value: null,
              delta_text: null,
              unit: "count",
              trend: "unknown",
              observed_at: "2026-03-11T12:00:00.000Z",
            },
          ],
        },
      ],
      post: {
        post_id: "123",
        post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
        author_name: "Joi Ascend",
        author_headline: "Automation operator",
        posted_at: "1d",
        text: "Testing metrics.",
      },
    });

    const result = await handleToolCall(LINKEDIN_ANALYTICS_POST_METRICS_TOOL, {
      profileName: "default",
      postUrl: "urn:li:activity:123",
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      surface: "post_metrics",
      post: {
        post_id: "123",
        author_name: "Joi Ascend",
      },
    });
    expect(fakeRuntime.analytics.getPostMetrics).toHaveBeenCalledWith({
      profileName: "default",
      postUrl: "urn:li:activity:123",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares jobs save and unsave actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareSaveJob.mockReturnValue({
      preparedActionId: "pa_job_save",
      confirmToken: "ct_job_save",
      expiresAtMs: 123,
      preview: {
        summary: "Save LinkedIn job https://www.linkedin.com/jobs/view/123/",
      },
    });
    fakeRuntime.jobs.prepareUnsaveJob.mockReturnValue({
      preparedActionId: "pa_job_unsave",
      confirmToken: "ct_job_unsave",
      expiresAtMs: 123,
      preview: {
        summary: "Unsave LinkedIn job https://www.linkedin.com/jobs/view/123/",
      },
    });

    const saveResult = await handleToolCall(LINKEDIN_JOBS_SAVE_TOOL, {
      profileName: "default",
      jobId: "123",
    });
    const unsaveResult = await handleToolCall(LINKEDIN_JOBS_UNSAVE_TOOL, {
      profileName: "default",
      jobId: "123",
      operatorNote: "cleanup",
    });

    expect("isError" in saveResult && saveResult.isError).toBe(false);
    expect(parseToolPayload(saveResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_save",
      confirmToken: "ct_job_save",
    });
    expect(fakeRuntime.jobs.prepareSaveJob).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123",
    });

    expect("isError" in unsaveResult && unsaveResult.isError).toBe(false);
    expect(parseToolPayload(unsaveResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_job_unsave",
      confirmToken: "ct_job_unsave",
    });
    expect(fakeRuntime.jobs.prepareUnsaveJob).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123",
      operatorNote: "cleanup",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(2);
  });

  it("returns job alert listings through the MCP contract", async () => {
    fakeRuntime.jobs.listJobAlerts.mockResolvedValue({
      count: 1,
      alerts: [
        {
          alert_id: "alert-1",
          query: "Staff Engineer",
          location: "Remote",
          frequency: "Daily",
          search_url:
            "https://www.linkedin.com/jobs/search/?keywords=Staff%20Engineer&location=Remote",
          enabled: true,
        },
      ],
    });

    const result = await handleToolCall(LINKEDIN_JOBS_ALERTS_LIST_TOOL, {
      profileName: "default",
      limit: 5,
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      count: 1,
      alerts: [
        expect.objectContaining({
          alert_id: "alert-1",
          enabled: true,
        }),
      ],
    });
    expect(fakeRuntime.jobs.listJobAlerts).toHaveBeenCalledWith({
      profileName: "default",
      limit: 5,
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares job alert create and remove actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareCreateJobAlert.mockReturnValue({
      preparedActionId: "pa_alert_create",
      confirmToken: "ct_alert_create",
      expiresAtMs: 123,
      preview: {
        summary: 'Create a LinkedIn job alert for "Staff Engineer" in Remote',
      },
    });
    fakeRuntime.jobs.prepareRemoveJobAlert.mockResolvedValue({
      preparedActionId: "pa_alert_remove",
      confirmToken: "ct_alert_remove",
      expiresAtMs: 123,
      preview: {
        summary: 'Remove LinkedIn job alert for "Staff Engineer" in Remote',
      },
    });

    const createResult = await handleToolCall(
      LINKEDIN_JOBS_ALERTS_CREATE_TOOL,
      {
        profileName: "default",
        query: "Staff Engineer",
        location: "Remote",
      },
    );
    const removeResult = await handleToolCall(
      LINKEDIN_JOBS_ALERTS_REMOVE_TOOL,
      {
        profileName: "default",
        alertId: "alert-1",
        operatorNote: "cleanup",
      },
    );

    expect("isError" in createResult && createResult.isError).toBe(false);
    expect(parseToolPayload(createResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_alert_create",
      confirmToken: "ct_alert_create",
    });
    expect(fakeRuntime.jobs.prepareCreateJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      query: "Staff Engineer",
      location: "Remote",
    });

    expect("isError" in removeResult && removeResult.isError).toBe(false);
    expect(parseToolPayload(removeResult)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_alert_remove",
      confirmToken: "ct_alert_remove",
    });
    expect(fakeRuntime.jobs.prepareRemoveJobAlert).toHaveBeenCalledWith({
      profileName: "default",
      alertId: "alert-1",
      operatorNote: "cleanup",
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(2);
  });

  it("prepares Easy Apply actions through the MCP contract", async () => {
    fakeRuntime.jobs.prepareEasyApply.mockReturnValue({
      preparedActionId: "pa_easy_apply",
      confirmToken: "ct_easy_apply",
      expiresAtMs: 123,
      preview: {
        summary:
          "Submit LinkedIn Easy Apply application for https://www.linkedin.com/jobs/view/123/",
      },
    });

    const result = await handleToolCall(LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL, {
      profileName: "default",
      jobId: "123",
      email: "candidate@example.com",
      resumePath: "/tmp/resume.pdf",
      answers: {
        "Years of experience": 8,
      },
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_easy_apply",
      confirmToken: "ct_easy_apply",
    });
    expect(fakeRuntime.jobs.prepareEasyApply).toHaveBeenCalledWith({
      profileName: "default",
      jobId: "123",
      email: "candidate@example.com",
      resumePath: "/tmp/resume.pdf",
      answers: {
        "Years of experience": 8,
      },
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });
});
