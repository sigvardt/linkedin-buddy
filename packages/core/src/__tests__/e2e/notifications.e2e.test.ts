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

  it("reads notification preferences and prepares a safe update", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const overview = await runtime.notifications.getPreferences();

    expect(overview).toMatchObject({
      view_type: "overview",
      categories: expect.any(Array)
    });

    const category = await runtime.notifications.getPreferences({
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting"
    });

    expect(category).toMatchObject({
      view_type: "category",
      preference_url: expect.stringContaining("/notification-categories/")
    });
    expect(category.view_type).toBe("category");
    expect(category.master_toggle).not.toBeNull();

    const prepared = await runtime.notifications.prepareUpdatePreference({
      preferenceUrl: category.preference_url,
      enabled: !(category.master_toggle?.enabled ?? false)
    });

    expect(prepared).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });
});
