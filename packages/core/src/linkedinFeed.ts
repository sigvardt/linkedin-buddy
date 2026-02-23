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

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForPostSurface(page);

          const likeButton = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "role-button-like",
                selectorHint: "getByRole(button, /like/i)",
                locatorFactory: (targetPage) =>
                  targetPage.getByRole("button", {
                    name: /\blike\b/i
                  })
              },
              {
                key: "aria-like-button",
                selectorHint: "button[aria-label*='Like']",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button[aria-label*='Like']")
              },
              {
                key: "social-action-like",
                selectorHint: "button.react-button__trigger",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button.react-button__trigger")
              }
            ],
            "like_button"
          );

          const wasAlreadyLiked =
            normalizeText(await likeButton.locator.getAttribute("aria-pressed")) ===
            "true";

          if (!wasAlreadyLiked) {
            await likeButton.locator.click({ timeout: 5_000 });
            await page.waitForTimeout(1_500);
          }

          const screenshotPath = `linkedin/screenshot-feed-like-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, screenshotPath, {
            action: LIKE_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            selector_key: likeButton.key
          });

          return {
            ok: true,
            result: {
              liked: true,
              already_liked: wasAlreadyLiked,
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

          const commentTrigger = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "role-button-comment",
                selectorHint: "getByRole(button, /comment/i)",
                locatorFactory: (targetPage) =>
                  targetPage.getByRole("button", {
                    name: /comment/i
                  })
              },
              {
                key: "aria-comment-button",
                selectorHint: "button[aria-label*='Comment']",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button[aria-label*='Comment']")
              },
              {
                key: "comment-button-fallback",
                selectorHint: "button.comments-comment-social-bar__button",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button.comments-comment-social-bar__button")
              }
            ],
            "comment_trigger"
          );

          await commentTrigger.locator.click({ timeout: 5_000 });

          const commentInput = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "role-textbox-comment",
                selectorHint: "getByRole(textbox, /comment/i)",
                locatorFactory: (targetPage) =>
                  targetPage.getByRole("textbox", {
                    name: /add a comment|comment/i
                  })
              },
              {
                key: "comment-box-editor",
                selectorHint: "div.comments-comment-box__editor[contenteditable='true']",
                locatorFactory: (targetPage) =>
                  targetPage.locator(
                    "div.comments-comment-box__editor[contenteditable='true']"
                  )
              },
              {
                key: "contenteditable-textbox",
                selectorHint: "div[role='textbox'][contenteditable='true']",
                locatorFactory: (targetPage) =>
                  targetPage.locator(
                    "div[role='textbox'][contenteditable='true']"
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

          const submitButton = await findVisibleLocatorOrThrow(
            page,
            [
              {
                key: "role-button-post",
                selectorHint: "getByRole(button, /post|comment/i)",
                locatorFactory: (targetPage) =>
                  targetPage.getByRole("button", {
                    name: /post|comment/i
                  })
              },
              {
                key: "comment-submit-button",
                selectorHint: "button.comments-comment-box__submit-button",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button.comments-comment-box__submit-button")
              },
              {
                key: "comment-submit-fallback",
                selectorHint: "button[aria-label*='Post comment']",
                locatorFactory: (targetPage) =>
                  targetPage.locator("button[aria-label*='Post comment']")
              }
            ],
            "comment_submit"
          );

          await submitButton.locator.click({ timeout: 5_000 });
          await page.waitForTimeout(1_500);

          const screenshotPath = `linkedin/screenshot-feed-comment-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, screenshotPath, {
            action: COMMENT_ON_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            selector_key: submitButton.key
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
    const rateLimitState = this.runtime.rateLimiter.peek(LIKE_RATE_LIMIT_CONFIG);

    const target = {
      profile_name: profileName,
      post_url: postUrl
    };

    const preview = {
      summary: `Like LinkedIn post ${postUrl}`,
      target,
      outbound: {
        action: "like"
      },
      rate_limit: formatRateLimitState(rateLimitState)
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: LIKE_POST_ACTION_TYPE,
      target,
      payload: {},
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
