import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_SESSION_STATUS_TOOL,
  SUBMIT_FEEDBACK_TOOL
} from "../index.js";

const feedbackMcpMocks = vi.hoisted(() => ({
  createCoreRuntime: vi.fn(),
  readFeedbackStateSnapshot: vi.fn(),
  recordFeedbackInvocation: vi.fn(),
  submitFeedback: vi.fn()
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual =
    await vi.importActual<typeof import("@linkedin-assistant/core")>(
      "@linkedin-assistant/core"
    );

  return {
    ...actual,
    createCoreRuntime: feedbackMcpMocks.createCoreRuntime,
    readFeedbackStateSnapshot: feedbackMcpMocks.readFeedbackStateSnapshot,
    recordFeedbackInvocation: feedbackMcpMocks.recordFeedbackInvocation,
    submitFeedback: feedbackMcpMocks.submitFeedback
  };
});

describe("feedback MCP tooling", () => {
  let handleToolCall: typeof import("../bin/linkedin-mcp.js").handleToolCall;

  beforeEach(async () => {
    vi.clearAllMocks();

    feedbackMcpMocks.createCoreRuntime.mockReturnValue({
      auth: {
        status: vi.fn().mockResolvedValue({
          authenticated: true,
          evasion: {
            diagnosticsEnabled: false,
            level: "moderate"
          }
        })
      },
      close: vi.fn(),
      logger: {
        log: vi.fn()
      },
      runId: "run-mcp-feedback"
    });
    feedbackMcpMocks.readFeedbackStateSnapshot.mockResolvedValue({
      activeProfileName: "default",
      invocationCount: 4,
      lastErrorStack: "Error: last failure",
      lastInvocationName: "linkedin.feed.list",
      lastMcpToolName: "linkedin.feed.list",
      sessionDurationMs: 120_000,
      sessionId: "session-1",
      sessionStartedAt: "2026-03-11T10:00:00.000Z"
    });
    feedbackMcpMocks.recordFeedbackInvocation.mockResolvedValue({
      reason: "session_first",
      showHint: true,
      snapshot: {
        activeProfileName: "default",
        invocationCount: 5,
        lastErrorStack: null,
        lastInvocationName: "linkedin.session.status",
        lastMcpToolName: "linkedin.session.status",
        sessionDurationMs: 180_000,
        sessionId: "session-1",
        sessionStartedAt: "2026-03-11T10:00:00.000Z"
      }
    });
    feedbackMcpMocks.submitFeedback.mockResolvedValue({
      body: "body",
      labels: ["feature", "agent-feedback"],
      redactionApplied: true,
      repository: "sigvardt/linkedin-buddy",
      status: "saved_pending",
      title: "[Agent Feedback] Add more logs",
      type: "feature",
      pendingFilePath:
        "/tmp/assistant-home/.linkedin-buddy/pending-feedback/2026-03-11-feature.md"
    });

    ({ handleToolCall } = await import("../bin/linkedin-mcp.js"));
  });

  it("submits feedback through the submit_feedback MCP contract", async () => {
    const result = await handleToolCall(SUBMIT_FEEDBACK_TOOL, {
      type: "feature",
      title: "Add more logs",
      description: "The MCP surface should preserve a little more debug context."
    });

    expect("isError" in result && result.isError).toBe(false);
    expect(feedbackMcpMocks.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "feature",
        title: "Add more logs",
        description: "The MCP surface should preserve a little more debug context."
      })
    );

    const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload.status).toBe("saved_pending");
    expect(payload.pending_file_path).toBe(
      ".linkedin-buddy/pending-feedback/2026-03-11-feature.md"
    );
    expect(payload.feedback_hint).toBeUndefined();
  });

  it("adds a feedback hint to ordinary tool results when the tracker says to show one", async () => {
    const result = await handleToolCall(LINKEDIN_SESSION_STATUS_TOOL, {
      profileName: "default"
    });

    expect("isError" in result && result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload.feedback_hint).toContain("linkedin-buddy feedback");
    expect(feedbackMcpMocks.recordFeedbackInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationName: LINKEDIN_SESSION_STATUS_TOOL,
        mcpToolName: LINKEDIN_SESSION_STATUS_TOOL,
        source: "mcp"
      })
    );
  });
});
