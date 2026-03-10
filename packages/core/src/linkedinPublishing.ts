import {
  errors as playwrightErrors,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import type { RateLimiter, RateLimiterState } from "./rateLimiter.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  ActionExecutorRegistry,
  PreparedActionResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_ARTICLE_NEW_URL = "https://www.linkedin.com/article/new/";
const LINKEDIN_NEWSLETTER_NEW_URL =
  "https://www.linkedin.com/article/newsletter/new/";
const LINKEDIN_NEWSLETTER_MANAGER_URL =
  "https://www.linkedin.com/mynetwork/network-manager/newsletters/";
const DRAFT_SAVE_TIMEOUT_MS = 20_000;
const ARTICLE_PUBLISH_TIMEOUT_MS = 30_000;
const KEYBOARD_ENTRY_DELAY_MS = 35;
const NEXT_BUTTON_PATTERN = /^Next\b/i;
const PUBLISH_BUTTON_PATTERNS = [/^Publish\b/i, /^Post\b/i] as const;

export const CREATE_ARTICLE_ACTION_TYPE = "article.create";
export const PUBLISH_ARTICLE_ACTION_TYPE = "article.publish";
export const CREATE_NEWSLETTER_ACTION_TYPE = "newsletter.create";
export const PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE = "newsletter.publish_issue";

export const LINKEDIN_NEWSLETTER_CADENCE_TYPES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly"
] as const;

export type LinkedInNewsletterCadence =
  (typeof LINKEDIN_NEWSLETTER_CADENCE_TYPES)[number];

interface NewsletterCadenceUiConfig {
  keyboardShortcut: string;
  label: string;
}

export const LINKEDIN_NEWSLETTER_CADENCE_MAP: Record<
  LinkedInNewsletterCadence,
  NewsletterCadenceUiConfig
> = {
  daily: {
    keyboardShortcut: "d",
    label: "Daily"
  },
  weekly: {
    keyboardShortcut: "w",
    label: "Weekly"
  },
  biweekly: {
    keyboardShortcut: "b",
    label: "Biweekly"
  },
  monthly: {
    keyboardShortcut: "m",
    label: "Monthly"
  }
};

const LINKEDIN_NEWSLETTER_CADENCE_ALIAS_MAP: Record<
  string,
  LinkedInNewsletterCadence
> = {
  daily: "daily",
  day: "daily",
  weekly: "weekly",
  week: "weekly",
  biweekly: "biweekly",
  "bi-weekly": "biweekly",
  twice_month: "biweekly",
  twice_monthly: "biweekly",
  fortnightly: "biweekly",
  monthly: "monthly",
  month: "monthly"
};

const CREATE_ARTICLE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.article.create",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 2
} as const;

const PUBLISH_ARTICLE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.article.publish",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 2
} as const;

const CREATE_NEWSLETTER_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.newsletter.create",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 1
} as const;

const PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.newsletter.publish_issue",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 3
} as const;

export interface PrepareCreateArticleInput {
  profileName?: string;
  title: string;
  body: string;
  operatorNote?: string;
}

export interface PreparePublishArticleInput {
  profileName?: string;
  articleUrl: string;
  operatorNote?: string;
}

export interface PrepareCreateNewsletterInput {
  profileName?: string;
  title: string;
  description: string;
  cadence?: LinkedInNewsletterCadence | string;
  operatorNote?: string;
}

export interface PreparePublishNewsletterIssueInput {
  profileName?: string;
  newsletterUrl: string;
  title: string;
  body: string;
  operatorNote?: string;
}

export interface ListNewslettersInput {
  profileName?: string;
}

export interface LinkedInNewsletterSummary {
  cadence?: string;
  description?: string;
  title: string;
  url: string;
}

export interface ListNewslettersResult {
  count: number;
  newsletters: LinkedInNewsletterSummary[];
}

interface ValidatedLongFormText {
  characterCount: number;
  lineCount: number;
  normalizedText: string;
  paragraphCount: number;
}

interface NewsletterPageContext {
  description?: string;
  subscriberText?: string;
  title?: string;
}

export interface LinkedInPublishingExecutorRuntime {
  artifacts: ArtifactHelpers;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  logger: JsonEventLogger;
  profileManager: ProfileManager;
  rateLimiter: RateLimiter;
}

export interface LinkedInPublishingRuntime
  extends LinkedInPublishingExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInPublishingExecutorRuntime>,
    "prepare"
  >;
}

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/[ \t]+\n/g, "\n").replace(/\r/g, "").trim();
}

function createTextMetrics(value: string, label: string): ValidatedLongFormText {
  const normalizedText = normalizeWhitespace(value);
  if (!normalizedText) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  const lines = normalizedText.split("\n");
  const paragraphCount = normalizedText
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0).length;

  return {
    characterCount: normalizedText.length,
    lineCount: lines.length,
    normalizedText,
    paragraphCount: paragraphCount || 1
  };
}

export function normalizeLinkedInNewsletterCadence(
  value: string | undefined,
  fallback: LinkedInNewsletterCadence = "weekly"
): LinkedInNewsletterCadence {
  if (value === undefined || normalizeWhitespace(value).length === 0) {
    return fallback;
  }

  const normalizedValue = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\s+/g, "_");
  const cadence =
    LINKEDIN_NEWSLETTER_CADENCE_ALIAS_MAP[normalizedValue] ??
    LINKEDIN_NEWSLETTER_CADENCE_ALIAS_MAP[normalizedValue.replace(/_/g, "-")];

  if (cadence) {
    return cadence;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `cadence must be one of: ${LINKEDIN_NEWSLETTER_CADENCE_TYPES.join(", ")}.`,
    {
      provided_value: value
    }
  );
}

function resolveLinkedInUrl(
  input: string,
  label: string,
  options: {
    idOnlyPrefix?: string;
    pathnamePattern: RegExp;
  }
): string {
  const normalizedInput = normalizeWhitespace(input);
  if (!normalizedInput) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  if (/^\d+$/.test(normalizedInput) && options.idOnlyPrefix) {
    return `${options.idOnlyPrefix}${normalizedInput}/`;
  }

  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a LinkedIn URL.`,
      {
        provided_value: input
      },
      error instanceof Error ? { cause: error } : undefined
    );
  }

  if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must point to linkedin.com.`,
      {
        provided_value: input,
        hostname: url.hostname
      }
    );
  }

  if (!options.pathnamePattern.test(url.pathname)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must point to a supported LinkedIn publishing URL.`,
      {
        provided_value: input,
        pathname: url.pathname
      }
    );
  }

  return url.toString();
}

export function resolveLinkedInArticleUrl(input: string): string {
  return resolveLinkedInUrl(input, "articleUrl", {
    idOnlyPrefix: "https://www.linkedin.com/article/edit/",
    pathnamePattern: /^\/article\/(?:edit\/\d+\/?|new\/?|[\w-]+\/?\d*\/?)|^\/pulse\//i
  });
}

export function resolveLinkedInNewsletterUrl(input: string): string {
  return resolveLinkedInUrl(input, "newsletterUrl", {
    idOnlyPrefix: "https://www.linkedin.com/newsletters/",
    pathnamePattern: /^\/newsletters\/(?:[\w-]+-)?\d+\/?$/i
  });
}

function isLinkedInNewsletterUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      /(\.|^)linkedin\.com$/i.test(parsedUrl.hostname) &&
      /^\/newsletters\/(?:[\w-]+-)?\d+\/?$/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

function isLinkedInArticleEditUrl(url: string): boolean {
  try {
    return /^\/article\/edit\/\d+\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function toAutomationError(
  error: unknown,
  message: string,
  details: Record<string, unknown>
): LinkedInAssistantError {
  if (error instanceof LinkedInAssistantError) {
    return error;
  }

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInAssistantError("TIMEOUT", message, details, { cause: error });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i.test(error.message)
  ) {
    return new LinkedInAssistantError("NETWORK_ERROR", message, details, {
      cause: error
    });
  }

  return asLinkedInAssistantError(error, "UNKNOWN", message);
}

function formatRateLimitState(
  state: RateLimiterState
): Record<string, number | boolean | string> {
  return {
    allowed: state.allowed,
    count: state.count,
    counter_key: state.counterKey,
    limit: state.limit,
    remaining: state.remaining,
    window_size_ms: state.windowSizeMs,
    window_start_ms: state.windowStartMs
  };
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function captureScreenshotArtifact(
  runtime: LinkedInPublishingExecutorRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

function registerTraceArtifact(
  runtime: LinkedInPublishingExecutorRuntime,
  relativePath: string,
  metadata: Record<string, unknown>
): void {
  runtime.artifacts.registerArtifact(relativePath, "application/zip", metadata);
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 250
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return false;
}

async function readBodyText(page: Page): Promise<string> {
  return page.evaluate(() => globalThis.document.body.innerText);
}

async function ensureArticleEditor(page: Page): Promise<void> {
  const titleLocator = page.locator("#article-editor-headline__textarea").first();
  const bodyLocator = page
    .locator('[role="textbox"][aria-label="Article editor content"]')
    .first();
  const ready = await waitForCondition(async () => {
    const titleVisible = await titleLocator.isVisible().catch(() => false);
    const bodyVisible = await bodyLocator.isVisible().catch(() => false);
    return titleVisible && bodyVisible;
  }, 10_000);

  if (!ready) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn article editor surface.",
      {
        current_url: page.url()
      }
    );
  }
}

async function ensureNewsletterCreationForm(page: Page): Promise<void> {
  const titleLocator = page.locator("#series-modal__title").first();
  const cadenceLocator = page.locator("#series-modal__frequency-select").first();
  const descriptionLocator = page
    .locator("#series-modal__description-input")
    .first();
  const ready = await waitForCondition(async () => {
    const titleVisible = await titleLocator.isVisible().catch(() => false);
    const cadenceVisible = await cadenceLocator.isVisible().catch(() => false);
    const descriptionVisible = await descriptionLocator.isVisible().catch(() => false);
    return titleVisible && cadenceVisible && descriptionVisible;
  }, 10_000);

  if (!ready) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn newsletter creation form.",
      {
        current_url: page.url()
      }
    );
  }
}

async function replaceInputValueWithKeyboard(
  page: Page,
  locator: Locator,
  value: string
): Promise<void> {
  await locator.click({ force: true });
  await page.keyboard.press("Meta+A").catch(() => undefined);
  await page.keyboard.press("Control+A").catch(() => undefined);
  await page.keyboard.press("Backspace").catch(() => undefined);
  await page.keyboard.type(value, { delay: KEYBOARD_ENTRY_DELAY_MS });
}

async function selectNewsletterCadenceWithKeyboard(
  page: Page,
  locator: Locator,
  cadence: LinkedInNewsletterCadence
): Promise<void> {
  await locator.focus();
  await page.keyboard.type(
    LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence].keyboardShortcut,
    {
      delay: KEYBOARD_ENTRY_DELAY_MS
    }
  );
  await page.keyboard.press("Enter");
}

async function clickElementMatching(
  page: Page,
  selector: string,
  pattern: RegExp,
  description: string
): Promise<void> {
  await page.evaluate(
    ({
      description,
      flags,
      selector,
      source
    }: {
      description: string;
      flags: string;
      selector: string;
      source: string;
    }) => {
      const matcher = new RegExp(source, flags);
      const isVisible = (element: globalThis.Element): boolean => {
        if (!(element instanceof globalThis.HTMLElement)) {
          return false;
        }

        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const elements = Array.from(globalThis.document.querySelectorAll(selector));
      const match = elements.find((element) => {
        if (!isVisible(element)) {
          return false;
        }

        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        const ariaLabel = element.getAttribute("aria-label") ?? "";
        const title = element.getAttribute("title") ?? "";
        return (
          matcher.test(text) ||
          matcher.test(ariaLabel) ||
          matcher.test(title)
        );
      });

      if (!(match instanceof globalThis.HTMLElement)) {
        throw new Error(`${description} not found.`);
      }

      match.click();
    },
    {
      description,
      flags: pattern.flags,
      selector,
      source: pattern.source
    }
  );
}

async function clickButtonByText(
  page: Page,
  pattern: RegExp,
  description: string
): Promise<void> {
  await clickElementMatching(page, "button,[role='button']", pattern, description);
}

async function hasVisibleButtonMatching(
  page: Page,
  pattern: RegExp
): Promise<boolean> {
  return page.evaluate(
    ({ flags, source }: { flags: string; source: string }) => {
      const matcher = new RegExp(source, flags);
      const isVisible = (element: globalThis.Element): boolean => {
        if (!(element instanceof globalThis.HTMLElement)) {
          return false;
        }

        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      return Array.from(
        globalThis.document.querySelectorAll("button,[role='button']")
      ).some((element) => {
        if (!isVisible(element)) {
          return false;
        }

        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        const ariaLabel = element.getAttribute("aria-label") ?? "";
        const title = element.getAttribute("title") ?? "";
        return (
          matcher.test(text) ||
          matcher.test(ariaLabel) ||
          matcher.test(title)
        );
      });
    },
    {
      flags: pattern.flags,
      source: pattern.source
    }
  );
}

async function waitForPublishSurface(page: Page): Promise<boolean> {
  return waitForCondition(async () => {
    for (const pattern of PUBLISH_BUTTON_PATTERNS) {
      if (await hasVisibleButtonMatching(page, pattern)) {
        return true;
      }
    }

    return false;
  }, 10_000);
}

async function waitForDraftSaved(page: Page): Promise<string> {
  const saved = await waitForCondition(async () => {
    if (!isLinkedInArticleEditUrl(page.url())) {
      return false;
    }

    const bodyText = await readBodyText(page);
    return /draft\s*-\s*saved/i.test(bodyText);
  }, DRAFT_SAVE_TIMEOUT_MS);

  if (!saved) {
    throw new LinkedInAssistantError(
      "TIMEOUT",
      "LinkedIn did not finish saving the draft.",
      {
        current_url: page.url()
      }
    );
  }

  return page.url();
}

async function ensurePublishSurface(page: Page): Promise<void> {
  const ready = await waitForPublishSurface(page);

  if (!ready) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn publish controls.",
      {
        current_url: page.url()
      }
    );
  }
}

async function waitForPublishCompletion(page: Page): Promise<string> {
  const published = await waitForCondition(async () => {
    const currentUrl = page.url();
    if (!isLinkedInArticleEditUrl(currentUrl)) {
      return true;
    }

    const bodyText = await readBodyText(page);
    return !/^\s*publish\s*$/im.test(bodyText) && !bodyText.includes("Post to Anyone");
  }, ARTICLE_PUBLISH_TIMEOUT_MS);

  if (!published) {
    throw new LinkedInAssistantError(
      "TIMEOUT",
      "LinkedIn did not confirm the publish flow in time.",
      {
        current_url: page.url()
      }
    );
  }

  return page.url();
}

async function getNewsletterPageContext(
  page: Page
): Promise<NewsletterPageContext | null> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string | undefined => {
      const normalizedValue = (value ?? "").replace(/\s+/g, " ").trim();
      return normalizedValue.length > 0 ? normalizedValue : undefined;
    };

    const heading = normalize(
      globalThis.document.querySelector("h1")?.textContent ??
        globalThis.document.querySelector("h2")?.textContent
    );
    const description = Array.from(
      globalThis.document.querySelectorAll("p, span, div")
    )
      .map((element) => normalize(element.textContent))
      .find(
        (text) =>
          text !== undefined &&
          !/newsletter|subscriber|published/i.test(text) &&
          text.length > 10
      );
    const subscriberText = Array.from(
      globalThis.document.querySelectorAll("button, span, div")
    )
      .map((element) => normalize(element.textContent))
      .find((text) => text !== undefined && /subscriber/i.test(text));

    if (!heading && !description && !subscriberText) {
      return null;
    }

    return {
      ...(description ? { description } : {}),
      ...(subscriberText ? { subscriberText } : {}),
      ...(heading ? { title: heading } : {})
    };
  });
}

export async function parseLinkedInNewsletterList(
  page: Page
): Promise<LinkedInNewsletterSummary[]> {
  const items = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const anchors = Array.from(
      globalThis.document.querySelectorAll("a[href*='/newsletters/']")
    ).filter(
      (anchor) => anchor instanceof globalThis.HTMLAnchorElement
    );
    const results: Array<{
      description?: string;
      title: string;
      url: string;
    }> = [];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      const url = anchor.href;
      const title = normalize(anchor.textContent);
      if (!url || !title || seen.has(url)) {
        continue;
      }

      seen.add(url);
      const container =
        anchor.closest("li, article, div[data-view-name], div") ?? anchor;
      const description = Array.from(container.querySelectorAll("p, span, div"))
        .map((element) => normalize(element.textContent))
        .find(
          (text) =>
            text.length > 0 &&
            text !== title &&
            !/help center|create newsletter/i.test(text)
        );

      results.push({
        ...(description ? { description } : {}),
        title,
        url
      });
    }

    return results;
  });

  return items.filter((item) => isLinkedInNewsletterUrl(item.url));
}

function getRequiredStringField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "payload" | "target"
): string {
  const value = source[key];
  if (typeof value === "string" && normalizeWhitespace(value).length > 0) {
    return normalizeWhitespace(value);
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      key,
      location
    }
  );
}

function getProfileName(source: Record<string, unknown>): string {
  const profileName = source.profile_name;
  return typeof profileName === "string" && profileName.trim().length > 0
    ? profileName.trim()
    : "default";
}

export class LinkedInPublishingService {
  constructor(private readonly runtime: LinkedInPublishingRuntime) {}

  async listNewsletters(
    input: ListNewslettersInput = {}
  ): Promise<ListNewslettersResult> {
    const profileName = input.profileName ?? "default";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(LINKEDIN_NEWSLETTER_MANAGER_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);

          const newsletters = await parseLinkedInNewsletterList(page);
          return {
            count: newsletters.length,
            newsletters
          };
        }
      );
    } catch (error) {
      throw toAutomationError(error, "Failed to list LinkedIn newsletters.", {
        profile_name: profileName
      });
    }
  }

  async prepareCreateArticle(
    input: PrepareCreateArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const title = createTextMetrics(input.title, "Article title");
    const body = createTextMetrics(input.body, "Article body");
    const tracePath = `linkedin/trace-article-create-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            await page.goto(LINKEDIN_ARTICLE_NEW_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            await ensureArticleEditor(page);

            const screenshotPath = `linkedin/screenshot-article-create-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_create_article",
              profile_name: profileName
            });
            artifactPaths.push(screenshotPath);

            const rateLimitState = this.runtime.rateLimiter.peek(
              CREATE_ARTICLE_RATE_LIMIT_CONFIG
            );
            const target = {
              compose_url: LINKEDIN_ARTICLE_NEW_URL,
              profile_name: profileName
            };
            const preview = {
              summary: "Create LinkedIn article draft",
              target,
              outbound: {
                body: body.normalizedText,
                title: title.normalizedText
              },
              validation: {
                body_character_count: body.characterCount,
                body_line_count: body.lineCount,
                body_paragraph_count: body.paragraphCount,
                title_character_count: title.characterCount
              },
              artifacts: artifactPaths.map((path) => ({
                path,
                type: path.endsWith(".zip") ? "trace" : "screenshot"
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: CREATE_ARTICLE_ACTION_TYPE,
              payload: {
                body: body.normalizedText,
                title: title.normalizedText
              },
              preview,
              target,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-article-create-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                page,
                failureScreenshot,
                {
                  action: "prepare_create_article_error",
                  profile_name: profileName
                }
              );
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn article creation.",
              {
                artifact_paths: artifactPaths,
                current_url: page.url(),
                profile_name: profileName
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                await context.tracing.stop({
                  path: this.runtime.artifacts.resolve(tracePath)
                });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_article",
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.publishing.prepare_article.trace.stop_failed",
                  {
                    message: error instanceof Error ? error.message : String(error),
                    profile_name: profileName
                  }
                );
              }
            }
          }
        }
      );
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn article creation.", {
        artifact_paths: artifactPaths,
        profile_name: profileName
      });
    }
  }

  async preparePublishArticle(
    input: PreparePublishArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const articleUrl = resolveLinkedInArticleUrl(input.articleUrl);
    const tracePath = `linkedin/trace-article-publish-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await ensureArticleEditor(page);

            const screenshotPath =
              `linkedin/screenshot-article-publish-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_publish_article",
              article_url: articleUrl,
              profile_name: profileName
            });
            artifactPaths.push(screenshotPath);

            const rateLimitState = this.runtime.rateLimiter.peek(
              PUBLISH_ARTICLE_RATE_LIMIT_CONFIG
            );
            const target = {
              article_url: articleUrl,
              profile_name: profileName
            };
            const preview = {
              summary: `Publish LinkedIn article ${articleUrl}`,
              target,
              outbound: {
                action: "publish_article"
              },
              validation: {
                current_url: page.url(),
                editable_article: isLinkedInArticleEditUrl(page.url())
              },
              artifacts: artifactPaths.map((path) => ({
                path,
                type: path.endsWith(".zip") ? "trace" : "screenshot"
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: PUBLISH_ARTICLE_ACTION_TYPE,
              payload: {
                article_url: articleUrl
              },
              preview,
              target,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-article-publish-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                page,
                failureScreenshot,
                {
                  action: "prepare_publish_article_error",
                  article_url: articleUrl,
                  profile_name: profileName
                }
              );
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn article publish.",
              {
                article_url: articleUrl,
                artifact_paths: artifactPaths,
                current_url: page.url(),
                profile_name: profileName
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                await context.tracing.stop({
                  path: this.runtime.artifacts.resolve(tracePath)
                });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_publish_article",
                  article_url: articleUrl,
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.publishing.prepare_publish_article.trace.stop_failed",
                  {
                    article_url: articleUrl,
                    message: error instanceof Error ? error.message : String(error),
                    profile_name: profileName
                  }
                );
              }
            }
          }
        }
      );
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn article publish.", {
        article_url: articleUrl,
        artifact_paths: artifactPaths,
        profile_name: profileName
      });
    }
  }

  async prepareCreateNewsletter(
    input: PrepareCreateNewsletterInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const title = createTextMetrics(input.title, "Newsletter title");
    const description = createTextMetrics(
      input.description,
      "Newsletter description"
    );
    const cadence = normalizeLinkedInNewsletterCadence(input.cadence);
    const tracePath = `linkedin/trace-newsletter-create-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            await page.goto(LINKEDIN_NEWSLETTER_NEW_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            await ensureNewsletterCreationForm(page);

            const screenshotPath =
              `linkedin/screenshot-newsletter-create-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_create_newsletter",
              cadence,
              profile_name: profileName
            });
            artifactPaths.push(screenshotPath);

            const rateLimitState = this.runtime.rateLimiter.peek(
              CREATE_NEWSLETTER_RATE_LIMIT_CONFIG
            );
            const target = {
              create_url: LINKEDIN_NEWSLETTER_NEW_URL,
              profile_name: profileName
            };
            const preview = {
              summary: `Create ${LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence].label.toLowerCase()} LinkedIn newsletter`,
              target,
              outbound: {
                cadence,
                description: description.normalizedText,
                title: title.normalizedText
              },
              validation: {
                cadence_label: LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence].label,
                description_character_count: description.characterCount,
                title_character_count: title.characterCount
              },
              artifacts: artifactPaths.map((path) => ({
                path,
                type: path.endsWith(".zip") ? "trace" : "screenshot"
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: CREATE_NEWSLETTER_ACTION_TYPE,
              payload: {
                cadence,
                description: description.normalizedText,
                title: title.normalizedText
              },
              preview,
              target,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-newsletter-create-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                page,
                failureScreenshot,
                {
                  action: "prepare_create_newsletter_error",
                  cadence,
                  profile_name: profileName
                }
              );
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn newsletter creation.",
              {
                artifact_paths: artifactPaths,
                current_url: page.url(),
                profile_name: profileName
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                await context.tracing.stop({
                  path: this.runtime.artifacts.resolve(tracePath)
                });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_newsletter",
                  cadence,
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.publishing.prepare_create_newsletter.trace.stop_failed",
                  {
                    message: error instanceof Error ? error.message : String(error),
                    profile_name: profileName
                  }
                );
              }
            }
          }
        }
      );
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn newsletter creation.",
        {
          artifact_paths: artifactPaths,
          profile_name: profileName
        }
      );
    }
  }

  async preparePublishNewsletterIssue(
    input: PreparePublishNewsletterIssueInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const newsletterUrl = resolveLinkedInNewsletterUrl(input.newsletterUrl);
    const title = createTextMetrics(input.title, "Newsletter issue title");
    const body = createTextMetrics(input.body, "Newsletter issue body");
    const tracePath =
      `linkedin/trace-newsletter-publish-issue-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            await page.goto(newsletterUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);

            const pageContext = await getNewsletterPageContext(page);
            await clickButtonByText(
              page,
              /^Create new edition$/i,
              "create new edition button"
            );
            await waitForNetworkIdleBestEffort(page);
            await ensureArticleEditor(page);

            const screenshotPath =
              `linkedin/screenshot-newsletter-publish-issue-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_publish_newsletter_issue",
              newsletter_url: newsletterUrl,
              profile_name: profileName
            });
            artifactPaths.push(screenshotPath);

            const rateLimitState = this.runtime.rateLimiter.peek(
              PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG
            );
            const target = {
              newsletter_title: pageContext?.title ?? null,
              newsletter_url: newsletterUrl,
              profile_name: profileName
            };
            const preview = {
              summary: `Publish new edition to LinkedIn newsletter ${newsletterUrl}`,
              target,
              outbound: {
                body: body.normalizedText,
                title: title.normalizedText
              },
              validation: {
                body_character_count: body.characterCount,
                body_line_count: body.lineCount,
                body_paragraph_count: body.paragraphCount,
                edition_compose_url: page.url(),
                title_character_count: title.characterCount
              },
              artifacts: artifactPaths.map((path) => ({
                path,
                type: path.endsWith(".zip") ? "trace" : "screenshot"
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
              payload: {
                body: body.normalizedText,
                newsletter_url: newsletterUrl,
                title: title.normalizedText
              },
              preview,
              target,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-newsletter-publish-issue-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                page,
                failureScreenshot,
                {
                  action: "prepare_publish_newsletter_issue_error",
                  newsletter_url: newsletterUrl,
                  profile_name: profileName
                }
              );
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn newsletter issue publish.",
              {
                artifact_paths: artifactPaths,
                current_url: page.url(),
                newsletter_url: newsletterUrl,
                profile_name: profileName
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                await context.tracing.stop({
                  path: this.runtime.artifacts.resolve(tracePath)
                });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_publish_newsletter_issue",
                  newsletter_url: newsletterUrl,
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.publishing.prepare_publish_newsletter_issue.trace.stop_failed",
                  {
                    message: error instanceof Error ? error.message : String(error),
                    profile_name: profileName
                  }
                );
              }
            }
          }
        }
      );
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn newsletter issue publish.",
        {
          artifact_paths: artifactPaths,
          newsletter_url: newsletterUrl,
          profile_name: profileName
        }
      );
    }
  }
}

class CreateArticleActionExecutor
  implements ActionExecutor<LinkedInPublishingExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPublishingExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const title = getRequiredStringField(action.payload, "title", action.id, "payload");
    const body = getRequiredStringField(action.payload, "body", action.id, "payload");
    const tracePath = `linkedin/trace-article-create-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          const rateLimitState = runtime.rateLimiter.consume(
            CREATE_ARTICLE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn article draft creation is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName
              }
            );
          }

          await page.goto(LINKEDIN_ARTICLE_NEW_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await ensureArticleEditor(page);

          const beforeScreenshot =
            `linkedin/screenshot-article-create-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, beforeScreenshot, {
            action: "confirm_create_article_before",
            profile_name: profileName
          });
          artifactPaths.push(beforeScreenshot);

          await page.locator("#article-editor-headline__textarea").fill(title);
          await page
            .locator('[role="textbox"][aria-label="Article editor content"]')
            .click({ force: true });
          await page.keyboard.type(body, { delay: 20 });

          const draftUrl = await waitForDraftSaved(page);

          const afterScreenshot =
            `linkedin/screenshot-article-create-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, afterScreenshot, {
            action: "confirm_create_article_after",
            draft_url: draftUrl,
            profile_name: profileName
          });
          artifactPaths.push(afterScreenshot);

          return {
            artifacts: artifactPaths,
            ok: true,
            result: {
              article_url: draftUrl,
              draft_saved: true,
              profile_name: profileName,
              rate_limit: formatRateLimitState(rateLimitState),
              title
            }
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-article-create-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: "confirm_create_article_error",
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to create a LinkedIn article draft.", {
            action_id: action.id,
            artifact_paths: artifactPaths,
            current_url: page.url(),
            profile_name: profileName
          });
        } finally {
          if (tracingStarted) {
            try {
              await context.tracing.stop({ path: runtime.artifacts.resolve(tracePath) });
              registerTraceArtifact(runtime, tracePath, {
                action: "confirm_create_article",
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.publishing.confirm_create_article.trace.stop_failed",
                {
                  message: error instanceof Error ? error.message : String(error),
                  profile_name: profileName
                }
              );
            }
          }
        }
      }
    );
  }
}

class PublishArticleActionExecutor
  implements ActionExecutor<LinkedInPublishingExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPublishingExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const articleUrl = resolveLinkedInArticleUrl(
      getRequiredStringField(action.payload, "article_url", action.id, "payload")
    );
    const tracePath = `linkedin/trace-article-publish-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          const rateLimitState = runtime.rateLimiter.consume(
            PUBLISH_ARTICLE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn article publishing is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName
              }
            );
          }

          await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await ensureArticleEditor(page);

          const beforeScreenshot =
            `linkedin/screenshot-article-publish-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, beforeScreenshot, {
            action: "confirm_publish_article_before",
            article_url: articleUrl,
            profile_name: profileName
          });
          artifactPaths.push(beforeScreenshot);

          await clickButtonByText(page, NEXT_BUTTON_PATTERN, "article next button");
          await waitForNetworkIdleBestEffort(page);
          await ensurePublishSurface(page);

          const prePublishScreenshot =
            `linkedin/screenshot-article-publish-confirm-ready-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, prePublishScreenshot, {
            action: "confirm_publish_article_ready",
            article_url: articleUrl,
            profile_name: profileName
          });
          artifactPaths.push(prePublishScreenshot);

          await clickButtonByText(
            page,
            /^(?:Publish|Post)\b/i,
            "article publish button"
          );
          await waitForNetworkIdleBestEffort(page);
          const publishedUrl = await waitForPublishCompletion(page);

          const afterScreenshot =
            `linkedin/screenshot-article-publish-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, afterScreenshot, {
            action: "confirm_publish_article_after",
            article_url: articleUrl,
            profile_name: profileName,
            published_url: publishedUrl
          });
          artifactPaths.push(afterScreenshot);

          return {
            artifacts: artifactPaths,
            ok: true,
            result: {
              article_url: publishedUrl,
              profile_name: profileName,
              rate_limit: formatRateLimitState(rateLimitState),
              source_article_url: articleUrl
            }
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-article-publish-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: "confirm_publish_article_error",
              article_url: articleUrl,
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to publish the LinkedIn article.", {
            action_id: action.id,
            article_url: articleUrl,
            artifact_paths: artifactPaths,
            current_url: page.url(),
            profile_name: profileName
          });
        } finally {
          if (tracingStarted) {
            try {
              await context.tracing.stop({ path: runtime.artifacts.resolve(tracePath) });
              registerTraceArtifact(runtime, tracePath, {
                action: "confirm_publish_article",
                article_url: articleUrl,
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.publishing.confirm_publish_article.trace.stop_failed",
                {
                  message: error instanceof Error ? error.message : String(error),
                  profile_name: profileName
                }
              );
            }
          }
        }
      }
    );
  }
}

class CreateNewsletterActionExecutor
  implements ActionExecutor<LinkedInPublishingExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPublishingExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const title = getRequiredStringField(action.payload, "title", action.id, "payload");
    const description = getRequiredStringField(
      action.payload,
      "description",
      action.id,
      "payload"
    );
    const cadence = normalizeLinkedInNewsletterCadence(
      getRequiredStringField(action.payload, "cadence", action.id, "payload")
    );
    const tracePath = `linkedin/trace-newsletter-create-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          const rateLimitState = runtime.rateLimiter.consume(
            CREATE_NEWSLETTER_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn newsletter creation is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName
              }
            );
          }

          await page.goto(LINKEDIN_NEWSLETTER_NEW_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await ensureNewsletterCreationForm(page);

          const beforeScreenshot =
            `linkedin/screenshot-newsletter-create-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, beforeScreenshot, {
            action: "confirm_create_newsletter_before",
            cadence,
            profile_name: profileName
          });
          artifactPaths.push(beforeScreenshot);

          await replaceInputValueWithKeyboard(
            page,
            page.locator("#series-modal__title").first(),
            title
          );
          await page.keyboard.press("Tab");
          await selectNewsletterCadenceWithKeyboard(
            page,
            page.locator("#series-modal__frequency-select").first(),
            cadence
          );
          await page.keyboard.press("Tab");
          await replaceInputValueWithKeyboard(
            page,
            page.locator("#series-modal__description-input").first(),
            description
          );
          await page.keyboard.press("Tab");
          await page.waitForTimeout(300);

          await clickButtonByText(page, /^Done$/i, "newsletter done button");
          await waitForNetworkIdleBestEffort(page);

          const created = await waitForCondition(async () => {
            return isLinkedInNewsletterUrl(page.url());
          }, 20_000);
          if (!created) {
            throw new LinkedInAssistantError(
              "TIMEOUT",
              "LinkedIn did not finish creating the newsletter.",
              {
                current_url: page.url()
              }
            );
          }

          const newsletterUrl = page.url();
          const pageContext = await getNewsletterPageContext(page);

          const afterScreenshot =
            `linkedin/screenshot-newsletter-create-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, afterScreenshot, {
            action: "confirm_create_newsletter_after",
            newsletter_url: newsletterUrl,
            profile_name: profileName
          });
          artifactPaths.push(afterScreenshot);

          return {
            artifacts: artifactPaths,
            ok: true,
            result: {
              cadence,
              newsletter_title: pageContext?.title ?? title,
              newsletter_url: newsletterUrl,
              profile_name: profileName,
              rate_limit: formatRateLimitState(rateLimitState)
            }
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-newsletter-create-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: "confirm_create_newsletter_error",
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to create the LinkedIn newsletter.", {
            action_id: action.id,
            artifact_paths: artifactPaths,
            current_url: page.url(),
            profile_name: profileName
          });
        } finally {
          if (tracingStarted) {
            try {
              await context.tracing.stop({ path: runtime.artifacts.resolve(tracePath) });
              registerTraceArtifact(runtime, tracePath, {
                action: "confirm_create_newsletter",
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.publishing.confirm_create_newsletter.trace.stop_failed",
                {
                  message: error instanceof Error ? error.message : String(error),
                  profile_name: profileName
                }
              );
            }
          }
        }
      }
    );
  }
}

class PublishNewsletterIssueActionExecutor
  implements ActionExecutor<LinkedInPublishingExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPublishingExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const newsletterUrl = resolveLinkedInNewsletterUrl(
      getRequiredStringField(action.payload, "newsletter_url", action.id, "payload")
    );
    const title = getRequiredStringField(action.payload, "title", action.id, "payload");
    const body = getRequiredStringField(action.payload, "body", action.id, "payload");
    const tracePath =
      `linkedin/trace-newsletter-publish-issue-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

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
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          const rateLimitState = runtime.rateLimiter.consume(
            PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn newsletter issue publishing is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName
              }
            );
          }

          await page.goto(newsletterUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const beforeScreenshot =
            `linkedin/screenshot-newsletter-publish-issue-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, beforeScreenshot, {
            action: "confirm_publish_newsletter_issue_before",
            newsletter_url: newsletterUrl,
            profile_name: profileName
          });
          artifactPaths.push(beforeScreenshot);

          await clickButtonByText(
            page,
            /^Create new edition$/i,
            "create new edition button"
          );
          await waitForNetworkIdleBestEffort(page);
          await ensureArticleEditor(page);

          await page.locator("#article-editor-headline__textarea").fill(title);
          await page
            .locator('[role="textbox"][aria-label="Article editor content"]')
            .click({ force: true });
          await page.keyboard.type(body, { delay: 20 });

          const draftUrl = await waitForDraftSaved(page);

          const draftScreenshot =
            `linkedin/screenshot-newsletter-publish-issue-draft-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, draftScreenshot, {
            action: "confirm_publish_newsletter_issue_draft",
            draft_url: draftUrl,
            newsletter_url: newsletterUrl,
            profile_name: profileName
          });
          artifactPaths.push(draftScreenshot);

          await clickButtonByText(
            page,
            NEXT_BUTTON_PATTERN,
            "newsletter issue next button"
          );
          await waitForNetworkIdleBestEffort(page);
          await ensurePublishSurface(page);

          const readyScreenshot =
            `linkedin/screenshot-newsletter-publish-issue-ready-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, readyScreenshot, {
            action: "confirm_publish_newsletter_issue_ready",
            draft_url: draftUrl,
            newsletter_url: newsletterUrl,
            profile_name: profileName
          });
          artifactPaths.push(readyScreenshot);

          await clickButtonByText(
            page,
            /^(?:Publish|Post)\b/i,
            "newsletter issue publish button"
          );
          await waitForNetworkIdleBestEffort(page);
          const issueUrl = await waitForPublishCompletion(page);

          const afterScreenshot =
            `linkedin/screenshot-newsletter-publish-issue-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, afterScreenshot, {
            action: "confirm_publish_newsletter_issue_after",
            issue_url: issueUrl,
            newsletter_url: newsletterUrl,
            profile_name: profileName
          });
          artifactPaths.push(afterScreenshot);

          return {
            artifacts: artifactPaths,
            ok: true,
            result: {
              draft_url: draftUrl,
              issue_url: issueUrl,
              newsletter_url: newsletterUrl,
              profile_name: profileName,
              rate_limit: formatRateLimitState(rateLimitState),
              title
            }
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-newsletter-publish-issue-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: "confirm_publish_newsletter_issue_error",
              newsletter_url: newsletterUrl,
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(
            error,
            "Failed to publish the LinkedIn newsletter issue.",
            {
              action_id: action.id,
              artifact_paths: artifactPaths,
              current_url: page.url(),
              newsletter_url: newsletterUrl,
              profile_name: profileName
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              await context.tracing.stop({ path: runtime.artifacts.resolve(tracePath) });
              registerTraceArtifact(runtime, tracePath, {
                action: "confirm_publish_newsletter_issue",
                newsletter_url: newsletterUrl,
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.publishing.confirm_publish_newsletter_issue.trace.stop_failed",
                {
                  message: error instanceof Error ? error.message : String(error),
                  profile_name: profileName
                }
              );
            }
          }
        }
      }
    );
  }
}

export function createPublishingActionExecutors(): ActionExecutorRegistry<LinkedInPublishingExecutorRuntime> {
  return {
    [CREATE_ARTICLE_ACTION_TYPE]: new CreateArticleActionExecutor(),
    [PUBLISH_ARTICLE_ACTION_TYPE]: new PublishArticleActionExecutor(),
    [CREATE_NEWSLETTER_ACTION_TYPE]: new CreateNewsletterActionExecutor(),
    [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]:
      new PublishNewsletterIssueActionExecutor()
  };
}
