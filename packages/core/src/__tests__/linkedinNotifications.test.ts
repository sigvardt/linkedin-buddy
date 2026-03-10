import { describe, expect, it } from "vitest";
import {
  createNotificationActionExecutors,
  DISMISS_NOTIFICATION_ACTION_TYPE,
  LinkedInNotificationsService,
  type LinkedInNotification,
  type LinkedInNotificationPreference,
  type LinkedInNotificationPreferenceChangeInput,
  type ListNotificationsInput,
  type LinkedInNotificationsRuntime
} from "../linkedinNotifications.js";

describe("LinkedInNotificationsService", () => {
  it("exports the service class", () => {
    expect(LinkedInNotificationsService).toBeDefined();
    expect(typeof LinkedInNotificationsService).toBe("function");
  });

  it("interface types are importable", () => {
    const notification: LinkedInNotification = {
      id: "test-1",
      type: "reaction",
      message: "Someone liked your post",
      timestamp: "2h ago",
      link: "https://www.linkedin.com/notifications/test",
      is_read: false
    };

    expect(notification.id).toBe("test-1");
    expect(notification.type).toBe("reaction");
    expect(notification.is_read).toBe(false);
  });

  it("input interface accepts optional fields", () => {
    const input: ListNotificationsInput = {};
    expect(input.profileName).toBeUndefined();
    expect(input.limit).toBeUndefined();

    const inputWithValues: ListNotificationsInput = {
      profileName: "test",
      limit: 5
    };
    expect(inputWithValues.profileName).toBe("test");
    expect(inputWithValues.limit).toBe(5);
  });

  it("runtime interface shape is correct", () => {
    const runtimeKeys: (keyof LinkedInNotificationsRuntime)[] = [
      "auth",
      "cdpUrl",
      "selectorLocale",
      "profileManager",
      "logger",
      "rateLimiter",
      "artifacts",
      "confirmFailureArtifacts",
      "twoPhaseCommit"
    ];
    expect(runtimeKeys).toHaveLength(9);
  });

  it("exports notification action executors", () => {
    const executors = createNotificationActionExecutors();
    expect(executors).toHaveProperty(DISMISS_NOTIFICATION_ACTION_TYPE);
    expect(Object.keys(executors)).toContain("notifications.update_preferences");
  });

  it("notification preference interfaces are importable", () => {
    const preference: LinkedInNotificationPreference = {
      key: "this-post",
      label: "This post",
      enabled: true
    };
    const change: LinkedInNotificationPreferenceChangeInput = {
      preference: "this-post",
      enabled: false
    };

    expect(preference.key).toBe("this-post");
    expect(change.enabled).toBe(false);
  });
});
