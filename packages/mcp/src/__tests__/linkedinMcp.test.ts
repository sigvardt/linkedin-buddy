import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
});
