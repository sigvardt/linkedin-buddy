/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
import type { BrowserContext, Page } from "playwright-core";
import { resolveEvasionConfig, type EvasionConfig } from "../config.js";
import { detectCaptcha } from "../evasion/browser.js";
import { LinkedInBuddyError } from "../errors.js";
import { attachHumanizeLogger, detachHumanizeLogger } from "../humanize.js";
import type { JsonEventLogger } from "../logging.js";
import { ProfileManager } from "../profileManager.js";
import {
  inspectAuthenticatedLinkedInIdentity,
  inspectLinkedInSession,
  isRateLimitedChallengeUrl,
  type LinkedInSessionIdentity,
} from "./sessionInspection.js";
import {
  LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR,
  LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTOR,
} from "./loginSelectors.js";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  type LinkedInSelectorLocale,
} from "../selectorLocale.js";
import {
  clearRateLimitState,
  isInRateLimitCooldown,
  recordRateLimit,
  type RateLimitState,
} from "./rateLimitState.js";

/** Authentication snapshot for a LinkedIn browser profile. */
export interface SessionStatus {
  authenticated: boolean;
  checkedAt: string;
  checkpointDetected?: boolean;
  currentUrl: string;
  /** Resolved anti-bot evasion status when available. */
  evasion?: EvasionConfig;
  identity?: LinkedInSessionIdentity;
  loginWallDetected?: boolean;
  reason: string;
  rateLimitActive?: boolean;
  rateLimited?: boolean;
  rateLimitUntil?: string;
  sessionCookiePresent?: boolean;
}

/** Common profile/session options accepted by auth helpers. */
export interface SessionOptions {
  profileName?: string;
  cdpUrl?: string | undefined;
}

/** Options for the interactive open-login poll loop. */
export interface OpenLoginOptions extends SessionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Result returned by the interactive open-login flow. */
export interface OpenLoginResult extends SessionStatus {
  timedOut: boolean;
}

/** Options for the headless credential-based login flow. */
export interface HeadlessLoginOptions extends SessionOptions {
  email: string;
  password: string;
  mfaCode?: string;
  mfaCallback?: () => Promise<string | undefined>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  retryOnRateLimit?: boolean;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** When true, retry in headed mode if a CAPTCHA checkpoint is detected. */
  headedFallback?: boolean;
  /** When true, force headed (non-headless) mode for the login attempt. */
  headed?: boolean;
  /** When true, browse LinkedIn organically before attempting login. */
  warmProfile?: boolean;
}

/** Result returned by the headless credential-based login flow. */
export interface HeadlessLoginResult extends SessionStatus {
  timedOut: boolean;
  checkpoint: boolean;
  checkpointType?:
    | "verification_code"
    | "app_approval"
    | "captcha"
    | "rate_limited"
    | "unknown";
  mfaRequired?: boolean;
}

async function isVisibleSafe(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

async function getPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Dismiss LinkedIn's cookie consent banner when present. The banner renders as
 * an `artdeco-global-alert` overlay with a `<header>` that intercepts pointer
 * events, preventing normal Playwright clicks on both the banner buttons and
 * the login form inputs underneath. We click via JS then remove the overlay
 * DOM to guarantee the form is unblocked.
 */
async function dismissCookieConsentBanner(page: Page): Promise<void> {
  if (typeof page.evaluate !== "function") return;

  const dismissed = await page
    .evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        "button[action-type='ACCEPT'], button[action-type='DENY']",
      );
      if (btn && btn.offsetWidth > 0) {
        btn.click();
      }
      for (const el of document.querySelectorAll(
        ".artdeco-global-alert--COOKIE_CONSENT, .artdeco-global-alert",
      )) {
        el.remove();
      }
      return true;
    })
    .catch(() => false);

  if (dismissed) {
    await sleep(500);
  }
}

async function enrichAuthenticatedSessionStatus<
  T extends { authenticated: boolean },
>(page: Page, status: T): Promise<T & { identity?: LinkedInSessionIdentity }> {
  if (!status.authenticated) {
    return status;
  }

  const identity = await inspectAuthenticatedLinkedInIdentity(page);
  return identity
    ? {
        ...status,
        identity,
      }
    : status;
}

export class LinkedInAuthService {
  constructor(
    private readonly profileManager: ProfileManager,
    private readonly cdpUrl?: string,
    private readonly selectorLocale: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE,
    private readonly logger?: Pick<JsonEventLogger, "log">,
    private readonly evasion: EvasionConfig = resolveEvasionConfig(),
  ) {}

  /** Checks whether the profile currently looks authenticated to LinkedIn. */
  async status(options: SessionOptions = {}): Promise<SessionStatus> {
    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;

    const status = await this.profileManager.runWithContext(
      {
        cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded",
        });
        const status = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale,
        });
        if (status.authenticated) {
          await clearRateLimitState();
        }
        return enrichAuthenticatedSessionStatus(page, status);
      },
    );

    if (status.authenticated) {
      const resolvedStatus = {
        ...status,
        evasion: this.evasion,
      };
      this.logger?.log("debug", "auth.session.status.checked", {
        authenticated: true,
        current_url: status.currentUrl,
        evasion_level: this.evasion.level,
        profileName,
        reason: status.reason,
      });

      return resolvedStatus;
    }

    const cooldown = await isInRateLimitCooldown();
    if (cooldown.active && cooldown.state) {
      const resolvedStatus = {
        ...status,
        evasion: this.evasion,
        reason: `${status.reason} Rate-limit cooldown is active until ${cooldown.state.rateLimitedUntil}.`,
        rateLimitActive: true,
        rateLimitUntil: cooldown.state.rateLimitedUntil,
      };

      this.logger?.log("debug", "auth.session.status.checked", {
        authenticated: false,
        checkpoint_detected: status.checkpointDetected ?? false,
        current_url: status.currentUrl,
        evasion_level: this.evasion.level,
        profileName,
        rate_limit_active: true,
        reason: resolvedStatus.reason,
      });

      return resolvedStatus;
    }

    const resolvedStatus = {
      ...status,
      evasion: this.evasion,
    };
    this.logger?.log("debug", "auth.session.status.checked", {
      authenticated: false,
      checkpoint_detected: status.checkpointDetected ?? false,
      current_url: status.currentUrl,
      evasion_level: this.evasion.level,
      profileName,
      rate_limit_active: false,
      reason: status.reason,
    });

    return resolvedStatus;
  }

  /** Throws a structured error when the session is not currently authenticated. */
  async ensureAuthenticated(
    options: SessionOptions = {},
  ): Promise<SessionStatus> {
    const status = await this.status(options);

    if (!status.authenticated) {
      const code = status.rateLimitActive
        ? "RATE_LIMITED"
        : status.checkpointDetected
          ? "CAPTCHA_OR_CHALLENGE"
          : "AUTH_REQUIRED";
      const guidance = status.rateLimitActive
        ? `Wait for cooldown expiry (${status.rateLimitUntil}) or clear it with "linkedin rate-limit --clear".`
        : `Run "linkedin login --manual --session ${options.profileName ?? "default"}" to capture a fresh session, or "linkedin login --profile ${options.profileName ?? "default"}" for interactive login.`;
      this.logger?.log("warn", "auth.session.ensure_authenticated.failed", {
        code,
        current_url: status.currentUrl,
        evasion_level: status.evasion?.level,
        profileName: options.profileName ?? "default",
        rate_limit_active: status.rateLimitActive ?? false,
        reason: status.reason,
      });
      throw new LinkedInBuddyError(code, `${status.reason} ${guidance}`, {
        profile_name: options.profileName ?? "default",
        current_url: status.currentUrl,
        checked_at: status.checkedAt,
        ...(status.evasion ? { evasion_level: status.evasion.level } : {}),
        rate_limit_active: status.rateLimitActive ?? false,
        ...(status.rateLimitUntil
          ? { rate_limit_until: status.rateLimitUntil }
          : {}),
      });
    }

    return status;
  }

  /** Runs the headless login flow and optionally retries rate-limit checkpoints. */
  async headlessLogin(
    options: HeadlessLoginOptions,
  ): Promise<HeadlessLoginResult> {
    const cooldown = await isInRateLimitCooldown();
    if (cooldown.active && cooldown.state) {
      return {
        authenticated: false,
        checkedAt: new Date().toISOString(),
        currentUrl: "N/A (skipped — rate limit cooldown)",
        evasion: this.evasion,
        reason: `Skipped — rate limit cooldown active until ${cooldown.state.rateLimitedUntil}`,
        timedOut: false,
        checkpoint: false,
        rateLimitActive: true,
        rateLimitUntil: cooldown.state.rateLimitedUntil,
      };
    }

    const retryOnRateLimit = options.retryOnRateLimit ?? false;
    const maxRetries = options.maxRetries ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 30_000;

    let result = {
      ...(await this.performHeadlessLogin(options)),
      evasion: this.evasion,
    };

    // Headed fallback: if CAPTCHA detected and headed fallback is enabled,
    // retry the entire login flow in headed (non-headless) mode.
    if (
      result.checkpointType === "captcha" &&
      (options.headedFallback ?? false) &&
      !options.headed
    ) {
      result = {
        ...(await this.performHeadlessLogin({ ...options, headed: true })),
        evasion: this.evasion,
      };
      if (result.authenticated || result.checkpointType !== "rate_limited") {
        return result;
      }
    }

    if (!retryOnRateLimit || result.checkpointType !== "rate_limited") {
      return result;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const backoffMs =
        retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * 5_000;
      await sleep(backoffMs);

      result = {
        ...(await this.performHeadlessLogin(options)),
        evasion: this.evasion,
      };
      if (result.checkpointType !== "rate_limited") {
        return result;
      }
    }

    return result;
  }

  private async performHeadlessLogin(
    options: HeadlessLoginOptions,
  ): Promise<HeadlessLoginResult> {
    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const useHeaded = options.headed ?? false;
    const warmProfile = options.warmProfile ?? false;

    return this.profileManager.runWithContext(
      {
        cdpUrl,
        profileName,
        headless: !useHeaded,
      },
      async (context) => {
        const page = await getPage(context);

        if (warmProfile) {
          await this.warmBrowserProfile(page);
        }

        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded",
        });

        const currentUrl = page.url();
        if (
          !currentUrl.includes("/login") &&
          !currentUrl.includes("/checkpoint")
        ) {
          const earlyStatus = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale,
          });
          if (earlyStatus.authenticated) {
            await clearRateLimitState();
            const resolvedEarlyStatus = await enrichAuthenticatedSessionStatus(
              page,
              earlyStatus,
            );
            return {
              ...resolvedEarlyStatus,
              timedOut: false,
              checkpoint: false,
            };
          }
        }

        await dismissCookieConsentBanner(page);

        const emailInputVisible = await page
          .locator(LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR)
          .first()
          .waitFor({ state: "visible", timeout: 8_000 })
          .then(() => true)
          .catch(() => false);

        if (!emailInputVisible) {
          // LinkedIn "returning user" variant: the email field is a hidden
          // input (sometimes a session token, sometimes the email itself) and
          // only the password field is shown. If the password field is visible
          // we can submit directly; otherwise clear cookies to get the full
          // login form.
          const passwordVisible = await page
            .locator(LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTOR)
            .first()
            .isVisible({ timeout: 3_000 })
            .catch(() => false);

          if (!passwordVisible) {
            await context.clearCookies({ domain: ".linkedin.com" });
            await page.goto("https://www.linkedin.com/login", {
              waitUntil: "domcontentloaded",
            });
            await dismissCookieConsentBanner(page);
            await page
              .locator(LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR)
              .first()
              .waitFor({ state: "visible", timeout: 10_000 });
          } else {
            // Inject the email into the hidden session_key field via JS so the
            // server receives the correct address on form submission.
            await page
              .evaluate((email: string) => {
                const el = document.querySelector<HTMLInputElement>(
                  "input[name='session_key']",
                );
                if (el) el.value = email;
              }, options.email)
              .catch(() => undefined);
          }
        }

        if (this.logger) {
          attachHumanizeLogger(page, this.logger);
        }

        try {
          if (emailInputVisible) {
            await page.type(LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR, options.email);
          }
          await page.type(
            LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTOR,
            options.password,
          );
        } finally {
          detachHumanizeLogger(page);
        }

        const signInButton = page.locator(
          "button[type='submit'][data-litms-control-urn='login-submit'], button[type='submit']:has-text('Sign in')",
        );
        await signInButton.first().click();

        await page.waitForTimeout(2_000);

        const deadline = Date.now() + timeoutMs;
        let mfaCodeSubmitted = false;

        while (Date.now() < deadline) {
          const status = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale,
          });

          if (status.authenticated) {
            await clearRateLimitState();
            const resolvedStatus = await enrichAuthenticatedSessionStatus(
              page,
              status,
            );
            return {
              ...resolvedStatus,
              timedOut: false,
              checkpoint: false,
            };
          }

          const isCheckpoint =
            page.url().includes("/checkpoint") ||
            (await isVisibleSafe(page, "form[action*='checkpoint']"));

          if (isCheckpoint) {
            // Rate limit detection — check before other checkpoint types
            if (isRateLimitedChallengeUrl(page.url())) {
              const rateLimitState = await recordRateLimit();
              return {
                authenticated: false,
                checkedAt: new Date().toISOString(),
                currentUrl: page.url(),
                reason:
                  "LinkedIn rate limit detected (challenge_global_internal_error)",
                timedOut: false,
                checkpoint: true,
                checkpointType: "rate_limited",
                rateLimitActive: true,
                rateLimitUntil: rateLimitState.rateLimitedUntil,
              };
            }

            const hasCodeInput = await isVisibleSafe(
              page,
              "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']",
            );
            const hasCaptcha = await detectCaptcha(page);

            let hasAppApproval = false;
            if (!hasCodeInput && !hasCaptcha) {
              const hasAppApprovalMarker = await isVisibleSafe(
                page,
                "[data-test-id='auth-app-approval']",
              );

              if (hasAppApprovalMarker) {
                hasAppApproval = true;
              } else {
                try {
                  hasAppApproval = await page
                    .getByText(/approve|verify.*app|app.*verify/i)
                    .first()
                    .isVisible({ timeout: 1_000 });
                } catch {
                  hasAppApproval = false;
                }
              }
            }

            const checkpointType:
              | "verification_code"
              | "app_approval"
              | "captcha"
              | "unknown" = hasCodeInput
              ? "verification_code"
              : hasAppApproval
                ? "app_approval"
                : hasCaptcha
                  ? "captcha"
                  : "unknown";

            if (checkpointType === "verification_code") {
              if (options.mfaCode && !mfaCodeSubmitted) {
                const codeInput = page.locator(
                  "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']",
                );
                await codeInput.first().fill(options.mfaCode);

                const submitButton = page.locator(
                  "button[type='submit'], button#two-step-submit-button",
                );
                await submitButton.first().click();
                mfaCodeSubmitted = true;

                try {
                  await page.waitForTimeout(2_000);
                } catch {
                  return {
                    authenticated: false,
                    checkedAt: new Date().toISOString(),
                    currentUrl: "unknown (page closed)",
                    reason:
                      "Page closed after MFA code submission — code may be invalid or expired",
                    timedOut: false,
                    checkpoint: true,
                    checkpointType: "verification_code",
                    mfaRequired: true,
                  };
                }
              } else if (!mfaCodeSubmitted && options.mfaCallback) {
                const interactiveCode = await options.mfaCallback();
                if (interactiveCode) {
                  const codeInput = page.locator(
                    "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']",
                  );
                  await codeInput.first().fill(interactiveCode);
                  const submitButton = page.locator(
                    "button[type='submit'], button#two-step-submit-button",
                  );
                  await submitButton.first().click();
                  mfaCodeSubmitted = true;
                  try {
                    await page.waitForTimeout(2_000);
                  } catch {
                    return {
                      authenticated: false,
                      checkedAt: new Date().toISOString(),
                      currentUrl: "unknown (page closed)",
                      reason:
                        "Page closed after MFA code submission — code may be invalid or expired",
                      timedOut: false,
                      checkpoint: true,
                      checkpointType: "verification_code",
                      mfaRequired: true,
                    };
                  }
                } else {
                  return {
                    ...status,
                    timedOut: false,
                    checkpoint: true,
                    checkpointType: "verification_code",
                    mfaRequired: true,
                  };
                }
              } else if (!options.mfaCode && !options.mfaCallback) {
                return {
                  ...status,
                  timedOut: false,
                  checkpoint: true,
                  checkpointType: "verification_code",
                  mfaRequired: true,
                };
              }
            } else if (checkpointType === "app_approval") {
              // Continue polling while LinkedIn awaits approval from a trusted device.
            } else if (checkpointType === "captcha") {
              return {
                ...status,
                timedOut: false,
                checkpoint: true,
                checkpointType: "captcha",
              };
            } else {
              return {
                ...status,
                timedOut: false,
                checkpoint: true,
                checkpointType: "unknown",
              };
            }
          }

          const loginErrorVisible = await isVisibleSafe(
            page,
            "#error-for-password, #error-for-username, .form__label--error, div[role='alert']",
          );

          if (loginErrorVisible) {
            return {
              authenticated: false,
              checkedAt: new Date().toISOString(),
              currentUrl: page.url(),
              reason: "Invalid credentials",
              timedOut: false,
              checkpoint: false,
            };
          }

          try {
            await page.waitForTimeout(pollIntervalMs);
          } catch {
            return {
              authenticated: false,
              checkedAt: new Date().toISOString(),
              currentUrl: "unknown (page closed)",
              reason: "Page closed unexpectedly during login polling",
              timedOut: false,
              checkpoint: false,
            };
          }
        }

        const finalStatus = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale,
        });
        const resolvedFinalStatus = await enrichAuthenticatedSessionStatus(
          page,
          finalStatus,
        );
        if (resolvedFinalStatus.authenticated) {
          await clearRateLimitState();
        }
        return {
          ...resolvedFinalStatus,
          timedOut: true,
          checkpoint: false,
        };
      },
    );
  }

  async getRateLimitStatus(): Promise<{
    active: boolean;
    state: RateLimitState | null;
  }> {
    return isInRateLimitCooldown();
  }

  /**
   * Browse LinkedIn pages organically before login to build a normal-looking
   * session fingerprint. Visits the public homepage and scrolls naturally.
   */
  private async warmBrowserProfile(page: Page): Promise<void> {
    try {
      await page.goto("https://www.linkedin.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });

      const scrollDelay = 800 + Math.random() * 1_200;
      await page.waitForTimeout(scrollDelay);

      await page.mouse.wheel(0, 200 + Math.random() * 300);
      await page.waitForTimeout(1_000 + Math.random() * 2_000);

      await page.mouse.wheel(0, 150 + Math.random() * 250);
      await page.waitForTimeout(500 + Math.random() * 1_000);
    } catch {
      // Warming is best-effort — failures should not block login.
    }
  }

  async openLogin(options: OpenLoginOptions = {}): Promise<OpenLoginResult> {
    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    return this.profileManager.runWithContext(
      {
        cdpUrl,
        profileName,
        headless: false,
      },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded",
        });

        let status = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale,
        });
        const deadline = Date.now() + timeoutMs;

        while (!status.authenticated && Date.now() < deadline) {
          try {
            await page.waitForTimeout(pollIntervalMs);
          } catch {
            return {
              ...status,
              timedOut: false,
            };
          }

          status = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale,
          });
        }

        const resolvedStatus = await enrichAuthenticatedSessionStatus(
          page,
          status,
        );

        if (resolvedStatus.authenticated) {
          await clearRateLimitState();
        }

        return {
          ...resolvedStatus,
          timedOut: !resolvedStatus.authenticated,
        };
      },
    );
  }
}
