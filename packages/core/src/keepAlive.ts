import { EventEmitter } from "node:events";
import type { FullHealthStatus } from "./healthCheck.js";
import { checkFullHealth } from "./healthCheck.js";
import type { ConnectionLease } from "./connectionPool.js";
import { CDPConnectionPool } from "./connectionPool.js";
import { humanize } from "./humanize.js";

export type KeepAliveEventType =
  | "healthy"
  | "session-expired"
  | "browser-disconnected"
  | "reconnect-attempt"
  | "reconnect-success"
  | "reconnect-failed"
  | "dead"
  | "activity";

export interface KeepAliveEvent {
  type: KeepAliveEventType;
  timestamp: string;
  health?: FullHealthStatus | undefined;
  consecutiveFailures: number;
  detail?: string | undefined;
}

export interface KeepAliveOptions {
  intervalMs?: number;
  cdpUrl: string;
  maxConsecutiveFailures?: number;
  jitterMs?: number;
  sessionRefreshEnabled?: boolean;
  activitySimulationEnabled?: boolean;
}

export class SessionKeepAliveService extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private tickInFlight = false;
  private consecutiveFailures = 0;
  private tickCount = 0;
  private declaredDead = false;

  private readonly intervalMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly jitterMs: number;
  private readonly sessionRefreshEnabled: boolean;
  private readonly activitySimulationEnabled: boolean;

  constructor(
    private readonly pool: CDPConnectionPool,
    private readonly options: KeepAliveOptions
  ) {
    super();
    this.on("error", () => undefined);

    this.intervalMs = options.intervalMs ?? 300_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
    this.jitterMs = options.jitterMs ?? 30_000;
    this.sessionRefreshEnabled = options.sessionRefreshEnabled ?? true;
    this.activitySimulationEnabled = options.activitySimulationEnabled ?? true;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.consecutiveFailures = 0;
    this.tickCount = 0;
    this.declaredDead = false;
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

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }

    const jitter = (Math.random() * 2 - 1) * this.jitterMs;
    const delay = Math.max(1_000, this.intervalMs + jitter);

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
    let lease: ConnectionLease | undefined;

    try {
      lease = await this.pool.acquire(this.options.cdpUrl);
      const health = await checkFullHealth(lease.context);
      this.processHealthResult(health, lease);
    } catch (error) {
      this.handleTickError(error);
    } finally {
      lease?.release();
      this.tickInFlight = false;
    }
  }

  private processHealthResult(
    health: FullHealthStatus,
    lease: ConnectionLease
  ): void {
    if (health.browser.healthy && health.session.authenticated) {
      this.consecutiveFailures = 0;
      this.declaredDead = false;

      this.emitKeepAliveEvent({
        type: "healthy",
        health
      });
      // Backward-compat
      this.emit("healthy", health);

      // Activity simulation on every 3rd healthy tick
      if (this.activitySimulationEnabled && this.tickCount % 3 === 0) {
        void this.simulateActivity(lease);
      }
      return;
    }

    if (!health.browser.browserConnected) {
      this.recordFailure();

      this.emitKeepAliveEvent({
        type: "browser-disconnected",
        health,
        detail: "Browser connection lost"
      });
      // Backward-compat
      this.emit("browser-disconnected", health);

      // Auto-reconnect: release current lease and re-acquire
      void this.attemptReconnect();
      return;
    }

    if (!health.session.authenticated) {
      this.recordFailure();

      this.emitKeepAliveEvent({
        type: "session-expired",
        health,
        detail: "LinkedIn session expired"
      });
      // Backward-compat
      this.emit("session-expired", health);

      // Session refresh: navigate to feed to refresh cookies
      if (this.sessionRefreshEnabled) {
        void this.refreshSession(lease);
      }
      return;
    }

    this.recordFailure();
    this.emitError(new Error("Health check failed."));
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;

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

  private async attemptReconnect(): Promise<void> {
    this.emitKeepAliveEvent({
      type: "reconnect-attempt",
      detail: "Attempting to reconnect to browser"
    });

    let lease: ConnectionLease | undefined;
    try {
      lease = await this.pool.acquire(this.options.cdpUrl);
      const health = await checkFullHealth(lease.context);

      if (health.browser.healthy) {
        this.emitKeepAliveEvent({
          type: "reconnect-success",
          health,
          detail: "Successfully reconnected to browser"
        });
      } else {
        this.emitKeepAliveEvent({
          type: "reconnect-failed",
          health,
          detail: "Reconnected but browser not healthy"
        });
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown reconnect error";
      this.emitKeepAliveEvent({
        type: "reconnect-failed",
        detail
      });
    } finally {
      lease?.release();
    }
  }

  private async refreshSession(lease: ConnectionLease): Promise<void> {
    try {
      const page = lease.context.pages()[0];
      if (!page) {
        return;
      }

      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded"
      });

      this.emitKeepAliveEvent({
        type: "activity",
        detail: "Session refresh: navigated to feed"
      });
    } catch {
      // Session refresh is best-effort; failures are not fatal
    }
  }

  private async simulateActivity(lease: ConnectionLease): Promise<void> {
    try {
      const page = lease.context.pages()[0];
      if (!page) {
        return;
      }

      const hp = humanize(page, { fast: true });
      await hp.scrollDown();
      await hp.idle();

      this.emitKeepAliveEvent({
        type: "activity",
        detail: "Simulated user scroll activity"
      });
    } catch {
      // Activity simulation is best-effort; failures are not fatal
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
      detail: partial.detail
    };

    this.emit("health-event", event);
  }

  private handleTickError(error: unknown): void {
    this.recordFailure();
    this.emitError(error);
  }

  private emitError(error: unknown): void {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.emit("error", normalized);
  }
}
