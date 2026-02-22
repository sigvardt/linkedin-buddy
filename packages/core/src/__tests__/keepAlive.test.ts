import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { SessionKeepAliveService } from "../keepAlive.js";
import { CDPConnectionPool } from "../connectionPool.js";
import type { FullHealthStatus } from "../healthCheck.js";

vi.mock("../healthCheck.js", () => ({
  checkFullHealth: vi.fn()
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
  const mockContext = {} as BrowserContext;
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
      intervalMs: 1_000
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
      intervalMs: 1_000
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
      intervalMs: 1_000
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
});
