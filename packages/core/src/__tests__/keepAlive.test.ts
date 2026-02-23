import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import {
  SessionKeepAliveService,
  type KeepAliveEvent
} from "../keepAlive.js";
import { CDPConnectionPool } from "../connectionPool.js";
import type { FullHealthStatus } from "../healthCheck.js";

vi.mock("../healthCheck.js", () => ({
  checkFullHealth: vi.fn()
}));

vi.mock("../humanize.js", () => ({
  humanize: vi.fn(() => ({
    scrollDown: vi.fn(async () => undefined),
    idle: vi.fn(async () => undefined)
  }))
}));

import { checkFullHealth } from "../healthCheck.js";

const mockedCheckFullHealth = vi.mocked(checkFullHealth);

interface MockPoolBundle {
  pool: CDPConnectionPool;
  acquire: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPoolBundle {
  const mockPage = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => "https://www.linkedin.com/feed/")
  } as unknown as Page;
  const mockContext = {
    pages: vi.fn(() => [mockPage])
  } as unknown as BrowserContext;
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ context: mockContext, release }));
  const dispose = vi.fn(async () => undefined);

  return {
    pool: {
      acquire,
      dispose
    } as unknown as CDPConnectionPool,
    acquire,
    dispose,
    release
  };
}

function createHealthStatus(overrides?: {
  browser?: Partial<FullHealthStatus["browser"]>;
  session?: Partial<FullHealthStatus["session"]>;
}): FullHealthStatus {
  const base: FullHealthStatus = {
    browser: {
      healthy: true,
      browserConnected: true,
      pageResponsive: true,
      checkedAt: "2026-02-22T00:00:00.000Z"
    },
    session: {
      authenticated: true,
      currentUrl: "https://www.linkedin.com/feed/",
      reason: "LinkedIn session appears authenticated.",
      checkedAt: "2026-02-22T00:00:00.000Z"
    }
  };

  return {
    browser: {
      ...base.browser,
      ...(overrides?.browser ?? {})
    },
    session: {
      ...base.session,
      ...(overrides?.session ?? {})
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionKeepAliveService", () => {
  it("start/stop lifecycle", () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000
    });

    expect(service.isRunning()).toBe(false);

    service.start();
    expect(service.isRunning()).toBe(true);

    service.stop();
    expect(service.isRunning()).toBe(false);
  });

  it("emits healthy on good health check", async () => {
    const { pool, acquire, release } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const healthyStatus = createHealthStatus();
    const onHealthy = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(healthyStatus);
    service.on("healthy", onHealthy);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(mockedCheckFullHealth).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onHealthy).toHaveBeenCalledTimes(1);
    expect(onHealthy).toHaveBeenCalledWith(healthyStatus);
  });

  it("emits session-expired on auth failure", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "Login form is visible."
      }
    });
    const onSessionExpired = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(expiredStatus);
    service.on("session-expired", onSessionExpired);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledWith(expiredStatus);
  });

  it("emits browser-disconnected when browser not connected", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const disconnectedStatus = createHealthStatus({
      browser: {
        healthy: false,
        browserConnected: false,
        pageResponsive: false
      },
      session: {
        authenticated: false,
        reason: "Session health check failed."
      }
    });
    const onBrowserDisconnected = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(disconnectedStatus);
    service.on("browser-disconnected", onBrowserDisconnected);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(onBrowserDisconnected).toHaveBeenCalledTimes(1);
    expect(onBrowserDisconnected).toHaveBeenCalledWith(disconnectedStatus);
  });

  it("emits structured health-event with correct fields", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const healthyStatus = createHealthStatus();
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(healthyStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(onHealthEvent).toHaveBeenCalledTimes(1);
    const event: KeepAliveEvent = onHealthEvent.mock.calls[0]![0] as KeepAliveEvent;
    expect(event.type).toBe("healthy");
    expect(event.timestamp).toBeDefined();
    expect(event.consecutiveFailures).toBe(0);
    expect(event.health).toEqual(healthyStatus);
  });

  it("tracks consecutive failures and emits dead after threshold", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      maxConsecutiveFailures: 3
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "Login form is visible."
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(expiredStatus);
    service.on("health-event", onHealthEvent);

    service.start();

    // Tick 1
    await vi.advanceTimersByTimeAsync(1_000);
    // Tick 2
    await vi.advanceTimersByTimeAsync(1_000);
    // Tick 3 — should trigger dead
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(service.getConsecutiveFailures()).toBe(3);
    const deadEvents = onHealthEvent.mock.calls
      .map((c) => c[0] as KeepAliveEvent)
      .filter((e) => e.type === "dead");
    expect(deadEvents.length).toBe(1);
    expect(deadEvents[0]!.detail).toContain("3 consecutive failures");
  });

  it("resets consecutive failures on success", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      maxConsecutiveFailures: 5
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "Login form is visible."
      }
    });
    const healthyStatus = createHealthStatus();

    // Fail twice, then succeed
    mockedCheckFullHealth
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValue(healthyStatus);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getConsecutiveFailures()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getConsecutiveFailures()).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getConsecutiveFailures()).toBe(0);
    service.stop();
  });

  it("emits reconnect-attempt on browser disconnect", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const disconnectedStatus = createHealthStatus({
      browser: {
        healthy: false,
        browserConnected: false,
        pageResponsive: false
      },
      session: {
        authenticated: false,
        reason: "Session health check failed."
      }
    });
    const healthyStatus = createHealthStatus();
    const onHealthEvent = vi.fn();

    // First call: disconnected. Second call (reconnect attempt): healthy.
    mockedCheckFullHealth
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValue(healthyStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const eventTypes = onHealthEvent.mock.calls.map(
      (c) => (c[0] as KeepAliveEvent).type
    );
    expect(eventTypes).toContain("browser-disconnected");
    expect(eventTypes).toContain("reconnect-attempt");
    expect(eventTypes).toContain("reconnect-success");
  });

  it("emits reconnect-failed when reconnect fails", async () => {
    const mockContext = {} as BrowserContext;
    const release = vi.fn();
    const acquire = vi.fn();
    const dispose = vi.fn(async () => undefined);

    const disconnectedStatus = createHealthStatus({
      browser: {
        healthy: false,
        browserConnected: false,
        pageResponsive: false
      },
      session: {
        authenticated: false,
        reason: "Session health check failed."
      }
    });

    // First acquire succeeds (for health check), second acquire fails (reconnect)
    acquire
      .mockResolvedValueOnce({ context: mockContext, release })
      .mockRejectedValueOnce(new Error("Connection refused"));

    const pool = { acquire, dispose } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(disconnectedStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const eventTypes = onHealthEvent.mock.calls.map(
      (c) => (c[0] as KeepAliveEvent).type
    );
    expect(eventTypes).toContain("reconnect-failed");
  });

  it("uses setTimeout chaining (not setInterval) for jitter", () => {
    const { pool } = createMockPool();
    const healthyStatus = createHealthStatus();
    mockedCheckFullHealth.mockResolvedValue(healthyStatus);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const callsBefore = setIntervalSpy.mock.calls.length;

    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 5_000,
      jitterMs: 1_000
    });

    service.start();

    // Should use setTimeout, not setInterval
    expect(setTimeoutSpy).toHaveBeenCalled();
    // setInterval should NOT have been called by our service
    expect(setIntervalSpy.mock.calls.length).toBe(callsBefore);

    service.stop();

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("dead event is emitted only once even with continued failures", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      maxConsecutiveFailures: 2
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "Login form is visible."
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(expiredStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    // 4 ticks — dead should trigger at 2, not again at 3 or 4
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const deadEvents = onHealthEvent.mock.calls
      .map((c) => c[0] as KeepAliveEvent)
      .filter((e) => e.type === "dead");
    expect(deadEvents.length).toBe(1);
  });

  it("double start is a no-op", () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });

    service.start();
    service.start(); // should not throw or create duplicate timers
    expect(service.isRunning()).toBe(true);
    service.stop();
  });
});
