import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable, getCdpUrl, getE2EBaseDir } from "./setup.js";
import { callMcpTool, getDefaultProfileName, getLastJsonObject, MCP_TOOL_NAMES, runCliCommand } from "./helpers.js";
import { CDPConnectionPool } from "../../connectionPool.js";
import { SessionKeepAliveService, type KeepAliveEvent, type KeepAliveMetrics } from "../../keepAlive.js";
import { LinkedInSessionStore } from "../../auth/sessionStore.js";

function expectIsoTimestamp(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe("Auth Session E2E", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  describe("Auth Status E2E", () => {
    it("status reports authenticated=true for live LinkedIn session", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const status = await runtime.auth.status({ profileName });

      expect(status.authenticated).toBe(true);
      expect(status.currentUrl).toContain("linkedin.com");
    }, 60_000);

    it("status includes checkedAt, reason, and session cookie diagnostics", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const status = await runtime.auth.status({ profileName });

      expectIsoTimestamp(status.checkedAt);
      expect(status.reason).toBeTypeOf("string");
      expect(status.reason.length).toBeGreaterThan(0);
      expect(status.sessionCookiePresent).toBe(true);
    }, 60_000);

    it("status exposes identity and evasion information", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const status = await runtime.auth.status({ profileName });

      // identity may not be populated in fixture replay mode
      if (status.identity && status.identity.fullName) {
        expect(status.identity.fullName).toBeTypeOf("string");
        expect(status.identity.fullName.length).toBeGreaterThan(0);
        expect(status.identity.profileUrl).toContain("linkedin.com");
      }
      expect(status.evasion).toBeDefined();
      expect(status.evasion?.level).toBeTypeOf("string");
    }, 60_000);

    it("status reports no checkpoint, login wall, or active rate limit", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const status = await runtime.auth.status({ profileName });

      expect(status.checkpointDetected).toBeFalsy();
      expect(status.loginWallDetected).toBeFalsy();
      expect(status.rateLimitActive).toBeFalsy();
    }, 60_000);

    it("ensureAuthenticated resolves and confirms authenticated=true", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const status = await runtime.auth.ensureAuthenticated({ profileName });

      expect(status.authenticated).toBe(true);
    }, 60_000);
  });

  describe("Health Check E2E", () => {
    it("healthCheck reports healthy browser connectivity", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const health = await runtime.healthCheck();

      expect(health.browser.healthy).toBe(true);
      expect(health.browser.browserConnected).toBe(true);
      expect(health.browser.pageResponsive).toBe(true);
      expectIsoTimestamp(health.browser.checkedAt);
    }, 60_000);

    it("healthCheck reports authenticated session basics", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const health = await runtime.healthCheck();

      expect(health.session.authenticated).toBe(true);
      expect(health.session.currentUrl).toContain("linkedin.com");
      expect(health.session.reason).toBeTypeOf("string");
      expect(health.session.reason.length).toBeGreaterThan(0);
      expect(health.session.sessionCookiePresent).toBe(true);
    }, 60_000);

    it("healthCheck includes sessionCookies array with cookie names", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const health = await runtime.healthCheck();

      expect(Array.isArray(health.session.sessionCookies)).toBe(true);
      expect(health.session.sessionCookies.length).toBeGreaterThan(0);
      for (const cookie of health.session.sessionCookies) {
        expect(cookie.name).toBeTypeOf("string");
        expect(cookie.name.length).toBeGreaterThan(0);
      }
    }, 60_000);

    it("healthCheck includes evasion details and safety flags", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const health = await runtime.healthCheck();

      expect(health.session.evasion.level).toBeTypeOf("string");
      expect(health.session.checkpointDetected).toBe(false);
      expect(health.session.loginWallDetected).toBe(false);
      expect(health.session.rateLimited).toBe(false);
      expect(
        health.session.sessionCookieFingerprint === null ||
          typeof health.session.sessionCookieFingerprint === "string"
      ).toBe(true);
    }, 60_000);

    it("healthCheck exposes identity details when authenticated", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const health = await runtime.healthCheck();

      // identity may not be populated in fixture replay mode
      if (health.session.identity) {
        expect(typeof health.session.identity).toBe("object");
      }
    }, 60_000);
  });

  describe("Session Store E2E", () => {
    it("round-trips saved storage state and metadata in a temp directory", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const tempDir = mkdtempSync(path.join(tmpdir(), "acid-session-store-"));
      const store = new LinkedInSessionStore(tempDir);
      const storageState = { cookies: [], origins: [] };

      try {
        const metadata = await store.save("acid-test", storageState);

        expect(metadata.sessionName).toBe("acid-test");
        expect(metadata.cookieCount).toBe(0);
        expect(metadata.originCount).toBe(0);
        expect(await store.exists("acid-test")).toBe(true);

        const loaded = await store.load("acid-test");
        expect(loaded.metadata.sessionName).toBe("acid-test");
        expect(loaded.storageState).toEqual(storageState);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);

    it("persists to the E2E base directory and allows explicit cleanup", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const baseDir = getE2EBaseDir();
      const store = new LinkedInSessionStore(baseDir);
      const storageState = { cookies: [], origins: [] };

      const metadata = await store.save("acid-test", storageState);
      try {
        expect(await store.exists("acid-test")).toBe(true);

        const loaded = await store.load("acid-test");
        expect(loaded.storageState).toEqual(storageState);
        expect(loaded.metadata.sessionName).toBe("acid-test");
      } finally {
        rmSync(metadata.filePath, { force: true });
      }
    }, 60_000);

    it("saveWithBackups creates a rotated backup entry", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const tempDir = mkdtempSync(path.join(tmpdir(), "acid-session-store-"));
      const store = new LinkedInSessionStore(tempDir);

      try {
        await store.saveWithBackups("acid-test", { cookies: [], origins: [] }, { maxBackups: 2 });
        await store.saveWithBackups("acid-test", { cookies: [], origins: [] }, { maxBackups: 2 });

        expect(await store.exists("acid-test")).toBe(true);
        expect(await store.exists("acid-test.backup-1")).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe("KeepAlive E2E", () => {
    it("starts and stops cleanly with a CDP-backed keep-alive service", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const cdpUrl = getCdpUrl();
      if (!cdpUrl) {
        context.skip("KeepAlive tests require a CDP endpoint");
        return;
      }

      const pool = new CDPConnectionPool({ idleTimeoutMs: 60_000 });
      const service = new SessionKeepAliveService(pool, {
        cdpUrl,
        intervalMs: 5_000,
        jitterMs: 0,
        activitySimulationEnabled: false,
        sessionRefreshEnabled: false
      });

      try {
        service.start();
        expect(service.isRunning()).toBe(true);
      } finally {
        service.stop();
        await pool.dispose();
      }

      expect(service.isRunning()).toBe(false);
    }, 30_000);

    it("emits healthy events and keeps a non-empty health log", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const cdpUrl = getCdpUrl();
      if (!cdpUrl) {
        context.skip("KeepAlive tests require a CDP endpoint");
        return;
      }

      const pool = new CDPConnectionPool({ idleTimeoutMs: 60_000 });
      const service = new SessionKeepAliveService(pool, {
        cdpUrl,
        intervalMs: 5_000,
        jitterMs: 0,
        activitySimulationEnabled: false,
        sessionRefreshEnabled: false
      });
      const events: KeepAliveEvent[] = [];

      try {
        service.on("health-event", (event: KeepAliveEvent) => {
          events.push(event);
        });
        service.start();

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for keep-alive health events"));
          }, 20_000);

          const check = () => {
            if (events.length > 0) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            setTimeout(check, 250);
          };

          check();
        });

        expect(events.length).toBeGreaterThan(0);
        expect(events.some((event) => event.type === "healthy")).toBe(true);
        expect(service.getHealthLog().length).toBeGreaterThan(0);
      } finally {
        service.stop();
        await pool.dispose();
      }
    }, 30_000);

    it("exposes metrics after at least one health event", async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const cdpUrl = getCdpUrl();
      if (!cdpUrl) {
        context.skip("KeepAlive tests require a CDP endpoint");
        return;
      }

      const pool = new CDPConnectionPool({ idleTimeoutMs: 60_000 });
      const service = new SessionKeepAliveService(pool, {
        cdpUrl,
        intervalMs: 5_000,
        jitterMs: 0,
        activitySimulationEnabled: false,
        sessionRefreshEnabled: false
      });

      try {
        service.start();

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for keep-alive metrics"));
          }, 20_000);

          const check = () => {
            if (service.getHealthLog().length > 0) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            setTimeout(check, 250);
          };

          check();
        });

        const metrics: KeepAliveMetrics = service.getMetrics();
        expect(metrics.authenticated).toBe(true);
        expect(metrics.browserConnected).toBe(true);
        expect(metrics.consecutiveFailures).toBe(0);
        expect(metrics.startedAt).toBeDefined();
        expect(typeof metrics.startedAt).toBe("string");
        expect(typeof metrics.sessionCookiePresent).toBe("boolean");
      } finally {
        service.stop();
        await pool.dispose();
      }
    }, 30_000);
  });

  describe("Auth Session MCP E2E", () => {
    it("session_status returns authenticated runtime session payload", async (context) => {
      skipIfE2EUnavailable(e2e, context);

      const result = await callMcpTool(MCP_TOOL_NAMES.sessionStatus, {
        profileName
      });

      expect(result.isError).toBe(false);
      const payload = asRecord(result.payload);
      expect(payload.profile_name).toBe(profileName);

      const status = asRecord(payload.status);
      expect(status.authenticated).toBe(true);
      // identity may not be populated in fixture replay mode
      if (status.identity !== undefined) {
        expect(typeof status.identity).toBe("object");
      }
      expect(payload.run_id).toBeTypeOf("string");
    }, 60_000);

    it("session_health returns healthy browser and authenticated session payload", async (context) => {
      skipIfE2EUnavailable(e2e, context);

      const result = await callMcpTool(MCP_TOOL_NAMES.sessionHealth, {
        profileName
      });

      expect(result.isError).toBe(false);
      const payload = asRecord(result.payload);
      expect(payload.profile_name).toBe(profileName);

      const browser = asRecord(payload.browser);
      expect(browser.healthy).toBe(true);
      expect(browser.browserConnected).toBe(true);

      const session = asRecord(payload.session);
      expect(session.authenticated).toBe(true);
      expect(session.sessionCookiePresent).toBe(true);

      const sessionCookies = session.sessionCookies;
      expect(Array.isArray(sessionCookies)).toBe(true);
      expect((sessionCookies as unknown[]).length).toBeGreaterThan(0);
      expect(payload.run_id).toBeTypeOf("string");
    }, 60_000);
  });

  describe("Auth Session CLI E2E", () => {
    it("linkedin status outputs authenticated session JSON", async (context) => {
      skipIfE2EUnavailable(e2e, context);

      const result = await runCliCommand(["status", "--profile", profileName]);
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();

      const payload = getLastJsonObject(result.stdout);
      expect(payload.authenticated).toBe(true);
      // identity may not be populated in fixture replay mode
      if (payload.identity !== undefined) {
        expect(payload.identity).toBeTypeOf("object");
      }
      expect(payload.evasion).toBeTypeOf("object");
      expect(payload.checkedAt).toBeTypeOf("string");
    }, 60_000);

    it("linkedin health outputs healthy browser and session JSON", async (context) => {
      skipIfE2EUnavailable(e2e, context);

      const result = await runCliCommand(["health", "--profile", profileName]);
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();

      const payload = getLastJsonObject(result.stdout);
      const browser = asRecord(payload.browser);
      const session = asRecord(payload.session);

      expect(browser.healthy).toBe(true);
      expect(session.authenticated).toBe(true);
      expect(Array.isArray(session.sessionCookies)).toBe(true);
      expect(session.evasion).toBeTypeOf("object");
    }, 60_000);
  });
});
