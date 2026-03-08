import { describe, expect, it } from "vitest";
import { setupE2ESuite } from "./setup.js";

describe("Notifications E2E", () => {
  const e2e = setupE2ESuite();

  it("list notifications does not error, returns array", async () => {
    if (!e2e.canRun()) return;
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 5 });

    expect(Array.isArray(notifications)).toBe(true);
  });
});
