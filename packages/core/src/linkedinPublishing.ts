import {
  errors as playwrightErrors,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  normalizeText,
  getOrCreatePage,
  escapeCssAttributeValue,
  escapeRegExp,
  isLocatorVisible
} from "./shared.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  createPrepareRateLimitMessage,
  peekRateLimitPreviewOrThrow,
  type ConsumeRateLimitInput,
  type RateLimiter
} from "./rateLimiter.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorRegistry,
  ActionExecutorResult,
  PreparedActionResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_HOST_PATTERN = /(^|\.)linkedin\.com$/iu;
export const CREATE_ARTICLE_ACTION_TYPE = "article.create";
export const PUBLISH_ARTICLE_ACTION_TYPE = "article.publish";
export const CREATE_NEWSLETTER_ACTION_TYPE = "newsletter.create";
export const PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE = "newsletter.publish_issue";

const PUBLISHING_RATE_LIMIT_CONFIGS = {
  [CREATE_ARTICLE_ACTION_TYPE]: {
    counterKey: "linkedin.article.create",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  },
  [PUBLISH_ARTICLE_ACTION_TYPE]: {
    counterKey: "linkedin.article.publish",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  },
  [CREATE_NEWSLETTER_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.create",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  },
  [PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE]: {
    counterKey: "linkedin.newsletter.publish_issue",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }
} as const satisfies Record<string, ConsumeRateLimitInput>;

export const LINKEDIN_NEWSLETTER_CADENCE_TYPES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly"
] as const;

export type LinkedInNewsletterCadence =
  (typeof LINKEDIN_NEWSLETTER_CADENCE_TYPES)[number];

const LINKEDIN_NEWSLETTER_CADENCE_LABELS: Record<
  LinkedInNewsletterCadence,
  { label: string; aliases: readonly string[] }
> = {
  daily: {
    label: "Daily",
    aliases: ["daily", "every day"]
  },
  weekly: {
    label: "Weekly",
    aliases: ["weekly", "every week"]
  },
  biweekly: {
    label: "Biweekly",
    aliases: ["biweekly", "bi-weekly", "every two weeks", "fortnightly"]
  },
  monthly: {
    label: "Monthly",
    aliases: ["monthly", "every month"]
  }
};

export const ARTICLE_TITLE_MAX_LENGTH = 150;
export const ARTICLE_BODY_MAX_LENGTH = 125_000;
export const NEWSLETTER_TITLE_MAX_LENGTH = 64;
export const NEWSLETTER_DESCRIPTION_MAX_LENGTH = 300;
export const NEWSLETTER_ISSUE_TITLE_MAX_LENGTH = 150;
export const NEWSLETTER_ISSUE_BODY_MAX_LENGTH = 125_000;

export interface PrepareCreateArticleInput {
  profileName?: string;
  title: string;
  body: string;
  operatorNote?: string;
}

export interface PreparePublishArticleInput {
  profileName?: string;
  draftUrl: string;
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
  newsletter: string;
  title: string;
  body: string;
  operatorNote?: string;
}

export interface ListNewslettersInput {
  profileName?: string;
}

export interface LinkedInNewsletterSummary {
  title: string;
  selected: boolean;
}

export interface ListNewslettersOutput {
  count: number;
  newsletters: LinkedInNewsletterSummary[];
}

export interface LinkedInPublishingExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
}

export interface LinkedInPublishingRuntime
  extends LinkedInPublishingExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInPublishingExecutorRuntime>,
    "prepare"
  >;
}

interface SelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

interface ScopedSelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: Locator) => Locator;
}

interface EditorSurface {
  page: Page;
  titleKey: string;
  bodyKey: string;
  triggerKey: string;
}

function getPublishingRateLimitConfig(
  actionType: string
): ConsumeRateLimitInput {
  const config = (
    PUBLISHING_RATE_LIMIT_CONFIGS as Record<string, ConsumeRateLimitInput>
  )[actionType];

  if (!config) {
    throw new LinkedInBuddyError("UNKNOWN", "Missing rate limit policy.", {
      action_type: actionType
    });
  }

  return config;
}

function enforcePublishingRateLimit(input: {
  runtime: LinkedInPublishingExecutorRuntime;
  actionType: string;
  actionId: string;
  profileName: string;
  details?: Record<string, unknown>;
}): void {
  consumeRateLimitOrThrow(input.runtime.rateLimiter, {
    config: getPublishingRateLimitConfig(input.actionType),
    message: createConfirmRateLimitMessage(input.actionType),
    details: {
      action_id: input.actionId,
      profile_name: input.profileName,
      ...(input.details ?? {})
    }
  });
}

function preparePublishingAction(
  runtime: LinkedInPublishingRuntime,
  input: {
    actionType: string;
    target: Record<string, unknown>;
    payload: Record<string, unknown>;
    preview: Record<string, unknown>;
    operatorNote?: string;
  }
): PreparedActionResult {
  return runtime.twoPhaseCommit.prepare({
    actionType: input.actionType,
    target: input.target,
    payload: input.payload,
    preview: {
      ...input.preview,
      rate_limit: peekRateLimitPreviewOrThrow(
        runtime.rateLimiter,
        getPublishingRateLimitConfig(input.actionType),
        createPrepareRateLimitMessage(input.actionType)
      )
    },
    ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
  });
}

function containsUnsupportedControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? -1;
    return (
      (codePoint >= 0x00 && codePoint <= 0x08) ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f
    );
  });
}

function normalizeLine(value: string): string {
  return value.replace(/[ \t]+\n/gu, "\n").replace(/[ \t]+$/gu, "").trim();
}

function buildLocalizedRegex(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[] = english,
  options: { exact?: boolean } = {}
): RegExp {
  const phrases =
    selectorLocale === "da" ? [...danish, ...english] : [...english, ...danish];
  const body = phrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$";
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "iu");
}

function requireSingleLineText(
  value: string,
  label: string,
  options: {
    allowUrl?: boolean;
    maxLength?: number;
  } = {}
): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  if (!options.allowUrl && /^https?:\/\//iu.test(normalizedValue)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be descriptive text, not a URL.`
    );
  }

  if (containsUnsupportedControlCharacters(normalizedValue)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} contains unsupported control characters.`
    );
  }


  if (options.maxLength && normalizedValue.length > options.maxLength) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} exceeds maximum length of ${options.maxLength} characters (got ${normalizedValue.length}).`,
    );
  }
  return normalizedValue;
}

function requireLongFormText(
  value: string,
  label: string,
  options: { maxLength?: number } = {},
): string {
  const normalizedValue = normalizeLine(
    value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n")
  );

  if (!normalizedValue) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  if (containsUnsupportedControlCharacters(normalizedValue)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} contains unsupported control characters.`
    );
  }


  if (options.maxLength && normalizedValue.length > options.maxLength) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} exceeds maximum length of ${options.maxLength} characters (got ${normalizedValue.length}).`,
    );
  }
  return normalizedValue;
}

function normalizeNewsletterCadence(
  value: LinkedInNewsletterCadence | string
): LinkedInNewsletterCadence {
  const normalizedValue = normalizeText(value)
    .toLowerCase()
    .replace(/[\s_-]+/gu, "");

  for (const cadence of LINKEDIN_NEWSLETTER_CADENCE_TYPES) {
    const config = LINKEDIN_NEWSLETTER_CADENCE_LABELS[cadence];
    const aliases = [cadence, ...config.aliases].map((alias) =>
      alias.replace(/[\s_-]+/gu, "")
    );
    if (aliases.includes(normalizedValue)) {
      return cadence;
    }
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `cadence must be one of: ${LINKEDIN_NEWSLETTER_CADENCE_TYPES.join(", ")}.`
  );
}

function normalizeLinkedInUrl(value: string, label: string): string {
  const normalizedValue = requireSingleLineText(value, label, {
    allowUrl: true
  });

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedValue);
  } catch (error) {
    throw asLinkedInBuddyError(
      error,
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a valid absolute URL.`
    );
  }

  if (!LINKEDIN_HOST_PATTERN.test(parsedUrl.hostname)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must point to linkedin.com.`
    );
  }

  parsedUrl.hash = "";
  return parsedUrl.toString();
}

function isEditorUrl(value: string): boolean {
  const normalizedValue = value.toLowerCase();
  return (
    normalizedValue.includes("/pulse/") ||
    normalizedValue.includes("/post/new/") ||
    normalizedValue.includes("/drafts/")
  );
}

function isDraftEditUrl(value: string): boolean {
  const normalizedValue = value.toLowerCase();
  return (
    normalizedValue.includes("/edit") || normalizedValue.includes("/post/new/")
  );
}

function resolvePublishedUrl(value: string): string {
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = "";
    const normalizedPath = parsedUrl.pathname.replace(/\/edit\/?$/iu, "/");
    parsedUrl.pathname = normalizedPath;
    return parsedUrl.toString();
  } catch {
    return value;
  }
}

function createVerificationSnippet(text: string): string {
  return normalizeText(text).slice(0, 120);
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

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key
    }
  );
}

function toAutomationError(
  error: unknown,
  message: string,
  details: Record<string, unknown>
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInBuddyError("TIMEOUT", message, details, { cause: error });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/iu.test(error.message)
  ) {
    return new LinkedInBuddyError("NETWORK_ERROR", message, details, {
      cause: error
    });
  }

  return asLinkedInBuddyError(error, "UNKNOWN", message);
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

async function findVisibleLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return { locator, key: candidate.key };
    } catch {
      // Try the next selector candidate.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: page.url(),
      attempted_selectors: candidates.map((candidate) => candidate.selectorHint),
      artifact_paths: artifactPaths
    }
  );
}

async function findVisibleScopedLocatorOrThrow(
  root: Locator,
  candidates: ScopedSelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[],
  currentUrl: string
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_500 });
      return { locator, key: candidate.key };
    } catch {
      // Try the next selector candidate.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: currentUrl,
      attempted_selectors: candidates.map((candidate) => candidate.selectorHint),
      artifact_paths: artifactPaths
    }
  );
}

async function findOptionalVisibleLocator(
  page: Page,
  candidates: SelectorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    if (await isLocatorVisible(locator)) {
      return { locator, key: candidate.key };
    }
  }

  return null;
}

async function resolveEditableText(locator: Locator): Promise<string> {
  const tagName = await locator
    .evaluate((node) => node.tagName.toLowerCase())
    .catch(() => "");

  if (tagName === "input" || tagName === "textarea") {
    return normalizeText(await locator.inputValue().catch(() => ""));
  }

  return normalizeText(await locator.innerText().catch(() => ""));
}

async function fillEditable(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  await locator.click({ timeout: 5_000 });
  await locator.fill(value, { timeout: 5_000 });
}

function createTextControlCandidates(
  keyPrefix: string,
  regex: RegExp
): SelectorCandidate[] {
  return [
    {
      key: `${keyPrefix}-button`,
      selectorHint: `button name ${regex}`,
      locatorFactory: (page) => page.getByRole("button", { name: regex })
    },
    {
      key: `${keyPrefix}-link`,
      selectorHint: `link name ${regex}`,
      locatorFactory: (page) => page.getByRole("link", { name: regex })
    },
    {
      key: `${keyPrefix}-generic-text`,
      selectorHint: `button/a/menuitem/option hasText ${regex}`,
      locatorFactory: (page) =>
        page
          .locator(
            "button, a, [role='button'], [role='menuitem'], [role='option']"
          )
          .filter({ hasText: regex })
    }
  ];
}

function createScopedTextControlCandidates(
  keyPrefix: string,
  regex: RegExp
): ScopedSelectorCandidate[] {
  return [
    {
      key: `${keyPrefix}-button`,
      selectorHint: `button name ${regex}`,
      locatorFactory: (root) => root.getByRole("button", { name: regex })
    },
    {
      key: `${keyPrefix}-generic-text`,
      selectorHint: `button/a/menuitem/option hasText ${regex}`,
      locatorFactory: (root) =>
        root
          .locator(
            "button, a, [role='button'], [role='menuitem'], [role='option']"
          )
          .filter({ hasText: regex })
    }
  ];
}

function createEditorTitleCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const titleRegex = buildLocalizedRegex(
    selectorLocale,
    ["Title", "Headline"],
    ["Titel", "Overskrift"]
  );

  return [
    {
      key: "editor-title-role-textbox",
      selectorHint: `textbox name ${titleRegex}`,
      locatorFactory: (page) => page.getByRole("textbox", { name: titleRegex })
    },
    {
      key: "editor-title-placeholder-input",
      selectorHint: "input/textarea placeholder or aria-label title/headline",
      locatorFactory: (page) =>
        page.locator(
          [
            "input[placeholder*='Title']",
            "input[placeholder*='title']",
            "input[placeholder*='Headline']",
            "input[placeholder*='headline']",
            "textarea[placeholder*='Title']",
            "textarea[placeholder*='title']",
            "textarea[placeholder*='Headline']",
            "textarea[placeholder*='headline']",
            "input[aria-label*='Title']",
            "input[aria-label*='title']",
            "input[aria-label*='Headline']",
            "input[aria-label*='headline']",
            "textarea[aria-label*='Title']",
            "textarea[aria-label*='title']",
            "textarea[aria-label*='Headline']",
            "textarea[aria-label*='headline']"
          ].join(", ")
        )
    },
    {
      key: "editor-title-contenteditable",
      selectorHint: "contenteditable title/headline",
      locatorFactory: (page) =>
        page.locator(
          [
            "h1[contenteditable='true']",
            "[contenteditable='true'][data-placeholder*='Title']",
            "[contenteditable='true'][data-placeholder*='title']",
            "[contenteditable='true'][data-placeholder*='Headline']",
            "[contenteditable='true'][data-placeholder*='headline']",
            "[contenteditable='true'][aria-label*='Title']",
            "[contenteditable='true'][aria-label*='title']",
            "[contenteditable='true'][aria-label*='Headline']",
            "[contenteditable='true'][aria-label*='headline']"
          ].join(", ")
        )
    }
  ];
}

function createEditorBodyCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const bodyRegex = buildLocalizedRegex(
    selectorLocale,
    ["Write here", "Tell your story", "Body", "Content"],
    ["Skriv her", "Fortæl din historie", "Brødtekst", "Indhold"]
  );

  return [
    {
      key: "editor-body-role-textbox",
      selectorHint: `textbox name ${bodyRegex}`,
      locatorFactory: (page) => page.getByRole("textbox", { name: bodyRegex })
    },
    {
      key: "editor-body-contenteditable-prompt",
      selectorHint: "contenteditable body prompt",
      locatorFactory: (page) =>
        page.locator(
          [
            "[contenteditable='true'][data-placeholder*='Write']",
            "[contenteditable='true'][data-placeholder*='write']",
            "[contenteditable='true'][data-placeholder*='story']",
            "[contenteditable='true'][data-placeholder*='Story']",
            "[contenteditable='true'][data-placeholder*='Body']",
            "[contenteditable='true'][data-placeholder*='body']",
            "[contenteditable='true'][data-placeholder*='Content']",
            "[contenteditable='true'][data-placeholder*='content']",
            "[contenteditable='true'][aria-label*='Write']",
            "[contenteditable='true'][aria-label*='write']",
            "[contenteditable='true'][aria-label*='Body']",
            "[contenteditable='true'][aria-label*='body']",
            "[contenteditable='true'][aria-label*='Content']",
            "[contenteditable='true'][aria-label*='content']"
          ].join(", ")
        )
    },
    {
      key: "editor-body-last-contenteditable",
      selectorHint: "last contenteditable element",
      locatorFactory: (page) =>
        page.locator("[role='textbox'][contenteditable='true'], [contenteditable='true']").last()
    }
  ];
}

function createDialogRootCandidates(): SelectorCandidate[] {
  return [
    {
      key: "dialog-role",
      selectorHint: "[role='dialog']",
      locatorFactory: (page) => page.locator("[role='dialog']")
    },
    {
      key: "dialog-element",
      selectorHint: "dialog element",
      locatorFactory: (page) => page.locator("dialog")
    },
    {
      key: "dialog-artdeco",
      selectorHint: ".artdeco-modal, .artdeco-modal__content",
      locatorFactory: (page) =>
        page.locator(".artdeco-modal, .artdeco-modal__content")
    }
  ];
}

function createDialogTextInputCandidates(
  keyPrefix: string,
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[] = english
): ScopedSelectorCandidate[] {
  const labelRegex = buildLocalizedRegex(selectorLocale, english, danish);
  const phrases =
    selectorLocale === "da" ? [...danish, ...english] : [...english, ...danish];
  const attributeSelectors = Array.from(
    new Set(
      phrases.flatMap((phrase) => {
        const variants = [phrase, phrase.toLowerCase()];
        return variants.flatMap((variant) => {
          const escapedValue = escapeCssAttributeValue(variant);
          return [
            `input[aria-label*="${escapedValue}"]`,
            `textarea[aria-label*="${escapedValue}"]`,
            `input[placeholder*="${escapedValue}"]`,
            `textarea[placeholder*="${escapedValue}"]`,
            `[contenteditable='true'][aria-label*="${escapedValue}"]`,
            `[contenteditable='true'][data-placeholder*="${escapedValue}"]`
          ];
        });
      })
    )
  ).join(", ");

  return [
    {
      key: `${keyPrefix}-textbox`,
      selectorHint: `textbox name ${labelRegex}`,
      locatorFactory: (root) => root.getByRole("textbox", { name: labelRegex })
    },
    {
      key: `${keyPrefix}-label`,
      selectorHint: `label ${labelRegex}`,
      locatorFactory: (root) => root.getByLabel(labelRegex)
    },
    {
      key: `${keyPrefix}-attribute`,
      selectorHint: `input/textarea/contenteditable placeholder or aria-label ${labelRegex}`,
      locatorFactory: (root) => root.locator(attributeSelectors)
    }
  ];
}

function createNewsletterFrequencyCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const frequencyRegex = buildLocalizedRegex(
    selectorLocale,
    ["Frequency", "Cadence"],
    ["Hyppighed", "Kadence"]
  );

  return [
    {
      key: "newsletter-frequency-combobox",
      selectorHint: `combobox name ${frequencyRegex}`,
      locatorFactory: (root) => root.getByRole("combobox", { name: frequencyRegex })
    },
    {
      key: "newsletter-frequency-select",
      selectorHint: "select[aria-label*=Frequency/Cadence]",
      locatorFactory: (root) =>
        root.locator(
          [
            "select[aria-label*='Frequency']",
            "select[aria-label*='frequency']",
            "select[aria-label*='Cadence']",
            "select[aria-label*='cadence']"
          ].join(", ")
        )
    },
    {
      key: "newsletter-frequency-any-select",
      selectorHint: "select, [role='combobox']",
      locatorFactory: (root) => root.locator("select, [role='combobox']")
    }
  ];
}

function createWriteArticleTriggerCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Write article", "Write an article"],
    ["Skriv artikel", "Skriv en artikel"]
  );

  return createTextControlCandidates("write-article", regex);
}

function createManageCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Manage"],
    ["Administrer"]
  );

  return createTextControlCandidates("manage", regex);
}

function createCreateNewsletterCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Create a newsletter", "Create newsletter"],
    ["Opret et nyhedsbrev"]
  );

  return createTextControlCandidates("create-newsletter", regex);
}

function createNextCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(selectorLocale, ["Next"], ["Næste"]);
  return createTextControlCandidates("next", regex);
}

function createPublishCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Publish"],
    ["Udgiv", "Publicer"]
  );

  return createTextControlCandidates("publish", regex);
}

function createScopedPublishCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Publish"],
    ["Udgiv", "Publicer"]
  );

  return createScopedTextControlCandidates("publish", regex);
}

function createDoneCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Done"],
    ["Færdig", "Udført"]
  );

  return createScopedTextControlCandidates("done", regex);
}

function createPublishTargetCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const regex = buildLocalizedRegex(
    selectorLocale,
    ["Individual article", "Newsletter", "Article"],
    ["Individuel artikel", "Nyhedsbrev", "Artikel"]
  );

  return [
    {
      key: "publish-target-header-button",
      selectorHint: `header button hasText ${regex}`,
      locatorFactory: (page) =>
        page
          .locator("header button, header [role='button']")
          .filter({ hasText: regex })
    },
    {
      key: "publish-target-generic-button",
      selectorHint: `button hasText ${regex}`,
      locatorFactory: (page) =>
        page.locator("button, [role='button']").filter({ hasText: regex })
    }
  ];
}

function createNewsletterOptionCandidates(
  selectorLocale: LinkedInSelectorLocale,
  title: string
): SelectorCandidate[] {
  const exactRegex = buildLocalizedRegex(selectorLocale, [title], [title], {
    exact: true
  });

  return [
    {
      key: "newsletter-option-role-option",
      selectorHint: `option/menuitem/button name ${exactRegex}`,
      locatorFactory: (page) =>
        page.locator("[role='option'], [role='menuitem'], button, a").filter({
          hasText: exactRegex
        })
    }
  ];
}

async function waitForPublishingEditor(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[],
  triggerKey: string
): Promise<EditorSurface> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await waitForNetworkIdleBestEffort(page, 10_000);

  const title = await findVisibleLocatorOrThrow(
    page,
    createEditorTitleCandidates(selectorLocale),
    "article_editor_title",
    artifactPaths
  );
  const body = await findVisibleLocatorOrThrow(
    page,
    createEditorBodyCandidates(selectorLocale),
    "article_editor_body",
    artifactPaths
  );

  return {
    page,
    titleKey: title.key,
    bodyKey: body.key,
    triggerKey
  };
}

async function openPublishingEditor(
  context: BrowserContext,
  basePage: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<EditorSurface> {
  await basePage.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(basePage, 10_000);

  const trigger = await findVisibleLocatorOrThrow(
    basePage,
    createWriteArticleTriggerCandidates(selectorLocale),
    "write_article_trigger",
    artifactPaths
  );
  const popupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);

  await trigger.locator.click({ timeout: 5_000 });

  const popupPage = await popupPromise;
  const editorPage = popupPage ?? basePage;

  if (popupPage) {
    await popupPage.waitForLoadState("domcontentloaded").catch(() => undefined);
  }

  return waitForPublishingEditor(
    editorPage,
    selectorLocale,
    artifactPaths,
    trigger.key
  );
}

async function fillDraftTitleAndBody(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  title: string,
  body: string,
  artifactPaths: string[]
): Promise<{ titleKey: string; bodyKey: string }> {
  const titleLocator = await findVisibleLocatorOrThrow(
    page,
    createEditorTitleCandidates(selectorLocale),
    "article_editor_title",
    artifactPaths
  );
  const bodyLocator = await findVisibleLocatorOrThrow(
    page,
    createEditorBodyCandidates(selectorLocale),
    "article_editor_body",
    artifactPaths
  );

  await fillEditable(titleLocator.locator, title);
  await fillEditable(bodyLocator.locator, body);

  return {
    titleKey: titleLocator.key,
    bodyKey: bodyLocator.key
  };
}

async function openManageMenu(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  const manageButton = await findVisibleLocatorOrThrow(
    page,
    createManageCandidates(selectorLocale),
    "publishing_manage_button",
    artifactPaths
  );
  await manageButton.locator.click({ timeout: 5_000 });
  return manageButton;
}

async function openNewsletterCreateDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<{ dialog: Locator; manageKey: string; createKey: string }> {
  const manageButton = await openManageMenu(page, selectorLocale, artifactPaths);
  const createAction = await findVisibleLocatorOrThrow(
    page,
    createCreateNewsletterCandidates(selectorLocale),
    "create_newsletter_action",
    artifactPaths
  );
  await createAction.locator.click({ timeout: 5_000 });

  const dialog = await findVisibleLocatorOrThrow(
    page,
    createDialogRootCandidates(),
    "newsletter_create_dialog",
    artifactPaths
  );

  return {
    dialog: dialog.locator,
    manageKey: manageButton.key,
    createKey: createAction.key
  };
}

async function fillNewsletterCreateDialog(
  page: Page,
  dialog: Locator,
  selectorLocale: LinkedInSelectorLocale,
  title: string,
  description: string,
  cadence: LinkedInNewsletterCadence,
  artifactPaths: string[]
): Promise<{
  titleKey: string;
  descriptionKey: string;
  cadenceKey: string;
  doneKey: string;
}> {
  const titleField = await findVisibleScopedLocatorOrThrow(
    dialog,
    createDialogTextInputCandidates(
      "newsletter-title",
      selectorLocale,
      ["Title", "Name"],
      ["Titel", "Navn"]
    ),
    "newsletter_dialog_title",
    artifactPaths,
    page.url()
  );
  await fillEditable(titleField.locator, title);

  const descriptionField = await findVisibleScopedLocatorOrThrow(
    dialog,
    createDialogTextInputCandidates(
      "newsletter-description",
      selectorLocale,
      ["Description"],
      ["Beskrivelse"]
    ),
    "newsletter_dialog_description",
    artifactPaths,
    page.url()
  );
  await fillEditable(descriptionField.locator, description);

  const cadenceField = await findVisibleScopedLocatorOrThrow(
    dialog,
    createNewsletterFrequencyCandidates(selectorLocale),
    "newsletter_dialog_frequency",
    artifactPaths,
    page.url()
  );
  const cadenceLabel = LINKEDIN_NEWSLETTER_CADENCE_LABELS[cadence].label;
  const cadenceTagName = await cadenceField.locator
    .evaluate((node) => node.tagName.toLowerCase())
    .catch(() => "");

  if (cadenceTagName === "select") {
    await cadenceField.locator.selectOption({ label: cadenceLabel });
  } else {
    await cadenceField.locator.click({ timeout: 5_000 });
    const cadenceOption = await findVisibleLocatorOrThrow(
      page,
      createTextControlCandidates(
        "newsletter-frequency-option",
        buildLocalizedRegex(selectorLocale, [cadenceLabel], [cadenceLabel], {
          exact: true
        })
      ),
      "newsletter_frequency_option",
      artifactPaths
    );
    await cadenceOption.locator.click({ timeout: 5_000 });
  }

  const doneButton = await findVisibleScopedLocatorOrThrow(
    dialog,
    createDoneCandidates(selectorLocale),
    "newsletter_dialog_done",
    artifactPaths,
    page.url()
  );
  await doneButton.locator.click({ timeout: 5_000 });
  await waitForCondition(async () => !(await isLocatorVisible(dialog)), 10_000);

  return {
    titleKey: titleField.key,
    descriptionKey: descriptionField.key,
    cadenceKey: cadenceField.key,
    doneKey: doneButton.key
  };
}

async function openPublishTargetMenu(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string; currentLabel: string }> {
  const dropdown = await findVisibleLocatorOrThrow(
    page,
    createPublishTargetCandidates(selectorLocale),
    "publish_target_dropdown",
    artifactPaths
  );
  const currentLabel = normalizeText(await dropdown.locator.innerText().catch(() => ""));
  await dropdown.locator.click({ timeout: 5_000 });
  return {
    locator: dropdown.locator,
    key: dropdown.key,
    currentLabel
  };
}

async function selectNewsletterTarget(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  newsletterTitle: string,
  artifactPaths: string[]
): Promise<{ dropdownKey: string; optionKey: string | null }> {
  const dropdown = await openPublishTargetMenu(page, selectorLocale, artifactPaths);
  if (normalizeText(dropdown.currentLabel) === newsletterTitle) {
    await page.keyboard.press("Escape").catch(() => undefined);
    return {
      dropdownKey: dropdown.key,
      optionKey: null
    };
  }

  const option = await findVisibleLocatorOrThrow(
    page,
    createNewsletterOptionCandidates(selectorLocale, newsletterTitle),
    "newsletter_target_option",
    artifactPaths
  );
  await option.locator.click({ timeout: 5_000 });
  await waitForNetworkIdleBestEffort(page, 5_000);

  return {
    dropdownKey: dropdown.key,
    optionKey: option.key
  };
}

function normalizeNewsletterMenuTitle(value: string): string | null {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return null;
  }

  if (/^individual article$/iu.test(normalizedValue)) {
    return null;
  }

  if (/^create (a )?newsletter$/iu.test(normalizedValue)) {
    return null;
  }

  if (/^manage$/iu.test(normalizedValue)) {
    return null;
  }

  if (/^publish$/iu.test(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

async function extractVisibleNewsletterTitles(
  page: Page,
  selectedLabel: string
): Promise<LinkedInNewsletterSummary[]> {
  const rawTexts = await page
    .locator(
      [
        "[role='menu'] [role='menuitem']",
        "[role='listbox'] [role='option']",
        ".artdeco-dropdown__content button",
        ".artdeco-dropdown__content a",
        ".artdeco-popover__content button",
        ".artdeco-popover__content a"
      ].join(", ")
    )
    .allInnerTexts()
    .catch(() => []);

  const seen = new Set<string>();
  const newsletters: LinkedInNewsletterSummary[] = [];

  for (const rawText of rawTexts) {
    const title = normalizeNewsletterMenuTitle(rawText);
    if (!title || seen.has(title.toLowerCase())) {
      continue;
    }

    seen.add(title.toLowerCase());
    newsletters.push({
      title,
      selected: normalizeText(selectedLabel) === title
    });
  }

  return newsletters;
}

async function publishCurrentLongFormDraft(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<{
  nextKey: string | null;
  publishKey: string;
  publishedUrl: string;
}> {
  const nextButton = await findOptionalVisibleLocator(
    page,
    createNextCandidates(selectorLocale)
  );

  if (nextButton) {
    await nextButton.locator.click({ timeout: 5_000 });
    await waitForNetworkIdleBestEffort(page, 5_000);
  }

  const dialog = await findOptionalVisibleLocator(page, createDialogRootCandidates());
  const publishButton = dialog
    ? await findVisibleScopedLocatorOrThrow(
        dialog.locator,
        createScopedPublishCandidates(selectorLocale),
        "publish_dialog_button",
        artifactPaths,
        page.url()
      )
    : await findVisibleLocatorOrThrow(
        page,
        createPublishCandidates(selectorLocale),
        "publish_button",
        artifactPaths
      );

  await publishButton.locator.click({ timeout: 5_000 });
  await waitForNetworkIdleBestEffort(page, 10_000);

  const published = await waitForCondition(async () => {
    const currentUrl = page.url();
    return currentUrl.length > 0 && !isDraftEditUrl(currentUrl);
  }, 20_000);

  if (!published) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "LinkedIn did not navigate away from the draft editor after publish.",
      {
        current_url: page.url(),
        artifact_paths: artifactPaths
      }
    );
  }

  return {
    nextKey: nextButton?.key ?? null,
    publishKey: publishButton.key,
    publishedUrl: resolvePublishedUrl(page.url())
  };
}

async function pauseForAutosave(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1_500);
  });
}

export class LinkedInArticlesService {
  constructor(private readonly runtime: LinkedInPublishingRuntime) {}

  async prepareCreate(
    input: PrepareCreateArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const title = requireSingleLineText(input.title, "Article title", { maxLength: ARTICLE_TITLE_MAX_LENGTH });
    const body = requireLongFormText(input.body, "Article body", { maxLength: ARTICLE_BODY_MAX_LENGTH });
    const tracePath = `linkedin/trace-article-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const prepared = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          let currentPage = await getOrCreatePage(context);
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            const editor = await openPublishingEditor(
              context,
              currentPage,
              this.runtime.selectorLocale,
              artifactPaths
            );
            currentPage = editor.page;

            const screenshotPath = `linkedin/screenshot-article-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, currentPage, screenshotPath, {
              action: "prepare_create_article",
              profile_name: profileName,
              trigger_selector_key: editor.triggerKey,
              title_selector_key: editor.titleKey,
              body_selector_key: editor.bodyKey
            });
            artifactPaths.push(screenshotPath);

            const target = {
              profile_name: profileName,
              compose_url: LINKEDIN_FEED_URL,
              content_type: "article"
            };
            const preview = {
              summary: `Create LinkedIn article draft "${title}"`,
              target,
              outbound: {
                title,
                body
              },
              validation: {
                title_length: title.length,
                body_length: body.length,
                body_paragraph_count: body.split(/\n{2,}/u).length
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              }))
            } satisfies Record<string, unknown>;

            return preparePublishingAction(this.runtime, {
              actionType: CREATE_ARTICLE_ACTION_TYPE,
              target,
              payload: {
                title,
                body
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-article-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                currentPage,
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

            throw toAutomationError(error, "Failed to prepare LinkedIn article creation.", {
              profile_name: profileName,
              current_url: currentPage.url(),
              artifact_paths: artifactPaths
            });
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_article",
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log("warn", "linkedin.article.prepare.trace.stop_failed", {
                  profile_name: profileName,
                  message: error instanceof Error ? error.message : String(error)
                });
              }
            }
          }
        }
      );

      return prepared;
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn article creation.", {
        profile_name: profileName,
        artifact_paths: artifactPaths
      });
    }
  }

  async preparePublish(
    input: PreparePublishArticleInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const draftUrl = normalizeLinkedInUrl(input.draftUrl, "draftUrl");
    const tracePath = `linkedin/trace-article-publish-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const prepared = await this.runtime.profileManager.runWithContext(
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

            await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page, 10_000);

            const title = await findVisibleLocatorOrThrow(
              page,
              createEditorTitleCandidates(this.runtime.selectorLocale),
              "article_editor_title",
              artifactPaths
            );
            const body = await findVisibleLocatorOrThrow(
              page,
              createEditorBodyCandidates(this.runtime.selectorLocale),
              "article_editor_body",
              artifactPaths
            );
            const publishButton = await findOptionalVisibleLocator(
              page,
              createPublishCandidates(this.runtime.selectorLocale)
            );
            const nextButton = await findOptionalVisibleLocator(
              page,
              createNextCandidates(this.runtime.selectorLocale)
            );

            const currentTitle = await resolveEditableText(title.locator);
            const screenshotPath = `linkedin/screenshot-article-publish-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_publish_article",
              profile_name: profileName,
              draft_url: draftUrl,
              title_selector_key: title.key,
              body_selector_key: body.key,
              publish_selector_key: publishButton?.key ?? null,
              next_selector_key: nextButton?.key ?? null
            });
            artifactPaths.push(screenshotPath);

            const target = {
              profile_name: profileName,
              draft_url: draftUrl,
              content_type: "article"
            };
            const preview = {
              summary: `Publish LinkedIn article draft${currentTitle ? ` "${currentTitle}"` : ""}`,
              target,
              current_state: {
                title: currentTitle || null,
                editor_url: page.url()
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              }))
            } satisfies Record<string, unknown>;

            return preparePublishingAction(this.runtime, {
              actionType: PUBLISH_ARTICLE_ACTION_TYPE,
              target,
              payload: {
                draft_url: draftUrl
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-article-publish-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_publish_article_error",
                profile_name: profileName,
                draft_url: draftUrl
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(error, "Failed to prepare LinkedIn article publish.", {
              profile_name: profileName,
              current_url: page.url(),
              draft_url: draftUrl,
              artifact_paths: artifactPaths
            });
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_publish_article",
                  profile_name: profileName,
                  draft_url: draftUrl
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.article.prepare_publish.trace.stop_failed",
                  {
                    profile_name: profileName,
                    message: error instanceof Error ? error.message : String(error)
                  }
                );
              }
            }
          }
        }
      );

      return prepared;
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn article publish.", {
        profile_name: profileName,
        draft_url: draftUrl,
        artifact_paths: artifactPaths
      });
    }
  }
}

export class LinkedInNewslettersService {
  constructor(private readonly runtime: LinkedInPublishingRuntime) {}

  async prepareCreate(
    input: PrepareCreateNewsletterInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const title = requireSingleLineText(input.title, "Newsletter title", { maxLength: NEWSLETTER_TITLE_MAX_LENGTH });
    const description = requireSingleLineText(
      input.description,
      "Newsletter description",
      { maxLength: NEWSLETTER_DESCRIPTION_MAX_LENGTH }
    );
    const cadence = normalizeNewsletterCadence(input.cadence);
    const tracePath = `linkedin/trace-newsletter-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const prepared = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          let currentPage = await getOrCreatePage(context);
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            const editor = await openPublishingEditor(
              context,
              currentPage,
              this.runtime.selectorLocale,
              artifactPaths
            );
            currentPage = editor.page;

            const dialogState = await openNewsletterCreateDialog(
              currentPage,
              this.runtime.selectorLocale,
              artifactPaths
            );

            const screenshotPath = `linkedin/screenshot-newsletter-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, currentPage, screenshotPath, {
              action: "prepare_create_newsletter",
              profile_name: profileName,
              trigger_selector_key: editor.triggerKey,
              manage_selector_key: dialogState.manageKey,
              create_selector_key: dialogState.createKey
            });
            artifactPaths.push(screenshotPath);

            const target = {
              profile_name: profileName,
              compose_url: LINKEDIN_FEED_URL,
              content_type: "newsletter"
            };
            const preview = {
              summary: `Create LinkedIn newsletter "${title}"`,
              target,
              outbound: {
                title,
                description,
                cadence
              },
              validation: {
                title_length: title.length,
                description_length: description.length,
                cadence_label: LINKEDIN_NEWSLETTER_CADENCE_LABELS[cadence].label
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              }))
            } satisfies Record<string, unknown>;

            return preparePublishingAction(this.runtime, {
              actionType: CREATE_NEWSLETTER_ACTION_TYPE,
              target,
              payload: {
                title,
                description,
                cadence
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-newsletter-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                currentPage,
                failureScreenshot,
                {
                  action: "prepare_create_newsletter_error",
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
                profile_name: profileName,
                current_url: currentPage.url(),
                artifact_paths: artifactPaths
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_newsletter",
                  profile_name: profileName
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.newsletter.prepare.trace.stop_failed",
                  {
                    profile_name: profileName,
                    message: error instanceof Error ? error.message : String(error)
                  }
                );
              }
            }
          }
        }
      );

      return prepared;
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
  }

  async preparePublishIssue(
    input: PreparePublishNewsletterIssueInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const newsletter = requireSingleLineText(input.newsletter, "newsletter");
    const title = requireSingleLineText(input.title, "Issue title", { maxLength: NEWSLETTER_ISSUE_TITLE_MAX_LENGTH });
    const body = requireLongFormText(input.body, "Issue body", { maxLength: NEWSLETTER_ISSUE_BODY_MAX_LENGTH });
    const tracePath = `linkedin/trace-newsletter-issue-prepare-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const prepared = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          let currentPage = await getOrCreatePage(context);
          let tracingStarted = false;

          try {
            await context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true
            });
            tracingStarted = true;

            const editor = await openPublishingEditor(
              context,
              currentPage,
              this.runtime.selectorLocale,
              artifactPaths
            );
            currentPage = editor.page;

            const dropdown = await openPublishTargetMenu(
              currentPage,
              this.runtime.selectorLocale,
              artifactPaths
            );
            if (normalizeText(dropdown.currentLabel) !== newsletter) {
              await findVisibleLocatorOrThrow(
                currentPage,
                createNewsletterOptionCandidates(this.runtime.selectorLocale, newsletter),
                "newsletter_target_option",
                artifactPaths
              );
            }
            await currentPage.keyboard.press("Escape").catch(() => undefined);

            const screenshotPath =
              `linkedin/screenshot-newsletter-issue-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, currentPage, screenshotPath, {
              action: "prepare_publish_newsletter_issue",
              profile_name: profileName,
              newsletter_title: newsletter,
              trigger_selector_key: editor.triggerKey,
              dropdown_selector_key: dropdown.key
            });
            artifactPaths.push(screenshotPath);

            const target = {
              profile_name: profileName,
              newsletter_title: newsletter,
              compose_url: LINKEDIN_FEED_URL,
              content_type: "newsletter_issue"
            };
            const preview = {
              summary: `Publish LinkedIn newsletter issue "${title}" in ${newsletter}`,
              target,
              outbound: {
                title,
                body
              },
              validation: {
                title_length: title.length,
                body_length: body.length,
                body_paragraph_count: body.split(/\n{2,}/u).length
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              }))
            } satisfies Record<string, unknown>;

            return preparePublishingAction(this.runtime, {
              actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
              target,
              payload: {
                newsletter_title: newsletter,
                title,
                body
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot =
              `linkedin/screenshot-newsletter-issue-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(
                this.runtime,
                currentPage,
                failureScreenshot,
                {
                  action: "prepare_publish_newsletter_issue_error",
                  profile_name: profileName,
                  newsletter_title: newsletter
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
                profile_name: profileName,
                current_url: currentPage.url(),
                newsletter_title: newsletter,
                artifact_paths: artifactPaths
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_publish_newsletter_issue",
                  profile_name: profileName,
                  newsletter_title: newsletter
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.newsletter.prepare_issue.trace.stop_failed",
                  {
                    profile_name: profileName,
                    message: error instanceof Error ? error.message : String(error)
                  }
                );
              }
            }
          }
        }
      );

      return prepared;
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn newsletter issue publish.",
        {
          profile_name: profileName,
          newsletter_title: newsletter,
          artifact_paths: artifactPaths
        }
      );
    }
  }

  async list(input: ListNewslettersInput = {}): Promise<ListNewslettersOutput> {
    const profileName = input.profileName ?? "default";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    return this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        const editor = await openPublishingEditor(
          context,
          page,
          this.runtime.selectorLocale,
          []
        );
        const dropdown = await openPublishTargetMenu(
          editor.page,
          this.runtime.selectorLocale,
          []
        );
        const newsletters = await extractVisibleNewsletterTitles(
          editor.page,
          dropdown.currentLabel
        );

        await editor.page.keyboard.press("Escape").catch(() => undefined);

        return {
          count: newsletters.length,
          newsletters
        };
      }
    );
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
    const tracePath = `linkedin/trace-article-confirm-${Date.now()}.zip`;
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
        let currentPage = await getOrCreatePage(context);
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          enforcePublishingRateLimit({
            runtime,
            actionType: CREATE_ARTICLE_ACTION_TYPE,
            actionId: action.id,
            profileName,
            details: {
              title
            }
          });

          const editor = await openPublishingEditor(
            context,
            currentPage,
            runtime.selectorLocale,
            artifactPaths
          );
          currentPage = editor.page;
          const fields = await fillDraftTitleAndBody(
            currentPage,
            runtime.selectorLocale,
            title,
            body,
            artifactPaths
          );
          await waitForNetworkIdleBestEffort(currentPage, 5_000);
          await pauseForAutosave();

          const draftUrl = normalizeLinkedInUrl(
            isEditorUrl(currentPage.url()) ? currentPage.url() : resolvePublishedUrl(currentPage.url()),
            "Draft URL"
          );
          const screenshotPath = `linkedin/screenshot-article-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, currentPage, screenshotPath, {
            action: CREATE_ARTICLE_ACTION_TYPE,
            profile_name: profileName,
            draft_url: draftUrl,
            trigger_selector_key: editor.triggerKey,
            title_selector_key: fields.titleKey,
            body_selector_key: fields.bodyKey
          });
          artifactPaths.push(screenshotPath);

          return {
            ok: true,
            result: {
              draft_created: true,
              draft_url: draftUrl,
              title,
              verification_snippet: createVerificationSnippet(body)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-article-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, currentPage, failureScreenshot, {
              action: `${CREATE_ARTICLE_ACTION_TYPE}_error`,
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to execute LinkedIn article creation.", {
            action_id: action.id,
            profile_name: profileName,
            current_url: currentPage.url(),
            artifact_paths: artifactPaths
          });
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: CREATE_ARTICLE_ACTION_TYPE,
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.article.confirm.trace.stop_failed", {
                action_id: action.id,
                message: error instanceof Error ? error.message : String(error)
              });
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
    const draftUrl = normalizeLinkedInUrl(
      getRequiredStringField(action.payload, "draft_url", action.id, "payload"),
      "draft_url"
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

          enforcePublishingRateLimit({
            runtime,
            actionType: PUBLISH_ARTICLE_ACTION_TYPE,
            actionId: action.id,
            profileName,
            details: {
              draft_url: draftUrl
            }
          });

          await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page, 10_000);

          const publishState = await publishCurrentLongFormDraft(
            page,
            runtime.selectorLocale,
            artifactPaths
          );
          const screenshotPath = `linkedin/screenshot-article-publish-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, screenshotPath, {
            action: PUBLISH_ARTICLE_ACTION_TYPE,
            profile_name: profileName,
            draft_url: draftUrl,
            next_selector_key: publishState.nextKey,
            publish_selector_key: publishState.publishKey,
            article_url: publishState.publishedUrl
          });
          artifactPaths.push(screenshotPath);

          return {
            ok: true,
            result: {
              published: true,
              draft_url: draftUrl,
              article_url: publishState.publishedUrl
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-article-publish-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${PUBLISH_ARTICLE_ACTION_TYPE}_error`,
              profile_name: profileName,
              draft_url: draftUrl
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to publish LinkedIn article.", {
            action_id: action.id,
            profile_name: profileName,
            current_url: page.url(),
            draft_url: draftUrl,
            artifact_paths: artifactPaths
          });
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: PUBLISH_ARTICLE_ACTION_TYPE,
                profile_name: profileName,
                draft_url: draftUrl
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.article.confirm_publish.trace.stop_failed",
                {
                  action_id: action.id,
                  message: error instanceof Error ? error.message : String(error)
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
    const cadence = normalizeNewsletterCadence(
      getRequiredStringField(action.payload, "cadence", action.id, "payload")
    );
    const tracePath = `linkedin/trace-newsletter-confirm-${Date.now()}.zip`;
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
        let currentPage = await getOrCreatePage(context);
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          enforcePublishingRateLimit({
            runtime,
            actionType: CREATE_NEWSLETTER_ACTION_TYPE,
            actionId: action.id,
            profileName,
            details: {
              title
            }
          });

          const editor = await openPublishingEditor(
            context,
            currentPage,
            runtime.selectorLocale,
            artifactPaths
          );
          currentPage = editor.page;
          const dialogState = await openNewsletterCreateDialog(
            currentPage,
            runtime.selectorLocale,
            artifactPaths
          );
          const dialogResult = await fillNewsletterCreateDialog(
            currentPage,
            dialogState.dialog,
            runtime.selectorLocale,
            title,
            description,
            cadence,
            artifactPaths
          );
          await waitForNetworkIdleBestEffort(currentPage, 5_000);
          await pauseForAutosave();

          const editorUrl = normalizeLinkedInUrl(currentPage.url(), "Editor URL");
          const screenshotPath = `linkedin/screenshot-newsletter-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, currentPage, screenshotPath, {
            action: CREATE_NEWSLETTER_ACTION_TYPE,
            profile_name: profileName,
            editor_url: editorUrl,
            trigger_selector_key: editor.triggerKey,
            manage_selector_key: dialogState.manageKey,
            create_selector_key: dialogState.createKey,
            title_selector_key: dialogResult.titleKey,
            description_selector_key: dialogResult.descriptionKey,
            cadence_selector_key: dialogResult.cadenceKey,
            done_selector_key: dialogResult.doneKey
          });
          artifactPaths.push(screenshotPath);

          return {
            ok: true,
            result: {
              newsletter_created: true,
              newsletter_title: title,
              cadence,
              editor_url: editorUrl
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-newsletter-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, currentPage, failureScreenshot, {
              action: `${CREATE_NEWSLETTER_ACTION_TYPE}_error`,
              profile_name: profileName
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to create LinkedIn newsletter.", {
            action_id: action.id,
            profile_name: profileName,
            current_url: currentPage.url(),
            artifact_paths: artifactPaths
          });
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: CREATE_NEWSLETTER_ACTION_TYPE,
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.newsletter.confirm.trace.stop_failed",
                {
                  action_id: action.id,
                  message: error instanceof Error ? error.message : String(error)
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
    const newsletterTitle = getRequiredStringField(
      action.payload,
      "newsletter_title",
      action.id,
      "payload"
    );
    const title = getRequiredStringField(action.payload, "title", action.id, "payload");
    const body = getRequiredStringField(action.payload, "body", action.id, "payload");
    const tracePath = `linkedin/trace-newsletter-issue-confirm-${Date.now()}.zip`;
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
        let currentPage = await getOrCreatePage(context);
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          enforcePublishingRateLimit({
            runtime,
            actionType: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
            actionId: action.id,
            profileName,
            details: {
              newsletter_title: newsletterTitle,
              title
            }
          });

          const editor = await openPublishingEditor(
            context,
            currentPage,
            runtime.selectorLocale,
            artifactPaths
          );
          currentPage = editor.page;

          const selection = await selectNewsletterTarget(
            currentPage,
            runtime.selectorLocale,
            newsletterTitle,
            artifactPaths
          );
          const fields = await fillDraftTitleAndBody(
            currentPage,
            runtime.selectorLocale,
            title,
            body,
            artifactPaths
          );
          await waitForNetworkIdleBestEffort(currentPage, 5_000);
          await pauseForAutosave();

          const publishState = await publishCurrentLongFormDraft(
            currentPage,
            runtime.selectorLocale,
            artifactPaths
          );
          const screenshotPath =
            `linkedin/screenshot-newsletter-issue-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, currentPage, screenshotPath, {
            action: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
            profile_name: profileName,
            newsletter_title: newsletterTitle,
            title_selector_key: fields.titleKey,
            body_selector_key: fields.bodyKey,
            trigger_selector_key: editor.triggerKey,
            dropdown_selector_key: selection.dropdownKey,
            option_selector_key: selection.optionKey,
            next_selector_key: publishState.nextKey,
            publish_selector_key: publishState.publishKey,
            issue_url: publishState.publishedUrl
          });
          artifactPaths.push(screenshotPath);

          return {
            ok: true,
            result: {
              published: true,
              newsletter_title: newsletterTitle,
              issue_url: publishState.publishedUrl,
              verification_snippet: createVerificationSnippet(body)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot =
            `linkedin/screenshot-newsletter-issue-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, currentPage, failureScreenshot, {
              action: `${PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE}_error`,
              profile_name: profileName,
              newsletter_title: newsletterTitle
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(
            error,
            "Failed to publish LinkedIn newsletter issue.",
            {
              action_id: action.id,
              profile_name: profileName,
              current_url: currentPage.url(),
              newsletter_title: newsletterTitle,
              artifact_paths: artifactPaths
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,
                profile_name: profileName,
                newsletter_title: newsletterTitle
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.newsletter.confirm_issue.trace.stop_failed",
                {
                  action_id: action.id,
                  message: error instanceof Error ? error.message : String(error)
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
