import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import { LinkedInAuthService, type SessionStatus } from "./auth/session.js";
import {
  inspectLinkedInSession,
  type LinkedInSessionInspection,
} from "./auth/sessionInspection.js";
import {
  LinkedInSessionStore,
  type LinkedInBrowserStorageState,
} from "./auth/sessionStore.js";
import { LinkedInBuddyError } from "./errors.js";
import {
  ProfileManager,
  type PersistentContextOptions,
} from "./profileManager.js";
import { wrapLinkedInBrowserContext } from "./linkedinPage.js";
import { createCoreRuntime, type CoreRuntime } from "./runtime.js";
import { getOrCreatePage } from "./shared.js";
import type { WriteValidationAccount } from "./writeValidationAccounts.js";
import {
  WRITE_VALIDATION_FEED_URL,
  WRITE_VALIDATION_REPORT_DIR,
  type LinkedInWriteValidationActionType,
} from "./writeValidationShared.js";

function createStoredSessionCdpError(): LinkedInBuddyError {
  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    "Stored-session write validation does not support CDP or external browser attachment.",
  );
}

class StoredSessionProfileManager extends ProfileManager {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    paths: CoreRuntime["paths"],
    private readonly storageState: LinkedInBrowserStorageState,
    private readonly timeoutMs: number,
    private readonly runtime: CoreRuntime,
  ) {
    super(paths);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    if (!this.browserPromise) {
      const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
      this.browserPromise = chromium
        .launch({
          headless: false,
          ...(executablePath ? { executablePath } : {}),
        })
        .then((browser) => {
          this.browser = browser;
          return browser;
        });
    }

    return this.browserPromise;
  }

  override async runWithPersistentContext<T>(
    _profileName: string,
    _options: PersistentContextOptions,
    callback: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      storageState: this.storageState,
    });

    context.setDefaultNavigationTimeout(this.timeoutMs);
    context.setDefaultTimeout(this.timeoutMs);
    const wrappedContext = wrapLinkedInBrowserContext(context, {
      evasion: this.runtime.evasion,
      logger: this.runtime.logger,
    });

    try {
      return await callback(wrappedContext);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  override async runWithCDP<T>(
    cdpUrl: string,
    callback: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    void cdpUrl;
    void callback;
    throw createStoredSessionCdpError();
  }

  override async runWithCDPResilient<T>(
    cdpUrl: string,
    callback: (context: BrowserContext) => Promise<T>,
    options?: { maxRetries?: number; retryDelayMs?: number },
  ): Promise<T> {
    void cdpUrl;
    void callback;
    void options;
    throw createStoredSessionCdpError();
  }

  override async runWithContext<T>(
    options: {
      cdpUrl?: string | undefined;
      profileName: string;
      headless?: boolean;
    },
    callback: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    if (options.cdpUrl) {
      throw createStoredSessionCdpError();
    }

    return this.runWithPersistentContext(
      options.profileName,
      { headless: false },
      callback,
    );
  }

  async inspectSession(): Promise<LinkedInSessionInspection> {
    return this.runWithPersistentContext(
      "session-inspection",
      { headless: false },
      async (context) => {
        const page = await getOrCreatePage(context);
        await page.goto(WRITE_VALIDATION_FEED_URL, {
          waitUntil: "domcontentloaded",
        });
        await waitForNetworkIdleBestEffort(page, this.timeoutMs);
        return inspectLinkedInSession(page, {
          selectorLocale: this.runtime.selectorLocale,
        });
      },
    );
  }

  async capturePageScreenshot(input: {
    actionType: LinkedInWriteValidationActionType;
    stage: "before" | "after";
    url: string;
  }): Promise<string> {
    const relativePath = `${WRITE_VALIDATION_REPORT_DIR}/${slugifyActionType(input.actionType)}-${input.stage}-${Date.now()}.png`;

    await this.runWithPersistentContext(
      `screenshot-${input.stage}`,
      { headless: false },
      async (context) => {
        const page = await getOrCreatePage(context);
        await page.goto(input.url, {
          waitUntil: "domcontentloaded",
        });
        await waitForNetworkIdleBestEffort(page, this.timeoutMs);
        const absolutePath = this.runtime.artifacts.resolve(relativePath);
        await page.screenshot({ fullPage: true, path: absolutePath });
      },
    );

    this.runtime.artifacts.registerArtifact(relativePath, "image/png", {
      action: input.actionType,
      capture_stage: input.stage,
      capture_url: input.url,
    });

    return relativePath;
  }

  async dispose(): Promise<void> {
    this.browserPromise = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

class StoredSessionAuthService extends LinkedInAuthService {
  constructor(
    profileManager: ProfileManager,
    private readonly sessionStatus: SessionStatus,
  ) {
    super(profileManager, undefined);
  }

  override async status(): Promise<SessionStatus> {
    return {
      ...this.sessionStatus,
      checkedAt: new Date().toISOString(),
    };
  }

  override async ensureAuthenticated(): Promise<SessionStatus> {
    if (!this.sessionStatus.authenticated) {
      throw new LinkedInBuddyError(
        this.sessionStatus.currentUrl.includes("/checkpoint")
          ? "CAPTCHA_OR_CHALLENGE"
          : "AUTH_REQUIRED",
        this.sessionStatus.reason,
        {
          checked_at: this.sessionStatus.checkedAt,
          current_url: this.sessionStatus.currentUrl,
        },
      );
    }

    return {
      ...this.sessionStatus,
      checkedAt: new Date().toISOString(),
    };
  }
}

function slugifyActionType(actionType: string): string {
  return (
    actionType
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "action"
  );
}

function toSessionStatus(inspection: LinkedInSessionInspection): SessionStatus {
  return {
    authenticated: inspection.authenticated,
    checkedAt: inspection.checkedAt,
    checkpointDetected: inspection.checkpointDetected,
    currentUrl: inspection.currentUrl,
    loginWallDetected: inspection.loginWallDetected,
    reason: inspection.reason,
  };
}

/** Screenshot and cleanup surface required by the Tier 3 execution pipeline. */
export interface WriteValidationProfileManager {
  capturePageScreenshot(input: {
    actionType: LinkedInWriteValidationActionType;
    stage: "before" | "after";
    url: string;
  }): Promise<string>;
  dispose(): Promise<void>;
}

/** Runtime resources created for one write-validation run and disposed during cleanup. */
export interface WriteValidationRuntimeHandle {
  profileManager: WriteValidationProfileManager;
  runtime: CoreRuntime;
}

/**
 * Creates the stored-session runtime used by Tier 3 write validation.
 *
 * The returned handle owns both the core runtime and the profile manager and
 * must be cleaned up by the caller when the run completes.
 */
export async function createWriteValidationRuntime(input: {
  account: WriteValidationAccount;
  baseDir?: string;
  timeoutMs: number;
}): Promise<WriteValidationRuntimeHandle> {
  const runtime = createCoreRuntime(
    input.baseDir
      ? {
          baseDir: input.baseDir,
        }
      : {},
  );
  try {
    const store = new LinkedInSessionStore(input.baseDir);
    const loadedSession = await store.load(input.account.sessionName);
    const profileManager = new StoredSessionProfileManager(
      runtime.paths,
      loadedSession.storageState,
      input.timeoutMs,
      runtime,
    );

    try {
      const inspection = await profileManager.inspectSession();

      if (!inspection.authenticated) {
        throw new LinkedInBuddyError(
          inspection.currentUrl.includes("/checkpoint")
            ? "CAPTCHA_OR_CHALLENGE"
            : "AUTH_REQUIRED",
          inspection.reason,
          {
            checked_at: inspection.checkedAt,
            current_url: inspection.currentUrl,
            session_name: input.account.sessionName,
          },
        );
      }

      runtime.profileManager = profileManager;
      runtime.auth = new StoredSessionAuthService(
        profileManager,
        toSessionStatus(inspection),
      );

      return {
        runtime,
        profileManager,
      };
    } catch (error) {
      await profileManager.dispose().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    runtime.close();
    throw error;
  }
}
