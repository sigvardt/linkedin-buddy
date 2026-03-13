import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { LinkedInAuthService } from "../auth/session.js";
import type { ProfileManager } from "../profileManager.js";

const rateLimitStateMocks = vi.hoisted(() => ({
  clearRateLimitState: vi.fn(async () => undefined),
  isInRateLimitCooldown: vi.fn(async () => ({ active: false, state: null })),
  recordRateLimit: vi.fn(async () => ({
    rateLimitedUntil: "2026-02-23T12:00:00.000Z",
    detectedAt: "2026-02-23T10:00:00.000Z",
    consecutiveRateLimits: 1,
  })),
}));

const humanizeMocks = vi.hoisted(() => ({
  attachHumanizeLogger: vi.fn(),
  detachHumanizeLogger: vi.fn(),
  type: vi.fn(async () => undefined),
}));

vi.mock("../auth/rateLimitState.js", () => ({
  clearRateLimitState: rateLimitStateMocks.clearRateLimitState,
  isInRateLimitCooldown: rateLimitStateMocks.isInRateLimitCooldown,
  recordRateLimit: rateLimitStateMocks.recordRateLimit,
}));

vi.mock("../humanize.js", () => ({
  attachHumanizeLogger: humanizeMocks.attachHumanizeLogger,
  detachHumanizeLogger: humanizeMocks.detachHumanizeLogger,
  humanize: vi.fn(() => ({
    type: humanizeMocks.type,
  })),
}));

function createMockPage(options: {
  initialUrl: string;
  getAttribute?: (
    selector: string,
    name: string,
    currentUrl: string,
  ) => string | null;
  onWait?: () => void;
  isVisible: (selector: string, currentUrl: string) => boolean;
  selfProfileGotoUrl?: string;
  textContent?: (selector: string, currentUrl: string) => string | null;
  waitForUrlResult?: string;
}): { page: Page; gotoCalls: string[]; setUrl: (url: string) => void } {
  let currentUrl = options.initialUrl;
  const gotoCalls: string[] = [];

  const typeCalls: Array<{ selector: string; value: string }> = [];

  const page = {
    url: vi.fn(() => currentUrl),
    goto: vi.fn(async (url: string) => {
      currentUrl =
        url === "https://www.linkedin.com/in/me/"
          ? (options.selfProfileGotoUrl ??
            "https://www.linkedin.com/in/test-operator/")
          : url;
      gotoCalls.push(url);
    }),
    waitForURL: vi.fn(async (matcher: unknown) => {
      if (options.waitForUrlResult) {
        currentUrl = options.waitForUrlResult;
      }

      if (typeof matcher === "function") {
        if (matcher(new URL(currentUrl)) !== true) {
          throw new Error("Timed out waiting for URL");
        }
        return;
      }

      if (matcher instanceof RegExp) {
        if (!matcher.test(currentUrl)) {
          throw new Error("Timed out waiting for URL");
        }
        return;
      }

      if (typeof matcher === "string" && matcher !== currentUrl) {
        throw new Error("Timed out waiting for URL");
      }
    }),
    waitForTimeout: vi.fn(async () => {
      options.onWait?.();
    }),
    evaluate: vi.fn(async () => undefined),
    type: vi.fn(async (selector: string, value: string) => {
      typeCalls.push({ selector, value });
    }),
    locator: vi.fn((selector: string) => {
      const visible = options.isVisible(selector, currentUrl);
      const click = vi.fn(async () => undefined);
      const count = vi.fn(async () => (visible ? 1 : 0));
      const isVisible = vi.fn(async () => visible);
      const waitFor = vi.fn(async () => {
        if (!visible) throw new Error("Timeout waiting for locator");
      });
      const textContent = vi.fn(async () => {
        return options.textContent?.(selector, currentUrl) ?? null;
      });
      const getAttribute = vi.fn(async (name: string) => {
        return options.getAttribute?.(selector, name, currentUrl) ?? null;
      });
      const first = vi.fn();
      const mockLocator = {
        click,
        count,
        first,
        getAttribute,
        isVisible,
        textContent,
        waitFor,
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
      return mockLocator;
    }),
    context: vi.fn(() => ({
      cookies: vi.fn(async () => []),
    })),
  } as unknown as Page;

  return {
    page,
    gotoCalls,
    typeCalls,
    setUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

function createContextWithPage(page: Page): BrowserContext {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
  } as unknown as BrowserContext;
}

describe("LinkedInAuthService auth flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitStateMocks.clearRateLimitState.mockResolvedValue(undefined);
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: false,
      state: null,
    });
    humanizeMocks.type.mockResolvedValue(undefined);
  });

  it("openLogin does not force navigation to feed while polling login", async () => {
    let waitCount = 0;
    let navVisible = false;

    const { page, gotoCalls, setUrl } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      onWait: () => {
        waitCount += 1;
        if (waitCount >= 2) {
          navVisible = true;
          setUrl("https://www.linkedin.com/feed/");
        }
      },
      isVisible: (selector, currentUrl) => {
        if (selector.includes("session_key")) {
          return currentUrl.includes("/login");
        }
        if (selector === "nav.global-nav") {
          return navVisible;
        }
        return false;
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const result = await auth.openLogin({
      profileName: "default",
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    });

    expect(result.authenticated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(gotoCalls).toEqual([
      "https://www.linkedin.com/login",
      "https://www.linkedin.com/in/me/",
    ]);
    expect(rateLimitStateMocks.clearRateLimitState).toHaveBeenCalledTimes(1);
  });

  it("status still checks live auth during cooldown and clears stale cooldown on success", async () => {
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: true,
      state: {
        rateLimitedUntil: "2026-02-23T12:00:00.000Z",
        detectedAt: "2026-02-23T10:00:00.000Z",
        consecutiveRateLimits: 1,
      },
    });

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav",
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const status = await auth.status({ profileName: "default" });

    expect(status.authenticated).toBe(true);
    expect(status.evasion).toMatchObject({
      diagnosticsEnabled: false,
      level: "moderate",
      source: "default",
    });
    expect(status.rateLimitActive).toBeUndefined();
    expect(rateLimitStateMocks.clearRateLimitState).toHaveBeenCalledTimes(1);
  });

  it("status enriches authenticated sessions with member identity", async () => {
    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/feed/",
      getAttribute: (selector, name, currentUrl) => {
        if (
          selector === "link[rel='canonical']" &&
          name === "href" &&
          currentUrl.includes("/in/test-operator/")
        ) {
          return "https://www.linkedin.com/in/test-operator/";
        }

        return null;
      },
      isVisible: (selector) => selector === "nav.global-nav",
      textContent: (selector, currentUrl) => {
        if (
          selector === "main h1" &&
          currentUrl.includes("/in/test-operator/")
        ) {
          return "Test Operator";
        }

        return null;
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const status = await auth.status({ profileName: "default" });

    expect(status.identity).toEqual({
      fullName: "Test Operator",
      profileUrl: "https://www.linkedin.com/in/test-operator/",
      vanityName: "test-operator",
    });
  });

  it("status does not treat /in/me/ as a resolved member slug", async () => {
    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav",
      selfProfileGotoUrl: "https://www.linkedin.com/in/me/",
      textContent: (selector, currentUrl) => {
        if (selector === "main h1" && currentUrl.includes("/in/me/")) {
          return "Fallback Operator";
        }

        return null;
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const status = await auth.status({ profileName: "default" });

    expect(status.identity).toEqual({
      fullName: "Fallback Operator",
      profileUrl: null,
      vanityName: null,
    });
  });

  it("ensureAuthenticated throws RATE_LIMITED when session is unauthenticated during cooldown", async () => {
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: true,
      state: {
        rateLimitedUntil: "2026-02-23T12:00:00.000Z",
        detectedAt: "2026-02-23T10:00:00.000Z",
        consecutiveRateLimits: 1,
      },
    });

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector, currentUrl) =>
        selector.includes("session_key") && currentUrl.includes("/login"),
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    await expect(
      auth.ensureAuthenticated({ profileName: "default" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("linkedin rate-limit --clear"),
    });
  });

  it("ensureAuthenticated restores stored session when persistent profile is unauthenticated", async () => {
    let callCount = 0;

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector) => {
        if (callCount === 0) {
          return (
            selector.includes("session_key") || selector.includes("/login")
          );
        }
        return selector === "nav.global-nav";
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => {
        const result = await callback(context);
        callCount += 1;
        return result;
      }),
    } as const;

    const sessionStore = {
      restoreToContext: vi.fn(async () => ({
        storageState: { cookies: [], origins: [] },
        metadata: {},
        restoredFromBackup: false,
        restoredSessionName: "default",
      })),
    };

    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
      undefined,
      "en",
      undefined,
      undefined,
      sessionStore as unknown as import("../auth/sessionStore.js").LinkedInSessionStore,
    );

    const result = await auth.ensureAuthenticated({ profileName: "default" });

    expect(result.authenticated).toBe(true);
    expect(sessionStore.restoreToContext).toHaveBeenCalledTimes(1);
    expect(profileManager.runWithContext).toHaveBeenCalledTimes(2);
  });

  it("ensureAuthenticated throws AUTH_REQUIRED when stored session restore fails", async () => {
    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector, currentUrl) =>
        selector.includes("session_key") && currentUrl.includes("/login"),
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;

    const sessionStore = {
      restoreToContext: vi.fn(async () => {
        throw new Error("No stored session found");
      }),
    };

    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
      undefined,
      "en",
      undefined,
      undefined,
      sessionStore as unknown as import("../auth/sessionStore.js").LinkedInSessionStore,
    );

    await expect(
      auth.ensureAuthenticated({ profileName: "default" }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    expect(sessionStore.restoreToContext).toHaveBeenCalledTimes(1);
  });

  it("ensureAuthenticated skips stored session restore during rate-limit cooldown", async () => {
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: true,
      state: {
        rateLimitedUntil: "2026-02-23T12:00:00.000Z",
        detectedAt: "2026-02-23T10:00:00.000Z",
        consecutiveRateLimits: 1,
      },
    });

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector, currentUrl) =>
        selector.includes("session_key") && currentUrl.includes("/login"),
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;

    const sessionStore = {
      restoreToContext: vi.fn(async () => ({
        storageState: { cookies: [], origins: [] },
        metadata: {},
        restoredFromBackup: false,
        restoredSessionName: "default",
      })),
    };

    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
      undefined,
      "en",
      undefined,
      undefined,
      sessionStore as unknown as import("../auth/sessionStore.js").LinkedInSessionStore,
    );

    await expect(
      auth.ensureAuthenticated({ profileName: "default" }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });

    expect(sessionStore.restoreToContext).not.toHaveBeenCalled();
  });

  it("ensureAuthenticated works without session store (backward compatible)", async () => {
    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector, currentUrl) =>
        selector.includes("session_key") && currentUrl.includes("/login"),
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;

    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    await expect(
      auth.ensureAuthenticated({ profileName: "default" }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    expect(profileManager.runWithContext).toHaveBeenCalledTimes(1);
  });

  it("headlessLogin classifies CAPTCHA checkpoints with shared selectors", async () => {
    let waitCount = 0;
    const checkpointUrl =
      "https://www.linkedin.com/checkpoint/challenge/AgCaptcha";

    const { page, typeCalls, setUrl } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      onWait: () => {
        waitCount += 1;
        if (waitCount === 1) {
          setUrl(checkpointUrl);
        }
      },
      isVisible: (selector, currentUrl) => {
        if (selector.includes("username")) {
          return currentUrl.includes("/login");
        }

        if (
          selector.includes("session_password") ||
          selector.includes("password")
        ) {
          return currentUrl.includes("/login");
        }

        if (selector === "form[action*='checkpoint']") {
          return currentUrl.includes("/checkpoint");
        }

        if (selector === "[data-sitekey]") {
          return currentUrl.includes("/checkpoint");
        }

        return false;
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const result = await auth.headlessLogin({
      email: "test@example.com",
      password: "secret",
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.authenticated).toBe(false);
    expect(result.checkpoint).toBe(true);
    expect(result.checkpointType).toBe("captcha");
    expect(result.currentUrl).toBe(checkpointUrl);
    expect(rateLimitStateMocks.recordRateLimit).not.toHaveBeenCalled();
    expect(typeCalls).toHaveLength(2);
    expect(page.type as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
  });

  it("headlessLogin targets nameless login inputs when legacy names are absent", async () => {
    let waitCount = 0;
    let navVisible = false;

    const { page, typeCalls, setUrl } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      onWait: () => {
        waitCount += 1;
        if (waitCount === 1) {
          navVisible = true;
          setUrl("https://www.linkedin.com/feed/");
        }
      },
      isVisible: (selector, currentUrl) => {
        if (selector.includes("username")) {
          return currentUrl.includes("/login");
        }

        if (
          selector.includes("session_password") ||
          selector.includes("password")
        ) {
          return currentUrl.includes("/login");
        }

        if (selector === "nav.global-nav") {
          return navVisible;
        }

        return false;
      },
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context)),
    } as const;
    const auth = new LinkedInAuthService(
      profileManager as unknown as ProfileManager,
    );

    const result = await auth.headlessLogin({
      email: "test@example.com",
      password: "secret",
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(result.authenticated).toBe(true);
    expect(result.checkpoint).toBe(false);
    expect(typeCalls).toHaveLength(2);
    expect(typeCalls[0]!.value).toBe("test@example.com");
    expect(typeCalls[1]!.value).toBe("secret");
  });
});
