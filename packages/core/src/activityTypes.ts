export const ACTIVITY_WATCH_KINDS = [
  "inbox_threads",
  "notifications",
  "pending_invitations",
  "accepted_invitations",
  "connections",
  "profile_watch",
  "feed"
] as const;

export type ActivityWatchKind = (typeof ACTIVITY_WATCH_KINDS)[number];

export const ACTIVITY_WATCH_STATUSES = [
  "active",
  "paused",
  "disabled"
] as const;

export type ActivityWatchStatus = (typeof ACTIVITY_WATCH_STATUSES)[number];

export const WEBHOOK_SUBSCRIPTION_STATUSES = [
  "active",
  "paused",
  "disabled"
] as const;

export type WebhookSubscriptionStatus =
  (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];

export const WEBHOOK_DELIVERY_ATTEMPT_STATUSES = [
  "pending",
  "delivered",
  "leased",
  "retrying",
  "failed",
  "dead_letter"
] as const;

export type WebhookDeliveryAttemptStatus =
  (typeof WEBHOOK_DELIVERY_ATTEMPT_STATUSES)[number];

export const ACTIVITY_SCHEDULE_KINDS = ["interval", "cron"] as const;

export type ActivityScheduleKind = (typeof ACTIVITY_SCHEDULE_KINDS)[number];

export const ACTIVITY_ENTITY_TYPES = [
  "thread",
  "message",
  "notification",
  "invitation",
  "connection",
  "profile",
  "post"
] as const;

export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export type ActivityEventChangeKind = "created" | "updated";

export const LINKEDIN_ACTIVITY_EVENT_TYPES = [
  "linkedin.inbox.thread.created",
  "linkedin.inbox.thread.updated",
  "linkedin.inbox.message.received",
  "linkedin.notifications.item.created",
  "linkedin.notifications.item.read_changed",
  "linkedin.connections.invitation.received",
  "linkedin.connections.invitation.sent_changed",
  "linkedin.connections.invitation.accepted",
  "linkedin.connections.connected",
  "linkedin.profile.snapshot.changed",
  "linkedin.feed.post.appeared",
  "linkedin.feed.post.engagement_changed"
] as const;

export const ACTIVITY_EVENT_TYPES = LINKEDIN_ACTIVITY_EVENT_TYPES;

export type LinkedInActivityEventType =
  (typeof LINKEDIN_ACTIVITY_EVENT_TYPES)[number];

export type ActivityEventType = LinkedInActivityEventType;

export const ACTIVITY_WATCH_EVENT_TYPES: Record<
  ActivityWatchKind,
  LinkedInActivityEventType[]
> = {
  inbox_threads: [
    "linkedin.inbox.thread.created",
    "linkedin.inbox.thread.updated",
    "linkedin.inbox.message.received"
  ],
  notifications: [
    "linkedin.notifications.item.created",
    "linkedin.notifications.item.read_changed"
  ],
  pending_invitations: [
    "linkedin.connections.invitation.received",
    "linkedin.connections.invitation.sent_changed"
  ],
  accepted_invitations: ["linkedin.connections.invitation.accepted"],
  connections: ["linkedin.connections.connected"],
  profile_watch: ["linkedin.profile.snapshot.changed"],
  feed: [
    "linkedin.feed.post.appeared",
    "linkedin.feed.post.engagement_changed"
  ]
};

export const ACTIVITY_WATCH_DEFAULT_POLL_INTERVAL_MS: Record<
  ActivityWatchKind,
  number
> = {
  inbox_threads: 5 * 60 * 1_000,
  notifications: 10 * 60 * 1_000,
  pending_invitations: 15 * 60 * 1_000,
  accepted_invitations: 30 * 60 * 1_000,
  connections: 20 * 60 * 1_000,
  profile_watch: 6 * 60 * 60 * 1_000,
  feed: 20 * 60 * 1_000
};

export const ACTIVITY_WATCH_MIN_POLL_INTERVAL_MS: Record<
  ActivityWatchKind,
  number
> = {
  inbox_threads: 2 * 60 * 1_000,
  notifications: 5 * 60 * 1_000,
  pending_invitations: 10 * 60 * 1_000,
  accepted_invitations: 15 * 60 * 1_000,
  connections: 10 * 60 * 1_000,
  profile_watch: 60 * 60 * 1_000,
  feed: 15 * 60 * 1_000
};

export const ACTIVITY_WATCH_KIND_ORDER: ActivityWatchKind[] = [
  "inbox_threads",
  "notifications",
  "pending_invitations",
  "accepted_invitations",
  "connections",
  "profile_watch",
  "feed"
];

const ACTIVITY_WATCH_KIND_SET = new Set<string>(ACTIVITY_WATCH_KINDS);
const LINKEDIN_ACTIVITY_EVENT_TYPE_SET = new Set<string>(
  LINKEDIN_ACTIVITY_EVENT_TYPES
);

export function isActivityWatchKind(value: string): value is ActivityWatchKind {
  return ACTIVITY_WATCH_KIND_SET.has(value);
}

export function isLinkedInActivityEventType(
  value: string
): value is LinkedInActivityEventType {
  return LINKEDIN_ACTIVITY_EVENT_TYPE_SET.has(value);
}

export function isActivityEventType(value: string): value is ActivityEventType {
  return isLinkedInActivityEventType(value);
}

export function getActivityWatchEventTypes(
  kind: ActivityWatchKind
): LinkedInActivityEventType[] {
  return [...ACTIVITY_WATCH_EVENT_TYPES[kind]];
}
