import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  chromium,
  type BrowserContext
} from "playwright-core";
import type { ConfigPaths } from "./config.js";

type PersistentLaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export interface PersistentContextOptions {
  headless?: boolean;
  launchOptions?: Omit<PersistentLaunchOptions, "headless" | "executablePath">;
}

function withPlaywrightInstallHint(error: unknown): Error {
  if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
    return new Error(
      "Playwright browser executable is missing. Install Chromium with \"npx playwright install chromium\" or set PLAYWRIGHT_EXECUTABLE_PATH."
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export class ProfileManager {
  constructor(private readonly paths: ConfigPaths) {}

  getProfileUserDataDir(profileName: string = "default"): string {
    return path.join(this.paths.profilesDir, profileName);
  }

  async withProfileLock<T>(
    profileName: string,
    callback: (userDataDir: string) => Promise<T>
  ): Promise<T> {
    const userDataDir = this.getProfileUserDataDir(profileName);
    await mkdir(userDataDir, { recursive: true });

    const release = await lockfile.lock(userDataDir, {
      realpath: false,
      lockfilePath: path.join(userDataDir, ".profile.lock"),
      retries: {
        retries: 20,
        factor: 1.2,
        minTimeout: 100,
        maxTimeout: 1_000
      }
    });

    try {
      return await callback(userDataDir);
    } finally {
      await release();
    }
  }

  async runWithPersistentContext<T>(
    profileName: string,
    options: PersistentContextOptions,
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    return this.withProfileLock(profileName, async (userDataDir) => {
      const launchOptions: PersistentLaunchOptions = {
        ...(options.launchOptions ?? {}),
        headless: options.headless ?? true
      };

      const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }

      let context: BrowserContext | undefined;
      try {
        context = await chromium.launchPersistentContext(userDataDir, launchOptions);
        return await callback(context);
      } catch (error) {
        throw withPlaywrightInstallHint(error);
      } finally {
        if (context) {
          await context.close();
        }
      }
    });
  }

  async runWithCDP<T>(
    cdpUrl: string,
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    let browser:
      | Awaited<ReturnType<typeof chromium.connectOverCDP>>
      | undefined;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("No browser context found on CDP connection");
      }
      return await callback(context);
    } catch (error) {
      throw withPlaywrightInstallHint(error);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async runWithContext<T>(
    options: {
      cdpUrl?: string | undefined;
      profileName: string;
      headless?: boolean;
    },
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    if (options.cdpUrl) {
      return this.runWithCDP(options.cdpUrl, callback);
    }

    return this.runWithPersistentContext(
      options.profileName,
      { headless: options.headless ?? true },
      callback
    );
  }
}
