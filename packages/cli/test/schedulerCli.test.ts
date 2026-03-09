import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const schedulerCliMocks = vi.hoisted(() => ({
  close: vi.fn(),
  createCoreRuntime: vi.fn(),
  loggerLog: vi.fn(),
  schedulerRunTick: vi.fn(),
  spawn: vi.fn()
}));

vi.mock("@linkedin-assistant/core", async () => {
  const actual = await import("../../core/src/index.js");

  class MockSchedulerService {
    constructor() {}

    async runTick(input: { profileName?: string; workerId?: string }) {
      return await schedulerCliMocks.schedulerRunTick(input);
    }
  }

  return {
    ...actual,
    createCoreRuntime: schedulerCliMocks.createCoreRuntime,
    LinkedInSchedulerService: MockSchedulerService
  };
});

vi.mock("node:child_process", () => ({
  spawn: schedulerCliMocks.spawn
}));

import { AssistantDatabase, resolveConfigPaths } from "@linkedin-assistant/core";
import { createCliProgram, runCli } from "../src/bin/linkedin.js";

const SCHEDULER_ENV_KEYS = [
  "LINKEDIN_ASSISTANT_HOME",
  "LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE"
] as const;

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

function createTickResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    profileName: "default",
    workerId: "cli:run-scheduler-cli",
    windowOpen: true,
    nextWindowStartAt: null,
    skippedReason: null,
    discoveredAcceptedConnections: 0,
    queuedJobs: 0,
    updatedJobs: 0,
    reopenedJobs: 0,
    cancelledJobs: 0,
    claimedJobs: 0,
    preparedJobs: 0,
    rescheduledJobs: 0,
    failedJobs: 0,
    processedJobs: [],
    ...overrides
  };
}

describe("linkedin scheduler CLI UX", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let previousEnv = new Map<string, string | undefined>();
  let stderrChunks: string[] = [];
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-scheduler-"));
    previousEnv = new Map<string, string | undefined>();
    for (const key of SCHEDULER_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }

    process.env.LINKEDIN_ASSISTANT_HOME = path.join(tempDir, "assistant-home");
    process.exitCode = undefined;
    setInteractiveMode(true, true);
    stderrChunks = [];
    vi.clearAllMocks();
    schedulerCliMocks.spawn.mockImplementation(() => ({
      pid: 12_345,
      unref: vi.fn()
    }));
    schedulerCliMocks.createCoreRuntime.mockImplementation(() => ({
      runId: "run-scheduler-cli",
      db: {},
      logger: { log: schedulerCliMocks.loggerLog },
      followups: {},
      close: schedulerCliMocks.close
    }));
    schedulerCliMocks.schedulerRunTick.mockResolvedValue(createTickResult());
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        const [chunk] = args;
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
    for (const key of SCHEDULER_ENV_KEYS) {
      const previousValue = previousEnv.get(key);
      if (typeof previousValue === "string") {
        process.env[key] = previousValue;
      } else {
        delete process.env[key];
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedSchedulerState(): Promise<void> {
    const schedulerDir = path.join(resolveConfigPaths().baseDir, "scheduler");
    await mkdir(schedulerDir, { recursive: true });
    await writeFile(
      path.join(schedulerDir, "default.state.json"),
      `${JSON.stringify(
        {
          pid: 12_345,
          profileName: "default",
          startedAt: "2026-03-09T08:00:00.000Z",
          updatedAt: "2026-03-09T08:05:00.000Z",
          status: "idle",
          pollIntervalMs: 300_000,
          businessHours: {
            timeZone: "UTC",
            startTime: "09:00",
            endTime: "17:00"
          },
          maxJobsPerTick: 2,
          maxActiveJobsPerProfile: 100,
          consecutiveFailures: 0,
          maxConsecutiveFailures: 5,
          lastTickAt: "2026-03-09T08:05:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  async function seedSchedulerJobs(): Promise<void> {
    const db = new AssistantDatabase(resolveConfigPaths().dbPath);
    try {
      db.insertSchedulerJob({
        id: "job_pending_1",
        profileName: "default",
        lane: "followup_preparation",
        actionType: "network.followup_after_accept",
        targetJson: JSON.stringify({
          profile_name: "default",
          profile_url_key: "https://www.linkedin.com/in/alice-smith/"
        }),
        dedupeKey: "followup_preparation:default:alice-smith",
        scheduledAtMs: Date.parse("2026-03-09T09:00:00.000Z"),
        maxAttempts: 5,
        createdAtMs: Date.parse("2026-03-09T08:00:00.000Z"),
        updatedAtMs: Date.parse("2026-03-09T08:00:00.000Z")
      });
      db.insertSchedulerJob({
        id: "job_prepared_1",
        profileName: "default",
        lane: "followup_preparation",
        actionType: "network.followup_after_accept",
        targetJson: JSON.stringify({
          profile_name: "default",
          profile_url_key: "https://www.linkedin.com/in/bob-jones/"
        }),
        dedupeKey: "followup_preparation:default:bob-jones",
        scheduledAtMs: Date.parse("2026-03-09T07:30:00.000Z"),
        status: "prepared",
        attemptCount: 1,
        maxAttempts: 5,
        preparedActionId: "pa_123",
        createdAtMs: Date.parse("2026-03-09T07:00:00.000Z"),
        updatedAtMs: Date.parse("2026-03-09T08:10:00.000Z")
      });
      db.insertSchedulerJob({
        id: "job_failed_1",
        profileName: "default",
        lane: "followup_preparation",
        actionType: "network.followup_after_accept",
        targetJson: JSON.stringify({
          profile_name: "default",
          profile_url_key: "https://www.linkedin.com/in/charlie-lee/"
        }),
        dedupeKey: "followup_preparation:default:charlie-lee",
        scheduledAtMs: Date.parse("2026-03-09T07:00:00.000Z"),
        status: "failed",
        attemptCount: 2,
        maxAttempts: 5,
        lastErrorCode: "NETWORK_ERROR",
        lastErrorMessage: "Temporary network issue.",
        createdAtMs: Date.parse("2026-03-09T06:00:00.000Z"),
        updatedAtMs: Date.parse("2026-03-09T08:15:00.000Z")
      });
    } finally {
      db.close();
    }
  }

  it("prints a human-readable scheduler status summary by default on TTYs", async () => {
    await seedSchedulerState();
    await seedSchedulerJobs();

    await runCli(["node", "linkedin", "scheduler", "status", "--jobs", "2"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Scheduler Status:");
    expect(output).toContain("Queue");
    expect(output).toContain("Next Jobs");
    expect(output).toContain("Recent History");
    expect(output).toContain("followup_preparation");
    expect(output).toContain("Use `--json`");
  });

  it("returns structured status JSON even when scheduler config is invalid", async () => {
    setInteractiveMode(false, false);
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE = "Mars/Olympus";
    await seedSchedulerJobs();

    await runCli(["node", "linkedin", "scheduler", "status", "--json"]);

    const payload = JSON.parse(
      String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "{}")
    ) as Record<string, unknown>;

    expect(payload.profile_name).toBe("default");
    expect(payload.scheduler_config).toBeUndefined();
    expect(payload.scheduler_config_error).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      message: expect.stringMatching(/valid IANA timezone/i)
    });
    expect(payload.job_counts).toMatchObject({
      total: 3,
      prepared: 1,
      failed: 1
    });
    expect(Array.isArray(payload.recent_jobs)).toBe(true);
  });

  it("formats scheduler config failures in human mode", async () => {
    process.env.LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE = "Mars/Olympus";

    await runCli(["node", "linkedin", "scheduler", "run-once"]);

    const stderrOutput = stderrChunks.join("");

    expect(process.exitCode).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(stderrOutput).toContain(
      "Scheduler command failed [ACTION_PRECONDITION_FAILED]"
    );
    expect(stderrOutput).toContain(
      "Setting: LINKEDIN_ASSISTANT_SCHEDULER_TIMEZONE"
    );
    expect(stderrOutput).toContain("Tip: run `linkedin scheduler --help`");
  });

  it("prints a human-readable start summary and progress notice", async () => {
    await runCli(["node", "linkedin", "scheduler", "start"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Scheduler Start: STARTED");
    expect(output).toContain("Event log:");
    expect(output).toContain("Prepared follow-up actions still require manual confirmation.");
    expect(stderrChunks.join("")).toContain(
      "[linkedin] Starting scheduler daemon for profile default."
    );
    expect(schedulerCliMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("supports the tick alias and surfaces failed job summaries", async () => {
    schedulerCliMocks.schedulerRunTick.mockResolvedValue(
      createTickResult({
        discoveredAcceptedConnections: 1,
        queuedJobs: 1,
        claimedJobs: 1,
        failedJobs: 1,
        processedJobs: [
          {
            jobId: "job_failed_1",
            lane: "followup_preparation",
            outcome: "failed",
            errorCode: "NETWORK_ERROR",
            errorMessage: "Temporary network issue."
          }
        ]
      })
    );

    await runCli(["node", "linkedin", "scheduler", "tick"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Scheduler Tick: COMPLETED");
    expect(output).toContain("Processed Jobs");
    expect(output).toContain("NETWORK_ERROR");
    expect(process.exitCode).toBe(1);
    expect(schedulerCliMocks.createCoreRuntime).toHaveBeenCalledTimes(1);
    expect(schedulerCliMocks.close).toHaveBeenCalledTimes(1);
  });

  it("documents human and JSON scheduler usage in help output", () => {
    const program = createCliProgram();
    const schedulerCommand = program.commands.find(
      (command) => command.name() === "scheduler"
    );
    const startCommand = schedulerCommand?.commands.find(
      (command) => command.name() === "start"
    );
    const statusCommand = schedulerCommand?.commands.find(
      (command) => command.name() === "status"
    );
    const stopCommand = schedulerCommand?.commands.find(
      (command) => command.name() === "stop"
    );
    const runOnceCommand = schedulerCommand?.commands.find(
      (command) => command.name() === "run-once"
    );

    expect(schedulerCommand?.description()).toContain(
      "The scheduler only prepares follow-ups near their due time"
    );
    expect(schedulerCommand?.description()).toContain(
      "prepared actions still require manual confirmation"
    );
    expect(startCommand?.helpInformation() ?? "").toContain(
      "current poll interval"
    );
    expect(statusCommand?.helpInformation() ?? "").toContain("--json");
    expect(statusCommand?.helpInformation() ?? "").toContain("--jobs");
    expect(stopCommand?.helpInformation() ?? "").toMatch(
      /without deleting queued\s+jobs/
    );
    expect(runOnceCommand?.helpInformation() ?? "").toContain(
      "refresh queue state"
    );
  });
});
