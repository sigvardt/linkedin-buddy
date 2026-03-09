import { randomBytes } from "node:crypto";
import type {
  ActivityWebhookConfig
} from "./config.js";
import {
  resolveActivityWebhookConfig
} from "./config.js";
import type {
  ActivityEventRow,
  ActivityWatchRow,
  AssistantDatabase,
  WebhookDeliveryAttemptRow,
  WebhookSubscriptionRow
} from "./db/database.js";
import { LinkedInAssistantError } from "./errors.js";
import { resolveProfileUrl } from "./linkedinProfile.js";
import type { JsonEventLogger } from "./logging.js";
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_WATCH_DEFAULT_POLL_INTERVAL_MS,
  ACTIVITY_WATCH_EVENT_TYPES,
  ACTIVITY_WATCH_MIN_POLL_INTERVAL_MS,
  ACTIVITY_WATCH_KINDS,
  type ActivityEventType,
  type ActivityScheduleKind,
  type ActivityWatchKind,
  type ActivityWatchStatus,
  type WebhookDeliveryAttemptStatus,
  type WebhookSubscriptionStatus
} from "./activityTypes.js";

const MAX_ACTIVITY_LIMIT = 50;

export interface ActivityWatch {
  id: string;
  profileName: string;
  kind: ActivityWatchKind;
  target: Record<string, unknown>;
  scheduleKind: ActivityScheduleKind;
  pollIntervalMs: number | null;
  cronExpression: string | null;
  status: ActivityWatchStatus;
  nextPollAtMs: number;
  lastPolledAtMs: number | null;
  lastSuccessAtMs: number | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WebhookSubscription {
  id: string;
  watchId: string;
  status: WebhookSubscriptionStatus;
  eventTypes: ActivityEventType[];
  deliveryUrl: string;
  maxAttempts: number;
  lastDeliveredAtMs: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreatedWebhookSubscription extends WebhookSubscription {
  signingSecret: string;
}

export interface ActivityEventRecord {
  id: string;
  watchId: string;
  profileName: string;
  eventType: ActivityEventType;
  entityKey: string;
  payload: Record<string, unknown>;
  fingerprint: string;
  occurredAtMs: number;
  createdAtMs: number;
}

export interface WebhookDeliveryAttemptRecord {
  id: string;
  watchId: string;
  profileName: string;
  subscriptionId: string;
  eventId: string;
  eventType: ActivityEventType;
  deliveryUrl: string;
  payload: Record<string, unknown>;
  attemptNumber: number;
  status: WebhookDeliveryAttemptStatus;
  responseStatus: number | null;
  responseBodyExcerpt: string | null;
  nextAttemptAtMs: number;
  lastAttemptAtMs: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateActivityWatchInput {
  profileName?: string;
  kind: ActivityWatchKind;
  target?: Record<string, unknown>;
  intervalSeconds?: number;
  cron?: string;
}

export interface CreateWebhookSubscriptionInput {
  watchId: string;
  deliveryUrl: string;
  eventTypes?: ActivityEventType[];
  signingSecret?: string;
  maxAttempts?: number;
}

export interface ActivityWatchesRuntime {
  db: AssistantDatabase;
  logger: JsonEventLogger;
  activityConfig?: ActivityWebhookConfig;
}

type CronFieldDefinition = {
  max: number;
  min: number;
  allowSevenAsSunday?: boolean;
};

type ParsedCronExpression = {
  dayOfMonth: Set<number>;
  dayOfWeek: Set<number>;
  hour: Set<number>;
  minute: Set<number>;
  month: Set<number>;
};

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readText(value: unknown, label: string, required = false): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!required || normalized.length > 0) {
    return normalized;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} is required.`
  );
}

function readPositiveInteger(
  value: unknown,
  label: string,
  fallback?: number,
  max = MAX_ACTIVITY_LIMIT
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer.`
    );
  }

  const normalized = Math.floor(value);
  if (normalized <= 0 || normalized > max) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be between 1 and ${max}.`
    );
  }

  return normalized;
}

function readHttpUrl(value: string, label: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a valid URL.`,
      { cause_name: error instanceof Error ? error.name : undefined }
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must use http or https.`
    );
  }

  return parsed.toString();
}

function normalizeTarget(
  kind: ActivityWatchKind,
  rawTarget: Record<string, unknown> | undefined
): Record<string, unknown> {
  const target = rawTarget ?? {};

  switch (kind) {
    case "inbox_threads":
      return {
        limit: readPositiveInteger(target.limit, "target.limit", 10),
        messageLimit: readPositiveInteger(
          target.messageLimit,
          "target.messageLimit",
          10,
          25
        ),
        unreadOnly: target.unreadOnly === true
      };
    case "notifications":
      return {
        limit: readPositiveInteger(target.limit, "target.limit", 20)
      };
    case "pending_invitations": {
      const direction = readText(target.direction, "target.direction") || "all";
      if (!["all", "sent", "received"].includes(direction)) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "target.direction must be one of: all, sent, received."
        );
      }

      return { direction };
    }
    case "accepted_invitations":
      return {
        sinceDays: readPositiveInteger(target.sinceDays, "target.sinceDays", 30, 365)
      };
    case "connections":
      return {
        limit: readPositiveInteger(target.limit, "target.limit", 40)
      };
    case "profile_watch": {
      const resolvedTarget = resolveProfileUrl(readText(target.target, "target.target", true));
      return {
        target: resolvedTarget
      };
    }
    case "feed":
      return {
        limit: readPositiveInteger(target.limit, "target.limit", 10, 20)
      };
  }
}

function parseCronField(
  value: string,
  definition: CronFieldDefinition
): Set<number> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "cron expressions may not contain blank fields."
    );
  }

  const values = new Set<number>();

  const addValue = (rawNumber: number): void => {
    const normalized =
      definition.allowSevenAsSunday && rawNumber === 7 ? 0 : rawNumber;
    if (normalized < definition.min || normalized > definition.max) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "cron expression contains a value outside the supported range."
      );
    }
    values.add(normalized);
  };

  const expandRange = (start: number, end: number, step: number): void => {
    if (step <= 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "cron step values must be greater than 0."
      );
    }

    if (end < start) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "cron ranges must end after they start."
      );
    }

    for (let current = start; current <= end; current += step) {
      addValue(current);
    }
  };

  for (const part of trimmed.split(",")) {
    const [rawRangePart, stepPart] = part.split("/");
    const rangePart = rawRangePart ?? "";
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;

    if (rangePart === "*") {
      expandRange(definition.min, definition.max, step);
      continue;
    }

    if (rangePart.includes("-")) {
      const [startText, endText] = rangePart.split("-");
      const start = Number.parseInt(startText ?? "", 10);
      const end = Number.parseInt(endText ?? "", 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          "cron ranges must use whole numbers."
        );
      }

      expandRange(start, end, step);
      continue;
    }

    const numeric = Number.parseInt(rangePart, 10);
    if (!Number.isFinite(numeric)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "cron fields must use numbers, ranges, lists, or step values."
      );
    }

    addValue(numeric);
  }

  return values;
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);

  if (parts.length !== 5) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "cron must use 5 fields: minute hour day-of-month month day-of-week."
    );
  }

  return {
    minute: parseCronField(parts[0] ?? "", { min: 0, max: 59 }),
    hour: parseCronField(parts[1] ?? "", { min: 0, max: 23 }),
    dayOfMonth: parseCronField(parts[2] ?? "", { min: 1, max: 31 }),
    month: parseCronField(parts[3] ?? "", { min: 1, max: 12 }),
    dayOfWeek: parseCronField(parts[4] ?? "", {
      min: 0,
      max: 6,
      allowSevenAsSunday: true
    })
  };
}

function matchesCron(date: Date, parsed: ParsedCronExpression): boolean {
  return (
    parsed.minute.has(date.getMinutes()) &&
    parsed.hour.has(date.getHours()) &&
    parsed.dayOfMonth.has(date.getDate()) &&
    parsed.month.has(date.getMonth() + 1) &&
    parsed.dayOfWeek.has(date.getDay())
  );
}

export function getNextCronOccurrenceMs(
  expression: string,
  afterMs: number
): number {
  const parsed = parseCronExpression(expression);
  const start = new Date(afterMs);
  const cursor = new Date(start.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const deadlineMs = afterMs + 366 * 24 * 60 * 60 * 1_000;
  while (cursor.getTime() <= deadlineMs) {
    if (matchesCron(cursor, parsed)) {
      return cursor.getTime();
    }

    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "cron did not produce a next occurrence within one year."
  );
}

function resolveSchedule(input: {
  kind: ActivityWatchKind;
  intervalSeconds?: number;
  cron?: string;
}): {
  cronExpression: string | null;
  pollIntervalMs: number | null;
  scheduleKind: ActivityScheduleKind;
} {
  const intervalSeconds = input.intervalSeconds;
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";

  if (typeof intervalSeconds === "number" && cron.length > 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Specify either intervalSeconds or cron, not both."
    );
  }

  if (cron.length > 0) {
    parseCronExpression(cron);
    return {
      scheduleKind: "cron",
      pollIntervalMs: null,
      cronExpression: cron
    };
  }

  const resolvedIntervalSeconds =
    typeof intervalSeconds === "number"
      ? readPositiveInteger(intervalSeconds, "intervalSeconds", undefined, 24 * 60 * 60)
      : Math.floor(ACTIVITY_WATCH_DEFAULT_POLL_INTERVAL_MS[input.kind] / 1_000);

  return {
    scheduleKind: "interval",
    pollIntervalMs: (resolvedIntervalSeconds ?? 1) * 1_000,
    cronExpression: null
  };
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

function toActivityWatch(row: ActivityWatchRow): ActivityWatch {
  return {
    id: row.id,
    profileName: row.profile_name,
    kind: row.kind,
    target: parseJsonObject(row.target_json),
    scheduleKind: row.schedule_kind,
    pollIntervalMs: row.poll_interval_ms,
    cronExpression: row.cron_expression,
    status: row.status,
    nextPollAtMs: row.next_poll_at,
    lastPolledAtMs: row.last_polled_at,
    lastSuccessAtMs: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at
  };
}

function toWebhookSubscription(
  row: WebhookSubscriptionRow
): WebhookSubscription {
  const parsedEventTypes = parseStringArray(row.event_types_json);

  return {
    id: row.id,
    watchId: row.watch_id,
    status: row.status,
    eventTypes: parsedEventTypes.filter((value): value is ActivityEventType =>
      ACTIVITY_EVENT_TYPES.includes(value as ActivityEventType)
    ),
    deliveryUrl: row.delivery_url,
    maxAttempts: row.max_attempts,
    lastDeliveredAtMs: row.last_delivered_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at
  };
}

function toActivityEventRecord(row: ActivityEventRow): ActivityEventRecord {
  return {
    id: row.id,
    watchId: row.watch_id,
    profileName: row.profile_name,
    eventType: row.event_type,
    entityKey: row.entity_key,
    payload: parseJsonObject(row.payload_json),
    fingerprint: row.fingerprint,
    occurredAtMs: row.occurred_at,
    createdAtMs: row.created_at
  };
}

function toWebhookDeliveryAttemptRecord(
  row: WebhookDeliveryAttemptRow
): WebhookDeliveryAttemptRecord {
  return {
    id: row.id,
    watchId: row.watch_id,
    profileName: row.profile_name,
    subscriptionId: row.subscription_id,
    eventId: row.event_id,
    eventType: row.event_type,
    deliveryUrl: row.delivery_url,
    payload: parseJsonObject(row.payload_json),
    attemptNumber: row.attempt_number,
    status: row.status,
    responseStatus: row.response_status,
    responseBodyExcerpt: row.response_body_excerpt,
    nextAttemptAtMs: row.next_attempt_at,
    lastAttemptAtMs: row.last_attempt_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at
  };
}

function ensureWatchExists(
  db: AssistantDatabase,
  watchId: string
): ActivityWatchRow {
  const watch = db.getActivityWatchById(watchId);
  if (watch) {
    return watch;
  }

  throw new LinkedInAssistantError(
    "TARGET_NOT_FOUND",
    `Activity watch ${watchId} was not found.`
  );
}

function ensureWebhookSubscriptionExists(
  db: AssistantDatabase,
  subscriptionId: string
): WebhookSubscriptionRow {
  const subscription = db.getWebhookSubscriptionById(subscriptionId);
  if (subscription) {
    return subscription;
  }

  throw new LinkedInAssistantError(
    "TARGET_NOT_FOUND",
    `Webhook subscription ${subscriptionId} was not found.`
  );
}

function resolveEventTypesForWatch(
  kind: ActivityWatchKind,
  eventTypes: ActivityEventType[] | undefined
): ActivityEventType[] {
  const supported = ACTIVITY_WATCH_EVENT_TYPES[kind];
  if (!eventTypes || eventTypes.length === 0) {
    return [...supported];
  }

  const invalid = eventTypes.filter((eventType) => !supported.includes(eventType));
  if (invalid.length > 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Unsupported event types for ${kind}: ${invalid.join(", ")}.`,
      {
        kind,
        supported_event_types: supported,
        provided_event_types: eventTypes
      }
    );
  }

  return [...new Set(eventTypes)];
}

function resolveEffectiveMinPollIntervalMs(
  kind: ActivityWatchKind,
  config: ActivityWebhookConfig
): number {
  return Math.max(
    ACTIVITY_WATCH_MIN_POLL_INTERVAL_MS[kind],
    config.minPollIntervalMs
  );
}

export class ActivityWatchesService {
  private readonly config: ActivityWebhookConfig;

  constructor(private readonly runtime: ActivityWatchesRuntime) {
    this.config = runtime.activityConfig ?? resolveActivityWebhookConfig();
  }

  createWatch(input: CreateActivityWatchInput): ActivityWatch {
    if (!ACTIVITY_WATCH_KINDS.includes(input.kind)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `kind must be one of: ${ACTIVITY_WATCH_KINDS.join(", ")}.`
      );
    }

    const nowMs = Date.now();
    const profileName = input.profileName ?? "default";
    this.ensureActiveWatchCapacity(profileName);
    const target = normalizeTarget(input.kind, input.target);
    const scheduleInput: {
      kind: ActivityWatchKind;
      intervalSeconds?: number;
      cron?: string;
    } = {
      kind: input.kind,
      ...(typeof input.intervalSeconds === "number"
        ? { intervalSeconds: input.intervalSeconds }
        : {}),
      ...(typeof input.cron === "string" ? { cron: input.cron } : {})
    };
    const schedule = resolveSchedule(scheduleInput);
    const effectiveMinPollIntervalMs = resolveEffectiveMinPollIntervalMs(
      input.kind,
      this.config
    );

    if (
      schedule.scheduleKind === "interval" &&
      schedule.pollIntervalMs !== null &&
      schedule.pollIntervalMs < effectiveMinPollIntervalMs
    ) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `intervalSeconds must be at least ${Math.ceil(effectiveMinPollIntervalMs / 1_000)} for ${input.kind}.`
      );
    }

    const id = createId("watch");
    this.runtime.db.insertActivityWatch({
      id,
      profileName,
      kind: input.kind,
      targetJson: JSON.stringify(target),
      scheduleKind: schedule.scheduleKind,
      pollIntervalMs: schedule.pollIntervalMs,
      cronExpression: schedule.cronExpression,
      status: "active",
      nextPollAtMs: nowMs,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    });

    this.runtime.logger.log("info", "activity.watch.created", {
      watch_id: id,
      profile_name: profileName,
      kind: input.kind
    });

    return toActivityWatch(ensureWatchExists(this.runtime.db, id));
  }

  listWatches(input: {
    profileName?: string;
    status?: ActivityWatchStatus;
  } = {}): ActivityWatch[] {
    return this.runtime.db.listActivityWatches(input).map(toActivityWatch);
  }

  getWatchById(id: string): ActivityWatch {
    return toActivityWatch(ensureWatchExists(this.runtime.db, id));
  }

  pauseWatch(id: string): ActivityWatch {
    return this.setWatchStatus(id, "paused");
  }

  resumeWatch(id: string): ActivityWatch {
    return this.setWatchStatus(id, "active", Date.now());
  }

  removeWatch(id: string): boolean {
    ensureWatchExists(this.runtime.db, id);
    return this.runtime.db.deleteActivityWatch(id);
  }

  createWebhookSubscription(
    input: CreateWebhookSubscriptionInput
  ): CreatedWebhookSubscription {
    const watch = ensureWatchExists(this.runtime.db, input.watchId);
    const deliveryUrl = readHttpUrl(input.deliveryUrl, "deliveryUrl");
    const signingSecret =
      typeof input.signingSecret === "string" && input.signingSecret.trim().length > 0
        ? input.signingSecret.trim()
        : `whsec_${randomBytes(16).toString("hex")}`;
    const eventTypes = resolveEventTypesForWatch(
      watch.kind,
      input.eventTypes
    );
    const nowMs = Date.now();
    const id = createId("whsub");

    this.runtime.db.insertWebhookSubscription({
      id,
      watchId: watch.id,
      status: "active",
      eventTypesJson: JSON.stringify(eventTypes),
      deliveryUrl,
      signingSecret,
      maxAttempts: input.maxAttempts ?? this.config.retry.maxAttempts,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    });

    const subscription = toWebhookSubscription(
      ensureWebhookSubscriptionExists(this.runtime.db, id)
    );

    this.runtime.logger.log("info", "activity.webhook.created", {
      webhook_subscription_id: id,
      watch_id: watch.id,
      event_types: eventTypes
    });

    return {
      ...subscription,
      signingSecret
    };
  }

  listWebhookSubscriptions(input: {
    watchId?: string;
    profileName?: string;
    status?: WebhookSubscriptionStatus;
  } = {}): WebhookSubscription[] {
    return this.runtime.db
      .listWebhookSubscriptions(input)
      .map(toWebhookSubscription);
  }

  getWebhookSubscriptionById(id: string): WebhookSubscription {
    return toWebhookSubscription(
      ensureWebhookSubscriptionExists(this.runtime.db, id)
    );
  }

  pauseWebhookSubscription(id: string): WebhookSubscription {
    return this.setWebhookSubscriptionStatus(id, "paused");
  }

  resumeWebhookSubscription(id: string): WebhookSubscription {
    return this.setWebhookSubscriptionStatus(id, "active");
  }

  removeWebhookSubscription(id: string): boolean {
    ensureWebhookSubscriptionExists(this.runtime.db, id);
    return this.runtime.db.deleteWebhookSubscription(id);
  }

  listEvents(input: {
    profileName?: string;
    watchId?: string;
    limit?: number;
  } = {}): ActivityEventRecord[] {
    return this.runtime.db.listActivityEvents(input).map(toActivityEventRecord);
  }

  listDeliveries(input: {
    profileName?: string;
    watchId?: string;
    subscriptionId?: string;
    status?: WebhookDeliveryAttemptStatus;
    limit?: number;
  } = {}): WebhookDeliveryAttemptRecord[] {
    return this.runtime.db
      .listWebhookDeliveryAttempts(input)
      .map(toWebhookDeliveryAttemptRecord);
  }

  private setWatchStatus(
    id: string,
    status: ActivityWatchStatus,
    nextPollAtMs?: number
  ): ActivityWatch {
    const existingWatch = ensureWatchExists(this.runtime.db, id);
    if (status === "active" && existingWatch.status !== "active") {
      this.ensureActiveWatchCapacity(existingWatch.profile_name, id);
    }
    this.runtime.db.updateActivityWatchStatus({
      id,
      status,
      ...(nextPollAtMs !== undefined ? { nextPollAtMs } : {}),
      updatedAtMs: Date.now()
    });
    return this.getWatchById(id);
  }

  private setWebhookSubscriptionStatus(
    id: string,
    status: WebhookSubscriptionStatus
  ): WebhookSubscription {
    ensureWebhookSubscriptionExists(this.runtime.db, id);
    this.runtime.db.updateWebhookSubscriptionStatus({
      id,
      status,
      updatedAtMs: Date.now()
    });
    return this.getWebhookSubscriptionById(id);
  }

  private ensureActiveWatchCapacity(
    profileName: string,
    currentWatchId?: string
  ): void {
    const activeWatchCount = this.runtime.db
      .listActivityWatches({
        profileName,
        status: "active"
      })
      .filter((watch) => watch.id !== currentWatchId).length;

    if (activeWatchCount >= this.config.maxConcurrentWatches) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Active watch limit reached for profile ${profileName}. Reduce active watches or raise LINKEDIN_ASSISTANT_ACTIVITY_MAX_CONCURRENT_WATCHES.`,
        {
          profile_name: profileName,
          active_watch_count: activeWatchCount,
          max_concurrent_watches: this.config.maxConcurrentWatches
        }
      );
    }
  }
}
