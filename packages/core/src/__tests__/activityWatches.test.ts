import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityWatchesService,
  type ActivityWatchesRuntime
} from "../activityWatches.js";
import type { ActivityWebhookConfig } from "../config.js";
import { AssistantDatabase } from "../db/database.js";
import { LinkedInAssistantError } from "../errors.js";

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

function createRuntime(): ActivityWatchesRuntime {
  const db = new AssistantDatabase(":memory:");
  databases.push(db);
  return {
    db,
    logger: {
      log: vi.fn()
    } as ActivityWatchesRuntime["logger"],
    activityConfig: createActivityConfig()
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  while (databases.length > 0) {
    const db = databases.pop();
    db?.close();
  }
});

describe("ActivityWatchesService", () => {
  it("creates watches, subscriptions, and updates their status", () => {
    const service = new ActivityWatchesService(createRuntime());

    const watch = service.createWatch({
      profileName: "default",
      kind: "notifications",
      intervalSeconds: 900,
      target: {
        limit: 7
      }
    });

    expect(watch.profileName).toBe("default");
    expect(watch.kind).toBe("notifications");
    expect(watch.scheduleKind).toBe("interval");
    expect(watch.pollIntervalMs).toBe(900_000);
    expect(watch.target).toEqual({
      limit: 7
    });

    const createdSubscription = service.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "https://example.com/hooks/linkedin"
    });

    expect(createdSubscription.watchId).toBe(watch.id);
    expect(createdSubscription.deliveryUrl).toBe(
      "https://example.com/hooks/linkedin"
    );
    expect(createdSubscription.eventTypes).toEqual([
      "linkedin.notifications.item.created",
      "linkedin.notifications.item.read_changed"
    ]);
    expect(createdSubscription.maxAttempts).toBe(4);
    expect(createdSubscription.signingSecret).toMatch(/^whsec_[a-f0-9]{32}$/u);

    const pausedWatch = service.pauseWatch(watch.id);
    expect(pausedWatch.status).toBe("paused");

    const resumedWatch = service.resumeWatch(watch.id);
    expect(resumedWatch.status).toBe("active");

    const pausedSubscription = service.pauseWebhookSubscription(
      createdSubscription.id
    );
    expect(pausedSubscription.status).toBe("paused");

    const resumedSubscription = service.resumeWebhookSubscription(
      createdSubscription.id
    );
    expect(resumedSubscription.status).toBe("active");

    expect(
      service.listWebhookSubscriptions({
        watchId: watch.id
      })
    ).toHaveLength(1);
    expect(
      service.removeWebhookSubscription(createdSubscription.id)
    ).toBe(true);
    expect(service.removeWatch(watch.id)).toBe(true);
  });

  it("rejects unsupported event types for a watch", () => {
    const service = new ActivityWatchesService(createRuntime());
    const watch = service.createWatch({
      kind: "connections"
    });

    expect(() =>
      service.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: "https://example.com/hooks/linkedin",
        eventTypes: ["linkedin.notifications.item.created"]
      })
    ).toThrow(LinkedInAssistantError);
  });
});
