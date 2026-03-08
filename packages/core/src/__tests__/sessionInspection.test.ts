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
