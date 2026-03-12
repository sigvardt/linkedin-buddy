import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV,
  LinkedInBuddyError,
  MAX_PENDING_FEEDBACK_FILES,
  buildFeedbackHintMessage,
  createFeedbackTechnicalContext,
  formatFeedbackDisplayPath,
  LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV,
  listPendingFeedbackFiles,
  normalizeFeedbackInputType,
  readPendingFeedbackFile,
  readFeedbackStateSnapshot,
  recordFeedbackInvocation,
  resolveFeedbackPaths,
  savePendingFeedback,
  scrubFeedbackText,
  submitFeedback,
  submitPendingFeedback,
} from "../src/index.js";

describe("feedback utilities", () => {
  let tempDir = "";
  let previousHintEveryN: string | undefined;
  let previousSessionIdleMs: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-feedback-"));
    previousHintEveryN = process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV];
    previousSessionIdleMs =
      process.env[LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV];
    process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV] = "3";
  });

  afterEach(async () => {
    if (previousHintEveryN === undefined) {
      delete process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV];
    } else {
      process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV] =
        previousHintEveryN;
    }
    if (previousSessionIdleMs === undefined) {
      delete process.env[LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV];
    } else {
      process.env[LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV] =
        previousSessionIdleMs;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("scrubs secrets and sensitive identifiers from feedback text", () => {
    const exampleBearerToken = [
      "test",
      "token",
      "placeholder",
      "for",
      "redaction",
    ].join("-");
    const exampleCookieValue = ["sample", "cookie", "placeholder"].join("-");
    const exampleIpAddress = [198, 51, 100, 24].join(".");
    const exampleHomePath = [
      "",
      "home",
      "sample-user",
      "workspace",
      "project",
      "file.ts",
    ].join("/");
    const input = [
      "Email: alice@example.com",
      `Authorization: Bearer ${exampleBearerToken}`,
      `Cookie: sessionid=${exampleCookieValue}`,
      "LinkedIn URL: https://www.linkedin.com/in/alice-example/",
      "LinkedIn URN: urn:li:member:123456789",
      `IP: ${exampleIpAddress}`,
      `Path: ${exampleHomePath}`,
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
    const exampleHomePath = [
      "",
      "home",
      "sample-user",
      "project",
      "src",
      "linkedin.ts",
    ].join("/");
    const first = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "status",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:00:00.000Z"),
    });
    const second = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "health",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:01:00.000Z"),
    });
    const third = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "profile view",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:02:00.000Z"),
    });
    const failed = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "feed list",
      activeProfileName: "default",
      now: new Date("2026-03-11T10:03:00.000Z"),
      error: new Error(`Request failed at ${exampleHomePath}`),
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

  it("returns context-aware hint messages by trigger reason", () => {
    const errorHint = buildFeedbackHintMessage("error");
    const nthHint = buildFeedbackHintMessage("nth_invocation");
    const defaultHint = buildFeedbackHintMessage();
    const sessionFirstHint = buildFeedbackHintMessage("session_first");

    expect(errorHint).toContain("issue");
    expect(errorHint).toContain("linkedin-buddy feedback");
    expect(nthHint).toContain("suggestions");
    expect(nthHint).toContain("linkedin-buddy feedback");
    expect(defaultHint).toContain("linkedin-buddy feedback");
    expect(sessionFirstHint).toContain("linkedin-buddy feedback");
    expect(errorHint).not.toBe(defaultHint);
    expect(nthHint).not.toBe(defaultHint);
  });

  it("submits feedback through gh when authenticated", async () => {
    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z"),
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
          source: "cli",
        }),
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
            stdout: "https://github.com/sigvardt/linkedin-buddy/issues/999\n",
          };
        },
      },
    );

    expect(result.status).toBe("submitted");
    expect(result.url).toBe(
      "https://github.com/sigvardt/linkedin-buddy/issues/999",
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
        "agent-feedback",
      ]),
    );
  });

  it("saves pending feedback locally and later submits it", async () => {
    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z"),
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
          mcpToolName: "submit_feedback",
        }),
      },
      {
        baseDir: tempDir,
        runner: async () => ({
          code: 1,
          stderr: "not logged in",
          stdout: "",
        }),
      },
    );

    expect(saved.status).toBe("saved_pending");
    expect(saved.pendingFilePath).toBeDefined();

    const pendingPath = saved.pendingFilePath ?? "";
    const pendingFile = await readFile(pendingPath, "utf8");
    expect(pendingFile).toContain("[Agent Feedback] Better MCP errors");
    expect(pendingFile).toContain("[REDACTED]");
    expect(formatFeedbackDisplayPath(pendingPath, tempDir)).toMatch(
      /^\.linkedin-buddy\/pending-feedback\//,
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
          stdout: "https://github.com/sigvardt/linkedin-buddy/issues/1000\n",
        };
      },
    });

    expect(submitted.submittedCount).toBe(1);
    expect(submitted.failureCount).toBe(0);
    expect(submitted.submitted[0]?.url).toBe(
      "https://github.com/sigvardt/linkedin-buddy/issues/1000",
    );
    await expect(readFile(pendingPath, "utf8")).rejects.toThrow();

    const feedbackPaths = resolveFeedbackPaths(tempDir);
    expect(feedbackPaths.pendingDir).toContain(".linkedin-buddy");
  });

  it("redacts jwt tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123.def456";
    const scrubbed = scrubFeedbackText(`token: ${jwt}`);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain(jwt);
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("redacts authorization headers", () => {
    const input = "Authorization: Bearer super-secret-token";
    const scrubbed = scrubFeedbackText(input);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain("super-secret-token");
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("redacts cookie headers", () => {
    const input = [
      "Cookie: sessionid=abc123",
      "Set-Cookie: li_at=secret-value; HttpOnly",
    ].join("\n");
    const scrubbed = scrubFeedbackText(input);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain("sessionid=abc123");
    expect(scrubbed.value).not.toContain("li_at=secret-value");
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("redacts secret assignments", () => {
    const input = 'api_key=xyz123 password: "abc"';
    const scrubbed = scrubFeedbackText(input);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain("xyz123");
    expect(scrubbed.value).not.toContain("abc");
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("redacts windows user paths", () => {
    const windowsPath = "C:\\Users\\alice\\project\\file.ts";
    const scrubbed = scrubFeedbackText(`path: ${windowsPath}`);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain(windowsPath);
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("redacts long secret blobs", () => {
    const blob =
      "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5QUJDREVGR0hJSktMTQ==";
    const scrubbed = scrubFeedbackText(`blob=${blob}`);

    expect(scrubbed.redacted).toBe(true);
    expect(scrubbed.value).not.toContain(blob);
    expect(scrubbed.value).toContain("[REDACTED]");
  });

  it("collapses repeated redaction tokens", () => {
    const scrubbed = scrubFeedbackText("[REDACTED] - [REDACTED] / [REDACTED]");

    expect(scrubbed.redacted).toBe(false);
    expect(scrubbed.value).toBe("[REDACTED]");
  });

  it("returns false when text has no sensitive content", () => {
    const input = "status command failed after reconnect without stack trace";
    const scrubbed = scrubFeedbackText(input);

    expect(scrubbed.redacted).toBe(false);
    expect(scrubbed.value).toBe(input);
  });

  it("returns empty string without redaction for empty input", () => {
    const scrubbed = scrubFeedbackText("");

    expect(scrubbed.redacted).toBe(false);
    expect(scrubbed.value).toBe("");
  });

  it("normalizes feedback type case insensitively", () => {
    expect(normalizeFeedbackInputType("BUG")).toBe("bug");
  });

  it("normalizes feedback type with trimmed whitespace", () => {
    expect(normalizeFeedbackInputType("  feature  ")).toBe("feature");
  });

  it("throws for invalid feedback type", () => {
    expect(() => normalizeFeedbackInputType("invalid")).toThrow(
      LinkedInBuddyError,
    );
  });

  it("resolves feedback paths under home directory by default", () => {
    const resolved = resolveFeedbackPaths();

    expect(resolved.feedbackRootDir).toBe(
      path.join(os.homedir(), ".linkedin-buddy"),
    );
    expect(resolved.pendingDir).toBe(
      path.join(os.homedir(), ".linkedin-buddy", "pending-feedback"),
    );
  });

  it("resolves feedback paths under a custom base directory", () => {
    const resolved = resolveFeedbackPaths("/custom/dir");

    expect(resolved.feedbackRootDir).toBe(
      path.join(path.resolve("/custom/dir"), ".linkedin-buddy"),
    );
    expect(resolved.statePath).toBe(
      path.join(
        path.resolve("/custom/dir"),
        ".linkedin-buddy",
        "feedback-state.json",
      ),
    );
  });

  it("formats display path as relative when file is inside feedback root", () => {
    const filePath = path.join(
      tempDir,
      ".linkedin-buddy",
      "pending-feedback",
      "entry.md",
    );

    expect(formatFeedbackDisplayPath(filePath, tempDir)).toBe(
      path.join(".linkedin-buddy", "pending-feedback", "entry.md"),
    );
  });

  it("formats display path as absolute when file is outside feedback root", () => {
    const outsideFilePath = path.join(tempDir, "outside.md");

    expect(
      formatFeedbackDisplayPath(outsideFilePath, path.join(tempDir, "other")),
    ).toBe(outsideFilePath);
  });

  it("includes humanized session duration in feedback body", async () => {
    const result = await submitFeedback(
      {
        type: "bug",
        title: "duration formatting",
        description: "checks duration format",
        technicalContext: createFeedbackTechnicalContext({
          cliVersion: "0.1.0",
          snapshot: {
            activeProfileName: "default",
            invocationCount: 1,
            lastErrorStack: null,
            lastInvocationName: "feedback",
            lastMcpToolName: null,
            sessionDurationMs: 3_726_000,
            sessionId: "session-1",
            sessionStartedAt: "2026-03-11T10:00:00.000Z",
          },
          source: "cli",
        }),
      },
      {
        baseDir: tempDir,
        runner: async () => ({ code: 1, stderr: "not logged in", stdout: "" }),
      },
    );

    expect(result.body).toContain("- Session duration: 1h 2m 6s");
  });

  it("expires session state after configured idle threshold", async () => {
    process.env[LINKEDIN_BUDDY_FEEDBACK_SESSION_IDLE_MS_ENV] = "0";

    const first = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "status",
      now: new Date("2026-03-11T10:00:00.000Z"),
    });
    const second = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "status",
      now: new Date("2026-03-11T10:00:00.001Z"),
    });

    expect(first.snapshot.sessionId).not.toBe(second.snapshot.sessionId);
    expect(second.reason).toBe("session_first");
  });

  it("returns zero-count snapshot for fresh feedback state", async () => {
    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z"),
    });

    expect(snapshot.invocationCount).toBe(0);
    expect(snapshot.lastInvocationName).toBeNull();
    expect(snapshot.lastErrorStack).toBeNull();
    expect(snapshot.sessionDurationMs).toBe(0);
  });

  it("uses hint cadence from environment override", async () => {
    process.env[LINKEDIN_BUDDY_FEEDBACK_HINT_EVERY_N_ENV] = "2";

    await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "status",
      now: new Date("2026-03-11T10:00:00.000Z"),
    });
    const second = await recordFeedbackInvocation({
      baseDir: tempDir,
      source: "cli",
      invocationName: "health",
      now: new Date("2026-03-11T10:00:30.000Z"),
    });

    expect(second.showHint).toBe(true);
    expect(second.reason).toBe("nth_invocation");
  });

  it("returns empty pending file list when directory is missing", async () => {
    const pendingFiles = await listPendingFeedbackFiles(tempDir);

    expect(pendingFiles).toEqual([]);
  });

  it("throws when pending feedback metadata is malformed", async () => {
    const malformedFilePath = path.join(tempDir, "malformed.md");
    await writeFile(
      malformedFilePath,
      [
        "<!-- linkedin-buddy-feedback-metadata",
        '{"createdAt":"2026-03-11T10:00:00.000Z"}',
        "-->",
        "body",
      ].join("\n"),
      "utf8",
    );

    await expect(readPendingFeedbackFile(malformedFilePath)).rejects.toThrow(
      "metadata is incomplete",
    );
  });

  it("throws helpful error when submitting pending feedback without gh auth", async () => {
    await submitFeedback(
      {
        type: "bug",
        title: "pending auth failure",
        description: "save pending first",
        technicalContext: createFeedbackTechnicalContext({
          cliVersion: "0.1.0",
          snapshot: {
            activeProfileName: "default",
            invocationCount: 0,
            lastErrorStack: null,
            lastInvocationName: null,
            lastMcpToolName: null,
            sessionDurationMs: 0,
            sessionId: "session-1",
            sessionStartedAt: "2026-03-11T10:00:00.000Z",
          },
          source: "cli",
        }),
      },
      {
        baseDir: tempDir,
        runner: async () => ({ code: 1, stderr: "not logged in", stdout: "" }),
      },
    );

    await expect(
      submitPendingFeedback({
        baseDir: tempDir,
        runner: async () => ({ code: 1, stderr: "not logged in", stdout: "" }),
      }),
    ).rejects.toThrow("gh auth login");
  });

  it("falls back to pending file when github issue creation fails", async () => {
    const result = await submitFeedback(
      {
        type: "bug",
        title: "gh issue create failure",
        description: "save pending on issue failure",
        technicalContext: createFeedbackTechnicalContext({
          cliVersion: "0.1.0",
          snapshot: {
            activeProfileName: "default",
            invocationCount: 0,
            lastErrorStack: null,
            lastInvocationName: null,
            lastMcpToolName: null,
            sessionDurationMs: 0,
            sessionId: "session-1",
            sessionStartedAt: "2026-03-11T10:00:00.000Z",
          },
          source: "cli",
        }),
      },
      {
        baseDir: tempDir,
        runner: async (_command, args) => {
          if (args[0] === "auth") {
            return { code: 0, stderr: "", stdout: "ok" };
          }

          return { code: 1, stderr: "create failed", stdout: "" };
        },
      },
    );

    expect(result.status).toBe("saved_pending");
    expect(result.pendingFilePath).toBeDefined();
  });

  it("throws when invocation name is empty", async () => {
    await expect(
      recordFeedbackInvocation({
        baseDir: tempDir,
        source: "cli",
        invocationName: "   ",
      }),
    ).rejects.toThrow("invocation name must not be empty");
  });

  it("rejects saving when pending file count exceeds the limit", async () => {
    const feedbackPaths = resolveFeedbackPaths(tempDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(feedbackPaths.pendingDir, { recursive: true });

    for (let i = 0; i < MAX_PENDING_FEEDBACK_FILES; i++) {
      const padded = String(i).padStart(4, "0");
      await writeFile(
        path.join(
          feedbackPaths.pendingDir,
          `2026-01-01T00-00-00-000Z-bug-${padded}.md`,
        ),
        [
          "<!-- linkedin-buddy-feedback-metadata",
          JSON.stringify({
            createdAt: "2026-01-01T00:00:00.000Z",
            labels: ["bug", "agent-feedback"],
            redactionApplied: false,
            title: `[Agent Feedback] placeholder ${padded}`,
            type: "bug",
          }),
          "-->",
          "",
          "placeholder body",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    const snapshot = await readFeedbackStateSnapshot({
      baseDir: tempDir,
      now: new Date("2026-03-11T10:00:00.000Z"),
    });

    await expect(
      savePendingFeedback(
        {
          type: "bug",
          title: "one more",
          description: "exceeds limit",
          technicalContext: createFeedbackTechnicalContext({
            cliVersion: "0.1.0",
            snapshot,
            source: "cli",
          }),
        },
        { baseDir: tempDir },
      ),
    ).rejects.toThrow(`Cannot save more than ${MAX_PENDING_FEEDBACK_FILES}`);
  });

  it("rejects reading an oversized pending feedback file", async () => {
    const feedbackPaths = resolveFeedbackPaths(tempDir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(feedbackPaths.pendingDir, { recursive: true });

    const oversizedPath = path.join(
      feedbackPaths.pendingDir,
      "2026-01-01T00-00-00-000Z-bug.md",
    );
    const largeContent = "x".repeat(600 * 1024);
    await writeFile(oversizedPath, largeContent, "utf8");

    await expect(readPendingFeedbackFile(oversizedPath)).rejects.toThrow(
      "byte limit",
    );
  });
});
