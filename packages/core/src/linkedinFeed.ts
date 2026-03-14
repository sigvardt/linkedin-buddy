import { mkdirSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import {
  scrollLinkedInPageToBottom,
  scrollLinkedInPageToTop,
} from "./linkedinPage.js";
import type { JsonEventLogger } from "./logging.js";
import { validateLinkedInPostText } from "./linkedinPosts.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  formatRateLimitState,
  type RateLimiter,
  type RateLimiterState,
} from "./rateLimiter.js";
import type {
  LinkedInSelectorLocale,
  LinkedInSelectorPhraseKey,
} from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  valueContainsLinkedInSelectorPhrase,
} from "./selectorLocale.js";
import {
  normalizeText,
  getOrCreatePage,
  escapeCssAttributeValue,
  isAbsoluteUrl,
  isLocatorVisible,
} from "./shared.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService,
} from "./twoPhaseCommit.js";

export interface LinkedInFeedPost {
  post_id: string;
  author_name: string;
  author_headline: string;
  author_profile_url: string;
  posted_at: string;
  text: string;
  reactions_count: string;
  comments_count: string;
  reposts_count: string;
  post_url: string;
}

export interface ViewFeedInput {
  profileName?: string;
  limit?: number;
  mine?: boolean;
}

export interface ViewPostInput {
  profileName?: string;
  postUrl: string;
}

export interface LikePostInput {
  profileName?: string;
  postUrl: string;
  reaction?: LinkedInFeedReaction | string;
  operatorNote?: string;
}

export interface CommentOnPostInput {
  profileName?: string;
  postUrl: string;
  text: string;
  operatorNote?: string;
}

export interface RepostPostInput {
  profileName?: string;
  postUrl: string;
  operatorNote?: string;
}

export interface SharePostInput {
  profileName?: string;
  postUrl: string;
  text: string;
  operatorNote?: string;
}

export interface SavePostInput {
  profileName?: string;
  postUrl: string;
  operatorNote?: string;
}

export interface UnsavePostInput {
  profileName?: string;
  postUrl: string;
  operatorNote?: string;
}

export interface RemoveReactionInput {
  profileName?: string;
  postUrl: string;
  operatorNote?: string;
}

export interface LinkedInFeedExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInFeedRuntime extends LinkedInFeedExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInFeedExecutorRuntime>,
    "prepare"
  >;
}

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_MY_ACTIVITY_URL =
  "https://www.linkedin.com/in/me/recent-activity/all/";
export const LIKE_POST_ACTION_TYPE = "feed.like_post";
export const COMMENT_ON_POST_ACTION_TYPE = "feed.comment_on_post";
export const REPOST_POST_ACTION_TYPE = "feed.repost_post";
export const SHARE_POST_ACTION_TYPE = "feed.share_post";
export const SAVE_POST_ACTION_TYPE = "feed.save_post";
export const UNSAVE_POST_ACTION_TYPE = "feed.unsave_post";
export const REMOVE_REACTION_ACTION_TYPE = "feed.remove_reaction";

export const LINKEDIN_FEED_REACTION_TYPES = [
  "like",
  "celebrate",
  "support",
  "love",
  "insightful",
  "funny",
] as const;

export type LinkedInFeedReaction =
  (typeof LINKEDIN_FEED_REACTION_TYPES)[number];

const LIKE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.like_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30,
} as const;

const COMMENT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.comment_on_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 15,
} as const;

const REPOST_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.repost_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 10,
} as const;

const SHARE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.share_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 10,
} as const;

const SAVE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.save_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40,
} as const;

const UNSAVE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.unsave_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40,
} as const;

const REMOVE_REACTION_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.remove_reaction",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30,
} as const;

interface FeedReactionUiConfig {
  label: string;
  menuAriaLabel: string;
  iconType: string;
}

export const LINKEDIN_FEED_REACTION_MAP: Record<
  LinkedInFeedReaction,
  FeedReactionUiConfig
> = {
  like: {
    label: "Like",
    menuAriaLabel: "React Like",
    iconType: "LIKE",
  },
  celebrate: {
    label: "Celebrate",
    menuAriaLabel: "React Celebrate",
    iconType: "PRAISE",
  },
  support: {
    label: "Support",
    menuAriaLabel: "React Support",
    iconType: "APPRECIATION",
  },
  love: {
    label: "Love",
    menuAriaLabel: "React Love",
    iconType: "EMPATHY",
  },
  insightful: {
    label: "Insightful",
    menuAriaLabel: "React Insightful",
    iconType: "INTEREST",
  },
  funny: {
    label: "Funny",
    menuAriaLabel: "React Funny",
    iconType: "ENTERTAINMENT",
  },
};

const LINKEDIN_FEED_REACTION_ALIAS_MAP: Record<string, LinkedInFeedReaction> = {
  like: "like",
  likes: "like",
  thumbsup: "like",
  thumbs_up: "like",
  celebrate: "celebrate",
  celebration: "celebrate",
  praise: "celebrate",
  support: "support",
  appreciation: "support",
  love: "love",
  heart: "love",
  insightful: "insightful",
  insight: "insightful",
  interest: "insightful",
  funny: "funny",
  laugh: "funny",
  haha: "funny",
  entertainment: "funny",
};

interface FeedPostSnapshot {
  post_id: string;
  author_name: string;
  author_headline: string;
  author_profile_url: string;
  posted_at: string;
  text: string;
  reactions_count: string;
  comments_count: string;
  reposts_count: string;
  post_url: string;
}

interface SelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

interface TargetPostLocator {
  locator: Locator;
  key: string;
  postIdentity: string;
  activityId: string;
}

interface ScopedSelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: Locator) => Locator;
}

interface PostRepostButtonState {
  reposted: boolean;
  ariaLabel: string;
  ariaPressed: string;
  buttonText: string;
  className: string;
}

function createVerificationSnippet(text: string): string {
  return normalizeText(text).slice(0, 120);
}

function normalizeReactionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function normalizeLinkedInFeedReaction(
  value: string | undefined,
  fallback: LinkedInFeedReaction = "like",
): LinkedInFeedReaction {
  if (!value || normalizeText(value).length === 0) {
    return fallback;
  }

  const key = normalizeReactionKey(value);
  const mapped = LINKEDIN_FEED_REACTION_ALIAS_MAP[key];
  if (mapped) {
    return mapped;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `reaction must be one of: ${LINKEDIN_FEED_REACTION_TYPES.join(", ")}.`,
    {
      provided_reaction: value,
      supported_reactions: LINKEDIN_FEED_REACTION_TYPES,
    },
  );
}

function resolvePostUrl(postUrl: string): string {
  const trimmedPostUrl = normalizeText(postUrl);
  if (!trimmedPostUrl) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "postUrl is required.",
    );
  }

  if (isAbsoluteUrl(trimmedPostUrl)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedPostUrl);
    } catch (error) {
      throw asLinkedInBuddyError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Post URL must be a valid URL.",
      );
    }

    const pathname = parsedUrl.pathname.endsWith("/")
      ? parsedUrl.pathname
      : `${parsedUrl.pathname}/`;
    return `${parsedUrl.origin}${pathname}${parsedUrl.search}`;
  }

  if (trimmedPostUrl.startsWith("/feed/update/")) {
    return `https://www.linkedin.com${trimmedPostUrl}`;
  }

  if (/^urn:li:/i.test(trimmedPostUrl)) {
    return `https://www.linkedin.com/feed/update/${trimmedPostUrl}/`;
  }

  if (/^(?:activity|share):\d+$/i.test(trimmedPostUrl)) {
    return `https://www.linkedin.com/feed/update/urn:li:${trimmedPostUrl.toLowerCase()}/`;
  }

  if (/^\d+$/.test(trimmedPostUrl)) {
    return `https://www.linkedin.com/feed/update/urn:li:activity:${trimmedPostUrl}/`;
  }

  return `https://www.linkedin.com/feed/update/${encodeURIComponent(trimmedPostUrl)}/`;
}

function extractPostIdentity(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const urnMatch = /(urn:li:[^/?#]+)/i.exec(normalized);
  if (urnMatch?.[1]) {
    return urnMatch[1];
  }

  const updateMatch = /\/feed\/update\/([^/?#]+)/i.exec(normalized);
  if (updateMatch?.[1]) {
    try {
      return decodeURIComponent(updateMatch[1]);
    } catch {
      return updateMatch[1];
    }
  }

  const activityMatch = /activity[-:/](\d+)/i.exec(normalized);
  if (activityMatch?.[1]) {
    return activityMatch[1];
  }

  const postMatch = /\/posts\/[^/?#-]+-(\d+)/i.exec(normalized);
  if (postMatch?.[1]) {
    return postMatch[1];
  }

  return normalized;
}

function extractActivityId(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const match = /(\d{6,})/.exec(normalized);
  return match?.[1] ?? "";
}

function toAbsoluteLinkedInPostUrl(postId: string): string {
  const normalizedPostId = normalizeText(postId);
  if (!normalizedPostId) {
    return "";
  }

  if (/^urn:li:/i.test(normalizedPostId)) {
    return `https://www.linkedin.com/feed/update/${normalizedPostId}/`;
  }

  if (/^\d+$/.test(normalizedPostId)) {
    return `https://www.linkedin.com/feed/update/urn:li:activity:${normalizedPostId}/`;
  }

  return `https://www.linkedin.com/feed/update/${normalizedPostId}/`;
}

function toFeedPost(snapshot: FeedPostSnapshot): LinkedInFeedPost {
  const postId = normalizeText(snapshot.post_id);
  const postUrl =
    normalizeText(snapshot.post_url) || toAbsoluteLinkedInPostUrl(postId);

  return {
    post_id: postId,
    author_name: normalizeText(snapshot.author_name),
    author_headline: normalizeText(snapshot.author_headline),
    author_profile_url: normalizeText(snapshot.author_profile_url),
    posted_at: normalizeText(snapshot.posted_at),
    text: normalizeText(snapshot.text),
    reactions_count: normalizeText(snapshot.reactions_count),
    comments_count: normalizeText(snapshot.comments_count),
    reposts_count: normalizeText(snapshot.reposts_count),
    post_url: postUrl,
  };
}

function getProfileName(target: Record<string, unknown>): string {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return "default";
}

function getRequiredStringField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload",
): string {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key,
    },
  );
}

async function captureScreenshotArtifact(
  runtime: LinkedInFeedExecutorRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForFeedSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-testid='mainFeed']",
    "[data-testid='mainFeed'] [role='listitem']",
    "[data-component-type='LazyColumn']",
    "[data-urn]",
    ".feed-shared-update-v2",
    ".occludable-update",
    "main",
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn feed content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

async function waitForPostSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-testid='mainFeed']",
    "[data-urn]",
    ".feed-shared-update-v2",
    "article",
    "main",
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn post content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractFeedPosts(
  page: Page,
  limit: number,
): Promise<LinkedInFeedPost[]> {
  const snapshots = await page.evaluate(
    (maxPosts: number) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const toAbsoluteUrl = (href: string | null | undefined): string => {
        const value = normalize(href);
        if (!value) {
          return "";
        }

        try {
          return new URL(value, globalThis.window.location.origin).toString();
        } catch {
          return value;
        }
      };

      const extractPostId = (value: string): string => {
        const normalized = normalize(value);
        if (!normalized) {
          return "";
        }

        const urnMatch = /(urn:li:[^/?#]+)/i.exec(normalized);
        if (urnMatch?.[1]) {
          return urnMatch[1];
        }

        const updateMatch = /\/feed\/update\/([^/?#]+)/i.exec(normalized);
        if (updateMatch?.[1]) {
          try {
            return decodeURIComponent(updateMatch[1]);
          } catch {
            return updateMatch[1];
          }
        }

        const activityMatch = /activity[-:/](\d+)/i.exec(normalized);
        if (activityMatch?.[1]) {
          return activityMatch[1];
        }

        const postMatch = /\/posts\/[^/?#-]+-(\d+)/i.exec(normalized);
        if (postMatch?.[1]) {
          return postMatch[1];
        }

        return normalized;
      };

      const buildPostUrl = (postId: string): string => {
        const normalized = normalize(postId);
        if (!normalized) {
          return "";
        }

        if (/^urn:li:/i.test(normalized)) {
          return `https://www.linkedin.com/feed/update/${normalized}/`;
        }

        if (/^\d+$/.test(normalized)) {
          return `https://www.linkedin.com/feed/update/urn:li:activity:${normalized}/`;
        }

        return `https://www.linkedin.com/feed/update/${normalized}/`;
      };

      const pickText = (selectors: string[], root: ParentNode): string => {
        for (const selector of selectors) {
          const el = root.querySelector(selector);
          if (!el) {
            continue;
          }
          // Prefer aria-hidden span to avoid double-read from paired
          // visible / screen-reader spans that LinkedIn renders.
          const ariaHidden = el.querySelector("span[aria-hidden='true']");
          const text = normalize((ariaHidden ?? el).textContent);
          if (text) {
            return text;
          }
        }
        return "";
      };

      const pickHref = (selectors: string[], root: ParentNode): string => {
        for (const selector of selectors) {
          const href = (
            root.querySelector(selector) as HTMLAnchorElement | null
          )?.href;
          const absolute = toAbsoluteUrl(href);
          if (absolute) {
            return absolute;
          }
        }
        return "";
      };

      const pickMetricLabel = (value: string, kind: string): string => {
        const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const metricPattern = new RegExp(
          `^\\d[\\d,\\.]*\\s+${escapedKind}s?$`,
          "i",
        );
        const normalized = normalize(value);
        return metricPattern.test(normalized) ? normalized : "";
      };

      const extractSduiPostId = (componentKey: string): string => {
        const normalized = normalize(componentKey);
        if (!normalized) {
          return "";
        }

        const expandedMatch = /expanded(.+?)FeedType_/i.exec(normalized);
        if (expandedMatch?.[1]) {
          return normalize(expandedMatch[1]);
        }

        return extractPostId(normalized);
      };

      const extractSduiPosts = (): FeedPostSnapshot[] => {
        const feedRoot =
          globalThis.document.querySelector("[data-testid='mainFeed']") ??
          globalThis.document.querySelector("[data-component-type='LazyColumn']");
        if (!feedRoot) {
          return [];
        }

        const listItems = Array.from(feedRoot.querySelectorAll("[role='listitem']"));
        const postCards = listItems.filter((item) => {
          const componentKey = normalize(item.getAttribute("componentkey"));
          return /FeedType/i.test(componentKey);
        });

        const sduiResults: FeedPostSnapshot[] = [];
        for (const card of postCards) {
          const componentKey = normalize(card.getAttribute("componentkey"));
          const postId = extractSduiPostId(componentKey);
          if (!postId) {
            continue;
          }

          const profileLinks = Array.from(
            card.querySelectorAll("a[href*='/in/']"),
          ) as HTMLAnchorElement[];

          let authorName = "";
          let authorHeadline = "";
          let postedAt = "";
          let authorProfileUrl = "";

          for (const link of profileLinks) {
            if (!authorProfileUrl) {
              authorProfileUrl = toAbsoluteUrl(link.getAttribute("href"));
            }

            if (!authorName) {
              const potentialName = normalize(link.textContent);
              if (potentialName) {
                authorName = potentialName;
              }
            }

            const parent = link.parentElement;
            if (!parent) {
              continue;
            }

            const siblingDivs = Array.from(parent.querySelectorAll("div"));
            for (const div of siblingDivs) {
              const text = normalize(div.textContent);
              if (!text || text === authorName) {
                continue;
              }
              if (!postedAt && /(^|\s)\d+\s*[hdwmy]\s*[•.]?/i.test(text)) {
                postedAt = text;
                continue;
              }
              if (!postedAt && text.includes("•")) {
                postedAt = text;
                continue;
              }
              if (!authorHeadline) {
                authorHeadline = text;
              }
            }
          }

          if (!authorName) {
            authorName = pickText(["a[href*='/in/'] div", "a[href*='/in/']"], card);
          }

          if (!authorProfileUrl) {
            authorProfileUrl = pickHref(["a[href*='/in/']"], card);
          }

          if (!authorHeadline || !postedAt) {
            const allDivText = Array.from(card.querySelectorAll("div")).map((div) =>
              normalize(div.textContent),
            );
            for (const text of allDivText) {
              if (!text || text === authorName || text === authorHeadline) {
                continue;
              }
              if (!postedAt && /(^|\s)\d+\s*[hdwmy]\s*[•.]?/i.test(text)) {
                postedAt = text;
                continue;
              }
              if (!postedAt && text.includes("•")) {
                postedAt = text;
                continue;
              }
              if (!authorHeadline) {
                authorHeadline = text;
              }
            }
          }

          const text = normalize(
            card.querySelector("span[data-testid='expandable-text-box']")?.textContent,
          );

          let reactions = "";
          let comments = "";
          let reposts = "";

          const spanText = Array.from(card.querySelectorAll("span")).map((span) =>
            normalize(span.textContent),
          );
          for (const value of spanText) {
            if (!reactions) {
              reactions = pickMetricLabel(value, "reaction");
            }
            if (!comments) {
              comments = pickMetricLabel(value, "comment");
            }
            if (!reposts) {
              reposts = pickMetricLabel(value, "repost");
            }
          }

          sduiResults.push({
            post_id: postId,
            author_name: authorName,
            author_headline: authorHeadline,
            author_profile_url: authorProfileUrl,
            posted_at: postedAt,
            text,
            reactions_count: reactions,
            comments_count: comments,
            reposts_count: reposts,
            post_url: "",
          });

          if (sduiResults.length >= maxPosts) {
            break;
          }
        }

        return sduiResults;
      };

      const extractLegacyPosts = (): FeedPostSnapshot[] => {
        const cardCandidates = [
          ...Array.from(globalThis.document.querySelectorAll("[data-urn]")),
          ...Array.from(
            globalThis.document.querySelectorAll("div.feed-shared-update-v2"),
          ),
          ...Array.from(
            globalThis.document.querySelectorAll("div.occludable-update"),
          ),
          ...Array.from(
            globalThis.document.querySelectorAll("article.feed-shared-update-v2"),
          ),
        ];

        const uniqueCards: Element[] = [];
        const seenCards = new Set<Element>();
        for (const candidate of cardCandidates) {
          const root =
            candidate.closest(
              "div[data-urn], div.feed-shared-update-v2, div.occludable-update, article.feed-shared-update-v2, li",
            ) ?? candidate;
          if (seenCards.has(root)) {
            continue;
          }
          seenCards.add(root);
          uniqueCards.push(root);
          if (uniqueCards.length >= maxPosts * 4) {
            break;
          }
        }

        const results: FeedPostSnapshot[] = [];
        for (const card of uniqueCards) {
          const actorRoot =
            card.querySelector(
              ".update-components-actor, .feed-shared-actor, .feed-shared-actor__container",
            ) ?? card;

          const urn =
            normalize(card.getAttribute("data-urn")) ||
            normalize(card.querySelector("[data-urn]")?.getAttribute("data-urn"));

          const postUrl = pickHref(
            [
              "a[href*='/feed/update/']",
              "a[href*='/posts/']",
              "a[href*='activity-']",
            ],
            card,
          );
          const postId = extractPostId(urn || postUrl);
          if (!postId && !postUrl) {
            continue;
          }

          const postedAtText = pickText(
            [
              ".update-components-actor__sub-description span[aria-hidden='true']",
              ".update-components-actor__sub-description",
              ".feed-shared-actor__sub-description",
              ".feed-shared-actor__sub-description-link",
              ".update-components-actor__meta-link",
            ],
            actorRoot,
          );

          const timeElement = card.querySelector("time");
          const postedAt =
            normalize(timeElement?.textContent) ||
            normalize(timeElement?.getAttribute("datetime")) ||
            postedAtText;

          const text = pickText(
            [
              ".feed-shared-update-v2__description-wrapper .break-words",
              ".feed-shared-update-v2__description",
              ".update-components-text span[dir='ltr']",
              ".update-components-text",
              ".break-words",
            ],
            card,
          );

          const reactions = pickText(
            [
              ".social-details-social-counts__reactions-count",
              ".social-details-social-counts__social-proof-text",
            ],
            card,
          );
          const comments = pickText(
            [".social-details-social-counts__comments"],
            card,
          );
          const reposts = pickText(
            [".social-details-social-counts__reposts"],
            card,
          );

          const authorName = pickText(
            [
              ".update-components-actor__name",
              ".feed-shared-actor__name",
              ".update-components-actor__title span[aria-hidden='true']",
            ],
            actorRoot,
          );

          const authorHeadline = pickText(
            [
              ".update-components-actor__description",
              ".feed-shared-actor__description",
            ],
            actorRoot,
          );

          const authorProfileUrl = pickHref(["a[href*='/in/']"], actorRoot);

          results.push({
            post_id: postId,
            author_name: authorName,
            author_headline: authorHeadline,
            author_profile_url: authorProfileUrl,
            posted_at: postedAt,
            text,
            reactions_count: reactions,
            comments_count: comments,
            reposts_count: reposts,
            post_url: postUrl || buildPostUrl(postId),
          });

          if (results.length >= maxPosts) {
            break;
          }
        }

        return results;
      };

      const results: FeedPostSnapshot[] = [];
      const seenPostIds = new Set<string>();
      const appendUniquePosts = (posts: FeedPostSnapshot[]): void => {
        for (const post of posts) {
          const dedupeKey = normalize(post.post_id) || normalize(post.post_url);
          if (!dedupeKey || seenPostIds.has(dedupeKey)) {
            continue;
          }
          seenPostIds.add(dedupeKey);
          results.push(post);
          if (results.length >= maxPosts) {
            return;
          }
        }
      };

      appendUniquePosts(extractSduiPosts());
      if (results.length < maxPosts) {
        appendUniquePosts(extractLegacyPosts());
      }

      return results.slice(0, maxPosts);
    },
    Math.max(1, limit),
  );

  return snapshots.map(toFeedPost);
}
/* eslint-enable no-undef */

async function loadFeedPosts(
  page: Page,
  limit: number,
): Promise<LinkedInFeedPost[]> {
  let posts = await extractFeedPosts(page, limit);

  for (let i = 0; i < 6 && posts.length < limit; i++) {
    await scrollLinkedInPageToBottom(page);
    await page.waitForTimeout(800);
    posts = await extractFeedPosts(page, limit);
  }

  return posts.slice(0, Math.max(1, limit));
}

function findMatchingPost(
  posts: LinkedInFeedPost[],
  postUrl: string,
): LinkedInFeedPost | null {
  const requestedIdentity = extractPostIdentity(postUrl);
  if (!requestedIdentity) {
    return posts[0] ?? null;
  }

  for (const post of posts) {
    const postIdentity =
      extractPostIdentity(post.post_id) || extractPostIdentity(post.post_url);
    if (!postIdentity) {
      continue;
    }

    if (postIdentity === requestedIdentity) {
      return post;
    }
  }

  return posts[0] ?? null;
}

async function findVisibleLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return {
        locator,
        key: candidate.key,
      };
    } catch {
      // Try next selector candidate.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: page.url(),
      attempted_selectors: candidates.map(
        (candidate) => candidate.selectorHint,
      ),
    },
  );
}

async function findVisibleLocator(
  page: Page,
  candidates: SelectorCandidate[],
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    if (await isLocatorVisible(locator)) {
      return {
        locator,
        key: candidate.key,
      };
    }
  }

  return null;
}

async function findVisibleScopedLocatorOrThrow(
  root: Locator,
  candidates: ScopedSelectorCandidate[],
  selectorKey: string,
  currentUrl: string,
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return {
        locator,
        key: candidate.key,
      };
    } catch {
      // Try next selector candidate.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: currentUrl,
      attempted_selectors: candidates.map(
        (candidate) => candidate.selectorHint,
      ),
    },
  );
}

async function waitForNetworkIdleBestEffort(
  page: Page,
  timeoutMs: number = 8_000,
): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: timeoutMs })
    .catch(() => undefined);
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return condition();
}

async function isAnyLocatorVisible(
  locator: Locator,
  maxChecks = 3,
): Promise<boolean> {
  const count = await locator.count();
  const checks = Math.min(count, maxChecks);
  for (let index = 0; index < checks; index += 1) {
    if (await isLocatorVisible(locator.nth(index))) {
      return true;
    }
  }
  return false;
}

interface ReactionButtonState {
  reacted: boolean;
  reaction: LinkedInFeedReaction | null;
  ariaLabel: string;
  className: string;
  buttonText: string;
}

const REACTION_SELECTOR_KEYS: Record<
  LinkedInFeedReaction,
  LinkedInSelectorPhraseKey
> = {
  like: "like",
  celebrate: "celebrate",
  support: "support",
  love: "love",
  insightful: "insightful",
  funny: "funny",
};

function inferReactionFromText(
  value: string,
  selectorLocale: LinkedInSelectorLocale,
): LinkedInFeedReaction | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const reaction of LINKEDIN_FEED_REACTION_TYPES) {
    const ui = LINKEDIN_FEED_REACTION_MAP[reaction];
    if (
      valueContainsLinkedInSelectorPhrase(
        normalized,
        REACTION_SELECTOR_KEYS[reaction],
        selectorLocale,
      )
    ) {
      return reaction;
    }
    if (normalized.includes(ui.iconType.toLowerCase())) {
      return reaction;
    }
  }

  return null;
}

async function getReactionButtonState(
  reactButton: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<ReactionButtonState> {
  const ariaPressed = normalizeText(
    await reactButton.getAttribute("aria-pressed"),
  ).toLowerCase();
  const className = normalizeText(await reactButton.getAttribute("class"));
  const ariaLabel = normalizeText(await reactButton.getAttribute("aria-label"));
  const buttonText = normalizeText(
    await reactButton.innerText().catch(() => ""),
  );

  const reacted =
    ariaPressed === "true" ||
    className.toLowerCase().includes("react-button--active") ||
    /remove\s+your\s+reaction|unreact|reacted|undo/i.test(ariaLabel);

  const reactionFromLabel = inferReactionFromText(ariaLabel, selectorLocale);
  const reactionFromText = inferReactionFromText(buttonText, selectorLocale);

  return {
    reacted,
    reaction: reactionFromLabel ?? reactionFromText,
    ariaLabel,
    className,
    buttonText,
  };
}

async function isDesiredReactionActive(
  reactButton: Locator,
  desiredReaction: LinkedInFeedReaction,
  selectorLocale: LinkedInSelectorLocale,
): Promise<boolean> {
  const state = await getReactionButtonState(reactButton, selectorLocale);
  if (!state.reacted) {
    return false;
  }

  if (state.reaction === desiredReaction) {
    return true;
  }

  // LinkedIn sometimes reports active state without including the reaction name.
  return desiredReaction === "like" && state.reaction === null;
}

async function selectReactionFromMenu(
  page: Page,
  reactButton: Locator,
  reaction: LinkedInFeedReaction,
  selectorLocale: LinkedInSelectorLocale,
): Promise<string> {
  const reactionKey = REACTION_SELECTOR_KEYS[reaction];
  const reactionLabelRegex = buildLinkedInSelectorPhraseRegex(
    reactionKey,
    selectorLocale,
    { exact: true },
  );
  const reactionLabelRegexHint = formatLinkedInSelectorRegexHint(
    reactionKey,
    selectorLocale,
    { exact: true },
  );
  const reactionAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button.reactions-menu__reaction-index",
    reactionKey,
    selectorLocale,
  );
  const reactionFallbackAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    reactionKey,
    selectorLocale,
  );
  await reactButton.hover({ timeout: 5_000 });

  const menu = page.locator("span.reactions-menu--active").first();
  const menuVisible = await waitForCondition(
    async () => isLocatorVisible(menu),
    3_500,
  );
  if (!menuVisible) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not open LinkedIn reaction menu for the selected post.",
    );
  }

  const candidateButtons: SelectorCandidate[] = [
    {
      key: "menu-reaction-text",
      selectorHint: `button.reactions-menu__reaction-index hasText ${reactionLabelRegexHint}`,
      locatorFactory: () =>
        menu
          .locator("button.reactions-menu__reaction-index")
          .filter({ hasText: reactionLabelRegex }),
    },
    {
      key: "menu-reaction-aria",
      selectorHint: reactionAriaSelector,
      locatorFactory: () => menu.locator(reactionAriaSelector),
    },
    {
      key: "menu-reaction-fallback",
      selectorHint: reactionFallbackAriaSelector,
      locatorFactory: () => menu.locator(reactionFallbackAriaSelector),
    },
  ];

  const reactionButton = await findVisibleLocatorOrThrow(
    page,
    candidateButtons,
    "reaction_menu_button",
  );
  await reactionButton.locator.click({ timeout: 5_000 });
  return reactionButton.key;
}

function createReactionButtonCandidates(
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): SelectorCandidate[] {
  const likeOrReactRegex = buildLinkedInSelectorPhraseRegex(
    ["like", "react"],
    selectorLocale,
  );
  const likeOrReactRegexHint = formatLinkedInSelectorRegexHint(
    ["like", "react"],
    selectorLocale,
  );
  const likeReactAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    ["like", "react", "reaction"],
    selectorLocale,
  );

  return [
    {
      key: "post-social-action-like",
      selectorHint: "button.social-actions-button.react-button__trigger",
      locatorFactory: () =>
        postRoot.locator("button.social-actions-button.react-button__trigger"),
    },
    {
      key: "post-react-button",
      selectorHint: "button.react-button__trigger",
      locatorFactory: () => postRoot.locator("button.react-button__trigger"),
    },
    {
      key: "post-aria-like-button",
      selectorHint: likeReactAriaSelector,
      locatorFactory: () => postRoot.locator(likeReactAriaSelector),
    },
    {
      key: "post-role-button-like",
      selectorHint: `getByRole(button, ${likeOrReactRegexHint})`,
      locatorFactory: () =>
        postRoot.getByRole("button", {
          name: likeOrReactRegex,
        }),
    },
  ];
}

async function resolveReactionButton(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<{ locator: Locator; key: string }> {
  return findVisibleLocatorOrThrow(
    page,
    createReactionButtonCandidates(postRoot, selectorLocale),
    "reaction_button",
  );
}

function createPostActionButtonCandidates(input: {
  postRoot: Locator;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys:
    | LinkedInSelectorPhraseKey
    | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
  exact?: boolean;
}): SelectorCandidate[] {
  const labelRegex = buildLinkedInSelectorPhraseRegex(
    input.selectorKeys,
    input.selectorLocale,
    input.exact ? { exact: true } : {},
  );
  const labelRegexHint = formatLinkedInSelectorRegexHint(
    input.selectorKeys,
    input.selectorLocale,
    input.exact ? { exact: true } : {},
  );
  const ariaSelector = buildLinkedInAriaLabelContainsSelector(
    ["button", "[role='button']"],
    input.selectorKeys,
    input.selectorLocale,
  );

  return [
    {
      key: `${input.candidateKeyPrefix}-post-role`,
      selectorHint: `post.getByRole(button, ${labelRegexHint})`,
      locatorFactory: () =>
        input.postRoot.getByRole("button", {
          name: labelRegex,
        }),
    },
    {
      key: `${input.candidateKeyPrefix}-post-aria`,
      selectorHint: `post ${ariaSelector}`,
      locatorFactory: () => input.postRoot.locator(ariaSelector),
    },
    {
      key: `${input.candidateKeyPrefix}-post-text`,
      selectorHint: `post button,[role='button'] hasText ${labelRegexHint}`,
      locatorFactory: () =>
        input.postRoot
          .locator("button, [role='button']")
          .filter({ hasText: labelRegex }),
    },
  ];
}

function createPageMenuActionCandidates(input: {
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys:
    | LinkedInSelectorPhraseKey
    | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
  exact?: boolean;
}): SelectorCandidate[] {
  const selectorKeys = Array.isArray(input.selectorKeys)
    ? input.selectorKeys
    : [input.selectorKeys];
  const labelRegex = buildLinkedInSelectorPhraseRegex(
    selectorKeys,
    input.selectorLocale,
    input.exact ? { exact: true } : {},
  );
  const labelRegexHint = formatLinkedInSelectorRegexHint(
    selectorKeys,
    input.selectorLocale,
    input.exact ? { exact: true } : {},
  );
  const ariaSelector = buildLinkedInAriaLabelContainsSelector(
    ["[role='menuitem']", "button", "[role='button']", "li"],
    selectorKeys,
    input.selectorLocale,
  );
  const fixtureMenuActions = [
    ...new Set(
      selectorKeys.flatMap((selectorKey) => {
        switch (selectorKey) {
          case "repost":
          case "save":
          case "share":
          case "unsave":
            return [selectorKey];
          default:
            return [];
        }
      }),
    ),
  ];
  const fixtureMenuActionCandidates = fixtureMenuActions.map(
    (menuAction) =>
      ({
        key: `${input.candidateKeyPrefix}-fixture-action-${menuAction}`,
        selectorHint:
          `.feed-post-actions-menu [data-menu-action="${menuAction}"], ` +
          `.repost-actions-menu [data-menu-action="${menuAction}"]`,
        locatorFactory: (page: Page) =>
          page.locator(
            `.feed-post-actions-menu [data-menu-action="${menuAction}"], ` +
              `.repost-actions-menu [data-menu-action="${menuAction}"]`,
          ),
      }) satisfies SelectorCandidate,
  );

  return [
    {
      key: `${input.candidateKeyPrefix}-menuitem-role`,
      selectorHint: `page.getByRole(menuitem, ${labelRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("menuitem", {
          name: labelRegex,
        }),
    },
    ...fixtureMenuActionCandidates,
    {
      key: `${input.candidateKeyPrefix}-button-role`,
      selectorHint: `page.getByRole(button, ${labelRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("button", {
          name: labelRegex,
        }),
    },
    {
      key: `${input.candidateKeyPrefix}-dropdown-text`,
      selectorHint: `.artdeco-dropdown__content-inner * hasText ${labelRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator(
            ".artdeco-dropdown__content-inner [role='menuitem'], .artdeco-dropdown__content-inner [role='button'], .artdeco-dropdown__content-inner button, .artdeco-dropdown__content-inner li, [role='dialog'] [role='menuitem'], [role='dialog'] button, .feed-post-actions-menu [role='menuitem'], .feed-post-actions-menu button",
          )
          .filter({ hasText: labelRegex }),
    },
    {
      key: `${input.candidateKeyPrefix}-generic-text`,
      selectorHint: `[role='menuitem'], button, [role='button'], li hasText ${labelRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("[role='menuitem'], button, [role='button'], li")
          .filter({ hasText: labelRegex }),
    },
    {
      key: `${input.candidateKeyPrefix}-aria`,
      selectorHint: ariaSelector,
      locatorFactory: (page) => page.locator(ariaSelector),
    },
  ];
}

async function openPostMoreActionsMenu(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<{ locator: Locator; key: string }> {
  const moreButton = await findVisibleLocatorOrThrow(
    page,
    [
      {
        key: "post-more-menu-trigger",
        selectorHint: "button.feed-shared-control-menu__trigger",
        locatorFactory: () =>
          postRoot.locator("button.feed-shared-control-menu__trigger"),
      },
      ...createPostActionButtonCandidates({
        postRoot,
        selectorLocale,
        selectorKeys: ["more_actions", "more"],
        candidateKeyPrefix: "post-more",
      }),
    ],
    "feed_post_more_actions_button",
  );

  await moreButton.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
  return moreButton;
}

async function clickPostMoreMenuAction(input: {
  page: Page;
  postRoot: Locator;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys:
    | LinkedInSelectorPhraseKey
    | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
  selectorKey: string;
}): Promise<string> {
  const menuActionCandidates = createPageMenuActionCandidates({
    selectorLocale: input.selectorLocale,
    selectorKeys: input.selectorKeys,
    candidateKeyPrefix: input.candidateKeyPrefix,
  });
  const existingMenuAction = await findVisibleLocator(
    input.page,
    menuActionCandidates,
  );

  let triggerKey = "feed-menu-already-open";
  if (!existingMenuAction) {
    const moreButton = await openPostMoreActionsMenu(
      input.page,
      input.postRoot,
      input.selectorLocale,
    );
    triggerKey = moreButton.key;
  }

  const menuAction =
    existingMenuAction ??
    (await findVisibleLocatorOrThrow(
      input.page,
      menuActionCandidates,
      input.selectorKey,
    ));

  await menuAction.locator.click({ timeout: 5_000 });
  return `${triggerKey}:${menuAction.key}`;
}

async function readPostSavedState(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<boolean | null> {
  await openPostMoreActionsMenu(page, postRoot, selectorLocale);

  const unsaveAction = await findVisibleLocator(
    page,
    createPageMenuActionCandidates({
      selectorLocale,
      selectorKeys: "unsave",
      candidateKeyPrefix: "feed-unsave",
    }),
  );
  if (unsaveAction) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return true;
  }

  const saveAction = await findVisibleLocator(
    page,
    createPageMenuActionCandidates({
      selectorLocale,
      selectorKeys: "save",
      candidateKeyPrefix: "feed-save",
    }),
  );
  if (saveAction) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  return null;
}

function createRepostButtonCandidates(
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): SelectorCandidate[] {
  return [
    {
      key: "post-social-action-repost",
      selectorHint: "button.social-actions-button.repost-button",
      locatorFactory: () =>
        postRoot.locator("button.social-actions-button.repost-button"),
    },
    ...createPostActionButtonCandidates({
      postRoot,
      selectorLocale,
      selectorKeys: ["repost", "share"],
      candidateKeyPrefix: "feed-repost",
    }),
  ];
}

async function resolveRepostButton(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<{ locator: Locator; key: string }> {
  return findVisibleLocatorOrThrow(
    page,
    createRepostButtonCandidates(postRoot, selectorLocale),
    "feed_repost_button",
  );
}

async function getRepostButtonState(
  repostButton: Locator,
): Promise<PostRepostButtonState> {
  const ariaLabel = normalizeText(
    await repostButton.getAttribute("aria-label"),
  );
  const ariaPressed = normalizeText(
    await repostButton.getAttribute("aria-pressed"),
  ).toLowerCase();
  const buttonText = normalizeText(
    await repostButton.innerText().catch(() => ""),
  );
  const className = normalizeText(await repostButton.getAttribute("class"));

  const reposted =
    ariaPressed === "true" ||
    className.toLowerCase().includes("active") ||
    /reposted|undo\s+repost/i.test(`${ariaLabel} ${buttonText}`);

  return {
    reposted,
    ariaLabel,
    ariaPressed,
    buttonText,
    className,
  };
}

async function isPostReposted(repostButton: Locator): Promise<boolean> {
  const state = await getRepostButtonState(repostButton);
  return state.reposted;
}

async function selectRepostMenuAction(input: {
  page: Page;
  postRoot: Locator;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys:
    | LinkedInSelectorPhraseKey
    | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
  selectorKey: string;
}): Promise<string> {
  const repostButton = await resolveRepostButton(
    input.page,
    input.postRoot,
    input.selectorLocale,
  );
  await repostButton.locator.click({ timeout: 5_000 });
  await input.page.waitForTimeout(600);

  const menuAction = await findVisibleLocatorOrThrow(
    input.page,
    createPageMenuActionCandidates({
      selectorLocale: input.selectorLocale,
      selectorKeys: input.selectorKeys,
      candidateKeyPrefix: input.candidateKeyPrefix,
    }),
    input.selectorKey,
  );

  await menuAction.locator.click({ timeout: 5_000 });
  return `${repostButton.key}:${menuAction.key}`;
}

function createComposerRootCandidates(
  selectorLocale: LinkedInSelectorLocale,
): SelectorCandidate[] {
  const postExactRegex = buildLinkedInSelectorPhraseRegex(
    "post",
    selectorLocale,
    { exact: true },
  );
  const postExactRegexHint = formatLinkedInSelectorRegexHint(
    "post",
    selectorLocale,
    { exact: true },
  );
  const composerPromptRegex = buildLinkedInSelectorPhraseRegex(
    "what_do_you_want_to_talk_about",
    selectorLocale,
  );
  const composerPromptRegexHint = formatLinkedInSelectorRegexHint(
    "what_do_you_want_to_talk_about",
    selectorLocale,
  );

  return [
    {
      key: "dialog-with-textbox",
      selectorHint: "[role='dialog'] has [contenteditable='true'] or textarea",
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.locator("[contenteditable='true'], textarea") }),
    },
    {
      key: "dialog-with-post-button",
      selectorHint: `[role='dialog'] has getByRole(button, ${postExactRegexHint})`,
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByRole("button", { name: postExactRegex }) }),
    },
    {
      key: "dialog-with-prompt",
      selectorHint: `[role='dialog'] hasText ${composerPromptRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByText(composerPromptRegex) }),
    },
    {
      key: "share-box-open",
      selectorHint: ".share-box__open, .share-creation-state, .composer-dialog",
      locatorFactory: (page) =>
        page.locator(
          ".share-box__open, .share-creation-state, .composer-dialog",
        ),
    },
  ];
}

function createComposerInputCandidates(
  selectorLocale: LinkedInSelectorLocale,
): ScopedSelectorCandidate[] {
  const composerInputRegex = buildLinkedInSelectorPhraseRegex(
    ["what_do_you_want_to_talk_about", "start_post"],
    selectorLocale,
  );
  const composerInputRegexHint = formatLinkedInSelectorRegexHint(
    ["what_do_you_want_to_talk_about", "start_post"],
    selectorLocale,
  );

  return [
    {
      key: "role-textbox-prompt",
      selectorHint: `getByRole(textbox, ${composerInputRegexHint})`,
      locatorFactory: (root) =>
        root.getByRole("textbox", {
          name: composerInputRegex,
        }),
    },
    {
      key: "ql-editor",
      selectorHint: ".ql-editor[contenteditable='true']",
      locatorFactory: (root) =>
        root.locator(".ql-editor[contenteditable='true']"),
    },
    {
      key: "contenteditable-role-textbox",
      selectorHint: "[contenteditable='true'][role='textbox']",
      locatorFactory: (root) =>
        root.locator("[contenteditable='true'][role='textbox']"),
    },
    {
      key: "contenteditable",
      selectorHint: "[contenteditable='true']",
      locatorFactory: (root) => root.locator("[contenteditable='true']"),
    },
    {
      key: "textarea",
      selectorHint: "textarea",
      locatorFactory: (root) => root.locator("textarea"),
    },
  ];
}

function createPublishButtonCandidates(
  selectorLocale: LinkedInSelectorLocale,
): ScopedSelectorCandidate[] {
  const postExactRegex = buildLinkedInSelectorPhraseRegex(
    "post",
    selectorLocale,
    { exact: true },
  );
  const postExactRegexHint = formatLinkedInSelectorRegexHint(
    "post",
    selectorLocale,
    { exact: true },
  );

  return [
    {
      key: "role-button-post",
      selectorHint: `getByRole(button, ${postExactRegexHint})`,
      locatorFactory: (root) =>
        root.getByRole("button", { name: postExactRegex }),
    },
    {
      key: "share-actions-primary",
      selectorHint: ".share-actions__primary-action",
      locatorFactory: (root) => root.locator(".share-actions__primary-action"),
    },
    {
      key: "submit-button",
      selectorHint: "button[type='submit']",
      locatorFactory: (root) => root.locator("button[type='submit']"),
    },
  ];
}

async function setComposerText(
  page: Page,
  composerRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
  text: string,
): Promise<string> {
  const composerInput = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createComposerInputCandidates(selectorLocale),
    "feed_share_composer_input",
    page.url(),
  );

  await composerInput.locator.click({ timeout: 5_000 });

  try {
    await composerInput.locator.fill(text, { timeout: 5_000 });
  } catch {
    await composerInput.locator.press("Control+A").catch(() => undefined);
    await composerInput.locator.press("Meta+A").catch(() => undefined);
    await composerInput.locator.press("Backspace").catch(() => undefined);
    await composerInput.locator.type(text);
  }

  return composerInput.key;
}

async function findVisiblePostBySnippet(
  page: Page,
  snippet: string,
): Promise<Locator | null> {
  const postCandidates = [
    page
      .locator("article, .feed-shared-update-v2, .occludable-update")
      .filter({ hasText: snippet }),
    page
      .getByText(snippet)
      .locator(
        "xpath=ancestor-or-self::*[self::article or contains(@class, 'feed-shared-update-v2') or contains(@class, 'occludable-update')]",
      ),
  ];

  for (const candidate of postCandidates) {
    if (await isAnyLocatorVisible(candidate)) {
      return candidate.first();
    }
  }

  return null;
}

async function extractPublishedPostUrl(
  page: Page,
  postRoot: Locator | null,
): Promise<string | null> {
  if (!postRoot) {
    return null;
  }

  const href = await postRoot
    .locator(
      "a[href*='/feed/update/'], a[href*='/posts/'], a[href*='/activity/']",
    )
    .first()
    .getAttribute("href")
    .catch(() => null);

  if (!href) {
    return null;
  }

  try {
    return new URL(href, page.url()).toString();
  } catch {
    return href;
  }
}

async function verifySharedPost(
  page: Page,
  text: string,
): Promise<{ verified: true; postUrl: string | null }> {
  const snippet = createVerificationSnippet(text);
  if (!snippet) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Cannot verify a shared post with empty text content.",
    );
  }

  const locatePost = async (): Promise<Locator | null> => {
    await scrollLinkedInPageToTop(page);
    await waitForFeedSurface(page);
    return findVisiblePostBySnippet(page, snippet);
  };

  let postRoot = await locatePost();
  if (!postRoot) {
    await page.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
    await waitForNetworkIdleBestEffort(page);
    postRoot = await locatePost();
  }

  if (!postRoot) {
    const verified = await waitForCondition(async () => {
      const located = await locatePost();
      postRoot = located;
      return located !== null;
    }, 12_000);

    if (!verified) {
      throw new LinkedInBuddyError(
        "UNKNOWN",
        "Shared LinkedIn post could not be verified on the feed.",
        {
          current_url: page.url(),
          verification_snippet: snippet,
        },
      );
    }
  }

  return {
    verified: true,
    postUrl: await extractPublishedPostUrl(page, postRoot),
  };
}

async function openShareComposerFromPost(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<{ composerRoot: Locator; triggerKey: string; rootKey: string }> {
  const repostButton = await resolveRepostButton(
    page,
    postRoot,
    selectorLocale,
  );
  await repostButton.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);

  const directComposer = await findVisibleLocator(
    page,
    createComposerRootCandidates(selectorLocale),
  );
  if (directComposer) {
    return {
      composerRoot: directComposer.locator,
      triggerKey: repostButton.key,
      rootKey: directComposer.key,
    };
  }

  const shareAction = await findVisibleLocatorOrThrow(
    page,
    createPageMenuActionCandidates({
      selectorLocale,
      selectorKeys: "share",
      candidateKeyPrefix: "feed-share",
    }),
    "feed_share_menu_action",
  );

  await shareAction.locator.click({ timeout: 5_000 });

  const composerRoot = await findVisibleLocatorOrThrow(
    page,
    createComposerRootCandidates(selectorLocale),
    "feed_share_composer_root",
  );

  return {
    composerRoot: composerRoot.locator,
    triggerKey: `${repostButton.key}:${shareAction.key}`,
    rootKey: composerRoot.key,
  };
}

async function findTargetPostLocator(
  page: Page,
  postUrl: string,
): Promise<TargetPostLocator> {
  const postIdentity = extractPostIdentity(postUrl);
  const activityId = extractActivityId(postIdentity || postUrl);
  const candidates: SelectorCandidate[] = [];

  if (postIdentity) {
    const escapedIdentity = escapeCssAttributeValue(postIdentity);
    candidates.push(
      {
        key: "post-root-data-urn-exact",
        selectorHint: `[data-urn="${postIdentity}"]`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`[data-urn="${escapedIdentity}"]`),
      },
      {
        key: "post-root-data-urn-contains",
        selectorHint: `[data-urn*="${postIdentity}"]`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`[data-urn*="${escapedIdentity}"]`),
      },
      {
        key: "post-root-permalink-identity",
        selectorHint: `article:has(a[href*="${postIdentity}"])`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`article:has(a[href*="${escapedIdentity}"])`),
      },
    );
  }

  if (activityId) {
    const escapedActivityId = escapeCssAttributeValue(activityId);
    candidates.push(
      {
        key: "post-root-data-urn-activity",
        selectorHint: `[data-urn*="${activityId}"]`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`[data-urn*="${escapedActivityId}"]`),
      },
      {
        key: "post-root-permalink-activity",
        selectorHint: `article:has(a[href*="${activityId}"])`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`article:has(a[href*="${escapedActivityId}"])`),
      },
    );
  }

  candidates.push(
    {
      key: "post-root-first-data-urn",
      selectorHint: "[data-urn]",
      locatorFactory: (targetPage) => targetPage.locator("[data-urn]"),
    },
    {
      key: "post-root-first-article",
      selectorHint: "article",
      locatorFactory: (targetPage) => targetPage.locator("article"),
    },
  );

  const resolved = await findVisibleLocatorOrThrow(
    page,
    candidates,
    "post_root",
  );
  return {
    locator: resolved.locator,
    key: resolved.key,
    postIdentity,
    activityId,
  };
}

async function expandCommentsForPost(
  page: Page,
  postRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<string | null> {
  const commentRegex = buildLinkedInSelectorPhraseRegex(
    "comment",
    selectorLocale,
  );
  const commentRegexHint = formatLinkedInSelectorRegexHint(
    "comment",
    selectorLocale,
  );
  const commentAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    "comment",
    selectorLocale,
  );

  const candidates: SelectorCandidate[] = [
    {
      key: "post-social-action-comment",
      selectorHint: "button.social-actions-button.comment-button",
      locatorFactory: () =>
        postRoot.locator("button.social-actions-button.comment-button"),
    },
    {
      key: "post-aria-comment-button",
      selectorHint: commentAriaSelector,
      locatorFactory: () => postRoot.locator(commentAriaSelector),
    },
    {
      key: "post-role-button-comment",
      selectorHint: `getByRole(button, ${commentRegexHint})`,
      locatorFactory: () =>
        postRoot.getByRole("button", {
          name: commentRegex,
        }),
    },
  ];

  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    if (await isLocatorVisible(locator)) {
      await locator.click({ timeout: 5_000 });
      await page.waitForTimeout(800);
      return candidate.key;
    }
  }

  return null;
}

async function isCommentVisibleInPost(
  postRoot: Locator,
  text: string,
): Promise<boolean> {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const candidates = [
    postRoot
      .locator(
        ".comments-comment-item__main-content, .comments-comment-item-content-body, .comments-post-meta__main-content",
      )
      .filter({ hasText: normalized }),
    postRoot.locator(".comments-comment-item").filter({ hasText: normalized }),
  ];

  for (const candidate of candidates) {
    if (await isAnyLocatorVisible(candidate)) {
      return true;
    }
  }

  return false;
}

export class LikePostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );
    const requestedReaction =
      typeof action.payload.reaction === "string"
        ? action.payload.reaction
        : undefined;
    const reaction = normalizeLinkedInFeedReaction(requestedReaction, "like");

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context: BrowserContext) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: LIKE_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
            requested_reaction: reaction,
          },
          errorDetails: {
            post_url: postUrl,
            requested_reaction: reaction,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn like_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: LIKE_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(LIKE_POST_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  reaction,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            const likeOrReactRegex = buildLinkedInSelectorPhraseRegex(
              ["like", "react"],
              runtime.selectorLocale,
            );
            const likeOrReactRegexHint = formatLinkedInSelectorRegexHint(
              ["like", "react"],
              runtime.selectorLocale,
            );
            const likeReactAriaSelector =
              buildLinkedInAriaLabelContainsSelector(
                "button",
                ["like", "react", "reaction"],
                runtime.selectorLocale,
              );

            const resolveReactionButton = async (postRoot: Locator) =>
              findVisibleLocatorOrThrow(
                page,
                [
                  {
                    key: "post-social-action-like",
                    selectorHint:
                      "button.social-actions-button.react-button__trigger",
                    locatorFactory: () =>
                      postRoot.locator(
                        "button.social-actions-button.react-button__trigger",
                      ),
                  },
                  {
                    key: "post-react-button",
                    selectorHint: "button.react-button__trigger",
                    locatorFactory: () =>
                      postRoot.locator("button.react-button__trigger"),
                  },
                  {
                    key: "post-aria-like-button",
                    selectorHint: likeReactAriaSelector,
                    locatorFactory: () =>
                      postRoot.locator(likeReactAriaSelector),
                  },
                  {
                    key: "post-role-button-like",
                    selectorHint: `getByRole(button, ${likeOrReactRegexHint})`,
                    locatorFactory: () =>
                      postRoot.getByRole("button", {
                        name: likeOrReactRegex,
                      }),
                  },
                ],
                "reaction_button",
              );

            let reactButton = await resolveReactionButton(targetPost.locator);
            const wasAlreadyReacted = await isDesiredReactionActive(
              reactButton.locator,
              reaction,
              runtime.selectorLocale,
            );
            let reactionSelectorKey: string | null = null;

            let verifiedReaction = wasAlreadyReacted;
            if (!wasAlreadyReacted) {
              if (reaction === "like") {
                await reactButton.locator.click({ timeout: 5_000 });
                verifiedReaction = await waitForCondition(
                  async () =>
                    isDesiredReactionActive(
                      reactButton.locator,
                      reaction,
                      runtime.selectorLocale,
                    ),
                  6_000,
                );

                if (!verifiedReaction) {
                  try {
                    reactionSelectorKey = await selectReactionFromMenu(
                      page,
                      reactButton.locator,
                      reaction,
                      runtime.selectorLocale,
                    );
                    verifiedReaction = await waitForCondition(
                      async () =>
                        isDesiredReactionActive(
                          reactButton.locator,
                          reaction,
                          runtime.selectorLocale,
                        ),
                      6_000,
                    );
                  } catch {
                    // Ignore and fall through to reload verification.
                  }
                }
              } else {
                reactionSelectorKey = await selectReactionFromMenu(
                  page,
                  reactButton.locator,
                  reaction,
                  runtime.selectorLocale,
                );
                verifiedReaction = await waitForCondition(
                  async () =>
                    isDesiredReactionActive(
                      reactButton.locator,
                      reaction,
                      runtime.selectorLocale,
                    ),
                  8_000,
                );
              }
            }

            if (!verifiedReaction) {
              await page.reload({ waitUntil: "domcontentloaded" });
              await waitForPostSurface(page);
              targetPost = await findTargetPostLocator(page, postUrl);
              reactButton = await resolveReactionButton(targetPost.locator);
              verifiedReaction = await isDesiredReactionActive(
                reactButton.locator,
                reaction,
                runtime.selectorLocale,
              );
            }

            if (!verifiedReaction) {
              const currentReactionState = await getReactionButtonState(
                reactButton.locator,
                runtime.selectorLocale,
              );
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Reaction action could not be verified on the target post.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  requested_reaction: reaction,
                  current_reaction: currentReactionState.reaction,
                  current_reacted: currentReactionState.reacted,
                  current_aria_label: currentReactionState.ariaLabel,
                  post_identity: targetPost.postIdentity,
                  activity_id: targetPost.activityId,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-feed-like-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: LIKE_POST_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              reaction,
              selector_key: reactButton.key,
              reaction_selector_key: reactionSelectorKey ?? undefined,
              post_selector_key: targetPost.key,
            });

            return {
              ok: true,
              result: {
                reacted: true,
                reaction,
                already_reacted: wasAlreadyReacted,
                liked: reaction === "like",
                already_liked: reaction === "like" ? wasAlreadyReacted : false,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export class CommentOnPostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );
    const text = getRequiredStringField(
      action.payload,
      "text",
      action.id,
      "payload",
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: COMMENT_ON_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
            comment_text: text,
          },
          errorDetails: {
            post_url: postUrl,
            comment_text: text,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn comment_on_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: COMMENT_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(
                  COMMENT_ON_POST_ACTION_TYPE,
                ),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            const commentRegex = buildLinkedInSelectorPhraseRegex(
              "comment",
              runtime.selectorLocale,
            );
            const commentRegexHint = formatLinkedInSelectorRegexHint(
              "comment",
              runtime.selectorLocale,
            );
            const commentAriaSelector = buildLinkedInAriaLabelContainsSelector(
              "button",
              "comment",
              runtime.selectorLocale,
            );
            const commentComposerRegex = buildLinkedInSelectorPhraseRegex(
              ["add_comment", "comment"],
              runtime.selectorLocale,
            );
            const commentComposerRegexHint = formatLinkedInSelectorRegexHint(
              ["add_comment", "comment"],
              runtime.selectorLocale,
            );
            const postRegex = buildLinkedInSelectorPhraseRegex(
              "post",
              runtime.selectorLocale,
              { exact: true },
            );
            const postRegexHint = formatLinkedInSelectorRegexHint(
              "post",
              runtime.selectorLocale,
              { exact: true },
            );
            const commentSubmitAriaSelector =
              buildLinkedInAriaLabelContainsSelector(
                "button",
                ["post_comment", "post"],
                runtime.selectorLocale,
              );

            const commentTrigger = await findVisibleLocatorOrThrow(
              page,
              [
                {
                  key: "post-social-action-comment",
                  selectorHint: "button.social-actions-button.comment-button",
                  locatorFactory: () =>
                    targetPost.locator.locator(
                      "button.social-actions-button.comment-button",
                    ),
                },
                {
                  key: "post-aria-comment-button",
                  selectorHint: commentAriaSelector,
                  locatorFactory: () =>
                    targetPost.locator.locator(commentAriaSelector),
                },
                {
                  key: "post-role-button-comment",
                  selectorHint: `getByRole(button, ${commentRegexHint})`,
                  locatorFactory: () =>
                    targetPost.locator.getByRole("button", {
                      name: commentRegex,
                    }),
                },
                {
                  key: "comment-button-fallback",
                  selectorHint: "button.comments-comment-social-bar__button",
                  locatorFactory: () =>
                    page.locator("button.comments-comment-social-bar__button"),
                },
              ],
              "comment_trigger",
            );

            await commentTrigger.locator.click({ timeout: 5_000 });

            const commentInput = await findVisibleLocatorOrThrow(
              page,
              [
                {
                  key: "post-comment-box-editor",
                  selectorHint:
                    "div.comments-comment-box__editor[contenteditable='true']",
                  locatorFactory: () =>
                    targetPost.locator.locator(
                      "div.comments-comment-box__editor[contenteditable='true']",
                    ),
                },
                {
                  key: "post-contenteditable-textbox",
                  selectorHint: "div[role='textbox'][contenteditable='true']",
                  locatorFactory: () =>
                    targetPost.locator.locator(
                      "div[role='textbox'][contenteditable='true']",
                    ),
                },
                {
                  key: "post-role-textbox-comment",
                  selectorHint: `getByRole(textbox, ${commentComposerRegexHint})`,
                  locatorFactory: () =>
                    targetPost.locator.getByRole("textbox", {
                      name: commentComposerRegex,
                    }),
                },
                {
                  key: "comment-box-editor-fallback",
                  selectorHint:
                    "div.comments-comment-box__editor[contenteditable='true']",
                  locatorFactory: (targetPage) =>
                    targetPage.locator(
                      "div.comments-comment-box__editor[contenteditable='true']",
                    ),
                },
                {
                  key: "comment-textarea-fallback",
                  selectorHint: "textarea",
                  locatorFactory: (targetPage) =>
                    targetPage.locator("textarea"),
                },
              ],
              "comment_input",
            );

            await commentInput.locator.click({ timeout: 3_000 });
            await commentInput.locator.fill(text, { timeout: 5_000 });

            const composerRoot = commentInput.locator.locator(
              "xpath=ancestor::*[contains(@class,'comments-comment-box')][1]",
            );

            const submitButton = await findVisibleLocatorOrThrow(
              page,
              [
                {
                  key: "comment-submit-button",
                  selectorHint:
                    "button[class*='comments-comment-box__submit-button']",
                  locatorFactory: () =>
                    composerRoot.locator(
                      "button[class*='comments-comment-box__submit-button']",
                    ),
                },
                {
                  key: "comment-submit-role-post",
                  selectorHint: `getByRole(button, ${postRegexHint})`,
                  locatorFactory: () =>
                    composerRoot.getByRole("button", {
                      name: postRegex,
                    }),
                },
                {
                  key: "comment-submit-role-comment",
                  selectorHint: `getByRole(button, ${commentRegexHint})`,
                  locatorFactory: () =>
                    composerRoot.getByRole("button", {
                      name: commentRegex,
                    }),
                },
                {
                  key: "comment-submit-aria",
                  selectorHint: commentSubmitAriaSelector,
                  locatorFactory: () =>
                    composerRoot.locator(commentSubmitAriaSelector),
                },
                {
                  key: "comment-submit-post-root-fallback",
                  selectorHint:
                    "button[class*='comments-comment-box__submit-button']",
                  locatorFactory: () =>
                    targetPost.locator.locator(
                      "button[class*='comments-comment-box__submit-button']",
                    ),
                },
              ],
              "comment_submit",
            );

            const submitEnabled = await waitForCondition(async () => {
              try {
                return await submitButton.locator.isEnabled();
              } catch {
                return false;
              }
            }, 4_000);

            if (!submitEnabled) {
              throw new LinkedInBuddyError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Comment submit button was not enabled after entering comment text.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  selector_key: submitButton.key,
                },
              );
            }

            await submitButton.locator.click({ timeout: 5_000 });
            await page.waitForTimeout(1_200);

            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);
            targetPost = await findTargetPostLocator(page, postUrl);
            const reopenCommentKey = await expandCommentsForPost(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );

            const commentVerified = await waitForCondition(
              async () => isCommentVisibleInPost(targetPost.locator, text),
              12_000,
            );

            if (!commentVerified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Comment action could not be verified on the target post.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  post_identity: targetPost.postIdentity,
                  activity_id: targetPost.activityId,
                  reopen_comment_selector_key: reopenCommentKey ?? null,
                  text,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-feed-comment-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: COMMENT_ON_POST_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              selector_key: submitButton.key,
              post_selector_key: targetPost.key,
            });

            return {
              ok: true,
              result: {
                commented: true,
                post_url: postUrl,
                text,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export class RepostPostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: REPOST_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
          },
          errorDetails: {
            post_url: postUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn repost_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: REPOST_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(REPOST_POST_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            let repostButton = await resolveRepostButton(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );
            const alreadyReposted = await isPostReposted(repostButton.locator);

            let selectorKey = repostButton.key;
            if (!alreadyReposted) {
              selectorKey = await selectRepostMenuAction({
                page,
                postRoot: targetPost.locator,
                selectorLocale: runtime.selectorLocale,
                selectorKeys: "repost",
                candidateKeyPrefix: "feed-repost-menu",
                selectorKey: "feed_repost_menu_action",
              });

              let verified = await waitForCondition(async () => {
                try {
                  repostButton = await resolveRepostButton(
                    page,
                    targetPost.locator,
                    runtime.selectorLocale,
                  );
                  return await isPostReposted(repostButton.locator);
                } catch {
                  return false;
                }
              }, 8_000);

              if (!verified) {
                await page.reload({ waitUntil: "domcontentloaded" });
                await waitForPostSurface(page);
                targetPost = await findTargetPostLocator(page, postUrl);
                repostButton = await resolveRepostButton(
                  page,
                  targetPost.locator,
                  runtime.selectorLocale,
                );
                verified = await isPostReposted(repostButton.locator);
              }

              if (!verified) {
                throw new LinkedInBuddyError(
                  "UNKNOWN",
                  "Repost action could not be verified on the target post.",
                  {
                    action_id: action.id,
                    profile_name: profileName,
                    post_url: postUrl,
                    post_identity: targetPost.postIdentity,
                    activity_id: targetPost.activityId,
                    selector_key: selectorKey,
                  },
                );
              }
            }

            const screenshotPath = `linkedin/screenshot-feed-repost-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: REPOST_POST_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              selector_key: selectorKey,
              post_selector_key: targetPost.key,
            });

            return {
              ok: true,
              result: {
                reposted: true,
                already_reposted: alreadyReposted,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export class SharePostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );
    const text = validateLinkedInPostText(
      getRequiredStringField(action.payload, "text", action.id, "payload"),
    ).normalizedText;

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: SHARE_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
            text,
          },
          errorDetails: {
            post_url: postUrl,
            text,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn share_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: SHARE_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(SHARE_POST_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            const targetPost = await findTargetPostLocator(page, postUrl);
            const composer = await openShareComposerFromPost(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );
            const inputKey = await setComposerText(
              page,
              composer.composerRoot,
              runtime.selectorLocale,
              text,
            );

            const publishButton = await findVisibleScopedLocatorOrThrow(
              composer.composerRoot,
              createPublishButtonCandidates(runtime.selectorLocale),
              "feed_share_publish_button",
              page.url(),
            );

            const publishEnabled = await waitForCondition(async () => {
              try {
                return await publishButton.locator.isEnabled();
              } catch {
                return false;
              }
            }, 5_000);

            if (!publishEnabled) {
              throw new LinkedInBuddyError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Share publish button was not enabled after entering share text.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  selector_key: publishButton.key,
                },
              );
            }

            const beforeScreenshotPath = `linkedin/screenshot-feed-share-before-${Date.now()}.png`;
            await captureScreenshotArtifact(
              runtime,
              page,
              beforeScreenshotPath,
              {
                action: SHARE_POST_ACTION_TYPE,
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                trigger_selector_key: composer.triggerKey,
                composer_selector_key: composer.rootKey,
                input_selector_key: inputKey,
                publish_selector_key: publishButton.key,
              },
            );

            await publishButton.locator.click({ timeout: 5_000 });
            await waitForCondition(
              async () => !(await isAnyLocatorVisible(composer.composerRoot)),
              10_000,
            );
            await waitForNetworkIdleBestEffort(page);

            const verification = await verifySharedPost(page, text);

            const afterScreenshotPath = `linkedin/screenshot-feed-share-after-${Date.now()}.png`;
            await captureScreenshotArtifact(
              runtime,
              page,
              afterScreenshotPath,
              {
                action: SHARE_POST_ACTION_TYPE,
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                shared_post_url: verification.postUrl,
              },
            );

            return {
              ok: true,
              result: {
                shared: true,
                post_url: postUrl,
                shared_post_url: verification.postUrl,
                text,
                verification_snippet: createVerificationSnippet(text),
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [beforeScreenshotPath, afterScreenshotPath],
            };
          },
        });
      },
    );
  }
}

export class SavePostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: SAVE_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
          },
          errorDetails: {
            post_url: postUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn save_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: SAVE_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(SAVE_POST_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            const initialSavedState = await readPostSavedState(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );

            let selectorKey = "feed-save-existing-state";
            if (initialSavedState !== true) {
              selectorKey = await clickPostMoreMenuAction({
                page,
                postRoot: targetPost.locator,
                selectorLocale: runtime.selectorLocale,
                selectorKeys: "save",
                candidateKeyPrefix: "feed-save",
                selectorKey: "feed_save_menu_action",
              });
            }

            let verified = initialSavedState === true;
            if (!verified) {
              verified = await waitForCondition(async () => {
                try {
                  return (
                    (await readPostSavedState(
                      page,
                      targetPost.locator,
                      runtime.selectorLocale,
                    )) === true
                  );
                } catch {
                  return false;
                }
              }, 6_000);
            }

            if (!verified) {
              await page.reload({ waitUntil: "domcontentloaded" });
              await waitForPostSurface(page);
              targetPost = await findTargetPostLocator(page, postUrl);
              verified =
                (await readPostSavedState(
                  page,
                  targetPost.locator,
                  runtime.selectorLocale,
                )) === true;
            }

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Save post action could not be verified on the target post.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  selector_key: selectorKey,
                  post_identity: targetPost.postIdentity,
                  activity_id: targetPost.activityId,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-feed-save-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: SAVE_POST_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              selector_key: selectorKey,
              post_selector_key: targetPost.key,
            });

            return {
              ok: true,
              result: {
                saved: true,
                already_saved: initialSavedState === true,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export class UnsavePostActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: UNSAVE_POST_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
          },
          errorDetails: {
            post_url: postUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn unsave_post action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: UNSAVE_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(UNSAVE_POST_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            const initialSavedState = await readPostSavedState(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );

            let selectorKey = "feed-unsave-existing-state";
            if (initialSavedState !== false) {
              selectorKey = await clickPostMoreMenuAction({
                page,
                postRoot: targetPost.locator,
                selectorLocale: runtime.selectorLocale,
                selectorKeys: "unsave",
                candidateKeyPrefix: "feed-unsave",
                selectorKey: "feed_unsave_menu_action",
              });
            }

            let verified = initialSavedState === false;
            if (!verified) {
              verified = await waitForCondition(async () => {
                try {
                  return (
                    (await readPostSavedState(
                      page,
                      targetPost.locator,
                      runtime.selectorLocale,
                    )) === false
                  );
                } catch {
                  return false;
                }
              }, 6_000);
            }

            if (!verified) {
              await page.reload({ waitUntil: "domcontentloaded" });
              await waitForPostSurface(page);
              targetPost = await findTargetPostLocator(page, postUrl);
              verified =
                (await readPostSavedState(
                  page,
                  targetPost.locator,
                  runtime.selectorLocale,
                )) === false;
            }

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Unsave post action could not be verified on the target post.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                  selector_key: selectorKey,
                  post_identity: targetPost.postIdentity,
                  activity_id: targetPost.activityId,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-feed-unsave-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: UNSAVE_POST_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              selector_key: selectorKey,
              post_selector_key: targetPost.key,
            });

            return {
              ok: true,
              result: {
                saved: false,
                already_unsaved: initialSavedState === false,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export class RemoveReactionActionExecutor implements ActionExecutor<LinkedInFeedExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target",
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: REMOVE_REACTION_ACTION_TYPE,
          profileName,
          targetUrl: postUrl,
          metadata: {
            post_url: postUrl,
          },
          errorDetails: {
            post_url: postUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn remove_reaction action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: REMOVE_REACTION_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(
                  REMOVE_REACTION_ACTION_TYPE,
                ),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  post_url: postUrl,
                },
              },
            );

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);

            let targetPost = await findTargetPostLocator(page, postUrl);
            let reactButton = await resolveReactionButton(
              page,
              targetPost.locator,
              runtime.selectorLocale,
            );
            const reactionState = await getReactionButtonState(
              reactButton.locator,
              runtime.selectorLocale,
            );
            const previousReaction = reactionState.reaction;
            const alreadyCleared = !reactionState.reacted;

            if (!alreadyCleared) {
              await reactButton.locator.click({ timeout: 5_000 });

              let verified = await waitForCondition(async () => {
                try {
                  const currentState = await getReactionButtonState(
                    reactButton.locator,
                    runtime.selectorLocale,
                  );
                  return !currentState.reacted;
                } catch {
                  return false;
                }
              }, 6_000);

              if (!verified) {
                await page.reload({ waitUntil: "domcontentloaded" });
                await waitForPostSurface(page);
                targetPost = await findTargetPostLocator(page, postUrl);
                reactButton = await resolveReactionButton(
                  page,
                  targetPost.locator,
                  runtime.selectorLocale,
                );
                verified = !(
                  await getReactionButtonState(
                    reactButton.locator,
                    runtime.selectorLocale,
                  )
                ).reacted;
              }

              if (!verified) {
                throw new LinkedInBuddyError(
                  "UNKNOWN",
                  "Remove reaction action could not be verified on the target post.",
                  {
                    action_id: action.id,
                    profile_name: profileName,
                    post_url: postUrl,
                    post_identity: targetPost.postIdentity,
                    activity_id: targetPost.activityId,
                    previous_reaction: previousReaction,
                  },
                );
              }
            }

            const screenshotPath = `linkedin/screenshot-feed-remove-reaction-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: REMOVE_REACTION_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              post_url: postUrl,
              post_selector_key: targetPost.key,
              previous_reaction: previousReaction,
            });

            return {
              ok: true,
              result: {
                reacted: false,
                already_cleared: alreadyCleared,
                previous_reaction: previousReaction,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState),
              },
              artifacts: [screenshotPath],
            };
          },
        });
      },
    );
  }
}

export function createFeedActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInFeedExecutorRuntime>
> {
  return {
    [LIKE_POST_ACTION_TYPE]: new LikePostActionExecutor(),
    [COMMENT_ON_POST_ACTION_TYPE]: new CommentOnPostActionExecutor(),
    [REPOST_POST_ACTION_TYPE]: new RepostPostActionExecutor(),
    [SHARE_POST_ACTION_TYPE]: new SharePostActionExecutor(),
    [SAVE_POST_ACTION_TYPE]: new SavePostActionExecutor(),
    [UNSAVE_POST_ACTION_TYPE]: new UnsavePostActionExecutor(),
    [REMOVE_REACTION_ACTION_TYPE]: new RemoveReactionActionExecutor(),
  };
}

function readFeedLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.floor(value));
}

export class LinkedInFeedService {
  constructor(private readonly runtime: LinkedInFeedRuntime) {}

  async viewFeed(input: ViewFeedInput = {}): Promise<LinkedInFeedPost[]> {
    const profileName = input.profileName ?? "default";
    const limit = readFeedLimit(input.limit);
    const mine = input.mine === true;
    const targetUrl = mine ? LINKEDIN_MY_ACTIVITY_URL : LINKEDIN_FEED_URL;

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          await waitForFeedSurface(page);
          const posts = await loadFeedPosts(page, limit);
          return posts.slice(0, limit);
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        mine
          ? "Failed to view your LinkedIn activity."
          : "Failed to view LinkedIn feed.",
      );
    }
  }

  async viewPost(input: ViewPostInput): Promise<LinkedInFeedPost> {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);

          const posts = await extractFeedPosts(page, 8);
          const post = findMatchingPost(posts, postUrl);
          if (!post) {
            throw new LinkedInBuddyError(
              "TARGET_NOT_FOUND",
              "Could not extract post details from the requested LinkedIn post URL.",
              {
                post_url: postUrl,
                current_url: page.url(),
              },
            );
          }

          return post;
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn post.",
      );
    }
  }

  prepareLikePost(input: LikePostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const reaction = normalizeLinkedInFeedReaction(input.reaction, "like");
    const rateLimitState: RateLimiterState = this.runtime.rateLimiter.peek(
      LIKE_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `React (${LINKEDIN_FEED_REACTION_MAP[reaction].label}) to LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "react",
        reaction,
      },
      supported_reactions: LINKEDIN_FEED_REACTION_TYPES,
      reaction_map: LINKEDIN_FEED_REACTION_MAP,
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: LIKE_POST_ACTION_TYPE,
      target,
      payload: {
        reaction,
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareCommentOnPost(input: CommentOnPostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const text = normalizeText(input.text);

    if (!text) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Comment text must not be empty.",
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      COMMENT_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Comment on LinkedIn post ${postUrl}`,
      target,
      outbound: {
        text,
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: COMMENT_ON_POST_ACTION_TYPE,
      target,
      payload: {
        text,
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareRepostPost(input: RepostPostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const rateLimitState = this.runtime.rateLimiter.peek(
      REPOST_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Repost LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "repost",
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REPOST_POST_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareSharePost(input: SharePostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const text = validateLinkedInPostText(input.text).normalizedText;
    const rateLimitState = this.runtime.rateLimiter.peek(
      SHARE_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Share LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "share",
        text,
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: SHARE_POST_ACTION_TYPE,
      target,
      payload: {
        text,
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareSavePost(input: SavePostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const rateLimitState = this.runtime.rateLimiter.peek(
      SAVE_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Save LinkedIn post ${postUrl} for later`,
      target,
      outbound: {
        action: "save",
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: SAVE_POST_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareUnsavePost(input: UnsavePostInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const rateLimitState = this.runtime.rateLimiter.peek(
      UNSAVE_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Unsave LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "unsave",
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UNSAVE_POST_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareRemoveReaction(input: RemoveReactionInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const rateLimitState = this.runtime.rateLimiter.peek(
      REMOVE_REACTION_RATE_LIMIT_CONFIG,
    );

    const target = {
      profile_name: profileName,
      post_url: postUrl,
    };

    const preview = {
      summary: `Remove your reaction from LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "remove_reaction",
      },
      rate_limit: formatRateLimitState(rateLimitState),
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_REACTION_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }
}
