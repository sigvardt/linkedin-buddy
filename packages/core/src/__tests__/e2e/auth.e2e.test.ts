import { describe, expect, it } from "vitest";
import { setupE2ESuite } from "./setup.js";

describe("Auth E2E", () => {
  const e2e = setupE2ESuite();

  it("status returns authenticated: true", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const status = await runtime.auth.status();
    expect(status.authenticated).toBe(true);
  });

  it("ensureAuthenticated does not throw", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    await expect(runtime.auth.ensureAuthenticated()).resolves.toMatchObject({
      authenticated: true
    });
  });

  it("current URL contains linkedin.com", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const status = await runtime.auth.status();
    expect(status.currentUrl).toContain("linkedin.com");
  });
});
