import { describe, expect, it } from "vitest";
import {
  LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR,
  createFeedPostComposerTriggerCandidates
} from "../feedPostComposerTriggerSelectors.js";

describe("LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR", () => {
  it("matches sharebox preload links with a trailing slash", () => {
    expect(LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toContain(
      "a[href$='/preload/sharebox/']"
    );
  });

  it("matches sharebox preload links without a trailing slash", () => {
    expect(LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toContain(
      "a[href$='/preload/sharebox']"
    );
  });

  it("is a valid CSS selector string", () => {
    expect(typeof LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toBe("string");
    expect(LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR).toBeTruthy();

    const selectorParts = LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR
      .split(",")
      .map((part) => part.trim());

    expect(selectorParts).toEqual([
      "a[href$='/preload/sharebox/']",
      "a[href$='/preload/sharebox']"
    ]);
  });
});

describe("createFeedPostComposerTriggerCandidates", () => {
  it("returns the expected five candidates with required fields", () => {
    const candidates = createFeedPostComposerTriggerCandidates("en");

    expect(candidates).toHaveLength(5);

    for (const candidate of candidates) {
      expect(candidate).toHaveProperty("key");
      expect(candidate).toHaveProperty("selectorHint");
      expect(candidate).toHaveProperty("locatorFactory");
      expect(typeof candidate.key).toBe("string");
      expect(candidate.key.length).toBeGreaterThan(0);
      expect(typeof candidate.selectorHint).toBe("string");
      expect(candidate.selectorHint.length).toBeGreaterThan(0);
      expect(typeof candidate.locatorFactory).toBe("function");
    }
  });

  it("uses expected candidate key ordering", () => {
    const candidates = createFeedPostComposerTriggerCandidates("en");

    expect(candidates[0]?.key).toBe("role-button-start-post");
    expect(candidates[1]?.key).toBe("sharebox-entry-link-or-share-box-trigger");
    expect(candidates[2]?.key).toBe("text-start-post");
  });

  it("uses english selector hints for default locale", () => {
    const [roleButtonCandidate, , textCandidate] =
      createFeedPostComposerTriggerCandidates("en");

    expect(roleButtonCandidate?.selectorHint).toContain("Start a post");
    expect(textCandidate?.selectorHint).toContain("Start a post");
  });

  it("produces localized hints for danish locale", () => {
    const englishCandidates = createFeedPostComposerTriggerCandidates("en");
    const danishCandidates = createFeedPostComposerTriggerCandidates("da");

    expect(danishCandidates).toHaveLength(5);
    expect(danishCandidates[0]?.selectorHint).toContain("Start et opslag");
    expect(danishCandidates[0]?.selectorHint).not.toBe(
      englishCandidates[0]?.selectorHint
    );
  });
});
