import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Health E2E", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  it("browser health returns healthy: true", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const health = await runtime.healthCheck();

    expect(health.browser.healthy).toBe(true);
    expect(health.browser.browserConnected).toBe(true);
    expect(health.browser.pageResponsive).toBe(true);
  });

  it("session health returns authenticated: true", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const health = await runtime.healthCheck();

    expect(health.session.authenticated).toBe(true);
    expect(health.session.currentUrl).toContain("linkedin.com");
  });
});
