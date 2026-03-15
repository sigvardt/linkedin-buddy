import type { Locator, Page } from "playwright-core";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint
} from "./selectorLocale.js";

export interface FeedPostComposerTriggerCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

export const LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR =
  "a[href$='/preload/sharebox/'], a[href$='/preload/sharebox']";

export function createFeedPostComposerTriggerCandidates(
  selectorLocale: LinkedInSelectorLocale
): FeedPostComposerTriggerCandidate[] {
  const startPostExactRegex = buildLinkedInSelectorPhraseRegex(
    "start_post",
    selectorLocale,
    { exact: true }
  );
  const startPostExactRegexHint = formatLinkedInSelectorRegexHint(
    "start_post",
    selectorLocale,
    { exact: true }
  );
  const startPostTextRegex = buildLinkedInSelectorPhraseRegex(
    "start_post",
    selectorLocale
  );
  const startPostTextRegexHint = formatLinkedInSelectorRegexHint(
    "start_post",
    selectorLocale
  );
  const shareBoxTriggerSelector = `${LINKEDIN_FEED_POST_COMPOSER_LINK_SELECTOR}, .share-box-feed-entry__trigger, .share-box__open`;

  return [
    {
      key: "role-button-start-post",
      selectorHint: `getByRole(button, ${startPostExactRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("button", { name: startPostExactRegex })
    },
    {
      key: "sharebox-entry-link-or-share-box-trigger",
      selectorHint: shareBoxTriggerSelector,
      locatorFactory: (page) => page.locator(shareBoxTriggerSelector)
    },
    {
      key: "text-start-post",
      selectorHint: `button, [role='button'], a hasText ${startPostTextRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("button, [role='button'], a")
          .filter({ hasText: startPostTextRegex })
    },
    {
      key: "sharebox-preload-any-link",
      selectorHint: "a[href*='sharebox'], button[data-control-name*='share']",
      locatorFactory: (page) =>
        page.locator("a[href*='sharebox'], button[data-control-name*='share']")
    },
    {
      key: "feed-share-trigger-class",
      selectorHint:
        ".share-creation-state__trigger, .feed-shared-update-v2__share-trigger",
      locatorFactory: (page) =>
        page.locator(
          ".share-creation-state__trigger, .feed-shared-update-v2__share-trigger"
        )
    }
  ];
}
