import type { BrowserContext, Page } from "playwright-core";
import { ProfileManager } from "../profileManager.js";

export interface SessionStatus {
  authenticated: boolean;
  checkedAt: string;
  currentUrl: string;
  reason: string;
}

export interface SessionOptions {
  profileName?: string;
}

export interface OpenLoginOptions extends SessionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface OpenLoginResult extends SessionStatus {
  timedOut: boolean;
}

async function isVisibleSafe(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

async function inspectLinkedInSession(page: Page): Promise<SessionStatus> {
  const checkedAt = new Date().toISOString();
  const currentUrl = page.url();

  const loginFormVisible = await isVisibleSafe(
    page,
    "input[name='session_key'], input#username"
  );
  const checkpointVisible =
    currentUrl.includes("/checkpoint") ||
    (await isVisibleSafe(page, "form[action*='checkpoint']"));

  if (checkpointVisible) {
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason: "LinkedIn checkpoint detected. Manual verification is required."
    };
  }

  if (loginFormVisible || currentUrl.includes("/login")) {
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason: "Login form is visible."
    };
  }

  const navVisible = await isVisibleSafe(page, "nav.global-nav");
  const feedLikeRoute =
    currentUrl.includes("/feed") ||
    currentUrl.includes("/mynetwork") ||
    currentUrl.includes("/jobs");

  if (navVisible || feedLikeRoute) {
    return {
      authenticated: true,
      checkedAt,
      currentUrl,
      reason: "LinkedIn session appears authenticated."
    };
  }

  return {
    authenticated: false,
    checkedAt,
    currentUrl,
    reason: "Could not confirm an authenticated LinkedIn session."
  };
}

async function getPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

export class LinkedInAuthService {
  constructor(private readonly profileManager: ProfileManager) {}

  async status(options: SessionOptions = {}): Promise<SessionStatus> {
    const profileName = options.profileName ?? "default";

    return this.profileManager.runWithPersistentContext(
      profileName,
      { headless: true },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded"
        });
        return inspectLinkedInSession(page);
      }
    );
  }

  async ensureAuthenticated(options: SessionOptions = {}): Promise<SessionStatus> {
    const status = await this.status(options);

    if (!status.authenticated) {
      throw new Error(`${status.reason} Run "linkedin login" first.`);
    }

    return status;
  }

  async openLogin(options: OpenLoginOptions = {}): Promise<OpenLoginResult> {
    const profileName = options.profileName ?? "default";
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    return this.profileManager.runWithPersistentContext(
      profileName,
      { headless: false },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded"
        });

        let status = await inspectLinkedInSession(page);
        const deadline = Date.now() + timeoutMs;

        while (!status.authenticated && Date.now() < deadline) {
          await page.waitForTimeout(pollIntervalMs);

          if (page.url().includes("/login")) {
            await page
              .goto("https://www.linkedin.com/feed/", {
                waitUntil: "domcontentloaded"
              })
              .catch(() => undefined);
          }

          status = await inspectLinkedInSession(page);
        }

        return {
          ...status,
          timedOut: !status.authenticated
        };
      }
    );
  }
}
