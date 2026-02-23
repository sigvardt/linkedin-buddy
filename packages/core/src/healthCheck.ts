import type { BrowserContext, Page } from "playwright-core";
import { inspectLinkedInSession } from "./auth/sessionInspection.js";

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
  try {
    const page = await getFirstPage(context);
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded"
    });

    return inspectLinkedInSession(page);
  } catch (error) {
    const checkedAt = new Date().toISOString();
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
