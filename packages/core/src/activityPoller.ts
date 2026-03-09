import { randomBytes } from "node:crypto";
import type { ActivityWatchesService } from "./activityWatches.js";
import {
  getNextCronOccurrenceMs
} from "./activityWatches.js";
import {
  diffActivityEntities,
  hashStableValue,
  stableStringify,
  type ActivityEntityRecord
} from "./activityDiff.js";
import type {
  ActivityEntityStateRow,
  ActivityWatchRow,
  AssistantDatabase,
  WebhookDeliveryAttemptRow,
  WebhookSubscriptionRow
} from "./db/database.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError,
  type LinkedInAssistantErrorCode
} from "./errors.js";
import type { LinkedInConnectionsService } from "./linkedinConnections.js";
import type { LinkedInFeedService, LinkedInFeedPost } from "./linkedinFeed.js";
import type {
  LinkedInAcceptedConnection,
  LinkedInFollowupsService
} from "./linkedinFollowups.js";
import type { LinkedInInboxService, LinkedInThreadDetail, LinkedInThreadSummary } from "./linkedinInbox.js";
import type { LinkedInNotificationsService } from "./linkedinNotifications.js";
import { normalizeLinkedInProfileUrl } from "./linkedinProfile.js";
import type { LinkedInProfile, LinkedInProfileService } from "./linkedinProfile.js";
import type { JsonEventLogger } from "./logging.js";
import type { ActivityWebhookConfig } from "./config.js";
import { resolveActivityWebhookConfig } from "./config.js";
import {
  type ActivityEntityType,
  type ActivityEventChangeKind,
  type ActivityEventType,
  type ActivityWatchKind
} from "./activityTypes.js";
import {
  calculateWebhookDeliveryBackoffMs,
  deliverWebhook
} from "./webhookDelivery.js";

const ACTIVITY_EVENT_VERSION = "2026-03-activity-v1";

export interface ActivityPollerRuntime {
  activityConfig?: ActivityWebhookConfig;
  activityWatches: ActivityWatchesService;
  connections: LinkedInConnectionsService;
  db: AssistantDatabase;
  feed: LinkedInFeedService;
  followups: LinkedInFollowupsService;
  inbox: LinkedInInboxService;
  logger: JsonEventLogger;
  notifications: LinkedInNotificationsService;
  profile: LinkedInProfileService;
}

export interface ActivityWatchTickResult {
  watchId: string;
  kind: ActivityWatchKind;
  emittedEvents: number;
  enqueuedDeliveries: number;
  errorCode?: string | null;
  errorMessage?: string;
}

export interface ActivityDeliveryTickResult {
  deliveryId: string;
  subscriptionId: string;
  outcome: "delivered" | "retry" | "failed" | "dead_letter" | "skipped";
  responseStatus?: number | null;
  errorCode?: string | null;
  errorMessage?: string;
}

export interface ActivityPollTickResult {
  profileName: string;
  workerId: string;
  claimedWatches: number;
  polledWatches: number;
  failedWatches: number;
  emittedEvents: number;
  enqueuedDeliveries: number;
  claimedDeliveries: number;
  deliveredAttempts: number;
  retriedDeliveries: number;
  failedDeliveries: number;
  deadLetterDeliveries: number;
  disabledSubscriptions: number;
  watchResults: ActivityWatchTickResult[];
  deliveryResults: ActivityDeliveryTickResult[];
}

interface EventEmissionResult {
  enqueuedDeliveries: number;
  eventId: string | null;
  inserted: boolean;
}

interface ProcessedDeliveryResult {
  result: ActivityDeliveryTickResult;
  subscriptionDisabled: boolean;
}

interface PendingEventReference {
  eventId: string | null;
}

interface PendingEventEmission {
  watch: ActivityWatchRow;
  eventType: ActivityEventType;
  entity: ActivityEntityRecord;
  previous: Record<string, unknown> | null;
  changeKind: ActivityEventChangeKind;
  occurredAtMs: number;
  reference: PendingEventReference;
}

interface PendingEntityStateMutation {
  watchId: string;
  entity: ActivityEntityRecord;
  firstSeenAtMs: number;
  pollStartedAtMs: number;
  eventReference?: PendingEventReference;
}

interface DeliveryQueueBudget {
  deferredDeliveries: number;
  remainingSlots: number;
}

const ACTIVE_ACTIVITY_TICKS = new Set<string>();

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function createActivityTickKey(profileName: string): string {
  return profileName.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return {};
  }
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWatchError(error: unknown): {
  code: LinkedInAssistantErrorCode | null;
  message: string;
} {
  const normalized = asLinkedInAssistantError(error);
  return {
    code: normalized.code,
    message: normalized.message
  };
}

function buildEventFingerprint(input: {
  watchId: string;
  eventType: ActivityEventType;
  entityKey: string;
  changeKind: ActivityEventChangeKind;
  current: Record<string, unknown>;
  previous: Record<string, unknown> | null;
}): string {
  return hashStableValue({
    watch_id: input.watchId,
    event_type: input.eventType,
    entity_key: input.entityKey,
    change_kind: input.changeKind,
    current: input.current,
    previous: input.previous
  });
}

function nextPollAtMsForWatch(
  watch: ActivityWatchRow,
  nowMs: number,
  minPollIntervalMs: number
): number {
  if (watch.schedule_kind === "cron" && watch.cron_expression) {
    return getNextCronOccurrenceMs(watch.cron_expression, nowMs);
  }

  const earliestAllowedPollAtMs = nowMs + minPollIntervalMs;
  const pollIntervalMs = watch.poll_interval_ms ?? 5 * 60 * 1000;
  return Math.max(nowMs + pollIntervalMs, earliestAllowedPollAtMs);
}

function calculateActivityPollBackoffMs(
  consecutiveFailures: number,
  config: ActivityWebhookConfig
): number {
  return calculateWebhookDeliveryBackoffMs(consecutiveFailures, config.retry);
}

function keyForProfileUrl(profileUrl: string): string {
  try {
    return normalizeLinkedInProfileUrl(profileUrl);
  } catch {
    return profileUrl.trim();
  }
}

function normalizeNotificationEntity(notification: {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  link: string;
  is_read: boolean;
}): ActivityEntityRecord {
  const snapshot = {
    id: readText(notification.id),
    type: readText(notification.type),
    message: readText(notification.message),
    timestamp: readText(notification.timestamp),
    link: readText(notification.link),
    is_read: notification.is_read === true
  };
  const entityKey = `notification:${snapshot.id}`;
  return {
    entityKey,
    entityType: "notification",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: snapshot.link
  };
}

function normalizeInvitationEntity(invitation: {
  vanity_name: string | null;
  full_name: string;
  headline: string;
  profile_url: string;
  sent_or_received: "sent" | "received";
}): ActivityEntityRecord {
  const profileUrl = readText(invitation.profile_url);
  const snapshot = {
    vanity_name: invitation.vanity_name,
    full_name: readText(invitation.full_name),
    headline: readText(invitation.headline),
    profile_url: profileUrl,
    sent_or_received: invitation.sent_or_received
  };
  return {
    entityKey: `invitation:${invitation.sent_or_received}:${keyForProfileUrl(profileUrl)}`,
    entityType: "invitation",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: profileUrl
  };
}

function normalizeConnectionEntity(connection: {
  vanity_name: string | null;
  full_name: string;
  headline: string;
  profile_url: string;
  connected_since: string;
}): ActivityEntityRecord {
  const profileUrl = readText(connection.profile_url);
  const snapshot = {
    vanity_name: connection.vanity_name,
    full_name: readText(connection.full_name),
    headline: readText(connection.headline),
    profile_url: profileUrl,
    connected_since: readText(connection.connected_since)
  };
  return {
    entityKey: `connection:${keyForProfileUrl(profileUrl)}`,
    entityType: "connection",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: profileUrl
  };
}

function normalizeAcceptedInvitationEntity(
  connection: LinkedInAcceptedConnection
): ActivityEntityRecord {
  const snapshot = {
    profile_url_key: readText(connection.profile_url_key),
    profile_url: readText(connection.profile_url),
    vanity_name: connection.vanity_name,
    full_name: readText(connection.full_name),
    headline: readText(connection.headline),
    first_seen_sent_at_ms: connection.first_seen_sent_at_ms,
    last_seen_sent_at_ms: connection.last_seen_sent_at_ms,
    accepted_at_ms: connection.accepted_at_ms,
    accepted_detection: readText(connection.accepted_detection),
    followup_status: connection.followup_status,
    followup_prepared_action_id: connection.followup_prepared_action_id,
    followup_prepared_at_ms: connection.followup_prepared_at_ms,
    followup_confirmed_at_ms: connection.followup_confirmed_at_ms,
    followup_expires_at_ms: connection.followup_expires_at_ms
  };

  return {
    entityKey: `accepted:${snapshot.profile_url_key}`,
    entityType: "connection",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: snapshot.profile_url
  };
}

function canonicalizeProfileSnapshot(profile: LinkedInProfile): Record<string, unknown> {
  const experience = [...profile.experience]
    .map((entry) => ({
      title: readText(entry.title),
      company: readText(entry.company),
      duration: readText(entry.duration),
      location: readText(entry.location),
      description: readText(entry.description)
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const education = [...profile.education]
    .map((entry) => ({
      school: readText(entry.school),
      degree: readText(entry.degree),
      field_of_study: readText(entry.field_of_study),
      dates: readText(entry.dates)
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));

  return {
    profile_url: readText(profile.profile_url),
    vanity_name: profile.vanity_name,
    full_name: readText(profile.full_name),
    headline: readText(profile.headline),
    location: readText(profile.location),
    about: readText(profile.about),
    connection_degree: readText(profile.connection_degree),
    experience,
    education
  };
}

function normalizeProfileEntity(profile: LinkedInProfile): ActivityEntityRecord {
  const snapshot = canonicalizeProfileSnapshot(profile);
  const profileUrl = readText(snapshot.profile_url);
  return {
    entityKey: `profile:${keyForProfileUrl(profileUrl)}`,
    entityType: "profile",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: profileUrl
  };
}

function normalizeFeedEntity(post: LinkedInFeedPost): ActivityEntityRecord {
  const snapshot = {
    post_id: readText(post.post_id),
    author_name: readText(post.author_name),
    author_headline: readText(post.author_headline),
    author_profile_url: readText(post.author_profile_url),
    posted_at: readText(post.posted_at),
    text: readText(post.text),
    reactions_count: readText(post.reactions_count),
    comments_count: readText(post.comments_count),
    reposts_count: readText(post.reposts_count),
    post_url: readText(post.post_url)
  };
  const postIdentity = snapshot.post_id || snapshot.post_url;
  return {
    entityKey: `post:${postIdentity}`,
    entityType: "post",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: snapshot.post_url
  };
}

function normalizeThreadEntity(thread: LinkedInThreadSummary): ActivityEntityRecord {
  const snapshot = {
    thread_id: readText(thread.thread_id),
    title: readText(thread.title),
    unread_count: thread.unread_count,
    snippet: readText(thread.snippet),
    thread_url: readText(thread.thread_url)
  };
  return {
    entityKey: `thread:${snapshot.thread_id}`,
    entityType: "thread",
    fingerprint: hashStableValue(snapshot),
    snapshot,
    url: snapshot.thread_url
  };
}

function normalizeMessageEntities(detail: LinkedInThreadDetail): ActivityEntityRecord[] {
  const threadUrl = readText(detail.thread_url);
  return detail.messages.map((message) => {
    const snapshot = {
      thread_id: readText(detail.thread_id),
      thread_url: threadUrl,
      author: readText(message.author),
      sent_at: readText(message.sent_at),
      text: readText(message.text)
    };
    const messageKey = hashStableValue(snapshot);
    return {
      entityKey: `message:${snapshot.thread_id}:${messageKey}`,
      entityType: "message",
      fingerprint: messageKey,
      snapshot,
      url: threadUrl
    };
  });
}

function hasFeedEngagementChanged(
  previous: Record<string, unknown>,
  current: Record<string, unknown>
): boolean {
  return (
    readText(previous.reactions_count) !== readText(current.reactions_count) ||
    readText(previous.comments_count) !== readText(current.comments_count) ||
    readText(previous.reposts_count) !== readText(current.reposts_count)
  );
}

export class ActivityPollerService {
  private readonly config: ActivityWebhookConfig;

  constructor(private readonly runtime: ActivityPollerRuntime) {
    this.config = runtime.activityConfig ?? resolveActivityWebhookConfig();
  }

  async runTick(input: {
    profileName?: string;
    workerId?: string;
  } = {}): Promise<ActivityPollTickResult> {
    const profileName = input.profileName ?? "default";
    const workerId = input.workerId ?? `activity-poller:${process.pid}`;
    const emptyResult = this.buildEmptyTickResult(profileName, workerId);

    if (!this.config.enabled) {
      return emptyResult;
    }

    const tickKey = createActivityTickKey(profileName);
    if (ACTIVE_ACTIVITY_TICKS.has(tickKey)) {
      this.runtime.logger.log("info", "activity.tick.skipped", {
        profile_name: profileName,
        reason: "concurrent_tick",
        worker_id: workerId
      });
      return emptyResult;
    }

    ACTIVE_ACTIVITY_TICKS.add(tickKey);

    try {
      const watchResults: ActivityWatchTickResult[] = [];
      const deliveryResults: ActivityDeliveryTickResult[] = [];
      let emittedEvents = 0;
      let enqueuedDeliveries = 0;
      let failedWatches = 0;
      let deliveredAttempts = 0;
      let retriedDeliveries = 0;
      let failedDeliveries = 0;
      let deadLetterDeliveries = 0;
      let disabledSubscriptions = 0;

      const deliveryClaimedAtMs = Date.now();
      const claimedDeliveries = this.runtime.db.claimDueWebhookDeliveryAttempts({
        profileName,
        nowMs: deliveryClaimedAtMs,
        limit: this.config.maxDeliveriesPerTick,
        leaseOwner: workerId,
        leaseTtlMs: this.config.deliveryLeaseTtlMs,
        clockSkewAllowanceMs: this.config.clockSkewAllowanceMs
      });

      for (const delivery of claimedDeliveries) {
        const correlationId = createId("deliverycorr");
        const { result, subscriptionDisabled } = await this.processDelivery(
          delivery,
          workerId,
          correlationId
        );
        deliveryResults.push(result);
        switch (result.outcome) {
          case "delivered":
            deliveredAttempts += 1;
            break;
          case "retry":
            retriedDeliveries += 1;
            break;
          case "dead_letter":
            deadLetterDeliveries += 1;
            break;
          case "failed":
            failedDeliveries += 1;
            break;
          case "skipped":
            if (result.errorCode === "ACTION_PRECONDITION_FAILED") {
              failedDeliveries += 1;
            }
            break;
        }
        if (subscriptionDisabled) {
          disabledSubscriptions += 1;
        }
      }

      this.promoteDeferredWebhookDeliveries(profileName, Date.now(), workerId);

      const queuedDeliveries = this.runtime.db.countQueuedWebhookDeliveryAttempts({
        profileName
      });
      let claimedWatches: ActivityWatchRow[] = [];

      if (queuedDeliveries >= this.config.maxEventQueueDepth) {
        this.runtime.logger.log("warn", "activity.watch.poll.backpressure", {
          max_event_queue_depth: this.config.maxEventQueueDepth,
          profile_name: profileName,
          queued_deliveries: queuedDeliveries,
          worker_id: workerId
        });
      } else {
        const watchClaimedAtMs = Date.now();
        claimedWatches = this.runtime.db.claimDueActivityWatches({
          profileName,
          nowMs: watchClaimedAtMs,
          limit: this.config.maxWatchesPerTick,
          leaseOwner: workerId,
          leaseTtlMs: this.config.watchLeaseTtlMs,
          clockSkewAllowanceMs: this.config.clockSkewAllowanceMs
        });
      }

      for (const watch of claimedWatches) {
        const correlationId = createId("pollcorr");
        const pollStartedAtMs = Date.now();

        try {
          const result = await this.pollWatch(
            watch,
            pollStartedAtMs,
            workerId,
            correlationId
          );
          emittedEvents += result.emittedEvents;
          enqueuedDeliveries += result.enqueuedDeliveries;
          watchResults.push(result);
        } catch (error) {
          const failedAtMs = Date.now();
          const normalized = normalizeWatchError(error);
          const consecutiveFailures = watch.consecutive_failures + 1;
          const backoffMs = calculateActivityPollBackoffMs(
            consecutiveFailures,
            this.config
          );
          const nextPollAtMs = Math.max(
            nextPollAtMsForWatch(watch, failedAtMs, this.config.minPollIntervalMs),
            failedAtMs + backoffMs
          );
          const markedFailed = this.runtime.db.markActivityWatchPollFailed({
            id: watch.id,
            leaseOwner: workerId,
            nowMs: failedAtMs,
            nextPollAtMs,
            errorCode: normalized.code,
            errorMessage: normalized.message
          });

          watchResults.push({
            watchId: watch.id,
            kind: watch.kind,
            emittedEvents: 0,
            enqueuedDeliveries: 0,
            ...(markedFailed
              ? {
                  errorCode: normalized.code,
                  errorMessage: normalized.message
                }
              : {
                  errorMessage: "Poll result was superseded by another worker."
                })
          });

          if (markedFailed) {
            failedWatches += 1;
            this.runtime.logger.log("warn", "activity.watch.poll.failed", {
              backoff_ms: backoffMs,
              consecutive_failures: consecutiveFailures,
              correlation_id: correlationId,
              error_code: normalized.code,
              error_message: normalized.message,
              kind: watch.kind,
              next_poll_at: new Date(nextPollAtMs).toISOString(),
              profile_name: watch.profile_name,
              watch_id: watch.id,
              worker_id: workerId
            });
          } else {
            this.runtime.logger.log("info", "activity.watch.poll.superseded", {
              correlation_id: correlationId,
              kind: watch.kind,
              profile_name: watch.profile_name,
              watch_id: watch.id,
              worker_id: workerId
            });
          }
        }
      }

      return {
        profileName,
        workerId,
        claimedWatches: claimedWatches.length,
        polledWatches: claimedWatches.length - failedWatches,
        failedWatches,
        emittedEvents,
        enqueuedDeliveries,
        claimedDeliveries: claimedDeliveries.length,
        deliveredAttempts,
        retriedDeliveries,
        failedDeliveries,
        deadLetterDeliveries,
        disabledSubscriptions,
        watchResults,
        deliveryResults
      };
    } finally {
      ACTIVE_ACTIVITY_TICKS.delete(tickKey);
    }
  }

  private buildEmptyTickResult(
    profileName: string,
    workerId: string
  ): ActivityPollTickResult {
    return {
      profileName,
      workerId,
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
      disabledSubscriptions: 0,
      watchResults: [],
      deliveryResults: []
    };
  }

  private promoteDeferredWebhookDeliveries(
    profileName: string,
    nowMs: number,
    workerId: string
  ): number {
    const queuedDeliveries = this.runtime.db.countQueuedWebhookDeliveryAttempts({
      profileName
    });
    const availableSlots = Math.max(
      0,
      this.config.maxEventQueueDepth - queuedDeliveries
    );
    if (availableSlots <= 0) {
      return 0;
    }

    const promoted = this.runtime.db.promoteDeferredWebhookDeliveryAttempts({
      profileName,
      nowMs,
      limit: availableSlots
    });

    if (promoted > 0) {
      this.runtime.logger.log("info", "activity.delivery.promoted", {
        available_slots: availableSlots,
        profile_name: profileName,
        promoted_deliveries: promoted,
        worker_id: workerId
      });
    }

    return promoted;
  }

  private async pollWatch(
    watch: ActivityWatchRow,
    pollStartedAtMs: number,
    leaseOwner: string,
    correlationId: string
  ): Promise<ActivityWatchTickResult> {
    const existingRows = this.runtime.db.listActivityEntityStates({ watchId: watch.id });
    const existingRowsByKey = new Map(
      existingRows.map((row) => [row.entity_key, row] as const)
    );
    const isInitialBaseline = watch.last_success_at === null;
    const pendingEventEmissions: PendingEventEmission[] = [];
    const pendingStateMutations: PendingEntityStateMutation[] = [];

    const stageEventForEntity = (input: {
      changeKind: ActivityEventChangeKind;
      entity: ActivityEntityRecord;
      eventType: ActivityEventType;
      occurredAtMs: number;
      previous: Record<string, unknown> | null;
      watch: ActivityWatchRow;
    }): PendingEventReference => {
      const reference: PendingEventReference = {
        eventId: null
      };
      pendingEventEmissions.push({
        watch: input.watch,
        eventType: input.eventType,
        entity: input.entity,
        previous: input.previous,
        changeKind: input.changeKind,
        occurredAtMs: input.occurredAtMs,
        reference
      });
      return reference;
    };

    const stageEntityState = (input: PendingEntityStateMutation): void => {
      pendingStateMutations.push(input);
    };

    const stageBaselineEntities = (
      watchId: string,
      entities: ActivityEntityRecord[],
      startedAtMs: number
    ): void => {
      for (const entity of entities) {
        stageEntityState({
          watchId,
          entity,
          firstSeenAtMs: startedAtMs,
          pollStartedAtMs: startedAtMs
        });
      }
    };

    const stageKnownEntities = (input: {
      watchId: string;
      entities: ActivityEntityRecord[];
      existingByKey: Map<string, ActivityEntityStateRow>;
      pollStartedAtMs: number;
    }): void => {
      for (const entity of input.entities) {
        stageEntityState({
          watchId: input.watchId,
          entity,
          firstSeenAtMs:
            input.existingByKey.get(entity.entityKey)?.first_seen_at ??
            input.pollStartedAtMs,
          pollStartedAtMs: input.pollStartedAtMs
        });
      }
    };

    const applyEntities = async (input: {
      currentEntities: ActivityEntityRecord[];
      emitCreated?: ActivityEventType;
      handleCreated?: (
        entity: ActivityEntityRecord
      ) => Promise<PendingEventReference | undefined>;
      handleUpdated?: (args: {
        current: ActivityEntityRecord;
        previous: Record<string, unknown>;
      }) => Promise<void>;
    }): Promise<void> => {
      const diff = diffActivityEntities(existingRows, input.currentEntities);

      if (!isInitialBaseline && input.handleCreated) {
        for (const entity of diff.created) {
          const eventReference = await input.handleCreated(entity);
          stageEntityState({
            watchId: watch.id,
            entity,
            firstSeenAtMs: pollStartedAtMs,
            pollStartedAtMs,
            ...(eventReference ? { eventReference } : {})
          });
        }
      } else if (!isInitialBaseline && input.emitCreated) {
        for (const entity of diff.created) {
          const eventReference = stageEventForEntity({
            watch,
            eventType: input.emitCreated,
            entity,
            previous: null,
            changeKind: "created",
            occurredAtMs: pollStartedAtMs
          });
          stageEntityState({
            watchId: watch.id,
            entity,
            firstSeenAtMs: pollStartedAtMs,
            pollStartedAtMs,
            eventReference
          });
        }
      }

      if (!isInitialBaseline && input.handleUpdated) {
        for (const item of diff.updated) {
          await input.handleUpdated(item);
        }
      }

      stageKnownEntities({
        watchId: watch.id,
        entities: [...diff.updated.map((item) => item.current), ...diff.unchanged],
        existingByKey: existingRowsByKey,
        pollStartedAtMs
      });

      if (isInitialBaseline) {
        stageBaselineEntities(watch.id, diff.created, pollStartedAtMs);
      }
    };

    const target = parseJsonObject(watch.target_json);

    switch (watch.kind) {
      case "notifications": {
        const notifications = await this.runtime.notifications.listNotifications({
          profileName: watch.profile_name,
          limit: readNumber(target.limit, 20)
        });
        await applyEntities({
          currentEntities: notifications.map(normalizeNotificationEntity),
          emitCreated: "linkedin.notifications.item.created",
          handleUpdated: async ({ current, previous }) => {
            if (
              typeof previous.is_read === "boolean" &&
              typeof current.snapshot.is_read === "boolean" &&
              previous.is_read !== current.snapshot.is_read
            ) {
              stageEventForEntity({
                watch,
                eventType: "linkedin.notifications.item.read_changed",
                entity: current,
                previous,
                changeKind: "updated",
                occurredAtMs: pollStartedAtMs
              });
            }
          }
        });
        break;
      }
      case "pending_invitations": {
        const directionValue = readText(target.direction);
        const filter =
          directionValue === "sent" || directionValue === "received"
            ? directionValue
            : "all";
        const invitations = await this.runtime.connections.listPendingInvitations({
          profileName: watch.profile_name,
          filter
        });
        await applyEntities({
          currentEntities: invitations.map(normalizeInvitationEntity),
          handleCreated: async (entity) => {
            const direction = readText(entity.snapshot.sent_or_received);
            const eventType =
              direction === "received"
                ? "linkedin.connections.invitation.received"
                : "linkedin.connections.invitation.sent_changed";
            return stageEventForEntity({
              watch,
              eventType,
              entity,
              previous: null,
              changeKind: "created",
              occurredAtMs: pollStartedAtMs
            });
          },
          handleUpdated: async ({ current, previous }) => {
            if (readText(current.snapshot.sent_or_received) !== "sent") {
              return;
            }

            stageEventForEntity({
              watch,
              eventType: "linkedin.connections.invitation.sent_changed",
              entity: current,
              previous,
              changeKind: "updated",
              occurredAtMs: pollStartedAtMs
            });
          }
        });
        break;
      }
      case "accepted_invitations": {
        const sinceDays = readNumber(target.sinceDays, 30);
        const acceptedConnections = await this.runtime.followups.listAcceptedConnections({
          profileName: watch.profile_name,
          sinceMs: pollStartedAtMs - sinceDays * 24 * 60 * 60 * 1_000
        });
        await applyEntities({
          currentEntities: acceptedConnections.map(normalizeAcceptedInvitationEntity),
          emitCreated: "linkedin.connections.invitation.accepted"
        });
        break;
      }
      case "connections": {
        const connections = await this.runtime.connections.listConnections({
          profileName: watch.profile_name,
          limit: readNumber(target.limit, 40)
        });
        await applyEntities({
          currentEntities: connections.map(normalizeConnectionEntity),
          emitCreated: "linkedin.connections.connected"
        });
        break;
      }
      case "profile_watch": {
        const requestedTarget = readText(target.target);
        const profile = await this.runtime.profile.viewProfile({
          profileName: watch.profile_name,
          ...(requestedTarget ? { target: requestedTarget } : {})
        });
        await applyEntities({
          currentEntities: [normalizeProfileEntity(profile)],
          handleUpdated: async ({ current, previous }) => {
            stageEventForEntity({
              watch,
              eventType: "linkedin.profile.snapshot.changed",
              entity: current,
              previous,
              changeKind: "updated",
              occurredAtMs: pollStartedAtMs
            });
          }
        });
        break;
      }
      case "feed": {
        const posts = await this.runtime.feed.viewFeed({
          profileName: watch.profile_name,
          limit: readNumber(target.limit, 10)
        });
        await applyEntities({
          currentEntities: posts.map(normalizeFeedEntity),
          emitCreated: "linkedin.feed.post.appeared",
          handleUpdated: async ({ current, previous }) => {
            if (!hasFeedEngagementChanged(previous, current.snapshot)) {
              return;
            }

            stageEventForEntity({
              watch,
              eventType: "linkedin.feed.post.engagement_changed",
              entity: current,
              previous,
              changeKind: "updated",
              occurredAtMs: pollStartedAtMs
            });
          }
        });
        break;
      }
      case "inbox_threads": {
        const threads = await this.runtime.inbox.listThreads({
          profileName: watch.profile_name,
          limit: readNumber(target.limit, 10),
          unreadOnly: target.unreadOnly === true
        });
        const threadEntities = threads.map(normalizeThreadEntity);
        const threadRows = existingRows.filter((row) => row.entity_type === "thread");
        const threadRowsByKey = new Map(
          threadRows.map((row) => [row.entity_key, row] as const)
        );
        const threadDiff = diffActivityEntities(threadRows, threadEntities);
        const threadsToInspect = isInitialBaseline
          ? threads
          : threads.filter((thread) => {
              const threadKey = `thread:${thread.thread_id}`;
              return (
                threadDiff.created.some((entity) => entity.entityKey === threadKey) ||
                threadDiff.updated.some(
                  (entity) => entity.current.entityKey === threadKey
                )
              );
            });

        if (!isInitialBaseline) {
          for (const entity of threadDiff.created) {
            const eventReference = stageEventForEntity({
              watch,
              eventType: "linkedin.inbox.thread.created",
              entity,
              previous: null,
              changeKind: "created",
              occurredAtMs: pollStartedAtMs
            });
            stageEntityState({
              watchId: watch.id,
              entity,
              firstSeenAtMs: pollStartedAtMs,
              pollStartedAtMs,
              eventReference
            });
          }

          for (const { current, previous } of threadDiff.updated) {
            stageEventForEntity({
              watch,
              eventType: "linkedin.inbox.thread.updated",
              entity: current,
              previous,
              changeKind: "updated",
              occurredAtMs: pollStartedAtMs
            });
          }
        }

        stageKnownEntities({
          watchId: watch.id,
          entities: [...threadDiff.updated.map((item) => item.current), ...threadDiff.unchanged],
          existingByKey: threadRowsByKey,
          pollStartedAtMs
        });

        if (isInitialBaseline) {
          stageBaselineEntities(watch.id, threadDiff.created, pollStartedAtMs);
        }

        const messageRows = existingRows.filter((row) => row.entity_type === "message");
        const messageRowsByKey = new Map(
          messageRows.map((row) => [row.entity_key, row] as const)
        );

        for (const thread of threadsToInspect) {
          const detail = await this.runtime.inbox.getThread({
            profileName: watch.profile_name,
            thread: thread.thread_url || thread.thread_id,
            limit: readNumber(target.messageLimit, 10)
          });
          const messageEntities = normalizeMessageEntities(detail);
          const messageDiff = diffActivityEntities(messageRows, messageEntities);

          if (!isInitialBaseline) {
            for (const entity of messageDiff.created) {
              const eventReference = stageEventForEntity({
                watch,
                eventType: "linkedin.inbox.message.received",
                entity,
                previous: null,
                changeKind: "created",
                occurredAtMs: pollStartedAtMs
              });
              stageEntityState({
                watchId: watch.id,
                entity,
                firstSeenAtMs: pollStartedAtMs,
                pollStartedAtMs,
                eventReference
              });
            }
          }

          stageKnownEntities({
            watchId: watch.id,
            entities: [
              ...messageDiff.updated.map((item) => item.current),
              ...messageDiff.unchanged
            ],
            existingByKey: messageRowsByKey,
            pollStartedAtMs
          });

          if (isInitialBaseline) {
            stageBaselineEntities(watch.id, messageDiff.created, pollStartedAtMs);
          }
        }

        break;
      }
    }

    const committed = this.runtime.db.runInTransaction(() => {
      const queueBudget: DeliveryQueueBudget = {
        deferredDeliveries: 0,
        remainingSlots: Math.max(
          0,
          this.config.maxEventQueueDepth -
            this.runtime.db.countQueuedWebhookDeliveryAttempts({
              profileName: watch.profile_name
            })
        )
      };
      const activeSubscriptions = this.runtime.db.listActiveWebhookSubscriptionsByWatchId(
        watch.id
      );
      const pollFinishedAtMs = Date.now();
      let committedEmittedEvents = 0;
      let committedEnqueuedDeliveries = 0;

      for (const pendingEvent of pendingEventEmissions) {
        const emitted = this.emitEventForEntity({
          watch: pendingEvent.watch,
          subscriptions: activeSubscriptions,
          eventType: pendingEvent.eventType,
          entity: pendingEvent.entity,
          previous: pendingEvent.previous,
          changeKind: pendingEvent.changeKind,
          occurredAtMs: pendingEvent.occurredAtMs,
          pollFinishedAtMs,
          queueBudget,
          correlationId
        });
        if (emitted.inserted) {
          committedEmittedEvents += 1;
        }
        committedEnqueuedDeliveries += emitted.enqueuedDeliveries;
        pendingEvent.reference.eventId = emitted.eventId;
      }

      for (const pendingState of pendingStateMutations) {
        this.upsertEntityState({
          watchId: pendingState.watchId,
          entity: pendingState.entity,
          firstSeenAtMs: pendingState.firstSeenAtMs,
          pollStartedAtMs: pendingState.pollStartedAtMs,
          ...(pendingState.eventReference
            ? { lastEmittedEventId: pendingState.eventReference.eventId }
            : {})
        });
      }

      const committedAtMs = Date.now();
      const markedSucceeded = this.runtime.db.markActivityWatchPollSucceeded({
        id: watch.id,
        leaseOwner,
        nowMs: committedAtMs,
        nextPollAtMs: nextPollAtMsForWatch(
          watch,
          committedAtMs,
          this.config.minPollIntervalMs
        )
      });
      if (!markedSucceeded) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "Activity watch poll result was superseded before commit."
        );
      }

      return {
        emittedEvents: committedEmittedEvents,
        enqueuedDeliveries: committedEnqueuedDeliveries,
        deferredDeliveries: queueBudget.deferredDeliveries
      };
    });

    if (committed.deferredDeliveries > 0) {
      this.runtime.logger.log("warn", "activity.delivery.deferred", {
        correlation_id: correlationId,
        deferred_deliveries: committed.deferredDeliveries,
        max_event_queue_depth: this.config.maxEventQueueDepth,
        profile_name: watch.profile_name,
        watch_id: watch.id
      });
    }

    return {
      watchId: watch.id,
      kind: watch.kind,
      emittedEvents: committed.emittedEvents,
      enqueuedDeliveries: committed.enqueuedDeliveries
    };
  }

  private emitEventForEntity(input: {
    watch: ActivityWatchRow;
    subscriptions: WebhookSubscriptionRow[];
    eventType: ActivityEventType;
    entity: ActivityEntityRecord;
    previous: Record<string, unknown> | null;
    changeKind: ActivityEventChangeKind;
    occurredAtMs: number;
    pollFinishedAtMs: number;
    queueBudget: DeliveryQueueBudget;
    correlationId: string;
  }): EventEmissionResult {
    return this.emitEvent({
      watch: input.watch,
      subscriptions: input.subscriptions,
      eventType: input.eventType,
      entityType: input.entity.entityType,
      entityKey: input.entity.entityKey,
      current: input.entity.snapshot,
      previous: input.previous,
      changeKind: input.changeKind,
      occurredAtMs: input.occurredAtMs,
      pollFinishedAtMs: input.pollFinishedAtMs,
      queueBudget: input.queueBudget,
      correlationId: input.correlationId,
      ...(input.entity.url ? { url: input.entity.url } : {})
    });
  }

  private upsertEntityState(input: {
    watchId: string;
    entity: ActivityEntityRecord;
    firstSeenAtMs: number;
    pollStartedAtMs: number;
    lastEmittedEventId?: string | null;
  }): void {
    this.runtime.db.upsertActivityEntityState({
      watchId: input.watchId,
      entityKey: input.entity.entityKey,
      entityType: input.entity.entityType,
      fingerprint: input.entity.fingerprint,
      snapshotJson: JSON.stringify(input.entity.snapshot),
      firstSeenAtMs: input.firstSeenAtMs,
      lastSeenAtMs: input.pollStartedAtMs,
      ...(input.lastEmittedEventId !== undefined
        ? { lastEmittedEventId: input.lastEmittedEventId }
        : {}),
      updatedAtMs: input.pollStartedAtMs
    });
  }

  private emitEvent(input: {
    watch: ActivityWatchRow;
    subscriptions: WebhookSubscriptionRow[];
    eventType: ActivityEventType;
    entityType: ActivityEntityType;
    entityKey: string;
    current: Record<string, unknown>;
    previous: Record<string, unknown> | null;
    changeKind: ActivityEventChangeKind;
    occurredAtMs: number;
    pollFinishedAtMs: number;
    queueBudget: DeliveryQueueBudget;
    correlationId: string;
    url?: string;
  }): EventEmissionResult {
    const eventId = createId("evt");
    const fingerprint = buildEventFingerprint({
      watchId: input.watch.id,
      eventType: input.eventType,
      entityKey: input.entityKey,
      changeKind: input.changeKind,
      current: input.current,
      previous: input.previous
    });
    const payload = {
      id: eventId,
      version: ACTIVITY_EVENT_VERSION,
      type: input.eventType,
      occurred_at: new Date(input.occurredAtMs).toISOString(),
      profile_name: input.watch.profile_name,
      watch: {
        id: input.watch.id,
        kind: input.watch.kind
      },
      entity: {
        key: input.entityKey,
        type: input.entityType,
        ...(input.url ? { url: input.url } : {})
      },
      change: {
        kind: input.changeKind,
        previous: input.previous,
        current: input.current
      },
      meta: {
        correlation_id: input.correlationId,
        poll_started_at: new Date(input.occurredAtMs).toISOString(),
        poll_finished_at: new Date(input.pollFinishedAtMs).toISOString()
      }
    };
    const payloadJson = JSON.stringify(payload);
    const inserted = this.runtime.db.insertActivityEvent({
      id: eventId,
      watchId: input.watch.id,
      profileName: input.watch.profile_name,
      eventType: input.eventType,
      entityKey: input.entityKey,
      payloadJson,
      fingerprint,
      occurredAtMs: input.occurredAtMs,
      createdAtMs: input.pollFinishedAtMs
    });

    if (!inserted) {
      return {
        inserted: false,
        eventId: null,
        enqueuedDeliveries: 0
      };
    }

    let enqueuedDeliveries = 0;
    for (const subscription of input.subscriptions) {
      const allowedEventTypes = parseStringArray(subscription.event_types_json);
      if (!allowedEventTypes.includes(input.eventType)) {
        continue;
      }

      const status = input.queueBudget.remainingSlots > 0 ? "pending" : "deferred";
      const insertedDelivery = this.runtime.db.insertWebhookDeliveryAttempt({
        id: createId("whdel"),
        watchId: input.watch.id,
        profileName: input.watch.profile_name,
        subscriptionId: subscription.id,
        eventId,
        eventType: input.eventType,
        deliveryUrl: subscription.delivery_url,
        payloadJson,
        attemptNumber: 1,
        status,
        nextAttemptAtMs: input.pollFinishedAtMs,
        createdAtMs: input.pollFinishedAtMs,
        updatedAtMs: input.pollFinishedAtMs
      });
      if (!insertedDelivery) {
        continue;
      }

      if (status === "pending") {
        enqueuedDeliveries += 1;
        input.queueBudget.remainingSlots = Math.max(
          0,
          input.queueBudget.remainingSlots - 1
        );
      } else {
        input.queueBudget.deferredDeliveries += 1;
      }
    }

    return {
      inserted: true,
      eventId,
      enqueuedDeliveries
    };
  }

  private async processDelivery(
    delivery: WebhookDeliveryAttemptRow,
    leaseOwner: string,
    correlationId: string
  ): Promise<ProcessedDeliveryResult> {
    const subscription = this.runtime.db.getWebhookSubscriptionById(
      delivery.subscription_id
    );
    if (!subscription || subscription.status !== "active") {
      const markedFailed = this.runtime.db.markWebhookDeliveryAttemptFailed({
        id: delivery.id,
        leaseOwner,
        nowMs: Date.now(),
        errorCode: "ACTION_PRECONDITION_FAILED",
        errorMessage: "Webhook subscription is not active."
      });
      if (!markedFailed) {
        this.runtime.logger.log("info", "activity.delivery.superseded", {
          correlation_id: correlationId,
          delivery_id: delivery.id,
          profile_name: delivery.profile_name,
          subscription_id: delivery.subscription_id,
          worker_id: leaseOwner
        });
        return {
          result: {
            deliveryId: delivery.id,
            subscriptionId: delivery.subscription_id,
            outcome: "skipped",
            errorMessage: "Webhook delivery lease was superseded."
          },
          subscriptionDisabled: false
        };
      }

      this.runtime.logger.log("warn", "activity.delivery.skipped", {
        correlation_id: correlationId,
        delivery_id: delivery.id,
        error_code: "ACTION_PRECONDITION_FAILED",
        error_message: "Webhook subscription is not active.",
        profile_name: delivery.profile_name,
        subscription_id: delivery.subscription_id,
        worker_id: leaseOwner
      });
      return {
        result: {
          deliveryId: delivery.id,
          subscriptionId: delivery.subscription_id,
          outcome: "skipped",
          errorCode: "ACTION_PRECONDITION_FAILED",
          errorMessage: "Webhook subscription is not active."
        },
        subscriptionDisabled: false
      };
    }

    const outcome = await deliverWebhook({
      deliveryId: delivery.id,
      deliveryUrl: delivery.delivery_url,
      eventType: delivery.event_type,
      payloadJson: delivery.payload_json,
      secret: subscription.signing_secret,
      retryCount: Math.max(0, delivery.attempt_number - 1),
      timeoutMs: this.config.deliveryTimeoutMs
    });
    const nowMs = Date.now();

    if (outcome.outcome === "delivered") {
      const committed = this.runtime.db.runInTransaction(() => {
        const markedDelivered = this.runtime.db.markWebhookDeliveryAttemptDelivered({
          id: delivery.id,
          leaseOwner,
          nowMs,
          responseStatus: outcome.responseStatus ?? null,
          responseBodyExcerpt: outcome.responseBodyExcerpt ?? null
        });
        if (!markedDelivered) {
          return false;
        }
        this.runtime.db.recordWebhookSubscriptionDelivered({
          id: subscription.id,
          deliveredAtMs: nowMs,
          updatedAtMs: nowMs
        });
        return true;
      });

      if (!committed) {
        this.runtime.logger.log("info", "activity.delivery.superseded", {
          correlation_id: correlationId,
          delivery_id: delivery.id,
          profile_name: delivery.profile_name,
          subscription_id: subscription.id,
          worker_id: leaseOwner
        });
        return {
          result: {
            deliveryId: delivery.id,
            subscriptionId: subscription.id,
            outcome: "skipped",
            errorMessage: "Webhook delivery lease was superseded."
          },
          subscriptionDisabled: false
        };
      }

      return {
        result: {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          outcome: "delivered",
          responseStatus: outcome.responseStatus ?? null
        },
        subscriptionDisabled: false
      };
    }

    if (outcome.outcome === "retry" && delivery.attempt_number < subscription.max_attempts) {
      const nextAttemptAtMs =
        nowMs +
        calculateWebhookDeliveryBackoffMs(delivery.attempt_number, this.config.retry);
      const transition = this.runtime.db.runInTransaction(() => {
        const markedRetrying = this.runtime.db.markWebhookDeliveryAttemptRetrying({
          id: delivery.id,
          leaseOwner,
          nowMs,
          responseStatus: outcome.responseStatus ?? null,
          responseBodyExcerpt: outcome.responseBodyExcerpt ?? null,
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.errorMessage
        });
        if (!markedRetrying) {
          return "superseded";
        }

        const insertedRetry = this.runtime.db.insertWebhookDeliveryAttempt({
          id: createId("whdel"),
          watchId: delivery.watch_id,
          profileName: delivery.profile_name,
          subscriptionId: delivery.subscription_id,
          eventId: delivery.event_id,
          eventType: delivery.event_type,
          deliveryUrl: delivery.delivery_url,
          payloadJson: delivery.payload_json,
          attemptNumber: delivery.attempt_number + 1,
          status: "pending",
          nextAttemptAtMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs
        });
        this.runtime.db.recordWebhookSubscriptionError({
          id: subscription.id,
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.errorMessage,
          updatedAtMs: nowMs
        });
        return insertedRetry ? "queued" : "duplicate";
      });

      if (transition === "superseded") {
        this.runtime.logger.log("info", "activity.delivery.superseded", {
          correlation_id: correlationId,
          delivery_id: delivery.id,
          profile_name: delivery.profile_name,
          subscription_id: subscription.id,
          worker_id: leaseOwner
        });
        return {
          result: {
            deliveryId: delivery.id,
            subscriptionId: subscription.id,
            outcome: "skipped",
            errorMessage: "Webhook delivery lease was superseded."
          },
          subscriptionDisabled: false
        };
      }

      this.runtime.logger.log("warn", "activity.delivery.retry", {
        correlation_id: correlationId,
        delivery_id: delivery.id,
        error_code: outcome.errorCode ?? null,
        error_message: outcome.errorMessage,
        next_attempt_at: new Date(nextAttemptAtMs).toISOString(),
        profile_name: delivery.profile_name,
        response_status: outcome.responseStatus ?? null,
        subscription_id: subscription.id,
        transition,
        worker_id: leaseOwner
      });
      return {
        result: {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          outcome: "retry",
          responseStatus: outcome.responseStatus ?? null,
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.errorMessage
        },
        subscriptionDisabled: false
      };
    }

    const deadLetter = outcome.outcome === "retry";
    const committed = this.runtime.db.runInTransaction(() => {
      const markedFailed = this.runtime.db.markWebhookDeliveryAttemptFailed({
        id: delivery.id,
        leaseOwner,
        nowMs,
        responseStatus: outcome.responseStatus ?? null,
        responseBodyExcerpt: outcome.responseBodyExcerpt ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage,
        deadLetter
      });
      if (!markedFailed) {
        return false;
      }
      this.runtime.db.recordWebhookSubscriptionError({
        id: subscription.id,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage,
        updatedAtMs: nowMs
      });
      if (outcome.disableSubscription) {
        this.runtime.db.updateWebhookSubscriptionStatus({
          id: subscription.id,
          status: "disabled",
          updatedAtMs: nowMs
        });
      }
      return true;
    });

    if (!committed) {
      this.runtime.logger.log("info", "activity.delivery.superseded", {
        correlation_id: correlationId,
        delivery_id: delivery.id,
        profile_name: delivery.profile_name,
        subscription_id: subscription.id,
        worker_id: leaseOwner
      });
      return {
        result: {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          outcome: "skipped",
          errorMessage: "Webhook delivery lease was superseded."
        },
        subscriptionDisabled: false
      };
    }

    this.runtime.logger.log(
      deadLetter || outcome.disableSubscription ? "error" : "warn",
      deadLetter ? "activity.delivery.dead_letter" : "activity.delivery.failed",
      {
        correlation_id: correlationId,
        dead_lettered: deadLetter,
        delivery_id: delivery.id,
        error_code: outcome.errorCode ?? null,
        error_message: outcome.errorMessage,
        profile_name: delivery.profile_name,
        response_status: outcome.responseStatus ?? null,
        subscription_disabled: outcome.disableSubscription === true,
        subscription_id: subscription.id,
        worker_id: leaseOwner
      }
    );

    return {
      result: {
        deliveryId: delivery.id,
        subscriptionId: subscription.id,
        outcome: deadLetter ? "dead_letter" : "failed",
        responseStatus: outcome.responseStatus ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.disableSubscription
          ? `${outcome.errorMessage} Subscription disabled.`
          : outcome.errorMessage
      },
      subscriptionDisabled: outcome.disableSubscription === true
    };
  }
}
