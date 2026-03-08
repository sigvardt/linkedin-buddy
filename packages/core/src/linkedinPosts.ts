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

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";

export const CREATE_POST_ACTION_TYPE = "post.create";
export const LINKEDIN_POST_MAX_LENGTH = 3000;

export const LINKEDIN_POST_VISIBILITY_TYPES = [
  "public",
  "connections"
] as const;

export type LinkedInPostVisibility =
  (typeof LINKEDIN_POST_VISIBILITY_TYPES)[number];

interface LinkedInPostVisibilityUiConfig {
  label: string;
  audienceLabel: string;
}

export const LINKEDIN_POST_VISIBILITY_MAP: Record<
  LinkedInPostVisibility,
  LinkedInPostVisibilityUiConfig
> = {
  public: {
    label: "Public",
    audienceLabel: "Anyone"
  },
  connections: {
    label: "Connections",
    audienceLabel: "Connections only"
  }
};

const LINKEDIN_POST_VISIBILITY_ALIAS_MAP: Record<string, LinkedInPostVisibility> = {
  public: "public",
  anyone: "public",
  everyone: "public",
  connections: "connections",
  connection: "connections",
  connections_only: "connections"
};

const CREATE_POST_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.post.create",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 1
} as const;

export interface PrepareCreatePostInput {
  profileName?: string;
  text: string;
  visibility?: LinkedInPostVisibility | string;
  operatorNote?: string;
}

export interface LinkedInPostsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
}

export interface LinkedInPostsRuntime extends LinkedInPostsExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInPostsExecutorRuntime>,
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

interface ValidatedPostText {
  normalizedText: string;
  characterCount: number;
  lineCount: number;
  paragraphCount: number;
  containsUrl: boolean;
  containsMention: boolean;
  containsHashtag: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePostText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trim();
}

function countParagraphs(value: string): number {
  return value
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0).length;
}

function hasUnsupportedControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      return true;
    }
  }

  return false;
}

export function validateLinkedInPostText(value: string): ValidatedPostText {
  const normalizedText = normalizePostText(value);

  if (!normalizedText) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Post text must not be empty."
    );
  }

  if (hasUnsupportedControlCharacters(normalizedText)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Post text contains unsupported control characters."
    );
  }

  const characterCount = normalizedText.length;
  if (characterCount > LINKEDIN_POST_MAX_LENGTH) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Post text must be ${LINKEDIN_POST_MAX_LENGTH} characters or fewer.`,
      {
        character_count: characterCount,
        max_length: LINKEDIN_POST_MAX_LENGTH
      }
    );
  }

  const lines = normalizedText.split("\n");

  return {
    normalizedText,
    characterCount,
    lineCount: lines.length,
    paragraphCount: countParagraphs(normalizedText),
    containsUrl: /(https?:\/\/|www\.)/i.test(normalizedText),
    containsMention: /(^|\s)@[\p{L}\p{N}_.-]+/iu.test(normalizedText),
    containsHashtag: /(^|\s)#[\p{L}\p{N}_-]+/iu.test(normalizedText)
  };
}

function normalizeVisibilityKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeLinkedInPostVisibility(
  value: string | undefined,
  fallback: LinkedInPostVisibility = "public"
): LinkedInPostVisibility {
  if (!value || normalizeText(value).length === 0) {
    return fallback;
  }

  const mapped = LINKEDIN_POST_VISIBILITY_ALIAS_MAP[normalizeVisibilityKey(value)];
  if (mapped) {
    return mapped;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `visibility must be one of: ${LINKEDIN_POST_VISIBILITY_TYPES.join(", ")}.`,
    {
      provided_visibility: value,
      supported_visibilities: LINKEDIN_POST_VISIBILITY_TYPES
    }
  );
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
    counter_key: state.counterKey,
    window_start_ms: state.windowStartMs,
    window_size_ms: state.windowSizeMs,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    allowed: state.allowed
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createVerificationSnippet(text: string): string {
  return normalizeText(text).slice(0, 120);
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function captureScreenshotArtifact(
  runtime: LinkedInPostsExecutorRuntime,
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
  runtime: LinkedInPostsExecutorRuntime,
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
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return false;
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function isAnyLocatorVisible(locator: Locator): Promise<boolean> {
  const count = Math.min(await locator.count().catch(() => 0), 4);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
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
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
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
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
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

async function findOptionalScopedLocator(
  root: Locator,
  candidates: ScopedSelectorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await isLocatorVisible(locator)) {
      return { locator, key: candidate.key };
    }
  }

  return null;
}

async function waitForFeedSurface(page: Page): Promise<void> {
  const candidates = [
    page.locator(".share-box-feed-entry").first(),
    page.getByRole("button", { name: /start a post/i }).first(),
    page.locator(".feed-shared-update-v2, .occludable-update, main").first(),
    page.locator("main").first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 6_000 });
      return;
    } catch {
      // Try next candidate.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn feed surface.",
    {
      current_url: page.url()
    }
  );
}

function createComposeTriggerCandidates(): SelectorCandidate[] {
  return [
    {
      key: "role-button-start-post",
      selectorHint: "getByRole(button, /start a post/i)",
      locatorFactory: (page) => page.getByRole("button", { name: /start a post/i })
    },
    {
      key: "aria-start-post",
      selectorHint: "button[aria-label*='Start a post' i]",
      locatorFactory: (page) =>
        page.locator(
          "button[aria-label*='start a post' i], [role='button'][aria-label*='start a post' i]"
        )
    },
    {
      key: "share-box-trigger",
      selectorHint: ".share-box-feed-entry__trigger, .share-box__open",
      locatorFactory: (page) =>
        page.locator(".share-box-feed-entry__trigger, .share-box__open")
    },
    {
      key: "text-start-post",
      selectorHint: "button, [role='button'] hasText /start a post/i",
      locatorFactory: (page) =>
        page.locator("button, [role='button']").filter({ hasText: /start a post/i })
    }
  ];
}

function createComposerRootCandidates(): SelectorCandidate[] {
  return [
    {
      key: "dialog-with-textbox",
      selectorHint: "[role='dialog'] has [contenteditable='true'] or textarea",
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.locator("[contenteditable='true'], textarea") })
    },
    {
      key: "dialog-with-post-button",
      selectorHint: "[role='dialog'] has getByRole(button, /^post$/i)",
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByRole("button", { name: /^post$/i }) })
    },
    {
      key: "dialog-with-prompt",
      selectorHint: "[role='dialog'] hasText /what do you want to talk about/i",
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByText(/what do you want to talk about/i) })
    },
    {
      key: "share-box-open",
      selectorHint: ".share-box__open, .share-creation-state",
      locatorFactory: (page) =>
        page.locator(".share-box__open, .share-creation-state")
    }
  ];
}

function createComposerInputCandidates(): ScopedSelectorCandidate[] {
  return [
    {
      key: "role-textbox-prompt",
      selectorHint: "getByRole(textbox, /what do you want to talk about|start a post/i)",
      locatorFactory: (root) =>
        root.getByRole("textbox", {
          name: /what do you want to talk about|start a post/i
        })
    },
    {
      key: "ql-editor",
      selectorHint: ".ql-editor[contenteditable='true']",
      locatorFactory: (root) => root.locator(".ql-editor[contenteditable='true']")
    },
    {
      key: "contenteditable-role-textbox",
      selectorHint: "[contenteditable='true'][role='textbox']",
      locatorFactory: (root) => root.locator("[contenteditable='true'][role='textbox']")
    },
    {
      key: "contenteditable",
      selectorHint: "[contenteditable='true']",
      locatorFactory: (root) => root.locator("[contenteditable='true']")
    },
    {
      key: "textarea",
      selectorHint: "textarea",
      locatorFactory: (root) => root.locator("textarea")
    }
  ];
}

function createVisibilityButtonCandidates(): ScopedSelectorCandidate[] {
  return [
    {
      key: "role-button-visibility",
      selectorHint:
        "getByRole(button, /anyone|connections only|who can see your post|visibility|post settings/i)",
      locatorFactory: (root) =>
        root.getByRole("button", {
          name: /anyone|connections only|who can see your post|visibility|post settings/i
        })
    },
    {
      key: "aria-label-visibility",
      selectorHint:
        "button[aria-label*=anyone|connections only|visibility|post settings]",
      locatorFactory: (root) =>
        root.locator(
          "button[aria-label*='Anyone' i], button[aria-label*='Connections only' i], button[aria-label*='Who can see your post' i], button[aria-label*='visibility' i], button[aria-label*='post settings' i]"
        )
    },
    {
      key: "button-text-visibility",
      selectorHint: "button hasText /anyone|connections only/i",
      locatorFactory: (root) => root.locator("button").filter({ hasText: /anyone|connections only/i })
    }
  ];
}

function createVisibilityOptionCandidates(
  visibility: LinkedInPostVisibility
): SelectorCandidate[] {
  const audienceLabel = LINKEDIN_POST_VISIBILITY_MAP[visibility].audienceLabel;
  const labelRegex = new RegExp(`^${escapeRegExp(audienceLabel)}$`, "i");

  return [
    {
      key: "role-radio-visibility-option",
      selectorHint: `getByRole(radio, ${audienceLabel})`,
      locatorFactory: (page) => page.getByRole("radio", { name: labelRegex })
    },
    {
      key: "role-button-visibility-option",
      selectorHint: `getByRole(button, ${audienceLabel})`,
      locatorFactory: (page) => page.getByRole("button", { name: labelRegex })
    },
    {
      key: "label-visibility-option",
      selectorHint: `label hasText ${audienceLabel}`,
      locatorFactory: (page) => page.locator("label").filter({ hasText: labelRegex })
    },
    {
      key: "generic-visibility-option",
      selectorHint: `[role='radio'], button, label, li hasText ${audienceLabel}`,
      locatorFactory: (page) =>
        page
          .locator("[role='radio'], button, label, li")
          .filter({ hasText: labelRegex })
    }
  ];
}

function createVisibilityDoneButtonCandidates(): SelectorCandidate[] {
  return [
    {
      key: "role-button-done",
      selectorHint: "getByRole(button, /done|save/i)",
      locatorFactory: (page) => page.getByRole("button", { name: /done|save/i })
    },
    {
      key: "button-text-done",
      selectorHint: "button hasText /done|save/i",
      locatorFactory: (page) => page.locator("button").filter({ hasText: /done|save/i })
    }
  ];
}

function createPublishButtonCandidates(): ScopedSelectorCandidate[] {
  return [
    {
      key: "role-button-post",
      selectorHint: "getByRole(button, /^post$/i)",
      locatorFactory: (root) => root.getByRole("button", { name: /^post$/i })
    },
    {
      key: "share-actions-primary",
      selectorHint: ".share-actions__primary-action",
      locatorFactory: (root) => root.locator(".share-actions__primary-action")
    },
    {
      key: "submit-button",
      selectorHint: "button[type='submit']",
      locatorFactory: (root) => root.locator("button[type='submit']")
    }
  ];
}

function createComposerCloseButtonCandidates(): ScopedSelectorCandidate[] {
  return [
    {
      key: "role-button-dismiss",
      selectorHint: "getByRole(button, /dismiss|close/i)",
      locatorFactory: (root) => root.getByRole("button", { name: /dismiss|close/i })
    },
    {
      key: "aria-dismiss-close",
      selectorHint: "button[aria-label*=dismiss|close]",
      locatorFactory: (root) =>
        root.locator(
          "button[aria-label*='dismiss' i], button[aria-label*='close' i]"
        )
    }
  ];
}

function createDiscardDialogCandidates(): SelectorCandidate[] {
  return [
    {
      key: "role-button-discard",
      selectorHint: "getByRole(button, /discard|leave/i)",
      locatorFactory: (page) => page.getByRole("button", { name: /discard|leave/i })
    },
    {
      key: "button-text-discard",
      selectorHint: "button hasText /discard|leave/i",
      locatorFactory: (page) => page.locator("button").filter({ hasText: /discard|leave/i })
    }
  ];
}

async function openPostComposer(
  page: Page,
  artifactPaths: string[]
): Promise<{ composerRoot: Locator; triggerKey: string; rootKey: string }> {
  await page.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForFeedSurface(page);

  const trigger = await findVisibleLocatorOrThrow(
    page,
    createComposeTriggerCandidates(),
    "post_composer_trigger",
    artifactPaths
  );
  await trigger.locator.click({ timeout: 5_000 });

  const root = await findVisibleLocatorOrThrow(
    page,
    createComposerRootCandidates(),
    "post_composer_root",
    artifactPaths
  );

  return {
    composerRoot: root.locator,
    triggerKey: trigger.key,
    rootKey: root.key
  };
}

async function closeComposerBestEffort(page: Page, composerRoot: Locator): Promise<void> {
  const closeButton = await findOptionalScopedLocator(
    composerRoot,
    createComposerCloseButtonCandidates()
  );

  try {
    if (closeButton) {
      await closeButton.locator.click({ timeout: 2_000 });
    } else {
      await page.keyboard.press("Escape");
    }
  } catch {
    // Best effort.
  }

  const discardButton = await findOptionalVisibleLocator(
    page,
    createDiscardDialogCandidates()
  );
  if (discardButton) {
    await discardButton.locator.click({ timeout: 2_000 }).catch(() => undefined);
  }

  await waitForCondition(async () => !(await isAnyLocatorVisible(composerRoot)), 5_000);
}

async function setComposerText(
  page: Page,
  composerRoot: Locator,
  text: string,
  artifactPaths: string[]
): Promise<string> {
  const composerInput = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createComposerInputCandidates(),
    "post_composer_input",
    artifactPaths,
    page.url()
  );

  await composerInput.locator.click({ timeout: 5_000 });

  try {
    await composerInput.locator.fill(text, { timeout: 5_000 });
  } catch {
    await composerInput.locator.press("Control+A").catch(() => undefined);
    await composerInput.locator.press("Meta+A").catch(() => undefined);
    await composerInput.locator.press("Backspace").catch(() => undefined);
    await page.keyboard.insertText(text);
  }

  return composerInput.key;
}

async function readLocatorDetails(locator: Locator): Promise<string> {
  const ariaLabel = await locator.getAttribute("aria-label").catch(() => null);
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return normalizeText(ariaLabel);
  }

  const textContent = await locator.first().innerText().catch(() => "");
  return normalizeText(textContent);
}

async function setPostVisibility(
  page: Page,
  composerRoot: Locator,
  visibility: LinkedInPostVisibility,
  artifactPaths: string[]
): Promise<string> {
  const audienceLabel = LINKEDIN_POST_VISIBILITY_MAP[visibility].audienceLabel;
  const visibilityButton = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createVisibilityButtonCandidates(),
    "post_visibility_button",
    artifactPaths,
    page.url()
  );

  const currentLabel = await readLocatorDetails(visibilityButton.locator);
  if (currentLabel.toLowerCase().includes(audienceLabel.toLowerCase())) {
    return visibilityButton.key;
  }

  await visibilityButton.locator.click({ timeout: 5_000 });

  const option = await findVisibleLocatorOrThrow(
    page,
    createVisibilityOptionCandidates(visibility),
    "post_visibility_option",
    artifactPaths
  );
  await option.locator.click({ timeout: 5_000 });

  const doneButton = await findOptionalVisibleLocator(
    page,
    createVisibilityDoneButtonCandidates()
  );
  if (doneButton) {
    await doneButton.locator.click({ timeout: 5_000 });
  }

  const updated = await waitForCondition(async () => {
    const nextButton = await findOptionalScopedLocator(
      composerRoot,
      createVisibilityButtonCandidates()
    );
    if (!nextButton) {
      return false;
    }

    const label = await readLocatorDetails(nextButton.locator);
    return label.toLowerCase().includes(audienceLabel.toLowerCase());
  }, 5_000);

  if (!updated) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      `LinkedIn post visibility could not be set to ${audienceLabel}.`,
      {
        current_url: page.url(),
        requested_visibility: visibility,
        requested_audience_label: audienceLabel,
        selector_key: visibilityButton.key,
        artifact_paths: artifactPaths
      }
    );
  }

  return visibilityButton.key;
}

async function findVisiblePostBySnippet(
  page: Page,
  snippet: string
): Promise<Locator | null> {
  const postCandidates = [
    page
      .locator("article, .feed-shared-update-v2, .occludable-update")
      .filter({ hasText: snippet }),
    page.getByText(snippet).locator("xpath=ancestor-or-self::*[self::article or contains(@class, 'feed-shared-update-v2') or contains(@class, 'occludable-update')]")
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
  postRoot: Locator | null
): Promise<string | null> {
  if (!postRoot) {
    return null;
  }

  const href = await postRoot
    .locator("a[href*='/feed/update/'], a[href*='/posts/'], a[href*='/activity/']")
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

async function verifyPublishedPost(
  page: Page,
  text: string,
  artifactPaths: string[]
): Promise<{ verified: true; postUrl: string | null }> {
  const snippet = createVerificationSnippet(text);
  if (!snippet) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Cannot verify a post with empty text content."
    );
  }

  const locatePost = async (): Promise<Locator | null> => {
    await page.evaluate(() => {
      globalThis.scrollTo({ top: 0, behavior: "auto" });
    });
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
      throw new LinkedInAssistantError(
        "UNKNOWN",
        "Published LinkedIn post could not be verified on the feed.",
        {
          current_url: page.url(),
          verification_snippet: snippet,
          artifact_paths: artifactPaths
        }
      );
    }
  }

  return {
    verified: true,
    postUrl: await extractPublishedPostUrl(page, postRoot)
  };
}

export class LinkedInPostsService {
  constructor(private readonly runtime: LinkedInPostsRuntime) {}

  async prepareCreate(
    input: PrepareCreatePostInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const validatedText = validateLinkedInPostText(input.text);
    const visibility = normalizeLinkedInPostVisibility(input.visibility, "public");
    const tracePath = `linkedin/trace-post-prepare-${Date.now()}.zip`;
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

            const { composerRoot, triggerKey, rootKey } = await openPostComposer(
              page,
              artifactPaths
            );

            const screenshotPath = `linkedin/screenshot-post-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_create_post",
              profile_name: profileName,
              visibility,
              trigger_selector_key: triggerKey,
              composer_selector_key: rootKey
            });
            artifactPaths.push(screenshotPath);

            await closeComposerBestEffort(page, composerRoot);

            const rateLimitState = this.runtime.rateLimiter.peek(
              CREATE_POST_RATE_LIMIT_CONFIG
            );

            const target = {
              profile_name: profileName,
              visibility,
              visibility_label: LINKEDIN_POST_VISIBILITY_MAP[visibility].label,
              compose_url: LINKEDIN_FEED_URL
            };

            const preview = {
              summary: `Create ${LINKEDIN_POST_VISIBILITY_MAP[visibility].label.toLowerCase()} LinkedIn post`,
              target,
              outbound: {
                text: validatedText.normalizedText
              },
              validation: {
                character_count: validatedText.characterCount,
                line_count: validatedText.lineCount,
                paragraph_count: validatedText.paragraphCount,
                max_length: LINKEDIN_POST_MAX_LENGTH,
                contains_url: validatedText.containsUrl,
                contains_mention: validatedText.containsMention,
                contains_hashtag: validatedText.containsHashtag
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: CREATE_POST_ACTION_TYPE,
              target,
              payload: {
                text: validatedText.normalizedText,
                visibility
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-post-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_create_post_error",
                profile_name: profileName,
                visibility
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(error, "Failed to prepare LinkedIn post creation.", {
              profile_name: profileName,
              current_url: page.url(),
              requested_visibility: visibility,
              artifact_paths: artifactPaths
            });
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_post",
                  profile_name: profileName,
                  visibility
                });
              } catch (error) {
                this.runtime.logger.log("warn", "linkedin.post.prepare.trace.stop_failed", {
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
      throw toAutomationError(error, "Failed to prepare LinkedIn post creation.", {
        profile_name: profileName,
        requested_visibility: visibility,
        artifact_paths: artifactPaths
      });
    }
  }
}

class CreatePostActionExecutor
  implements ActionExecutor<LinkedInPostsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPostsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const text = getRequiredStringField(action.payload, "text", action.id, "payload");
    const visibility = normalizeLinkedInPostVisibility(
      getRequiredStringField(action.payload, "visibility", action.id, "payload"),
      "public"
    );
    const tracePath = `linkedin/trace-post-confirm-${Date.now()}.zip`;
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
            CREATE_POST_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn create_post confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                requested_visibility: visibility,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          const { composerRoot, triggerKey, rootKey } = await openPostComposer(
            page,
            artifactPaths
          );
          const visibilityKey = await setPostVisibility(
            page,
            composerRoot,
            visibility,
            artifactPaths
          );
          const inputKey = await setComposerText(page, composerRoot, text, artifactPaths);

          const prePublishScreenshot = `linkedin/screenshot-post-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, prePublishScreenshot, {
            action: CREATE_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            trigger_selector_key: triggerKey,
            composer_selector_key: rootKey,
            visibility_selector_key: visibilityKey,
            input_selector_key: inputKey
          });
          artifactPaths.push(prePublishScreenshot);

          const publishButton = await findVisibleScopedLocatorOrThrow(
            composerRoot,
            createPublishButtonCandidates(),
            "post_publish_button",
            artifactPaths,
            page.url()
          );
          const publishEnabled = await waitForCondition(async () => {
            try {
              return await publishButton.locator.isEnabled();
            } catch {
              return false;
            }
          }, 5_000);

          if (!publishEnabled) {
            throw new LinkedInAssistantError(
              "UI_CHANGED_SELECTOR_FAILED",
              "LinkedIn publish button was not enabled after entering post content.",
              {
                action_id: action.id,
                profile_name: profileName,
                requested_visibility: visibility,
                selector_key: publishButton.key,
                artifact_paths: artifactPaths
              }
            );
          }

          await publishButton.locator.click({ timeout: 5_000 });
          await waitForCondition(async () => !(await isAnyLocatorVisible(composerRoot)), 10_000);
          await waitForNetworkIdleBestEffort(page, 10_000);

          const verification = await verifyPublishedPost(page, text, artifactPaths);

          const postPublishScreenshot = `linkedin/screenshot-post-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postPublishScreenshot, {
            action: CREATE_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            published_post_url: verification.postUrl
          });
          artifactPaths.push(postPublishScreenshot);

          return {
            ok: true,
            result: {
              posted: true,
              visibility,
              verification_snippet: createVerificationSnippet(text),
              published_post_url: verification.postUrl,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-post-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${CREATE_POST_ACTION_TYPE}_error`,
              profile_name: profileName,
              visibility
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to execute LinkedIn create_post action.", {
            action_id: action.id,
            profile_name: profileName,
            current_url: page.url(),
            requested_visibility: visibility,
            artifact_paths: artifactPaths
          });
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: CREATE_POST_ACTION_TYPE,
                profile_name: profileName,
                visibility
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.post.confirm.trace.stop_failed", {
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

export function createPostActionExecutors(): ActionExecutorRegistry<LinkedInPostsExecutorRuntime> {
  return {
    [CREATE_POST_ACTION_TYPE]: new CreatePostActionExecutor()
  };
}
