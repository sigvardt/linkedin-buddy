import type { Locator, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR,
  createFeedPostComposerTriggerCandidates,
} from "../feedPostComposerTriggerSelectors.js";

describe("feed post compositor trigger selectors", () => {
  it("keeps feed composer link selectors for sharebox preload paths", () => {
    expect(LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toContain(
      "/preload/sharebox/",
    );
    expect(LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toContain(
      "/preload/sharebox",
    );
  });

  it("creates stable trigger candidates for localized feed composer detection", () => {
    const candidates = createFeedPostComposerTriggerCandidates("en");

    expect(candidates.map((candidate) => candidate.key)).toEqual([
      "role-button-start-post",
      "sharebox-entry-link-or-share-box-trigger",
      "text-start-post",
    ]);
    expect(
      candidates.every((candidate) => candidate.selectorHint.length > 0),
    ).toBe(true);
  });

  it("builds locator factories for button, link, and text trigger paths", () => {
    const roleLocator = {} as Locator;
    const shareBoxLocator = {} as Locator;
    const textFilteredLocator = {} as Locator;
    const baseButtonLocator = {
      filter: vi.fn(() => textFilteredLocator),
    } as unknown as Locator;

    const page = {
      getByRole: vi.fn(() => roleLocator),
      locator: vi.fn((selector: string) => {
        if (selector === "button, [role='button'], a") {
          return baseButtonLocator;
        }

        return shareBoxLocator;
      }),
    } as unknown as Page;

    const candidates = createFeedPostComposerTriggerCandidates("en");

    expect(candidates[0]?.locatorFactory(page)).toBe(roleLocator);
    expect(candidates[1]?.locatorFactory(page)).toBe(shareBoxLocator);
    expect(candidates[2]?.locatorFactory(page)).toBe(textFilteredLocator);
    expect(page.getByRole).toHaveBeenCalledWith(
      "button",
      expect.objectContaining({ name: expect.any(RegExp) }),
    );
    expect(page.locator).toHaveBeenCalledWith("button, [role='button'], a");
  });
});
