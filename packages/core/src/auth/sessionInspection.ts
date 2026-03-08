import type { Page } from "playwright-core";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  buildLinkedInAriaLabelContainsSelector,
  type LinkedInSelectorLocale
} from "../selectorLocale.js";

export interface LinkedInSessionInspection {
  authenticated: boolean;
  checkedAt: string;
  currentUrl: string;
  reason: string;
}

const LOGIN_FORM_SELECTOR = "input[name='session_key'], input#username";
const CHECKPOINT_FORM_SELECTOR = "form[action*='checkpoint']";
const AUTH_NAV_SELECTOR = "nav.global-nav";

function createAuthProfileSelector(selectorLocale: LinkedInSelectorLocale): string {
  return [
    buildLinkedInAriaLabelContainsSelector("button", "me", selectorLocale),
    "[data-control-name='nav.settings_view_profile']"
  ].join(", ");
}

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

  if (checkpointVisible) {
    const reason = isRateLimitedChallengeUrl(currentUrl)
      ? "LinkedIn rate-limit challenge detected."
      : "LinkedIn checkpoint detected. Manual verification is required.";
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason
    };
  }

  const loginFormVisible = await isVisibleSafe(page, LOGIN_FORM_SELECTOR);
  if (loginFormVisible || isLoginUrl(currentUrl)) {
    return {
      authenticated: false,
      checkedAt,
      currentUrl,
      reason: "Login form is visible."
    };
  }

  const navVisible = await isVisibleSafe(page, AUTH_NAV_SELECTOR);
  const profileMenuVisible = await isVisibleSafe(
    page,
    createAuthProfileSelector(selectorLocale)
  );
  const sessionCookiePresent = await hasSessionCookie(page);

  if (navVisible || profileMenuVisible || sessionCookiePresent) {
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
