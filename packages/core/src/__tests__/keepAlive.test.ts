import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import {
  SessionKeepAliveService,
  type KeepAliveEvent
} from "../keepAlive.js";
import { CDPConnectionPool } from "../connectionPool.js";
import type { FullHealthStatus } from "../healthCheck.js";
import type {
  LinkedInBrowserStorageState,
  LinkedInSessionStore
} from "../auth/sessionStore.js";

vi.mock("../healthCheck.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../healthCheck.js")>();

  return {
    ...actual,
    checkFullHealth: vi.fn()
  };
});

const humanizeMocks = vi.hoisted(() => ({
  idle: vi.fn(async () => undefined),
  moveMouseNear: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  scrollDown: vi.fn(async () => undefined)
}));

vi.mock("../humanize.js", () => ({
  humanize: vi.fn(() => humanizeMocks)
}));

import { checkFullHealth } from "../healthCheck.js";

const mockedCheckFullHealth = vi.mocked(checkFullHealth);

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    reject,
    resolve
  };
}

function createMockPage(
  currentUrl = "https://www.linkedin.com/feed/"
): Page {
  return {
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => currentUrl)
  } as unknown as Page;
}

function getHealthEvents(onHealthEvent: ReturnType<typeof vi.fn>): KeepAliveEvent[] {
  return onHealthEvent.mock.calls.map((call) => call[0] as KeepAliveEvent);
}

function getEventTypes(onHealthEvent: ReturnType<typeof vi.fn>): KeepAliveEvent["type"][] {
  return getHealthEvents(onHealthEvent).map((event) => event.type);
}

function createStorageState(
  overrides?: Partial<LinkedInBrowserStorageState>
): LinkedInBrowserStorageState {
  return {
    cookies: [
      {
        domain: ".linkedin.com",
        expires: 1_900_000_000,
        httpOnly: true,
        name: "li_at",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "valid-cookie"
      }
    ],
    origins: [
      {
        localStorage: [
          {
            name: "li_theme",
            value: "dark"
          }
        ],
        origin: "https://www.linkedin.com"
      }
    ],
    ...(overrides ?? {})
  };
}

interface MockPoolBundle {
  addCookies: ReturnType<typeof vi.fn>;
  pool: CDPConnectionPool;
  acquire: ReturnType<typeof vi.fn>;
  cookies: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  mockContext: BrowserContext;
  mockPage: Page;
  release: ReturnType<typeof vi.fn>;
  storageState: ReturnType<typeof vi.fn>;
}

function createMockPool(options?: {
  cookieCalls?: LinkedInBrowserStorageState["cookies"][];
  storageStateCalls?: LinkedInBrowserStorageState[];
  storageState?: LinkedInBrowserStorageState;
}): MockPoolBundle {
  const storageStateValue = options?.storageState ?? createStorageState();
  const queuedCookieCalls = [
    ...(options?.cookieCalls ?? [storageStateValue.cookies])
  ];
  const queuedStorageStateCalls = [
    ...(options?.storageStateCalls ?? [storageStateValue])
  ];
  const mockPage = {
    close: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => "https://www.linkedin.com/feed/")
  } as unknown as Page;
  const cookies = vi.fn(async () => {
    if (queuedCookieCalls.length > 1) {
      return queuedCookieCalls.shift() ?? [];
    }

    return queuedCookieCalls[0] ?? [];
  });
  const storageState = vi.fn(async () => {
    if (queuedStorageStateCalls.length > 1) {
      return queuedStorageStateCalls.shift() ?? storageStateValue;
    }

    return queuedStorageStateCalls[0] ?? storageStateValue;
  });
  const addCookies = vi.fn(async () => undefined);
  const mockContext = {
    addCookies,
    cookies,
    newPage: vi.fn(async () => mockPage),
    pages: vi.fn(() => [mockPage]),
    storageState
  } as unknown as BrowserContext;
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ context: mockContext, release }));
  const dispose = vi.fn(async () => undefined);

  return {
    addCookies,
    pool: {
      acquire,
      dispose,
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool,
    acquire,
    cookies,
    dispose,
    mockContext,
    mockPage,
    release,
    storageState
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
      checkpointDetected: false,
      cookieExpiringSoon: false,
      currentUrl: "https://www.linkedin.com/feed/",
      loginWallDetected: false,
      nextCookieExpiryAt: null,
      rateLimited: false,
      reason: "LinkedIn session appears authenticated.",
      checkedAt: "2026-02-22T00:00:00.000Z",
      sessionCookieFingerprint: "healthy-session-fingerprint",
      sessionCookiePresent: true,
      sessionCookies: []
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
      jitterMs: 0,
      sessionRefreshEnabled: false
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
      jitterMs: 0,
      sessionRefreshEnabled: false
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
      jitterMs: 0,
      networkGracePeriodMs: 0
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
      maxConsecutiveFailures: 3,
      sessionRefreshEnabled: false
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
      maxConsecutiveFailures: 5,
      sessionRefreshEnabled: false
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
    const release = vi.fn();
    const acquire = vi.fn();
    const dispose = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);

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
      .mockResolvedValueOnce({
        context: {
          cookies: vi.fn(async () => createStorageState().cookies),
          newPage: vi.fn(async () => ({ goto: vi.fn(async () => undefined) })),
          pages: vi.fn(() => [
            {
              goto: vi.fn(async () => undefined),
              url: vi.fn(() => "https://www.linkedin.com/feed/")
            }
          ]),
          storageState: vi.fn(async () => createStorageState())
        } as unknown as BrowserContext,
        release
      })
      .mockRejectedValueOnce(new Error("Connection refused"));

    const pool = { acquire, dispose, invalidate } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      networkGracePeriodMs: 0
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
      maxConsecutiveFailures: 2,
      sessionRefreshEnabled: false
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

  it("proactively refreshes expiring cookies and persists the session snapshot", async () => {
    const nowMs = Date.parse("2026-03-09T10:00:00.000Z");
    vi.setSystemTime(nowMs);
    const expiringCookies = [
      {
        ...createStorageState().cookies[0]!,
        expires: Math.floor((nowMs + 5 * 60_000) / 1_000),
        value: "expiring-cookie"
      }
    ];
    const refreshedCookies = [
      {
        ...createStorageState().cookies[0]!,
        expires: Math.floor((nowMs + 3 * 60 * 60_000) / 1_000),
        value: "refreshed-cookie"
      }
    ];
    const refreshedStorageState = createStorageState({
      cookies: refreshedCookies
    });
    const { pool } = createMockPool({
      cookieCalls: [expiringCookies, refreshedCookies],
      storageStateCalls: [
        createStorageState({ cookies: expiringCookies }),
        refreshedStorageState
      ],
      storageState: refreshedStorageState
    });
    const sessionStore = {
      saveWithBackups: vi.fn(async () => undefined)
    } as unknown as LinkedInSessionStore;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      cookieRefreshLeadMs: 60 * 60_000,
      sessionName: "default",
      sessionStore
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(
        createHealthStatus({
          session: {
            cookieExpiringSoon: true,
            nextCookieExpiryAt: new Date(nowMs + 5 * 60_000).toISOString(),
            sessionCookieFingerprint: "expiring-session-fingerprint",
            sessionCookies: [
              {
                name: "li_at",
                domain: ".linkedin.com",
                path: "/",
                expiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
                expiresInMs: 5 * 60_000,
                httpOnly: true,
                secure: true,
                sameSite: "Lax"
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        createHealthStatus({
          session: {
            nextCookieExpiryAt: new Date(nowMs + 3 * 60 * 60_000).toISOString(),
            sessionCookieFingerprint: "refreshed-session-fingerprint",
            sessionCookies: [
              {
                name: "li_at",
                domain: ".linkedin.com",
                path: "/",
                expiresAt: new Date(nowMs + 3 * 60 * 60_000).toISOString(),
                expiresInMs: 3 * 60 * 60_000,
                httpOnly: true,
                secure: true,
                sameSite: "Lax"
              }
            ]
          }
        })
      );
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const eventTypes = onHealthEvent.mock.calls.map(
      (call) => (call[0] as KeepAliveEvent).type
    );
    expect(eventTypes).toContain("cookie-refresh");
    expect(eventTypes).toContain("session-persisted");
    expect(sessionStore.saveWithBackups).toHaveBeenCalled();
    expect(eventTypes).toContain("session-rotated");
  });

  it("rotates activity patterns instead of repeating one keepalive action", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(6_000);
    service.stop();

    const activityEvents = onHealthEvent.mock.calls
      .map((call) => call[0] as KeepAliveEvent)
      .filter((event) => event.type === "activity");

    expect(activityEvents).toHaveLength(2);
    expect(activityEvents[0]?.metadata?.pattern).toBe("feed-scroll");
    expect(activityEvents[1]?.metadata?.pattern).toBe("notifications-peek");
  });

  it("recovers from transient network interruptions inside the grace period", async () => {
    const { mockContext, release } = createMockPool();
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ context: mockContext, release });
    const pool = {
      acquire,
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      networkGracePeriodMs: 60_000
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const eventTypes = onHealthEvent.mock.calls.map(
      (call) => (call[0] as KeepAliveEvent).type
    );
    expect(eventTypes).toContain("network-interruption");
    expect(eventTypes).toContain("reconnect-attempt");
    expect(eventTypes).toContain("reconnect-success");
    expect(eventTypes).not.toContain("dead");
    expect(service.getConsecutiveFailures()).toBe(0);
  });

  it("emits login-required with health context when soft re-auth fails", async () => {
    const expiredCookies = [
      {
        ...createStorageState().cookies[0]!,
        expires: 1_600_000_000,
        value: "expired-cookie"
      }
    ];
    const { pool } = createMockPool({
      cookieCalls: [expiredCookies],
      storageState: createStorageState({ cookies: expiredCookies })
    });
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        loginWallDetected: true,
        nextCookieExpiryAt: "2020-09-13T12:26:40.000Z",
        reason: "LinkedIn login wall detected."
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(expiredStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const loginRequiredEvent = onHealthEvent.mock.calls
      .map((call) => call[0] as KeepAliveEvent)
      .find((event) => event.type === "manual-login-required");

    expect(loginRequiredEvent?.detail).toContain("Manual LinkedIn login");
    expect(loginRequiredEvent?.metadata?.currentUrl).toBe(
      "https://www.linkedin.com/feed/"
    );
    expect(loginRequiredEvent?.metadata?.nextCookieExpiryAt).toBe(
      "2020-09-13T12:26:40.000Z"
    );
  });

  it("restores a stored session fallback before requiring manual login", async () => {
    const { pool } = createMockPool();
    const sessionStore = {
      saveWithBackups: vi.fn(async () => undefined),
      restoreToContext: vi.fn(async () => ({
        metadata: {
          capturedAt: "2026-03-09T09:00:00.000Z",
          cookieCount: 1,
          filePath: "/tmp/default.backup-1.session.enc.json",
          hasLinkedInAuthCookie: true,
          liAtCookieExpiresAt: "2026-03-10T09:00:00.000Z",
          originCount: 1,
          sessionName: "default.backup-1"
        },
        restoredFromBackup: true,
        restoredSessionName: "default.backup-1",
        storageState: createStorageState()
      }))
    } as unknown as LinkedInSessionStore;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false,
      sessionStore
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        loginWallDetected: true,
        reason: "LinkedIn login wall detected."
      }
    });
    const healthyStatus = createHealthStatus();
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(healthyStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const eventTypes = onHealthEvent.mock.calls.map(
      (call) => (call[0] as KeepAliveEvent).type
    );
    expect(eventTypes).toContain("soft-reauth-attempt");
    expect(eventTypes).toContain("soft-reauth-success");
    expect(eventTypes).not.toContain("manual-login-required");
  });
  it("applies jitter with a one-second minimum delay", () => {
    const { pool } = createMockPool();
    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 250,
      jitterMs: 500
    });

    service.start();

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays).toContain(1_000);

    service.stop();
    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("stops rescheduling when stopped during an in-flight tick", async () => {
    const { pool, acquire } = createMockPool();
    const pendingHealthCheck = createDeferred<FullHealthStatus>();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });

    mockedCheckFullHealth.mockImplementation(() => pendingHealthCheck.promise);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acquire).toHaveBeenCalledTimes(1);

    service.stop();
    pendingHealthCheck.resolve(createHealthStatus());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("switches to the retry cadence after a timed-out network interruption", async () => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new Error("Timed out while connecting"))
      .mockRejectedValueOnce(new Error("Timed out while reconnecting"));
    const pool = {
      acquire,
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 5_000,
      jitterMs: 0,
      networkGracePeriodMs: 60_000,
      networkRetryIntervalMs: 1_500
    });
    const onError = vi.fn();
    const onHealthEvent = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    service.on("error", onError);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    service.stop();

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays).toEqual(expect.arrayContaining([5_000, 1_500]));
    expect(getEventTypes(onHealthEvent)).toEqual(
      expect.arrayContaining([
        "network-interruption",
        "reconnect-attempt",
        "reconnect-failed"
      ])
    );
    expect(onError).not.toHaveBeenCalled();
    expect(service.getConsecutiveFailures()).toBe(0);

    setTimeoutSpy.mockRestore();
  });

  it("normalizes non-transient thrown values into error events", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const onError = vi.fn();
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockRejectedValue("HTTP 500");
    service.on("error", onError);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("HTTP 500");
    expect(service.getConsecutiveFailures()).toBe(1);
    expect(getEventTypes(onHealthEvent)).not.toContain("reconnect-attempt");
  });

  it("records a failure when the browser stays connected but unhealthy", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const onError = vi.fn();
    const unhealthyStatus = createHealthStatus({
      browser: {
        healthy: false,
        pageResponsive: false
      }
    });

    mockedCheckFullHealth.mockResolvedValue(unhealthyStatus);
    service.on("error", onError);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
      "Health check failed."
    );
    expect(service.getConsecutiveFailures()).toBe(1);
  });

  it("keeps the interruption active when reconnecting restores the browser but not auth", async () => {
    const { mockContext, release } = createMockPool();
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ context: mockContext, release });
    const pool = {
      acquire,
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      networkGracePeriodMs: 60_000,
      networkRetryIntervalMs: 1_500
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(
      createHealthStatus({
        session: {
          authenticated: false,
          reason: "Authentication required."
        }
      })
    );
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    const reconnectSuccess = getHealthEvents(onHealthEvent).find(
      (event) => event.type === "reconnect-success"
    );
    expect(reconnectSuccess?.detail).toContain("session still needs recovery");
    expect(service.getMetrics().networkInterruptedAt).toBeDefined();
    expect(getEventTypes(onHealthEvent)).not.toContain("network-recovered");
  });

  it("recovers the live session with soft re-auth before manual login is required", async () => {
    const { pool, mockPage } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        loginWallDetected: true,
        reason: "LinkedIn login wall detected.",
        sessionCookiePresent: true
      }
    });
    const recoveredStatus = createHealthStatus({
      session: {
        sessionCookieFingerprint: "recovered-session-fingerprint"
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(recoveredStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(getEventTypes(onHealthEvent)).toEqual(
      expect.arrayContaining([
        "session-expired",
        "login-wall-detected",
        "soft-reauth-attempt",
        "soft-reauth-success"
      ])
    );
    expect(getEventTypes(onHealthEvent)).not.toContain("manual-login-required");
    expect(mockPage.goto).toHaveBeenCalledWith(
      "https://www.linkedin.com/feed/",
      { waitUntil: "domcontentloaded" }
    );
    expect(service.getMetrics().lastCookieRefreshAt).toBeDefined();
  });

  it("requires manual login when a stored restore still leaves the session stale", async () => {
    const { pool } = createMockPool();
    const sessionStore = {
      saveWithBackups: vi.fn(async () => undefined),
      restoreToContext: vi.fn(async () => ({
        metadata: {
          capturedAt: "2026-03-09T09:00:00.000Z",
          cookieCount: 1,
          filePath: "/tmp/stale-session.backup-1.session.enc.json",
          hasLinkedInAuthCookie: true,
          liAtCookieExpiresAt: "2026-03-10T09:00:00.000Z",
          originCount: 1,
          sessionName: "stale-session.backup-1"
        },
        restoredFromBackup: true,
        restoredSessionName: "stale-session.backup-1",
        storageState: createStorageState()
      }))
    } as unknown as LinkedInSessionStore;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      maxBackupSessions: 2,
      sessionName: "stale-session",
      sessionRefreshEnabled: false,
      sessionStore
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "LinkedIn session expired.",
        sessionCookiePresent: false
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(expiredStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(sessionStore.restoreToContext).toHaveBeenCalledWith(
      expect.anything(),
      "stale-session",
      {
        allowExpired: false,
        maxBackups: 2
      }
    );
    expect(getEventTypes(onHealthEvent)).toContain("manual-login-required");
    expect(getEventTypes(onHealthEvent)).not.toContain("soft-reauth-success");

    const loginRequiredEvent = getHealthEvents(onHealthEvent).find(
      (event) => event.type === "manual-login-required"
    );
    expect(loginRequiredEvent?.metadata?.whatWasHappening).toBe(
      "session recovery after authentication loss"
    );
  });

  it("falls back to in-memory backup sessions when the live session goes stale", async () => {
    const backupStorageState = createStorageState({
      cookies: [
        {
          ...createStorageState().cookies[0]!,
          value: "backup-cookie"
        }
      ]
    });
    const { addCookies, pool } = createMockPool({
      storageState: backupStorageState
    });
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const healthyStatus = createHealthStatus({
      session: {
        sessionCookieFingerprint: "backup-fingerprint"
      }
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "LinkedIn session expired."
      }
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(healthyStatus)
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(healthyStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(addCookies).toHaveBeenCalledWith(backupStorageState.cookies);

    const successEvent = getHealthEvents(onHealthEvent).find(
      (event) =>
        event.type === "soft-reauth-success" && event.metadata?.source === "memory"
    );
    expect(successEvent).toBeDefined();
    expect(getEventTypes(onHealthEvent)).not.toContain("manual-login-required");
  });

  it("raises and clears cookie-expiry alerts from configured thresholds", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      alertThresholds: {
        cookieExpiringWithinMs: 120_000,
        reconnectsInWindow: {
          count: 99,
          windowMs: 60_000
        }
      },
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth
      .mockResolvedValueOnce(
        createHealthStatus({
          session: {
            nextCookieExpiryAt: new Date(Date.now() + 60_000).toISOString()
          }
        })
      )
      .mockResolvedValueOnce(
        createHealthStatus({
          session: {
            nextCookieExpiryAt: new Date(Date.now() + 10 * 60_000).toISOString()
          }
        })
      );
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.getMetrics().activeAlerts).toContain("cookie-expiry");

    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(service.getMetrics().activeAlerts).not.toContain("cookie-expiry");
    expect(
      getHealthEvents(onHealthEvent).filter(
        (event) =>
          event.type === "alert" && event.metadata?.alertKey === "cookie-expiry"
      )
    ).toHaveLength(1);
  });

  it("emits reconnect burst alerts and clears them once the window passes", async () => {
    const { mockContext, release } = createMockPool();
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ context: mockContext, release })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ context: mockContext, release })
      .mockResolvedValueOnce({ context: mockContext, release });
    const pool = {
      acquire,
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      alertThresholds: {
        cookieExpiringWithinMs: 0,
        reconnectsInWindow: {
          count: 2,
          windowMs: 2_000
        }
      },
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_001,
      jitterMs: 0,
      networkGracePeriodMs: 60_000
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(service.getMetrics().activeAlerts).toContain("reconnect-burst");

    await vi.advanceTimersByTimeAsync(1_001);
    service.stop();

    expect(service.getMetrics().activeAlerts).not.toContain("reconnect-burst");
    expect(
      getHealthEvents(onHealthEvent).filter(
        (event) =>
          event.type === "alert" && event.metadata?.alertKey === "reconnect-burst"
      )
    ).toHaveLength(1);
  });

  it("caps health logs and in-memory backups to the configured limits", async () => {
    const storageStates = ["1", "2", "3", "4"].map((suffix) =>
      createStorageState({
        cookies: [
          {
            ...createStorageState().cookies[0]!,
            value: `cookie-${suffix}`
          }
        ]
      })
    );
    const { pool } = createMockPool({
      storageStateCalls: storageStates
    });
    const service = new SessionKeepAliveService(pool, {
      activitySimulationEnabled: false,
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      maxBackupSessions: 2,
      maxHealthLogEntries: 5,
      sessionRefreshEnabled: false
    });
    const healthQueue = [
      "fp-1",
      "fp-2",
      "fp-3",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4",
      "fp-4"
    ].map((fingerprint) =>
      createHealthStatus({
        session: {
          sessionCookieFingerprint: fingerprint
        }
      })
    );

    mockedCheckFullHealth.mockImplementation(async () => {
      return healthQueue.shift() ?? createHealthStatus();
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.stop();

    const healthLog = service.getHealthLog();
    expect(healthLog).toHaveLength(10);
    expect(service.getMetrics().backupSessionCount).toBe(2);
    expect(service.getMetrics().lastSessionFingerprint).toBeDefined();
    expect(service.getMetrics().sessionUptimeMs).toBeGreaterThan(0);

    healthLog.pop();
    expect(service.getHealthLog()).toHaveLength(10);
  });

  it("warms the session after extended idle time before simulating activity", async () => {
    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      activityEveryHealthyTicks: 1,
      cdpUrl: "http://127.0.0.1:18800",
      idleWarmupThresholdMs: 500,
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(getEventTypes(onHealthEvent)).toContain("warmup");
    expect(service.getMetrics().lastWarmupAt).toBeDefined();
  });

  it("closes orphaned tabs during healthy ticks", async () => {
    const primaryPage = createMockPage("https://www.linkedin.com/feed/");
    const secondaryPage = createMockPage(
      "https://www.linkedin.com/notifications/"
    );
    const blankPage = createMockPage("about:blank");
    const errorPage = createMockPage("chrome-error://chromewebdata/");
    const mockContext = {
      addCookies: vi.fn(async () => undefined),
      cookies: vi.fn(async () => createStorageState().cookies),
      newPage: vi.fn(async () => primaryPage),
      pages: vi.fn(() => [primaryPage, secondaryPage, blankPage, errorPage]),
      storageState: vi.fn(async () => createStorageState())
    } as unknown as BrowserContext;
    const release = vi.fn();
    const pool = {
      acquire: vi.fn(async () => ({ context: mockContext, release })),
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      activitySimulationEnabled: false,
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      sessionRefreshEnabled: false
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(blankPage.close).toHaveBeenCalledOnce();
    expect(errorPage.close).toHaveBeenCalledOnce();
    expect(secondaryPage.close).not.toHaveBeenCalled();

    const cleanupEvent = getHealthEvents(onHealthEvent).find(
      (event) => event.type === "tab-cleanup"
    );
    expect(cleanupEvent?.metadata).toMatchObject({
      closedCount: 2,
      remainingPages: 2
    });
  });

  it("uses the night activity cadence during configured quiet hours", async () => {
    vi.setSystemTime(new Date("2026-03-09T01:00:00.000Z"));

    const { pool } = createMockPool();
    const service = new SessionKeepAliveService(pool, {
      activityEveryHealthyTicks: 1,
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      nightActivityEveryHealthyTicks: 3,
      nightHours: {
        endHour: 6,
        startHour: 0
      },
      sessionRefreshEnabled: false
    });
    const onHealthEvent = vi.fn();

    mockedCheckFullHealth.mockResolvedValue(createHealthStatus());
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      getHealthEvents(onHealthEvent).filter((event) => event.type === "activity")
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(
      getHealthEvents(onHealthEvent).filter((event) => event.type === "activity")
    ).toHaveLength(1);
  });

  it("runs through a full keepalive lifecycle across healthy, reconnect, and recovery states", async () => {
    const { addCookies, mockContext, release } = createMockPool();
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({ context: mockContext, release })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ context: mockContext, release })
      .mockResolvedValueOnce({ context: mockContext, release });
    const pool = {
      acquire,
      dispose: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined)
    } as unknown as CDPConnectionPool;
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: "http://127.0.0.1:18800",
      intervalMs: 1_000,
      jitterMs: 0,
      networkGracePeriodMs: 60_000,
      sessionRefreshEnabled: false
    });
    const onHealthEvent = vi.fn();
    const healthyStatus = createHealthStatus({
      session: {
        sessionCookieFingerprint: "lifecycle-fingerprint"
      }
    });
    const expiredStatus = createHealthStatus({
      session: {
        authenticated: false,
        reason: "LinkedIn session expired."
      }
    });

    mockedCheckFullHealth
      .mockResolvedValueOnce(healthyStatus)
      .mockResolvedValueOnce(healthyStatus)
      .mockResolvedValueOnce(expiredStatus)
      .mockResolvedValueOnce(healthyStatus);
    service.on("health-event", onHealthEvent);

    service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    service.stop();

    expect(getEventTypes(onHealthEvent)).toEqual(
      expect.arrayContaining([
        "healthy",
        "network-interruption",
        "reconnect-attempt",
        "reconnect-success",
        "network-recovered",
        "session-expired",
        "soft-reauth-attempt",
        "soft-reauth-success"
      ])
    );
    expect(addCookies).toHaveBeenCalled();
    expect(service.getMetrics()).toMatchObject({
      authenticated: true,
      backupSessionCount: 1,
      reconnectCount: 1
    });
    expect(service.getMetrics().lastLoginRequiredAt).toBeUndefined();
  });

});
