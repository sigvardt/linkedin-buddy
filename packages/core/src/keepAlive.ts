import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import type {
  LinkedInBrowserStorageState,
  LinkedInSessionStore
} from "./auth/sessionStore.js";
import {
  getLinkedInSessionFingerprint,
  restoreLinkedInSessionCookies
} from "./auth/sessionStore.js";
import {
  checkFullHealth,
  DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS,
  type FullHealthStatus
} from "./healthCheck.js";
import type { ConnectionLease } from "./connectionPool.js";
import { CDPConnectionPool } from "./connectionPool.js";
import { LinkedInAssistantError } from "./errors.js";
import { humanize } from "./humanize.js";

const DEFAULT_NETWORK_GRACE_PERIOD_MS = 5 * 60_000;
const DEFAULT_NETWORK_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_WARMUP_THRESHOLD_MS = 4 * 60 * 60_000;
const DEFAULT_ACTIVITY_EVERY_HEALTHY_TICKS = 3;
const DEFAULT_NIGHT_ACTIVITY_EVERY_HEALTHY_TICKS = 6;
const DEFAULT_MAX_HEALTH_LOG_ENTRIES = 200;
const DEFAULT_MAX_BACKUP_SESSIONS = 3;
const RATE_LIMIT_BACKOFF_INTERVAL_MULTIPLIER = 2;
const RATE_LIMIT_BACKOFF_RETRY_MULTIPLIER = 4;

const DEFAULT_RECONNECT_ALERT_THRESHOLD = {
  count: 3,
  windowMs: 10 * 60_000
} as const;

const ACTIVITY_PATTERNS = [
  "feed-scroll",
  "notifications-peek",
  "network-peek"
] as const;

const KEEP_ALIVE_PAGE_GOTO_OPTIONS = {
  waitUntil: "domcontentloaded"
} as const;

const LINKEDIN_KEEP_ALIVE_URLS = {
  feed: "https://www.linkedin.com/feed/",
  network: "https://www.linkedin.com/mynetwork/",
  notifications: "https://www.linkedin.com/notifications/"
} as const;

type ActivityPattern = (typeof ACTIVITY_PATTERNS)[number];

const ACTIVITY_PATTERN_DETAILS: Readonly<
  Record<
    ActivityPattern,
    {
      detail: string;
      shouldScrollDown?: boolean;
      url: string;
    }
  >
> = {
  "feed-scroll": {
    detail: "Rotated keepalive activity: scrolled the LinkedIn feed",
    shouldScrollDown: true,
    url: LINKEDIN_KEEP_ALIVE_URLS.feed
  },
  "network-peek": {
    detail: "Rotated keepalive activity: viewed the network page",
    url: LINKEDIN_KEEP_ALIVE_URLS.network
  },
  "notifications-peek": {
    detail: "Rotated keepalive activity: checked the notifications page",
    url: LINKEDIN_KEEP_ALIVE_URLS.notifications
  }
};

interface SessionSnapshot {
  capturedAt: string;
  fingerprint: string;
  nextCookieExpiryAt: string | null;
  storageState: LinkedInBrowserStorageState;
}

type RestoreSessionContext = LinkedInSessionStore["restoreToContext"];
type SaveSessionBackups = LinkedInSessionStore["saveWithBackups"];

interface KeepAliveSessionStoreLike {
  restoreToContext?: RestoreSessionContext;
  saveWithBackups?: SaveSessionBackups;
}

interface SessionRestoreAttempt {
  attemptDetail: string;
  attemptMetadata: Record<string, unknown>;
  restore: () => Promise<unknown>;
  successDetail: string;
  successMetadata: Record<string, unknown>;
}

/**
 * Structured event kinds emitted by `SessionKeepAliveService` as it monitors
 * and recovers a LinkedIn browser session.
 */
export type KeepAliveEventType =
  | "healthy"
  | "session-expired"
  | "browser-disconnected"
  | "reconnect-attempt"
  | "reconnect-success"
  | "reconnect-failed"
  | "dead"
  | "activity"
  | "alert"
  | "cookie-refresh"
  | "login-wall-detected"
  | "manual-login-required"
  | "network-interruption"
  | "network-recovered"
  | "session-persisted"
  | "session-rotated"
  | "soft-reauth-attempt"
  | "soft-reauth-failed"
  | "soft-reauth-success"
  | "tab-cleanup"
  | "warmup";

/**
 * Structured keepalive event emitted on the `health-event` channel.
 */
export interface KeepAliveEvent {
  type: KeepAliveEventType;
  timestamp: string;
  health?: FullHealthStatus;
  consecutiveFailures: number;
  detail?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Thresholds that raise operator-visible keepalive alerts.
 */
export interface KeepAliveAlertThresholds {
  cookieExpiringWithinMs?: number;
  reconnectsInWindow?: {
    count: number;
    windowMs: number;
  };
}

/**
 * Rolling health and recovery metrics exposed by `SessionKeepAliveService`.
 */
export interface KeepAliveMetrics {
  activeAlerts: string[];
  authenticated: boolean;
  backupSessionCount: number;
  browserConnected: boolean;
  browserHealthy: boolean;
  consecutiveFailures: number;
  currentReason: string;
  currentUrl: string;
  lastActivityAt?: string;
  lastCookieRefreshAt?: string;
  lastHealthyAt?: string;
  lastLoginRequiredAt?: string;
  lastSessionFingerprint?: string;
  lastTickAt?: string;
  lastWarmupAt?: string;
  networkInterruptedAt?: string;
  nextCookieExpiryAt: string | null;
  reconnectCount: number;
  reconnectCountInWindow: number;
  sessionCookiePresent: boolean;
  sessionUptimeMs: number;
  startedAt?: string;
}

/**
 * Configuration for `SessionKeepAliveService`.
 *
 * Defaults:
 * - `activityEveryHealthyTicks`: `3`
 * - `activitySimulationEnabled`: `true`
 * - `cookieRefreshLeadMs`: session-cookie warning threshold from
 *   `checkFullHealth()`
 * - `idleWarmupThresholdMs`: `14400000`
 * - `intervalMs`: `300000`
 * - `jitterMs`: `30000`
 * - `maxBackupSessions`: `3`
 * - `maxConsecutiveFailures`: `5`
 * - `maxHealthLogEntries`: `200` (minimum `10`)
 * - `networkGracePeriodMs`: `300000`
 * - `networkRetryIntervalMs`: `30000`
 * - `nightActivityEveryHealthyTicks`: `6`
 * - `nightHours`: `00:00`-`06:00`
 * - `sessionName`: `default`
 * - `sessionRefreshEnabled`: `true`
 */
export interface KeepAliveOptions {
  activityEveryHealthyTicks?: number;
  activitySimulationEnabled?: boolean;
  alertThresholds?: KeepAliveAlertThresholds;
  cdpUrl: string;
  cookieRefreshLeadMs?: number;
  idleWarmupThresholdMs?: number;
  intervalMs?: number;
  jitterMs?: number;
  maxBackupSessions?: number;
  maxConsecutiveFailures?: number;
  maxHealthLogEntries?: number;
  networkGracePeriodMs?: number;
  networkRetryIntervalMs?: number;
  nightActivityEveryHealthyTicks?: number;
  nightHours?: {
    endHour: number;
    startHour: number;
  };
  sessionName?: string;
  sessionRefreshEnabled?: boolean;
  sessionStore?: KeepAliveSessionStoreLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function resolveRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-empty string.`,
      {
        received_type: describeValueType(value)
      }
    );
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-empty string.`
    );
  }

  return normalized;
}

function resolveOptionalString(
  value: unknown,
  label: string,
  fallback: string
): string {
  if (typeof value === "undefined") {
    return fallback;
  }

  return resolveRequiredString(value, label);
}

function resolvePositiveInteger(
  value: unknown,
  fallback: number,
  label: string
): number {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (!isFiniteInteger(value) || value <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer.`,
      {
        received: value
      }
    );
  }

  return value;
}

function resolveNonNegativeInteger(
  value: unknown,
  fallback: number,
  label: string
): number {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (!isFiniteInteger(value) || value < 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-negative integer.`,
      {
        received: value
      }
    );
  }

  return value;
}

function resolveBooleanOption(
  value: unknown,
  fallback: boolean,
  label: string
): boolean {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a boolean when provided.`,
      {
        received_type: describeValueType(value)
      }
    );
  }

  return value;
}

function normalizeAlertThresholds(
  input: KeepAliveOptions["alertThresholds"]
): Required<KeepAliveAlertThresholds> {
  if (typeof input === "undefined") {
    return Object.freeze({
      cookieExpiringWithinMs: DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS,
      reconnectsInWindow: Object.freeze({ ...DEFAULT_RECONNECT_ALERT_THRESHOLD })
    });
  }

  if (!isRecord(input)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "alertThresholds must be an object when provided.",
      {
        received_type: describeValueType(input)
      }
    );
  }

  const reconnectsInWindowInput = input.reconnectsInWindow;
  if (
    typeof reconnectsInWindowInput !== "undefined" &&
    !isRecord(reconnectsInWindowInput)
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "alertThresholds.reconnectsInWindow must be an object when provided.",
      {
        received_type: describeValueType(reconnectsInWindowInput)
      }
    );
  }

  return Object.freeze({
    cookieExpiringWithinMs: resolveNonNegativeInteger(
      input.cookieExpiringWithinMs,
      DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS,
      "alertThresholds.cookieExpiringWithinMs"
    ),
    reconnectsInWindow: Object.freeze({
      count: resolvePositiveInteger(
        reconnectsInWindowInput?.count,
        DEFAULT_RECONNECT_ALERT_THRESHOLD.count,
        "alertThresholds.reconnectsInWindow.count"
      ),
      windowMs: resolvePositiveInteger(
        reconnectsInWindowInput?.windowMs,
        DEFAULT_RECONNECT_ALERT_THRESHOLD.windowMs,
        "alertThresholds.reconnectsInWindow.windowMs"
      )
    })
  });
}

function normalizeNightHours(
  input: KeepAliveOptions["nightHours"]
): NonNullable<KeepAliveOptions["nightHours"]> {
  if (typeof input === "undefined") {
    return Object.freeze({
      startHour: 0,
      endHour: 6
    });
  }

  if (!isRecord(input)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "nightHours must be an object when provided.",
      {
        received_type: describeValueType(input)
      }
    );
  }

  const startHour = resolveNonNegativeInteger(
    input.startHour,
    0,
    "nightHours.startHour"
  );
  const endHour = resolveNonNegativeInteger(input.endHour, 6, "nightHours.endHour");
  if (startHour > 23 || endHour > 23) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "nightHours.startHour and nightHours.endHour must be between 0 and 23.",
      {
        start_hour: startHour,
        end_hour: endHour
      }
    );
  }

  return Object.freeze({
    startHour,
    endHour
  });
}

function normalizeSessionStore(
  sessionStore: KeepAliveOptions["sessionStore"]
): Readonly<KeepAliveSessionStoreLike> | undefined {
  if (typeof sessionStore === "undefined") {
    return undefined;
  }

  if (!isRecord(sessionStore)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "sessionStore must be an object when provided.",
      {
        received_type: describeValueType(sessionStore)
      }
    );
  }

  if (
    typeof sessionStore.restoreToContext !== "undefined" &&
    typeof sessionStore.restoreToContext !== "function"
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "sessionStore.restoreToContext must be a function when provided."
    );
  }

  if (
    typeof sessionStore.saveWithBackups !== "undefined" &&
    typeof sessionStore.saveWithBackups !== "function"
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "sessionStore.saveWithBackups must be a function when provided."
    );
  }

  const restoreToContext =
    typeof sessionStore.restoreToContext === "function"
      ? (sessionStore.restoreToContext.bind(
          sessionStore
        ) as NonNullable<KeepAliveSessionStoreLike["restoreToContext"]>)
      : undefined;
  const saveWithBackups =
    typeof sessionStore.saveWithBackups === "function"
      ? (sessionStore.saveWithBackups.bind(
          sessionStore
        ) as NonNullable<KeepAliveSessionStoreLike["saveWithBackups"]>)
      : undefined;

  if (!restoreToContext && !saveWithBackups) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "sessionStore must provide restoreToContext and/or saveWithBackups when provided."
    );
  }

  return Object.freeze({
    ...(restoreToContext ? { restoreToContext } : {}),
    ...(saveWithBackups ? { saveWithBackups } : {})
  });
}

function validateKeepAlivePool(pool: CDPConnectionPool): void {
  if (!isRecord(pool) || typeof pool.acquire !== "function") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "keepalive pool must expose an acquire() function."
    );
  }

  if (
    "invalidate" in pool &&
    typeof pool.invalidate !== "undefined" &&
    typeof pool.invalidate !== "function"
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "keepalive pool.invalidate must be a function when provided."
    );
  }
}

function isFullHealthStatus(value: unknown): value is FullHealthStatus {
  if (!isRecord(value)) {
    return false;
  }

  const browser = value.browser;
  const session = value.session;
  return (
    isRecord(browser) &&
    typeof browser.healthy === "boolean" &&
    typeof browser.browserConnected === "boolean" &&
    typeof browser.pageResponsive === "boolean" &&
    typeof browser.checkedAt === "string" &&
    isRecord(session) &&
    typeof session.authenticated === "boolean" &&
    typeof session.currentUrl === "string" &&
    typeof session.reason === "string" &&
    typeof session.checkedAt === "string" &&
    typeof session.checkpointDetected === "boolean" &&
    typeof session.cookieExpiringSoon === "boolean" &&
    typeof session.loginWallDetected === "boolean" &&
    (typeof session.nextCookieExpiryAt === "string" ||
      session.nextCookieExpiryAt === null) &&
    typeof session.rateLimited === "boolean" &&
    (typeof session.sessionCookieFingerprint === "string" ||
      session.sessionCookieFingerprint === null) &&
    typeof session.sessionCookiePresent === "boolean" &&
    Array.isArray(session.sessionCookies)
  );
}

function assertFullHealthStatus(value: unknown): asserts value is FullHealthStatus {
  if (isFullHealthStatus(value)) {
    return;
  }

  throw new LinkedInAssistantError(
    "UNKNOWN",
    "Keepalive health check returned an invalid status.",
    {
      received_type: describeValueType(value),
      has_browser: isRecord(value) && isRecord(value.browser),
      has_session: isRecord(value) && isRecord(value.session)
    }
  );
}

function isConnectionLease(value: unknown): value is ConnectionLease {
  return (
    isRecord(value) &&
    "context" in value &&
    value.context !== null &&
    typeof value.release === "function"
  );
}

function assertConnectionLease(value: unknown): asserts value is ConnectionLease {
  if (isConnectionLease(value)) {
    return;
  }

  throw new LinkedInAssistantError(
    "UNKNOWN",
    "Keepalive connection pool returned an invalid lease.",
    {
      received_type: describeValueType(value)
    }
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

function isNightHour(
  hour: number,
  nightHours: NonNullable<KeepAliveOptions["nightHours"]>
): boolean {
  if (nightHours.startHour === nightHours.endHour) {
    return false;
  }

  if (nightHours.startHour < nightHours.endHour) {
    return hour >= nightHours.startHour && hour < nightHours.endHour;
  }

  return hour >= nightHours.startHour || hour < nightHours.endHour;
}

function isTransientConnectionError(error: unknown): boolean {
  const normalized = getErrorMessage(error).toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    "browser has been closed",
    "connection refused",
    "connection reset",
    "eai_again",
    "err_connection_reset",
    "err_internet_disconnected",
    "err_network_changed",
    "econnrefused",
    "net::err",
    "network",
    "socket hang up",
    "temporarily unavailable",
    "target closed",
    "timed out",
    "websocket"
  ].some((token) => normalized.includes(token));
}

function millisecondsUntil(isoTimestamp: string | null | undefined): number | null {
  if (!isoTimestamp) {
    return null;
  }

  const timestampMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }

  return timestampMs - Date.now();
}

function isTimestampWithinWindow(
  isoTimestamp: string | null | undefined,
  windowMs: number
): boolean {
  const remainingMs = millisecondsUntil(isoTimestamp);
  return remainingMs !== null && remainingMs > 0 && remainingMs <= windowMs;
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];
  if (existingPage) {
    return existingPage;
  }

  return context.newPage();
}

async function navigateToKeepAlivePage(page: Page, url: string): Promise<void> {
  await page.goto(url, KEEP_ALIVE_PAGE_GOTO_OPTIONS);
}

/**
 * Coordinates periodic LinkedIn health checks, low-risk background activity,
 * session snapshot persistence, and recovery attempts for a CDP-attached
 * browser session.
 *
 * Emits high-level events such as `healthy`, `session-expired`,
 * `browser-disconnected`, `health-event`, and `error`.
 */
export class SessionKeepAliveService extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private tickInFlight = false;
  private generation = 0;
  private consecutiveFailures = 0;
  private healthyTickCount = 0;
  private declaredDead = false;
  private networkInterruptedAtMs: number | undefined;
  private rateLimitCooldownUntilMs: number | undefined;
  private activityPatternIndex = 0;
  private readonly eventLog: KeepAliveEvent[] = [];
  private readonly reconnectTimestampsMs: number[] = [];
  private readonly activeAlerts = new Set<string>();
  private backupSessions: SessionSnapshot[] = [];
  private metrics: KeepAliveMetrics = this.createInitialMetrics();

  private readonly activityEveryHealthyTicks: number;
  private readonly activitySimulationEnabled: boolean;
  private readonly alertThresholds: Required<KeepAliveAlertThresholds>;
  private readonly cookieRefreshLeadMs: number;
  private readonly idleWarmupThresholdMs: number;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly maxBackupSessions: number;
  private readonly maxConsecutiveFailures: number;
  private readonly maxHealthLogEntries: number;
  private readonly networkGracePeriodMs: number;
  private readonly networkRetryIntervalMs: number;
  private readonly nightActivityEveryHealthyTicks: number;
  private readonly nightHours: NonNullable<KeepAliveOptions["nightHours"]>;
  private readonly cdpUrl: string;
  private readonly sessionName: string;
  private readonly sessionRefreshEnabled: boolean;
  private readonly sessionStore: Readonly<KeepAliveSessionStoreLike> | undefined;

  constructor(
    private readonly pool: CDPConnectionPool,
    options: KeepAliveOptions
  ) {
    super();
    validateKeepAlivePool(pool);
    if (!isRecord(options)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "keepalive options must be an object.",
        {
          received_type: describeValueType(options)
        }
      );
    }

    this.on("error", () => undefined);

    this.activityEveryHealthyTicks = resolvePositiveInteger(
      options.activityEveryHealthyTicks,
      DEFAULT_ACTIVITY_EVERY_HEALTHY_TICKS,
      "activityEveryHealthyTicks"
    );
    this.activitySimulationEnabled = resolveBooleanOption(
      options.activitySimulationEnabled,
      true,
      "activitySimulationEnabled"
    );
    this.alertThresholds = normalizeAlertThresholds(options.alertThresholds);
    this.cookieRefreshLeadMs = resolveNonNegativeInteger(
      options.cookieRefreshLeadMs,
      DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS,
      "cookieRefreshLeadMs"
    );
    this.idleWarmupThresholdMs = resolveNonNegativeInteger(
      options.idleWarmupThresholdMs,
      DEFAULT_IDLE_WARMUP_THRESHOLD_MS,
      "idleWarmupThresholdMs"
    );
    this.intervalMs = resolvePositiveInteger(options.intervalMs, 300_000, "intervalMs");
    this.jitterMs = resolveNonNegativeInteger(options.jitterMs, 30_000, "jitterMs");
    this.maxBackupSessions = resolvePositiveInteger(
      options.maxBackupSessions,
      DEFAULT_MAX_BACKUP_SESSIONS,
      "maxBackupSessions"
    );
    this.maxConsecutiveFailures = resolvePositiveInteger(
      options.maxConsecutiveFailures,
      5,
      "maxConsecutiveFailures"
    );
    this.maxHealthLogEntries = Math.max(
      10,
      resolvePositiveInteger(
        options.maxHealthLogEntries,
        DEFAULT_MAX_HEALTH_LOG_ENTRIES,
        "maxHealthLogEntries"
      )
    );
    this.networkGracePeriodMs = resolveNonNegativeInteger(
      options.networkGracePeriodMs,
      DEFAULT_NETWORK_GRACE_PERIOD_MS,
      "networkGracePeriodMs"
    );
    this.networkRetryIntervalMs = resolvePositiveInteger(
      options.networkRetryIntervalMs,
      DEFAULT_NETWORK_RETRY_INTERVAL_MS,
      "networkRetryIntervalMs"
    );
    this.nightActivityEveryHealthyTicks = resolvePositiveInteger(
      options.nightActivityEveryHealthyTicks,
      DEFAULT_NIGHT_ACTIVITY_EVERY_HEALTHY_TICKS,
      "nightActivityEveryHealthyTicks"
    );
    this.nightHours = normalizeNightHours(options.nightHours);
    this.cdpUrl = resolveRequiredString(options.cdpUrl, "cdpUrl");
    this.sessionName = resolveOptionalString(
      options.sessionName,
      "sessionName",
      "default"
    );
    this.sessionRefreshEnabled = resolveBooleanOption(
      options.sessionRefreshEnabled,
      true,
      "sessionRefreshEnabled"
    );
    this.sessionStore = normalizeSessionStore(options.sessionStore);
  }

  /**
   * Starts the keepalive loop. Calling this while already running is a no-op.
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.generation += 1;
    this.clearTimer();
    this.running = true;
    this.consecutiveFailures = 0;
    this.healthyTickCount = 0;
    this.declaredDead = false;
    this.networkInterruptedAtMs = undefined;
    this.rateLimitCooldownUntilMs = undefined;
    this.activityPatternIndex = 0;
    this.eventLog.length = 0;
    this.reconnectTimestampsMs.length = 0;
    this.activeAlerts.clear();
    this.backupSessions = [];
    this.metrics = this.createInitialMetrics(new Date().toISOString());
    this.scheduleNextTick(this.generation);
  }

  /**
   * Stops future keepalive ticks and invalidates any in-flight generation.
   */
  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.running = false;
  }

  /**
   * Returns whether the keepalive loop is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the current consecutive-failure count.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns a defensive copy of the in-memory health-event log.
   */
  getHealthLog(): KeepAliveEvent[] {
    return [...this.eventLog];
  }

  /**
   * Returns the latest derived keepalive metrics and active alerts.
   */
  getMetrics(): KeepAliveMetrics {
    void this.getRateLimitDelayMs();

    return {
      ...this.metrics,
      activeAlerts: [...this.activeAlerts],
      backupSessionCount: this.backupSessions.length,
      consecutiveFailures: this.consecutiveFailures,
      reconnectCountInWindow: this.reconnectTimestampsMs.length,
      sessionUptimeMs: this.getSessionUptimeMs()
    };
  }

  private createInitialMetrics(startedAt?: string): KeepAliveMetrics {
    return {
      activeAlerts: [],
      authenticated: false,
      backupSessionCount: 0,
      browserConnected: false,
      browserHealthy: false,
      consecutiveFailures: 0,
      currentReason: "",
      currentUrl: "",
      nextCookieExpiryAt: null,
      reconnectCount: 0,
      reconnectCountInWindow: 0,
      sessionCookiePresent: false,
      sessionUptimeMs: 0,
      ...(startedAt ? { startedAt } : {})
    };
  }

  private getSessionUptimeMs(): number {
    if (!this.metrics.startedAt || !this.metrics.lastHealthyAt) {
      return this.metrics.sessionUptimeMs;
    }

    const startedAtMs = Date.parse(this.metrics.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return this.metrics.sessionUptimeMs;
    }

    return Math.max(0, Date.now() - startedAtMs);
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private getRateLimitDelayMs(): number | null {
    if (this.rateLimitCooldownUntilMs === undefined) {
      return null;
    }

    const remainingMs = this.rateLimitCooldownUntilMs - Date.now();
    if (remainingMs > 0) {
      return remainingMs;
    }

    this.rateLimitCooldownUntilMs = undefined;
    this.activeAlerts.delete("rate-limit-cooldown");
    return null;
  }

  private activateRateLimitCooldown(): number {
    const retryAfterMs = Math.max(
      this.intervalMs * RATE_LIMIT_BACKOFF_INTERVAL_MULTIPLIER,
      this.networkRetryIntervalMs * RATE_LIMIT_BACKOFF_RETRY_MULTIPLIER
    );
    const retryAtMs = Date.now() + retryAfterMs;
    this.rateLimitCooldownUntilMs = Math.max(
      this.rateLimitCooldownUntilMs ?? 0,
      retryAtMs
    );
    this.updateAlert(
      "rate-limit-cooldown",
      true,
      "LinkedIn rate-limit challenge detected; slowing keepalive retries",
      {
        retryAfterMs,
        retryAt: new Date(this.rateLimitCooldownUntilMs).toISOString()
      }
    );
    return retryAfterMs;
  }

  private scheduleNextTick(generation: number): void {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    const usingRetryCadence = this.networkInterruptedAtMs !== undefined;
    const rateLimitDelayMs = this.getRateLimitDelayMs();
    const jitter =
      usingRetryCadence || rateLimitDelayMs !== null
        ? 0
        : (Math.random() * 2 - 1) * this.jitterMs;
    const baseDelay = Math.max(
      usingRetryCadence ? this.networkRetryIntervalMs : this.intervalMs,
      rateLimitDelayMs ?? 0
    );
    const delay = Math.max(1_000, baseDelay + jitter);

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runTick(generation).finally(() => {
        this.scheduleNextTick(generation);
      });
    }, delay);
  }

  private async runTick(generation: number): Promise<void> {
    if (!this.isGenerationCurrent(generation) || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    this.metrics.lastTickAt = new Date().toISOString();
    let lease: ConnectionLease | undefined;

    try {
      const acquiredLease = await this.pool.acquire(this.cdpUrl);
      assertConnectionLease(acquiredLease);
      lease = acquiredLease;
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      const healthResult = await checkFullHealth(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      assertFullHealthStatus(healthResult);
      await this.processHealthResult(healthResult, lease, generation);
    } catch (error) {
      if (this.isGenerationCurrent(generation)) {
        await this.handleTickError(error, generation);
      }
    } finally {
      this.releaseLease(lease);
      this.tickInFlight = false;
    }
  }

  private async processHealthResult(
    health: FullHealthStatus,
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    this.updateMetricsFromHealth(health);

    if (health.browser.healthy && health.session.authenticated) {
      await this.handleHealthyState(health, lease, generation);
      return;
    }

    if (!health.browser.browserConnected) {
      this.emitKeepAliveEvent({
        type: "browser-disconnected",
        health,
        detail: "Browser connection lost",
        metadata: {
          currentUrl: health.session.currentUrl,
          sessionReason: health.session.reason
        }
      });
      this.emit("browser-disconnected", health);
      await this.handleNetworkInterruption("Browser connection lost", generation);
      return;
    }

    if (!health.session.authenticated) {
      await this.handleUnauthenticatedState(health, lease, generation);
      return;
    }

    this.recordFailure();
    this.emitError(new Error("Health check failed."));
  }

  private updateMetricsFromHealth(health: FullHealthStatus): void {
    this.metrics.authenticated = health.session.authenticated;
    this.metrics.browserConnected = health.browser.browserConnected;
    this.metrics.browserHealthy = health.browser.healthy;
    this.metrics.currentReason = health.session.reason;
    this.metrics.currentUrl = health.session.currentUrl;
    this.metrics.nextCookieExpiryAt = health.session.nextCookieExpiryAt;
    this.metrics.sessionCookiePresent = health.session.sessionCookiePresent;
    this.metrics.sessionUptimeMs = this.getSessionUptimeMs();
  }

  private clearFailureState(): void {
    this.consecutiveFailures = 0;
    this.declaredDead = false;
    this.rateLimitCooldownUntilMs = undefined;
    this.metrics.consecutiveFailures = 0;
    this.activeAlerts.delete("rate-limit-cooldown");
  }

  private markSessionHealthy(): void {
    this.clearFailureState();
    this.metrics.lastHealthyAt = new Date().toISOString();
    this.metrics.sessionUptimeMs = this.getSessionUptimeMs();
  }

  private async handleHealthyState(
    health: FullHealthStatus,
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    this.healthyTickCount += 1;
    this.markSessionHealthy();

    this.emitKeepAliveEvent({
      type: "healthy",
      health,
      metadata: {
        currentUrl: health.session.currentUrl,
        nextCookieExpiryAt: health.session.nextCookieExpiryAt
      }
    });
    this.emit("healthy", health);

    this.recoverFromNetworkInterruption(health);
    await this.captureSessionSnapshot(lease, health, generation);
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    await this.cleanupOrphanPages(lease, generation);
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (this.sessionRefreshEnabled && this.shouldRefreshCookies(health)) {
      await this.refreshSession(lease, "proactive", generation);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
    }

    if (this.activitySimulationEnabled && this.shouldSimulateActivity()) {
      await this.maybeWarmup(lease, generation);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      await this.simulateActivity(lease, generation);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }
    }

    this.evaluateAlerts();
  }

  private shouldRefreshCookies(health: FullHealthStatus): boolean {
    return isTimestampWithinWindow(
      health.session.nextCookieExpiryAt,
      this.cookieRefreshLeadMs
    );
  }

  private shouldSimulateActivity(): boolean {
    const cadence = isNightHour(new Date().getHours(), this.nightHours)
      ? this.nightActivityEveryHealthyTicks
      : this.activityEveryHealthyTicks;

    return this.healthyTickCount % cadence === 0;
  }

  private async handleUnauthenticatedState(
    health: FullHealthStatus,
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    this.emitKeepAliveEvent({
      type: "session-expired",
      health,
      detail: "LinkedIn session expired",
      metadata: {
        currentUrl: health.session.currentUrl,
        reason: health.session.reason,
        checkpointDetected: health.session.checkpointDetected,
        loginWallDetected: health.session.loginWallDetected,
        rateLimited: health.session.rateLimited,
        nextCookieExpiryAt: health.session.nextCookieExpiryAt
      }
    });
    this.emit("session-expired", health);

    if (health.session.loginWallDetected) {
      this.emitKeepAliveEvent({
        type: "login-wall-detected",
        health,
        detail: "LinkedIn login wall detected mid-session",
        metadata: {
          currentUrl: health.session.currentUrl,
          reason: health.session.reason
        }
      });
    }

    let recovered = false;
    const shouldAttemptSoftRefresh =
      this.sessionRefreshEnabled &&
      !health.session.rateLimited &&
      !health.session.checkpointDetected &&
      (health.session.sessionCookiePresent || this.shouldRefreshCookies(health));

    if (shouldAttemptSoftRefresh) {
      recovered = await this.attemptSoftRefresh(lease, health, generation);
    }

    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (!recovered && !health.session.rateLimited && !health.session.checkpointDetected) {
      recovered = await this.restoreBackupSession(lease, generation);
    }

    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (recovered) {
      this.clearFailureState();
      return;
    }

    const retryAfterMs = health.session.rateLimited
      ? this.activateRateLimitCooldown()
      : undefined;
    this.recordFailure();
    this.metrics.lastLoginRequiredAt = new Date().toISOString();
    this.emitKeepAliveEvent({
      type: "manual-login-required",
      health,
      detail: "Manual LinkedIn login is required to continue",
      metadata: {
        currentUrl: health.session.currentUrl,
        reason: health.session.reason,
        checkpointDetected: health.session.checkpointDetected,
        nextCookieExpiryAt: health.session.nextCookieExpiryAt,
        rateLimited: health.session.rateLimited,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        sessionCookiePresent: health.session.sessionCookiePresent,
        whatWasHappening: health.session.loginWallDetected
          ? "soft re-auth after LinkedIn login wall"
          : "session recovery after authentication loss"
      }
    });
    this.evaluateAlerts();
  }

  private async handleNetworkInterruption(
    detail: string,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    const firstInterruption = this.networkInterruptedAtMs === undefined;
    if (firstInterruption) {
      this.networkInterruptedAtMs = Date.now();
      this.metrics.networkInterruptedAt = new Date(
        this.networkInterruptedAtMs
      ).toISOString();
      this.emitKeepAliveEvent({
        type: "network-interruption",
        detail,
        metadata: {
          retryIntervalMs: this.networkRetryIntervalMs,
          gracePeriodMs: this.networkGracePeriodMs
        }
      });
    }

    const recovered = await this.attemptReconnect(generation);
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (recovered) {
      return;
    }

    if (!this.isWithinNetworkGracePeriod()) {
      this.recordFailure();
    }
  }

  private isWithinNetworkGracePeriod(): boolean {
    return (
      this.networkInterruptedAtMs !== undefined &&
      Date.now() - this.networkInterruptedAtMs < this.networkGracePeriodMs
    );
  }

  private recoverFromNetworkInterruption(health: FullHealthStatus): void {
    if (this.networkInterruptedAtMs === undefined) {
      return;
    }

    this.emitKeepAliveEvent({
      type: "network-recovered",
      health,
      detail: "Recovered from transient network interruption"
    });
    this.networkInterruptedAtMs = undefined;
    delete this.metrics.networkInterruptedAt;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    this.metrics.consecutiveFailures = this.consecutiveFailures;

    if (
      !this.declaredDead &&
      this.consecutiveFailures >= this.maxConsecutiveFailures
    ) {
      this.declaredDead = true;
      this.emitKeepAliveEvent({
        type: "dead",
        detail: `Declared dead after ${this.consecutiveFailures} consecutive failures`,
        metadata: {
          maxConsecutiveFailures: this.maxConsecutiveFailures
        }
      });
    }
  }

  private async attemptReconnect(generation: number): Promise<boolean> {
    if (!this.isGenerationCurrent(generation)) {
      return false;
    }

    this.emitKeepAliveEvent({
      type: "reconnect-attempt",
      detail: "Attempting to reconnect to browser",
      metadata: {
        inNetworkGracePeriod: this.isWithinNetworkGracePeriod(),
        retryIntervalMs: this.networkRetryIntervalMs
      }
    });

    let lease: ConnectionLease | undefined;
    try {
      await this.pool.invalidate?.(this.cdpUrl);
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      const acquiredLease = await this.pool.acquire(this.cdpUrl);
      assertConnectionLease(acquiredLease);
      lease = acquiredLease;
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      const healthResult = await checkFullHealth(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      assertFullHealthStatus(healthResult);
      const health = healthResult;
      this.updateMetricsFromHealth(health);

      if (health.browser.healthy) {
        this.reconnectTimestampsMs.push(Date.now());
        this.trimReconnectWindow();
        this.metrics.reconnectCount += 1;
        this.metrics.reconnectCountInWindow = this.reconnectTimestampsMs.length;
        this.emitKeepAliveEvent({
          type: "reconnect-success",
          health,
          detail: health.session.authenticated
            ? "Successfully reconnected to browser"
            : "Reconnected to browser, but session still needs recovery",
          metadata: {
            reconnectCount: this.metrics.reconnectCount,
            authenticated: health.session.authenticated
          }
        });

        if (health.session.authenticated) {
          this.markSessionHealthy();
          this.recoverFromNetworkInterruption(health);
          await this.captureSessionSnapshot(lease, health, generation);
          if (!this.isGenerationCurrent(generation)) {
            return false;
          }
        }

        this.evaluateAlerts();
        return health.session.authenticated;
      }

      this.emitKeepAliveEvent({
        type: "reconnect-failed",
        health,
        detail: "Reconnected, but browser is still unhealthy"
      });
    } catch (error) {
      if (this.isGenerationCurrent(generation)) {
        this.emitKeepAliveEvent({
          type: "reconnect-failed",
          detail: getErrorMessage(error)
        });
      }
    } finally {
      this.releaseLease(lease);
    }

    return false;
  }

  private async attemptSoftRefresh(
    lease: ConnectionLease,
    health: FullHealthStatus,
    generation: number
  ): Promise<boolean> {
    if (!this.isGenerationCurrent(generation)) {
      return false;
    }

    this.emitKeepAliveEvent({
      type: "soft-reauth-attempt",
      health,
      detail: "Attempting to recover the active session without manual login"
    });

    const refreshedHealth = await this.refreshSession(
      lease,
      "soft-reauth",
      generation
    );
    if (!this.isGenerationCurrent(generation)) {
      return false;
    }

    if (refreshedHealth?.session.authenticated) {
      this.emitKeepAliveEvent({
        type: "soft-reauth-success",
        health: refreshedHealth,
        detail: "Recovered the LinkedIn session without manual login"
      });
      return true;
    }

    this.emitKeepAliveEvent({
      type: "soft-reauth-failed",
      health: refreshedHealth ?? health,
      detail: "Soft session refresh did not restore authentication"
    });
    return false;
  }

  private async refreshSession(
    lease: ConnectionLease,
    reason: "proactive" | "soft-reauth",
    generation: number
  ): Promise<FullHealthStatus | null> {
    if (!this.isGenerationCurrent(generation)) {
      return null;
    }

    try {
      const page = await getOrCreatePage(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return null;
      }

      await navigateToKeepAlivePage(page, LINKEDIN_KEEP_ALIVE_URLS.feed);
      if (!this.isGenerationCurrent(generation)) {
        return null;
      }

      this.metrics.lastCookieRefreshAt = new Date().toISOString();
      if (reason === "proactive") {
        this.emitKeepAliveEvent({
          type: "cookie-refresh",
          detail: "Proactively refreshed near-expiry LinkedIn session cookies"
        });
      }

      const refreshedHealthResult = await checkFullHealth(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return null;
      }

      assertFullHealthStatus(refreshedHealthResult);
      const refreshedHealth = refreshedHealthResult;
      this.updateMetricsFromHealth(refreshedHealth);
      if (refreshedHealth.session.authenticated) {
        this.markSessionHealthy();
        await this.captureSessionSnapshot(lease, refreshedHealth, generation);
        if (!this.isGenerationCurrent(generation)) {
          return null;
        }
      }

      return refreshedHealth;
    } catch {
      return null;
    }
  }

  private async attemptSessionRestore(
    lease: ConnectionLease,
    attempt: SessionRestoreAttempt,
    generation: number
  ): Promise<boolean> {
    if (!this.isGenerationCurrent(generation)) {
      return false;
    }

    this.emitKeepAliveEvent({
      type: "soft-reauth-attempt",
      detail: attempt.attemptDetail,
      metadata: attempt.attemptMetadata
    });

    try {
      await attempt.restore();
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      const restoredHealthResult = await checkFullHealth(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      assertFullHealthStatus(restoredHealthResult);
      const restoredHealth = restoredHealthResult;
      this.updateMetricsFromHealth(restoredHealth);
      if (!restoredHealth.session.authenticated) {
        return false;
      }

      await this.captureSessionSnapshot(lease, restoredHealth, generation);
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      this.emitKeepAliveEvent({
        type: "soft-reauth-success",
        health: restoredHealth,
        detail: attempt.successDetail,
        metadata: attempt.successMetadata
      });
      return true;
    } catch {
      return false;
    }
  }

  private shouldCaptureSessionSnapshot(health: FullHealthStatus): boolean {
    const knownFingerprint = health.session.sessionCookieFingerprint;

    return (
      this.backupSessions.length === 0 ||
      knownFingerprint == null ||
      knownFingerprint !== this.metrics.lastSessionFingerprint ||
      this.shouldRefreshCookies(health)
    );
  }

  private async captureSessionSnapshot(
    lease: ConnectionLease,
    health: FullHealthStatus,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (typeof lease.context.storageState !== "function") {
      return;
    }

    if (!this.shouldCaptureSessionSnapshot(health)) {
      return;
    }

    try {
      const storageState = await lease.context.storageState();
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      const fingerprint = getLinkedInSessionFingerprint(storageState);
      const snapshot: SessionSnapshot = {
        capturedAt: new Date().toISOString(),
        fingerprint,
        nextCookieExpiryAt: health.session.nextCookieExpiryAt,
        storageState
      };

      const fingerprintChanged =
        this.metrics.lastSessionFingerprint !== undefined &&
        this.metrics.lastSessionFingerprint !== fingerprint;
      this.metrics.lastSessionFingerprint = fingerprint;
      this.backupSessions = [
        snapshot,
        ...this.backupSessions.filter(
          (candidate) => candidate.fingerprint !== fingerprint
        )
      ].slice(0, this.maxBackupSessions);
      this.metrics.backupSessionCount = this.backupSessions.length;

      if (fingerprintChanged) {
        this.emitKeepAliveEvent({
          type: "session-rotated",
          health,
          detail: "LinkedIn rotated session tokens; refreshed backup state",
          metadata: {
            backupSessionCount: this.backupSessions.length,
            nextCookieExpiryAt: health.session.nextCookieExpiryAt
          }
        });
      }

      if (this.sessionStore?.saveWithBackups) {
        await this.sessionStore.saveWithBackups(
          this.sessionName,
          storageState,
          {
            maxBackups: this.maxBackupSessions
          }
        );
        if (!this.isGenerationCurrent(generation)) {
          return;
        }

        this.emitKeepAliveEvent({
          type: "session-persisted",
          detail: `Persisted session snapshot for ${this.sessionName}`,
          metadata: {
            backupSessionCount: this.maxBackupSessions,
            sessionName: this.sessionName
          }
        });
      }
    } catch {
      // Snapshot capture is best-effort; failures should not break keepalive.
    }
  }

  private async restoreBackupSession(
    lease: ConnectionLease,
    generation: number
  ): Promise<boolean> {
    if (!this.isGenerationCurrent(generation)) {
      return false;
    }

    const sessionStore = this.sessionStore;
    if (sessionStore?.restoreToContext) {
      const restoreToContext = sessionStore.restoreToContext;
      const restoredFromSessionStore = await this.attemptSessionRestore(lease, {
        attemptDetail: `Attempting stored-session restore for ${this.sessionName}`,
        attemptMetadata: {
          sessionName: this.sessionName,
          source: "session-store"
        },
        restore: () =>
          restoreToContext(lease.context, this.sessionName, {
            allowExpired: false,
            maxBackups: this.maxBackupSessions
          }),
        successDetail: `Recovered authentication from stored session ${this.sessionName}`,
        successMetadata: {
          source: "session-store"
        }
      }, generation);

      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      if (restoredFromSessionStore) {
        return true;
      }
    }

    for (const snapshot of this.backupSessions) {
      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      const restoredFromMemory = await this.attemptSessionRestore(lease, {
        attemptDetail: "Attempting in-memory session restore",
        attemptMetadata: {
          capturedAt: snapshot.capturedAt,
          nextCookieExpiryAt: snapshot.nextCookieExpiryAt,
          source: "memory"
        },
        restore: () =>
          restoreLinkedInSessionCookies(lease.context, snapshot.storageState),
        successDetail: "Recovered authentication from in-memory backup session",
        successMetadata: {
          source: "memory",
          capturedAt: snapshot.capturedAt
        }
      }, generation);

      if (!this.isGenerationCurrent(generation)) {
        return false;
      }

      if (restoredFromMemory) {
        return true;
      }
    }

    return false;
  }

  private async maybeWarmup(
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    if (!this.metrics.lastActivityAt) {
      return;
    }

    const lastActivityAtMs = Date.parse(this.metrics.lastActivityAt);
    if (!Number.isFinite(lastActivityAtMs)) {
      return;
    }

    if (Date.now() - lastActivityAtMs < this.idleWarmupThresholdMs) {
      return;
    }

    try {
      const page = await getOrCreatePage(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      await navigateToKeepAlivePage(page, LINKEDIN_KEEP_ALIVE_URLS.feed);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      await humanize(page, { fast: true }).idle();
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      this.metrics.lastWarmupAt = new Date().toISOString();
      this.emitKeepAliveEvent({
        type: "warmup",
        detail: "Performed a gentle session warmup after extended idle time"
      });
    } catch {
      // Warmup is best-effort; failures should not break keepalive.
    }
  }

  private async simulateActivity(
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    try {
      const page = await getOrCreatePage(lease.context);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      const hp = humanize(page, { fast: true });
      const pattern =
        ACTIVITY_PATTERNS[
          this.activityPatternIndex % ACTIVITY_PATTERNS.length
        ] ?? ACTIVITY_PATTERNS[0];
      const activity = ACTIVITY_PATTERN_DETAILS[pattern];
      this.activityPatternIndex += 1;

      await navigateToKeepAlivePage(page, activity.url);
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      if (activity.shouldScrollDown) {
        await hp.scrollDown();
        if (!this.isGenerationCurrent(generation)) {
          return;
        }
      }
      await hp.idle();
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      this.metrics.lastActivityAt = new Date().toISOString();
      this.emitKeepAliveEvent({
        type: "activity",
        detail: activity.detail,
        metadata: {
          pattern
        }
      });
    } catch {
      // Activity simulation is best-effort; failures are not fatal.
    }
  }

  private async cleanupOrphanPages(
    lease: ConnectionLease,
    generation: number
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) {
      return;
    }

    const pages = lease.context.pages();
    if (pages.length <= 1) {
      return;
    }

    let closedCount = 0;
    for (const page of pages.slice(1)) {
      if (!this.isGenerationCurrent(generation)) {
        return;
      }

      const currentUrl = page.url();
      const looksOrphaned =
        currentUrl.length === 0 ||
        currentUrl === "about:blank" ||
        currentUrl.startsWith("chrome-error://");
      if (!looksOrphaned || typeof page.close !== "function") {
        continue;
      }

      try {
        await page.close();
        closedCount += 1;
      } catch {
        // Keepalive should continue even if tab cleanup fails.
      }
    }

    if (closedCount > 0) {
      this.emitKeepAliveEvent({
        type: "tab-cleanup",
        detail: `Closed ${closedCount} orphaned page${closedCount === 1 ? "" : "s"}`,
        metadata: {
          closedCount,
          remainingPages: Math.max(0, pages.length - closedCount)
        }
      });
    }
  }

  private trimReconnectWindow(): void {
    const windowMs = this.alertThresholds.reconnectsInWindow.windowMs;
    const cutoffMs = Date.now() - windowMs;
    while ((this.reconnectTimestampsMs[0] ?? Number.POSITIVE_INFINITY) < cutoffMs) {
      this.reconnectTimestampsMs.shift();
    }
  }

  private evaluateAlerts(): void {
    this.trimReconnectWindow();
    this.metrics.reconnectCountInWindow = this.reconnectTimestampsMs.length;

    const cookieExpiryMs = millisecondsUntil(this.metrics.nextCookieExpiryAt);
    const cookieAlertActive = isTimestampWithinWindow(
      this.metrics.nextCookieExpiryAt,
      this.alertThresholds.cookieExpiringWithinMs
    );
    this.updateAlert(
      "cookie-expiry",
      cookieAlertActive,
      "LinkedIn session cookie is approaching expiry",
      {
        expiresInMs: cookieExpiryMs,
        nextCookieExpiryAt: this.metrics.nextCookieExpiryAt
      }
    );

    const reconnectAlertActive =
      this.reconnectTimestampsMs.length >= this.alertThresholds.reconnectsInWindow.count;
    this.updateAlert(
      "reconnect-burst",
      reconnectAlertActive,
      "Keepalive has needed repeated reconnects in a short window",
      {
        reconnectsInWindow: this.reconnectTimestampsMs.length,
        windowMs: this.alertThresholds.reconnectsInWindow.windowMs
      }
    );
  }

  private updateAlert(
    key: string,
    active: boolean,
    detail: string,
    metadata: Record<string, unknown>
  ): void {
    if (active && !this.activeAlerts.has(key)) {
      this.activeAlerts.add(key);
      this.emitKeepAliveEvent({
        type: "alert",
        detail,
        metadata: {
          alertKey: key,
          ...metadata
        }
      });
      return;
    }

    if (!active) {
      this.activeAlerts.delete(key);
    }
  }

  private emitKeepAliveEvent(
    partial: Omit<KeepAliveEvent, "timestamp" | "consecutiveFailures"> &
      Partial<Pick<KeepAliveEvent, "timestamp" | "consecutiveFailures">>
  ): void {
    const event: KeepAliveEvent = {
      timestamp: partial.timestamp ?? new Date().toISOString(),
      consecutiveFailures: partial.consecutiveFailures ?? this.consecutiveFailures,
      type: partial.type,
      ...(partial.health === undefined ? {} : { health: partial.health }),
      ...(partial.detail === undefined ? {} : { detail: partial.detail }),
      ...(partial.metadata === undefined ? {} : { metadata: partial.metadata })
    };

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxHealthLogEntries) {
      this.eventLog.splice(0, this.eventLog.length - this.maxHealthLogEntries);
    }

    this.emit("health-event", event);
  }

  private async handleTickError(
    error: unknown,
    generation: number
  ): Promise<void> {
    if (isTransientConnectionError(error)) {
      await this.handleNetworkInterruption(
        getErrorMessage(error) || "Transient network interruption",
        generation
      );
      return;
    }

    this.recordFailure();
    this.emitError(error);
  }

  private emitError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(getErrorMessage(error));
    this.emit("error", normalized);
  }

  private releaseLease(lease: ConnectionLease | undefined): void {
    if (!lease) {
      return;
    }

    try {
      lease.release();
    } catch (error) {
      this.emitError(
        new LinkedInAssistantError(
          "UNKNOWN",
          "Failed to release keepalive browser lease.",
          {
            cause: getErrorMessage(error)
          },
          error instanceof Error ? { cause: error } : undefined
        )
      );
    }
  }
}
