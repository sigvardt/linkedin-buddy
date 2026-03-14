import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHealthCheckResult } from "../auth/sessionHealthCheck.js";
import { LinkedInBuddyError } from "../errors.js";
import {
  createSessionGuard,
  type SessionGuardDeps,
  type SessionGuardLogger
} from "../sessionGuard.js";

function createHealthyResult(): SessionHealthCheckResult {
  return {
    healthy: true,
    sessionName: "default",
    checkedAt: new Date().toISOString(),
    reason: "Stored li_at cookie is present and not expired.",
    sessionExists: true,
    hasAuthCookie: true,
    authCookieExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    authCookieExpiresInMs: 86400000,
    hasBrowserFingerprint: true,
    cookieCount: 5,
    guidance: "LinkedIn session is valid and ready to use."
  };
}

function createUnhealthyResult(): SessionHealthCheckResult {
  return {
    healthy: false,
    sessionName: "default",
    checkedAt: new Date().toISOString(),
    reason: "Stored li_at cookie is expired.",
    sessionExists: true,
    hasAuthCookie: true,
    authCookieExpiresAt: new Date(Date.now() - 3600000).toISOString(),
    authCookieExpiresInMs: -3600000,
    hasBrowserFingerprint: true,
    cookieCount: 5,
    guidance:
      'LinkedIn session has expired. Run "linkedin login --manual" to re-authenticate.'
  };
}

function createGuardDeps(
  healthResult: SessionHealthCheckResult = createHealthyResult()
): {
  checkHealth: ReturnType<
    typeof vi.fn<
      (sessionName?: string, baseDir?: string) => Promise<SessionHealthCheckResult>
    >
  >;
  deps: SessionGuardDeps;
  logger: SessionGuardLogger & {
    log: ReturnType<
      typeof vi.fn<
        (
          level: string,
          event: string,
          payload?: Record<string, unknown>
        ) => unknown
      >
    >;
  };
  sampleInterval: ReturnType<
    typeof vi.fn<
      (meanMs: number, options?: { minIntervalMs?: number; maxIntervalMs?: number }) => number
    >
  >;
  sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
} {
  const logger: SessionGuardLogger & {
    log: ReturnType<
      typeof vi.fn<
        (
          level: string,
          event: string,
          payload?: Record<string, unknown>
        ) => unknown
      >
    >;
  } = {
    log: vi.fn<
      (level: string, event: string, payload?: Record<string, unknown>) => unknown
    >()
  };
  const checkHealth = vi.fn<
    (sessionName?: string, baseDir?: string) => Promise<SessionHealthCheckResult>
  >(async () => healthResult);
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
  const sampleInterval = vi.fn<
    (meanMs: number, options?: { minIntervalMs?: number; maxIntervalMs?: number }) => number
  >(() => 500);

  const deps: SessionGuardDeps = { logger, checkHealth, sampleInterval, sleep };

  return { checkHealth, deps, logger, sampleInterval, sleep };
}

describe("createSessionGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("health check", () => {
    it("calls checkHealth on first invocation", async () => {
      const { checkHealth, deps } = createGuardDeps();
      const guard = createSessionGuard(deps);

      await guard({ actionId: "a1", actionType: "inbox.send-message" });

      expect(checkHealth).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledWith("default", undefined);
    });

    it("caches health result within TTL", async () => {
      const { checkHealth, deps } = createGuardDeps();
      const guard = createSessionGuard(deps, { healthCacheTtlMs: 10_000 });

      await guard({ actionId: "a1", actionType: "feed.like" });
      vi.advanceTimersByTime(5_000);
      await guard({ actionId: "a2", actionType: "feed.like" });

      expect(checkHealth).toHaveBeenCalledTimes(1);
    });

    it("re-checks after TTL expires", async () => {
      const { checkHealth, deps } = createGuardDeps();
      const guard = createSessionGuard(deps, { healthCacheTtlMs: 1_000 });

      await guard({ actionId: "a1", actionType: "connections.follow" });
      vi.advanceTimersByTime(1_001);
      await guard({ actionId: "a2", actionType: "connections.follow" });

      expect(checkHealth).toHaveBeenCalledTimes(2);
    });

    it("throws AUTH_REQUIRED when session is unhealthy", async () => {
      const { deps } = createGuardDeps(createUnhealthyResult());
      const guard = createSessionGuard(deps);

      const result = guard({ actionId: "a1", actionType: "inbox.send-message" });
      await expect(result).rejects.toBeInstanceOf(LinkedInBuddyError);
      await expect(result).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    });

    it("passes silently when session is healthy", async () => {
      const { deps } = createGuardDeps();
      const guard = createSessionGuard(deps);

      await expect(
        guard({ actionId: "a1", actionType: "jobs.save" })
      ).resolves.toBeUndefined();
    });

    it("logs warning and allows operation when checkHealth throws", async () => {
      const { logger, sampleInterval, sleep } = createGuardDeps();
      const checkHealth = vi.fn<
        (sessionName?: string, baseDir?: string) => Promise<SessionHealthCheckResult>
      >(async () => {
        throw new Error("health check failed");
      });
      const deps: SessionGuardDeps = { logger, checkHealth, sampleInterval, sleep };
      const guard = createSessionGuard(deps);

      await expect(
        guard({ actionId: "a1", actionType: "posts.create" })
      ).resolves.toBeUndefined();

      expect(logger.log).toHaveBeenCalledWith(
        "warn",
        "session_guard.health_check.io_error",
        expect.objectContaining({
          action_id: "a1",
          action_type: "posts.create",
          error: "health check failed"
        })
      );
    });

    it("checks health every time when healthCacheTtlMs is 0", async () => {
      const { checkHealth, deps } = createGuardDeps();
      const guard = createSessionGuard(deps, { healthCacheTtlMs: 0 });

      await guard({ actionId: "a1", actionType: "groups.join" });
      await guard({ actionId: "a2", actionType: "groups.join" });

      expect(checkHealth).toHaveBeenCalledTimes(2);
    });
  });

  describe("operation pacing", () => {
    it("does not delay the first operation", async () => {
      const { deps, sampleInterval, sleep } = createGuardDeps();
      const guard = createSessionGuard(deps);

      await guard({ actionId: "a1", actionType: "feed.comment" });

      expect(sampleInterval).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it("applies pacing to subsequent operations", async () => {
      const { deps, sampleInterval, sleep } = createGuardDeps();
      sampleInterval.mockReturnValue(800);

      const guard = createSessionGuard(deps, {
        pacingMeanMs: 800,
        pacingMinMs: 100,
        pacingMaxMs: 2_000
      });

      await guard({ actionId: "a1", actionType: "connections.accept" });
      vi.advanceTimersByTime(50);
      await guard({ actionId: "a2", actionType: "connections.accept" });

      expect(sampleInterval).toHaveBeenCalledTimes(1);
      expect(sampleInterval).toHaveBeenCalledWith(800, {
        minIntervalMs: 100,
        maxIntervalMs: 2_000
      });
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it("disables pacing when pacingMeanMs is 0", async () => {
      const { deps, sampleInterval, sleep } = createGuardDeps();
      const guard = createSessionGuard(deps, { pacingMeanMs: 0 });

      await guard({ actionId: "a1", actionType: "profile.update-intro" });
      vi.advanceTimersByTime(25);
      await guard({ actionId: "a2", actionType: "profile.update-intro" });

      expect(sampleInterval).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it("sleeps for remaining delay when elapsed is below target", async () => {
      const { deps, sampleInterval, sleep } = createGuardDeps();
      sampleInterval.mockReturnValue(1_000);
      const guard = createSessionGuard(deps, { pacingMeanMs: 1_000 });

      await guard({ actionId: "a1", actionType: "inbox.react" });
      vi.advanceTimersByTime(250);
      await guard({ actionId: "a2", actionType: "inbox.react" });

      expect(sleep).toHaveBeenCalledWith(750);
    });

    it("does not sleep when elapsed exceeds target delay", async () => {
      const { deps, sampleInterval, sleep } = createGuardDeps();
      sampleInterval.mockReturnValue(300);
      const guard = createSessionGuard(deps, { pacingMeanMs: 300 });

      await guard({ actionId: "a1", actionType: "jobs.unsave" });
      vi.advanceTimersByTime(500);
      await guard({ actionId: "a2", actionType: "jobs.unsave" });

      expect(sampleInterval).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe("frequency warning", () => {
    it("does not warn when operation count is below threshold", async () => {
      const { deps, logger } = createGuardDeps();
      const guard = createSessionGuard(deps, {
        pacingMeanMs: 0,
        frequencyWarningThreshold: 3,
        frequencyWindowMs: 1_000
      });

      await guard({ actionId: "a1", actionType: "feed.save" });
      await guard({ actionId: "a2", actionType: "feed.save" });

      expect(logger.log).not.toHaveBeenCalledWith(
        "warn",
        "session_guard.frequency.high",
        expect.anything()
      );
    });

    it("warns when threshold is reached within the window", async () => {
      const { deps, logger } = createGuardDeps();
      const guard = createSessionGuard(deps, {
        pacingMeanMs: 0,
        frequencyWarningThreshold: 3,
        frequencyWindowMs: 1_000
      });

      await guard({ actionId: "a1", actionType: "events.rsvp" });
      await guard({ actionId: "a2", actionType: "events.rsvp" });
      await guard({ actionId: "a3", actionType: "events.rsvp" });

      expect(logger.log).toHaveBeenCalledWith(
        "warn",
        "session_guard.frequency.high",
        expect.objectContaining({
          operations_in_window: 3,
          threshold: 3,
          window_ms: 1_000
        })
      );
    });

    it("evicts old operation timestamps outside the window", async () => {
      const { deps, logger } = createGuardDeps();
      const guard = createSessionGuard(deps, {
        pacingMeanMs: 0,
        frequencyWarningThreshold: 2,
        frequencyWindowMs: 100
      });

      await guard({ actionId: "a1", actionType: "connections.list" });
      vi.advanceTimersByTime(101);
      await guard({ actionId: "a2", actionType: "connections.list" });

      expect(logger.log).not.toHaveBeenCalledWith(
        "warn",
        "session_guard.frequency.high",
        expect.anything()
      );
    });
  });

  describe("enabled and defaults", () => {
    it("is a no-op when disabled", async () => {
      const { checkHealth, deps, logger, sampleInterval, sleep } = createGuardDeps();
      const guard = createSessionGuard(deps, { enabled: false });

      await guard({ actionId: "a1", actionType: "posts.delete" });
      await guard({ actionId: "a2", actionType: "posts.delete" });

      expect(checkHealth).not.toHaveBeenCalled();
      expect(sampleInterval).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
    });

    it("is active by default", async () => {
      const { checkHealth, deps } = createGuardDeps();
      const guard = createSessionGuard(deps);

      await guard({ actionId: "a1", actionType: "notifications.list" });

      expect(checkHealth).toHaveBeenCalledTimes(1);
    });
  });
});
