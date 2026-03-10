import { describe, expect, it } from "vitest";
import { getNotification } from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

describe("Notifications E2E", () => {
  const e2e = setupE2ESuite();

  it("list notifications does not error, returns array", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 5 });

    expect(Array.isArray(notifications)).toBe(true);
  });

  it("reads notification preferences and prepares notification actions", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notification = await getNotification(runtime);

    const preferences = await runtime.notifications.getPreferences({
      notification: notification.id
    });
    expect(preferences).toMatchObject({
      notification: {
        id: notification.id
      },
      preferences: expect.any(Array)
    });
    const firstPreference = preferences.preferences[0];
    expect(firstPreference).toBeDefined();
    if (!firstPreference) {
      throw new Error("Expected at least one notification preference.");
    }

    const dismiss = await runtime.notifications.prepareDismiss({
      notification: notification.id
    });
    expect(dismiss).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/),
      preview: {
        notification: {
          id: notification.id
        }
      }
    });

    const update = await runtime.notifications.prepareUpdatePreferences({
      notification: notification.id,
      changes: [
        {
          preference: firstPreference.key,
          enabled: !firstPreference.enabled
        }
      ]
    });
    expect(update).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/),
      preview: {
        notification: {
          id: notification.id
        },
        changes: expect.any(Array)
      }
    });
  });
});
