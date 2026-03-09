import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import type {
  LinkedInBrowserStorageState,
  RestoreStoredLinkedInSessionOptions,
  SaveStoredLinkedInSessionOptions
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
import { humanize } from "./humanize.js";

const DEFAULT_NETWORK_GRACE_PERIOD_MS = 5 * 60_000;
const DEFAULT_NETWORK_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_WARMUP_THRESHOLD_MS = 4 * 60 * 60_000;
const DEFAULT_ACTIVITY_EVERY_HEALTHY_TICKS = 3;
const DEFAULT_NIGHT_ACTIVITY_EVERY_HEALTHY_TICKS = 6;
const DEFAULT_MAX_HEALTH_LOG_ENTRIES = 200;
const DEFAULT_MAX_BACKUP_SESSIONS = 3;

const DEFAULT_RECONNECT_ALERT_THRESHOLD = {
  count: 3,
  windowMs: 10 * 60_000
} as const;

const ACTIVITY_PATTERNS = [
  "feed-scroll",
  "notifications-peek",
  "network-peek"
] as const;

interface SessionSnapshot {
  capturedAt: string;
  fingerprint: string;
  nextCookieExpiryAt: string | null;
  storageState: LinkedInBrowserStorageState;
}

interface KeepAliveSessionStoreLike {
  restoreToContext(
    context: BrowserContext,
    sessionName?: string,
    options?: RestoreStoredLinkedInSessionOptions
  ): Promise<unknown>;
  saveWithBackups(
    sessionName: string,
    storageState: LinkedInBrowserStorageState,
    options?: SaveStoredLinkedInSessionOptions
  ): Promise<unknown>;
}

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

export interface KeepAliveEvent {
  type: KeepAliveEventType;
  timestamp: string;
  health?: FullHealthStatus | undefined;
  consecutiveFailures: number;
  detail?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface KeepAliveAlertThresholds {
  cookieExpiringWithinMs?: number;
  reconnectsInWindow?: {
    count: number;
    windowMs: number;
  };
}

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
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return [
    "browser has been closed",
    "connection refused",
    "eai_again",
    "econnrefused",
    "network",
    "socket hang up",
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

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];
  if (existingPage) {
    return existingPage;
  }

  return context.newPage();
}

export class SessionKeepAliveService extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private tickInFlight = false;
  private consecutiveFailures = 0;
  private tickCount = 0;
  private healthyTickCount = 0;
  private declaredDead = false;
  private networkInterruptedAtMs: number | undefined;
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
  private readonly sessionName: string;
  private readonly sessionRefreshEnabled: boolean;

  constructor(
    private readonly pool: CDPConnectionPool,
    private readonly options: KeepAliveOptions
  ) {
    super();
    this.on("error", () => undefined);

    this.activityEveryHealthyTicks = Math.max(
      1,
      options.activityEveryHealthyTicks ?? DEFAULT_ACTIVITY_EVERY_HEALTHY_TICKS
    );
    this.activitySimulationEnabled = options.activitySimulationEnabled ?? true;
    this.alertThresholds = {
      cookieExpiringWithinMs:
        options.alertThresholds?.cookieExpiringWithinMs ??
        DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS,
      reconnectsInWindow:
        options.alertThresholds?.reconnectsInWindow ??
        DEFAULT_RECONNECT_ALERT_THRESHOLD
    };
    this.cookieRefreshLeadMs =
      options.cookieRefreshLeadMs ?? DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS;
    this.idleWarmupThresholdMs =
      options.idleWarmupThresholdMs ?? DEFAULT_IDLE_WARMUP_THRESHOLD_MS;
    this.intervalMs = options.intervalMs ?? 300_000;
    this.jitterMs = options.jitterMs ?? 30_000;
    this.maxBackupSessions = Math.max(
      1,
      options.maxBackupSessions ?? DEFAULT_MAX_BACKUP_SESSIONS
    );
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.maxHealthLogEntries = Math.max(
      10,
      options.maxHealthLogEntries ?? DEFAULT_MAX_HEALTH_LOG_ENTRIES
    );
    this.networkGracePeriodMs =
      options.networkGracePeriodMs ?? DEFAULT_NETWORK_GRACE_PERIOD_MS;
    this.networkRetryIntervalMs =
      options.networkRetryIntervalMs ?? DEFAULT_NETWORK_RETRY_INTERVAL_MS;
    this.nightActivityEveryHealthyTicks = Math.max(
      1,
      options.nightActivityEveryHealthyTicks ??
        DEFAULT_NIGHT_ACTIVITY_EVERY_HEALTHY_TICKS
    );
    this.nightHours = options.nightHours ?? {
      startHour: 0,
      endHour: 6
    };
    this.sessionName = options.sessionName ?? "default";
    this.sessionRefreshEnabled = options.sessionRefreshEnabled ?? true;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.consecutiveFailures = 0;
    this.tickCount = 0;
    this.healthyTickCount = 0;
    this.declaredDead = false;
    this.networkInterruptedAtMs = undefined;
    this.activityPatternIndex = 0;
    this.eventLog.length = 0;
    this.reconnectTimestampsMs.length = 0;
    this.activeAlerts.clear();
    this.backupSessions = [];
    this.metrics = this.createInitialMetrics(new Date().toISOString());
    this.scheduleNextTick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getHealthLog(): KeepAliveEvent[] {
    return [...this.eventLog];
  }

  getMetrics(): KeepAliveMetrics {
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

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }

    const usingRetryCadence = this.networkInterruptedAtMs !== undefined;
    const jitter = usingRetryCadence ? 0 : (Math.random() * 2 - 1) * this.jitterMs;
    const baseDelay = usingRetryCadence
      ? this.networkRetryIntervalMs
      : this.intervalMs;
    const delay = Math.max(1_000, baseDelay + jitter);

    this.timer = setTimeout(() => {
      void this.runTick().finally(() => {
        this.scheduleNextTick();
      });
    }, delay);
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    this.tickCount += 1;
    this.metrics.lastTickAt = new Date().toISOString();
    let lease: ConnectionLease | undefined;

    try {
      lease = await this.pool.acquire(this.options.cdpUrl);
      const health = await checkFullHealth(lease.context);
      await this.processHealthResult(health, lease);
    } catch (error) {
      await this.handleTickError(error);
    } finally {
      lease?.release();
      this.tickInFlight = false;
    }
  }

  private async processHealthResult(
    health: FullHealthStatus,
    lease: ConnectionLease
  ): Promise<void> {
    this.updateMetricsFromHealth(health);

    if (health.browser.healthy && health.session.authenticated) {
      await this.handleHealthyState(health, lease);
      return;
    }

    if (!health.browser.browserConnected) {
      this.emitKeepAliveEvent({
        type: "browser-disconnected",
        health,
        detail: "Browser connection lost"
      });
      this.emit("browser-disconnected", health);
      await this.handleNetworkInterruption("Browser connection lost");
      return;
    }

    if (!health.session.authenticated) {
      await this.handleUnauthenticatedState(health, lease);
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

  private async handleHealthyState(
    health: FullHealthStatus,
    lease: ConnectionLease
  ): Promise<void> {
    this.healthyTickCount += 1;
    this.consecutiveFailures = 0;
    this.declaredDead = false;
    this.metrics.consecutiveFailures = 0;
    this.metrics.lastHealthyAt = new Date().toISOString();
    this.metrics.sessionUptimeMs = this.getSessionUptimeMs();

    this.emitKeepAliveEvent({
      type: "healthy",
      health
    });
    this.emit("healthy", health);

    this.recoverFromNetworkInterruption(health);
    await this.captureSessionSnapshot(lease, health);
    await this.cleanupOrphanPages(lease);

    if (this.sessionRefreshEnabled && this.shouldRefreshCookies(health)) {
      await this.refreshSession(lease, "proactive");
    }

    if (this.activitySimulationEnabled && this.shouldSimulateActivity()) {
      await this.maybeWarmup(lease);
      await this.simulateActivity(lease);
    }

    this.evaluateAlerts();
  }

  private shouldRefreshCookies(health: FullHealthStatus): boolean {
    const expiresInMs = millisecondsUntil(health.session.nextCookieExpiryAt);
    return (
      expiresInMs !== null &&
      expiresInMs > 0 &&
      expiresInMs <= this.cookieRefreshLeadMs
    );
  }

  private shouldSimulateActivity(): boolean {
    const cadence = isNightHour(new Date().getHours(), this.nightHours)
      ? this.nightActivityEveryHealthyTicks
      : this.activityEveryHealthyTicks;

    return cadence > 0 && this.healthyTickCount % cadence === 0;
  }

  private async handleUnauthenticatedState(
    health: FullHealthStatus,
    lease: ConnectionLease
  ): Promise<void> {
    this.emitKeepAliveEvent({
      type: "session-expired",
      health,
      detail: "LinkedIn session expired"
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

    if (
      this.sessionRefreshEnabled &&
      (health.session.sessionCookiePresent || this.shouldRefreshCookies(health))
    ) {
      recovered = await this.attemptSoftRefresh(lease, health);
    }

    if (!recovered) {
      recovered = await this.restoreBackupSession(lease);
    }

    if (recovered) {
      this.consecutiveFailures = 0;
      this.declaredDead = false;
      this.metrics.consecutiveFailures = 0;
      return;
    }

    this.recordFailure();
    this.metrics.lastLoginRequiredAt = new Date().toISOString();
    this.emitKeepAliveEvent({
      type: "manual-login-required",
      health,
      detail: "Manual LinkedIn login is required to continue",
      metadata: {
        currentUrl: health.session.currentUrl,
        reason: health.session.reason,
        nextCookieExpiryAt: health.session.nextCookieExpiryAt,
        sessionCookiePresent: health.session.sessionCookiePresent,
        whatWasHappening: health.session.loginWallDetected
          ? "soft re-auth after LinkedIn login wall"
          : "session recovery after authentication loss"
      }
    });
  }

  private async handleNetworkInterruption(detail: string): Promise<void> {
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

    const recovered = await this.attemptReconnect();
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
        detail: `Declared dead after ${this.consecutiveFailures} consecutive failures`
      });
    }
  }

  private async attemptReconnect(): Promise<boolean> {
    this.emitKeepAliveEvent({
      type: "reconnect-attempt",
      detail: "Attempting to reconnect to browser"
    });

    let lease: ConnectionLease | undefined;
    try {
      await this.pool.invalidate?.(this.options.cdpUrl);
      lease = await this.pool.acquire(this.options.cdpUrl);
      const health = await checkFullHealth(lease.context);
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
            : "Reconnected to browser, but session still needs recovery"
        });

        if (health.session.authenticated) {
          this.consecutiveFailures = 0;
          this.declaredDead = false;
          this.metrics.lastHealthyAt = new Date().toISOString();
          this.metrics.sessionUptimeMs = this.getSessionUptimeMs();
          this.recoverFromNetworkInterruption(health);
          await this.captureSessionSnapshot(lease, health);
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
      this.emitKeepAliveEvent({
        type: "reconnect-failed",
        detail:
          error instanceof Error ? error.message : "Unknown reconnect error"
      });
    } finally {
      lease?.release();
    }

    return false;
  }

  private async attemptSoftRefresh(
    lease: ConnectionLease,
    health: FullHealthStatus
  ): Promise<boolean> {
    this.emitKeepAliveEvent({
      type: "soft-reauth-attempt",
      health,
      detail: "Attempting to recover the active session without manual login"
    });

    const refreshedHealth = await this.refreshSession(lease, "soft-reauth");
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
    reason: "proactive" | "soft-reauth"
  ): Promise<FullHealthStatus | null> {
    try {
      const page = await getOrCreatePage(lease.context);
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded"
      });

      this.metrics.lastCookieRefreshAt = new Date().toISOString();
      if (reason === "proactive") {
        this.emitKeepAliveEvent({
          type: "cookie-refresh",
          detail: "Proactively refreshed near-expiry LinkedIn session cookies"
        });
      }

      const refreshedHealth = await checkFullHealth(lease.context);
      this.updateMetricsFromHealth(refreshedHealth);
      if (refreshedHealth.session.authenticated) {
        this.metrics.lastHealthyAt = new Date().toISOString();
        this.metrics.sessionUptimeMs = this.getSessionUptimeMs();
        await this.captureSessionSnapshot(lease, refreshedHealth);
      }

      return refreshedHealth;
    } catch {
      return null;
    }
  }

  private async captureSessionSnapshot(
    lease: ConnectionLease,
    health: FullHealthStatus
  ): Promise<void> {
    if (typeof lease.context.storageState !== "function") {
      return;
    }

    const knownFingerprint = health.session.sessionCookieFingerprint;
    const shouldCapture =
      this.backupSessions.length === 0 ||
      knownFingerprint === null ||
      knownFingerprint === undefined ||
      knownFingerprint !== this.metrics.lastSessionFingerprint ||
      this.shouldRefreshCookies(health);

    if (!shouldCapture) {
      return;
    }

    try {
      const storageState = await lease.context.storageState();
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

      if (this.options.sessionStore) {
        await this.options.sessionStore.saveWithBackups(
          this.sessionName,
          storageState,
          {
            maxBackups: this.maxBackupSessions
          }
        );
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

  private async restoreBackupSession(lease: ConnectionLease): Promise<boolean> {
    if (this.options.sessionStore) {
      this.emitKeepAliveEvent({
        type: "soft-reauth-attempt",
        detail: `Attempting stored-session restore for ${this.sessionName}`,
        metadata: {
          sessionName: this.sessionName,
          source: "session-store"
        }
      });

      try {
        await this.options.sessionStore.restoreToContext(
          lease.context,
          this.sessionName,
          {
            allowExpired: false,
            maxBackups: this.maxBackupSessions
          }
        );
        const restoredHealth = await checkFullHealth(lease.context);
        this.updateMetricsFromHealth(restoredHealth);
        if (restoredHealth.session.authenticated) {
          await this.captureSessionSnapshot(lease, restoredHealth);
          this.emitKeepAliveEvent({
            type: "soft-reauth-success",
            health: restoredHealth,
            detail: `Recovered authentication from stored session ${this.sessionName}`,
            metadata: {
              source: "session-store"
            }
          });
          return true;
        }
      } catch {
        // Fall back to in-memory snapshots below.
      }
    }

    for (const snapshot of this.backupSessions) {
      this.emitKeepAliveEvent({
        type: "soft-reauth-attempt",
        detail: "Attempting in-memory session restore",
        metadata: {
          capturedAt: snapshot.capturedAt,
          nextCookieExpiryAt: snapshot.nextCookieExpiryAt,
          source: "memory"
        }
      });

      try {
        await restoreLinkedInSessionCookies(lease.context, snapshot.storageState);
        const restoredHealth = await checkFullHealth(lease.context);
        this.updateMetricsFromHealth(restoredHealth);
        if (restoredHealth.session.authenticated) {
          await this.captureSessionSnapshot(lease, restoredHealth);
          this.emitKeepAliveEvent({
            type: "soft-reauth-success",
            health: restoredHealth,
            detail: "Recovered authentication from in-memory backup session",
            metadata: {
              source: "memory",
              capturedAt: snapshot.capturedAt
            }
          });
          return true;
        }
      } catch {
        // Continue through remaining snapshots.
      }
    }

    return false;
  }

  private async maybeWarmup(lease: ConnectionLease): Promise<void> {
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
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded"
      });
      await humanize(page, { fast: true }).idle();
      this.metrics.lastWarmupAt = new Date().toISOString();
      this.emitKeepAliveEvent({
        type: "warmup",
        detail: "Performed a gentle session warmup after extended idle time"
      });
    } catch {
      // Warmup is best-effort; failures should not break keepalive.
    }
  }

  private async simulateActivity(lease: ConnectionLease): Promise<void> {
    try {
      const page = await getOrCreatePage(lease.context);
      const hp = humanize(page, { fast: true });
      const pattern = ACTIVITY_PATTERNS[
        this.activityPatternIndex % ACTIVITY_PATTERNS.length
      ];
      this.activityPatternIndex += 1;
      let detail = "";

      switch (pattern) {
        case "feed-scroll": {
          await page.goto("https://www.linkedin.com/feed/", {
            waitUntil: "domcontentloaded"
          });
          await hp.scrollDown();
          await hp.idle();
          detail = "Rotated keepalive activity: scrolled the LinkedIn feed";
          break;
        }
        case "notifications-peek": {
          await page.goto("https://www.linkedin.com/notifications/", {
            waitUntil: "domcontentloaded"
          });
          await hp.idle();
          detail = "Rotated keepalive activity: checked the notifications page";
          break;
        }
        case "network-peek": {
          await page.goto("https://www.linkedin.com/mynetwork/", {
            waitUntil: "domcontentloaded"
          });
          await hp.idle();
          detail = "Rotated keepalive activity: viewed the network page";
          break;
        }
      }

      this.metrics.lastActivityAt = new Date().toISOString();
      this.emitKeepAliveEvent({
        type: "activity",
        detail,
        metadata: {
          pattern
        }
      });
    } catch {
      // Activity simulation is best-effort; failures are not fatal.
    }
  }

  private async cleanupOrphanPages(lease: ConnectionLease): Promise<void> {
    const pages = lease.context.pages();
    if (pages.length <= 1) {
      return;
    }

    let closedCount = 0;
    for (const page of pages.slice(1)) {
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
    while (
      this.reconnectTimestampsMs.length > 0 &&
      this.reconnectTimestampsMs[0] !== undefined &&
      this.reconnectTimestampsMs[0] < cutoffMs
    ) {
      this.reconnectTimestampsMs.shift();
    }
  }

  private evaluateAlerts(): void {
    this.trimReconnectWindow();
    this.metrics.reconnectCountInWindow = this.reconnectTimestampsMs.length;

    const cookieExpiryMs = millisecondsUntil(this.metrics.nextCookieExpiryAt);
    const cookieAlertActive =
      cookieExpiryMs !== null &&
      cookieExpiryMs > 0 &&
      cookieExpiryMs <= this.alertThresholds.cookieExpiringWithinMs;
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
      health: partial.health,
      detail: partial.detail,
      metadata: partial.metadata
    };

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxHealthLogEntries) {
      this.eventLog.splice(0, this.eventLog.length - this.maxHealthLogEntries);
    }

    this.emit("health-event", event);
  }

  private async handleTickError(error: unknown): Promise<void> {
    if (isTransientConnectionError(error)) {
      await this.handleNetworkInterruption(
        error instanceof Error ? error.message : "Transient network interruption"
      );
      return;
    }

    this.recordFailure();
    this.emitError(error);
  }

  private emitError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.emit("error", normalized);
  }
}
