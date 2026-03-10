import type { BrowserContext, Page } from "playwright-core";
import {
  inspectAuthenticatedLinkedInIdentity,
  inspectLinkedInSession,
  type LinkedInSessionIdentity
} from "./auth/sessionInspection.js";
import { resolveEvasionConfig, type EvasionConfig } from "./config.js";
import {
  getLinkedInSessionFingerprint,
  summarizeLinkedInSessionCookies,
  type LinkedInSessionCookieMetadata
} from "./auth/sessionStore.js";

export const DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS = 60 * 60_000;

/** Browser reachability snapshot for one health-check run. */
export interface BrowserHealthStatus {
  healthy: boolean;
  browserConnected: boolean;
  pageResponsive: boolean;
  checkedAt: string;
}

/** LinkedIn session health snapshot for one health-check run. */
export interface SessionHealthStatus {
  authenticated: boolean;
  currentUrl: string;
  reason: string;
  checkedAt: string;
  checkpointDetected: boolean;
  cookieExpiringSoon: boolean;
  /** Resolved anti-bot evasion status for the current runtime. */
  evasion: EvasionConfig;
  identity?: LinkedInSessionIdentity;
  loginWallDetected: boolean;
  nextCookieExpiryAt: string | null;
  rateLimited: boolean;
  sessionCookieFingerprint: string | null;
  sessionCookiePresent: boolean;
  sessionCookies: LinkedInSessionCookieMetadata[];
}

/** Combined browser + LinkedIn session health report. */
export interface FullHealthStatus {
  browser: BrowserHealthStatus;
  session: SessionHealthStatus;
}

/** Optional enrichments applied to session and full health checks. */
export interface HealthCheckOptions {
  evasion?: EvasionConfig;
}

async function getFirstPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

/** Checks whether the underlying browser context is connected and responsive. */
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

/** Checks the LinkedIn session state and enriches it with cookie + evasion diagnostics. */
export async function checkLinkedInSession(
  context: BrowserContext,
  options: HealthCheckOptions = {}
): Promise<SessionHealthStatus> {
  const evasion = options.evasion ?? resolveEvasionConfig();

  try {
    const page = await getFirstPage(context);
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded"
    });

    const inspection = await inspectLinkedInSession(page);
    const identity = inspection.authenticated
      ? await inspectAuthenticatedLinkedInIdentity(page)
      : undefined;
    const cookies = await context.cookies("https://www.linkedin.com");
    const sessionCookies = summarizeLinkedInSessionCookies(cookies);
    const nextCookieExpiryAt = sessionCookies.find(
      (cookie) => cookie.expiresAt !== null && (cookie.expiresInMs ?? 0) > 0
    )?.expiresAt ?? null;
    const cookieExpiringSoon = sessionCookies.some(
      (cookie) =>
        cookie.expiresInMs !== null &&
        cookie.expiresInMs > 0 &&
        cookie.expiresInMs <= DEFAULT_SESSION_COOKIE_EXPIRY_WARNING_MS
    );

    return {
      ...inspection,
      cookieExpiringSoon,
      evasion,
      ...(identity ? { identity } : {}),
      nextCookieExpiryAt,
      sessionCookieFingerprint:
        sessionCookies.length > 0
          ? getLinkedInSessionFingerprint({ cookies })
          : null,
      sessionCookiePresent:
        inspection.sessionCookiePresent || sessionCookies.length > 0,
      sessionCookies
    };
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const currentUrl = context.pages()[0]?.url() ?? "";
    const reason =
      error instanceof Error
        ? `Session health check failed before LinkedIn could be inspected: ${error.message}. Check browser connectivity and reload the profile before retrying.`
        : "Session health check failed before LinkedIn could be inspected. Check browser connectivity and reload the profile before retrying.";

    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason,
      checkpointDetected: false,
      cookieExpiringSoon: false,
      evasion,
      loginWallDetected: false,
      nextCookieExpiryAt: null,
      rateLimited: false,
      sessionCookieFingerprint: null,
      sessionCookiePresent: false,
      sessionCookies: []
    };
  }
}

/** Runs both browser and LinkedIn session checks and returns one combined report. */
export async function checkFullHealth(
  context: BrowserContext,
  options: HealthCheckOptions = {}
): Promise<FullHealthStatus> {
  const browser = await checkBrowserHealth(context);
  const session = await checkLinkedInSession(context, options);

  return {
    browser,
    session
  };
}
