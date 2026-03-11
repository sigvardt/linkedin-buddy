import {
  chromium,
  type Browser,
  type BrowserContext
} from "playwright-core";
import { resolveEvasionConfig, type EvasionConfig } from "./config.js";
import { wrapLinkedInBrowserContext } from "./linkedinPage.js";
import type { JsonEventLogger } from "./logging.js";

interface PooledConnection {
  browser: Browser;
  connectedAtMs: number;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  lastAcquiredAtMs: number;
  lastReleasedAtMs: number | undefined;
}

class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }
}

export interface ConnectionLease {
  context: BrowserContext;
  release: () => void;
}

export interface ConnectionPoolEntryStats {
  ageMs: number;
  cdpUrl: string;
  connected: boolean;
  connectedAt: string;
  idleScheduled: boolean;
  lastAcquiredAt: string;
  lastReleasedAt?: string;
  refCount: number;
}

export class CDPConnectionPool {
  private connections = new Map<string, PooledConnection>();
  private readonly idleTimeoutMs: number;
  private readonly lock = new AsyncLock();
  private readonly maxConnectionAgeMs: number;
  private readonly evasion: EvasionConfig;
  private readonly logger: Pick<JsonEventLogger, "log"> | undefined;

  constructor(options?: {
    idleTimeoutMs?: number;
    maxConnectionAgeMs?: number;
    evasion?: EvasionConfig;
    logger?: Pick<JsonEventLogger, "log">;
  }) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 300_000;
    this.maxConnectionAgeMs = options?.maxConnectionAgeMs ?? 30 * 60_000;
    this.evasion = options?.evasion ?? resolveEvasionConfig();
    this.logger = options?.logger;
  }

  async acquire(cdpUrl: string): Promise<ConnectionLease> {
    return this.lock.run(async () => {
      let pooled = this.connections.get(cdpUrl);

      if (pooled?.idleTimer) {
        clearTimeout(pooled.idleTimer);
        pooled.idleTimer = undefined;
      }

      const nowMs = Date.now();

      if (
        pooled &&
        (!pooled.browser.isConnected() ||
          nowMs - pooled.connectedAtMs >= this.maxConnectionAgeMs)
      ) {
        await this.closeConnection(cdpUrl, pooled);
        pooled = undefined;
      }

      if (!pooled) {
        const browser = await chromium.connectOverCDP(cdpUrl);
        pooled = {
          browser,
          connectedAtMs: nowMs,
          refCount: 0,
          idleTimer: undefined,
          lastAcquiredAtMs: nowMs,
          lastReleasedAtMs: undefined
        };
        this.connections.set(cdpUrl, pooled);
      }

      pooled.lastAcquiredAtMs = nowMs;

      const context = pooled.browser.contexts()[0];
      if (!context) {
        await this.closeConnection(cdpUrl, pooled);
        throw new Error("No browser context found on CDP connection");
      }

      pooled.refCount += 1;
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;

        void this.lock
          .run(async () => {
            const current = this.connections.get(cdpUrl);
            if (!current) {
              return;
            }

            current.refCount = Math.max(0, current.refCount - 1);
            current.lastReleasedAtMs = Date.now();
            if (current.refCount !== 0 || current.idleTimer) {
              return;
            }

            const idleTimer = setTimeout(() => {
              void this.lock
                .run(async () => {
                  const idle = this.connections.get(cdpUrl);
                  if (!idle) {
                    return;
                  }

                  if (idle.refCount > 0 || idle.idleTimer !== idleTimer) {
                    return;
                  }

                  await this.closeConnection(cdpUrl, idle);
                })
                .catch(() => undefined);
            }, this.idleTimeoutMs);

            current.idleTimer = idleTimer;
          })
          .catch(() => undefined);
      };

      return {
        context: wrapLinkedInBrowserContext(context, {
          evasion: this.evasion,
          ...(this.logger ? { logger: this.logger } : {})
        }),
        release
      };
    });
  }

  async dispose(): Promise<void> {
    await this.lock.run(async () => {
      const entries = [...this.connections.entries()];
      this.connections.clear();

      await Promise.all(
        entries.map(async ([, connection]) => {
          if (connection.idleTimer) {
            clearTimeout(connection.idleTimer);
            connection.idleTimer = undefined;
          }

          try {
            await connection.browser.close();
          } catch {
            // Ignore close failures during cleanup.
          }
        })
      );
    });
  }

  async invalidate(cdpUrl: string): Promise<void> {
    await this.lock.run(async () => {
      const connection = this.connections.get(cdpUrl);
      if (!connection) {
        return;
      }

      await this.closeConnection(cdpUrl, connection);
    });
  }

  getStats(): ConnectionPoolEntryStats[] {
    const nowMs = Date.now();
    return [...this.connections.entries()].map(([cdpUrl, connection]) => ({
      ageMs: Math.max(0, nowMs - connection.connectedAtMs),
      cdpUrl,
      connected: connection.browser.isConnected(),
      connectedAt: new Date(connection.connectedAtMs).toISOString(),
      idleScheduled: connection.idleTimer !== undefined,
      lastAcquiredAt: new Date(connection.lastAcquiredAtMs).toISOString(),
      ...(typeof connection.lastReleasedAtMs === "number"
        ? { lastReleasedAt: new Date(connection.lastReleasedAtMs).toISOString() }
        : {}),
      refCount: connection.refCount
    }));
  }

  private async closeConnection(
    cdpUrl: string,
    connection: PooledConnection
  ): Promise<void> {
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }

    this.connections.delete(cdpUrl);

    try {
      await connection.browser.close();
    } catch {
      // Ignore close failures during cleanup.
    }
  }
}
