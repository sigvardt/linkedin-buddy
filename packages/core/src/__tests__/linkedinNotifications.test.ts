import { describe, expect, it, vi } from "vitest";
import {
  DISMISS_NOTIFICATION_ACTION_TYPE,
  LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS,
  _hashNotificationFingerprint as hashNotificationFingerprint,
  _legacyHashNotificationFingerprint as legacyHashNotificationFingerprint,
  _extractNotificationStructuredData as extractNotificationStructuredData,
  _normalizeNotificationLink as normalizeNotificationLink,
  _stripVolatileContent as stripVolatileContent,
  LinkedInNotificationsService,
  NOTIFICATION_LIST_MAX_LIMIT,
  NOTIFICATION_SCAN_MAX_LIMIT,
  UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
  createNotificationActionExecutors,
  normalizeLinkedInNotificationPreferenceChannel,
  type LinkedInNotification,
  type LinkedInNotificationsRuntime,
} from "../linkedinNotifications.js";

const DEFAULT_PREFERENCE_URL =
  "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting";
const SUBCATEGORY_PREFERENCE_URL =
  "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions";

function createPrepareMock() {
  return vi.fn((input: { preview: Record<string, unknown> }) => ({
    preparedActionId: "pa_test",
    confirmToken: "ct_test",
    expiresAtMs: 123,
    preview: input.preview,
  }));
}

function createNotificationsService(prepare = createPrepareMock()) {
  const service = new LinkedInNotificationsService({
    twoPhaseCommit: { prepare },
  } as unknown as LinkedInNotificationsRuntime);

  return {
    service,
    prepare,
  };
}

describe("LinkedIn notification constants", () => {
  it("uses a stable dismiss action type identifier", () => {
    expect(DISMISS_NOTIFICATION_ACTION_TYPE).toBe("notifications.dismiss");
  });

  it("uses a stable update preference action type identifier", () => {
    expect(UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE).toBe(
      "notifications.update_preference",
    );
  });

  it("exposes the list notifications hard cap", () => {
    expect(NOTIFICATION_LIST_MAX_LIMIT).toBe(100);
  });

  it("exposes the notification scan hard cap", () => {
    expect(NOTIFICATION_SCAN_MAX_LIMIT).toBe(200);
  });

  it("exposes the supported notification preference channels", () => {
    expect(LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS).toEqual([
      "in_app",
      "push",
      "email",
    ]);
  });

  it("normalizes supported notification preference channels", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("in_app")).toBe(
      "in_app",
    );
    expect(normalizeLinkedInNotificationPreferenceChannel("In-app")).toBe(
      "in_app",
    );
    expect(normalizeLinkedInNotificationPreferenceChannel("push")).toBe("push");
    expect(normalizeLinkedInNotificationPreferenceChannel("Email")).toBe(
      "email",
    );
  });

  it("rejects unsupported notification preference channels", () => {
    expect(() => normalizeLinkedInNotificationPreferenceChannel("sms")).toThrow(
      "channel must be one of",
    );
  });
});

describe("normalizeLinkedInNotificationPreferenceChannel", () => {
  it("normalizes in_app to in_app", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("in_app")).toBe(
      "in_app",
    );
  });

  it("normalizes In-app to in_app", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("In-app")).toBe(
      "in_app",
    );
  });

  it("normalizes IN_APP to in_app", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("IN_APP")).toBe(
      "in_app",
    );
  });

  it("normalizes push to push", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("push")).toBe("push");
  });

  it("normalizes Push to push", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("Push")).toBe("push");
  });

  it("normalizes email to email", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("email")).toBe(
      "email",
    );
  });

  it("normalizes E-mail to email", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("E-mail")).toBe(
      "email",
    );
  });

  it("normalizes EMAIL to email", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("EMAIL")).toBe(
      "email",
    );
  });

  it("normalizes values with surrounding whitespace", () => {
    expect(normalizeLinkedInNotificationPreferenceChannel("  push  ")).toBe(
      "push",
    );
  });

  it("rejects an empty channel", () => {
    expect(() => normalizeLinkedInNotificationPreferenceChannel("")).toThrow(
      "channel must be one of",
    );
  });

  it("rejects unsupported channels", () => {
    expect(() => normalizeLinkedInNotificationPreferenceChannel("sms")).toThrow(
      "channel must be one of",
    );
  });
});

describe("createNotificationActionExecutors", () => {
  it("registers the dismiss and update preference executors", () => {
    const executors = createNotificationActionExecutors();

    expect(Object.keys(executors)).toEqual([
      DISMISS_NOTIFICATION_ACTION_TYPE,
      UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
    ]);
    expect(executors[DISMISS_NOTIFICATION_ACTION_TYPE]).toBeDefined();
    expect(executors[UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE]).toBeDefined();
  });

  it("returns both expected executor keys", () => {
    const executors = createNotificationActionExecutors();

    expect(Object.keys(executors)).toEqual([
      DISMISS_NOTIFICATION_ACTION_TYPE,
      UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
    ]);
  });

  it("returns executors with execute methods", () => {
    const executors = createNotificationActionExecutors();

    expect(executors[DISMISS_NOTIFICATION_ACTION_TYPE]).toHaveProperty(
      "execute",
    );
    expect(
      executors[UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE],
    ).toHaveProperty("execute");
  });

  it("returns execute methods as functions", () => {
    const executors = createNotificationActionExecutors();

    expect(typeof executors[DISMISS_NOTIFICATION_ACTION_TYPE]?.execute).toBe(
      "function",
    );
    expect(
      typeof executors[UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE]?.execute,
    ).toBe("function");
  });
});

describe("LinkedInNotificationsService prepare flows", () => {
  it("prepares notification dismiss actions with structured previews", async () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: input.preview,
    }));
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: { prepare },
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
          is_read: false,
        } satisfies LinkedInNotification,
      ]);

    const prepared = await service.prepareDismissNotification({
      notificationId: "notif_123",
    });

    expect(prepared.preview).toMatchObject({
      summary: 'Dismiss LinkedIn notification "Someone reacted to your post"',
      target: {
        profile_name: "default",
        notification_id: "notif_123",
        notification_link:
          "https://www.linkedin.com/feed/update/urn:li:activity:123",
      },
      notification: {
        id: "notif_123",
        is_read: false,
      },
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: DISMISS_NOTIFICATION_ACTION_TYPE,
        payload: {
          notification_id: "notif_123",
        },
      }),
    );
    expect(listNotifications).toHaveBeenCalledWith({
      profileName: "default",
      limit: 75,
    });
  });

  it("prepares category notification preference updates", async () => {
    const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
      preparedActionId: "pa_pref",
      confirmToken: "ct_pref",
      expiresAtMs: 456,
      preview: input.preview,
    }));
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: { prepare },
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
          selector_key: "allPostingAndCommentingNotificationSettings",
        },
        subcategories: [],
      });

    const prepared = await service.prepareUpdatePreference({
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
      enabled: false,
    });

    expect(prepared.preview).toMatchObject({
      summary:
        'Set LinkedIn notification preference "Posting and commenting" to off',
      target: {
        profile_name: "default",
        view_type: "category",
      },
      current_enabled: true,
      enabled: false,
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
        payload: {
          preference_url:
            "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
          enabled: false,
        },
      }),
    );
    expect(getPreferences).toHaveBeenCalledWith({
      profileName: "default",
      preferenceUrl:
        "https://www.linkedin.com/mypreferences/d/notification-categories/posting-and-commenting",
    });
  });

  it("requires a channel when preparing subcategory notification preference updates", async () => {
    const service = new LinkedInNotificationsService({
      twoPhaseCommit: {
        prepare: vi.fn(),
      },
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
          selector_key: "postCommentsAndReactionsViaInApp",
        },
      ],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl:
          "https://www.linkedin.com/mypreferences/d/notification-subcategories/comments-and-reactions",
        enabled: false,
      }),
    ).rejects.toThrow("channel is required");
  });
});

describe("LinkedInNotificationsService.prepareDismissNotification", () => {
  it("rejects empty notificationId", async () => {
    const { service } = createNotificationsService();

    await expect(
      service.prepareDismissNotification({
        notificationId: "",
      }),
    ).rejects.toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
    });
    await expect(
      service.prepareDismissNotification({
        notificationId: "",
      }),
    ).rejects.toThrow("notificationId is required");
  });

  it("rejects whitespace-only notificationId", async () => {
    const { service } = createNotificationsService();

    await expect(
      service.prepareDismissNotification({
        notificationId: "   \n\t  ",
      }),
    ).rejects.toMatchObject({
      code: "ACTION_PRECONDITION_FAILED",
    });
  });

  it("returns TARGET_NOT_FOUND when notification is missing", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([]);

    await expect(
      service.prepareDismissNotification({
        notificationId: "notif_missing",
      }),
    ).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });
  });

  it("returns structured preview for successful dismiss", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([
      {
        id: "notif_123",
        type: "mention",
        message: "You were mentioned",
        timestamp: "1h",
        link: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        is_read: true,
      },
    ]);

    const prepared = await service.prepareDismissNotification({
      notificationId: "notif_123",
    });

    expect(prepared).toMatchObject({
      preparedActionId: "pa_test",
      confirmToken: "ct_test",
      expiresAtMs: 123,
      preview: {
        summary: 'Dismiss LinkedIn notification "You were mentioned"',
        target: {
          profile_name: "default",
          notification_id: "notif_123",
          notification_type: "mention",
        },
        notification: {
          id: "notif_123",
          is_read: true,
        },
      },
    });
  });

  it("uses default profile when none is provided", async () => {
    const { service } = createNotificationsService();
    const listNotifications = vi
      .spyOn(service, "listNotifications")
      .mockResolvedValue([
        {
          id: "notif_123",
          type: "reaction",
          message: "Someone reacted",
          timestamp: "2h",
          link: "https://www.linkedin.com/feed/update/urn:li:activity:321",
          is_read: false,
        },
      ]);

    await service.prepareDismissNotification({
      notificationId: "notif_123",
    });

    expect(listNotifications).toHaveBeenCalledWith({
      profileName: "default",
      limit: 75,
    });
  });

  it("forwards custom profile name", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([
      {
        id: "notif_abc",
        type: "job",
        message: "New job alert",
        timestamp: "3h",
        link: "https://www.linkedin.com/jobs/view/123",
        is_read: false,
      },
    ]);

    await service.prepareDismissNotification({
      profileName: "sales",
      notificationId: "notif_abc",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          profile_name: "sales",
        }),
      }),
    );
  });

  it("forwards operator note when provided", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([
      {
        id: "notif_abc",
        type: "comment",
        message: "New comment",
        timestamp: "4h",
        link: "https://www.linkedin.com/feed/update/urn:li:activity:999",
        is_read: false,
      },
    ]);

    await service.prepareDismissNotification({
      notificationId: "notif_abc",
      operatorNote: "Dismiss duplicate noise",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorNote: "Dismiss duplicate noise",
      }),
    );
  });

  it("omits operator note when not provided", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([
      {
        id: "notif_abc",
        type: "follow",
        message: "You have a new follower",
        timestamp: "5h",
        link: "https://www.linkedin.com/in/test/",
        is_read: false,
      },
    ]);

    await service.prepareDismissNotification({
      notificationId: "notif_abc",
    });

    const call = prepare.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("operatorNote");
  });

  it("trims notificationId before lookup and payload", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "listNotifications").mockResolvedValue([
      {
        id: "notif_trimmed",
        type: "reaction",
        message: "Trimmed id",
        timestamp: "6h",
        link: "https://www.linkedin.com/feed/update/urn:li:activity:444",
        is_read: false,
      },
    ]);

    await service.prepareDismissNotification({
      notificationId: "  notif_trimmed  ",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          notification_id: "notif_trimmed",
        },
      }),
    );
  });
});

describe("LinkedInNotificationsService.prepareUpdatePreference", () => {
  it("rejects overview pages", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "overview",
      title: "Notifications",
      preference_url:
        "https://www.linkedin.com/mypreferences/d/categories/notifications",
      categories: [],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: "categories/notifications",
        enabled: false,
      }),
    ).rejects.toThrow("overview");
  });

  it("requires channel for subcategory pages", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url: SUBCATEGORY_PREFERENCE_URL,
      description: null,
      channels: [
        {
          channel_key: "in_app",
          label: "In-app notifications",
          enabled: true,
          selector_key: "selector_in_app",
        },
      ],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
        enabled: false,
      }),
    ).rejects.toThrow("channel is required");
  });

  it("rejects category updates already enabled", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "category",
      title: "Posting and commenting",
      preference_url: DEFAULT_PREFERENCE_URL,
      description: null,
      master_toggle: {
        label: "Allow post related notifications",
        enabled: true,
        selector_key: "allPostingAndCommentingNotificationSettings",
      },
      subcategories: [],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: DEFAULT_PREFERENCE_URL,
        enabled: true,
      }),
    ).rejects.toThrow("already enabled");
  });

  it("rejects category updates already disabled", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "category",
      title: "Posting and commenting",
      preference_url: DEFAULT_PREFERENCE_URL,
      description: null,
      master_toggle: {
        label: "Allow post related notifications",
        enabled: false,
        selector_key: "allPostingAndCommentingNotificationSettings",
      },
      subcategories: [],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: DEFAULT_PREFERENCE_URL,
        enabled: false,
      }),
    ).rejects.toThrow("already disabled");
  });

  it("rejects subcategory updates already at target state", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url: SUBCATEGORY_PREFERENCE_URL,
      description: null,
      channels: [
        {
          channel_key: "email",
          label: "Email",
          enabled: false,
          selector_key: "selector_email",
        },
      ],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
        channel: "email",
        enabled: false,
      }),
    ).rejects.toThrow("already disabled");
  });

  it("returns TARGET_NOT_FOUND when channel does not exist on subcategory page", async () => {
    const { service } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url: SUBCATEGORY_PREFERENCE_URL,
      description: null,
      channels: [
        {
          channel_key: "in_app",
          label: "In-app notifications",
          enabled: true,
          selector_key: "selector_in_app",
        },
      ],
    });

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
        channel: "push",
        enabled: false,
      }),
    ).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });
  });

  it("prepares category updates with expected preview and payload", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "category",
      title: "Posting and commenting",
      preference_url: DEFAULT_PREFERENCE_URL,
      description: null,
      master_toggle: {
        label: "Allow post related notifications",
        enabled: true,
        selector_key: "allPostingAndCommentingNotificationSettings",
      },
      subcategories: [],
    });

    const prepared = await service.prepareUpdatePreference({
      preferenceUrl: DEFAULT_PREFERENCE_URL,
      enabled: false,
    });

    expect(prepared.preview).toMatchObject({
      summary:
        'Set LinkedIn notification preference "Posting and commenting" to off',
      target: {
        profile_name: "default",
        view_type: "category",
        channel: null,
      },
      current_enabled: true,
      enabled: false,
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          preference_url: DEFAULT_PREFERENCE_URL,
          enabled: false,
        },
      }),
    );
  });

  it("prepares subcategory updates with channel in preview and payload", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url: SUBCATEGORY_PREFERENCE_URL,
      description: null,
      channels: [
        {
          channel_key: "push",
          label: "Push",
          enabled: true,
          selector_key: "selector_push",
        },
      ],
    });

    const prepared = await service.prepareUpdatePreference({
      preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
      channel: "Push",
      enabled: false,
    });

    expect(prepared.preview).toMatchObject({
      summary:
        'Set LinkedIn notification preference "Comments and reactions" (push) to off',
      target: {
        view_type: "subcategory",
        channel: "push",
      },
      current_enabled: true,
      enabled: false,
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          preference_url: SUBCATEGORY_PREFERENCE_URL,
          enabled: false,
          channel: "push",
        },
      }),
    );
  });

  it("forwards operator note for preference updates", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "category",
      title: "Posting and commenting",
      preference_url: DEFAULT_PREFERENCE_URL,
      description: null,
      master_toggle: {
        label: "Allow post related notifications",
        enabled: true,
        selector_key: "allPostingAndCommentingNotificationSettings",
      },
      subcategories: [],
    });

    await service.prepareUpdatePreference({
      preferenceUrl: DEFAULT_PREFERENCE_URL,
      enabled: false,
      operatorNote: "Disable noisy category",
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorNote: "Disable noisy category",
      }),
    );
  });

  it("uses default profile name when not provided", async () => {
    const { service, prepare } = createNotificationsService();
    const getPreferences = vi
      .spyOn(service, "getPreferences")
      .mockResolvedValue({
        view_type: "category",
        title: "Posting and commenting",
        preference_url: DEFAULT_PREFERENCE_URL,
        description: null,
        master_toggle: {
          label: "Allow post related notifications",
          enabled: true,
          selector_key: "allPostingAndCommentingNotificationSettings",
        },
        subcategories: [],
      });

    await service.prepareUpdatePreference({
      preferenceUrl: DEFAULT_PREFERENCE_URL,
      enabled: false,
    });

    expect(getPreferences).toHaveBeenCalledWith({
      profileName: "default",
      preferenceUrl: DEFAULT_PREFERENCE_URL,
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          profile_name: "default",
        }),
      }),
    );
  });

  it("normalizes channel values with punctuation and case", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "subcategory",
      title: "Comments and reactions",
      preference_url: SUBCATEGORY_PREFERENCE_URL,
      description: null,
      channels: [
        {
          channel_key: "email",
          label: "Email",
          enabled: true,
          selector_key: "selector_email",
        },
      ],
    });

    await service.prepareUpdatePreference({
      preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
      channel: "E-mail",
      enabled: false,
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          channel: "email",
        }),
      }),
    );
  });

  it("rejects unsupported channel values", async () => {
    const { service } = createNotificationsService();
    const getPreferences = vi.spyOn(service, "getPreferences");

    await expect(
      service.prepareUpdatePreference({
        preferenceUrl: SUBCATEGORY_PREFERENCE_URL,
        channel: "sms",
        enabled: false,
      }),
    ).rejects.toThrow("channel must be one of");

    expect(getPreferences).not.toHaveBeenCalled();
  });

  it("omits operator note when empty string is provided", async () => {
    const { service, prepare } = createNotificationsService();
    vi.spyOn(service, "getPreferences").mockResolvedValue({
      view_type: "category",
      title: "Posting and commenting",
      preference_url: DEFAULT_PREFERENCE_URL,
      description: null,
      master_toggle: {
        label: "Allow post related notifications",
        enabled: true,
        selector_key: "allPostingAndCommentingNotificationSettings",
      },
      subcategories: [],
    });

    await service.prepareUpdatePreference({
      preferenceUrl: DEFAULT_PREFERENCE_URL,
      enabled: false,
      operatorNote: "",
    });

    const call = prepare.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("operatorNote");
  });
});

describe("normalizeNotificationLink", () => {
  it("strips query parameters", () => {
    expect(
      normalizeNotificationLink(
        "https://www.linkedin.com/feed/update/urn:li:activity:123?utm_source=share",
      ),
    ).toBe("https://www.linkedin.com/feed/update/urn:li:activity:123");
  });

  it("strips fragments", () => {
    expect(normalizeNotificationLink("https://www.linkedin.com/in/someone#section")).toBe(
      "https://www.linkedin.com/in/someone",
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeNotificationLink("https://www.linkedin.com/notifications/")).toBe(
      "https://www.linkedin.com/notifications",
    );
  });

  it("strips query params and fragments together", () => {
    expect(
      normalizeNotificationLink(
        "https://www.linkedin.com/feed/update/urn:li:activity:123?foo=bar#baz",
      ),
    ).toBe("https://www.linkedin.com/feed/update/urn:li:activity:123");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeNotificationLink("")).toBe("");
  });

  it("returns input for non-URL strings", () => {
    expect(normalizeNotificationLink("not-a-url")).toBe("not-a-url");
  });

  it("handles null/undefined via normalizeText", () => {
    expect(normalizeNotificationLink(undefined as unknown as string)).toBe("");
    expect(normalizeNotificationLink(null as unknown as string)).toBe("");
  });

  it("normalizes whitespace before parsing", () => {
    expect(normalizeNotificationLink("  https://www.linkedin.com/in/someone  ")).toBe(
      "https://www.linkedin.com/in/someone",
    );
  });
});

describe("stripVolatileContent", () => {
  it("strips digits from messages", () => {
    expect(stripVolatileContent("Your post has reached 22 impressions")).toBe(
      "Your post has reached impressions",
    );
  });

  it("handles multiple numbers", () => {
    expect(stripVolatileContent("5 people viewed your profile 3 times")).toBe(
      "people viewed your profile times",
    );
  });

  it("collapses resulting double spaces", () => {
    const result = stripVolatileContent("Got 100 views");
    expect(result).not.toContain("  ");
  });

  it("returns empty string for empty input", () => {
    expect(stripVolatileContent("")).toBe("");
  });

  it("returns unchanged text with no numbers", () => {
    expect(stripVolatileContent("Someone liked your post")).toBe(
      "Someone liked your post",
    );
  });
});

describe("hashNotificationFingerprint", () => {
  it("produces stable ID when link query params change", () => {
    const id1 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123?utm=a",
      message: "Someone liked your post",
    });
    const id2 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123?utm=b",
      message: "Someone liked your post",
    });
    expect(id1).toBe(id2);
  });

  it("produces stable ID when message counters change", () => {
    const id1 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/analytics/post-summary/123",
      message: "Your post has reached 22 impressions",
    });
    const id2 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/analytics/post-summary/123",
      message: "Your post has reached 47 impressions",
    });
    expect(id1).toBe(id2);
  });

  it("differentiates notifications with different links", () => {
    const id1 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:111",
      message: "Someone liked your post",
    });
    const id2 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:222",
      message: "Someone liked your post",
    });
    expect(id1).not.toBe(id2);
  });

  it("differentiates notifications with same link but different message structure", () => {
    const id1 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123",
      message: "Alice liked your post",
    });
    const id2 = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123",
      message: "Your post has reached some impressions",
    });
    expect(id1).not.toBe(id2);
  });

  it("starts with notif_ prefix", () => {
    const id = hashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123",
      message: "Test",
    });
    expect(id).toMatch(/^notif_[0-9a-f]{16}$/);
  });
});

describe("legacyHashNotificationFingerprint", () => {
  it("uses raw link without normalization", () => {
    const id1 = legacyHashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123?utm=a",
      message: "Test message",
    });
    const id2 = legacyHashNotificationFingerprint({
      link: "https://www.linkedin.com/feed/update/urn:li:activity:123?utm=b",
      message: "Test message",
    });
    expect(id1).not.toBe(id2);
  });

  it("uses raw message without stripping digits", () => {
    const id1 = legacyHashNotificationFingerprint({
      link: "https://www.linkedin.com/analytics/post-summary/123",
      message: "Your post has reached 22 impressions",
    });
    const id2 = legacyHashNotificationFingerprint({
      link: "https://www.linkedin.com/analytics/post-summary/123",
      message: "Your post has reached 47 impressions",
    });
    expect(id1).not.toBe(id2);
  });

  it("starts with notif_ prefix", () => {
    const id = legacyHashNotificationFingerprint({
      link: "https://www.linkedin.com/test",
      message: "Test",
    });
    expect(id).toMatch(/^notif_[0-9a-f]{16}$/);
  });
});

describe("extractNotificationStructuredData", () => {
  it("extracts post analytics from 'Your post has ... views'", () => {
    expect(extractNotificationStructuredData("Your post has 1,234 views")).toEqual({
      views: 1234,
    });
  });

  it("extracts post analytics from 'people viewed your post'", () => {
    expect(extractNotificationStructuredData("500 people viewed your post")).toEqual({
      views: 500,
    });
  });

  it("extracts profile views from 'people viewed your profile'", () => {
    expect(extractNotificationStructuredData("42 people viewed your profile")).toEqual({
      profile_views: 42,
    });
  });

  it("extracts profile views from 'Your profile was viewed by ... people'", () => {
    expect(
      extractNotificationStructuredData("Your profile was viewed by 100 people"),
    ).toEqual({
      profile_views: 100,
    });
  });

  it("extracts search appearances", () => {
    expect(extractNotificationStructuredData("You appeared in 15 searches")).toEqual({
      search_appearances: 15,
    });
  });

  it("extracts mention sender", () => {
    expect(extractNotificationStructuredData("John Smith mentioned you")).toEqual({
      mentioned_by: "John Smith",
    });
  });

  it("extracts connection sender from connection request", () => {
    expect(
      extractNotificationStructuredData("Jane Doe sent you a connection request"),
    ).toEqual({
      sender: "Jane Doe",
    });
  });

  it("extracts connection sender from accepted connection", () => {
    expect(extractNotificationStructuredData("Bob accepted your connection")).toEqual({
      sender: "Bob",
    });
  });

  it("extracts newsletter subscriber count", () => {
    expect(extractNotificationStructuredData("1,500 people subscribed to")).toEqual({
      subscriber_count: 1500,
    });
  });

  it("extracts newsletter subscriber name", () => {
    expect(extractNotificationStructuredData("Alice subscribed to")).toEqual({
      subscriber: "Alice",
    });
  });

  it("extracts job alert count and title", () => {
    expect(
      extractNotificationStructuredData('5 new jobs for "Software Engineer"'),
    ).toEqual({
      job_count: 5,
      job_title: "Software Engineer",
    });
  });

  it("extracts single job alert title", () => {
    expect(extractNotificationStructuredData('new job for "Designer"')).toEqual({
      job_title: "Designer",
    });
  });

  it("extracts company name from posted notification", () => {
    expect(extractNotificationStructuredData("Google posted:")).toEqual({
      company_name: "Google",
    });
  });

  it("extracts company name from shared post notification", () => {
    expect(extractNotificationStructuredData("Microsoft shared a post:")).toEqual({
      company_name: "Microsoft",
    });
  });

  it("extracts trending topic", () => {
    expect(
      extractNotificationStructuredData("Trending: AI advances in 2025"),
    ).toEqual({
      topic: "AI advances in 2025",
    });
  });

  it("returns undefined when message does not match known parsers", () => {
    expect(
      extractNotificationStructuredData("Someone liked your comment"),
    ).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractNotificationStructuredData("")).toBeUndefined();
  });

  it("normalizes excessive whitespace before parsing", () => {
    expect(
      extractNotificationStructuredData("   John   Smith   mentioned\n\t you   "),
    ).toEqual({
      mentioned_by: "John Smith",
    });
  });
});
