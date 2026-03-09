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
import { LinkedInAssistantError } from "../errors.js";
import type {
  LinkedInConnection,
  LinkedInPendingInvitation
} from "../linkedinConnections.js";
import type { LinkedInFeedPost } from "../linkedinFeed.js";
import type { LinkedInAcceptedConnection } from "../linkedinFollowups.js";
import type {
  LinkedInThreadDetail,
  LinkedInThreadMessage,
  LinkedInThreadSummary
} from "../linkedinInbox.js";
import type { LinkedInNotification } from "../linkedinNotifications.js";
import type { LinkedInProfile } from "../linkedinProfile.js";
import {
  createWebhookSignature,
  type DeliverWebhookInput
} from "../webhookDelivery.js";

const databases: AssistantDatabase[] = [];

interface RecordedRequest {
  body: string;
  headers: IncomingHttpHeaders;
}

interface MutableActivityState {
  acceptedConnections: LinkedInAcceptedConnection[];
  connections: LinkedInConnection[];
  feed: LinkedInFeedPost[];
  notifications: LinkedInNotification[];
  pendingInvitations: LinkedInPendingInvitation[];
  profile: LinkedInProfile;
  threadDetails: LinkedInThreadDetail[];
  threads: LinkedInThreadSummary[];
}

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

function createNotification(
  id: string,
  overrides: Partial<LinkedInNotification> = {}
): LinkedInNotification {
  return {
    id,
    type: "mention",
    message: `Notification ${id}`,
    timestamp: "Just now",
    link: `https://www.linkedin.com/notifications/${id}`,
    is_read: false,
    ...overrides
  };
}

function createPendingInvitation(
  slug: string,
  direction: "sent" | "received",
  overrides: Partial<LinkedInPendingInvitation> = {}
): LinkedInPendingInvitation {
  return {
    vanity_name: slug,
    full_name: `Person ${slug}`,
    headline: `Headline ${slug}`,
    profile_url: `https://www.linkedin.com/in/${slug}/`,
    sent_or_received: direction,
    ...overrides
  };
}

function createAcceptedConnection(
  slug: string,
  overrides: Partial<LinkedInAcceptedConnection> = {}
): LinkedInAcceptedConnection {
  const nowMs = Date.now();

  return {
    profile_url_key: slug,
    profile_url: `https://www.linkedin.com/in/${slug}/`,
    vanity_name: slug,
    full_name: `Accepted ${slug}`,
    headline: `Accepted headline ${slug}`,
    first_seen_sent_at_ms: nowMs - 20_000,
    last_seen_sent_at_ms: nowMs - 10_000,
    accepted_at_ms: nowMs - 5_000,
    accepted_detection: "poller",
    followup_status: "not_prepared",
    followup_prepared_action_id: null,
    followup_prepared_at_ms: null,
    followup_confirmed_at_ms: null,
    followup_expires_at_ms: null,
    ...overrides
  };
}

function createConnection(
  slug: string,
  overrides: Partial<LinkedInConnection> = {}
): LinkedInConnection {
  return {
    vanity_name: slug,
    full_name: `Connection ${slug}`,
    headline: `Connection headline ${slug}`,
    profile_url: `https://www.linkedin.com/in/${slug}/`,
    connected_since: "March 2026",
    ...overrides
  };
}

function createProfile(
  slug: string,
  overrides: Partial<LinkedInProfile> = {}
): LinkedInProfile {
  return {
    profile_url: `https://www.linkedin.com/in/${slug}/`,
    vanity_name: slug,
    full_name: `Profile ${slug}`,
    headline: `Headline ${slug}`,
    location: "Copenhagen",
    about: `About ${slug}`,
    connection_degree: "1st",
    experience: [
      {
        title: "Engineer",
        company: "Acme",
        duration: "2024 - Present",
        location: "Copenhagen",
        description: "Builds systems"
      },
      {
        title: "Advisor",
        company: "Beta",
        duration: "2022 - 2024",
        location: "Remote",
        description: "Guides teams"
      }
    ],
    education: [
      {
        school: "Technical University",
        degree: "MSc",
        field_of_study: "Computer Science",
        dates: "2018 - 2020"
      },
      {
        school: "City College",
        degree: "BSc",
        field_of_study: "Software Engineering",
        dates: "2015 - 2018"
      }
    ],
    ...overrides
  };
}

function createPost(
  id: string,
  overrides: Partial<LinkedInFeedPost> = {}
): LinkedInFeedPost {
  return {
    post_id: id,
    author_name: `Author ${id}`,
    author_headline: `Author headline ${id}`,
    author_profile_url: `https://www.linkedin.com/in/author-${id}/`,
    posted_at: "1h",
    text: `Post ${id}`,
    reactions_count: "1",
    comments_count: "1",
    reposts_count: "1",
    post_url: `https://www.linkedin.com/feed/update/${id}/`,
    ...overrides
  };
}

function createThreadSummary(
  id: string,
  overrides: Partial<LinkedInThreadSummary> = {}
): LinkedInThreadSummary {
  return {
    thread_id: id,
    title: `Thread ${id}`,
    unread_count: 0,
    snippet: `Snippet ${id}`,
    thread_url: `https://www.linkedin.com/messaging/thread/${id}/`,
    ...overrides
  };
}

function createMessage(
  author: string,
  text: string,
  sentAt: string | null = "Now"
): LinkedInThreadMessage {
  return {
    author,
    sent_at: sentAt,
    text
  };
}

function createThreadDetail(
  id: string,
  messages: LinkedInThreadMessage[],
  overrides: Partial<LinkedInThreadDetail> = {}
): LinkedInThreadDetail {
  return {
    thread_id: id,
    title: `Thread ${id}`,
    unread_count: 0,
    snippet: `Snippet ${id}`,
    thread_url: `https://www.linkedin.com/messaging/thread/${id}/`,
    messages,
    ...overrides
  };
}

function findThreadDetail(
  details: LinkedInThreadDetail[],
  thread: string
): LinkedInThreadDetail | undefined {
  return details.find(
    (detail) => detail.thread_id === thread || detail.thread_url === thread
  );
}

function createActivityServices(input: {
  activityConfigOverrides?: Partial<ActivityWebhookConfig>;
  state?: Partial<MutableActivityState>;
} = {}): {
  db: AssistantDatabase;
  logger: ActivityWatchesRuntime["logger"];
  mocks: {
    connections: {
      listConnections: ReturnType<typeof vi.fn>;
      listPendingInvitations: ReturnType<typeof vi.fn>;
    };
    feed: {
      viewFeed: ReturnType<typeof vi.fn>;
    };
    followups: {
      listAcceptedConnections: ReturnType<typeof vi.fn>;
    };
    inbox: {
      getThread: ReturnType<typeof vi.fn>;
      listThreads: ReturnType<typeof vi.fn>;
    };
    notifications: {
      listNotifications: ReturnType<typeof vi.fn>;
    };
    profile: {
      viewProfile: ReturnType<typeof vi.fn>;
    };
  };
  poller: ActivityPollerService;
  state: MutableActivityState;
  watches: ActivityWatchesService;
} {
  const db = new AssistantDatabase(":memory:");
  databases.push(db);
  const activityConfig = createActivityConfig(input.activityConfigOverrides);
  const logger = {
    log: vi.fn()
  } as ActivityWatchesRuntime["logger"];
  const watches = new ActivityWatchesService({
    db,
    logger,
    activityConfig
  });
  const state: MutableActivityState = {
    acceptedConnections: [],
    connections: [],
    feed: [],
    notifications: [],
    pendingInvitations: [],
    profile: createProfile("default"),
    threadDetails: [],
    threads: [],
    ...input.state
  };

  const connections = {
    listPendingInvitations: vi.fn(
      async (request: {
        filter?: "all" | "received" | "sent";
        profileName?: string;
      } = {}): Promise<LinkedInPendingInvitation[]> => {
        if (!request.filter || request.filter === "all") {
          return state.pendingInvitations;
        }

        return state.pendingInvitations.filter(
          (invitation) => invitation.sent_or_received === request.filter
        );
      }
    ),
    listConnections: vi.fn(
      async (): Promise<LinkedInConnection[]> => state.connections
    )
  };
  const followups = {
    listAcceptedConnections: vi.fn(
      async (): Promise<LinkedInAcceptedConnection[]> => state.acceptedConnections
    )
  };
  const feed = {
    viewFeed: vi.fn(
      async (): Promise<LinkedInFeedPost[]> => state.feed
    )
  };
  const notifications = {
    listNotifications: vi.fn(
      async (): Promise<LinkedInNotification[]> => state.notifications
    )
  };
  const profile = {
    viewProfile: vi.fn(
      async (): Promise<LinkedInProfile> => state.profile
    )
  };
  const inbox = {
    listThreads: vi.fn(
      async (): Promise<LinkedInThreadSummary[]> => state.threads
    ),
    getThread: vi.fn(
      async (request: {
        limit?: number;
        profileName?: string;
        thread: string;
      }): Promise<LinkedInThreadDetail> => {
        const detail = findThreadDetail(state.threadDetails, request.thread);
        return (
          detail ??
          createThreadDetail(request.thread, [], {
            title: "",
            snippet: "",
            thread_url: request.thread
          })
        );
      }
    )
  };

  const runtime: ActivityPollerRuntime = {
    activityConfig,
    activityWatches: watches,
    connections: connections as unknown as ActivityPollerRuntime["connections"],
    db,
    feed: feed as unknown as ActivityPollerRuntime["feed"],
    followups: followups as unknown as ActivityPollerRuntime["followups"],
    inbox: inbox as unknown as ActivityPollerRuntime["inbox"],
    logger,
    notifications: notifications as unknown as ActivityPollerRuntime["notifications"],
    profile: profile as unknown as ActivityPollerRuntime["profile"]
  };

  return {
    db,
    logger,
    mocks: {
      connections,
      feed,
      followups,
      inbox,
      notifications,
      profile
    },
    poller: new ActivityPollerService(runtime),
    state,
    watches
  };
}

async function startWebhookServer(input: {
  body?: string;
  onRequest?: (request: RecordedRequest) => void;
  statusCode?: number;
} = {}): Promise<{
  close: () => Promise<void>;
  requests: RecordedRequest[];
  url: string;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const recordedRequest = {
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers
      };
      requests.push(recordedRequest);
      input.onRequest?.(recordedRequest);
      response.writeHead(input.statusCode ?? 202, {
        "content-type": "application/json"
      });
      response.end(input.body ?? '{"accepted":true}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    requests,
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

function insertPendingDelivery(input: {
  db: AssistantDatabase;
  deliveryUrl: string;
  eventType?: DeliverWebhookInput["eventType"];
  nowMs: number;
  payloadJson?: string;
  profileName?: string;
  subscriptionId: string;
  watchId: string;
}): { deliveryId: string; eventId: string } {
  const eventId = `evt_${input.watchId}`;
  const deliveryId = `whdel_${input.subscriptionId}`;
  input.db.insertActivityEvent({
    id: eventId,
    watchId: input.watchId,
    profileName: input.profileName ?? "default",
    eventType: input.eventType ?? "linkedin.notifications.item.created",
    entityKey: `notification:${input.watchId}`,
    payloadJson: input.payloadJson ?? JSON.stringify({ id: eventId }),
    fingerprint: `fingerprint_${input.watchId}`,
    occurredAtMs: input.nowMs,
    createdAtMs: input.nowMs
  });
  input.db.insertWebhookDeliveryAttempt({
    id: deliveryId,
    watchId: input.watchId,
    profileName: input.profileName ?? "default",
    subscriptionId: input.subscriptionId,
    eventId,
    eventType: input.eventType ?? "linkedin.notifications.item.created",
    deliveryUrl: input.deliveryUrl,
    payloadJson: input.payloadJson ?? JSON.stringify({ id: eventId }),
    attemptNumber: 1,
    status: "pending",
    nextAttemptAtMs: input.nowMs,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs
  });

  return {
    deliveryId,
    eventId
  };
}

function insertRawWatch(input: {
  cronExpression?: string | null;
  db: AssistantDatabase;
  id: string;
  kind: Parameters<ActivityWatchesService["createWatch"]>[0]["kind"];
  lastSuccessAtMs?: number | null;
  nowMs?: number;
  pollIntervalMs?: number | null;
  profileName?: string;
  scheduleKind?: "cron" | "interval";
  targetJson: string;
}): void {
  const nowMs = input.nowMs ?? Date.now();

  input.db.insertActivityWatch({
    id: input.id,
    profileName: input.profileName ?? "default",
    kind: input.kind,
    targetJson: input.targetJson,
    scheduleKind: input.scheduleKind ?? "interval",
    pollIntervalMs:
      input.scheduleKind === "cron" ? null : (input.pollIntervalMs ?? 60_000),
    cronExpression:
      input.scheduleKind === "cron" ? (input.cronExpression ?? "0 9 * * 1-5") : null,
    status: "active",
    nextPollAtMs: nowMs,
    lastSuccessAtMs: input.lastSuccessAtMs ?? nowMs - 1_000,
    createdAtMs: nowMs,
    updatedAtMs: nowMs
  });
}

function insertRawSubscription(input: {
  db: AssistantDatabase;
  deliveryUrl: string;
  eventTypesJson: string;
  id: string;
  maxAttempts?: number;
  nowMs?: number;
  watchId: string;
}): void {
  const nowMs = input.nowMs ?? Date.now();

  input.db.insertWebhookSubscription({
    id: input.id,
    watchId: input.watchId,
    status: "active",
    eventTypesJson: input.eventTypesJson,
    deliveryUrl: input.deliveryUrl,
    signingSecret: `whsec_${input.id}`,
    maxAttempts: input.maxAttempts ?? 3,
    createdAtMs: nowMs,
    updatedAtMs: nowMs
  });
}

function makeWatchesDue(
  watches: ActivityWatchesService,
  watchIds: string[]
): void {
  for (const watchId of watchIds) {
    watches.resumeWatch(watchId);
  }
}

function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
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

describe("ActivityPollerService", () => {
  it("short-circuits all polling and delivery work when disabled", async () => {
    const services = createActivityServices({
      activityConfigOverrides: {
        enabled: false
      },
      state: {
        notifications: [createNotification("notif-disabled")]
      }
    });
    const watch = services.watches.createWatch({
      kind: "notifications"
    });
    const subscription = services.watches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: "https://example.com/hooks/disabled"
    });
    insertPendingDelivery({
      db: services.db,
      deliveryUrl: subscription.deliveryUrl,
      nowMs: Date.now(),
      subscriptionId: subscription.id,
      watchId: watch.id
    });

    const result = await services.poller.runTick({
      profileName: "default",
      workerId: "disabled-worker"
    });

    expect(result).toMatchObject({
      claimedWatches: 0,
      polledWatches: 0,
      failedWatches: 0,
      emittedEvents: 0,
      enqueuedDeliveries: 0,
      claimedDeliveries: 0,
      deliveredAttempts: 0,
      retriedDeliveries: 0,
      failedDeliveries: 0,
      deadLetterDeliveries: 0,
      disabledSubscriptions: 0
    });
    expect(services.mocks.notifications.listNotifications).not.toHaveBeenCalled();
  });

  it("polls every watch kind and delivers signed webhook payloads", async () => {
    const server = await startWebhookServer();

    try {
      const baselineThread = createThreadSummary("thread-1", {
        unread_count: 1,
        snippet: "Baseline thread"
      });
      const baselineThreadDetail = createThreadDetail(
        "thread-1",
        [createMessage("Alice", "Baseline message")],
        {
          unread_count: 1,
          snippet: "Baseline thread"
        }
      );
      const baselineProfile = createProfile("watched-profile");
      const services = createActivityServices({
        state: {
          acceptedConnections: [createAcceptedConnection("accepted-1")],
          connections: [createConnection("connection-1")],
          feed: [
            createPost("post-1"),
            createPost("post-ignore", {
              text: "Original text"
            })
          ],
          notifications: [
            createNotification("notif-1"),
            createNotification("notif-ignore", {
              message: "No read-state change"
            })
          ],
          pendingInvitations: [
            createPendingInvitation("sent-existing", "sent"),
            createPendingInvitation("received-existing", "received")
          ],
          profile: baselineProfile,
          threadDetails: [baselineThreadDetail],
          threads: [baselineThread]
        }
      });

      const notificationsWatch = services.watches.createWatch({
        kind: "notifications"
      });
      const pendingInvitationsWatch = services.watches.createWatch({
        kind: "pending_invitations"
      });
      const acceptedInvitationsWatch = services.watches.createWatch({
        kind: "accepted_invitations"
      });
      const connectionsWatch = services.watches.createWatch({
        kind: "connections"
      });
      const profileWatch = services.watches.createWatch({
        kind: "profile_watch",
        target: {
          target: baselineProfile.profile_url
        }
      });
      const feedWatch = services.watches.createWatch({
        kind: "feed"
      });
      const inboxWatch = services.watches.createWatch({
        kind: "inbox_threads"
      });

      const notificationsSubscription = services.watches.createWebhookSubscription({
        watchId: notificationsWatch.id,
        deliveryUrl: server.url
      });
      const notificationsReadSubscription =
        services.watches.createWebhookSubscription({
          watchId: notificationsWatch.id,
          deliveryUrl: server.url,
          eventTypes: ["linkedin.notifications.item.read_changed"]
        });
      const pendingSubscription = services.watches.createWebhookSubscription({
        watchId: pendingInvitationsWatch.id,
        deliveryUrl: server.url
      });
      const acceptedSubscription = services.watches.createWebhookSubscription({
        watchId: acceptedInvitationsWatch.id,
        deliveryUrl: server.url
      });
      const connectionsSubscription = services.watches.createWebhookSubscription({
        watchId: connectionsWatch.id,
        deliveryUrl: server.url
      });
      const profileSubscription = services.watches.createWebhookSubscription({
        watchId: profileWatch.id,
        deliveryUrl: server.url
      });
      const feedSubscription = services.watches.createWebhookSubscription({
        watchId: feedWatch.id,
        deliveryUrl: server.url
      });
      const inboxSubscription = services.watches.createWebhookSubscription({
        watchId: inboxWatch.id,
        deliveryUrl: server.url
      });

      const subscriptions = [
        notificationsSubscription,
        notificationsReadSubscription,
        pendingSubscription,
        acceptedSubscription,
        connectionsSubscription,
        profileSubscription,
        feedSubscription,
        inboxSubscription
      ];
      const watchIds = [
        notificationsWatch.id,
        pendingInvitationsWatch.id,
        acceptedInvitationsWatch.id,
        connectionsWatch.id,
        profileWatch.id,
        feedWatch.id,
        inboxWatch.id
      ];

      const baseline = await services.poller.runTick({
        profileName: "default",
        workerId: "all-kinds-worker"
      });
      expect(baseline.emittedEvents).toBe(0);
      expect(baseline.deliveredAttempts).toBe(0);
      expect(services.mocks.inbox.getThread).toHaveBeenCalledTimes(1);

      services.state.notifications = [
        createNotification("notif-1", {
          is_read: true
        }),
        createNotification("notif-ignore", {
          message: "Changed copy only"
        }),
        createNotification("notif-2")
      ];
      services.state.pendingInvitations = [
        createPendingInvitation("sent-existing", "sent", {
          headline: "Updated sent headline"
        }),
        createPendingInvitation("received-existing", "received", {
          headline: "Updated received headline"
        }),
        createPendingInvitation("received-new", "received")
      ];
      services.state.acceptedConnections = [
        createAcceptedConnection("accepted-1"),
        createAcceptedConnection("accepted-2")
      ];
      services.state.connections = [
        createConnection("connection-1"),
        createConnection("connection-2")
      ];
      services.state.profile = createProfile("watched-profile", {
        headline: "Updated watched headline"
      });
      services.state.feed = [
        createPost("post-1", {
          reactions_count: "2"
        }),
        createPost("post-ignore", {
          text: "Changed text only"
        }),
        createPost("post-2")
      ];
      services.state.threads = [
        createThreadSummary("thread-1", {
          unread_count: 2,
          snippet: "Updated thread summary"
        }),
        createThreadSummary("thread-2", {
          unread_count: 1,
          snippet: "New thread"
        })
      ];
      services.state.threadDetails = [
        createThreadDetail(
          "thread-1",
          [
            createMessage("Alice", "Baseline message"),
            createMessage("Alice", "New follow-up")
          ],
          {
            unread_count: 2,
            snippet: "Updated thread summary"
          }
        ),
        createThreadDetail(
          "thread-2",
          [createMessage("Bob", "Hello there")],
          {
            unread_count: 1,
            snippet: "New thread"
          }
        )
      ];

      makeWatchesDue(services.watches, watchIds);

      const changed = await services.poller.runTick({
        profileName: "default",
        workerId: "all-kinds-worker"
      });
      expect(changed.emittedEvents).toBe(13);
      expect(changed.enqueuedDeliveries).toBe(14);
      expect(services.mocks.inbox.getThread).toHaveBeenCalledTimes(3);
      expect(services.mocks.connections.listPendingInvitations).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter: "all"
        })
      );
      expect(services.mocks.profile.viewProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: baselineProfile.profile_url
        })
      );

      const events = services.watches.listEvents({
        limit: 20
      });
      const eventTypes = events.map((event) => event.eventType);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "linkedin.notifications.item.created",
          "linkedin.notifications.item.read_changed",
          "linkedin.connections.invitation.received",
          "linkedin.connections.invitation.sent_changed",
          "linkedin.connections.invitation.accepted",
          "linkedin.connections.connected",
          "linkedin.profile.snapshot.changed",
          "linkedin.feed.post.appeared",
          "linkedin.feed.post.engagement_changed",
          "linkedin.inbox.thread.created",
          "linkedin.inbox.thread.updated",
          "linkedin.inbox.message.received"
        ])
      );
      expect(
        eventTypes.filter(
          (eventType) => eventType === "linkedin.inbox.message.received"
        )
      ).toHaveLength(2);

      expect(
        services.watches.listDeliveries({
          subscriptionId: notificationsReadSubscription.id
        })
      ).toHaveLength(1);
      expect(
        services
          .watches.listDeliveries({
            subscriptionId: notificationsReadSubscription.id
          })
          .map((delivery) => delivery.eventType)
      ).toEqual(["linkedin.notifications.item.read_changed"]);

      const deliverySecrets = new Map<string, string>();
      const subscriptionSecrets = new Map(
        subscriptions.map((subscription) => [subscription.id, subscription.signingSecret])
      );
      for (const delivery of services.watches.listDeliveries({ limit: 20 })) {
        const secret = subscriptionSecrets.get(delivery.subscriptionId);
        if (secret) {
          deliverySecrets.set(delivery.id, secret);
        }
      }

      const delivered = await services.poller.runTick({
        profileName: "default",
        workerId: "all-kinds-worker"
      });
      expect(changed.deliveredAttempts + delivered.deliveredAttempts).toBe(14);
      expect(server.requests).toHaveLength(14);

      const requestTypes = server.requests.map((request) => {
        const payload = JSON.parse(request.body) as { type: string };
        return payload.type;
      });
      expect(new Set(requestTypes)).toEqual(
        new Set([
          "linkedin.notifications.item.created",
          "linkedin.notifications.item.read_changed",
          "linkedin.connections.invitation.received",
          "linkedin.connections.invitation.sent_changed",
          "linkedin.connections.invitation.accepted",
          "linkedin.connections.connected",
          "linkedin.profile.snapshot.changed",
          "linkedin.feed.post.appeared",
          "linkedin.feed.post.engagement_changed",
          "linkedin.inbox.thread.created",
          "linkedin.inbox.thread.updated",
          "linkedin.inbox.message.received"
        ])
      );

      for (const request of server.requests) {
        const deliveryId = readHeader(
          request.headers,
          "x-linkedin-assistant-delivery"
        );
        const timestamp = readHeader(
          request.headers,
          "x-linkedin-assistant-timestamp"
        );
        const signature = readHeader(
          request.headers,
          "x-linkedin-assistant-signature-256"
        );
        const secret = deliverySecrets.get(deliveryId);

        expect(secret).toBeTruthy();
        expect(readHeader(request.headers, "x-linkedin-assistant-retry-count")).toBe(
          "0"
        );
        expect(signature).toBe(
          `sha256=${createWebhookSignature(secret ?? "", timestamp, request.body)}`
        );
      }

      const deliveredAttempts = services.watches.listDeliveries({
        status: "delivered",
        limit: 20
      });
      expect(deliveredAttempts).toHaveLength(14);
    } finally {
      await server.close();
    }
  });

  it("retries rate-limited deliveries and dead-letters the final attempt", async () => {
    const server = await startWebhookServer({
      body: "slow down",
      statusCode: 429
    });

    try {
      const services = createActivityServices({
        activityConfigOverrides: {
          retry: {
            initialBackoffMs: 0,
            maxBackoffMs: 0
          }
        }
      });
      const watch = services.watches.createWatch({
        kind: "notifications"
      });
      const subscription = services.watches.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: server.url,
        maxAttempts: 2
      });

      insertPendingDelivery({
        db: services.db,
        deliveryUrl: subscription.deliveryUrl,
        nowMs: Date.now(),
        subscriptionId: subscription.id,
        watchId: watch.id
      });

      const firstAttempt = await services.poller.runTick({
        workerId: "retry-worker"
      });
      expect(firstAttempt.retriedDeliveries).toBe(1);
      expect(firstAttempt.deliveryResults[0]).toMatchObject({
        outcome: "retry",
        errorCode: "RATE_LIMITED",
        responseStatus: 429
      });

      const attemptsAfterRetry = services.watches.listDeliveries({
        subscriptionId: subscription.id,
        limit: 10
      });
      expect(attemptsAfterRetry).toHaveLength(2);
      expect(attemptsAfterRetry.map((attempt) => attempt.status).sort()).toEqual([
        "pending",
        "retrying"
      ]);
      expect(attemptsAfterRetry.map((attempt) => attempt.attemptNumber).sort()).toEqual([
        1,
        2
      ]);
      expect(
        services.watches.getWebhookSubscriptionById(subscription.id)
      ).toMatchObject({
        lastErrorCode: "RATE_LIMITED",
        status: "active"
      });

      const finalAttempt = await services.poller.runTick({
        workerId: "retry-worker"
      });
      expect(finalAttempt.deadLetterDeliveries).toBe(1);
      expect(finalAttempt.deliveryResults[0]).toMatchObject({
        outcome: "dead_letter",
        errorCode: "RATE_LIMITED",
        responseStatus: 429
      });
      expect(server.requests).toHaveLength(2);
      expect(
        readHeader(
          server.requests[1]?.headers ?? {},
          "x-linkedin-assistant-retry-count"
        )
      ).toBe("1");
      expect(
        services.watches
          .listDeliveries({
            subscriptionId: subscription.id,
            limit: 10
          })
          .map((attempt) => attempt.status)
          .sort()
      ).toEqual(["dead_letter", "retrying"]);
    } finally {
      await server.close();
    }
  });

  it("classifies network failures as retryable deliveries", async () => {
    const unavailableServer = await startWebhookServer();
    const unavailableUrl = unavailableServer.url;
    await unavailableServer.close();

    const services = createActivityServices({
      activityConfigOverrides: {
        retry: {
          initialBackoffMs: 0,
          maxBackoffMs: 0
        }
      }
    });
    const watch = services.watches.createWatch({
      kind: "notifications"
    });
    const subscription = services.watches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: unavailableUrl,
      maxAttempts: 2
    });

    insertPendingDelivery({
      db: services.db,
      deliveryUrl: subscription.deliveryUrl,
      nowMs: Date.now(),
      subscriptionId: subscription.id,
      watchId: watch.id
    });

    const result = await services.poller.runTick({
      workerId: "network-worker"
    });
    expect(result.retriedDeliveries).toBe(1);
    expect(result.deliveryResults[0]).toMatchObject({
      outcome: "retry",
      errorCode: "NETWORK_ERROR"
    });
    expect(
      services.watches
        .listDeliveries({
          subscriptionId: subscription.id,
          limit: 10
        })
        .map((attempt) => attempt.status)
        .sort()
    ).toEqual(["pending", "retrying"]);
  });

  it("disables subscriptions after terminal 410 responses", async () => {
    const server = await startWebhookServer({
      body: "gone",
      statusCode: 410
    });

    try {
      const services = createActivityServices();
      const watch = services.watches.createWatch({
        kind: "notifications"
      });
      const subscription = services.watches.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: server.url
      });

      insertPendingDelivery({
        db: services.db,
        deliveryUrl: subscription.deliveryUrl,
        nowMs: Date.now(),
        subscriptionId: subscription.id,
        watchId: watch.id
      });

      const result = await services.poller.runTick({
        workerId: "disable-worker"
      });
      expect(result.failedDeliveries).toBe(1);
      expect(result.disabledSubscriptions).toBe(1);
      expect(result.deliveryResults[0]).toMatchObject({
        outcome: "failed",
        errorCode: "ACTION_PRECONDITION_FAILED",
        responseStatus: 410
      });
      expect(result.deliveryResults[0]?.errorMessage).toContain(
        "Subscription disabled."
      );
      expect(services.watches.getWebhookSubscriptionById(subscription.id).status).toBe(
        "disabled"
      );
      expect(
        services
          .watches.listDeliveries({
            subscriptionId: subscription.id,
            limit: 10
          })
          .map((delivery) => delivery.status)
      ).toEqual(["failed"]);
    } finally {
      await server.close();
    }
  });

  it("skips deliveries for inactive subscriptions without sending requests", async () => {
    const server = await startWebhookServer();

    try {
      const services = createActivityServices();
      const watch = services.watches.createWatch({
        kind: "notifications"
      });
      const subscription = services.watches.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: server.url
      });

      insertPendingDelivery({
        db: services.db,
        deliveryUrl: subscription.deliveryUrl,
        nowMs: Date.now(),
        subscriptionId: subscription.id,
        watchId: watch.id
      });
      services.watches.pauseWebhookSubscription(subscription.id);

      const result = await services.poller.runTick({
        workerId: "inactive-sub-worker"
      });
      expect(result.failedDeliveries).toBe(1);
      expect(result.deliveryResults[0]).toMatchObject({
        outcome: "skipped",
        errorCode: "ACTION_PRECONDITION_FAILED"
      });
      expect(server.requests).toHaveLength(0);
      expect(
        services.watches.listDeliveries({
          subscriptionId: subscription.id,
          limit: 10
        })[0]
      ).toMatchObject({
        status: "failed",
        lastErrorCode: "ACTION_PRECONDITION_FAILED"
      });
    } finally {
      await server.close();
    }
  });

  it("records watch polling failures with structured error metadata", async () => {
    const services = createActivityServices();
    const watch = services.watches.createWatch({
      kind: "notifications"
    });

    services.mocks.notifications.listNotifications.mockRejectedValueOnce(
      new LinkedInAssistantError("RATE_LIMITED", "Too many requests")
    );

    const result = await services.poller.runTick({
      workerId: "failure-worker"
    });
    expect(result.failedWatches).toBe(1);
    expect(result.watchResults[0]).toMatchObject({
      watchId: watch.id,
      errorCode: "RATE_LIMITED",
      errorMessage: "Too many requests"
    });

    expect(services.watches.getWatchById(watch.id)).toMatchObject({
      consecutiveFailures: 1,
      lastErrorCode: "RATE_LIMITED",
      lastErrorMessage: "Too many requests"
    });
  });

  it("deduplicates duplicate entities returned in the same poll", async () => {
    const server = await startWebhookServer();

    try {
      const services = createActivityServices();
      const watch = services.watches.createWatch({
        kind: "notifications"
      });
      services.watches.createWebhookSubscription({
        watchId: watch.id,
        deliveryUrl: server.url
      });

      await services.poller.runTick({
        workerId: "duplicate-worker"
      });
      services.state.notifications = [
        createNotification("notif-duplicate"),
        createNotification("notif-duplicate")
      ];
      makeWatchesDue(services.watches, [watch.id]);

      const changed = await services.poller.runTick({
        workerId: "duplicate-worker"
      });
      expect(changed.emittedEvents).toBe(1);
      expect(changed.enqueuedDeliveries).toBe(1);

      const delivered = await services.poller.runTick({
        workerId: "duplicate-worker"
      });
      expect(changed.deliveredAttempts + delivered.deliveredAttempts).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(
        services.watches.listEvents({
          watchId: watch.id,
          limit: 10
        })
      ).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("handles malformed stored targets and subscription event filters defensively", async () => {
    const server = await startWebhookServer({
      body: ""
    });

    try {
      const services = createActivityServices();
      const nowMs = Date.now();

      insertRawWatch({
        db: services.db,
        id: "watch_target_array",
        kind: "notifications",
        nowMs,
        targetJson: "[]"
      });
      insertRawWatch({
        db: services.db,
        id: "watch_target_invalid",
        kind: "notifications",
        nowMs,
        targetJson: "not-json"
      });
      insertRawSubscription({
        db: services.db,
        deliveryUrl: server.url,
        eventTypesJson: '["linkedin.notifications.item.created",42]',
        id: "whsub_filtered",
        nowMs,
        watchId: "watch_target_array"
      });
      insertRawSubscription({
        db: services.db,
        deliveryUrl: server.url,
        eventTypesJson: "not-json",
        id: "whsub_invalid_json",
        nowMs,
        watchId: "watch_target_invalid"
      });
      services.state.notifications = [
        createNotification("notif-defensive", {
          link: 42 as unknown as string
        })
      ];

      const firstTick = await services.poller.runTick();
      const secondTick = await services.poller.runTick();

      expect(firstTick.profileName).toBe("default");
      expect(firstTick.workerId).toBe(`activity-poller:${process.pid}`);
      expect(firstTick.emittedEvents).toBe(2);
      expect(firstTick.enqueuedDeliveries + secondTick.deliveredAttempts).toBe(1);
      expect(server.requests).toHaveLength(1);

      const events = services.watches.listEvents({ limit: 10 });
      expect(events).toHaveLength(2);
      for (const event of events) {
        const payload = event.payload as {
          entity?: { url?: string };
        };
        expect(payload.entity?.url).toBeUndefined();
      }

      expect(
        services
          .watches.listDeliveries({
            status: "delivered",
            limit: 10
          })[0]?.responseBodyExcerpt
      ).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("uses fallback config and cron scheduling when runtime config is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 8, 59, 30, 0));

    const db = new AssistantDatabase(":memory:");
    databases.push(db);
    const logger = {
      log: vi.fn()
    } as ActivityWatchesRuntime["logger"];
    const watches = new ActivityWatchesService({
      db,
      logger
    });
    const notifications = {
      listNotifications: vi.fn(async (): Promise<LinkedInNotification[]> => [])
    };
    const poller = new ActivityPollerService({
      activityWatches: watches,
      connections: {
        listConnections: vi.fn(async (): Promise<LinkedInConnection[]> => []),
        listPendingInvitations: vi.fn(
          async (): Promise<LinkedInPendingInvitation[]> => []
        )
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
        getThread: vi.fn(async (): Promise<LinkedInThreadDetail> =>
          createThreadDetail("thread", [])
        ),
        listThreads: vi.fn(async (): Promise<LinkedInThreadSummary[]> => [])
      } as unknown as ActivityPollerRuntime["inbox"],
      logger,
      notifications: notifications as unknown as ActivityPollerRuntime["notifications"],
      profile: {
        viewProfile: vi.fn(async (): Promise<LinkedInProfile> =>
          createProfile("default")
        )
      } as unknown as ActivityPollerRuntime["profile"]
    });

    insertRawWatch({
      db,
      id: "watch_cron",
      kind: "notifications",
      nowMs: Date.now(),
      scheduleKind: "cron",
      targetJson: "{}"
    });

    const result = await poller.runTick();

    expect(result.profileName).toBe("default");
    expect(result.workerId).toBe(`activity-poller:${process.pid}`);
    expect(notifications.listNotifications).toHaveBeenCalledTimes(1);
    expect(db.getActivityWatchById("watch_cron")?.next_poll_at).toBe(
      new Date(2026, 2, 9, 9, 0, 0, 0).getTime()
    );
  });

  it("uses sent invitation filters and preserves invalid profile urls as entity keys", async () => {
    const services = createActivityServices();
    const nowMs = Date.now();

    insertRawWatch({
      db: services.db,
      id: "watch_sent",
      kind: "pending_invitations",
      nowMs,
      targetJson: JSON.stringify({
        direction: "sent"
      })
    });
    services.state.pendingInvitations = [
      createPendingInvitation("sent-new", "sent", {
        profile_url: "https://example.com/not-linkedin"
      })
    ];

    const result = await services.poller.runTick({
      workerId: "sent-filter-worker"
    });

    expect(result.emittedEvents).toBe(1);
    expect(services.mocks.connections.listPendingInvitations).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: "sent"
      })
    );

    const event = services.watches.listEvents({ limit: 10 })[0];
    expect(event).toMatchObject({
      entityKey: "invitation:sent:https://example.com/not-linkedin",
      eventType: "linkedin.connections.invitation.sent_changed"
    });
  });

  it("falls back to thread ids and post urls for raw watches", async () => {
    const services = createActivityServices({
      state: {
        feed: [
          createPost("", {
            post_url: "https://www.linkedin.com/feed/update/post-fallback/"
          })
        ],
        profile: createProfile("no-target-profile"),
        threadDetails: [
          createThreadDetail("thread-no-url", [createMessage("Pat", "Hi")], {
            thread_url: ""
          })
        ],
        threads: [
          createThreadSummary("thread-no-url", {
            thread_url: ""
          })
        ]
      }
    });
    const nowMs = Date.now();

    insertRawWatch({
      db: services.db,
      id: "watch_profile_no_target",
      kind: "profile_watch",
      nowMs,
      targetJson: "{}"
    });
    insertRawWatch({
      db: services.db,
      id: "watch_inbox_no_url",
      kind: "inbox_threads",
      nowMs,
      targetJson: "{}"
    });
    insertRawWatch({
      db: services.db,
      id: "watch_feed_post_url",
      kind: "feed",
      nowMs,
      targetJson: "{}"
    });

    const result = await services.poller.runTick({
      workerId: "fallback-worker"
    });

    expect(result.emittedEvents).toBe(3);
    expect(services.mocks.profile.viewProfile).toHaveBeenCalledWith({
      profileName: "default"
    });
    expect(services.mocks.inbox.getThread).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: "thread-no-url"
      })
    );

    expect(
      services.watches
        .listEvents({ limit: 10 })
        .map((event) => ({
          entityKey: event.entityKey,
          eventType: event.eventType
        }))
    ).toEqual(
      expect.arrayContaining([
        {
          entityKey: "post:https://www.linkedin.com/feed/update/post-fallback/",
          eventType: "linkedin.feed.post.appeared"
        },
        {
          entityKey: "thread:thread-no-url",
          eventType: "linkedin.inbox.thread.created"
        },
        {
          entityKey: expect.stringContaining("message:thread-no-url:"),
          eventType: "linkedin.inbox.message.received"
        }
      ])
    );
  });

  it("records terminal network failures without response metadata", async () => {
    const unavailableServer = await startWebhookServer();
    const unavailableUrl = unavailableServer.url;
    await unavailableServer.close();

    const services = createActivityServices({
      activityConfigOverrides: {
        retry: {
          initialBackoffMs: 0,
          maxBackoffMs: 0
        }
      }
    });
    const watch = services.watches.createWatch({
      kind: "notifications"
    });
    const subscription = services.watches.createWebhookSubscription({
      watchId: watch.id,
      deliveryUrl: unavailableUrl,
      maxAttempts: 1
    });

    insertPendingDelivery({
      db: services.db,
      deliveryUrl: subscription.deliveryUrl,
      nowMs: Date.now(),
      subscriptionId: subscription.id,
      watchId: watch.id
    });

    const result = await services.poller.runTick({
      workerId: "network-dead-worker"
    });

    expect(result.deadLetterDeliveries).toBe(1);
    expect(result.deliveryResults[0]).toMatchObject({
      outcome: "dead_letter",
      errorCode: "NETWORK_ERROR",
      responseStatus: null
    });
    expect(
      services.watches.listDeliveries({
        subscriptionId: subscription.id,
        limit: 10
      })[0]
    ).toMatchObject({
      responseBodyExcerpt: null,
      responseStatus: null,
      status: "dead_letter"
    });
  });

  it("ignores profile reordering when the canonical snapshot is unchanged", async () => {
    const baselineProfile = createProfile("stable-profile", {
      experience: [
        {
          title: "First role",
          company: "Acme",
          duration: "2024 - Present",
          location: "Copenhagen",
          description: "Builds"
        },
        {
          title: "Second role",
          company: "Beta",
          duration: "2021 - 2024",
          location: "Remote",
          description: "Guides"
        }
      ],
      education: [
        {
          school: "First School",
          degree: "MSc",
          field_of_study: "Computer Science",
          dates: "2018 - 2020"
        },
        {
          school: "Second School",
          degree: "BSc",
          field_of_study: "Software Engineering",
          dates: "2015 - 2018"
        }
      ]
    });
    const services = createActivityServices({
      state: {
        profile: baselineProfile
      }
    });
    const watch = services.watches.createWatch({
      kind: "profile_watch",
      target: {
        target: baselineProfile.profile_url
      }
    });

    await services.poller.runTick({
      workerId: "profile-order-worker"
    });
    services.state.profile = createProfile("stable-profile", {
      experience: [...baselineProfile.experience].reverse(),
      education: [...baselineProfile.education].reverse()
    });
    makeWatchesDue(services.watches, [watch.id]);

    const result = await services.poller.runTick({
      workerId: "profile-order-worker"
    });
    expect(result.emittedEvents).toBe(0);
    expect(
      services.watches.listEvents({
        watchId: watch.id,
        limit: 10
      })
    ).toHaveLength(0);
  });
});
