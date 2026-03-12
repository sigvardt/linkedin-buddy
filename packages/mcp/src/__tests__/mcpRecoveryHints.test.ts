import { LinkedInBuddyError } from "@linkedin-buddy/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINKEDIN_SESSION_STATUS_TOOL } from "../index.js";

const recoveryHintMocks = vi.hoisted(() => ({
  createCoreRuntime: vi.fn(),
  recordFeedbackInvocation: vi.fn(),
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await vi.importActual<typeof import("@linkedin-buddy/core")>(
    "@linkedin-buddy/core",
  );

  return {
    ...actual,
    createCoreRuntime: recoveryHintMocks.createCoreRuntime,
    recordFeedbackInvocation: recoveryHintMocks.recordFeedbackInvocation,
  };
});

interface FakeRuntime {
  auth: {
    status: ReturnType<typeof vi.fn>;
  };
  close: ReturnType<typeof vi.fn>;
  logger: {
    log: ReturnType<typeof vi.fn>;
  };
  runId: string;
}

function createFakeRuntime(): FakeRuntime {
  return {
    auth: {
      status: vi.fn(),
    },
    close: vi.fn(),
    logger: {
      log: vi.fn(),
    },
    runId: "run-mcp-recovery",
  };
}

function parsePayload(result: {
  content: Array<{ text: string; type: "text" }>;
}): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("MCP recovery hints", () => {
  let fakeRuntime: FakeRuntime;
  let handleToolCall: typeof import("../bin/linkedin-mcp.js").handleToolCall;

  beforeEach(async () => {
    vi.clearAllMocks();

    fakeRuntime = createFakeRuntime();
    recoveryHintMocks.createCoreRuntime.mockReturnValue(fakeRuntime);
    recoveryHintMocks.recordFeedbackInvocation.mockResolvedValue({
      showHint: false,
    });

    ({ handleToolCall } = await import("../bin/linkedin-mcp.js"));
  });

  it("includes open_login guidance for AUTH_REQUIRED errors", async () => {
    fakeRuntime.auth.status.mockRejectedValue(
      new LinkedInBuddyError("AUTH_REQUIRED", "Authentication required."),
    );

    const result = await handleToolCall(LINKEDIN_SESSION_STATUS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.code).toBe("AUTH_REQUIRED");
    expect(payload.recovery_hint).toEqual(
      expect.stringContaining("open_login"),
    );
  });

  it("includes rate-limit guidance for RATE_LIMITED errors", async () => {
    fakeRuntime.auth.status.mockRejectedValue(
      new LinkedInBuddyError("RATE_LIMITED", "Too many requests."),
    );

    const result = await handleToolCall(LINKEDIN_SESSION_STATUS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.code).toBe("RATE_LIMITED");
    expect(payload.recovery_hint).toEqual(
      expect.stringContaining("rate limit"),
    );
  });

  it("includes a generic recovery hint for unknown errors", async () => {
    fakeRuntime.auth.status.mockRejectedValue(new Error("Unexpected failure"));

    const result = await handleToolCall(LINKEDIN_SESSION_STATUS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.code).toBe("UNKNOWN");
    expect(payload.recovery_hint).toEqual(
      expect.stringContaining("unexpected error occurred"),
    );
  });

  it("does not attach recovery hints to successful responses", async () => {
    fakeRuntime.auth.status.mockResolvedValue({
      authenticated: true,
      evasion: {
        diagnosticsEnabled: false,
        level: "moderate",
      },
    });

    const result = await handleToolCall(LINKEDIN_SESSION_STATUS_TOOL, {
      profileName: "default",
    });

    expect("isError" in result && result.isError).toBe(false);
    const payload = parsePayload(result);
    expect(payload.recovery_hint).toBeUndefined();
  });
});
