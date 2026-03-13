import { describe, expect, it } from "vitest";
import type {
  LinkedInNotification,
  MarkNotificationReadResult
} from "../../linkedinNotifications.js";
import { expectPreparedAction } from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const NOTIFICATION_CATEGORY_URL =
  "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting";

function expectNotificationShape(notification: LinkedInNotification): void {
  expect(typeof notification.id).toBe("string");
  expect(notification.id.length).toBeGreaterThan(0);
  expect(typeof notification.type).toBe("string");
  expect(notification.type.length).toBeGreaterThan(0);
  expect(typeof notification.message).toBe("string");
  expect(notification.message.length).toBeGreaterThan(0);
  expect(typeof notification.timestamp).toBe("string");
  expect(notification.timestamp.length).toBeGreaterThan(0);
  expect(typeof notification.link).toBe("string");
  expect(notification.link).toContain("linkedin.com");
  expect(typeof notification.is_read).toBe("boolean");
}

function expectMarkReadShape(
  result: MarkNotificationReadResult,
  expectedNotificationId: string
): void {
  expect(result.marked_read).toBe(true);
  expect(result.notification_id).toBe(expectedNotificationId);
  expect(typeof result.notification_id).toBe("string");
  expect(result.notification_id.length).toBeGreaterThan(0);
  expect(typeof result.link).toBe("string");
  expect(result.link.length).toBeGreaterThan(0);
  expect(typeof result.was_already_read).toBe("boolean");
  expect(
    result.selector_key === null || typeof result.selector_key === "string"
  ).toBe(true);
}

function expectNonEmptyNotificationId(notifications: LinkedInNotification[]): string {
  const first = notifications[0];
  expect(first, "Expected at least one notification for this E2E test").toBeDefined();
  return first!.id;
}

describe("Notifications E2E", () => {
  const e2e = setupE2ESuite();

  it("list notifications returns array with expected fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 5 });

    expect(Array.isArray(notifications)).toBe(true);
    for (const notification of notifications) {
      expectNotificationShape(notification);
    }
  }, 120_000);

  it("list notifications respects limit parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 2 });

    expect(Array.isArray(notifications)).toBe(true);
    expect(notifications.length).toBeLessThanOrEqual(2);
  }, 120_000);

  it("notification IDs are stable across consecutive calls", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const first = await runtime.notifications.listNotifications({ limit: 10 });
    const second = await runtime.notifications.listNotifications({ limit: 10 });

    const firstIds = new Set(first.map((notification) => notification.id));
    const sharedIds = second.filter((notification) => firstIds.has(notification.id));

    expect(sharedIds.length).toBeGreaterThan(0);
  }, 120_000);

  it("mark-read returns result with expected fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 10 });
    const notificationId = expectNonEmptyNotificationId(notifications);

    const result = await runtime.notifications.markRead({
      notificationId
    });

    expectMarkReadShape(result, notificationId);
  }, 120_000);

  it("prepare dismiss returns valid prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const notifications = await runtime.notifications.listNotifications({ limit: 10 });
    const notificationId = expectNonEmptyNotificationId(notifications);

    const prepared = await runtime.notifications.prepareDismissNotification({
      notificationId
    });

    expectPreparedAction(prepared);
    expect(prepared.preview.summary).toEqual(expect.any(String));
    expect(prepared.preview.target).toMatchObject({
      notification_id: notificationId
    });
  }, 120_000);

  it("get preferences returns overview with categories", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const overview = await runtime.notifications.getPreferences();

    expect(overview.view_type).toBe("overview");
    if (overview.view_type !== "overview") {
      return;
    }

    expect(Array.isArray(overview.categories)).toBe(true);
    expect(overview.categories.length).toBeGreaterThan(0);
    for (const category of overview.categories) {
      expect(typeof category.title).toBe("string");
      expect(category.title.length).toBeGreaterThan(0);
      expect(typeof category.slug).toBe("string");
      expect(category.slug.length).toBeGreaterThan(0);
      expect(typeof category.preference_url).toBe("string");
      expect(category.preference_url.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("get preferences returns category page with subcategories", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const category = await runtime.notifications.getPreferences({
      preferenceUrl: NOTIFICATION_CATEGORY_URL
    });

    expect(category.view_type).toBe("category");
    if (category.view_type !== "category") {
      return;
    }

    expect(typeof category.title).toBe("string");
    expect(category.title.length).toBeGreaterThan(0);
    expect(
      category.master_toggle === null || typeof category.master_toggle === "object"
    ).toBe(true);
    expect(Array.isArray(category.subcategories)).toBe(true);
  }, 120_000);

  it("get preferences returns subcategory page with channels", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const category = await runtime.notifications.getPreferences({
      preferenceUrl: NOTIFICATION_CATEGORY_URL
    });

    expect(category.view_type).toBe("category");
    if (category.view_type !== "category") {
      return;
    }

    const subcategory = category.subcategories[0];

    expect(subcategory, "Expected at least one subcategory on category page").toBeDefined();

    const subcategoryPage = await runtime.notifications.getPreferences({
      preferenceUrl: subcategory!.preference_url
    });

    expect(subcategoryPage.view_type).toBe("subcategory");
    if (subcategoryPage.view_type !== "subcategory") {
      return;
    }

    expect(Array.isArray(subcategoryPage.channels)).toBe(true);
    for (const channel of subcategoryPage.channels) {
      expect(channel).toHaveProperty("channel_key");
    }
  }, 120_000);

  it("prepare update preference returns valid prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const category = await runtime.notifications.getPreferences({
      preferenceUrl: NOTIFICATION_CATEGORY_URL
    });

    expect(category.view_type).toBe("category");
    if (category.view_type !== "category") {
      return;
    }

    const prepared = await runtime.notifications.prepareUpdatePreference({
      preferenceUrl: category.preference_url,
      enabled: category.master_toggle ? !category.master_toggle.enabled : true
    });

    expectPreparedAction(prepared);
    expect(prepared.preview).toMatchObject({
      preference_url: category.preference_url
    });
  }, 120_000);
});
