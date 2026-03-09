import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityWebhookConfig } from "../config.js";
import { AssistantDatabase } from "../db/database.js";
import { LinkedInAssistantError } from "../errors.js";
import {
  ActivityWatchesService,
  getNextCronOccurrenceMs,
  parseCronExpression,
  type ActivityWatchesRuntime,
  type CreateActivityWatchInput
} from "../activityWatches.js";

const FIXED_NOW = new Date(2026, 2, 9, 10, 0, 0, 0);
const databases: AssistantDatabase[] = [];

function createActivityConfig(
  overrides: Partial<ActivityWebhookConfig> = {}
): ActivityWebhookConfig {
  const retry = {
    maxAttempts: 4,
    initialBackoffMs: 1_000,
    maxBackoffMs: 60_000,
    ...overrides.retry
  };

  return {
    enabled: true,
    daemonPollIntervalMs: 60_000,
    maxWatchesPerTick: 10,
    watchLeaseTtlMs: 60_000,
    maxDeliveriesPerTick: 25,
    deliveryLeaseTtlMs: 60_000,
    deliveryTimeoutMs: 5_000,
    ...overrides,
    retry
  };
}

function createRuntime(
  activityConfig?: ActivityWebhookConfig
): ActivityWatchesRuntime {
  const db = new AssistantDatabase(":memory:");
  databases.push(db);
  return {
    db,
    logger: {
      log: vi.fn()
    } as ActivityWatchesRuntime["logger"],
    ...(activityConfig ? { activityConfig } : {})
  };
}

function captureLinkedInError(action: () => unknown): LinkedInAssistantError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInAssistantError);
    return error as LinkedInAssistantError;
  }

  throw new Error("Expected LinkedInAssistantError to be thrown.");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  while (databases.length > 0) {
    const db = databases.pop();
    db?.close();
  }
});

describe("ActivityWatchesService", () => {
  it("normalizes watch targets and schedules across watch kinds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const service = new ActivityWatchesService(createRuntime(createActivityConfig()));

    const inboxWatch = service.createWatch({
      profileName: "ops",
      kind: "inbox_threads",
      intervalSeconds: 900,
      target: {
        limit: 7,
        messageLimit: 3,
        unreadOnly: true
      }
    });
    const notificationsWatch = service.createWatch({
      kind: "notifications"
    });
    const pendingWatch = service.createWatch({
      kind: "pending_invitations",
      target: {
        direction: "sent"
      }
    });
    const acceptedWatch = service.createWatch({
      kind: "accepted_invitations"
    });
    const connectionsWatch = service.createWatch({
      kind: "connections"
    });
    const profileWatch = service.createWatch({
      kind: "profile_watch",
      target: {
        target: "/in/jane-doe"
      },
      cron: "0 9 * * 1-5"
    });
    const feedWatch = service.createWatch({
      kind: "feed",
      target: {
        limit: 5
      }
    });

    expect(inboxWatch).toMatchObject({
      profileName: "ops",
      kind: "inbox_threads",
      scheduleKind: "interval",
      pollIntervalMs: 900_000,
      target: {
        limit: 7,
        messageLimit: 3,
        unreadOnly: true
      }
    });
    expect(notificationsWatch.target).toEqual({
      limit: 20
    });
    expect(pendingWatch.target).toEqual({
      direction: "sent"
    });
    expect(acceptedWatch.target).toEqual({
      sinceDays: 30
    });
    expect(connectionsWatch.target).toEqual({
      limit: 40
    });
    expect(profileWatch).toMatchObject({
      scheduleKind: "cron",
      pollIntervalMs: null,
      cronExpression: "0 9 * * 1-5",
      target: {
        target: "https://www.linkedin.com/in/jane-doe"
      }
    });
    expect(feedWatch.target).toEqual({
      limit: 5
    });

    expect(
      service.listWatches({
        profileName: "ops"
      })
    ).toHaveLength(1);
    expect(service.listWatches()).toHaveLength(7);

    const pausedWatch = service.pauseWatch(feedWatch.id);
    expect(pausedWatch.status).toBe("paused");
    expect(
      service.listWatches({
        status: "paused"
      })
    ).toHaveLength(1);

    const resumedWatch = service.resumeWatch(feedWatch.id);
    expect(resumedWatch.status).toBe("active");
    expect(resumedWatch.nextPollAtMs).toBe(FIXED_NOW.getTime());
  });

  it("parses cron expressions and computes the next matching occurrence", () => {
    const parsed = parseCronExpression("*/15 9-17/2 1,15 1-3 0,7");

    expect([...parsed.minute]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hour]).toEqual([9, 11, 13, 15, 17]);
    expect([...parsed.dayOfMonth]).toEqual([1, 15]);
    expect([...parsed.month]).toEqual([1, 2, 3]);
    expect([...parsed.dayOfWeek]).toEqual([0]);

    const afterMs = new Date(2026, 2, 9, 8, 59, 30, 0).getTime();
    const nextMs = getNextCronOccurrenceMs("0 9 * * 1-5", afterMs);

    expect(nextMs).toBe(new Date(2026, 2, 9, 9, 0, 0, 0).getTime());
  });

  it("rejects invalid watch, cron, and subscription inputs", () => {
    const service = new ActivityWatchesService(createRuntime(createActivityConfig()));

    const unsupportedKind = captureLinkedInError(() =>
      service.createWatch({
        kind: "bogus" as unknown as CreateActivityWatchInput["kind"]
      })
    );
    expect(unsupportedKind.code).toBe("ACTION_PRECONDITION_FAILED");
    expect(unsupportedKind.message).toContain("kind must be one of");

    const invalidTargetLimit = captureLinkedInError(() =>
      service.createWatch({
        kind: "notifications",
        target: {
          limit: "3" as unknown as number
        }
      })
    );
    expect(invalidTargetLimit.message).toBe(
      "target.limit must be a positive integer."
    );

    const invalidMessageLimit = captureLinkedInError(() =>
      service.createWatch({
        kind: "inbox_threads",
        target: {
          messageLimit: 26
        }
      })
    );
    expect(invalidMessageLimit.message).toBe(
      "target.messageLimit must be between 1 and 25."
    );

    const invalidDirection = captureLinkedInError(() =>
      service.createWatch({
        kind: "pending_invitations",
        target: {
          direction: "sideways"
        }
      })
    );
    expect(invalidDirection.message).toBe(
      "target.direction must be one of: all, sent, received."
    );

    const invalidSinceDays = captureLinkedInError(() =>
      service.createWatch({
        kind: "accepted_invitations",
        target: {
          sinceDays: 366
        }
      })
    );
    expect(invalidSinceDays.message).toBe(
      "target.sinceDays must be between 1 and 365."
    );

    const missingProfileTarget = captureLinkedInError(() =>
      service.createWatch({
        kind: "profile_watch",
        target: {}
      })
    );
    expect(missingProfileTarget.message).toBe("target.target is required.");

    const invalidProfileTarget = captureLinkedInError(() =>
      service.createWatch({
        kind: "profile_watch",
        target: {
          target: "https://example.com/not-linkedin"
        }
      })
    );
    expect(invalidProfileTarget.message).toBe(
      "Profile URL must point to linkedin.com/in/."
    );

    const conflictingSchedule = captureLinkedInError(() =>
      service.createWatch({
        kind: "notifications",
        intervalSeconds: 60,
        cron: "* * * * *"
      })
    );
    expect(conflictingSchedule.message).toBe(
      "Specify either intervalSeconds or cron, not both."
    );

    const zeroInterval = captureLinkedInError(() =>
      service.createWatch({
        kind: "notifications",
        intervalSeconds: 0
      })
    );
    expect(zeroInterval.message).toBe(
      "intervalSeconds must be between 1 and 86400."
    );

    const oversizedInterval = captureLinkedInError(() =>
      service.createWatch({
        kind: "notifications",
        intervalSeconds: 86_401
      })
    );
    expect(oversizedInterval.message).toBe(
      "intervalSeconds must be between 1 and 86400."
    );

    const invalidCronFieldCount = captureLinkedInError(() =>
      parseCronExpression("* * * *")
    );
    expect(invalidCronFieldCount.message).toBe(
      "cron must use 5 fields: minute hour day-of-month month day-of-week."
    );

    const invalidCronStep = captureLinkedInError(() =>
      parseCronExpression("*/0 * * * *")
    );
    expect(invalidCronStep.message).toBe(
      "cron step values must be greater than 0."
    );

    const invalidCronRange = captureLinkedInError(() =>
      parseCronExpression("5-1 * * * *")
    );
    expect(invalidCronRange.message).toBe(
      "cron ranges must end after they start."
    );

    const invalidCronRangeNumbers = captureLinkedInError(() =>
      parseCronExpression("x-y * * * *")
    );
    expect(invalidCronRangeNumbers.message).toBe(
      "cron ranges must use whole numbers."
    );

    const invalidCronField = captureLinkedInError(() =>
      parseCronExpression("foo * * * *")
    );
    expect(invalidCronField.message).toBe(
      "cron fields must use numbers, ranges, lists, or step values."
    );

    const invalidCronValue = captureLinkedInError(() =>
      parseCronExpression("60 * * * *")
    );
    expect(invalidCronValue.message).toBe(
      "cron expression contains a value outside the supported range."
    );

    const impossibleCron = captureLinkedInError(() =>
      getNextCronOccurrenceMs("0 0 31 2 *", new Date(2026, 0, 1).getTime())
    );
    expect(impossibleCron.message).toBe(
      "cron did not produce a next occurrence within one year."
    );

    const watch = service.createWatch({
      kind: "connections"
    });

    const invalidUrl = captureLinkedInError(() =>
      service.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: "not-a-url"
      })
    );
    expect(invalidUrl.message).toBe("deliveryUrl must be a valid URL.");

    const invalidProtocol = captureLinkedInError(() =>
      service.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: "ftp://example.com/hooks/linkedin"
      })
    );
    expect(invalidProtocol.message).toBe(
      "deliveryUrl must use http or https."
    );

    const unsupportedEventType = captureLinkedInError(() =>
      service.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: "https://example.com/hooks/linkedin",
        eventTypes: ["linkedin.notifications.item.created"]
      })
    );
    expect(unsupportedEventType.message).toContain(
      "Unsupported event types for connections"
    );

    const missingWatch = captureLinkedInError(() =>
      service.getWatchById("missing")
    );
    expect(missingWatch.code).toBe("TARGET_NOT_FOUND");
    expect(missingWatch.message).toBe("Activity watch missing was not found.");

    const missingSubscription = captureLinkedInError(() =>
      service.getWebhookSubscriptionById("missing")
    );
    expect(missingSubscription.code).toBe("TARGET_NOT_FOUND");
    expect(missingSubscription.message).toBe(
      "Webhook subscription missing was not found."
    );
  });

  it("deduplicates webhook events and maps stored rows through read APIs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const runtime = createRuntime(createActivityConfig());
    const service = new ActivityWatchesService(runtime);
    const watch = service.createWatch({
      profileName: "default",
      kind: "notifications"
    });

    const createdSubscription = service.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "https://example.com/hooks/linkedin",
      eventTypes: [
        "linkedin.notifications.item.created",
        "linkedin.notifications.item.created",
        "linkedin.notifications.item.read_changed"
      ],
      signingSecret: "  custom-secret  ",
      maxAttempts: 9
    });

    expect(createdSubscription.signingSecret).toBe("custom-secret");
    expect(createdSubscription.maxAttempts).toBe(9);
    expect(createdSubscription.eventTypes).toEqual([
      "linkedin.notifications.item.created",
      "linkedin.notifications.item.read_changed"
    ]);

    runtime.db.insertActivityWatch({
      id: "watch_invalid_json",
      profileName: "default",
      kind: "notifications",
      targetJson: "not-json",
      scheduleKind: "interval",
      pollIntervalMs: 60_000,
      status: "active",
      nextPollAtMs: FIXED_NOW.getTime(),
      createdAtMs: FIXED_NOW.getTime(),
      updatedAtMs: FIXED_NOW.getTime()
    });

    expect(service.getWatchById("watch_invalid_json").target).toEqual({});

    runtime.db.insertWebhookSubscription({
      id: "whsub_filtered",
      watchId: watch.id,
      status: "active",
      eventTypesJson:
        '["linkedin.notifications.item.created","bad-event",42]',
      deliveryUrl: "https://example.com/hooks/filter",
      signingSecret: "whsec_manual",
      maxAttempts: 3,
      createdAtMs: FIXED_NOW.getTime(),
      updatedAtMs: FIXED_NOW.getTime()
    });
    runtime.db.insertWebhookSubscription({
      id: "whsub_invalid_json",
      watchId: watch.id,
      status: "active",
      eventTypesJson: "not-json",
      deliveryUrl: "https://example.com/hooks/invalid-json",
      signingSecret: "whsec_invalid",
      maxAttempts: 3,
      createdAtMs: FIXED_NOW.getTime(),
      updatedAtMs: FIXED_NOW.getTime()
    });

    expect(service.getWebhookSubscriptionById("whsub_filtered").eventTypes).toEqual([
      "linkedin.notifications.item.created"
    ]);
    expect(service.getWebhookSubscriptionById("whsub_invalid_json").eventTypes).toEqual(
      []
    );

    runtime.db.insertActivityEvent({
      id: "evt_old",
      watchId: watch.id,
      profileName: "default",
      eventType: "linkedin.notifications.item.created",
      entityKey: "notification:notif-old",
      payloadJson: "not-json",
      fingerprint: "fingerprint-old",
      occurredAtMs: FIXED_NOW.getTime() - 2_000,
      createdAtMs: FIXED_NOW.getTime() - 2_000
    });
    runtime.db.insertActivityEvent({
      id: "evt_new",
      watchId: watch.id,
      profileName: "default",
      eventType: "linkedin.notifications.item.read_changed",
      entityKey: "notification:notif-new",
      payloadJson: JSON.stringify({
        id: "evt_new",
        ok: true
      }),
      fingerprint: "fingerprint-new",
      occurredAtMs: FIXED_NOW.getTime() - 1_000,
      createdAtMs: FIXED_NOW.getTime() - 1_000
    });

    const events = service.listEvents({
      watchId: watch.id,
      limit: 10
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe("evt_new");
    expect(events[0]?.payload).toEqual({
      id: "evt_new",
      ok: true
    });
    expect(events[1]?.id).toBe("evt_old");
    expect(events[1]?.payload).toEqual({});

    runtime.db.insertWebhookDeliveryAttempt({
      id: "whdel_failed",
      watchId: watch.id,
      profileName: "default",
      subscriptionId: createdSubscription.id,
      eventId: "evt_new",
      eventType: "linkedin.notifications.item.read_changed",
      deliveryUrl: createdSubscription.deliveryUrl,
      payloadJson: "[]",
      attemptNumber: 1,
      status: "failed",
      nextAttemptAtMs: FIXED_NOW.getTime(),
      createdAtMs: FIXED_NOW.getTime() - 500,
      updatedAtMs: FIXED_NOW.getTime() - 500
    });

    const deliveries = service.listDeliveries({
      subscriptionId: createdSubscription.id,
      status: "failed",
      limit: 10
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toEqual({});

    const pausedSubscription = service.pauseWebhookSubscription(createdSubscription.id);
    expect(pausedSubscription.status).toBe("paused");
    expect(
      service.listWebhookSubscriptions({
        status: "paused"
      })
    ).toHaveLength(1);

    const resumedSubscription = service.resumeWebhookSubscription(
      createdSubscription.id
    );
    expect(resumedSubscription.status).toBe("active");

    expect(service.removeWebhookSubscription(createdSubscription.id)).toBe(true);
    expect(service.removeWatch(watch.id)).toBe(true);
  });

  it("falls back to resolved activity config when no runtime override is provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const previousMaxAttempts =
      process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS;
    process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS = "8";

    try {
      const service = new ActivityWatchesService(createRuntime());
      const watch = service.createWatch({
        kind: "connections"
      });
      const subscription = service.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: "https://example.com/hooks/linkedin"
      });

      expect(subscription.maxAttempts).toBe(8);
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS;
      } else {
        process.env.LINKEDIN_ASSISTANT_ACTIVITY_MAX_DELIVERY_ATTEMPTS =
          previousMaxAttempts;
      }
    }
  });
});
