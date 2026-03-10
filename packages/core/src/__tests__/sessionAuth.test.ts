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
    consecutiveRateLimits: 1
  }))
}));

vi.mock("../auth/rateLimitState.js", () => ({
  clearRateLimitState: rateLimitStateMocks.clearRateLimitState,
  isInRateLimitCooldown: rateLimitStateMocks.isInRateLimitCooldown,
  recordRateLimit: rateLimitStateMocks.recordRateLimit
}));

function createMockPage(options: {
  initialUrl: string;
  onWait?: () => void;
  isVisible: (selector: string, currentUrl: string) => boolean;
}): { page: Page; gotoCalls: string[]; setUrl: (url: string) => void } {
  let currentUrl = options.initialUrl;
  const gotoCalls: string[] = [];

  const page = {
    url: vi.fn(() => currentUrl),
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
      gotoCalls.push(url);
    }),
    waitForTimeout: vi.fn(async () => {
      options.onWait?.();
    }),
    locator: vi.fn((selector: string) => {
      const visible = options.isVisible(selector, currentUrl);
      const isVisible = vi.fn(async () => visible);
      const first = vi.fn();
      const mockLocator = {
        first,
        isVisible
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
      return mockLocator;
    }),
    context: vi.fn(() => ({
      cookies: vi.fn(async () => [])
    }))
  } as unknown as Page;

  return {
    page,
    gotoCalls,
    setUrl: (url: string) => {
      currentUrl = url;
    }
  };
}

function createContextWithPage(page: Page): BrowserContext {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page)
  } as unknown as BrowserContext;
}

describe("LinkedInAuthService auth flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitStateMocks.clearRateLimitState.mockResolvedValue(undefined);
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: false,
      state: null
    });
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
      }
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context))
    } as const;
    const auth = new LinkedInAuthService(profileManager as unknown as ProfileManager);

    const result = await auth.openLogin({
      profileName: "default",
      timeoutMs: 2_000,
      pollIntervalMs: 1
    });

    expect(result.authenticated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(gotoCalls).toEqual(["https://www.linkedin.com/login"]);
    expect(rateLimitStateMocks.clearRateLimitState).toHaveBeenCalledTimes(1);
  });

  it("status still checks live auth during cooldown and clears stale cooldown on success", async () => {
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: true,
      state: {
        rateLimitedUntil: "2026-02-23T12:00:00.000Z",
        detectedAt: "2026-02-23T10:00:00.000Z",
        consecutiveRateLimits: 1
      }
    });

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav"
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context))
    } as const;
    const auth = new LinkedInAuthService(profileManager as unknown as ProfileManager);

    const status = await auth.status({ profileName: "default" });

    expect(status.authenticated).toBe(true);
    expect(status.evasion).toMatchObject({
      diagnosticsEnabled: false,
      level: "moderate",
      source: "default"
    });
    expect(status.rateLimitActive).toBeUndefined();
    expect(rateLimitStateMocks.clearRateLimitState).toHaveBeenCalledTimes(1);
  });

  it("ensureAuthenticated throws RATE_LIMITED when session is unauthenticated during cooldown", async () => {
    rateLimitStateMocks.isInRateLimitCooldown.mockResolvedValue({
      active: true,
      state: {
        rateLimitedUntil: "2026-02-23T12:00:00.000Z",
        detectedAt: "2026-02-23T10:00:00.000Z",
        consecutiveRateLimits: 1
      }
    });

    const { page } = createMockPage({
      initialUrl: "https://www.linkedin.com/login",
      isVisible: (selector, currentUrl) =>
        selector.includes("session_key") && currentUrl.includes("/login")
    });

    const context = createContextWithPage(page);
    const profileManager = {
      runWithContext: vi.fn(async (_options, callback) => callback(context))
    } as const;
    const auth = new LinkedInAuthService(profileManager as unknown as ProfileManager);

    await expect(
      auth.ensureAuthenticated({ profileName: "default" })
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("linkedin rate-limit --clear")
    });
  });
});
