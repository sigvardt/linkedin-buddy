import type { BrowserContext, Page } from "playwright-core";
import { LinkedInAssistantError } from "../errors.js";
import { ProfileManager } from "../profileManager.js";

export interface SessionStatus {
  authenticated: boolean;
  checkedAt: string;
  currentUrl: string;
  reason: string;
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
}

export interface HeadlessLoginResult extends SessionStatus {
  timedOut: boolean;
  checkpoint: boolean;
  checkpointType?: "verification_code" | "app_approval" | "captcha" | "unknown";
  mfaRequired?: boolean;
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
  constructor(
    private readonly profileManager: ProfileManager,
    private readonly cdpUrl?: string
  ) {}

  async status(options: SessionOptions = {}): Promise<SessionStatus> {
    const profileName = options.profileName ?? "default";
    const cdpUrl = options.cdpUrl ?? this.cdpUrl;

    return this.profileManager.runWithContext(
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
        return inspectLinkedInSession(page);
      }
    );
  }

  async ensureAuthenticated(options: SessionOptions = {}): Promise<SessionStatus> {
    const status = await this.status(options);

    if (!status.authenticated) {
      const code = status.currentUrl.includes("/checkpoint")
        ? "CAPTCHA_OR_CHALLENGE"
        : "AUTH_REQUIRED";
      throw new LinkedInAssistantError(
        code,
        `${status.reason} Run "linkedin login --profile ${options.profileName ?? "default"}" first.`,
        {
          profile_name: options.profileName ?? "default",
          current_url: status.currentUrl,
          checked_at: status.checkedAt
        }
      );
    }

    return status;
  }

  async headlessLogin(options: HeadlessLoginOptions): Promise<HeadlessLoginResult> {
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
          const earlyStatus = await inspectLinkedInSession(page);
          if (earlyStatus.authenticated) {
            return {
              ...earlyStatus,
              timedOut: false,
              checkpoint: false
            };
          }
        }

        const emailInput = page.locator(
          "input[name='session_key'], input#username"
        );
        await emailInput.first().fill(options.email);

        const passwordInput = page.locator(
          "input[name='session_password'], input#password"
        );
        await passwordInput.first().fill(options.password);

        const signInButton = page.locator(
          "button[type='submit'][data-litms-control-urn='login-submit'], button[type='submit']:has-text('Sign in')"
        );
        await signInButton.first().click();

        await page.waitForTimeout(2_000);

        const deadline = Date.now() + timeoutMs;
        let mfaCodeSubmitted = false;

        while (Date.now() < deadline) {
          const status = await inspectLinkedInSession(page);

          if (status.authenticated) {
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

        const finalStatus = await inspectLinkedInSession(page);
        return {
          ...finalStatus,
          timedOut: true,
          checkpoint: false
        };
      }
    );
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
