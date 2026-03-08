import { describe, expect, it } from "vitest";
import { getCdpUrl, setupE2ESuite } from "./setup.js";
import { CDPConnectionPool } from "../../connectionPool.js";
import {
  SessionKeepAliveService,
  type KeepAliveEvent
} from "../../keepAlive.js";

describe("Health E2E", () => {
  const e2e = setupE2ESuite();

  it("browser health returns healthy: true", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const health = await runtime.healthCheck();

    expect(health.browser.healthy).toBe(true);
    expect(health.browser.browserConnected).toBe(true);
    expect(health.browser.pageResponsive).toBe(true);
  });

  it("session health returns authenticated: true", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const health = await runtime.healthCheck();

    expect(health.session.authenticated).toBe(true);
    expect(health.session.currentUrl).toContain("linkedin.com");
  });
});

describe("KeepAlive E2E", () => {
  const e2e = setupE2ESuite();

  it("starts, emits health-event, and stops cleanly", async () => {
    if (!e2e.canRun()) return;

    const pool = new CDPConnectionPool({ idleTimeoutMs: 60_000 });
    const service = new SessionKeepAliveService(pool, {
      cdpUrl: getCdpUrl(),
      intervalMs: 5_000,
      jitterMs: 0,
      activitySimulationEnabled: false,
      sessionRefreshEnabled: false
    });

    const receivedEvents: KeepAliveEvent[] = [];

    service.on("health-event", (event: KeepAliveEvent) => {
      receivedEvents.push(event);
    });

    service.start();
    expect(service.isRunning()).toBe(true);

    // Wait for at least one health event (max 15s timeout)
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (receivedEvents.length > 0) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      setTimeout(check, 500);
    });

    service.stop();
    expect(service.isRunning()).toBe(false);

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
    const firstEvent = receivedEvents[0]!;
    expect(firstEvent.type).toBe("healthy");
    expect(firstEvent.timestamp).toBeDefined();
    expect(firstEvent.consecutiveFailures).toBe(0);
    expect(firstEvent.health).toBeDefined();
    expect(firstEvent.health!.browser.healthy).toBe(true);
    expect(firstEvent.health!.session.authenticated).toBe(true);

    await pool.dispose();
  }, 30_000);
});
