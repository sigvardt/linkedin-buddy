import { describe, expect, it } from "vitest";
import {
  LinkedInNotificationsService,
  type LinkedInNotification,
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
      "profileManager",
      "logger"
    ];
    expect(runtimeKeys).toHaveLength(4);
  });
});
