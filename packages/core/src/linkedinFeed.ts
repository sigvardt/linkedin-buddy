import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ProfileManager } from "./profileManager.js";
import type { RateLimiter, RateLimiterState } from "./rateLimiter.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
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

export interface LinkedInFeedExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
}

export interface LinkedInFeedRuntime extends LinkedInFeedExecutorRuntime {
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInFeedExecutorRuntime>, "prepare">;
}

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
export const LIKE_POST_ACTION_TYPE = "feed.like_post";
export const COMMENT_ON_POST_ACTION_TYPE = "feed.comment_on_post";

export const LINKEDIN_FEED_REACTION_TYPES = [
  "like",
  "celebrate",
  "support",
  "love",
  "insightful",
  "funny"
] as const;

export type LinkedInFeedReaction = (typeof LINKEDIN_FEED_REACTION_TYPES)[number];

const LIKE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.like_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30
} as const;

const COMMENT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.feed.comment_on_post",
  windowSizeMs: 60 * 60 * 1000,
  limit: 15
} as const;

interface ReactionUiConfig {
  label: string;
  menuAriaLabel: string;
  iconType: string;
}

export const LINKEDIN_FEED_REACTION_MAP: Record<
  LinkedInFeedReaction,
  ReactionUiConfig
> = {
  like: {
    label: "Like",
    menuAriaLabel: "React Like",
    iconType: "LIKE"
  },
  celebrate: {
    label: "Celebrate",
    menuAriaLabel: "React Celebrate",
    iconType: "PRAISE"
  },
  support: {
    label: "Support",
    menuAriaLabel: "React Support",
    iconType: "APPRECIATION"
  },
  love: {
    label: "Love",
    menuAriaLabel: "React Love",
    iconType: "EMPATHY"
  },
  insightful: {
    label: "Insightful",
    menuAriaLabel: "React Insightful",
    iconType: "INTEREST"
  },
  funny: {
    label: "Funny",
    menuAriaLabel: "React Funny",
    iconType: "ENTERTAINMENT"
  }
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
  entertainment: "funny"
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

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeReactionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeLinkedInFeedReaction(
  value: string | undefined,
  fallback: LinkedInFeedReaction = "like"
): LinkedInFeedReaction {
  if (!value || normalizeText(value).length === 0) {
    return fallback;
  }

  const key = normalizeReactionKey(value);
  const mapped = LINKEDIN_FEED_REACTION_ALIAS_MAP[key];
  if (mapped) {
    return mapped;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `reaction must be one of: ${LINKEDIN_FEED_REACTION_TYPES.join(", ")}.`,
    {
      provided_reaction: value,
      supported_reactions: LINKEDIN_FEED_REACTION_TYPES
    }
  );
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolvePostUrl(postUrl: string): string {
  const trimmedPostUrl = normalizeText(postUrl);
  if (!trimmedPostUrl) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "postUrl is required."
    );
  }

  if (isAbsoluteUrl(trimmedPostUrl)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedPostUrl);
    } catch (error) {
      throw asLinkedInAssistantError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Post URL must be a valid URL."
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

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
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

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
  const postUrl = normalizeText(snapshot.post_url) || toAbsoluteLinkedInPostUrl(postId);

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
    post_url: postUrl
  };
}

function formatRateLimitState(
  state: RateLimiterState
): Record<string, number | boolean | string> {
  return {
    counter_key: state.counterKey,
    window_start_ms: state.windowStartMs,
    window_size_ms: state.windowSizeMs,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    allowed: state.allowed
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
  location: "target" | "payload"
): string {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key
    }
  );
}

async function captureScreenshotArtifact(
  runtime: LinkedInFeedExecutorRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForFeedSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-urn]",
    ".feed-shared-update-v2",
    ".occludable-update",
    "main"
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn feed content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForPostSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-urn]",
    ".feed-shared-update-v2",
    "article",
    "main"
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn post content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractFeedPosts(page: Page, limit: number): Promise<LinkedInFeedPost[]> {
  const snapshots = await page.evaluate((maxPosts: number) => {
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
        const text = normalize(root.querySelector(selector)?.textContent);
        if (text) {
          return text;
        }
      }
      return "";
    };

    const pickHref = (selectors: string[], root: ParentNode): string => {
      for (const selector of selectors) {
        const href = (root.querySelector(selector) as HTMLAnchorElement | null)?.href;
        const absolute = toAbsoluteUrl(href);
        if (absolute) {
          return absolute;
        }
      }
      return "";
    };

    const cardCandidates = [
      ...Array.from(globalThis.document.querySelectorAll("[data-urn]")),
      ...Array.from(globalThis.document.querySelectorAll("div.feed-shared-update-v2")),
      ...Array.from(globalThis.document.querySelectorAll("div.occludable-update")),
      ...Array.from(globalThis.document.querySelectorAll("article.feed-shared-update-v2"))
    ];

    const uniqueCards: Element[] = [];
    const seenCards = new Set<Element>();
    for (const candidate of cardCandidates) {
      const root =
        candidate.closest(
          "div[data-urn], div.feed-shared-update-v2, div.occludable-update, article.feed-shared-update-v2, li"
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
          ".update-components-actor, .feed-shared-actor, .feed-shared-actor__container"
        ) ?? card;

      const urn =
        normalize(card.getAttribute("data-urn")) ||
        normalize(card.querySelector("[data-urn]")?.getAttribute("data-urn"));

      const postUrl = pickHref(
        [
          "a[href*='/feed/update/']",
          "a[href*='/posts/']",
          "a[href*='activity-']"
        ],
        card
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
          ".update-components-actor__meta-link"
        ],
        actorRoot
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
          ".break-words"
        ],
        card
      );

      const reactions = pickText(
        [
          ".social-details-social-counts__reactions-count",
          ".social-details-social-counts__social-proof-text"
        ],
        card
      );
      const comments = pickText([".social-details-social-counts__comments"], card);
      const reposts = pickText([".social-details-social-counts__reposts"], card);

      const authorName = pickText(
        [
          ".update-components-actor__name",
          ".feed-shared-actor__name",
          ".update-components-actor__title span[aria-hidden='true']"
        ],
        actorRoot
      );

      const authorHeadline = pickText(
        [
          ".update-components-actor__description",
          ".feed-shared-actor__description"
        ],
        actorRoot
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
        post_url: postUrl || buildPostUrl(postId)
      });

      if (results.length >= maxPosts) {
        break;
      }
    }

    return results;
  }, Math.max(1, limit));

  return snapshots.map(toFeedPost);
}
/* eslint-enable no-undef */

async function loadFeedPosts(page: Page, limit: number): Promise<LinkedInFeedPost[]> {
  let posts = await extractFeedPosts(page, limit);

  for (let i = 0; i < 6 && posts.length < limit; i++) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    posts = await extractFeedPosts(page, limit);
  }

  return posts.slice(0, Math.max(1, limit));
}

function findMatchingPost(posts: LinkedInFeedPost[], postUrl: string): LinkedInFeedPost | null {
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
  selectorKey: string
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return {
        locator,
        key: candidate.key
      };
    } catch {
      // Try next selector candidate.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: page.url(),
      attempted_selectors: candidates.map((candidate) => candidate.selectorHint)
    }
  );
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
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

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function isAnyLocatorVisible(locator: Locator, maxChecks = 3): Promise<boolean> {
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

function inferReactionFromText(value: string): LinkedInFeedReaction | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const reaction of LINKEDIN_FEED_REACTION_TYPES) {
    const ui = LINKEDIN_FEED_REACTION_MAP[reaction];
    if (normalized.includes(ui.label.toLowerCase())) {
      return reaction;
    }
    if (normalized.includes(ui.iconType.toLowerCase())) {
      return reaction;
    }
  }

  return null;
}

async function getReactionButtonState(reactButton: Locator): Promise<ReactionButtonState> {
  const ariaPressed = normalizeText(await reactButton.getAttribute("aria-pressed")).toLowerCase();
  const className = normalizeText(await reactButton.getAttribute("class"));
  const ariaLabel = normalizeText(await reactButton.getAttribute("aria-label"));
  const buttonText = normalizeText(await reactButton.innerText().catch(() => ""));

  const reacted =
    ariaPressed === "true" ||
    className.toLowerCase().includes("react-button--active") ||
    /remove\s+your\s+reaction|unreact|reacted|undo/i.test(ariaLabel);

  const reactionFromLabel = inferReactionFromText(ariaLabel);
  const reactionFromText = inferReactionFromText(buttonText);

  return {
    reacted,
    reaction: reactionFromLabel ?? reactionFromText,
    ariaLabel,
    className,
    buttonText
  };
}

async function isDesiredReactionActive(
  reactButton: Locator,
  desiredReaction: LinkedInFeedReaction
): Promise<boolean> {
  const state = await getReactionButtonState(reactButton);
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
  reaction: LinkedInFeedReaction
): Promise<string> {
  const reactionUi = LINKEDIN_FEED_REACTION_MAP[reaction];
  await reactButton.hover({ timeout: 5_000 });

  const menu = page.locator("span.reactions-menu--active").first();
  const menuVisible = await waitForCondition(async () => isLocatorVisible(menu), 3_500);
  if (!menuVisible) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not open LinkedIn reaction menu for the selected post."
    );
  }

  const candidateButtons: SelectorCandidate[] = [
    {
      key: "menu-reaction-aria",
      selectorHint: `button.reactions-menu__reaction-index[aria-label='${reactionUi.menuAriaLabel}']`,
      locatorFactory: () =>
        menu.locator(
          `button.reactions-menu__reaction-index[aria-label="${reactionUi.menuAriaLabel}"]`
        )
    },
    {
      key: "menu-reaction-text",
      selectorHint: `button.reactions-menu__reaction-index hasText=${reactionUi.label}`,
      locatorFactory: () =>
        menu
          .locator("button.reactions-menu__reaction-index")
          .filter({ hasText: new RegExp(`^${reactionUi.label}$`, "i") })
    },
    {
      key: "menu-reaction-fallback",
      selectorHint: `button[aria-label*='${reactionUi.label}']`,
      locatorFactory: () =>
        menu.locator(`button[aria-label*="${reactionUi.label}"]`)
    }
  ];

  const reactionButton = await findVisibleLocatorOrThrow(page, candidateButtons, "reaction_menu_button");
  await reactionButton.locator.click({ timeout: 5_000 });
  return reactionButton.key;
}

async function findTargetPostLocator(page: Page, postUrl: string): Promise<TargetPostLocator> {
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
          targetPage.locator(`[data-urn="${escapedIdentity}"]`)
      },
      {
        key: "post-root-data-urn-contains",
        selectorHint: `[data-urn*="${postIdentity}"]`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`[data-urn*="${escapedIdentity}"]`)
      },
      {
        key: "post-root-permalink-identity",
        selectorHint: `article:has(a[href*="${postIdentity}"])`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`article:has(a[href*="${escapedIdentity}"])`)
      }
    );
  }

  if (activityId) {
    const escapedActivityId = escapeCssAttributeValue(activityId);
    candidates.push(
      {
        key: "post-root-data-urn-activity",
        selectorHint: `[data-urn*="${activityId}"]`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`[data-urn*="${escapedActivityId}"]`)
      },
      {
        key: "post-root-permalink-activity",
        selectorHint: `article:has(a[href*="${activityId}"])`,
        locatorFactory: (targetPage) =>
          targetPage.locator(`article:has(a[href*="${escapedActivityId}"])`)
      }
    );
  }

  candidates.push(
    {
      key: "post-root-first-data-urn",
      selectorHint: "[data-urn]",
      locatorFactory: (targetPage) => targetPage.locator("[data-urn]")
    },
    {
      key: "post-root-first-article",
      selectorHint: "article",
      locatorFactory: (targetPage) => targetPage.locator("article")
    }
  );

  const resolved = await findVisibleLocatorOrThrow(page, candidates, "post_root");
  return {
    locator: resolved.locator,
    key: resolved.key,
    postIdentity,
    activityId
  };
}

async function expandCommentsForPost(page: Page, postRoot: Locator): Promise<string | null> {
  const candidates: SelectorCandidate[] = [
    {
      key: "post-social-action-comment",
      selectorHint: "button.social-actions-button.comment-button",
      locatorFactory: () => postRoot.locator("button.social-actions-button.comment-button")
    },
    {
      key: "post-aria-comment-button",
      selectorHint: "button[aria-label*='Comment']",
      locatorFactory: () => postRoot.locator("button[aria-label*='Comment']")
    },
    {
      key: "post-role-button-comment",
      selectorHint: "getByRole(button, /comment/i)",
      locatorFactory: () =>
        postRoot.getByRole("button", {
          name: /comment/i
        })
    }
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

async function isCommentVisibleInPost(postRoot: Locator, text: string): Promise<boolean> {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const candidates = [
    postRoot
      .locator(
        ".comments-comment-item__main-content, .comments-comment-item-content-body, .comments-post-meta__main-content"
      )
      .filter({ hasText: normalized }),
    postRoot.locator(".comments-comment-item").filter({ hasText: normalized })
  ];

  for (const candidate of candidates) {
    if (await isAnyLocatorVisible(candidate)) {
      return true;
    }
  }

  return false;
}

export class LikePostActionExecutor
  implements ActionExecutor<LinkedInFeedExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target"
    );
    const requestedReaction =
      typeof action.payload.reaction === "string"
        ? action.payload.reaction
        : undefined;
    const reaction = normalizeLinkedInFeedReaction(requestedReaction, "like");

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        try {
          const rateLimitState = runtime.rateLimiter.consume(
            LIKE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn like_post confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                reaction,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);

          let targetPost = await findTargetPostLocator(page, postUrl);

          const resolveReactionButton = async (postRoot: Locator) =>
            findVisibleLocatorOrThrow(
              page,
              [
                {
                  key: "post-social-action-like",
                  selectorHint: "button.social-actions-button.react-button__trigger",
                  locatorFactory: () =>
                    postRoot.locator(
                      "button.social-actions-button.react-button__trigger"
                    )
                },
                {
                  key: "post-react-button",
                  selectorHint: "button.react-button__trigger",
                  locatorFactory: () => postRoot.locator("button.react-button__trigger")
                },
                {
                  key: "post-aria-like-button",
                  selectorHint:
                    "button[aria-label*='Like'], button[aria-label*='React'], button[aria-label*='reaction']",
                  locatorFactory: () =>
                    postRoot.locator(
                      "button[aria-label*='Like'], button[aria-label*='React'], button[aria-label*='reaction']"
                    )
                },
                {
                  key: "post-role-button-like",
                  selectorHint: "getByRole(button, /like|react/i)",
                  locatorFactory: () =>
                    postRoot.getByRole("button", {
                      name: /\blike\b|\breact\b/i
                    })
                }
              ],
              "reaction_button"
            );

          let reactButton = await resolveReactionButton(targetPost.locator);
          const wasAlreadyReacted = await isDesiredReactionActive(
            reactButton.locator,
            reaction
          );
          let reactionSelectorKey: string | null = null;

          let verifiedReaction = wasAlreadyReacted;
          if (!wasAlreadyReacted) {
            if (reaction === "like") {
              await reactButton.locator.click({ timeout: 5_000 });
              verifiedReaction = await waitForCondition(
                async () => isDesiredReactionActive(reactButton.locator, reaction),
                6_000
              );

              if (!verifiedReaction) {
                try {
                  reactionSelectorKey = await selectReactionFromMenu(
                    page,
                    reactButton.locator,
                    reaction
                  );
                  verifiedReaction = await waitForCondition(
                    async () => isDesiredReactionActive(reactButton.locator, reaction),
                    6_000
                  );
                } catch {
                  // Ignore and fall through to reload verification.
                }
              }
            } else {
              reactionSelectorKey = await selectReactionFromMenu(
                page,
                reactButton.locator,
                reaction
              );
              verifiedReaction = await waitForCondition(
                async () => isDesiredReactionActive(reactButton.locator, reaction),
                8_000
              );
            }
          }

          if (!verifiedReaction) {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForPostSurface(page);
            targetPost = await findTargetPostLocator(page, postUrl);
            reactButton = await resolveReactionButton(targetPost.locator);
            verifiedReaction = await isDesiredReactionActive(reactButton.locator, reaction);
          }

          if (!verifiedReaction) {
            const currentReactionState = await getReactionButtonState(reactButton.locator);
            throw new LinkedInAssistantError(
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
                activity_id: targetPost.activityId
              }
            );
          }

          const screenshotPath = `linkedin/screenshot-feed-like-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, screenshotPath, {
            action: LIKE_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            reaction,
            selector_key: reactButton.key,
            reaction_selector_key: reactionSelectorKey ?? undefined,
            post_selector_key: targetPost.key
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
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: [screenshotPath]
          };
        } catch (error) {
          throw asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn like_post action."
          );
        }
      }
    );
  }
}

export class CommentOnPostActionExecutor
  implements ActionExecutor<LinkedInFeedExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInFeedExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = getRequiredStringField(
      action.target,
      "post_url",
      action.id,
      "target"
    );
    const text = getRequiredStringField(action.payload, "text", action.id, "payload");

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);

        try {
          const rateLimitState = runtime.rateLimiter.consume(
            COMMENT_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn comment_on_post confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);

          let targetPost = await findTargetPostLocator(page, postUrl);

          const commentTrigger = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "post-social-action-comment",
                selectorHint: "button.social-actions-button.comment-button",
                locatorFactory: () =>
                  targetPost.locator.locator("button.social-actions-button.comment-button")
              },
              {
                key: "post-aria-comment-button",
                selectorHint: "button[aria-label*='Comment']",
                locatorFactory: () =>
                  targetPost.locator.locator("button[aria-label*='Comment']")
              },
              {
                key: "post-role-button-comment",
                selectorHint: "getByRole(button, /comment/i)",
                locatorFactory: () =>
                  targetPost.locator.getByRole("button", {
                    name: /comment/i
                  })
              },
              {
                key: "comment-button-fallback",
                selectorHint: "button.comments-comment-social-bar__button",
                locatorFactory: () =>
                  page.locator("button.comments-comment-social-bar__button")
              }
            ],
            "comment_trigger"
          );

          await commentTrigger.locator.click({ timeout: 5_000 });

          const commentInput = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "post-comment-box-editor",
                selectorHint: "div.comments-comment-box__editor[contenteditable='true']",
                locatorFactory: () =>
                  targetPost.locator.locator(
                    "div.comments-comment-box__editor[contenteditable='true']"
                  )
              },
              {
                key: "post-contenteditable-textbox",
                selectorHint: "div[role='textbox'][contenteditable='true']",
                locatorFactory: () =>
                  targetPost.locator.locator("div[role='textbox'][contenteditable='true']")
              },
              {
                key: "post-role-textbox-comment",
                selectorHint: "getByRole(textbox, /add a comment|comment/i)",
                locatorFactory: () =>
                  targetPost.locator.getByRole("textbox", {
                    name: /add a comment|comment/i
                  })
              },
              {
                key: "comment-box-editor-fallback",
                selectorHint: "div.comments-comment-box__editor[contenteditable='true']",
                locatorFactory: (targetPage) =>
                  targetPage.locator(
                    "div.comments-comment-box__editor[contenteditable='true']"
                  )
              },
              {
                key: "comment-textarea-fallback",
                selectorHint: "textarea",
                locatorFactory: (targetPage) => targetPage.locator("textarea")
              }
            ],
            "comment_input"
          );

          await commentInput.locator.click({ timeout: 3_000 });
          await commentInput.locator.fill(text, { timeout: 5_000 });

          const composerRoot = commentInput.locator.locator(
            "xpath=ancestor::*[contains(@class,'comments-comment-box')][1]"
          );

          const submitButton = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "comment-submit-button",
                selectorHint: "button[class*='comments-comment-box__submit-button']",
                locatorFactory: () =>
                  composerRoot.locator(
                    "button[class*='comments-comment-box__submit-button']"
                  )
              },
              {
                key: "comment-submit-role-post",
                selectorHint: "getByRole(button, /^post$/i)",
                locatorFactory: () =>
                  composerRoot.getByRole("button", {
                    name: /^post$/i
                  })
              },
              {
                key: "comment-submit-role-comment",
                selectorHint: "getByRole(button, /^comment$/i)",
                locatorFactory: () =>
                  composerRoot.getByRole("button", {
                    name: /^comment$/i
                  })
              },
              {
                key: "comment-submit-aria",
                selectorHint: "button[aria-label*='Post comment'], button[aria-label*='Post']",
                locatorFactory: () =>
                  composerRoot.locator(
                    "button[aria-label*='Post comment'], button[aria-label*='Post']"
                  )
              },
              {
                key: "comment-submit-post-root-fallback",
                selectorHint: "button[class*='comments-comment-box__submit-button']",
                locatorFactory: () =>
                  targetPost.locator.locator(
                    "button[class*='comments-comment-box__submit-button']"
                  )
              }
            ],
            "comment_submit"
          );

          const submitEnabled = await waitForCondition(async () => {
            try {
              return await submitButton.locator.isEnabled();
            } catch {
              return false;
            }
          }, 4_000);

          if (!submitEnabled) {
            throw new LinkedInAssistantError(
              "UI_CHANGED_SELECTOR_FAILED",
              "Comment submit button was not enabled after entering comment text.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                selector_key: submitButton.key
              }
            );
          }

          await submitButton.locator.click({ timeout: 5_000 });
          await page.waitForTimeout(1_200);

          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);
          targetPost = await findTargetPostLocator(page, postUrl);
          const reopenCommentKey = await expandCommentsForPost(page, targetPost.locator);

          const commentVerified = await waitForCondition(
            async () => isCommentVisibleInPost(targetPost.locator, text),
            12_000
          );

          if (!commentVerified) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "Comment action could not be verified on the target post.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                post_identity: targetPost.postIdentity,
                activity_id: targetPost.activityId,
                reopen_comment_selector_key: reopenCommentKey ?? null,
                text
              }
            );
          }

          const screenshotPath = `linkedin/screenshot-feed-comment-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, screenshotPath, {
            action: COMMENT_ON_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            selector_key: submitButton.key,
            post_selector_key: targetPost.key
          });

          return {
            ok: true,
            result: {
              commented: true,
              post_url: postUrl,
              text,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: [screenshotPath]
          };
        } catch (error) {
          throw asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn comment_on_post action."
          );
        }
      }
    );
  }
}

export function createFeedActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInFeedExecutorRuntime>
> {
  return {
    [LIKE_POST_ACTION_TYPE]: new LikePostActionExecutor(),
    [COMMENT_ON_POST_ACTION_TYPE]: new CommentOnPostActionExecutor()
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

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
          await waitForFeedSurface(page);
          const posts = await loadFeedPosts(page, limit);
          return posts.slice(0, limit);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn feed."
      );
    }
  }

  async viewPost(input: ViewPostInput): Promise<LinkedInFeedPost> {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);

          const posts = await extractFeedPosts(page, 8);
          const post = findMatchingPost(posts, postUrl);
          if (!post) {
            throw new LinkedInAssistantError(
              "TARGET_NOT_FOUND",
              "Could not extract post details from the requested LinkedIn post URL.",
              {
                post_url: postUrl,
                current_url: page.url()
              }
            );
          }

          return post;
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn post."
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
    const rateLimitState = this.runtime.rateLimiter.peek(LIKE_RATE_LIMIT_CONFIG);

    const target = {
      profile_name: profileName,
      post_url: postUrl
    };

    const preview = {
      summary: `React (${LINKEDIN_FEED_REACTION_MAP[reaction].label}) to LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "react",
        reaction
      },
      supported_reactions: LINKEDIN_FEED_REACTION_TYPES,
      reaction_map: LINKEDIN_FEED_REACTION_MAP,
      rate_limit: formatRateLimitState(rateLimitState)
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: LIKE_POST_ACTION_TYPE,
      target,
      payload: {
        reaction
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
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
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Comment text must not be empty."
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(COMMENT_RATE_LIMIT_CONFIG);

    const target = {
      profile_name: profileName,
      post_url: postUrl
    };

    const preview = {
      summary: `Comment on LinkedIn post ${postUrl}`,
      target,
      outbound: {
        text
      },
      rate_limit: formatRateLimitState(rateLimitState)
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: COMMENT_ON_POST_ACTION_TYPE,
      target,
      payload: {
        text
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
