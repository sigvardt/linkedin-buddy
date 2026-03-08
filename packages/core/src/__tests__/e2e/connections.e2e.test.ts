import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Connections E2E", () => {
  const e2e = setupE2ESuite();

  it("list connections returns array with name, profile_url", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const connections = await runtime.connections.listConnections();

    expect(Array.isArray(connections)).toBe(true);
    const [first] = connections;
    if (first) {
      expect(first.full_name.length).toBeGreaterThan(0);
      expect(first.profile_url).toContain("linkedin.com");
    }
  });

  it("list with limit 5 returns <= 5 results", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const connections = await runtime.connections.listConnections({ limit: 5 });

    expect(connections.length).toBeLessThanOrEqual(5);
  });
});
