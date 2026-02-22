import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

describe("Connections E2E", () => {
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

  it("list connections returns array with name, profile_url", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const connections = await runtime.connections.listConnections();

    expect(Array.isArray(connections)).toBe(true);
    const [first] = connections;
    if (first) {
      expect(first.full_name.length).toBeGreaterThan(0);
      expect(first.profile_url).toContain("linkedin.com");
    }
  });

  it("list with limit 5 returns <= 5 results", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const connections = await runtime.connections.listConnections({ limit: 5 });

    expect(connections.length).toBeLessThanOrEqual(5);
  });
});
