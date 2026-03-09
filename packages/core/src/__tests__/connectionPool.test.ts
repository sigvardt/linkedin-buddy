import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext } from "playwright-core";
import { CDPConnectionPool } from "../connectionPool.js";

const playwrightMocks = vi.hoisted(() => ({
  connectOverCDP: vi.fn<(cdpUrl: string) => Promise<Browser>>()
}));

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: playwrightMocks.connectOverCDP
  }
}));

interface MockBrowserBundle {
  mockBrowser: Browser;
  mockContext: BrowserContext;
  isConnected: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockBrowser(connected = true): MockBrowserBundle {
  let mockBrowser!: Browser;
  const mockContext = {
    browser: () => mockBrowser
  } as unknown as BrowserContext;
  const isConnected = vi.fn(() => connected);
  const close = vi.fn(async () => undefined);

  mockBrowser = {
    isConnected,
    contexts: vi.fn(() => [mockContext]),
    close
  } as unknown as Browser;

  return { mockBrowser, mockContext, isConnected, close };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CDPConnectionPool", () => {
  it("acquire returns context and release", async () => {
    const pool = new CDPConnectionPool({ idleTimeoutMs: 10 });
    const { mockBrowser, mockContext } = createMockBrowser();
    playwrightMocks.connectOverCDP.mockResolvedValue(mockBrowser);

    const lease = await pool.acquire("http://127.0.0.1:18800");

    expect(lease.context).toBe(mockContext);
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledWith(
      "http://127.0.0.1:18800"
    );

    lease.release();
    await pool.dispose();
  });

  it("reuses existing connection for same URL", async () => {
    const pool = new CDPConnectionPool({ idleTimeoutMs: 10 });
    const { mockBrowser, mockContext } = createMockBrowser();
    playwrightMocks.connectOverCDP.mockResolvedValue(mockBrowser);

    const leaseA = await pool.acquire("http://127.0.0.1:18800");
    const leaseB = await pool.acquire("http://127.0.0.1:18800");

    expect(leaseA.context).toBe(mockContext);
    expect(leaseB.context).toBe(mockContext);
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(1);

    leaseA.release();
    leaseB.release();
    await pool.dispose();
  });

  it("reconnects when browser disconnected", async () => {
    const pool = new CDPConnectionPool({ idleTimeoutMs: 10 });
    const first = createMockBrowser(true);
    const second = createMockBrowser(true);

    playwrightMocks.connectOverCDP
      .mockResolvedValueOnce(first.mockBrowser)
      .mockResolvedValueOnce(second.mockBrowser);

    const leaseA = await pool.acquire("http://127.0.0.1:18800");
    first.isConnected.mockReturnValue(false);
    leaseA.release();

    const leaseB = await pool.acquire("http://127.0.0.1:18800");

    expect(leaseB.context).toBe(second.mockContext);
    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);

    leaseB.release();
    await pool.dispose();
  });

  it("dispose closes all connections", async () => {
    const pool = new CDPConnectionPool({ idleTimeoutMs: 10 });
    const first = createMockBrowser(true);
    const second = createMockBrowser(true);

    playwrightMocks.connectOverCDP
      .mockResolvedValueOnce(first.mockBrowser)
      .mockResolvedValueOnce(second.mockBrowser);

    const leaseA = await pool.acquire("http://127.0.0.1:18800");
    const leaseB = await pool.acquire("http://127.0.0.1:18801");
    leaseA.release();
    leaseB.release();

    await pool.dispose();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("preemptively reconnects stale connections before they age out", async () => {
    vi.useFakeTimers();

    const pool = new CDPConnectionPool({
      idleTimeoutMs: 60_000,
      maxConnectionAgeMs: 1_000
    });
    const first = createMockBrowser(true);
    const second = createMockBrowser(true);

    playwrightMocks.connectOverCDP
      .mockResolvedValueOnce(first.mockBrowser)
      .mockResolvedValueOnce(second.mockBrowser);

    const firstLease = await pool.acquire("http://127.0.0.1:18800");
    firstLease.release();

    await vi.advanceTimersByTimeAsync(1_500);

    const secondLease = await pool.acquire("http://127.0.0.1:18800");

    expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(secondLease.context).toBe(second.mockContext);

    secondLease.release();
    await pool.dispose();
  });

  it("exposes connection stats for monitoring", async () => {
    const pool = new CDPConnectionPool({ idleTimeoutMs: 10 });
    const { mockBrowser } = createMockBrowser();
    playwrightMocks.connectOverCDP.mockResolvedValue(mockBrowser);

    const lease = await pool.acquire("http://127.0.0.1:18800");
    const [stats] = pool.getStats();

    expect(stats).toMatchObject({
      cdpUrl: "http://127.0.0.1:18800",
      connected: true,
      idleScheduled: false,
      refCount: 1
    });
    expect(stats?.connectedAt).toContain("T");
    expect(stats?.lastAcquiredAt).toContain("T");

    lease.release();
    await pool.dispose();
  });
});
