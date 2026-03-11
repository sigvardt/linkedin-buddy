import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keepAliveCliMocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    pid: 12_345,
    unref: vi.fn()
  }))
}));

vi.mock("@linkedin-buddy/core", async () => await import("../../core/src/index.js"));

vi.mock("node:child_process", () => ({
  spawn: keepAliveCliMocks.spawn
}));

import { resolveConfigPaths } from "@linkedin-buddy/core";
import { createCliProgram, runCli } from "../src/bin/linkedin.js";

interface KeepAliveStateFile {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "degraded" | "stopped";
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastCheckStartedAt?: string;
  lastHealthyAt?: string;
  authenticated?: boolean;
  browserHealthy?: boolean;
  currentUrl?: string;
  reason?: string;
  lastError?: string;
  cdpUrl?: string;
  healthCheckInProgress?: boolean;
  stoppedAt?: string;
}

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

function keepAliveDir(): string {
  return path.join(resolveConfigPaths().baseDir, "keepalive");
}

async function seedKeepAliveState(
  profileName: string,
  state: KeepAliveStateFile
): Promise<void> {
  const dir = keepAliveDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${profileName}.state.json`),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

async function seedKeepAlivePid(profileName: string, pid: number): Promise<void> {
  const dir = keepAliveDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${profileName}.pid`), `${pid}\n`, "utf8");
}

async function seedKeepAliveEvents(
  profileName: string,
  events: Array<Record<string, unknown>>
): Promise<void> {
  const dir = keepAliveDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${profileName}.events.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
}

describe("linkedin keepalive CLI UX", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-keepalive-"));
    process.env.LINKEDIN_BUDDY_HOME = path.join(tempDir, "buddy-home");
    process.exitCode = undefined;
    stdoutChunks = [];
    stderrChunks = [];
    setInteractiveMode(true, true);
    vi.clearAllMocks();
    keepAliveCliMocks.spawn.mockImplementation(() => ({
      pid: 12_345,
      unref: vi.fn()
    }));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
        const [chunk] = args;
        stdoutChunks.push(String(chunk));
        return true;
      });
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
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prints a human-readable keepalive status summary by default on TTYs", async () => {
    await seedKeepAlivePid("default", process.pid);
    await seedKeepAliveState("default", {
      pid: process.pid,
      profileName: "default",
      startedAt: "2026-03-09T08:00:00.000Z",
      updatedAt: "2026-03-09T08:05:00.000Z",
      status: "running",
      intervalMs: 300_000,
      jitterMs: 30_000,
      maxConsecutiveFailures: 5,
      consecutiveFailures: 0,
      lastTickAt: "2026-03-09T08:05:00.000Z",
      lastHealthyAt: "2026-03-09T08:05:00.000Z",
      authenticated: true,
      browserHealthy: true,
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "LinkedIn session appears authenticated.",
      healthCheckInProgress: false
    });
    await seedKeepAliveEvents("default", [
      {
        ts: "2026-03-09T08:05:00.000Z",
        event: "keepalive.tick.started",
        profile_name: "default"
      },
      {
        ts: "2026-03-09T08:05:01.000Z",
        event: "keepalive.tick",
        profile_name: "default",
        healthy: true,
        reason: "LinkedIn session appears authenticated."
      }
    ]);

    await runCli(["node", "linkedin", "keepalive", "status"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Keepalive Status:");
    expect(output).toContain("Browser health: healthy");
    expect(output).toContain("Session health: authenticated");
    expect(output).toContain("State file:");
    expect(output).toContain("Next Steps");
    expect(output).not.toContain("Recent Events");
  });

  it("shows recent events and extra diagnostics in verbose human mode", async () => {
    await seedKeepAlivePid("default", process.pid);
    await seedKeepAliveState("default", {
      pid: process.pid,
      profileName: "default",
      startedAt: "2026-03-09T08:00:00.000Z",
      updatedAt: "2026-03-09T08:05:00.000Z",
      status: "degraded",
      intervalMs: 300_000,
      jitterMs: 30_000,
      maxConsecutiveFailures: 5,
      consecutiveFailures: 3,
      lastTickAt: "2026-03-09T08:05:00.000Z",
      lastCheckStartedAt: "2026-03-09T08:05:00.000Z",
      authenticated: false,
      browserHealthy: true,
      currentUrl: "https://www.linkedin.com/checkpoint/challenge/",
      reason: "LinkedIn checkpoint detected. Manual verification is required.",
      lastError: "Checkpoint still active.",
      cdpUrl: "http://127.0.0.1:18800",
      healthCheckInProgress: true
    });
    await seedKeepAliveEvents("default", [
      {
        ts: "2026-03-09T08:05:00.000Z",
        event: "keepalive.tick.started",
        profile_name: "default"
      },
      {
        ts: "2026-03-09T08:05:02.000Z",
        event: "keepalive.tick.error",
        profile_name: "default",
        error: "Checkpoint still active."
      }
    ]);

    await runCli(["node", "linkedin", "keepalive", "status", "--verbose"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Keepalive Status: DEGRADED");
    expect(output).toContain("Recent Events");
    expect(output).toContain("Health check started");
    expect(output).toContain("External CDP session:");
    expect(output).toContain("Action Needed");
  });

  it("prints a human-readable start summary and progress notices", async () => {
    await runCli(["node", "linkedin", "keepalive", "start"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");
    const state = JSON.parse(
      await readFile(path.join(keepAliveDir(), "default.state.json"), "utf8")
    ) as KeepAliveStateFile;

    expect(output).toContain("Keepalive Start: STARTED");
    expect(output).toContain("Event log:");
    expect(output).toContain("linkedin keepalive status --profile default");
    expect(stderrChunks.join("")).toContain(
      "[linkedin] Starting keepalive daemon for profile default."
    );
    expect(stderrChunks.join("")).toContain(
      "first session health check will continue in the background"
    );
    expect(state.status).toBe("starting");
    expect(state.healthCheckInProgress).toBe(false);
    expect(keepAliveCliMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("supports quiet mode for concise keepalive output", async () => {
    await runCli(["node", "linkedin", "keepalive", "start", "--quiet"]);

    const output = String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "");

    expect(output).toContain("Keepalive Start: STARTED");
    expect(stderrChunks).toEqual([]);
  });

  it("formats keepalive input errors with actionable guidance in human mode", async () => {
    await runCli(["node", "linkedin", "keepalive", "status", "--profile", "../bad"]);

    expect(process.exitCode).toBe(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain(
      "Keepalive command failed [ACTION_PRECONDITION_FAILED]"
    );
    expect(stderrChunks.join("")).toContain(
      "Use a simple profile name such as `default` or `sales`, not a filesystem path."
    );
    expect(stderrChunks.join("")).toContain("linkedin keepalive --help");
  });

  it("rejects combining quiet and verbose keepalive flags", async () => {
    await runCli([
      "node",
      "linkedin",
      "keepalive",
      "status",
      "--quiet",
      "--verbose"
    ]);

    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain(
      'Choose either "--quiet" or "--verbose", not both.'
    );
  });

  it("defaults to JSON keepalive output outside TTYs", async () => {
    setInteractiveMode(false, false);
    await seedKeepAlivePid("default", process.pid);
    await seedKeepAliveState("default", {
      pid: process.pid,
      profileName: "default",
      startedAt: "2026-03-09T08:00:00.000Z",
      updatedAt: "2026-03-09T08:05:00.000Z",
      status: "running",
      intervalMs: 300_000,
      jitterMs: 30_000,
      maxConsecutiveFailures: 5,
      consecutiveFailures: 0,
      authenticated: true,
      browserHealthy: true,
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "LinkedIn session appears authenticated.",
      healthCheckInProgress: false
    });
    await seedKeepAliveEvents("default", [
      {
        ts: "2026-03-09T08:05:01.000Z",
        event: "keepalive.tick",
        profile_name: "default",
        healthy: true
      }
    ]);

    await runCli(["node", "linkedin", "keepalive", "status"]);

    const payload = JSON.parse(
      String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? "{}")
    ) as Record<string, unknown>;

    expect(payload.profile_name).toBe("default");
    expect(payload.state).toMatchObject({
      status: "running",
      authenticated: true,
      browserHealthy: true
    });
    expect(payload.recent_events).toEqual([
      expect.objectContaining({
        event: "keepalive.tick"
      })
    ]);
  });

  it("documents keepalive human and JSON usage in help output", () => {
    const program = createCliProgram();
    const keepAliveCommand = program.commands.find(
      (command) => command.name() === "keepalive"
    );
    const startCommand = keepAliveCommand?.commands.find(
      (command) => command.name() === "start"
    );
    const statusCommand = keepAliveCommand?.commands.find(
      (command) => command.name() === "status"
    );
    const stopCommand = keepAliveCommand?.commands.find(
      (command) => command.name() === "stop"
    );

    expect(keepAliveCommand?.description()).toContain(
      "records background LinkedIn health checks to disk"
    );
    expect(startCommand?.description() ?? "").toContain(
      "background session health checks"
    );

    startCommand?.outputHelp();
    const startHelpOutput = stdoutChunks.join("");
    expect(startHelpOutput).toContain("--json");
    expect(startHelpOutput).toContain("--verbose");
    expect(startHelpOutput).toContain("stale PID file");

    stdoutChunks = [];
    statusCommand?.outputHelp();
    const statusHelpOutput = stdoutChunks.join("");
    expect(statusHelpOutput).toContain("--quiet");
    expect(statusHelpOutput).toContain("Action Needed guidance");

    stdoutChunks = [];
    stopCommand?.outputHelp();
    const stopHelpOutput = stdoutChunks.join("");
    expect(stopHelpOutput).toContain("force-kills it");
  });
});
