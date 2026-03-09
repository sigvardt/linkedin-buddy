import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activityCliMocks = vi.hoisted(() => ({
  activityPollerRunTick: vi.fn(),
  activityWatchesCreateWatch: vi.fn(),
  activityWatchesCreateWebhookSubscription: vi.fn(),
  close: vi.fn(),
  createCoreRuntime: vi.fn(),
  loggerLog: vi.fn()
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");

  return {
    ...actual,
    createCoreRuntime: activityCliMocks.createCoreRuntime
  };
});

import {
  LinkedInAssistantError,
  resolveConfigPaths
} from "@linkedin-assistant/core";
import { createCliProgram, runCli } from "../src/bin/linkedin.js";

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

function createWatch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "watch_cli_123",
    profileName: "default",
    kind: "notifications",
    target: {
      limit: 20
    },
    scheduleKind: "interval",
    pollIntervalMs: 900_000,
    cronExpression: null,
    status: "active",
    nextPollAtMs: Date.parse("2026-03-09T09:00:00.000Z"),
    lastPolledAtMs: null,
    lastSuccessAtMs: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAtMs: Date.parse("2026-03-09T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-03-09T08:00:00.000Z"),
    ...overrides
  };
}

function createTickResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    profileName: "default",
    workerId: "cli:run-activity-cli",
    claimedWatches: 1,
    polledWatches: 1,
    failedWatches: 0,
    emittedEvents: 2,
    enqueuedDeliveries: 2,
    claimedDeliveries: 1,
    deliveredAttempts: 1,
    retriedDeliveries: 0,
    failedDeliveries: 0,
    deadLetterDeliveries: 0,
    disabledSubscriptions: 0,
    watchResults: [
      {
        watchId: "watch_cli_123",
        kind: "notifications",
        emittedEvents: 2,
        enqueuedDeliveries: 2
      }
    ],
    deliveryResults: [
      {
        deliveryId: "delivery_cli_123",
        subscriptionId: "whsub_cli_123",
        outcome: "delivered",
        responseStatus: 204
      }
    ],
    ...overrides
  };
}

describe("linkedin activity CLI UX", () => {
  let previousActivityEnabled: string | undefined;
  let previousHome: string | undefined;
  let stderrChunks: string[] = [];
  let stdoutChunks: string[] = [];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "linkedin-cli-activity-"))
    );
    previousActivityEnabled = process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED;
    previousHome = process.env.LINKEDIN_ASSISTANT_HOME;
    process.env.LINKEDIN_ASSISTANT_HOME = path.join(tempDir, "assistant-home");
    delete process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED;

    process.exitCode = undefined;
    stderrChunks = [];
    stdoutChunks = [];
    setInteractiveMode(true, true);

    vi.clearAllMocks();

    activityCliMocks.activityPollerRunTick.mockResolvedValue(createTickResult());
    activityCliMocks.activityWatchesCreateWatch.mockReturnValue(createWatch());
    activityCliMocks.activityWatchesCreateWebhookSubscription.mockReturnValue({
      id: "whsub_cli_123",
      watchId: "watch_cli_123",
      status: "active",
      eventTypes: ["linkedin.notifications.item.created"],
      deliveryUrl: "https://example.com/hooks/linkedin",
      maxAttempts: 6,
      signingSecret: "whsec_cli_123",
      lastDeliveredAtMs: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAtMs: Date.parse("2026-03-09T08:00:00.000Z"),
      updatedAtMs: Date.parse("2026-03-09T08:00:00.000Z")
    });

    activityCliMocks.createCoreRuntime.mockImplementation(() => ({
      runId: "run-activity-cli",
      logger: {
        log: activityCliMocks.loggerLog
      },
      activityPoller: {
        runTick: activityCliMocks.activityPollerRunTick
      },
      activityWatches: {
        createWatch: activityCliMocks.activityWatchesCreateWatch,
        createWebhookSubscription:
          activityCliMocks.activityWatchesCreateWebhookSubscription,
        listDeliveries: vi.fn().mockReturnValue([]),
        listEvents: vi.fn().mockReturnValue([]),
        listWatches: vi.fn().mockReturnValue([]),
        listWebhookSubscriptions: vi.fn().mockReturnValue([]),
        pauseWatch: vi.fn().mockReturnValue(createWatch({ status: "paused" })),
        pauseWebhookSubscription: vi.fn(),
        removeWatch: vi.fn().mockReturnValue(true),
        removeWebhookSubscription: vi.fn().mockReturnValue(true),
        resumeWatch: vi.fn().mockReturnValue(createWatch()),
        resumeWebhookSubscription: vi.fn()
      },
      close: activityCliMocks.close
    }));

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutChunks.push(args.map((value) => String(value)).join(" "));
    });
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        stderrChunks.push(String(args[0]));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;

    if (previousActivityEnabled === undefined) {
      delete process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED;
    } else {
      process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED = previousActivityEnabled;
    }

    if (previousHome === undefined) {
      delete process.env.LINKEDIN_ASSISTANT_HOME;
    } else {
      process.env.LINKEDIN_ASSISTANT_HOME = previousHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("documents human-readable activity output and json mode in help", () => {
    const program = createCliProgram();
    const activityCommand = program.commands.find((command) => command.name() === "activity");
    const activityWatchCommand = activityCommand?.commands.find(
      (command) => command.name() === "watch"
    );
    const watchAddCommand = activityWatchCommand?.commands.find(
      (command) => command.name() === "add"
    );
    const runOnceCommand = activityCommand?.commands.find(
      (command) => command.name() === "run-once"
    );

    expect(activityCommand?.helpInformation() ?? "").toContain(
      "human-readable activity summaries"
    );
    expect(watchAddCommand?.helpInformation() ?? "").toContain("--json");
    expect(runOnceCommand?.helpInformation() ?? "").toContain("--json");
  });

  it("prints a human-readable watch creation summary", async () => {
    await runCli([
      "node",
      "linkedin",
      "activity",
      "watch",
      "add",
      "--kind",
      "notifications",
      "--interval-seconds",
      "900"
    ]);

    const output = stdoutChunks.join("\n");

    expect(output).toContain("Created activity watch for profile default");
    expect(output).toContain("Watch id: watch_cli_123");
    expect(output).toContain("Next Steps");
    expect(activityCliMocks.loggerLog).toHaveBeenCalledWith(
      "info",
      "cli.activity.watch.add.start",
      expect.objectContaining({
        profile_name: "default"
      })
    );
  });

  it("formats thrown activity command errors for humans", async () => {
    activityCliMocks.activityWatchesCreateWebhookSubscription.mockImplementation(() => {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "deliveryUrl must be a valid URL.",
        {
          example: "https://example.com/hooks/linkedin",
          field: "deliveryUrl",
          suggestion: "Use an absolute http(s) webhook endpoint.",
          value: "not-a-url"
        }
      );
    });

    await runCli([
      "node",
      "linkedin",
      "activity",
      "webhook",
      "add",
      "--watch",
      "watch_cli_123",
      "--url",
      "not-a-url"
    ]);

    const stderrOutput = stderrChunks.join("");

    expect(stderrOutput).toContain("Activity command failed [ACTION_PRECONDITION_FAILED]");
    expect(stderrOutput).toContain("Field: deliveryUrl");
    expect(stderrOutput).toContain("Suggested fix: Use an absolute http(s) webhook endpoint.");
    expect(stderrOutput).toContain("Rerun with --json if you need the structured error payload.");
    expect(process.exitCode).toBe(1);
  });

  it("prints progress notices and a clear human-readable run-once summary", async () => {
    activityCliMocks.activityPollerRunTick.mockResolvedValue(
      createTickResult({
        failedWatches: 1,
        watchResults: [
          {
            watchId: "watch_cli_123",
            kind: "notifications",
            emittedEvents: 0,
            enqueuedDeliveries: 0,
            errorCode: "NETWORK_ERROR",
            errorMessage: "Temporary timeout while polling notifications."
          }
        ]
      })
    );

    await runCli(["node", "linkedin", "activity", "run-once", "--profile", "default"]);

    expect(stderrChunks.join("")).toContain(
      'Running one activity polling tick for profile "default".'
    );
    const output = stdoutChunks.join("\n");
    expect(output).toContain("Activity poll tick completed for profile default");
    expect(output).toContain("Watch Results");
    expect(output).toContain("NETWORK_ERROR");
    expect(process.exitCode).toBe(1);
  });

  it("shows actionable config guidance in human-readable status output", async () => {
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_ENABLED = "sometimes";

    await runCli(["node", "linkedin", "activity", "status", "--profile", "default"]);

    const output = stdoutChunks.join("\n");

    expect(output).toContain("Activity daemon status for profile default");
    expect(output).toContain("Config Issue");
    expect(output).toContain("Setting: LINKEDIN_ASSISTANT_ACTIVITY_ENABLED");
    expect(output).toContain("Example: LINKEDIN_ASSISTANT_ACTIVITY_ENABLED=false");
    expect(output).toContain("Suggested fix:");
    expect(process.exitCode).toBe(1);
  });

  it("redacts secret-bearing CDP URLs from persisted daemon diagnostics", async () => {
    const secretBearingUrl =
      "ws://user:pass@127.0.0.1:9222/devtools/browser/abc?token=secret#frag";
    activityCliMocks.activityPollerRunTick.mockImplementation(async () => {
      process.emit("SIGTERM");
      throw new Error(`Failed to connect to ${secretBearingUrl}`);
    });

    await runCli([
      "node",
      "linkedin",
      "--cdp-url",
      secretBearingUrl,
      "activity",
      "__run",
      "--profile",
      "default"
    ]);

    const activityDir = path.join(resolveConfigPaths().baseDir, "activity");
    const eventLog = await readFile(path.join(activityDir, "default.events.jsonl"), "utf8");
    const stateFile = await readFile(path.join(activityDir, "default.state.json"), "utf8");

    expect(eventLog).not.toContain("user:pass@");
    expect(eventLog).not.toContain("token=secret");
    expect(eventLog).not.toContain("#frag");
    expect(stateFile).not.toContain("user:pass@");
    expect(stateFile).not.toContain("token=secret");
    expect(stateFile).not.toContain("#frag");
    expect(eventLog).toContain("ws://127.0.0.1:9222/devtools/browser/abc");
  });
});
