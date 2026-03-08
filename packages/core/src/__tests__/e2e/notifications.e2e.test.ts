import { describe, expect, it } from "vitest";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Notifications E2E", () => {
  const e2e = setupE2ESuite();

  it("list notifications does not error, returns array", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 5 });

    expect(Array.isArray(notifications)).toBe(true);
  });
});
