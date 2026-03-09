import { describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { checkBrowserHealth, checkLinkedInSession } from "../healthCheck.js";

function createMockPage(opts: {
  url: string;
  evaluateResult?: unknown;
  isVisible?: (selector: string) => boolean;
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
    goto: vi.fn(async () => {
      currentUrl = opts.url;
    }),
    locator: vi.fn((selector: string) => {
      const visible = opts.isVisible?.(selector) ?? false;
      const isVisible = vi.fn(async () => visible);
      const first = vi.fn();
      const mockLocator = {
        first,
        isVisible
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
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
});
