import { EventEmitter } from "node:events";
import type { FullHealthStatus } from "./healthCheck.js";
import { checkFullHealth } from "./healthCheck.js";
import type { ConnectionLease } from "./connectionPool.js";
import { CDPConnectionPool } from "./connectionPool.js";

export interface KeepAliveOptions {
  intervalMs?: number;
  cdpUrl: string;
}

export class SessionKeepAliveService extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private tickInFlight = false;

  constructor(
    private readonly pool: CDPConnectionPool,
    private readonly options: KeepAliveOptions
  ) {
    super();
    this.on("error", () => undefined);
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    const intervalMs = this.options.intervalMs ?? 300_000;
    this.timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runTick(): Promise<void> {
    if (!this.running || this.tickInFlight) {
      return;
    }

    this.tickInFlight = true;
    let lease: ConnectionLease | undefined;

    try {
      lease = await this.pool.acquire(this.options.cdpUrl);
      const health = await checkFullHealth(lease.context);
      this.emitHealthEvent(health);
    } catch (error) {
      this.emitError(error);
    } finally {
      lease?.release();
      this.tickInFlight = false;
    }
  }

  private emitHealthEvent(health: FullHealthStatus): void {
    if (health.browser.healthy && health.session.authenticated) {
      this.emit("healthy", health);
      return;
    }

    if (!health.browser.browserConnected) {
      this.emit("browser-disconnected", health);
      return;
    }

    if (!health.session.authenticated) {
      this.emit("session-expired", health);
      return;
    }

    this.emitError(new Error("Health check failed."));
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.emit("error", normalized);
  }
}
