import { describe, expect, it } from "vitest";
import {
  getDefaultProfileName,
  getLastJsonObject,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe.sequential("Scheduler E2E - CLI surface", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const defaultProfileName = getDefaultProfileName();
  const idleProfileName = `e2e-scheduler-idle-${Date.now()}`;

  it("scheduler status returns structured output when no daemon is running", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "scheduler",
      "status",
      "--profile",
      idleProfileName,
      "--json"
    ]);
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      profile_name: idleProfileName,
      running: false
    });
    expect(payload).toHaveProperty("job_counts");
    expect(Array.isArray(payload.next_jobs)).toBe(true);
    expect(Array.isArray(payload.recent_jobs)).toBe(true);
  }, 60_000);

  it("scheduler run-once executes a tick and returns structured result", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "scheduler",
      "run-once",
      "--profile",
      defaultProfileName,
      "--json"
    ]);
    expect(result.error).toBeUndefined();
    expect([0, 1]).toContain(result.exitCode);

    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      run_id: expect.any(String),
      profileName: defaultProfileName,
      workerId: expect.any(String),
      windowOpen: expect.any(Boolean),
      skippedReason: expect.anything(),
      preparedJobs: expect.any(Number),
      failedJobs: expect.any(Number)
    });
    expect(Array.isArray(payload.processedJobs)).toBe(true);
  }, 120_000);

  it("scheduler status with --jobs returns queue and recent job lists", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "scheduler",
      "status",
      "--profile",
      defaultProfileName,
      "--jobs",
      "10",
      "--json"
    ]);
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(Array.isArray(payload.next_jobs)).toBe(true);
    expect(Array.isArray(payload.recent_jobs)).toBe(true);
  }, 60_000);

  it("scheduler status returns validation error for invalid --jobs value", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "scheduler",
      "status",
      "--profile",
      defaultProfileName,
      "--jobs",
      "0",
      "--json"
    ]);

    expect(result.exitCode).toBe(1);
    const payload = getLastJsonObject(result.stderr);
    expect(payload).toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
      message: "jobs must be a positive integer."
    });
  }, 60_000);
});

describe.sequential("Scheduler E2E - daemon lifecycle", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = `e2e-scheduler-${Date.now()}`;

  it("start spawns daemon, status confirms running, and stop shuts it down", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    let daemonStarted = false;
    let daemonStopped = false;

    try {
      const start = await runCliCommand([
        "scheduler",
        "start",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(start.error).toBeUndefined();
      expect(start.exitCode).toBe(0);
      const startPayload = getLastJsonObject(start.stdout);
      expect(startPayload).toMatchObject({
        started: true,
        profile_name: profileName,
        pid: expect.any(Number)
      });
      daemonStarted = true;

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      });

      const status = await runCliCommand([
        "scheduler",
        "status",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(status.error).toBeUndefined();
      expect(status.exitCode).toBe(0);
      const statusPayload = getLastJsonObject(status.stdout);
      expect(statusPayload).toMatchObject({
        profile_name: profileName,
        running: true
      });

      const stop = await runCliCommand([
        "scheduler",
        "stop",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(stop.error).toBeUndefined();
      expect(stop.exitCode).toBe(0);
      const stopPayload = getLastJsonObject(stop.stdout);
      expect(stopPayload).toMatchObject({
        stopped: true,
        profile_name: profileName
      });
      daemonStopped = true;

      const statusAfterStop = await runCliCommand([
        "scheduler",
        "status",
        "--profile",
        profileName,
        "--json"
      ]);
      expect(statusAfterStop.error).toBeUndefined();
      expect(statusAfterStop.exitCode).toBe(0);
      const statusAfterStopPayload = getLastJsonObject(statusAfterStop.stdout);
      expect(statusAfterStopPayload).toMatchObject({
        profile_name: profileName,
        running: false
      });
    } finally {
      if (daemonStarted && !daemonStopped) {
        await runCliCommand([
          "scheduler",
          "stop",
          "--profile",
          profileName,
          "--json"
        ]);
      }
    }
  }, 30_000);
});
