import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Auth E2E", () => {
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

  it("status returns authenticated: true", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const status = await runtime.auth.status();
    expect(status.authenticated).toBe(true);
  });

  it("ensureAuthenticated does not throw", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    await expect(runtime.auth.ensureAuthenticated()).resolves.toMatchObject({
      authenticated: true
    });
  });

  it("current URL contains linkedin.com", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const status = await runtime.auth.status();
    expect(status.currentUrl).toContain("linkedin.com");
  });
});
