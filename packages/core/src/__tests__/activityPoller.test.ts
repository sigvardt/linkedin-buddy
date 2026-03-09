import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityPollerService,
  type ActivityPollerRuntime
} from "../activityPoller.js";
import {
  ActivityWatchesService,
  type ActivityWatchesRuntime
} from "../activityWatches.js";
import type { ActivityWebhookConfig } from "../config.js";
import { AssistantDatabase } from "../db/database.js";
import type { LinkedInPendingInvitation } from "../linkedinConnections.js";
import type { LinkedInFeedPost } from "../linkedinFeed.js";
import type { LinkedInAcceptedConnection } from "../linkedinFollowups.js";
import type {
  LinkedInThreadDetail,
  LinkedInThreadSummary
} from "../linkedinInbox.js";
import type { LinkedInNotification } from "../linkedinNotifications.js";
import type { LinkedInProfile } from "../linkedinProfile.js";
import { createWebhookSignature } from "../webhookDelivery.js";

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

function createActivityServices(input: {
  notifications: { current: LinkedInNotification[] };
}): {
  db: AssistantDatabase;
  poller: ActivityPollerService;
  watches: ActivityWatchesService;
} {
  const db = new AssistantDatabase(":memory:");
  databases.push(db);
  const activityConfig = createActivityConfig();
  const logger = {
    log: vi.fn()
  } as ActivityWatchesRuntime["logger"];
  const watches = new ActivityWatchesService({
    db,
    logger,
    activityConfig
  });
  const defaultProfile: LinkedInProfile = {
    profile_url: "https://www.linkedin.com/in/default/",
    vanity_name: "default",
    full_name: "Default Person",
    headline: "Testing",
    location: "Copenhagen",
    about: "",
    connection_degree: "1st",
    experience: [],
    education: []
  };
  const runtime: ActivityPollerRuntime = {
    activityConfig,
    activityWatches: watches,
    connections: {
      listPendingInvitations: vi.fn(
        async (): Promise<LinkedInPendingInvitation[]> => []
      ),
      listConnections: vi.fn(async (): Promise<unknown[]> => [])
    } as unknown as ActivityPollerRuntime["connections"],
    db,
    feed: {
      viewFeed: vi.fn(async (): Promise<LinkedInFeedPost[]> => [])
    } as unknown as ActivityPollerRuntime["feed"],
    followups: {
      listAcceptedConnections: vi.fn(
        async (): Promise<LinkedInAcceptedConnection[]> => []
      )
    } as unknown as ActivityPollerRuntime["followups"],
    inbox: {
      listThreads: vi.fn(async (): Promise<LinkedInThreadSummary[]> => []),
      getThread: vi.fn(
        async (): Promise<LinkedInThreadDetail> => ({
          thread_id: "thread-1",
          title: "",
          unread_count: 0,
          snippet: "",
          thread_url: "",
          messages: []
        })
      )
    } as unknown as ActivityPollerRuntime["inbox"],
    logger,
    notifications: {
      listNotifications: vi.fn(
        async (): Promise<LinkedInNotification[]> => input.notifications.current
      )
    } as unknown as ActivityPollerRuntime["notifications"],
    profile: {
      viewProfile: vi.fn(async (): Promise<LinkedInProfile> => defaultProfile)
    } as unknown as ActivityPollerRuntime["profile"]
  };

  return {
    db,
    poller: new ActivityPollerService(runtime),
    watches
  };
}

async function startWebhookServer(input: {
  onRequest: (request: {
    body: string;
    headers: IncomingHttpHeaders;
  }) => void;
}): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      input.onRequest({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/webhooks/linkedin`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();

  while (databases.length > 0) {
    const db = databases.pop();
    db?.close();
  }
});

describe("ActivityPollerService", () => {
  it("creates events, signs webhook payloads, and avoids duplicates", async () => {
    const notifications = {
      current: [] as LinkedInNotification[]
    };
    const requests: Array<{
      body: string;
      headers: IncomingHttpHeaders;
    }> = [];
    const server = await startWebhookServer({
      onRequest: (request) => {
        requests.push(request);
      }
    });

    try {
      const services = createActivityServices({ notifications });
      const watch = services.watches.createWatch({
        profileName: "default",
        kind: "notifications"
      });
      const subscription = services.watches.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: server.url
      });

      const baseline = await services.poller.runTick({
        profileName: "default",
        workerId: "test-worker"
      });
      expect(baseline.emittedEvents).toBe(0);
      expect(baseline.deliveredAttempts).toBe(0);

      notifications.current = [
        {
          id: "notif-1",
          type: "connection_request",
          message: "Jane Doe viewed your profile",
          timestamp: "Just now",
          link: "https://www.linkedin.com/notifications/1",
          is_read: false
        }
      ];
      services.watches.resumeWatch(watch.id);

      const changed = await services.poller.runTick({
        profileName: "default",
        workerId: "test-worker"
      });
      expect(changed.emittedEvents).toBe(1);
      expect(changed.enqueuedDeliveries).toBe(1);
      expect(changed.deliveredAttempts).toBe(0);
      expect(requests).toHaveLength(0);

      const delivered = await services.poller.runTick({
        profileName: "default",
        workerId: "test-worker"
      });
      expect(delivered.emittedEvents).toBe(0);
      expect(delivered.deliveredAttempts).toBe(1);
      expect(requests).toHaveLength(1);

      const [request] = requests;
      const timestampHeader = request?.headers["x-linkedin-assistant-timestamp"];
      const signatureHeader = request?.headers["x-linkedin-assistant-signature-256"];
      expect(typeof timestampHeader).toBe("string");
      expect(signatureHeader).toBe(
        `sha256=${createWebhookSignature(
          subscription.signingSecret,
          timestampHeader as string,
          request?.body ?? ""
        )}`
      );

      const payload = JSON.parse(request?.body ?? "{}") as {
        type?: string;
        entity?: { key?: string };
      };
      expect(payload.type).toBe("linkedin.notifications.item.created");
      expect(payload.entity?.key).toBe("notification:notif-1");

      const events = services.watches.listEvents({
        watchId: watch.id
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("linkedin.notifications.item.created");

      const deliveries = services.watches.listDeliveries({
        watchId: watch.id
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.status).toBe("delivered");

      services.watches.resumeWatch(watch.id);

      const unchanged = await services.poller.runTick({
        profileName: "default",
        workerId: "test-worker"
      });
      expect(unchanged.emittedEvents).toBe(0);
      expect(unchanged.deliveredAttempts).toBe(0);
      expect(requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
