import type { BrowserContext, Page } from "playwright-core";

export interface BrowserHealthStatus {
  healthy: boolean;
  browserConnected: boolean;
  pageResponsive: boolean;
  checkedAt: string;
}

export interface SessionHealthStatus {
  authenticated: boolean;
  currentUrl: string;
  reason: string;
  checkedAt: string;
}

export interface FullHealthStatus {
  browser: BrowserHealthStatus;
  session: SessionHealthStatus;
}

async function getFirstPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function isVisibleSafe(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

export async function checkBrowserHealth(
  context: BrowserContext
): Promise<BrowserHealthStatus> {
  const checkedAt = new Date().toISOString();
  const browserConnected = context.browser()?.isConnected() ?? false;
  let pageResponsive = false;

  if (browserConnected) {
    try {
      const page = await getFirstPage(context);
      await page.evaluate(() => 1 + 1);
      pageResponsive = true;
    } catch {
      pageResponsive = false;
    }
  }

  return {
    healthy: browserConnected && pageResponsive,
    browserConnected,
    pageResponsive,
    checkedAt
  };
}

export async function checkLinkedInSession(
  context: BrowserContext
): Promise<SessionHealthStatus> {
  const checkedAt = new Date().toISOString();

  try {
    const page = await getFirstPage(context);
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded"
    });

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
  } catch (error) {
    const currentUrl = context.pages()[0]?.url() ?? "";
    const reason =
      error instanceof Error
        ? `Session health check failed: ${error.message}`
        : "Session health check failed.";

    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason
    };
  }
}

export async function checkFullHealth(
  context: BrowserContext
): Promise<FullHealthStatus> {
  const browser = await checkBrowserHealth(context);
  const session = await checkLinkedInSession(context);

  return {
    browser,
    session
  };
}
