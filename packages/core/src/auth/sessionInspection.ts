import type { Page } from "playwright-core";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  buildLinkedInAriaLabelContainsSelector,
  type LinkedInSelectorLocale
} from "../selectorLocale.js";

/**
 * Snapshot of whether a Playwright page currently appears authenticated to
 * LinkedIn.
 */
export interface LinkedInSessionInspection {
  authenticated: boolean;
  checkedAt: string;
  currentUrl: string;
  reason: string;
  checkpointDetected: boolean;
  loginWallDetected: boolean;
  rateLimited: boolean;
  sessionCookiePresent: boolean;
}

/** Best-effort identity snapshot for the authenticated LinkedIn member. */
export interface LinkedInSessionIdentity {
  fullName: string | null;
  profileUrl: string | null;
  vanityName: string | null;
}

const LOGIN_FORM_SELECTOR = "input[name='session_key'], input#username";
const CHECKPOINT_FORM_SELECTOR = "form[action*='checkpoint']";
const AUTH_NAV_SELECTOR = "nav.global-nav";
const AUTH_PROFILE_MENU_SELECTOR = "[data-control-name='nav.settings_view_profile']";
const PROFILE_HEADING_SELECTORS = [
  "main h1",
  ".pv-text-details__left-panel h1",
  "h1"
];
const LOGIN_WALL_SELECTOR = [
  "[data-test-id='sign-in-form']",
  ".authwall",
  "form[action*='login-submit']",
  "a[href*='/login'][data-tracking-control-name]"
].join(", ");
const LINKEDIN_PROFILE_SELF_URL = "https://www.linkedin.com/in/me/";

async function isVisibleSafe(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

function isLoginUrl(url: string): boolean {
  return (
    url.includes("/login") ||
    url.includes("/authwall") ||
    url.includes("signup/cold-join")
  );
}

/**
 * Returns whether a LinkedIn challenge URL matches the known rate-limit flow.
 */
export function isRateLimitedChallengeUrl(url: string): boolean {
  return (
    url.includes("challenge_global_internal_error") ||
    url.includes("errorKey=challenge_global_internal_error")
  );
}

function isCheckpointUrl(url: string): boolean {
  return (
    url.includes("/checkpoint") ||
    url.includes("/challenge") ||
    isRateLimitedChallengeUrl(url)
  );
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLinkedInProfileUrl(value: string | null): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value, "https://www.linkedin.com");
    const vanityMatch = parsed.pathname.match(/^\/in\/([^/?#]+)\/?$/u);
    if (!vanityMatch) {
      return null;
    }

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `/in/${vanityMatch[1]}/`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractLinkedInVanityName(profileUrl: string | null): string | null {
  if (!profileUrl) {
    return null;
  }

  try {
    const parsed = new URL(profileUrl);
    const vanityMatch = parsed.pathname.match(/^\/in\/([^/]+)\/$/u);
    return vanityMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readFirstNonEmptyText(
  page: Page,
  selectors: string[]
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const rawText = await page.locator(selector).first().textContent();
      const normalized = normalizeWhitespace(rawText);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Best effort.
    }
  }

  return null;
}

async function readFirstAttribute(
  page: Page,
  selector: string,
  attribute: string
): Promise<string | null> {
  try {
    const value = await page.locator(selector).first().getAttribute(attribute);
    return normalizeWhitespace(value);
  } catch {
    return null;
  }
}

async function hasSessionCookie(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies("https://www.linkedin.com");
    return cookies.some(
      (cookie) => cookie.name === "li_at" && cookie.value.trim().length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Inspects the current LinkedIn page for authenticated-session, login-wall,
 * checkpoint, and rate-limit signals.
 */
export async function inspectLinkedInSession(
  page: Page,
  options: { selectorLocale?: LinkedInSelectorLocale } = {}
): Promise<LinkedInSessionInspection> {
  const selectorLocale =
    options.selectorLocale ?? DEFAULT_LINKEDIN_SELECTOR_LOCALE;
  const checkedAt = new Date().toISOString();
  const currentUrl = page.url();

  const checkpointVisible =
    isCheckpointUrl(currentUrl) ||
    (await isVisibleSafe(page, CHECKPOINT_FORM_SELECTOR));
  const sessionCookiePresent = await hasSessionCookie(page);

  if (checkpointVisible) {
    const rateLimited = isRateLimitedChallengeUrl(currentUrl);
    const reason = rateLimited
      ? "LinkedIn rate-limit challenge detected."
      : "LinkedIn checkpoint detected. Manual verification is required.";
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason,
      checkpointDetected: true,
      loginWallDetected: false,
      rateLimited,
      sessionCookiePresent
    };
  }

  const loginFormVisible = await isVisibleSafe(page, LOGIN_FORM_SELECTOR);
  const loginWallVisible = await isVisibleSafe(page, LOGIN_WALL_SELECTOR);
  if (loginFormVisible || isLoginUrl(currentUrl) || loginWallVisible) {
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason: loginWallVisible
        ? "LinkedIn login wall detected."
        : "Login form is visible.",
      checkpointDetected: false,
      loginWallDetected: loginWallVisible || isLoginUrl(currentUrl),
      rateLimited: false,
      sessionCookiePresent
    };
  }

  const navVisible = await isVisibleSafe(page, AUTH_NAV_SELECTOR);
  const profileMenuSelector = [
    buildLinkedInAriaLabelContainsSelector("button", "me", selectorLocale),
    AUTH_PROFILE_MENU_SELECTOR
  ].join(", ");
  const profileMenuVisible = await isVisibleSafe(
    page,
    profileMenuSelector
  );
  if (navVisible || profileMenuVisible || sessionCookiePresent) {
    return {
      authenticated: true,
      checkedAt,
      currentUrl,
      reason: "LinkedIn session appears authenticated.",
      checkpointDetected: false,
      loginWallDetected: false,
      rateLimited: false,
      sessionCookiePresent
    };
  }

  return {
    authenticated: false,
    checkedAt,
    currentUrl,
    reason: "Could not confirm an authenticated LinkedIn session.",
    checkpointDetected: false,
    loginWallDetected: false,
    rateLimited: false,
    sessionCookiePresent
  };
}

/**
 * Best-effort extraction of the currently authenticated LinkedIn member's
 * public identity. This intentionally prefers a stable public profile URL plus
 * the visible H1 so operators can confirm they are using the intended account.
 */
export async function inspectAuthenticatedLinkedInIdentity(
  page: Page
): Promise<LinkedInSessionIdentity | undefined> {
  try {
    await page.goto(LINKEDIN_PROFILE_SELF_URL, {
      waitUntil: "domcontentloaded"
    });
  } catch {
    return undefined;
  }

  const currentUrl = page.url();
  if (isLoginUrl(currentUrl) || isCheckpointUrl(currentUrl)) {
    return undefined;
  }

  const fullName = await readFirstNonEmptyText(page, PROFILE_HEADING_SELECTORS);
  const profileUrl =
    normalizeLinkedInProfileUrl(
      await readFirstAttribute(page, "link[rel='canonical']", "href")
    ) ?? normalizeLinkedInProfileUrl(currentUrl);

  if (!fullName && !profileUrl) {
    return undefined;
  }

  return {
    fullName,
    profileUrl,
    vanityName: extractLinkedInVanityName(profileUrl)
  };
}
