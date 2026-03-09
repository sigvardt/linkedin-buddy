import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { inspectLinkedInSession } from "../auth/sessionInspection.js";

function createMockPage(options: {
  url: string;
  cookies?: readonly { name: string; value: string }[];
  isVisible?: (selector: string) => boolean;
}): Page {
  return {
    url: vi.fn(() => options.url),
    locator: vi.fn((selector: string) => {
      const visible = options.isVisible?.(selector) ?? false;
      const isVisible = vi.fn(async () => visible);
      const first = vi.fn();
      const mockLocator = {
        first,
        isVisible
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
    expect(status.reason).toBe(
      "Could not confirm an authenticated LinkedIn session."
    );
  });

  it("marks the session unauthenticated when the login form is visible", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/feed/",
      isVisible: (selector) => selector.includes("input[name='session_key']")
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.reason).toBe("Login form is visible.");
  });

  it("detects LinkedIn rate-limit challenge URLs", async () => {
    const page = createMockPage({
      url: "https://www.linkedin.com/checkpoint/challenge?errorKey=challenge_global_internal_error"
    });

    const status = await inspectLinkedInSession(page);

    expect(status.authenticated).toBe(false);
    expect(status.reason).toBe("LinkedIn rate-limit challenge detected.");
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
});
