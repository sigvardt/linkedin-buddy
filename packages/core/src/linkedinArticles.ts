import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
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

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */

const LINKEDIN_ARTICLE_EDITOR_URL = "https://www.linkedin.com/article/new/";
const LINKEDIN_NEWSLETTER_CREATE_URL =
  "https://www.linkedin.com/article/newsletter/new/";
const LINKEDIN_NEWSLETTER_MANAGER_URL =
  "https://www.linkedin.com/mynetwork/network-manager/newsletters/";

const INDIVIDUAL_ARTICLE_LABEL = "Individual article";
const CREATE_NEW_EDITION_BUTTON_TEXT = "Create new edition";
const CREATE_NEWSLETTER_BUTTON_TEXT = "Create newsletter";

const CREATE_ARTICLE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.article.create",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 10
} as const;

const PUBLISH_ARTICLE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.article.publish",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 5
} as const;

const CREATE_NEWSLETTER_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.newsletter.create",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 2
} as const;

const PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.newsletter.publish_issue",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 5
} as const;

export const CREATE_ARTICLE_ACTION_TYPE = "article.create";
export const PUBLISH_ARTICLE_ACTION_TYPE = "article.publish";
export const CREATE_NEWSLETTER_ACTION_TYPE = "newsletter.create";
export const PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE =
  "newsletter.publish_issue";

export const LINKEDIN_NEWSLETTER_CADENCES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly"
] as const;

export type LinkedInNewsletterCadence =
  (typeof LINKEDIN_NEWSLETTER_CADENCES)[number];

interface NewsletterCadenceUiConfig {
  label: string;
  value: string;
}

const LINKEDIN_NEWSLETTER_CADENCE_MAP: Record<
  LinkedInNewsletterCadence,
  NewsletterCadenceUiConfig
> = {
  daily: {
    label: "Daily",
    value: "DAILY"
  },
  weekly: {
    label: "Weekly",
    value: "WEEKLY"
  },
  biweekly: {
    label: "Biweekly",
    value: "TWICE_MONTH"
  },
  monthly: {
    label: "Monthly",
    value: "MONTHLY"
  }
};

const LINKEDIN_NEWSLETTER_TITLE_MAX_LENGTH = 30;
const LINKEDIN_NEWSLETTER_DESCRIPTION_MAX_LENGTH = 120;

export interface PrepareCreateArticleInput {
  profileName?: string;
  title: string;
  body: string;
  operatorNote?: string;
}

export interface PreparePublishArticleInput {
  profileName?: string;
  articleUrl: string;
  shareText?: string;
  operatorNote?: string;
}

export interface PrepareCreateNewsletterInput {
  profileName?: string;
  title: string;
  description: string;
  cadence: LinkedInNewsletterCadence | string;
  operatorNote?: string;
}

export interface PreparePublishNewsletterIssueInput {
  profileName?: string;
  newsletterUrl: string;
  title: string;
  body: string;
  shareText?: string;
  operatorNote?: string;
}

export interface ListNewslettersInput {
  profileName?: string;
  limit?: number;
}

export interface LinkedInNewsletterSummary {
  title: string;
  newsletter_url: string;
  cadence: string;
  subscriber_count: string;
  edition_count: string;
  description: string;
}

interface LinkedInArticlesRuntimeBase {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
}

export interface LinkedInArticlesExecutorRuntime
  extends LinkedInArticlesRuntimeBase {
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInArticlesRuntime
  extends LinkedInArticlesExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInArticlesExecutorRuntime>,
    "prepare"
  >;
}

interface ExtractedNewsletterSummary {
  title: string;
  newsletter_url: string;
  cadence: string;
  subscriber_count: string;
  edition_count: string;
  description: string;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMultiLineText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireNonEmptyString(value: string, fieldName: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${fieldName} is required.`
    );
  }

  return normalized;
}

function validateArticleTitle(value: string): string {
  return requireNonEmptyString(value, "title");
}

function validateArticleBody(value: string): string {
  const normalized = normalizeMultiLineText(value);
  if (!normalized) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "body is required."
    );
  }

  return normalized;
}

function validateOptionalShareText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeMultiLineText(value);
  if (!normalized) {
    return undefined;
  }

  return normalized;
}

function validateNewsletterTitle(value: string): string {
  const normalized = requireNonEmptyString(value, "title");
  if (normalized.length > LINKEDIN_NEWSLETTER_TITLE_MAX_LENGTH) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Newsletter title must be ${LINKEDIN_NEWSLETTER_TITLE_MAX_LENGTH} characters or fewer.`
    );
  }

  return normalized;
}

function validateNewsletterDescription(value: string): string {
  const normalized = requireNonEmptyString(value, "description");
  if (normalized.length > LINKEDIN_NEWSLETTER_DESCRIPTION_MAX_LENGTH) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Newsletter description must be ${LINKEDIN_NEWSLETTER_DESCRIPTION_MAX_LENGTH} characters or fewer.`
    );
  }

  return normalized;
}

export function normalizeLinkedInNewsletterCadence(
  value: LinkedInNewsletterCadence | string
): LinkedInNewsletterCadence {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s_-]+/g, "");
  switch (normalized) {
    case "daily":
      return "daily";
    case "weekly":
      return "weekly";
    case "biweekly":
    case "twicemonth":
    case "twicemonthly":
      return "biweekly";
    case "monthly":
      return "monthly";
    default:
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `cadence must be one of: ${LINKEDIN_NEWSLETTER_CADENCES.join(", ")}.`
      );
  }
}

export function normalizeLinkedInArticleDraftUrl(value: string): string {
  const normalized = requireNonEmptyString(value, "articleUrl");
  if (normalized.startsWith("/article/")) {
    return `https://www.linkedin.com${normalized}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch (error) {
    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "articleUrl must be a valid LinkedIn URL."
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLinkedInDomain =
    hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  if (!isLinkedInDomain || !parsedUrl.pathname.startsWith("/article/")) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "articleUrl must point to linkedin.com/article/."
    );
  }

  parsedUrl.hash = "";
  return parsedUrl.toString();
}

export function normalizeLinkedInNewsletterUrl(value: string): string {
  const normalized = requireNonEmptyString(value, "newsletterUrl");
  if (normalized.startsWith("/newsletters/")) {
    return `https://www.linkedin.com${normalized.endsWith("/") ? normalized : `${normalized}/`}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch (error) {
    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "newsletterUrl must be a valid LinkedIn URL."
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLinkedInDomain =
    hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  if (!isLinkedInDomain || !parsedUrl.pathname.startsWith("/newsletters/")) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "newsletterUrl must point to linkedin.com/newsletters/."
    );
  }

  parsedUrl.hash = "";
  if (!parsedUrl.pathname.endsWith("/")) {
    parsedUrl.pathname = `${parsedUrl.pathname}/`;
  }
  return parsedUrl.toString();
}

function getRequiredStringField(
  value: Record<string, unknown>,
  key: string,
  label: string
): string {
  const raw = value[key];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} is required.`
  );
}

function getOptionalStringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

function formatRateLimitState(state: RateLimiterState): Record<string, unknown> {
  return {
    counter_key: state.counterKey,
    limit: state.limit,
    count: state.count,
    remaining: state.remaining,
    allowed: state.allowed,
    window_start_ms: state.windowStartMs,
    window_end_ms: state.windowStartMs + state.windowSizeMs
  };
}

function buildPreviewArtifacts(paths: string[]): Array<Record<string, string>> {
  return paths.map((path) => ({
    type: path.endsWith(".png") ? "screenshot" : "artifact",
    path
  }));
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

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function captureScreenshotArtifact(
  runtime: { artifacts: ArtifactHelpers },
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForArticleEditor(page: Page): Promise<void> {
  await page
    .locator('textarea[placeholder="Title"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[aria-label="Article editor content"][contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

async function waitForNewsletterCreateDialog(page: Page): Promise<void> {
  await page
    .locator('[role="dialog"] input[name="title"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

async function waitForNewsletterManager(page: Page): Promise<void> {
  const createButton = page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(CREATE_NEWSLETTER_BUTTON_TEXT)}$`, "i")
  });
  await createButton.first().waitFor({ state: "visible", timeout: 15_000 });
}

function isPublicationTriggerText(value: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.length > 0 &&
    normalized !== "Me" &&
    normalized !== "For Business" &&
    normalized !== "Style" &&
    normalized !== "Manage"
  );
}

async function findPublicationTrigger(page: Page): Promise<Locator> {
  const triggers = page.locator("button.artdeco-dropdown__trigger");
  const count = await triggers.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = triggers.nth(index);
    const ariaLabel = normalizeText(await candidate.getAttribute("aria-label"));
    if (ariaLabel === "Manage menu") {
      continue;
    }

    const text = normalizeText(await candidate.innerText().catch(() => ""));
    if (!isPublicationTriggerText(text)) {
      continue;
    }

    return candidate;
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate the LinkedIn article publication selector."
  );
}

async function readPublicationSelection(page: Page): Promise<string> {
  const trigger = await findPublicationTrigger(page);
  return normalizeText(await trigger.innerText().catch(() => ""));
}

async function selectPublicationTarget(
  page: Page,
  publicationLabel: string
): Promise<string> {
  const trigger = await findPublicationTrigger(page);
  const current = normalizeText(await trigger.innerText().catch(() => ""));
  if (current.includes(publicationLabel)) {
    return current;
  }

  await trigger.click();

  const radio = page.getByRole("radio", {
    name: new RegExp(`^${escapeRegExp(publicationLabel)}$`, "i")
  });
  await radio.first().waitFor({ state: "visible", timeout: 10_000 });
  await radio.first().click();

  const switched = await waitForCondition(async () => {
    const nextValue = normalizeText(await trigger.innerText().catch(() => ""));
    return nextValue.includes(publicationLabel);
  }, 10_000);

  if (!switched) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not switch the LinkedIn article editor to "${publicationLabel}".`
    );
  }

  return normalizeText(await trigger.innerText().catch(() => ""));
}

async function typeIntoField(
  page: Page,
  locator: Locator,
  text: string
): Promise<void> {
  await locator.click();
  await locator.press("Meta+A").catch(() => undefined);
  await locator.press("Control+A").catch(() => undefined);
  await locator.press("Backspace").catch(() => undefined);
  await page.keyboard.type(text);
}

async function waitForDraftSaved(page: Page): Promise<void> {
  await waitForCondition(async () => {
    const text = normalizeText(await page.locator("body").innerText().catch(() => ""));
    return /draft\s*-\s*saved|draft saved/i.test(text);
  }, 15_000);
}

async function createDraftFromEditor(
  page: Page,
  input: {
    title: string;
    body: string;
  }
): Promise<{ draftUrl: string; title: string; body: string }> {
  const titleField = page.locator('textarea[placeholder="Title"]').first();
  const bodyField = page
    .locator('[aria-label="Article editor content"][contenteditable="true"]')
    .first();

  await titleField.fill(input.title);
  await waitForCondition(
    async () => /\/article\/edit\//.test(page.url()),
    20_000
  );
  await page.waitForTimeout(1_000);
  await bodyField.fill(input.body);

  const bodyPersisted = await waitForCondition(async () => {
    const bodyText = normalizeText(await bodyField.textContent().catch(() => ""));
    return bodyText === normalizeText(input.body);
  }, 10_000);

  if (!bodyPersisted) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "LinkedIn article body text did not persist after drafting."
    );
  }

  // LinkedIn persists the body change only after focus leaves the editor.
  await titleField.click();
  await page.waitForTimeout(8_000);
  await waitForDraftSaved(page);

  return {
    draftUrl: page.url(),
    title: await titleField.inputValue(),
    body: normalizeText(await bodyField.textContent().catch(() => ""))
  };
}

async function openPublishDialog(page: Page): Promise<Locator> {
  const nextButton = page.getByRole("button", { name: /^next$/i }).first();
  await nextButton.waitFor({ state: "visible", timeout: 10_000 });
  await nextButton.click();

  const dialog = page.locator('[role="dialog"]').first();
  const visible = await waitForCondition(
    async () => await dialog.isVisible().catch(() => false),
    10_000
  );

  if (!visible) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "LinkedIn did not open the publish dialog for the article draft.",
      {
        current_url: page.url(),
        page_text: bodyText.slice(0, 500)
      }
    );
  }

  return dialog;
}

async function fillPublishSummary(
  page: Page,
  dialog: Locator,
  shareText: string | undefined
): Promise<void> {
  if (!shareText) {
    return;
  }

  const summaryInput = dialog
    .locator('textarea, [role="textbox"][contenteditable="true"], [contenteditable="true"]')
    .first();
  if (!(await summaryInput.isVisible().catch(() => false))) {
    return;
  }

  await typeIntoField(page, summaryInput, shareText);
}

async function publishFromDialog(
  page: Page,
  dialog: Locator,
  draftUrl: string
): Promise<{ publishedUrl: string; currentUrl: string }> {
  const publishButton = dialog.getByRole("button", { name: /^publish$/i }).first();
  await publishButton.waitFor({ state: "visible", timeout: 10_000 });
  await publishButton.click();

  const published = await waitForCondition(async () => {
    const dialogVisible = await dialog.isVisible().catch(() => false);
    const currentUrl = page.url();
    if (!currentUrl.includes("/article/edit/")) {
      return true;
    }

    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    return (
      !dialogVisible &&
      currentUrl !== draftUrl &&
      /published|edition|article/i.test(bodyText)
    );
  }, 30_000);

  if (!published) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "LinkedIn did not confirm article publication.",
      {
        current_url: page.url()
      }
    );
  }

  return {
    publishedUrl: page.url(),
    currentUrl: page.url()
  };
}

async function extractNewsletters(page: Page, limit: number): Promise<
  ExtractedNewsletterSummary[]
> {
  return page.evaluate((requestedLimit) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const items: ExtractedNewsletterSummary[] = [];
    const seen = new Set<string>();
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/newsletters/"]')
    );

    for (const anchor of anchors) {
      const href = normalize(anchor.href);
      const title = normalize(anchor.textContent);
      if (
        !href ||
        seen.has(href) ||
        href.includes("/mynetwork/network-manager/newsletters") ||
        title.length === 0
      ) {
        continue;
      }

      const card =
        anchor.closest("li") ??
        anchor.closest("article") ??
        anchor.closest("section") ??
        anchor.closest("div[data-view-name]") ??
        anchor.closest("div") ??
        anchor;
      const cardText = normalize((card as HTMLElement | null)?.innerText ?? card.textContent);
      const cadenceMatch = /\b(Daily|Weekly|Biweekly|Monthly)\b/i.exec(cardText);
      const subscribersMatch = /([0-9][0-9,]*)\s+subscribers?/i.exec(cardText);
      const editionsMatch = /([0-9][0-9,]*)\s+editions?/i.exec(cardText);

      let description = "";
      const lines = cardText
        .split(/(?<=\.)\s+|\s{2,}/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
      for (const line of lines) {
        if (
          line === title ||
          /author|subscriber|edition|daily|weekly|biweekly|monthly/i.test(line)
        ) {
          continue;
        }

        description = line;
        break;
      }

      seen.add(href);
      items.push({
        title,
        newsletter_url: href.endsWith("/") ? href : `${href}/`,
        cadence: cadenceMatch?.[1] ?? "",
        subscriber_count: subscribersMatch?.[0] ?? "",
        edition_count: editionsMatch?.[0] ?? "",
        description
      });

      if (items.length >= requestedLimit) {
        break;
      }
    }

    return items;
  }, Math.max(1, limit));
}

async function findNewsletterByTitle(
  page: Page,
  title: string
): Promise<ExtractedNewsletterSummary | null> {
  const normalizedTitle = normalizeText(title).toLowerCase();
  const newsletters = await extractNewsletters(page, 50);
  return (
    newsletters.find(
      (newsletter) => newsletter.title.toLowerCase() === normalizedTitle
    ) ?? null
  );
}

function resolvePreparedProfileName(profileName: string | undefined): string {
  return profileName ?? "default";
}

function toAutomationError(
  error: unknown,
  message: string,
  details: Record<string, unknown>
): LinkedInAssistantError {
  const linkedInError = asLinkedInAssistantError(error, "UNKNOWN", message);
  for (const [key, value] of Object.entries(details)) {
    if (linkedInError.details[key] !== undefined || value === undefined) {
      continue;
    }

    linkedInError.details[key] = value;
  }

  return linkedInError;
}

async function withProfilePage<T>(
  runtime: LinkedInArticlesRuntimeBase,
  profileName: string,
  callback: (context: BrowserContext, page: Page) => Promise<T>
): Promise<T> {
  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return callback(context, page);
    }
  );
}

export class LinkedInArticlesService {
  constructor(private readonly runtime: LinkedInArticlesRuntime) {}

  async listNewsletters(
    input: ListNewslettersInput = {}
  ): Promise<LinkedInNewsletterSummary[]> {
    const profileName = resolvePreparedProfileName(input.profileName);
    const limit = Math.max(1, input.limit ?? 20);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await withProfilePage(this.runtime, profileName, async (_, page) => {
        await page.goto(LINKEDIN_NEWSLETTER_MANAGER_URL, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page);
        await waitForNewsletterManager(page);
        return extractNewsletters(page, limit);
      });
    } catch (error) {
      throw toAutomationError(error, "Failed to list LinkedIn newsletters.", {
        profile_name: profileName
      });
    }
  }

  async prepareCreateArticle(
    input: PrepareCreateArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = resolvePreparedProfileName(input.profileName);
    const title = validateArticleTitle(input.title);
    const body = validateArticleBody(input.body);
    const artifactPaths: string[] = [];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      await withProfilePage(this.runtime, profileName, async (_, page) => {
        await page.goto(LINKEDIN_ARTICLE_EDITOR_URL, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page);
        await waitForArticleEditor(page);

        const screenshotPath = `linkedin/screenshot-article-prepare-${Date.now()}.png`;
        artifactPaths.push(
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: "prepare_create_article",
            profile_name: profileName
          })
        );
      });
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn article draft creation.",
        {
          profile_name: profileName,
          artifact_paths: artifactPaths
        }
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      CREATE_ARTICLE_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      compose_url: LINKEDIN_ARTICLE_EDITOR_URL,
      publication: "individual_article"
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: CREATE_ARTICLE_ACTION_TYPE,
      target,
      payload: {
        title,
        body
      },
      preview: {
        summary: `Create LinkedIn article draft "${title}"`,
        target,
        outbound: {
          title,
          body
        },
        validation: {
          title_length: title.length,
          body_length: body.length
        },
        artifacts: buildPreviewArtifacts(artifactPaths),
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async preparePublishArticle(
    input: PreparePublishArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = resolvePreparedProfileName(input.profileName);
    const articleUrl = normalizeLinkedInArticleDraftUrl(input.articleUrl);
    const shareText = validateOptionalShareText(input.shareText);
    const artifactPaths: string[] = [];
    let draftTitle = "";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      await withProfilePage(this.runtime, profileName, async (_, page) => {
        await page.goto(articleUrl, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page);
        await waitForArticleEditor(page);

        const publicationSelection = await readPublicationSelection(page);
        if (!publicationSelection.includes(INDIVIDUAL_ARTICLE_LABEL)) {
          throw new LinkedInAssistantError(
            "ACTION_PRECONDITION_FAILED",
            "The selected draft is linked to a newsletter issue. Use newsletter.prepare_publish_issue for newsletter editions.",
            {
              article_url: articleUrl,
              publication_selection: publicationSelection
            }
          );
        }

        draftTitle = await page
          .locator('textarea[placeholder="Title"]')
          .first()
          .inputValue();

        const screenshotPath = `linkedin/screenshot-article-publish-prepare-${Date.now()}.png`;
        artifactPaths.push(
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: "prepare_publish_article",
            profile_name: profileName,
            article_url: articleUrl
          })
        );
      });
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn article publish.", {
        profile_name: profileName,
        article_url: articleUrl,
        artifact_paths: artifactPaths
      });
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      PUBLISH_ARTICLE_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      article_url: articleUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: PUBLISH_ARTICLE_ACTION_TYPE,
      target,
      payload: {
        ...(shareText ? { share_text: shareText } : {})
      },
      preview: {
        summary: `Publish LinkedIn article draft ${articleUrl}`,
        target,
        outbound: {
          ...(draftTitle ? { title: draftTitle } : {}),
          ...(shareText ? { share_text: shareText } : {})
        },
        artifacts: buildPreviewArtifacts(artifactPaths),
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareCreateNewsletter(
    input: PrepareCreateNewsletterInput
  ): Promise<PreparedActionResult> {
    const profileName = resolvePreparedProfileName(input.profileName);
    const title = validateNewsletterTitle(input.title);
    const description = validateNewsletterDescription(input.description);
    const cadence = normalizeLinkedInNewsletterCadence(input.cadence);
    const artifactPaths: string[] = [];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      await withProfilePage(this.runtime, profileName, async (_, page) => {
        await page.goto(LINKEDIN_NEWSLETTER_CREATE_URL, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page);
        await waitForNewsletterCreateDialog(page);

        const screenshotPath =
          `linkedin/screenshot-newsletter-create-prepare-${Date.now()}.png`;
        artifactPaths.push(
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: "prepare_create_newsletter",
            profile_name: profileName
          })
        );
      });
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn newsletter creation.",
        {
          profile_name: profileName,
          artifact_paths: artifactPaths
        }
      );
    }

    const cadenceUi = LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence];
    const rateLimitState = this.runtime.rateLimiter.peek(
      CREATE_NEWSLETTER_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      create_url: LINKEDIN_NEWSLETTER_CREATE_URL
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: CREATE_NEWSLETTER_ACTION_TYPE,
      target,
      payload: {
        title,
        description,
        cadence
      },
      preview: {
        summary: `Create LinkedIn newsletter "${title}"`,
        target,
        outbound: {
          title,
          description,
          cadence,
          cadence_label: cadenceUi.label
        },
        validation: {
          title_length: title.length,
          description_length: description.length,
          title_max_length: LINKEDIN_NEWSLETTER_TITLE_MAX_LENGTH,
          description_max_length: LINKEDIN_NEWSLETTER_DESCRIPTION_MAX_LENGTH
        },
        artifacts: buildPreviewArtifacts(artifactPaths),
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async preparePublishNewsletterIssue(
    input: PreparePublishNewsletterIssueInput
  ): Promise<PreparedActionResult> {
    const profileName = resolvePreparedProfileName(input.profileName);
    const newsletterUrl = normalizeLinkedInNewsletterUrl(input.newsletterUrl);
    const title = validateArticleTitle(input.title);
    const body = validateArticleBody(input.body);
    const shareText = validateOptionalShareText(input.shareText);
    const artifactPaths: string[] = [];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      await withProfilePage(this.runtime, profileName, async (_, page) => {
        await page.goto(newsletterUrl, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page);
        await page
          .getByRole("button", {
            name: new RegExp(`^${escapeRegExp(CREATE_NEW_EDITION_BUTTON_TEXT)}$`, "i")
          })
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });

        const screenshotPath =
          `linkedin/screenshot-newsletter-issue-prepare-${Date.now()}.png`;
        artifactPaths.push(
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: "prepare_publish_newsletter_issue",
            profile_name: profileName,
            newsletter_url: newsletterUrl
          })
        );
      });
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn newsletter issue publish.",
        {
          profile_name: profileName,
          newsletter_url: newsletterUrl,
          artifact_paths: artifactPaths
        }
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      newsletter_url: newsletterUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
      target,
      payload: {
        title,
        body,
        ...(shareText ? { share_text: shareText } : {})
      },
      preview: {
        summary: `Publish LinkedIn newsletter issue "${title}"`,
        target,
        outbound: {
          title,
          body,
          ...(shareText ? { share_text: shareText } : {})
        },
        validation: {
          title_length: title.length,
          body_length: body.length,
          ...(shareText ? { share_text_length: shareText.length } : {})
        },
        artifacts: buildPreviewArtifacts(artifactPaths),
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}

async function executeCreateArticle(
  runtime: LinkedInArticlesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<ActionExecutorResult> {
  const profileName = getRequiredStringField(target, "profile_name", "profile_name");
  const title = validateArticleTitle(getRequiredStringField(payload, "title", "title"));
  const body = validateArticleBody(getRequiredStringField(payload, "body", "body"));

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: CREATE_ARTICLE_ACTION_TYPE,
        profileName,
        targetUrl: LINKEDIN_ARTICLE_EDITOR_URL,
        metadata: {
          title
        },
        errorDetails: {
          title
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to create LinkedIn article draft."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            CREATE_ARTICLE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn article draft creation is rate limited for the current window.",
              {
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(LINKEDIN_ARTICLE_EDITOR_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForArticleEditor(page);
          const publicationSelection = await selectPublicationTarget(
            page,
            INDIVIDUAL_ARTICLE_LABEL
          );
          const draft = await createDraftFromEditor(page, {
            title,
            body
          });

          const screenshotPath = `linkedin/screenshot-article-created-${Date.now()}.png`;
          const artifacts = [
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: CREATE_ARTICLE_ACTION_TYPE,
              action_id: actionId,
              profile_name: profileName,
              draft_article_url: draft.draftUrl
            })
          ];

          return {
            ok: true,
            result: {
              status: "article_draft_created",
              title: draft.title,
              body: draft.body,
              publication: publicationSelection,
              article_draft_url: draft.draftUrl
            },
            artifacts
          };
        }
      });
    }
  );
}

async function executePublishArticle(
  runtime: LinkedInArticlesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<ActionExecutorResult> {
  const profileName = getRequiredStringField(target, "profile_name", "profile_name");
  const articleUrl = normalizeLinkedInArticleDraftUrl(
    getRequiredStringField(target, "article_url", "article_url")
  );
  const shareText = validateOptionalShareText(getOptionalStringField(payload, "share_text"));

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: PUBLISH_ARTICLE_ACTION_TYPE,
        profileName,
        targetUrl: articleUrl,
        metadata: {
          article_url: articleUrl
        },
        errorDetails: {
          article_url: articleUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to publish LinkedIn article draft."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            PUBLISH_ARTICLE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn article publishing is rate limited for the current window.",
              {
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(articleUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForArticleEditor(page);

          const publicationSelection = await readPublicationSelection(page);
          if (!publicationSelection.includes(INDIVIDUAL_ARTICLE_LABEL)) {
            throw new LinkedInAssistantError(
              "ACTION_PRECONDITION_FAILED",
              "This draft is configured as a newsletter issue, not an individual article.",
              {
                article_url: articleUrl,
                publication_selection: publicationSelection
              }
            );
          }

          const title = await page
            .locator('textarea[placeholder="Title"]')
            .first()
            .inputValue();
          const dialog = await openPublishDialog(page);
          await fillPublishSummary(page, dialog, shareText);
          const publishResult = await publishFromDialog(page, dialog, articleUrl);

          const screenshotPath = `linkedin/screenshot-article-published-${Date.now()}.png`;
          const artifacts = [
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: PUBLISH_ARTICLE_ACTION_TYPE,
              action_id: actionId,
              profile_name: profileName,
              article_url: articleUrl,
              published_url: publishResult.publishedUrl
            })
          ];

          return {
            ok: true,
            result: {
              status: "article_published",
              title,
              article_draft_url: articleUrl,
              published_url: publishResult.publishedUrl,
              ...(shareText ? { share_text: shareText } : {})
            },
            artifacts
          };
        }
      });
    }
  );
}

async function executeCreateNewsletter(
  runtime: LinkedInArticlesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<ActionExecutorResult> {
  const profileName = getRequiredStringField(target, "profile_name", "profile_name");
  const title = validateNewsletterTitle(getRequiredStringField(payload, "title", "title"));
  const description = validateNewsletterDescription(
    getRequiredStringField(payload, "description", "description")
  );
  const cadence = normalizeLinkedInNewsletterCadence(
    getRequiredStringField(payload, "cadence", "cadence")
  );

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: CREATE_NEWSLETTER_ACTION_TYPE,
        profileName,
        targetUrl: LINKEDIN_NEWSLETTER_CREATE_URL,
        metadata: {
          title,
          cadence
        },
        errorDetails: {
          title,
          cadence
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to create LinkedIn newsletter."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            CREATE_NEWSLETTER_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn newsletter creation is rate limited for the current window.",
              {
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(LINKEDIN_NEWSLETTER_CREATE_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForNewsletterCreateDialog(page);

          const dialog = page.locator('[role="dialog"]').first();
          await typeIntoField(page, dialog.locator('input[name="title"]').first(), title);
          await dialog
            .locator('select[name="cadence"]')
            .first()
            .selectOption(LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence].value);
          await typeIntoField(
            page,
            dialog.locator('input[name="description"]').first(),
            description
          );
          await dialog.getByRole("button", { name: /^done$/i }).first().click({
            force: true
          });

          const created = await waitForCondition(async () => {
            const bodyText = normalizeText(
              await page.locator("body").innerText().catch(() => "")
            );
            return (
              /newsletter created successfully/i.test(bodyText) ||
              /create new edition/i.test(bodyText)
            );
          }, 30_000);

          if (!created) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "LinkedIn did not confirm newsletter creation."
            );
          }

          await page.goto(LINKEDIN_NEWSLETTER_MANAGER_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForNewsletterManager(page);

          const newsletter = await findNewsletterByTitle(page, title);
          if (!newsletter) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "Created LinkedIn newsletter could not be found on the newsletters manager page.",
              {
                title
              }
            );
          }

          const screenshotPath =
            `linkedin/screenshot-newsletter-created-${Date.now()}.png`;
          const artifacts = [
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: CREATE_NEWSLETTER_ACTION_TYPE,
              action_id: actionId,
              profile_name: profileName,
              newsletter_url: newsletter.newsletter_url
            })
          ];

          return {
            ok: true,
            result: {
              status: "newsletter_created",
              title: newsletter.title,
              cadence: LINKEDIN_NEWSLETTER_CADENCE_MAP[cadence].label,
              description,
              newsletter_url: newsletter.newsletter_url
            },
            artifacts
          };
        }
      });
    }
  );
}

async function executePublishNewsletterIssue(
  runtime: LinkedInArticlesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<ActionExecutorResult> {
  const profileName = getRequiredStringField(target, "profile_name", "profile_name");
  const newsletterUrl = normalizeLinkedInNewsletterUrl(
    getRequiredStringField(target, "newsletter_url", "newsletter_url")
  );
  const title = validateArticleTitle(getRequiredStringField(payload, "title", "title"));
  const body = validateArticleBody(getRequiredStringField(payload, "body", "body"));
  const shareText = validateOptionalShareText(getOptionalStringField(payload, "share_text"));

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
        profileName,
        targetUrl: newsletterUrl,
        metadata: {
          newsletter_url: newsletterUrl,
          title
        },
        errorDetails: {
          newsletter_url: newsletterUrl,
          title
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to publish LinkedIn newsletter issue."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            PUBLISH_NEWSLETTER_ISSUE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn newsletter issue publishing is rate limited for the current window.",
              {
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(newsletterUrl, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          const newEditionButton = page.getByRole("button", {
            name: new RegExp(`^${escapeRegExp(CREATE_NEW_EDITION_BUTTON_TEXT)}$`, "i")
          });
          await newEditionButton.first().waitFor({ state: "visible", timeout: 15_000 });
          await newEditionButton.first().click();

          await waitForArticleEditor(page);
          const draft = await createDraftFromEditor(page, {
            title,
            body
          });
          const dialog = await openPublishDialog(page);
          await fillPublishSummary(page, dialog, shareText);
          const publishResult = await publishFromDialog(
            page,
            dialog,
            draft.draftUrl
          );

          const screenshotPath =
            `linkedin/screenshot-newsletter-issue-published-${Date.now()}.png`;
          const artifacts = [
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
              action_id: actionId,
              profile_name: profileName,
              newsletter_url: newsletterUrl,
              published_url: publishResult.publishedUrl
            })
          ];

          return {
            ok: true,
            result: {
              status: "newsletter_issue_published",
              newsletter_url: newsletterUrl,
              issue_title: draft.title,
              published_url: publishResult.publishedUrl,
              ...(shareText ? { share_text: shareText } : {})
            },
            artifacts
          };
        }
      });
    }
  );
}

export class CreateArticleActionExecutor
  implements ActionExecutor<LinkedInArticlesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInArticlesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    return executeCreateArticle(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
  }
}

export class PublishArticleActionExecutor
  implements ActionExecutor<LinkedInArticlesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInArticlesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    return executePublishArticle(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
  }
}

export class CreateNewsletterActionExecutor
  implements ActionExecutor<LinkedInArticlesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInArticlesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    return executeCreateNewsletter(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
  }
}

export class PublishNewsletterIssueActionExecutor
  implements ActionExecutor<LinkedInArticlesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInArticlesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    return executePublishNewsletterIssue(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
  }
}

export function createArticleActionExecutors(): ActionExecutorRegistry<LinkedInArticlesExecutorRuntime> {
  return {
    [CREATE_ARTICLE_ACTION_TYPE]: new CreateArticleActionExecutor(),
    [PUBLISH_ARTICLE_ACTION_TYPE]: new PublishArticleActionExecutor(),
    [CREATE_NEWSLETTER_ACTION_TYPE]: new CreateNewsletterActionExecutor(),
    [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]:
      new PublishNewsletterIssueActionExecutor()
  };
}
