import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright-core";
import {
  inspectAuthenticatedLinkedInIdentity,
  inspectLinkedInSession
} from "../auth/sessionInspection.js";

function createMockPage(options: {
  url: string;
  cookies?: readonly { name: string; value: string }[];
  getAttribute?: (selector: string, name: string, currentUrl: string) => string | null;
  isVisible?: (selector: string) => boolean;
  textContent?: (selector: string, currentUrl: string) => string | null;
}): Page {
  let currentUrl = options.url;

  return {
    goto: vi.fn(async (url: string) => {
      currentUrl = url === "https://www.linkedin.com/in/me/"
        ? "https://www.linkedin.com/in/test-member/"
        : url;
    }),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((selector: string) => {
      const visible = options.isVisible?.(selector) ?? false;
      const isVisible = vi.fn(async () => visible);
      const textContent = vi.fn(async () => options.textContent?.(selector, currentUrl) ?? null);
      const getAttribute = vi.fn(async (name: string) => {
        return options.getAttribute?.(selector, name, currentUrl) ?? null;
      });
      const first = vi.fn();
      const mockLocator = {
        first,
        getAttribute,
        isVisible,
        textContent
      } as unknown as Locator;
      first.mockReturnValue(mockLocator);
      return mockLocator;
    }),
    context: vi.fn(
      () =>
        ({
          cookies: vi.fn(async () => options.cookies ?? [])
        }) as unknown as BrowserContext
    )
  } as unknown as Page;
}

describe("inspectLinkedInSession", () => {
  it("treats missing cookies and missing auth selectors as unauthenticated", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/"
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.loginWallDetected).toBe(false);
    expect(status.reason).toBe(
      "Could not confirm an authenticated LinkedIn session."
    );
    expect(status.sessionCookiePresent).toBe(false);
  });

  it("marks the session unauthenticated when the login form is visible", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector.includes("input[name='session_key']")
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.loginWallDetected).toBe(false);
    expect(status.reason).toBe("Login form is visible.");
  });

  it("detects a login wall even when the URL still looks like feed", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector.includes("[data-test-id='sign-in-form']")
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.loginWallDetected).toBe(true);
    expect(status.reason).toBe("LinkedIn login wall detected.");
  });

  it("detects LinkedIn rate-limit challenge URLs", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/checkpoint/challenge?errorKey=challenge_global_internal_error"
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.checkpointDetected).toBe(true);
    expect(status.rateLimited).toBe(true);
    expect(status.reason).toBe("LinkedIn rate-limit challenge detected.");
  });

  it("flags LinkedIn authwall pages as login walls", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/authwall?trk=public_profile"
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.loginWallDetected).toBe(true);
    expect(status.reason).toContain("Login form");
  });

  it("authenticates when the localized profile-menu aria label is visible", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector.includes('button[aria-label*="Mig" i]')
    });

    const status = await inspectLinkedInSession(page, {
      selectorLocale: "da"
    });

    expect(status.authenticated).toBe(true);
    expect(status.loginWallDetected).toBe(false);
    expect(status.reason).toContain("authenticated");
  });

  it("keeps the english profile-menu fallback active for non-english locales", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector.includes('button[aria-label*="Me" i]')
    });

    const status = await inspectLinkedInSession(page, {
      selectorLocale: "da"
    });

    expect(status.authenticated).toBe(true);
    expect(status.reason).toContain("authenticated");
  });

  it("keeps the stable profile-menu attribute fallback locale-independent", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) =>
        selector.includes("[data-control-name='nav.settings_view_profile']")
    });

    const status = await inspectLinkedInSession(page, {
      selectorLocale: "da"
    });

    expect(status.authenticated).toBe(true);
    expect(status.reason).toContain("authenticated");
  });

  it("extracts the authenticated member identity from the self profile page", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      getAttribute: (selector, name, currentUrl) => {
        if (
          selector === "link[rel='canonical']" &&
          name === "href" &&
          currentUrl.includes("/in/test-member/")
        ) {
          return "https://www.linkedin.com/in/test-member/";
        }

        return null;
      },
      textContent: (selector, currentUrl) => {
        if (selector === "main h1" && currentUrl.includes("/in/test-member/")) {
          return " Test   Member ";
        }

        return null;
      }
    });

    const identity = await inspectAuthenticatedLinkedInIdentity(page);

    expect(identity).toEqual({
      fullName: "Test Member",
      profileUrl: "https://www.linkedin.com/in/test-member/",
      vanityName: "test-member"
    });
  });
});
