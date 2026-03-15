import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { resolveEvasionConfig } from "../config.js";
import { checkBrowserHealth, checkLinkedInSession } from "../healthCheck.js";

function createMockPage(opts: {
  getAttribute?: (
    selector: string,
    name: string,
    currentUrl: string
  ) => string | null;
  url: string;
  evaluateResult?: unknown;
  isVisible?: (selector: string) => boolean;
  selfProfileGotoUrl?: string;
  textContent?: (selector: string, currentUrl: string) => string | null;
  waitForUrlResult?: string;
}): Page {
  let currentUrl = opts.url;

  return {
    evaluate: vi.fn(async () => {
      if (opts.evaluateResult instanceof Error) {
        throw opts.evaluateResult;
      }
      return opts.evaluateResult ?? 2;
    }),
    url: vi.fn(() => currentUrl),
    goto: vi.fn(async (url: string) => {
      currentUrl =
        url === "https://www.linkedin.com/in/me/"
          ? (opts.selfProfileGotoUrl ??
            "https://www.linkedin.com/in/test-health/")
          : opts.url;
    }),
    waitForURL: vi.fn(async (matcher: unknown) => {
      if (opts.waitForUrlResult) {
        currentUrl = opts.waitForUrlResult;
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
    locator: vi.fn((selector: string) => {
      const visible = opts.isVisible?.(selector) ?? false;
      const isVisible = vi.fn(async () => visible);
      const textContent = vi.fn(async () => {
        return opts.textContent?.(selector, currentUrl) ?? null;
      });
      const getAttribute = vi.fn(async (name: string) => {
        return opts.getAttribute?.(selector, name, currentUrl) ?? null;
      });
      const first = vi.fn();
      const filter = vi.fn();
      const mockLocator = {
        filter,
        first,
        getAttribute,
        isVisible,
        textContent
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
      filter.mockReturnValue(mockLocator);
      return mockLocator;
    })
  } as unknown as Page;
}

function createMockContext(opts: {
  cookies?: Array<{
    domain: string;
    expires: number;
    httpOnly: boolean;
    name: string;
    path: string;
    sameSite: "Lax" | "None" | "Strict";
    secure: boolean;
    value: string;
  }>;
  connected: boolean;
  pages: Page[];
}): BrowserContext {
  const mockBrowser = {
    isConnected: vi.fn(() => opts.connected)
  } as unknown as Browser;

  return {
    browser: vi.fn(() => mockBrowser),
    cookies: vi.fn(async () => opts.cookies ?? []),
    pages: vi.fn(() => opts.pages),
    newPage: vi.fn(async () => {
      const [firstPage] = opts.pages;
      if (!firstPage) {
        throw new Error("No mock page configured");
      }
      return firstPage;
    })
  } as unknown as BrowserContext;
}

describe("checkBrowserHealth", () => {
  it("is healthy when connected and page responsive", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      evaluateResult: 2
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkBrowserHealth(context);

    expect(status.healthy).toBe(true);
    expect(status.browserConnected).toBe(true);
    expect(status.pageResponsive).toBe(true);
    expect(status.checkedAt).toContain("T");
  });

  it("is unhealthy when browser disconnected", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/"
    });
    const context = createMockContext({
      connected: false,
      pages: [page]
    });

    const status = await checkBrowserHealth(context);

    expect(status.healthy).toBe(false);
    expect(status.browserConnected).toBe(false);
    expect(status.pageResponsive).toBe(false);
  });

  it("is unhealthy when page unresponsive", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      evaluateResult: new Error("Page crashed")
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkBrowserHealth(context);

    expect(status.healthy).toBe(false);
    expect(status.browserConnected).toBe(true);
    expect(status.pageResponsive).toBe(false);
  });
});

describe("checkLinkedInSession", () => {
  it("is authenticated when nav is visible", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav"
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkLinkedInSession(context);

    expect(status.authenticated).toBe(true);
    expect(status.checkpointDetected).toBe(false);
    expect(status.cookieExpiringSoon).toBe(false);
    expect(status.currentUrl).toContain("/feed");
    expect(status.loginWallDetected).toBe(false);
    expect(status.reason).toContain("authenticated");
    expect(status.evasion).toMatchObject({
      diagnosticsEnabled: false,
      level: "moderate",
      source: "default"
    });
    expect(status.sessionCookiePresent).toBe(false);
  });

  it("is unauthenticated when login form is visible", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/login",
      isVisible: (selector) => selector.includes("session_key")
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkLinkedInSession(context);

    expect(status.authenticated).toBe(false);
    expect(status.checkpointDetected).toBe(false);
    expect(status.loginWallDetected).toBe(true);
    expect(status.currentUrl).toContain("/login");
    expect(status.reason).toContain("Login form");
  });

  it("surfaces cookie expiry metadata for proactive refresh decisions", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav"
    });
    const context = createMockContext({
      connected: true,
      cookies: [
        {
          name: "li_at",
          value: "token",
          domain: ".linkedin.com",
          path: "/",
          expires: Math.floor((Date.now() + 30 * 60_000) / 1_000),
          httpOnly: true,
          secure: true,
          sameSite: "Lax"
        }
      ],
      pages: [page]
    });

    const status = await checkLinkedInSession(context);

    expect(status.authenticated).toBe(true);
    expect(status.cookieExpiringSoon).toBe(true);
    expect(status.nextCookieExpiryAt).toContain("T");
    expect(status.sessionCookieFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(status.sessionCookiePresent).toBe(true);
    expect(status.sessionCookies).toHaveLength(1);
  });

  it("propagates the runtime evasion snapshot into health output", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav"
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });
    const evasion = resolveEvasionConfig({
      diagnosticsEnabled: true,
      level: "paranoid"
    });

    const status = await checkLinkedInSession(context, { evasion });

    expect(status.evasion).toBe(evasion);
  });

  it("includes the authenticated member identity when the profile page resolves", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      getAttribute: (selector, name, currentUrl) => {
        if (
          selector === "link[rel='canonical']" &&
          name === "href" &&
          currentUrl.includes("/in/test-health/")
        ) {
          return "https://www.linkedin.com/in/test-health/";
        }

        return null;
      },
      isVisible: (selector) => selector === "nav.global-nav",
      textContent: (selector, currentUrl) => {
        if (selector === "main h1" && currentUrl.includes("/in/test-health/")) {
          return "Health Check User";
        }

        return null;
      }
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkLinkedInSession(context);

    expect(status.identity).toEqual({
      fullName: "Health Check User",
      profileUrl: "https://www.linkedin.com/in/test-health/",
      vanityName: "test-health"
    });
  });

  it("keeps health identity partial when /in/me/ never resolves", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector === "nav.global-nav",
      selfProfileGotoUrl: "https://www.linkedin.com/in/me/",
      textContent: (selector, currentUrl) => {
        if (selector === "main h1" && currentUrl.includes("/in/me/")) {
          return "Health Fallback";
        }

        return null;
      }
    });
    const context = createMockContext({
      connected: true,
      pages: [page]
    });

    const status = await checkLinkedInSession(context);

    expect(status.identity).toEqual({
      fullName: "Health Fallback",
      profileUrl: null,
      vanityName: null
    });
  });
});
