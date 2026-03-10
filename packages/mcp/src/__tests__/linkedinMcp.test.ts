import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL,
  LINKEDIN_COMPANY_VIEW_TOOL,
  LINKEDIN_EVENTS_SEARCH_TOOL,
  LINKEDIN_EVENTS_VIEW_TOOL,
  LINKEDIN_GROUPS_SEARCH_TOOL,
  LINKEDIN_GROUPS_VIEW_TOOL,
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
  events: {
    searchEvents: ReturnType<typeof vi.fn>;
    viewEvent: ReturnType<typeof vi.fn>;
  };
  groups: {
    searchGroups: ReturnType<typeof vi.fn>;
    viewGroup: ReturnType<typeof vi.fn>;
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
    events: {
      searchEvents: vi.fn(),
      viewEvent: vi.fn()
    },
    groups: {
      searchGroups: vi.fn(),
      viewGroup: vi.fn()
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

  it("returns group search payloads through the MCP contract", async () => {
    fakeRuntime.groups.searchGroups.mockResolvedValue({
      query: "marketing",
      count: 1,
      results: [
        {
          name: "The Social Media Marketing Group",
          group_type: "Public Group",
          member_count: "3M members",
          description: "The largest LinkedIn group focused on digital marketing.",
          group_url: "https://www.linkedin.com/groups/66325/"
        }
      ]
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_SEARCH_TOOL, {
      profileName: "default",
      query: "marketing",
      limit: 5
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "marketing",
      count: 1,
      results: [
        expect.objectContaining({
          name: "The Social Media Marketing Group"
        })
      ]
    });
    expect(fakeRuntime.groups.searchGroups).toHaveBeenCalledWith({
      profileName: "default",
      query: "marketing",
      limit: 5
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns group detail payloads through the MCP contract", async () => {
    fakeRuntime.groups.viewGroup.mockResolvedValue({
      group_url: "https://www.linkedin.com/groups/66325/",
      group_id: "66325",
      name: "The Social Media Marketing Group",
      description: "The largest LinkedIn group focused on digital marketing.",
      member_count: "3M members",
      group_type: "Public group",
      visibility_description:
        "Anyone, on or off LinkedIn can see posts in the group.",
      join_state: "not_joined"
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_VIEW_TOOL, {
      profileName: "default",
      target: "66325"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      group: {
        group_id: "66325",
        join_state: "not_joined"
      }
    });
    expect(fakeRuntime.groups.viewGroup).toHaveBeenCalledWith({
      profileName: "default",
      target: "66325"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns event search payloads through the MCP contract", async () => {
    fakeRuntime.events.searchEvents.mockResolvedValue({
      query: "AI",
      count: 1,
      results: [
        {
          title: "The AI Advantage in 2026",
          date: "Tue, Mar 10, 2026",
          location: "Warren, Ohio, US",
          organizer: "Gilbert's Risk Solutions",
          description: "A practical, no-hype executive breakfast briefing.",
          attendee_count: "7 attendees",
          event_url: "https://www.linkedin.com/events/7424814333760700416/"
        }
      ]
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_SEARCH_TOOL, {
      profileName: "default",
      query: "AI",
      limit: 5
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "AI",
      count: 1,
      results: [
        expect.objectContaining({
          title: "The AI Advantage in 2026"
        })
      ]
    });
    expect(fakeRuntime.events.searchEvents).toHaveBeenCalledWith({
      profileName: "default",
      query: "AI",
      limit: 5
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("returns event detail payloads through the MCP contract", async () => {
    fakeRuntime.events.viewEvent.mockResolvedValue({
      event_url: "https://www.linkedin.com/events/7424814333760700416/",
      event_id: "7424814333760700416",
      title: "The AI Advantage in 2026",
      status: "Event ended",
      date: "Tue, Mar 10, 2026, 1:00 PM - 2:30 PM (your local time)",
      location: "9519 E Market St, Warren, Ohio, US, 44484",
      venue: "The Theater Room",
      organizer: "Gilbert's Risk Solutions",
      organizer_url: "https://www.linkedin.com/company/gilberts-risk-solutions/",
      description: "A practical, no-hype executive breakfast briefing.",
      attendee_count: "7 attendees",
      event_link: "https://gilbertsleadingwithai.my.canva.site/",
      rsvp_state: "not_responded"
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_VIEW_TOOL, {
      profileName: "default",
      target: "7424814333760700416"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      event: {
        event_id: "7424814333760700416",
        rsvp_state: "not_responded"
      }
    });
    expect(fakeRuntime.events.viewEvent).toHaveBeenCalledWith({
      profileName: "default",
      target: "7424814333760700416"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });
});
