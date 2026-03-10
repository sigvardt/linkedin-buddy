import { describe, expect, it, vi } from "vitest";
import {
  DISMISS_NOTIFICATION_ACTION_TYPE,
  LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS,
  LinkedInNotificationsService,
  UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
  createNotificationActionExecutors,
  normalizeLinkedInNotificationPreferenceChannel,
  type LinkedInNotification,
  type LinkedInNotificationsRuntime
} from "../linkedinNotifications.js";

describe("LinkedIn notification constants", () => {
  it("exposes the supported notification preference channels", () => {
    expect(LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS).toEqual([
      "in_app",
      "push",
      "email"
    ]);
  });

  it("normalizes supported notification preference channels", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("in_app")).toBe("in_app");
    expect(normalizeLinkedInNotificationPreferenceChannel("In-app")).toBe("in_app");
    expect(normalizeLinkedInNotificationPreferenceChannel("push")).toBe("push");
    expect(normalizeLinkedInNotificationPreferenceChannel("Email")).toBe("email");
  });

  it("rejects unsupported notification preference channels", () => {
    expect(() =>
      normalizeLinkedInNotificationPreferenceChannel("sms")
    ).toThrow("channel must be one of");
  });
});

describe("createNotificationActionExecutors", () => {
  it("registers the dismiss and update preference executors", () => {
    const executors = createNotificationActionExecutors();

    expect(Object.keys(executors)).toEqual([
      DISMISS_NOTIFICATION_ACTION_TYPE,
      UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE
    ]);
    expect(executors[DISMISS_NOTIFICATION_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInNotificationsService prepare flows", () => {
  it("prepares notification dismiss actions with structured previews", async () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: { prepare }
    } as unknown as LinkedInNotificationsRuntime);
    const listNotifications = vi
      .spyOn(service, "listNotifications")
      .mockResolvedValue([
        {
          id: "notif_123",
          type: "reaction",
          message: "Someone reacted to your post",
          timestamp: "2h",
          link: "https://www.linkedin.com/feed/update/urn:li:activity:123",
          is_read: false
        } satisfies LinkedInNotification
      ]);

    const prepared = await service.prepareDismissNotification({
      notificationId: "notif_123"
    });

    expect(prepared.preview).toMatchObject({
      summary: 'Dismiss LinkedIn notification "Someone reacted to your post"',
      target: {
        profile_name: "default",
        notification_id: "notif_123",
        notification_link: "https://www.linkedin.com/feed/update/urn:li:activity:123"
      },
      notification: {
        id: "notif_123",
        is_read: false
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: DISMISS_NOTIFICATION_ACTION_TYPE,
        payload: {
          notification_id: "notif_123"
        }
      })
    );
    expect(listNotifications).toHaveBeenCalledWith({
      profileName: "default",
      limit: 75
    });
  });

  it("prepares category notification preference updates", async () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref",
      expiresAtMs: 456,
      preview: input.preview
    }));
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: { prepare }
    } as unknown as LinkedInNotificationsRuntime);
    const getPreferences = vi
      .spyOn(service, "getPreferences")
      .mockResolvedValue({
        view_type: "category",
        title: "Posting and commenting",
        preference_url:
          "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
        description: null,
        master_toggle: {
          label: "Allow post related notifications",
          enabled: true,
          selector_key: "allPostingAndCommentingNotificationSettings"
        },
        subcategories: []
      });

    const prepared = await service.prepareUpdatePreference({
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
      enabled: false
    });

    expect(prepared.preview).toMatchObject({
      summary:
        'Set LinkedIn notification preference "Posting and commenting" to off',
      target: {
        profile_name: "default",
        view_type: "category"
      },
      current_enabled: true,
      enabled: false
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
        payload: {
          preference_url:
            "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
          enabled: false
        }
      })
    );
    expect(getPreferences).toHaveBeenCalledWith({
      profileName: "default",
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting"
    });
  });

  it("requires a channel when preparing subcategory notification preference updates", async () => {
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: {
        prepare: vi.fn()
      }
    } as unknown as LinkedInNotificationsRuntime);
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url:
        "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
      description: null,
      channels: [
        {
          channel_key: "in_app",
          label: "In-app notifications",
          enabled: true,
          selector_key: "postCommentsAndReactionsViaInApp"
        }
      ]
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl:
          "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
        enabled: false
      })
    ).rejects.toThrow("channel is required");
  });
});
