import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const feedbackCliMocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
  question: vi.fn(),
  close: vi.fn(),
  readFeedbackStateSnapshot: vi.fn(),
  recordFeedbackInvocation: vi.fn(),
  submitFeedback: vi.fn(),
  submitPendingFeedback: vi.fn()
}));

vi.mock("node:readline/promises", () => ({
  createInterface: feedbackCliMocks.createInterface.mockImplementation(() => ({
    close: feedbackCliMocks.close,
    question: feedbackCliMocks.question
  }))
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    readFeedbackStateSnapshot: feedbackCliMocks.readFeedbackStateSnapshot,
    recordFeedbackInvocation: feedbackCliMocks.recordFeedbackInvocation,
    submitFeedback: feedbackCliMocks.submitFeedback,
    submitPendingFeedback: feedbackCliMocks.submitPendingFeedback
  };
});

import { runCli } from "../src/bin/linkedin.js";

function setInteractiveMode(inputIsTty: boolean, outputIsTty: boolean): void {
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: inputIsTty
  });
  Object.defineProperty(stdout, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: outputIsTty
  });
}

describe("linkedin feedback CLI", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let previousAssistantHome: string | undefined;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    previousAssistantHome = process.env.LINKEDIN_ASSISTANT_HOME;
    process.env.LINKEDIN_ASSISTANT_HOME = "/tmp/assistant-home";

    feedbackCliMocks.readFeedbackStateSnapshot.mockResolvedValue({
      activeProfileName: "default",
      invocationCount: 2,
      lastErrorStack: "Error: boom",
      lastInvocationName: "status",
      lastMcpToolName: null,
      sessionDurationMs: 60_000,
      sessionId: "session-1",
      sessionStartedAt: "2026-03-11T10:00:00.000Z"
    });
    feedbackCliMocks.recordFeedbackInvocation.mockResolvedValue({
      showHint: false,
      snapshot: {
        activeProfileName: "default",
        invocationCount: 3,
        lastErrorStack: null,
        lastInvocationName: "feedback",
        lastMcpToolName: null,
        sessionDurationMs: 61_000,
        sessionId: "session-1",
        sessionStartedAt: "2026-03-11T10:00:00.000Z"
      }
    });
    feedbackCliMocks.submitFeedback.mockResolvedValue({
      body: "body",
      labels: ["bug", "agent-feedback"],
      redactionApplied: false,
      repository: "sigvardt/linkedin-buddy",
      status: "submitted",
      title: "[Agent Feedback] Prompted title",
      type: "bug",
      url: "https://github.com/sigvardt/linkedin-buddy/issues/321"
    });
    feedbackCliMocks.submitPendingFeedback.mockResolvedValue({
      failureCount: 0,
      failures: [],
      repository: "sigvardt/linkedin-buddy",
      submitted: [
        {
          filePath: "/tmp/assistant-home/.linkedin-buddy/pending-feedback/2026-03-11-bug.md",
          title: "[Agent Feedback] Saved item",
          type: "bug",
          url: "https://github.com/sigvardt/linkedin-buddy/issues/322"
        }
      ],
      submittedCount: 1
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      stdoutChunks.push(String(value ?? ""));
    });
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        stderrChunks.push(String(args[0]));
        return true;
      });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    if (previousAssistantHome === undefined) {
      delete process.env.LINKEDIN_ASSISTANT_HOME;
    } else {
      process.env.LINKEDIN_ASSISTANT_HOME = previousAssistantHome;
    }
  });

  it("prompts for missing feedback fields and submits the report", async () => {
    feedbackCliMocks.question
      .mockResolvedValueOnce("bug")
      .mockResolvedValueOnce("Prompted title")
      .mockResolvedValueOnce("It failed after reconnect.")
      .mockResolvedValueOnce("");

    await runCli(["node", "linkedin-buddy", "feedback"]);

    expect(feedbackCliMocks.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bug",
        title: "Prompted title",
        description: "It failed after reconnect."
      })
    );
    expect(stdoutChunks.join("\n")).toContain("Feedback filed:");
    expect(stderrChunks.join("")).toContain("Detailed explanation.");
  });

  it("submits saved pending feedback files", async () => {
    await runCli([
      "node",
      "linkedin-buddy",
      "feedback",
      "--submit-pending"
    ]);

    expect(feedbackCliMocks.submitPendingFeedback).toHaveBeenCalledTimes(1);
    expect(stdoutChunks.join("\n")).toContain("Submitted 1 pending feedback file");
    expect(stdoutChunks.join("\n")).toContain(".linkedin-buddy/pending-feedback/");
  });
});
