import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFeedbackHintMessage,
  createFeedbackTechnicalContext,
  formatFeedbackDisplayPath,
  LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV,
  readFeedbackStateSnapshot,
  recordFeedbackInvocation,
  resolveFeedbackPaths,
  scrubFeedbackText,
  submitFeedback,
  submitPendingFeedback
} from "../src/index.js";

describe("feedback utilities", () => {
  let tempDir = "";
  let previousHintEveryN: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-feedback-"));
    previousHintEveryN =
      process.env[LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV];
    process.env[LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV] = "3";
  });

  afterEach(async () => {
    if (previousHintEveryN === undefined) {
      delete process.env[LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV];
    } else {
      process.env[LINKEDIN_ASSISTANT_FEEDBACK_HINT_EVERY_N_ENV] = previousHintEveryN;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("scrubs secrets and sensitive identifiers from feedback text", () => {
    const exampleBearerToken = [
      "test",
      "token",
      "placeholder",
      "for",
      "redaction"
    ].join("-");
    const exampleCookieValue = ["sample", "cookie", "placeholder"].join("-");
    const exampleIpAddress = [198, 51, 100, 24].join(".");
    const exampleHomePath = ["", "home", "sample-user", "workspace", "project", "file.ts"].join(
      "/"
    );
    const input = [
      "Email: alice@example.com",
      `Authorization: Bearer ${exampleBearerToken}`,
      `Cookie: sessionid=${exampleCookieValue}`,
      "LinkedIn URL: https://www.linkedin.com/in/alice-example/",
      "LinkedIn URN: urn:li:member:123456789",
      `IP: ${exampleIpAddress}`,
      `Path: ${exampleHomePath}`
    ].join("\n");

    const scrubbed = scrubFeedbackText(input);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain("alice@example.com");
    expect(scrubbed.value).not.toContain("linkedin.com/in/alice-example");
    expect(scrubbed.value).not.toContain("urn:li:member:123456789");
    expect(scrubbed.value).not.toContain(exampleIpAddress);
    expect(scrubbed.value).not.toContain(exampleHomePath);
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("shows hints on first session use, every nth invocation, and errors", async () => {
    const exampleHomePath = ["", "home", "sample-user", "project", "src", "linkedin.ts"].join(
      "/"
    );
    const first = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "status",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:00:00.000Z")
    });
    const second = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "health",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:01:00.000Z")
    });
    const third = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "profile view",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:02:00.000Z")
    });
    const failed = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "feed list",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:03:00.000Z"),
      error: new Error(`Request failed at ${exampleHomePath}`)
    });

    expect(first.showHint).toBe(true);
    expect(first.reason).toBe("session_first");
    expect(second.showHint).toBe(false);
    expect(third.showHint).toBe(true);
    expect(third.reason).toBe("nth_invocation");
    expect(failed.showHint).toBe(true);
    expect(failed.reason).toBe("error");
    expect(failed.snapshot.lastErrorStack).toContain("[REDACTED]");
    expect(buildFeedbackHintMessage()).toContain("linkedin-buddy feedback");
  });

  it("submits feedback through gh when authenticated", async () => {
    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z")
    });

    const ghCalls: Array<{ args: string[]; command: string }> = [];
    const result = await submitFeedback(
      {
        type: "bug",
        title: "Status command fails after reconnect",
        description: "It crashes after the browser reconnect flow completes.",
        technicalContext: createFeedbackTechnicalContext({
          cliVersion: "0.1.0",
          snapshot,
          source: "cli"
        })
      },
      {
        baseDir: tempDir,
        runner: async (command, args) => {
          ghCalls.push({ command, args });

          if (args[0] === "auth") {
            return { code: 0, stderr: "", stdout: "ok" };
          }

          return {
            code: 0,
            stderr: "",
            stdout: "https://github.com/sigvardt/linkedin-buddy/issues/999\n"
          };
        }
      }
    );

    expect(result.status).toBe("submitted");
    expect(result.url).toBe(
      "https://github.com/sigvardt/linkedin-buddy/issues/999"
    );
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[1]?.args).toEqual(
      expect.arrayContaining([
        "issue",
        "create",
        "--repo",
        "sigvardt/linkedin-buddy",
        "--label",
        "bug",
        "--label",
        "agent-feedback"
      ])
    );
  });

  it("saves pending feedback locally and later submits it", async () => {
    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z")
    });

    const saved = await submitFeedback(
      {
        type: "improvement",
        title: "Better MCP errors",
        description:
          "The error payload included alice@example.com and https://www.linkedin.com/in/alice-example/ but it should be redacted.",
        technicalContext: createFeedbackTechnicalContext({
          cliVersion: "0.1.0",
          snapshot,
          source: "mcp",
          mcpToolName: "submit_feedback"
        })
      },
      {
        baseDir: tempDir,
        runner: async () => ({
          code: 1,
          stderr: "not logged in",
          stdout: ""
        })
      }
    );

    expect(saved.status).toBe("saved_pending");
    expect(saved.pendingFilePath).toBeDefined();

    const pendingPath = saved.pendingFilePath ?? "";
    const pendingFile = await readFile(pendingPath, "utf8");
    expect(pendingFile).toContain("[Agent Feedback] Better MCP errors");
    expect(pendingFile).toContain("[REDACTED]");
    expect(formatFeedbackDisplayPath(pendingPath, tempDir)).toMatch(
      /^\.linkedin-buddy\/pending-feedback\//
    );

    const submitted = await submitPendingFeedback({
      baseDir: tempDir,
      runner: async (_command, args) => {
        if (args[0] === "auth") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        return {
          code: 0,
          stderr: "",
          stdout: "https://github.com/sigvardt/linkedin-buddy/issues/1000\n"
        };
      }
    });

    expect(submitted.submittedCount).toBe(1);
    expect(submitted.failureCount).toBe(0);
    expect(submitted.submitted[0]?.url).toBe(
      "https://github.com/sigvardt/linkedin-buddy/issues/1000"
    );
    await expect(readFile(pendingPath, "utf8")).rejects.toThrow();

    const feedbackPaths = resolveFeedbackPaths(tempDir);
    expect(feedbackPaths.pendingDir).toContain(".linkedin-buddy");
  });
});
