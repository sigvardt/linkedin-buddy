import type { BrowserContext, Page } from "playwright-core";
import { LinkedInAssistantError } from "../errors.js";
import { humanize } from "../humanize.js";
import { ProfileManager } from "../profileManager.js";
import {
  inspectLinkedInSession,
  isRateLimitedChallengeUrl
} from "./sessionInspection.js";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  type LinkedInSelectorLocale
} from "../selectorLocale.js";
import {
  clearRateLimitState,
  isInRateLimitCooldown,
  recordRateLimit,
  type RateLimitState
} from "./rateLimitState.js";

export interface SessionStatus {
  authenticated: boolean;
  checkedAt: string;
  currentUrl: string;
  reason: string;
  rateLimitActive?: boolean;
  rateLimitUntil?: string;
}

export interface SessionOptions {
  profileName?: string;
  cdpUrl?: string | undefined;
}

export interface OpenLoginOptions extends SessionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface OpenLoginResult extends SessionStatus {
  timedOut: boolean;
}

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
}

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

function isRateLimited(url: string): boolean {
  return isRateLimitedChallengeUrl(url);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LinkedInAuthService {
  constructor(
    private readonly profileManager: ProfileManager,
    private readonly cdpUrl?: string,
    private readonly selectorLocale: LinkedInSelectorLocale =
      DEFAULT_LINKEDIN_SELECTOR_LOCALE
  ) {}

  async status(options: SessionOptions = {}): Promise<SessionStatus> {
    const cooldown = await isInRateLimitCooldown();

    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;

    const status = await this.profileManager.runWithContext(
      {
        cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/feed/", {
          waitUntil: "domcontentloaded"
        });
        const status = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale
        });
        if (status.authenticated) {
          await clearRateLimitState();
        }
        return status;
      }
    );

    if (!status.authenticated && cooldown.active && cooldown.state) {
      return {
        ...status,
        reason: `${status.reason} Rate-limit cooldown is active until ${cooldown.state.rateLimitedUntil}.`,
        rateLimitActive: true,
        rateLimitUntil: cooldown.state.rateLimitedUntil
      };
    }

    return status;
  }

  async ensureAuthenticated(options: SessionOptions = {}): Promise<SessionStatus> {
    const status = await this.status(options);

    if (!status.authenticated) {
      const code = status.rateLimitActive
        ? "RATE_LIMITED"
        : status.currentUrl.includes("/checkpoint")
          ? "CAPTCHA_OR_CHALLENGE"
          : "AUTH_REQUIRED";
      const guidance = status.rateLimitActive
        ? `Wait for cooldown expiry (${status.rateLimitUntil}) or clear it with "linkedin rate-limit --clear".`
        : `Run "linkedin login --profile ${options.profileName ?? "default"}" first.`;
      throw new LinkedInAssistantError(
        code,
        `${status.reason} ${guidance}`,
        {
          profile_name: options.profileName ?? "default",
          current_url: status.currentUrl,
          checked_at: status.checkedAt,
          rate_limit_active: status.rateLimitActive ?? false,
          ...(status.rateLimitUntil
            ? { rate_limit_until: status.rateLimitUntil }
            : {})
        }
      );
    }

    return status;
  }

  async headlessLogin(options: HeadlessLoginOptions): Promise<HeadlessLoginResult> {
    const cooldown = await isInRateLimitCooldown();
    if (cooldown.active && cooldown.state) {
      return {
        authenticated: false,
        checkedAt: new Date().toISOString(),
        currentUrl: "N/A (skipped — rate limit cooldown)",
        reason: `Skipped — rate limit cooldown active until ${cooldown.state.rateLimitedUntil}`,
        timedOut: false,
        checkpoint: false,
        rateLimitActive: true,
        rateLimitUntil: cooldown.state.rateLimitedUntil
      };
    }

    const retryOnRateLimit = options.retryOnRateLimit ?? false;
    const maxRetries = options.maxRetries ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 30_000;

    let lastResult: HeadlessLoginResult | undefined;

    const attempts = retryOnRateLimit ? maxRetries + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && lastResult?.checkpointType === "rate_limited") {
        const backoffMs =
          retryBaseDelayMs * Math.pow(2, attempt - 1) +
          Math.random() * 5_000;
        await sleep(backoffMs);
      }

      lastResult = await this.performHeadlessLogin(options);

      if (
        lastResult.checkpointType !== "rate_limited" ||
        !retryOnRateLimit
      ) {
        return lastResult;
      }
    }

    return lastResult!;
  }

  private async performHeadlessLogin(
    options: HeadlessLoginOptions
  ): Promise<HeadlessLoginResult> {
    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;

    return this.profileManager.runWithContext(
      {
        cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded"
        });

        const currentUrl = page.url();
        if (!currentUrl.includes("/login") && !currentUrl.includes("/checkpoint")) {
          const earlyStatus = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale
          });
          if (earlyStatus.authenticated) {
            await clearRateLimitState();
            return {
              ...earlyStatus,
              timedOut: false,
              checkpoint: false
            };
          }
        }

        // Human-like typing for credentials
        const hp = humanize(page, { fast: false });
        await hp.type(
          "input[name='session_key'], input#username",
          options.email
        );
        await hp.type(
          "input[name='session_password'], input#password",
          options.password
        );

        const signInButton = page.locator(
          "button[type='submit'][data-litms-control-urn='login-submit'], button[type='submit']:has-text('Sign in')"
        );
        await signInButton.first().click();

        await page.waitForTimeout(2_000);

        const deadline = Date.now() + timeoutMs;
        let mfaCodeSubmitted = false;

        while (Date.now() < deadline) {
          const status = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale
          });

          if (status.authenticated) {
            await clearRateLimitState();
            return {
              ...status,
              timedOut: false,
              checkpoint: false
            };
          }

          const isCheckpoint =
            page.url().includes("/checkpoint") ||
            (await isVisibleSafe(page, "form[action*='checkpoint']"));

          if (isCheckpoint) {
            // Rate limit detection — check before other checkpoint types
            if (isRateLimited(page.url())) {
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
                rateLimitUntil: rateLimitState.rateLimitedUntil
              };
            }

            const hasCodeInput = await isVisibleSafe(
              page,
              "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']"
            );
            const hasCaptcha = await isVisibleSafe(
              page,
              "iframe[src*='captcha'], #captcha, iframe[src*='recaptcha'], .recaptcha"
            );

            let hasAppApproval = false;
            if (!hasCodeInput && !hasCaptcha) {
              const hasAppApprovalMarker = await isVisibleSafe(
                page,
                "[data-test-id='auth-app-approval']"
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
                  "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']"
                );
                await codeInput.first().fill(options.mfaCode);

                const submitButton = page.locator(
                  "button[type='submit'], button#two-step-submit-button"
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
                    reason: "Page closed after MFA code submission — code may be invalid or expired",
                    timedOut: false,
                    checkpoint: true,
                    checkpointType: "verification_code",
                    mfaRequired: true
                  };
                }
              } else if (!mfaCodeSubmitted && options.mfaCallback) {
                const interactiveCode = await options.mfaCallback();
                if (interactiveCode) {
                  const codeInput = page.locator(
                    "input[name='pin'], input#input__phone_verification_pin, input[name*='verification'], input[name*='code']"
                  );
                  await codeInput.first().fill(interactiveCode);
                  const submitButton = page.locator(
                    "button[type='submit'], button#two-step-submit-button"
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
                      reason: "Page closed after MFA code submission — code may be invalid or expired",
                      timedOut: false,
                      checkpoint: true,
                      checkpointType: "verification_code",
                      mfaRequired: true
                    };
                  }
                } else {
                  return {
                    ...status,
                    timedOut: false,
                    checkpoint: true,
                    checkpointType: "verification_code",
                    mfaRequired: true
                  };
                }
              } else if (!options.mfaCode && !options.mfaCallback) {
                return {
                  ...status,
                  timedOut: false,
                  checkpoint: true,
                  checkpointType: "verification_code",
                  mfaRequired: true
                };
              }
            } else if (checkpointType === "app_approval") {
              // Continue polling while LinkedIn awaits approval from a trusted device.
            } else if (checkpointType === "captcha") {
              return {
                ...status,
                timedOut: false,
                checkpoint: true,
                checkpointType: "captcha"
              };
            } else {
              return {
                ...status,
                timedOut: false,
                checkpoint: true,
                checkpointType: "unknown"
              };
            }
          }

          const loginErrorVisible = await isVisibleSafe(
            page,
            "#error-for-password, #error-for-username, .form__label--error, div[role='alert']"
          );

          if (loginErrorVisible) {
            return {
              authenticated: false,
              checkedAt: new Date().toISOString(),
              currentUrl: page.url(),
              reason: "Invalid credentials",
              timedOut: false,
              checkpoint: false
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
              checkpoint: false
            };
          }
        }

        const finalStatus = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale
        });
        if (finalStatus.authenticated) {
          await clearRateLimitState();
        }
        return {
          ...finalStatus,
          timedOut: true,
          checkpoint: false
        };
      }
    );
  }

  async getRateLimitStatus(): Promise<{
    active: boolean;
    state: RateLimitState | null;
  }> {
    return isInRateLimitCooldown();
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
        headless: false
      },
      async (context) => {
        const page = await getPage(context);
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded"
        });

        let status = await inspectLinkedInSession(page, {
          selectorLocale: this.selectorLocale
        });
        const deadline = Date.now() + timeoutMs;

        while (!status.authenticated && Date.now() < deadline) {
          try {
            await page.waitForTimeout(pollIntervalMs);
          } catch {
            return {
              ...status,
              timedOut: false
            };
          }

          status = await inspectLinkedInSession(page, {
            selectorLocale: this.selectorLocale
          });
        }

        if (status.authenticated) {
          await clearRateLimitState();
        }

        return {
          ...status,
          timedOut: !status.authenticated
        };
      }
    );
  }
}
