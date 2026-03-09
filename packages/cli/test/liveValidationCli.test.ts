import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const liveValidationCliMocks = vi.hoisted(() => ({
  answers: [] as string[],
  captureLinkedInSession: vi.fn(),
  runReadOnlyLinkedInLiveValidation: vi.fn()
}));

vi.mock("node:readline/promises", async () => {
  const actual = await vi.importActual<typeof import("node:readline/promises")>(
    "node:readline/promises"
  );

  return {
    ...actual,
    createInterface: vi.fn(() => ({
      close: vi.fn(),
      question: vi.fn(async () => liveValidationCliMocks.answers.shift() ?? "yes")
    }))
  };
});

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");

  return {
    ...actual,
    captureLinkedInSession: liveValidationCliMocks.captureLinkedInSession,
    runReadOnlyLinkedInLiveValidation:
      liveValidationCliMocks.runReadOnlyLinkedInLiveValidation
  };
});

import { LinkedInAssistantError } from "@linkedin-assistant/core";
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

function createValidationReport(
  outcome: "pass" | "fail" = "pass"
): Record<string, unknown> {
  return {
    blocked_request_count: 0,
    blocked_requests: [],
    checked_at: "2026-03-09T10:00:00.000Z",
    diff: {
      recoveries: [],
      regressions: [],
      unchanged_count: 2
    },
    events_path: "/tmp/live-readonly/events.jsonl",
    fail_count: outcome === "fail" ? 1 : 0,
    latest_report_path: "/tmp/live-readonly/latest-report.json",
    operation_count: 1,
    operations: [
      {
        attempt_count: 1,
        completed_at: "2026-03-09T10:00:05.000Z",
        failed_count: outcome === "fail" ? 1 : 0,
        final_url: "https://www.linkedin.com/feed/",
        matched_count: outcome === "fail" ? 0 : 1,
        operation: "feed",
        page_load_ms: 1400,
        selector_results: [
          {
            description: "Feed content surface",
            ...(outcome === "fail"
              ? {
                  error: "No selector candidate matched feed_surface.",
                  matched_candidate_key: null,
                  matched_candidate_rank: null,
                  matched_selector: null,
                  status: "fail"
                }
              : {
                  matched_candidate_key: "feed-update-card",
                  matched_candidate_rank: 0,
                  matched_selector: "div.feed-shared-update-v2",
                  status: "pass"
                }),
            selector_key: "feed_surface"
          }
        ],
        started_at: "2026-03-09T10:00:00.000Z",
        status: outcome,
        summary: "Load the LinkedIn feed and verify the main feed surface.",
        url: "https://www.linkedin.com/feed/",
        warnings: []
      }
    ],
    outcome,
    pass_count: outcome === "fail" ? 0 : 1,
    recommended_actions: ["Open /tmp/live-readonly/report.json"],
    report_path: "/tmp/live-readonly/report.json",
    request_limits: {
      max_requests: 20,
      max_requests_reached: false,
      min_interval_ms: 5000,
      used_requests: 1
    },
    run_id: "run_live_validation_test",
    session: {
      captured_at: "2026-03-09T09:00:00.000Z",
      file_path: "/tmp/session.enc.json",
      li_at_expires_at: "2026-04-01T00:00:00.000Z",
      session_name: "smoke"
    },
    summary: "Checked 1 read-only LinkedIn operation. 1 passed. 0 failed."
  };
}

describe("linkedin live validation CLI", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setInteractiveMode(true, true);
    process.exitCode = undefined;
    liveValidationCliMocks.answers = [];
    vi.clearAllMocks();
    stderrChunks = [];
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("captures a stored session through the auth:session alias", async () => {
    liveValidationCliMocks.captureLinkedInSession.mockResolvedValue({
      authenticated: true,
      capturedAt: "2026-03-09T09:00:00.000Z",
      checkedAt: "2026-03-09T09:01:00.000Z",
      currentUrl: "https://www.linkedin.com/feed/",
      filePath: "/tmp/stored-session.enc.json",
      liAtCookieExpiresAt: "2026-04-01T00:00:00.000Z",
      sessionName: "smoke"
    });

    await runCli([
      "node",
      "linkedin",
      "auth:session",
      "--session",
      "smoke"
    ]);

    expect(liveValidationCliMocks.captureLinkedInSession).toHaveBeenCalledWith({
      sessionName: "smoke",
      timeoutMs: 600_000
    });
    expect(JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ""))).toMatchObject({
      authenticated: true,
      session_name: "smoke"
    });
  });

  it("requires --read-only for live validation", async () => {
    await expect(
      runCli(["node", "linkedin", "test:live", "--yes"])
    ).rejects.toThrow("--read-only");
  });

  it("refuses interactive live validation when no TTY is available", async () => {
    setInteractiveMode(false, false);

    await expect(
      runCli(["node", "linkedin", "test:live", "--read-only"])
    ).rejects.toThrow("non-interactive mode");
  });

  it("prints JSON and sets exit code when the validation report fails", async () => {
    setInteractiveMode(false, false);
    liveValidationCliMocks.runReadOnlyLinkedInLiveValidation.mockResolvedValue(
      createValidationReport("fail")
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--read-only",
      "--yes",
      "--json"
    ]);

    expect(process.exitCode).toBe(1);
    expect(
      JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ""))
    ).toMatchObject({
      outcome: "fail"
    });
  });

  it("passes retry and pacing overrides through to core live validation", async () => {
    setInteractiveMode(false, false);
    liveValidationCliMocks.runReadOnlyLinkedInLiveValidation.mockResolvedValue(
      createValidationReport("pass")
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--read-only",
      "--yes",
      "--json",
      "--max-requests",
      "25",
      "--min-interval-ms",
      "2500",
      "--max-retries",
      "3",
      "--retry-base-delay-ms",
      "200",
      "--retry-max-delay-ms",
      "400"
    ]);

    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).toHaveBeenCalledWith({
      maxRequests: 25,
      maxRetries: 3,
      minIntervalMs: 2500,
      retryBaseDelayMs: 200,
      retryMaxDelayMs: 400,
      sessionName: "default",
      timeoutMs: 30_000
    });
  });

  it("prints a human-readable error and exits when the live validation is rate limited", async () => {
    liveValidationCliMocks.runReadOnlyLinkedInLiveValidation.mockRejectedValue(
      new LinkedInAssistantError(
        "RATE_LIMITED",
        "Read-only live validation reached the per-session request cap (20) before inbox.",
        {
          max_requests: 20,
          operation: "inbox",
          used_requests: 20
        }
      )
    );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--read-only",
      "--yes"
    ]);

    expect(process.exitCode).toBe(1);
    expect(liveValidationCliMocks.captureLinkedInSession).not.toHaveBeenCalled();
    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).toHaveBeenCalledTimes(1);
    expect(stderrChunks.join("")).toContain("Live validation failed [RATE_LIMITED]");
    expect(stderrChunks.join("")).toContain("per-session request cap");
  });

  it("rejects retry windows where the max delay is smaller than the base delay", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "test:live",
        "--read-only",
        "--yes",
        "--retry-base-delay-ms",
        "2000",
        "--retry-max-delay-ms",
        "1000"
      ])
    ).rejects.toThrow("retry-max-delay-ms");

    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).not.toHaveBeenCalled();
  });

  it("rejects cdp-url overrides for the visible test live command", async () => {
    await expect(
      runCli([
        "node",
        "linkedin",
        "--cdp-url",
        "http://127.0.0.1:18800",
        "test",
        "live",
        "--read-only",
        "--yes",
        "--json"
      ])
    ).rejects.toThrow("do not support --cdp-url");

    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).not.toHaveBeenCalled();
  });

  it("prompts for re-auth, captures a fresh session, and retries once", async () => {
    liveValidationCliMocks.answers = ["yes"];
    liveValidationCliMocks.captureLinkedInSession.mockResolvedValue({
      authenticated: true,
      capturedAt: "2026-03-09T09:30:00.000Z",
      checkedAt: "2026-03-09T09:31:00.000Z",
      currentUrl: "https://www.linkedin.com/feed/",
      filePath: "/tmp/stored-session.enc.json",
      liAtCookieExpiresAt: "2026-04-01T00:00:00.000Z",
      sessionName: "smoke"
    });
    liveValidationCliMocks.runReadOnlyLinkedInLiveValidation
      .mockRejectedValueOnce(
        new LinkedInAssistantError(
          "AUTH_REQUIRED",
          "Stored session is expired.",
          { session_name: "smoke" }
        )
      )
      .mockResolvedValueOnce(createValidationReport("pass"));

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--read-only",
      "--json",
      "--session",
      "smoke"
    ]);

    expect(liveValidationCliMocks.captureLinkedInSession).toHaveBeenCalledTimes(1);
    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ""))
    ).toMatchObject({
      outcome: "pass",
      session: {
        session_name: "smoke"
      }
    });
  });

  it("formats a second failure cleanly after refreshing the stored session", async () => {
    liveValidationCliMocks.answers = ["yes"];
    liveValidationCliMocks.captureLinkedInSession.mockResolvedValue({
      authenticated: true,
      capturedAt: "2026-03-09T09:30:00.000Z",
      checkedAt: "2026-03-09T09:31:00.000Z",
      currentUrl: "https://www.linkedin.com/feed/",
      filePath: "/tmp/stored-session.enc.json",
      liAtCookieExpiresAt: "2026-04-01T00:00:00.000Z",
      sessionName: "smoke"
    });
    liveValidationCliMocks.runReadOnlyLinkedInLiveValidation
      .mockRejectedValueOnce(
        new LinkedInAssistantError(
          "AUTH_REQUIRED",
          "Stored session is expired.",
          { session_name: "smoke" }
        )
      )
      .mockRejectedValueOnce(
        new LinkedInAssistantError(
          "RATE_LIMITED",
          "Read-only live validation reached the per-session request cap (20) before inbox.",
          {
            max_requests: 20,
            operation: "inbox",
            used_requests: 20
          }
        )
      );

    await runCli([
      "node",
      "linkedin",
      "test:live",
      "--read-only",
      "--session",
      "smoke"
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join(""))
      .toContain("Live validation failed [RATE_LIMITED]");
    expect(liveValidationCliMocks.captureLinkedInSession).toHaveBeenCalledTimes(1);
    expect(liveValidationCliMocks.runReadOnlyLinkedInLiveValidation).toHaveBeenCalledTimes(2);
  });
});
