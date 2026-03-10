import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_EVENTS_SEARCH_TOOL,
  LINKEDIN_EVENTS_VIEW_TOOL,
  LINKEDIN_EVENTS_PREPARE_RSVP_TOOL,
  LINKEDIN_GROUPS_PREPARE_JOIN_TOOL,
  LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL,
  LINKEDIN_GROUPS_PREPARE_POST_TOOL,
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
  logger: {
    log: ReturnType<typeof vi.fn>;
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
  events: {
    searchEvents: ReturnType<typeof vi.fn>;
    viewEvent: ReturnType<typeof vi.fn>;
    prepareRsvp: ReturnType<typeof vi.fn>;
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
    members: {
      prepareReportMember: vi.fn()
    },
    groups: {
      searchGroups: vi.fn(),
      viewGroup: vi.fn(),
      prepareJoinGroup: vi.fn(),
      prepareLeaveGroup: vi.fn(),
      preparePostToGroup: vi.fn()
    },
    events: {
      searchEvents: vi.fn(),
      viewEvent: vi.fn(),
      prepareRsvp: vi.fn()
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
          membership_state: "member"
        }
      ]
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_SEARCH_TOOL, {
      profileName: "default",
      query: "technology",
      limit: 5
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "technology",
      results: [
        expect.objectContaining({
          group_id: "9806731"
        })
      ]
    });
    expect(fakeRuntime.groups.searchGroups).toHaveBeenCalledWith({
      profileName: "default",
      query: "technology",
      limit: 5
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
      membership_state: "member"
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_VIEW_TOOL, {
      profileName: "default",
      group: "9806731"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      group: expect.objectContaining({
        group_id: "9806731",
        membership_state: "member"
      })
    });
    expect(fakeRuntime.groups.viewGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group join actions through the MCP contract", async () => {
    fakeRuntime.groups.prepareJoinGroup.mockReturnValue({
      preparedActionId: "pa_group_join",
      confirmToken: "ct_group_join",
      expiresAtMs: 123,
      preview: {
        summary: "Join LinkedIn group 63979"
      }
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_JOIN_TOOL, {
      profileName: "default",
      group: "63979"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_join",
      confirmToken: "ct_group_join"
    });
    expect(fakeRuntime.groups.prepareJoinGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "63979"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group leave actions through the MCP contract", async () => {
    fakeRuntime.groups.prepareLeaveGroup.mockReturnValue({
      preparedActionId: "pa_group_leave",
      confirmToken: "ct_group_leave",
      expiresAtMs: 123,
      preview: {
        summary: "Leave LinkedIn group 9806731"
      }
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL, {
      profileName: "default",
      group: "9806731",
      operatorNote: "Validation"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_leave",
      confirmToken: "ct_group_leave"
    });
    expect(fakeRuntime.groups.prepareLeaveGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731",
      operatorNote: "Validation"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares group post actions through the MCP contract", async () => {
    fakeRuntime.groups.preparePostToGroup.mockReturnValue({
      preparedActionId: "pa_group_post",
      confirmToken: "ct_group_post",
      expiresAtMs: 123,
      preview: {
        summary: "Post to LinkedIn group 9806731"
      }
    });

    const result = await handleToolCall(LINKEDIN_GROUPS_PREPARE_POST_TOOL, {
      profileName: "default",
      group: "9806731",
      text: "Thanks for sharing this perspective."
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_group_post",
      confirmToken: "ct_group_post"
    });
    expect(fakeRuntime.groups.preparePostToGroup).toHaveBeenCalledWith({
      profileName: "default",
      group: "9806731",
      text: "Thanks for sharing this perspective."
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
          is_online: true
        }
      ]
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_SEARCH_TOOL, {
      profileName: "default",
      query: "leadership",
      limit: 5
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      query: "leadership",
      results: [
        expect.objectContaining({
          event_id: "7433954919704973312"
        })
      ]
    });
    expect(fakeRuntime.events.searchEvents).toHaveBeenCalledWith({
      profileName: "default",
      query: "leadership",
      limit: 5
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
      rsvp_state: "not_responded"
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_VIEW_TOOL, {
      profileName: "default",
      event: "7433954919704973312"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      event: expect.objectContaining({
        event_id: "7433954919704973312",
        rsvp_state: "not_responded"
      })
    });
    expect(fakeRuntime.events.viewEvent).toHaveBeenCalledWith({
      profileName: "default",
      event: "7433954919704973312"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });

  it("prepares event RSVP actions through the MCP contract", async () => {
    fakeRuntime.events.prepareRsvp.mockReturnValue({
      preparedActionId: "pa_event",
      confirmToken: "ct_event",
      expiresAtMs: 123,
      preview: {
        summary: "RSVP attend for LinkedIn event 7433954919704973312"
      }
    });

    const result = await handleToolCall(LINKEDIN_EVENTS_PREPARE_RSVP_TOOL, {
      profileName: "default",
      event: "7433954919704973312"
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(parseToolPayload(result)).toMatchObject({
      run_id: "run_test",
      profile_name: "default",
      preparedActionId: "pa_event",
      confirmToken: "ct_event"
    });
    expect(fakeRuntime.events.prepareRsvp).toHaveBeenCalledWith({
      profileName: "default",
      event: "7433954919704973312"
    });
    expect(fakeRuntime.close).toHaveBeenCalledTimes(1);
  });
});
