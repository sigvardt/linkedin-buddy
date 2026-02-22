import {
  chromium,
  type Browser,
  type BrowserContext
} from "playwright-core";

interface PooledConnection {
  browser: Browser;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
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

export class CDPConnectionPool {
  private connections = new Map<string, PooledConnection>();
  private readonly idleTimeoutMs: number;
  private readonly lock = new AsyncLock();

  constructor(options?: { idleTimeoutMs?: number }) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 300_000;
  }

  async acquire(cdpUrl: string): Promise<ConnectionLease> {
    return this.lock.run(async () => {
      let pooled = this.connections.get(cdpUrl);

      if (pooled?.idleTimer) {
        clearTimeout(pooled.idleTimer);
        pooled.idleTimer = undefined;
      }

      if (pooled && !pooled.browser.isConnected()) {
        await this.closeConnection(cdpUrl, pooled);
        pooled = undefined;
      }

      if (!pooled) {
        const browser = await chromium.connectOverCDP(cdpUrl);
        pooled = {
          browser,
          refCount: 0,
          idleTimer: undefined
        };
        this.connections.set(cdpUrl, pooled);
      }

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
        context,
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
