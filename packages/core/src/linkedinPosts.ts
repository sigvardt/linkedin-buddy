import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
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
  LinkedInSelectorLocale,
  LinkedInSelectorPhraseKey
} from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  ActionExecutorRegistry,
  PreparedActionResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_PROFILE_ACTIVITY_URL = "https://www.linkedin.com/in/me/recent-activity/all/";
const LINKEDIN_ASSISTANT_CONFIG_FILENAME = "config.json";
const DEFAULT_LINK_PREVIEW_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_LINK_PREVIEW_VALIDATION_TIMEOUT_MS = 30_000;
const LINK_PREVIEW_BODY_BYTE_LIMIT = 64 * 1024;

export const CREATE_POST_ACTION_TYPE = "post.create";
export const CREATE_MEDIA_POST_ACTION_TYPE = "post.create_media";
export const CREATE_POLL_POST_ACTION_TYPE = "post.create_poll";
export const EDIT_POST_ACTION_TYPE = "post.edit";
export const DELETE_POST_ACTION_TYPE = "post.delete";
export const LINKEDIN_POST_MAX_LENGTH = 3000;
export const LINKEDIN_POST_MAX_MEDIA_ATTACHMENTS = 20;
export const LINKEDIN_POST_POLL_MIN_OPTIONS = 2;
export const LINKEDIN_POST_POLL_MAX_OPTIONS = 4;
export const LINKEDIN_POST_POLL_DURATION_DAYS = [1, 3, 7, 14] as const;
export const LINKEDIN_POST_FEED_SURFACE_SELECTORS = [
  "main[role='main']",
  "[data-urn]",
  ".feed-shared-update-v2",
  ".occludable-update",
  ".share-box-feed-entry",
  "main"
] as const;
export const LINKEDIN_POST_ACTIVITY_SURFACE_SELECTORS = [
  "main[role='main']",
  "[data-urn]",
  "article",
  ".feed-shared-update-v2",
  ".occludable-update",
  "main"
] as const;

type LinkedInPollDurationDays =
  (typeof LINKEDIN_POST_POLL_DURATION_DAYS)[number];

export const LINKEDIN_POST_MEDIA_KINDS = ["image", "video"] as const;

export type LinkedInPostMediaKind =
  (typeof LINKEDIN_POST_MEDIA_KINDS)[number];

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

const EDIT_POST_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.post.edit",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 10
} as const;

const DELETE_POST_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.post.delete",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 10
} as const;

const LINKEDIN_POST_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp"
]);

const LINKEDIN_POST_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".webm"
]);

export interface PrepareCreatePostInput {
  profileName?: string;
  text: string;
  visibility?: LinkedInPostVisibility | string;
  operatorNote?: string;
}

export interface PrepareCreateMediaPostInput {
  profileName?: string;
  text: string;
  mediaPaths: string[];
  visibility?: LinkedInPostVisibility | string;
  operatorNote?: string;
}

export interface PrepareCreatePollPostInput {
  profileName?: string;
  text?: string;
  question: string;
  options: string[];
  durationDays?: LinkedInPollDurationDays | number;
  visibility?: LinkedInPostVisibility | string;
  operatorNote?: string;
}

export interface PrepareEditPostInput {
  profileName?: string;
  postUrl: string;
  text: string;
  operatorNote?: string;
}

export interface PrepareDeletePostInput {
  profileName?: string;
  postUrl: string;
  operatorNote?: string;
}

export interface LinkedInPostsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
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
  postSafetyLint: LinkedInPostSafetyLintConfig;
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

export interface ValidatedPostText {
  normalizedText: string;
  characterCount: number;
  lineCount: number;
  paragraphCount: number;
  containsUrl: boolean;
  containsMention: boolean;
  containsHashtag: boolean;
}

export interface LinkedInPostSafetyLintConfig {
  maxLength: number;
  bannedPhrases: string[];
  validateLinkPreviews: boolean;
  linkPreviewValidationTimeoutMs: number;
}

export interface LinkedInPostLintResult {
  validatedText: ValidatedPostText;
  urls: string[];
}

interface LinkPreviewValidationFailure {
  url: string;
  reason: string;
}

interface ExtractedPostLinks {
  validUrls: string[];
  invalidUrls: string[];
}

interface PostSafetyLintConfigShape {
  maxLength?: unknown;
  bannedPhrases?: unknown;
  validateLinkPreviews?: unknown;
  linkPreviewValidationTimeoutMs?: unknown;
}

interface ValidatedMediaAttachment {
  path: string;
  absolutePath: string;
  fileName: string;
  extension: string;
  kind: LinkedInPostMediaKind;
  sizeBytes: number;
}

interface TargetPostLocator {
  locator: Locator;
  key: string;
  postIdentity: string;
  activityId: string;
}

export const DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG: LinkedInPostSafetyLintConfig = {
  maxLength: LINKEDIN_POST_MAX_LENGTH,
  bannedPhrases: [],
  validateLinkPreviews: false,
  linkPreviewValidationTimeoutMs: DEFAULT_LINK_PREVIEW_VALIDATION_TIMEOUT_MS
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalPositiveInteger(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be an integer.`,
      {
        label,
        provided_value: value
      }
    );
  }

  const min = options.min ?? 1;
  const max = options.max;
  if (value < min || (max !== undefined && value > max)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      max === undefined
        ? `${label} must be at least ${min}.`
        : `${label} must be between ${min} and ${max}.`,
      {
        label,
        provided_value: value,
        min,
        ...(max === undefined ? {} : { max })
      }
    );
  }

  return value;
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a boolean.`,
      {
        label,
        provided_value: value
      }
    );
  }

  return value;
}

function normalizeConfiguredPhraseList(values: string[]): string[] {
  const normalizedValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) {
      continue;
    }

    const dedupeKey = normalizedValue.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedValues.push(normalizedValue);
  }

  return normalizedValues;
}

function parseOptionalBannedPhraseList(
  value: unknown,
  label: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be an array of strings.`,
      {
        label,
        provided_value: value
      }
    );
  }

  return normalizeConfiguredPhraseList(value);
}

function parseBooleanEnv(value: string | undefined, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} must be one of: true, false, 1, 0, yes, no, on, off.`,
    {
      label,
      provided_value: value
    }
  );
}

function parseIntegerEnv(
  value: string | undefined,
  label: string,
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be an integer.`,
      {
        label,
        provided_value: value
      }
    );
  }

  return parseOptionalPositiveInteger(parsed, label, options);
}

function parseBannedPhraseEnv(
  value: string | undefined,
  label: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim().length === 0) {
    return [];
  }

  const trimmedValue = value.trim();
  if (trimmedValue.startsWith("[")) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(trimmedValue);
    } catch (error) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `${label} must be a JSON string array or a comma/newline-separated list.`,
        {
          label,
          provided_value: value,
          message: error instanceof Error ? error.message : String(error)
        },
        error instanceof Error ? { cause: error } : undefined
      );
    }

    return parseOptionalBannedPhraseList(parsed, label);
  }

  return normalizeConfiguredPhraseList(trimmedValue.split(/\r?\n|,/g));
}

function readPostSafetyLintConfigShape(baseDir: string): PostSafetyLintConfigShape {
  const configPath = path.join(baseDir, LINKEDIN_ASSISTANT_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Failed to parse LinkedIn assistant config file at ${configPath}.`,
      {
        config_path: configPath,
        message: error instanceof Error ? error.message : String(error)
      },
      error instanceof Error ? { cause: error } : undefined
    );
  }

  if (!isRecord(parsed)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `LinkedIn assistant config file at ${configPath} must contain a JSON object.`,
      {
        config_path: configPath
      }
    );
  }

  const directLintConfig = parsed.postSafetyLint;
  if (directLintConfig === undefined) {
    return {};
  }

  if (!isRecord(directLintConfig)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `postSafetyLint in ${configPath} must be a JSON object.`,
      {
        config_path: configPath,
        provided_value: directLintConfig
      }
    );
  }

  return directLintConfig;
}

export function resolveLinkedInPostSafetyLintConfig(
  baseDir?: string
): LinkedInPostSafetyLintConfig {
  const fileConfig = baseDir ? readPostSafetyLintConfigShape(baseDir) : {};
  const fileLabel = baseDir
    ? `${path.join(baseDir, LINKEDIN_ASSISTANT_CONFIG_FILENAME)} postSafetyLint`
    : "postSafetyLint";

  const maxLength =
    parseIntegerEnv(
      process.env.LINKEDIN_ASSISTANT_POST_SAFETY_MAX_LENGTH,
      "LINKEDIN_ASSISTANT_POST_SAFETY_MAX_LENGTH",
      {
      max: LINKEDIN_POST_MAX_LENGTH
      }
    ) ??
    parseOptionalPositiveInteger(fileConfig.maxLength, `${fileLabel}.maxLength`, {
      max: LINKEDIN_POST_MAX_LENGTH
    }) ??
    DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG.maxLength;

  const bannedPhrases =
    parseBannedPhraseEnv(
      process.env.LINKEDIN_ASSISTANT_POST_SAFETY_BANNED_PHRASES,
      "LINKEDIN_ASSISTANT_POST_SAFETY_BANNED_PHRASES"
    ) ??
    parseOptionalBannedPhraseList(fileConfig.bannedPhrases, `${fileLabel}.bannedPhrases`) ??
    DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG.bannedPhrases;

  const validateLinkPreviews =
    parseBooleanEnv(
      process.env.LINKEDIN_ASSISTANT_POST_SAFETY_VALIDATE_LINK_PREVIEWS,
      "LINKEDIN_ASSISTANT_POST_SAFETY_VALIDATE_LINK_PREVIEWS"
    ) ??
    parseOptionalBoolean(
      fileConfig.validateLinkPreviews,
      `${fileLabel}.validateLinkPreviews`
    ) ??
    DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG.validateLinkPreviews;

  const linkPreviewValidationTimeoutMs =
    parseIntegerEnv(
      process.env.LINKEDIN_ASSISTANT_POST_SAFETY_LINK_TIMEOUT_MS,
      "LINKEDIN_ASSISTANT_POST_SAFETY_LINK_TIMEOUT_MS",
      {
        max: MAX_LINK_PREVIEW_VALIDATION_TIMEOUT_MS
      }
    ) ??
    parseOptionalPositiveInteger(
      fileConfig.linkPreviewValidationTimeoutMs,
      `${fileLabel}.linkPreviewValidationTimeoutMs`,
      {
        max: MAX_LINK_PREVIEW_VALIDATION_TIMEOUT_MS
      }
    ) ??
    DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG.linkPreviewValidationTimeoutMs;

  return {
    maxLength,
    bannedPhrases,
    validateLinkPreviews,
    linkPreviewValidationTimeoutMs
  };
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

export function validateLinkedInPostText(
  value: string,
  maxLength: number = LINKEDIN_POST_MAX_LENGTH
): ValidatedPostText {
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
  if (characterCount > maxLength) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Post text must be ${maxLength} characters or fewer.`,
      {
        character_count: characterCount,
        max_length: maxLength,
        linkedin_max_length: LINKEDIN_POST_MAX_LENGTH
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

function normalizeBannedPhraseMatcher(value: string): string {
  return normalizeText(value).replace(/[\s\r\n]+/g, " ");
}

function matchConfiguredBannedPhrases(
  text: string,
  bannedPhrases: string[]
): string[] {
  return bannedPhrases.filter((phrase) => {
    const normalizedPhrase = normalizeBannedPhraseMatcher(phrase);
    if (!normalizedPhrase) {
      return false;
    }

    const normalizedPattern = escapeRegExp(normalizedPhrase).replace(/\s+/g, "\\s+");
    return new RegExp(
      `(^|[^\\p{L}\\p{N}_])${normalizedPattern}($|[^\\p{L}\\p{N}_])`,
      "iu"
    ).test(text);
  });
}

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,!?;:]+$/u, "");
}

function extractUrlsFromPostText(text: string): ExtractedPostLinks {
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];
  const seenValidUrls = new Set<string>();
  const seenInvalidUrls = new Set<string>();
  const matches = text.match(/\b(?:https?:\/\/|www\.)[^\s<>{}"']+/giu) ?? [];

  for (const match of matches) {
    const trimmedUrl = trimTrailingUrlPunctuation(match);
    const candidateUrl = /^https?:\/\//iu.test(trimmedUrl)
      ? trimmedUrl
      : `https://${trimmedUrl}`;

    try {
      const url = new URL(candidateUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http:// and https:// links are supported.");
      }

      const normalizedUrl = url.toString();
      if (seenValidUrls.has(normalizedUrl)) {
        continue;
      }

      seenValidUrls.add(normalizedUrl);
      validUrls.push(normalizedUrl);
    } catch {
      if (seenInvalidUrls.has(trimmedUrl)) {
        continue;
      }

      seenInvalidUrls.add(trimmedUrl);
      invalidUrls.push(trimmedUrl);
    }
  }

  return {
    validUrls,
    invalidUrls
  };
}

function isPrivateHostname(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    normalizedHostname.endsWith(".local") ||
    normalizedHostname.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipVersion = isIP(normalizedHostname);
  if (ipVersion === 4) {
    const octets = normalizedHostname.split(".").map((segment) => Number.parseInt(segment, 10));
    const firstOctet = octets[0] ?? -1;
    const secondOctet = octets[1] ?? -1;

    if (firstOctet === 10 || firstOctet === 127) {
      return true;
    }

    if (firstOctet === 169 && secondOctet === 254) {
      return true;
    }

    if (firstOctet === 192 && secondOctet === 168) {
      return true;
    }

    if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }

    return false;
  }

  if (ipVersion === 6) {
    return (
      normalizedHostname === "::1" ||
      normalizedHostname.startsWith("fc") ||
      normalizedHostname.startsWith("fd") ||
      normalizedHostname.startsWith("fe80:")
    );
  }

  return false;
}

async function readResponseSnippet(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainingBytes = maxBytes;
  let html = "";

  try {
    while (remainingBytes > 0) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = value.subarray(0, remainingBytes);
      remainingBytes -= chunk.byteLength;
      html += decoder.decode(chunk, { stream: remainingBytes > 0 });

      if (chunk.byteLength < value.byteLength) {
        break;
      }
    }

    html += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort.
    }
  }

  return html;
}

function looksPreviewableHtml(html: string): boolean {
  return (
    /<title\b[^>]*>.*?<\/title>/isu.test(html) ||
    /property=["']og:title["']/iu.test(html) ||
    /name=["']twitter:title["']/iu.test(html) ||
    /name=["']description["']/iu.test(html) ||
    /property=["']og:description["']/iu.test(html)
  );
}

async function validateLinkPreview(url: string, timeoutMs: number): Promise<string | null> {
  const parsedUrl = new URL(url);
  if (isPrivateHostname(parsedUrl.hostname)) {
    return "Private, loopback, or local-network links cannot be preview-validated.";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"
      }
    });

    if (!response.ok) {
      return `Received HTTP ${response.status}.`;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/\bhtml\b/iu.test(contentType)) {
      return `Expected HTML content but received ${contentType || "unknown content type"}.`;
    }

    const htmlSnippet = await readResponseSnippet(response, LINK_PREVIEW_BODY_BYTE_LIMIT);
    if (!looksPreviewableHtml(htmlSnippet)) {
      return "The page does not expose HTML title or preview metadata near the top of the document.";
    }

    return null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return `Timed out after ${timeoutMs}ms.`;
    }

    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function validateConfiguredLinkPreviews(
  urls: string[],
  timeoutMs: number
): Promise<void> {
  const results = await Promise.all(
    urls.map(async (url): Promise<LinkPreviewValidationFailure | null> => {
      const failureReason = await validateLinkPreview(url, timeoutMs);
      if (!failureReason) {
        return null;
      }

      return {
        url,
        reason: failureReason
      };
    })
  );

  const failedLinks = results.filter(
    (result): result is LinkPreviewValidationFailure => result !== null
  );
  if (failedLinks.length === 0) {
    return;
  }

  const firstFailedLink = failedLinks[0];
  if (!firstFailedLink) {
    return;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    failedLinks.length === 1
      ? `Link preview validation failed for ${firstFailedLink.url}.`
      : `Link preview validation failed for ${failedLinks.length} links.`,
    {
      invalid_links: failedLinks,
      link_preview_validation: {
        enabled: true,
        timeout_ms: timeoutMs
      }
    }
  );
}

export async function lintLinkedInPostContent(
  value: string,
  config: LinkedInPostSafetyLintConfig = DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG
): Promise<LinkedInPostLintResult> {
  const validatedText = validateLinkedInPostText(value, config.maxLength);
  const matchedBannedPhrases = matchConfiguredBannedPhrases(
    validatedText.normalizedText,
    config.bannedPhrases
  );
  if (matchedBannedPhrases.length > 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      matchedBannedPhrases.length === 1
        ? `Post text contains banned phrase "${matchedBannedPhrases[0]}".`
        : `Post text contains ${matchedBannedPhrases.length} banned phrases.`,
      {
        banned_phrases: matchedBannedPhrases,
        configured_banned_phrase_count: config.bannedPhrases.length
      }
    );
  }

  const extractedLinks = extractUrlsFromPostText(validatedText.normalizedText);
  if (config.validateLinkPreviews) {
    if (extractedLinks.invalidUrls.length > 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        extractedLinks.invalidUrls.length === 1
          ? `Post text contains an invalid URL: ${extractedLinks.invalidUrls[0]}.`
          : `Post text contains ${extractedLinks.invalidUrls.length} invalid URLs.`,
        {
          invalid_urls: extractedLinks.invalidUrls,
          link_preview_validation: {
            enabled: true,
            timeout_ms: config.linkPreviewValidationTimeoutMs
          }
        }
      );
    }

    await validateConfiguredLinkPreviews(
      extractedLinks.validUrls,
      config.linkPreviewValidationTimeoutMs
    );
  }

  return {
    validatedText,
    urls: extractedLinks.validUrls
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

function normalizeOptionalPostText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizePostText(value);
  return normalized.length > 0 ? normalized : null;
}

async function lintOptionalLinkedInPostContent(
  value: string | undefined,
  config: LinkedInPostSafetyLintConfig = DEFAULT_LINKEDIN_POST_SAFETY_LINT_CONFIG
): Promise<LinkedInPostLintResult | null> {
  const normalizedValue = normalizeOptionalPostText(value);
  if (!normalizedValue) {
    return null;
  }

  return lintLinkedInPostContent(normalizedValue, config);
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

function buildTextRegex(labels: readonly string[], exact = false): RegExp {
  const normalizedLabels = Array.from(
    new Set(
      labels
        .map((label) => normalizeText(label))
        .filter((label) => label.length > 0)
    )
  );
  const pattern = normalizedLabels.map((label) => escapeRegExp(label)).join("|");
  return new RegExp(exact ? `^(?:${pattern})$` : `(?:${pattern})`, "i");
}

function determineMediaKind(extension: string): LinkedInPostMediaKind | null {
  if (LINKEDIN_POST_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (LINKEDIN_POST_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  return null;
}

function validateLinkedInPostMediaAttachments(
  mediaPaths: string[]
): ValidatedMediaAttachment[] {
  if (!Array.isArray(mediaPaths) || mediaPaths.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "mediaPaths must include at least one attachment."
    );
  }

  if (mediaPaths.length > LINKEDIN_POST_MAX_MEDIA_ATTACHMENTS) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `mediaPaths may include at most ${LINKEDIN_POST_MAX_MEDIA_ATTACHMENTS} files.`,
      {
        media_count: mediaPaths.length,
        max_media_attachments: LINKEDIN_POST_MAX_MEDIA_ATTACHMENTS
      }
    );
  }

  const attachments = mediaPaths.map((rawPath) => {
    const normalizedPath = normalizeText(rawPath);
    if (!normalizedPath) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "mediaPaths must not contain empty entries."
      );
    }

    const absolutePath = path.resolve(normalizedPath);
    if (!existsSync(absolutePath)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Media file does not exist: ${normalizedPath}.`,
        {
          media_path: normalizedPath,
          absolute_path: absolutePath
        }
      );
    }

    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Media path must point to a file: ${normalizedPath}.`,
        {
          media_path: normalizedPath,
          absolute_path: absolutePath
        }
      );
    }

    if (stats.size <= 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Media file must not be empty: ${normalizedPath}.`,
        {
          media_path: normalizedPath,
          absolute_path: absolutePath
        }
      );
    }

    const extension = path.extname(absolutePath).toLowerCase();
    const kind = determineMediaKind(extension);
    if (!kind) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Unsupported LinkedIn media file type: ${normalizedPath}.`,
        {
          media_path: normalizedPath,
          absolute_path: absolutePath,
          extension,
          supported_extensions: [
            ...Array.from(LINKEDIN_POST_IMAGE_EXTENSIONS),
            ...Array.from(LINKEDIN_POST_VIDEO_EXTENSIONS)
          ]
        }
      );
    }

    return {
      path: normalizedPath,
      absolutePath,
      fileName: path.basename(absolutePath),
      extension,
      kind,
      sizeBytes: stats.size
    } satisfies ValidatedMediaAttachment;
  });

  const kinds = new Set(attachments.map((attachment) => attachment.kind));
  if (kinds.size > 1) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "mediaPaths must contain only images or only a single video.",
      {
        media_kinds: Array.from(kinds)
      }
    );
  }

  const kind = attachments[0]?.kind;
  if (kind === "video" && attachments.length > 1) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "LinkedIn post composer only supports one video attachment per post.",
      {
        media_count: attachments.length
      }
    );
  }

  return attachments;
}

function normalizePollQuestion(question: string): string {
  const normalized = normalizeText(question);
  if (!normalized) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "question is required."
    );
  }

  return normalized;
}

function normalizePollOptions(options: string[]): string[] {
  if (!Array.isArray(options)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `options must include ${LINKEDIN_POST_POLL_MIN_OPTIONS}-${LINKEDIN_POST_POLL_MAX_OPTIONS} entries.`
    );
  }

  const normalizedOptions = options
    .map((option) => normalizeText(option))
    .filter((option) => option.length > 0);

  if (
    normalizedOptions.length < LINKEDIN_POST_POLL_MIN_OPTIONS ||
    normalizedOptions.length > LINKEDIN_POST_POLL_MAX_OPTIONS
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `options must include ${LINKEDIN_POST_POLL_MIN_OPTIONS}-${LINKEDIN_POST_POLL_MAX_OPTIONS} non-empty entries.`,
      {
        option_count: normalizedOptions.length,
        min_options: LINKEDIN_POST_POLL_MIN_OPTIONS,
        max_options: LINKEDIN_POST_POLL_MAX_OPTIONS
      }
    );
  }

  const dedupeSet = new Set(normalizedOptions.map((option) => option.toLowerCase()));
  if (dedupeSet.size !== normalizedOptions.length) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "options must be distinct.",
      {
        options: normalizedOptions
      }
    );
  }

  return normalizedOptions;
}

function normalizePollDurationDays(
  durationDays: number | LinkedInPollDurationDays | undefined
): LinkedInPollDurationDays {
  if (durationDays === undefined) {
    return 7;
  }

  if (
    typeof durationDays !== "number" ||
    !LINKEDIN_POST_POLL_DURATION_DAYS.includes(durationDays as LinkedInPollDurationDays)
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `durationDays must be one of: ${LINKEDIN_POST_POLL_DURATION_DAYS.join(", ")}.`,
      {
        duration_days: durationDays,
        supported_duration_days: LINKEDIN_POST_POLL_DURATION_DAYS
      }
    );
  }

  return durationDays as LinkedInPollDurationDays;
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

async function hasAnyLocator(locator: Locator): Promise<boolean> {
  return (await locator.count().catch(() => 0)) > 0;
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

async function findPresentLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    if (await hasAnyLocator(locator)) {
      return { locator, key: candidate.key };
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

async function findPresentLocatorCollection(
  page: Page,
  candidates: SelectorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page);
    if (await hasAnyLocator(locator)) {
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

async function findPresentScopedLocator(
  root: Locator,
  candidates: ScopedSelectorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await hasAnyLocator(locator)) {
      return { locator, key: candidate.key };
    }
  }

  return null;
}

async function waitForVisibleSurface(
  page: Page,
  selectors: readonly string[],
  errorMessage: string
): Promise<void> {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000
      });
      return;
    } catch {
      // Try next candidate.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    errorMessage,
    {
      current_url: page.url(),
      attempted_selectors: [...selectors]
    }
  );
}

export async function waitForFeedSurface(page: Page): Promise<void> {
  await waitForVisibleSurface(
    page,
    LINKEDIN_POST_FEED_SURFACE_SELECTORS,
    "Could not locate LinkedIn feed surface."
  );
}

async function waitForProfileActivitySurface(page: Page): Promise<void> {
  await waitForVisibleSurface(
    page,
    LINKEDIN_POST_ACTIVITY_SURFACE_SELECTORS,
    "Could not locate LinkedIn profile activity surface."
  );
}

type PostUiActionLabelKey =
  | "edit"
  | "delete"
  | "media"
  | "poll"
  | "question"
  | "option"
  | "duration";

const POST_UI_ACTION_LABELS: Record<
  PostUiActionLabelKey,
  Record<LinkedInSelectorLocale, readonly string[]>
> = {
  edit: {
    en: ["Edit post", "Edit"],
    da: ["Rediger opslag", "Rediger"]
  },
  delete: {
    en: ["Delete post", "Delete", "Remove"],
    da: ["Slet opslag", "Slet", "Fjern"]
  },
  media: {
    en: [
      "Add media",
      "Add a photo",
      "Add a photo or video",
      "Photo",
      "Video"
    ],
    da: [
      "Tilføj medier",
      "Tilføj et billede",
      "Tilføj et billede eller en video",
      "Foto",
      "Billede",
      "Video"
    ]
  },
  poll: {
    en: ["Create a poll", "Poll"],
    da: ["Opret en afstemning", "Afstemning"]
  },
  question: {
    en: ["Question"],
    da: ["Spørgsmål"]
  },
  option: {
    en: ["Option"],
    da: ["Valgmulighed", "Svarmulighed", "Mulighed"]
  },
  duration: {
    en: ["Duration"],
    da: ["Varighed"]
  }
};

function getPostUiActionLabels(
  key: PostUiActionLabelKey,
  locale: LinkedInSelectorLocale
): string[] {
  const localized = POST_UI_ACTION_LABELS[key][locale] ?? POST_UI_ACTION_LABELS[key].en;
  return Array.from(new Set([...localized, ...POST_UI_ACTION_LABELS[key].en]));
}

function buildAriaLabelContainsSelector(
  tagNames: string | readonly string[],
  labels: readonly string[]
): string {
  const resolvedTagNames = Array.isArray(tagNames) ? tagNames : [tagNames];
  return resolvedTagNames
    .flatMap((tagName) =>
      labels.map(
        (label) => `${tagName}[aria-label*="${escapeCssAttributeValue(label)}" i]`
      )
    )
    .join(", ");
}

function formatPollDurationLabels(
  durationDays: LinkedInPollDurationDays,
  locale: LinkedInSelectorLocale
): string[] {
  const englishLabels = {
    1: ["1 day", "One day"],
    3: ["3 days"],
    7: ["1 week", "7 days"],
    14: ["2 weeks", "14 days"]
  } satisfies Record<LinkedInPollDurationDays, string[]>;

  const danishLabels = {
    1: ["1 dag"],
    3: ["3 dage"],
    7: ["1 uge", "7 dage"],
    14: ["2 uger", "14 dage"]
  } satisfies Record<LinkedInPollDurationDays, string[]>;

  const localized = locale === "da" ? danishLabels[durationDays] : englishLabels[durationDays];
  return Array.from(new Set([...(localized ?? []), ...englishLabels[durationDays]]));
}

function createComposeTriggerCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
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
  const startPostAriaSelector = buildLinkedInAriaLabelContainsSelector(
    ["button", "[role='button']"],
    "start_post",
    selectorLocale
  );

  return [
    {
      key: "role-button-start-post",
      selectorHint: `getByRole(button, ${startPostExactRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("button", { name: startPostExactRegex })
    },
    {
      key: "aria-start-post",
      selectorHint: startPostAriaSelector,
      locatorFactory: (page) => page.locator(startPostAriaSelector)
    },
    {
      key: "share-box-trigger",
      selectorHint: ".share-box-feed-entry__trigger, .share-box__open",
      locatorFactory: (page) =>
        page.locator(".share-box-feed-entry__trigger, .share-box__open")
    },
    {
      key: "text-start-post",
      selectorHint: `button, [role='button'] hasText ${startPostTextRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("button, [role='button']")
          .filter({ hasText: startPostTextRegex })
    }
  ];
}

function createComposerRootCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const postExactRegex = buildLinkedInSelectorPhraseRegex(
    "post",
    selectorLocale,
    { exact: true }
  );
  const postExactRegexHint = formatLinkedInSelectorRegexHint(
    "post",
    selectorLocale,
    { exact: true }
  );
  const composerPromptRegex = buildLinkedInSelectorPhraseRegex(
    "what_do_you_want_to_talk_about",
    selectorLocale
  );
  const composerPromptRegexHint = formatLinkedInSelectorRegexHint(
    "what_do_you_want_to_talk_about",
    selectorLocale
  );

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
      selectorHint: `[role='dialog'] has getByRole(button, ${postExactRegexHint})`,
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByRole("button", { name: postExactRegex }) })
    },
    {
      key: "dialog-with-prompt",
      selectorHint: `[role='dialog'] hasText ${composerPromptRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("[role='dialog']")
          .filter({ has: page.getByText(composerPromptRegex) })
    },
    {
      key: "share-box-open",
      selectorHint: ".share-box__open, .share-creation-state",
      locatorFactory: (page) =>
        page.locator(".share-box__open, .share-creation-state")
    }
  ];
}

function createComposerInputCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const composerInputRegex = buildLinkedInSelectorPhraseRegex(
    ["what_do_you_want_to_talk_about", "start_post"],
    selectorLocale
  );
  const composerInputRegexHint = formatLinkedInSelectorRegexHint(
    ["what_do_you_want_to_talk_about", "start_post"],
    selectorLocale
  );

  return [
    {
      key: "role-textbox-prompt",
      selectorHint: `getByRole(textbox, ${composerInputRegexHint})`,
      locatorFactory: (root) =>
        root.getByRole("textbox", {
          name: composerInputRegex
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

function createVisibilityButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const visibilityRegex = buildLinkedInSelectorPhraseRegex(
    [
      "anyone",
      "connections_only",
      "who_can_see_your_post",
      "visibility",
      "post_settings"
    ],
    selectorLocale
  );
  const visibilityRegexHint = formatLinkedInSelectorRegexHint(
    [
      "anyone",
      "connections_only",
      "who_can_see_your_post",
      "visibility",
      "post_settings"
    ],
    selectorLocale
  );
  const visibilityAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    [
      "anyone",
      "connections_only",
      "who_can_see_your_post",
      "visibility",
      "post_settings"
    ],
    selectorLocale
  );
  const visibilityTextRegex = buildLinkedInSelectorPhraseRegex(
    ["anyone", "connections_only"],
    selectorLocale
  );
  const visibilityTextRegexHint = formatLinkedInSelectorRegexHint(
    ["anyone", "connections_only"],
    selectorLocale
  );

  return [
    {
      key: "role-button-visibility",
      selectorHint: `getByRole(button, ${visibilityRegexHint})`,
      locatorFactory: (root) =>
        root.getByRole("button", {
          name: visibilityRegex
        })
    },
    {
      key: "aria-label-visibility",
      selectorHint: visibilityAriaSelector,
      locatorFactory: (root) => root.locator(visibilityAriaSelector)
    },
    {
      key: "button-text-visibility",
      selectorHint: `button hasText ${visibilityTextRegexHint}`,
      locatorFactory: (root) =>
        root.locator("button").filter({ hasText: visibilityTextRegex })
    }
  ];
}

function getVisibilityPhraseKey(
  visibility: LinkedInPostVisibility
): LinkedInSelectorPhraseKey {
  return visibility === "connections" ? "connections_only" : "anyone";
}

function createVisibilityOptionCandidates(
  visibility: LinkedInPostVisibility,
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const visibilityPhraseKey = getVisibilityPhraseKey(visibility);
  const labelRegex = buildLinkedInSelectorPhraseRegex(
    visibilityPhraseKey,
    selectorLocale,
    { exact: true }
  );
  const labelRegexHint = formatLinkedInSelectorRegexHint(
    visibilityPhraseKey,
    selectorLocale,
    { exact: true }
  );

  return [
    {
      key: "role-radio-visibility-option",
      selectorHint: `getByRole(radio, ${labelRegexHint})`,
      locatorFactory: (page) => page.getByRole("radio", { name: labelRegex })
    },
    {
      key: "role-button-visibility-option",
      selectorHint: `getByRole(button, ${labelRegexHint})`,
      locatorFactory: (page) => page.getByRole("button", { name: labelRegex })
    },
    {
      key: "label-visibility-option",
      selectorHint: `label hasText ${labelRegexHint}`,
      locatorFactory: (page) => page.locator("label").filter({ hasText: labelRegex })
    },
    {
      key: "generic-visibility-option",
      selectorHint: `[role='radio'], button, label, li hasText ${labelRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("[role='radio'], button, label, li")
          .filter({ hasText: labelRegex })
    }
  ];
}

function createVisibilityDoneButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const doneRegex = buildLinkedInSelectorPhraseRegex(
    ["done", "save"],
    selectorLocale
  );
  const doneRegexHint = formatLinkedInSelectorRegexHint(
    ["done", "save"],
    selectorLocale
  );

  return [
    {
      key: "role-button-done",
      selectorHint: `getByRole(button, ${doneRegexHint})`,
      locatorFactory: (page) => page.getByRole("button", { name: doneRegex })
    },
    {
      key: "button-text-done",
      selectorHint: `button hasText ${doneRegexHint}`,
      locatorFactory: (page) => page.locator("button").filter({ hasText: doneRegex })
    }
  ];
}

function createPublishButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const postExactRegex = buildLinkedInSelectorPhraseRegex(
    "post",
    selectorLocale,
    { exact: true }
  );
  const postExactRegexHint = formatLinkedInSelectorRegexHint(
    "post",
    selectorLocale,
    { exact: true }
  );

  return [
    {
      key: "role-button-post",
      selectorHint: `getByRole(button, ${postExactRegexHint})`,
      locatorFactory: (root) => root.getByRole("button", { name: postExactRegex })
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

function createScopedSaveButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const saveRegex = buildLinkedInSelectorPhraseRegex(
    ["save", "done"],
    selectorLocale
  );
  const saveRegexHint = formatLinkedInSelectorRegexHint(
    ["save", "done"],
    selectorLocale
  );
  const saveAriaSelector = buildLinkedInAriaLabelContainsSelector(
    ["button", "[role='button']"],
    ["save", "done"],
    selectorLocale
  );

  return [
    {
      key: "dialog-role-button-save",
      selectorHint: `getByRole(button, ${saveRegexHint})`,
      locatorFactory: (root) => root.getByRole("button", { name: saveRegex })
    },
    {
      key: "dialog-aria-button-save",
      selectorHint: saveAriaSelector,
      locatorFactory: (root) => root.locator(saveAriaSelector)
    },
    {
      key: "dialog-button-text-save",
      selectorHint: `button hasText ${saveRegexHint}`,
      locatorFactory: (root) => root.locator("button").filter({ hasText: saveRegex })
    }
  ];
}

function createPostMenuButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const menuRegex = buildLinkedInSelectorPhraseRegex(
    ["more", "more_actions"],
    selectorLocale
  );
  const menuRegexHint = formatLinkedInSelectorRegexHint(
    ["more", "more_actions"],
    selectorLocale
  );
  const menuAriaSelector = buildLinkedInAriaLabelContainsSelector(
    ["button", "[role='button']"],
    ["more", "more_actions"],
    selectorLocale
  );

  return [
    {
      key: "post-menu-button-role",
      selectorHint: `getByRole(button, ${menuRegexHint})`,
      locatorFactory: (root) => root.getByRole("button", { name: menuRegex })
    },
    {
      key: "post-menu-button-aria",
      selectorHint: menuAriaSelector,
      locatorFactory: (root) => root.locator(menuAriaSelector)
    },
    {
      key: "post-menu-button-feed-control",
      selectorHint: ".feed-shared-control-menu__trigger, .artdeco-dropdown__trigger",
      locatorFactory: (root) =>
        root.locator(".feed-shared-control-menu__trigger, .artdeco-dropdown__trigger")
    }
  ];
}

function createPostMenuActionCandidates(
  labels: readonly string[],
  keyPrefix: string
): SelectorCandidate[] {
  const exactRegex = buildTextRegex(labels, true);
  const textRegex = buildTextRegex(labels);
  const ariaSelector = buildAriaLabelContainsSelector(
    ["button", "[role='button']", "[role='menuitem']"],
    labels
  );

  return [
    {
      key: `${keyPrefix}-menuitem-role`,
      selectorHint: `[role='menuitem'] hasText ${textRegex.source}`,
      locatorFactory: (page) => page.locator("[role='menuitem']").filter({ hasText: textRegex })
    },
    {
      key: `${keyPrefix}-dropdown-button-text`,
      selectorHint: `.artdeco-dropdown__content-inner button hasText ${textRegex.source}`,
      locatorFactory: (page) =>
        page
          .locator(".artdeco-dropdown__content-inner button, .artdeco-dropdown__content-inner li")
          .filter({ hasText: textRegex })
    },
    {
      key: `${keyPrefix}-action-aria`,
      selectorHint: ariaSelector,
      locatorFactory: (page) => page.locator(ariaSelector)
    },
    {
      key: `${keyPrefix}-button-exact`,
      selectorHint: `button exact ${exactRegex.source}`,
      locatorFactory: (page) => page.locator("button, [role='button']").filter({ hasText: exactRegex })
    }
  ];
}

function createDeleteConfirmButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const labels = getPostUiActionLabels("delete", selectorLocale);
  const deleteRegex = buildTextRegex(labels);
  const deleteExactRegex = buildTextRegex(labels, true);
  const deleteAriaSelector = buildAriaLabelContainsSelector(
    ["button", "[role='button']"],
    labels
  );

  return [
    {
      key: "delete-confirm-role-exact",
      selectorHint: `getByRole(button, ${deleteExactRegex.source})`,
      locatorFactory: (root) => root.getByRole("button", { name: deleteExactRegex })
    },
    {
      key: "delete-confirm-aria",
      selectorHint: deleteAriaSelector,
      locatorFactory: (root) => root.locator(deleteAriaSelector)
    },
    {
      key: "delete-confirm-button-text",
      selectorHint: `button hasText ${deleteRegex.source}`,
      locatorFactory: (root) => root.locator("button").filter({ hasText: deleteRegex })
    }
  ];
}

function createMediaButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const labels = getPostUiActionLabels("media", selectorLocale);
  const mediaRegex = buildTextRegex(labels);
  const mediaExactRegex = buildTextRegex(labels, true);
  const mediaAriaSelector = buildAriaLabelContainsSelector(
    ["button", "[role='button']"],
    labels
  );

  return [
    {
      key: "media-button-role-exact",
      selectorHint: `getByRole(button, ${mediaExactRegex.source})`,
      locatorFactory: (root) => root.getByRole("button", { name: mediaExactRegex })
    },
    {
      key: "media-button-aria",
      selectorHint: mediaAriaSelector,
      locatorFactory: (root) => root.locator(mediaAriaSelector)
    },
    {
      key: "media-button-text",
      selectorHint: `button hasText ${mediaRegex.source}`,
      locatorFactory: (root) =>
        root.locator("button, [role='button']").filter({ hasText: mediaRegex })
    },
    {
      key: "media-button-footer-icon",
      selectorHint: ".share-box-footer button, footer button",
      locatorFactory: (root) =>
        root.locator(".share-box-footer button, .share-creation-state__footer button")
    }
  ];
}

function createMediaInputCandidates(): ScopedSelectorCandidate[] {
  return [
    {
      key: "media-input-file",
      selectorHint: "input[type='file']",
      locatorFactory: (root) => root.locator("input[type='file']")
    },
    {
      key: "media-input-accept-image-video",
      selectorHint: "input[accept*='image'], input[accept*='video']",
      locatorFactory: (root) =>
        root.locator("input[accept*='image'], input[accept*='video']")
    }
  ];
}

function createPageMediaInputCandidates(): SelectorCandidate[] {
  return [
    {
      key: "page-media-input-file",
      selectorHint: "input[type='file']",
      locatorFactory: (page) => page.locator("input[type='file']")
    },
    {
      key: "page-media-input-accept-image-video",
      selectorHint: "input[accept*='image'], input[accept*='video']",
      locatorFactory: (page) =>
        page.locator("input[accept*='image'], input[accept*='video']")
    }
  ];
}

function createPollButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const labels = getPostUiActionLabels("poll", selectorLocale);
  const pollRegex = buildTextRegex(labels);
  const pollExactRegex = buildTextRegex(labels, true);
  const pollAriaSelector = buildAriaLabelContainsSelector(
    ["button", "[role='button']"],
    labels
  );

  return [
    {
      key: "poll-button-role-exact",
      selectorHint: `getByRole(button, ${pollExactRegex.source})`,
      locatorFactory: (root) => root.getByRole("button", { name: pollExactRegex })
    },
    {
      key: "poll-button-aria",
      selectorHint: pollAriaSelector,
      locatorFactory: (root) => root.locator(pollAriaSelector)
    },
    {
      key: "poll-button-text",
      selectorHint: `button hasText ${pollRegex.source}`,
      locatorFactory: (root) =>
        root.locator("button, [role='button']").filter({ hasText: pollRegex })
    }
  ];
}

function createPollQuestionInputCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const labels = getPostUiActionLabels("question", selectorLocale);
  const questionRegex = buildTextRegex(labels);
  const questionAriaSelector = buildAriaLabelContainsSelector(
    ["input", "textarea"],
    labels
  );

  return [
    {
      key: "poll-question-role-textbox",
      selectorHint: `getByRole(textbox, ${questionRegex.source})`,
      locatorFactory: (page) => page.getByRole("textbox", { name: questionRegex })
    },
    {
      key: "poll-question-aria",
      selectorHint: questionAriaSelector,
      locatorFactory: (page) => page.locator(questionAriaSelector)
    },
    {
      key: "poll-question-name",
      selectorHint: "input[name*='question'], textarea[name*='question']",
      locatorFactory: (page) =>
        page.locator("input[name*='question' i], textarea[name*='question' i]")
    }
  ];
}

function createPollOptionInputCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const labels = getPostUiActionLabels("option", selectorLocale);
  const optionRegex = buildTextRegex(labels);
  const optionAriaSelector = buildAriaLabelContainsSelector(
    ["input", "textarea"],
    labels
  );

  return [
    {
      key: "poll-option-role-textbox",
      selectorHint: `getByRole(textbox, ${optionRegex.source})`,
      locatorFactory: (page) => page.getByRole("textbox", { name: optionRegex })
    },
    {
      key: "poll-option-aria",
      selectorHint: optionAriaSelector,
      locatorFactory: (page) => page.locator(optionAriaSelector)
    },
    {
      key: "poll-option-name",
      selectorHint: "input[name*='option'], textarea[name*='option']",
      locatorFactory: (page) =>
        page.locator("input[name*='option' i], textarea[name*='option' i]")
    }
  ];
}

function createPollDurationSelectCandidates(): SelectorCandidate[] {
  return [
    {
      key: "poll-duration-select-labeled",
      selectorHint: "select[aria-label*='Duration'], select[name*='duration']",
      locatorFactory: (page) =>
        page.locator("select[aria-label*='Duration' i], select[name*='duration' i]")
    },
    {
      key: "poll-duration-select-generic",
      selectorHint: "select",
      locatorFactory: (page) => page.locator("select")
    }
  ];
}

function createPollDurationButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const labels = getPostUiActionLabels("duration", selectorLocale);
  const durationRegex = buildTextRegex(labels);
  const durationAriaSelector = buildAriaLabelContainsSelector(
    ["button", "[role='button']"],
    labels
  );

  return [
    {
      key: "poll-duration-button-role",
      selectorHint: `getByRole(button, ${durationRegex.source})`,
      locatorFactory: (page) => page.getByRole("button", { name: durationRegex })
    },
    {
      key: "poll-duration-button-aria",
      selectorHint: durationAriaSelector,
      locatorFactory: (page) => page.locator(durationAriaSelector)
    }
  ];
}

function createPollDurationOptionCandidates(
  durationDays: LinkedInPollDurationDays,
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const labels = formatPollDurationLabels(durationDays, selectorLocale);
  const durationRegex = buildTextRegex(labels);
  const durationExactRegex = buildTextRegex(labels, true);

  return [
    {
      key: "poll-duration-option-menuitem",
      selectorHint: `[role='menuitem'] hasText ${durationRegex.source}`,
      locatorFactory: (page) => page.locator("[role='menuitem']").filter({ hasText: durationRegex })
    },
    {
      key: "poll-duration-option-role",
      selectorHint: `getByRole(option, ${durationExactRegex.source})`,
      locatorFactory: (page) => page.getByRole("option", { name: durationExactRegex })
    },
    {
      key: "poll-duration-option-generic",
      selectorHint: `button, li hasText ${durationRegex.source}`,
      locatorFactory: (page) =>
        page.locator("button, li, div[role='button']").filter({ hasText: durationRegex })
    }
  ];
}

function createComposerCloseButtonCandidates(
  selectorLocale: LinkedInSelectorLocale
): ScopedSelectorCandidate[] {
  const closeRegex = buildLinkedInSelectorPhraseRegex(
    ["dismiss", "close"],
    selectorLocale
  );
  const closeRegexHint = formatLinkedInSelectorRegexHint(
    ["dismiss", "close"],
    selectorLocale
  );
  const closeAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    ["dismiss", "close"],
    selectorLocale
  );

  return [
    {
      key: "role-button-dismiss",
      selectorHint: `getByRole(button, ${closeRegexHint})`,
      locatorFactory: (root) => root.getByRole("button", { name: closeRegex })
    },
    {
      key: "aria-dismiss-close",
      selectorHint: closeAriaSelector,
      locatorFactory: (root) => root.locator(closeAriaSelector)
    }
  ];
}

function createDiscardDialogCandidates(
  selectorLocale: LinkedInSelectorLocale
): SelectorCandidate[] {
  const discardRegex = buildLinkedInSelectorPhraseRegex(
    ["discard", "leave"],
    selectorLocale
  );
  const discardRegexHint = formatLinkedInSelectorRegexHint(
    ["discard", "leave"],
    selectorLocale
  );

  return [
    {
      key: "role-button-discard",
      selectorHint: `getByRole(button, ${discardRegexHint})`,
      locatorFactory: (page) => page.getByRole("button", { name: discardRegex })
    },
    {
      key: "button-text-discard",
      selectorHint: `button hasText ${discardRegexHint}`,
      locatorFactory: (page) => page.locator("button").filter({ hasText: discardRegex })
    }
  ];
}

async function openPostComposer(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<{ composerRoot: Locator; triggerKey: string; rootKey: string }> {
  await page.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  const triggerCandidates = createComposeTriggerCandidates(selectorLocale);
  const visibleTrigger = await findOptionalVisibleLocator(page, triggerCandidates);
  if (!visibleTrigger) {
    await waitForFeedSurface(page);
  }

  const trigger =
    visibleTrigger ??
    (await findVisibleLocatorOrThrow(
      page,
      triggerCandidates,
      "post_composer_trigger",
      artifactPaths
    ));
  await trigger.locator.click({ timeout: 5_000 });

  const root = await findVisibleLocatorOrThrow(
    page,
    createComposerRootCandidates(selectorLocale),
    "post_composer_root",
    artifactPaths
  );

  return {
    composerRoot: root.locator,
    triggerKey: trigger.key,
    rootKey: root.key
  };
}

async function closeComposerBestEffort(
  page: Page,
  composerRoot: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const closeButton = await findOptionalScopedLocator(
    composerRoot,
    createComposerCloseButtonCandidates(selectorLocale)
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
    createDiscardDialogCandidates(selectorLocale)
  );
  if (discardButton) {
    await discardButton.locator.click({ timeout: 2_000 }).catch(() => undefined);
  }

  await waitForCondition(async () => !(await isAnyLocatorVisible(composerRoot)), 5_000);
}

async function setComposerText(
  page: Page,
  composerRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
  text: string,
  artifactPaths: string[]
): Promise<string> {
  const composerInput = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createComposerInputCandidates(selectorLocale),
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
  selectorLocale: LinkedInSelectorLocale,
  visibility: LinkedInPostVisibility,
  artifactPaths: string[]
): Promise<string> {
  const audienceLabel = LINKEDIN_POST_VISIBILITY_MAP[visibility].audienceLabel;
  const visibilityButton = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createVisibilityButtonCandidates(selectorLocale),
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
    createVisibilityOptionCandidates(visibility, selectorLocale),
    "post_visibility_option",
    artifactPaths
  );
  await option.locator.click({ timeout: 5_000 });

  const doneButton = await findOptionalVisibleLocator(
    page,
    createVisibilityDoneButtonCandidates(selectorLocale)
  );
  if (doneButton) {
    await doneButton.locator.click({ timeout: 5_000 });
  }

  const updated = await waitForCondition(async () => {
    const nextButton = await findOptionalScopedLocator(
      composerRoot,
      createVisibilityButtonCandidates(selectorLocale)
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

async function waitForVisibleDialog(page: Page): Promise<Locator> {
  const dialog = page.locator("[role='dialog']").last();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

async function setTextInputValue(
  page: Page,
  locator: Locator,
  value: string
): Promise<void> {
  await locator.click({ timeout: 5_000 });

  try {
    await locator.fill(value, { timeout: 5_000 });
  } catch {
    await locator.press("Control+A").catch(() => undefined);
    await locator.press("Meta+A").catch(() => undefined);
    await locator.press("Backspace").catch(() => undefined);
    await page.keyboard.insertText(value);
  }
}

async function findTargetPostLocator(
  page: Page,
  postUrl: string,
  artifactPaths: string[]
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

  const resolved = await findVisibleLocatorOrThrow(
    page,
    candidates,
    "post_root",
    artifactPaths
  );

  return {
    locator: resolved.locator,
    key: resolved.key,
    postIdentity,
    activityId
  };
}

async function openTargetPostActionMenu(
  page: Page,
  targetPost: TargetPostLocator,
  selectorLocale: LinkedInSelectorLocale,
  artifactPaths: string[]
): Promise<string> {
  const menuButton = await findVisibleScopedLocatorOrThrow(
    targetPost.locator,
    createPostMenuButtonCandidates(selectorLocale),
    "post_action_menu_button",
    artifactPaths,
    page.url()
  );

  await menuButton.locator.click({ timeout: 5_000 });
  const menuOpened = await waitForCondition(
    async () =>
      isAnyLocatorVisible(page.locator("[role='menu'], .artdeco-dropdown__content-inner")),
    5_000
  );

  if (!menuOpened) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not open the LinkedIn post action menu.",
      {
        current_url: page.url(),
        selector_key: menuButton.key,
        artifact_paths: artifactPaths
      }
    );
  }

  return menuButton.key;
}

async function attachMediaToComposer(
  page: Page,
  composerRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
  attachments: ValidatedMediaAttachment[],
  artifactPaths: string[]
): Promise<{ mediaButtonKey: string | null; mediaInputKey: string }> {
  let mediaButtonKey: string | null = null;
  let mediaInput = await findPresentScopedLocator(
    composerRoot,
    createMediaInputCandidates()
  );

  if (!mediaInput) {
    const mediaButton = await findVisibleScopedLocatorOrThrow(
      composerRoot,
      createMediaButtonCandidates(selectorLocale),
      "post_media_button",
      artifactPaths,
      page.url()
    );

    mediaButtonKey = mediaButton.key;
    await mediaButton.locator.click({ timeout: 5_000 });

    mediaInput =
      (await findPresentScopedLocator(composerRoot, createMediaInputCandidates())) ??
      (await findPresentLocatorOrThrow(
        page,
        createPageMediaInputCandidates(),
        "post_media_input",
        artifactPaths
      ));
  }

  await mediaInput.locator.setInputFiles(
    attachments.map((attachment) => attachment.absolutePath)
  );
  await waitForNetworkIdleBestEffort(page, 10_000).catch(() => undefined);

  const attachmentsReady = await waitForCondition(async () => {
    const previewLocator = composerRoot.locator(
      ".share-preview, .share-box__preview, .share-image, img, video, [data-test-id*='media']"
    );
    const publishButton = await findOptionalScopedLocator(
      composerRoot,
      createPublishButtonCandidates(selectorLocale)
    );
    const publishEnabled = publishButton
      ? await publishButton.locator.isEnabled().catch(() => false)
      : false;
    return publishEnabled || (await hasAnyLocator(previewLocator));
  }, 12_000);

  if (!attachmentsReady) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "LinkedIn media attachments did not appear ready in the composer.",
      {
        current_url: page.url(),
        media_paths: attachments.map((attachment) => attachment.path),
        artifact_paths: artifactPaths
      }
    );
  }

  return {
    mediaButtonKey,
    mediaInputKey: mediaInput.key
  };
}

async function resolvePollOptionInput(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  optionIndex: number,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of createPollOptionInputCandidates(selectorLocale)) {
    const locator = candidate.locatorFactory(page);
    const count = await locator.count().catch(() => 0);
    if (count <= optionIndex) {
      continue;
    }

    const resolved = locator.nth(optionIndex);
    try {
      await resolved.waitFor({ state: "visible", timeout: 2_500 });
      return {
        locator: resolved,
        key: `${candidate.key}-${optionIndex}`
      };
    } catch {
      // Try next candidate collection.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn poll option input ${optionIndex + 1}.`,
    {
      current_url: page.url(),
      option_index: optionIndex,
      artifact_paths: artifactPaths
    }
  );
}

async function setPollDuration(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  durationDays: LinkedInPollDurationDays,
  artifactPaths: string[]
): Promise<string | null> {
  const durationSelect = await findPresentLocatorCollection(
    page,
    createPollDurationSelectCandidates()
  );
  if (durationSelect) {
    const select = durationSelect.locator.first();
    const labels = formatPollDurationLabels(durationDays, selectorLocale);
    for (const label of labels) {
      try {
        await select.selectOption({ label });
        return durationSelect.key;
      } catch {
        // Try next label.
      }
    }

    for (const value of [String(durationDays), `${durationDays}_days`]) {
      try {
        await select.selectOption({ value });
        return durationSelect.key;
      } catch {
        // Try next value.
      }
    }
  }

  const durationButton = await findOptionalVisibleLocator(
    page,
    createPollDurationButtonCandidates(selectorLocale)
  );
  if (!durationButton) {
    if (durationDays === 7) {
      return null;
    }

    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not locate LinkedIn poll duration control for ${durationDays} days.`,
      {
        current_url: page.url(),
        duration_days: durationDays,
        artifact_paths: artifactPaths
      }
    );
  }

  await durationButton.locator.click({ timeout: 5_000 });
  const durationOption = await findVisibleLocatorOrThrow(
    page,
    createPollDurationOptionCandidates(durationDays, selectorLocale),
    "poll_duration_option",
    artifactPaths
  );
  await durationOption.locator.click({ timeout: 5_000 });
  return durationButton.key;
}

async function fillPollComposerFields(
  page: Page,
  composerRoot: Locator,
  selectorLocale: LinkedInSelectorLocale,
  question: string,
  options: string[],
  durationDays: LinkedInPollDurationDays,
  artifactPaths: string[]
): Promise<{
  pollButtonKey: string;
  questionInputKey: string;
  optionInputKeys: string[];
  durationKey: string | null;
}> {
  const pollButton = await findVisibleScopedLocatorOrThrow(
    composerRoot,
    createPollButtonCandidates(selectorLocale),
    "post_poll_button",
    artifactPaths,
    page.url()
  );
  await pollButton.locator.click({ timeout: 5_000 });

  const questionInput = await findVisibleLocatorOrThrow(
    page,
    createPollQuestionInputCandidates(selectorLocale),
    "poll_question_input",
    artifactPaths
  );
  await setTextInputValue(page, questionInput.locator, question);

  const optionInputKeys: string[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const optionInput = await resolvePollOptionInput(
      page,
      selectorLocale,
      index,
      artifactPaths
    );
    await setTextInputValue(page, optionInput.locator, options[index] ?? "");
    optionInputKeys.push(optionInput.key);
  }

  const durationKey = await setPollDuration(
    page,
    selectorLocale,
    durationDays,
    artifactPaths
  );

  return {
    pollButtonKey: pollButton.key,
    questionInputKey: questionInput.key,
    optionInputKeys,
    durationKey
  };
}

async function extractPostSnippetFromLocator(targetPost: Locator): Promise<string> {
  const text = normalizeText(await targetPost.innerText().catch(() => ""));
  return createVerificationSnippet(text);
}

async function verifyUpdatedPostAtUrl(
  page: Page,
  postUrl: string,
  text: string,
  artifactPaths: string[]
): Promise<{ verified: true; postUrl: string }> {
  const snippet = createVerificationSnippet(text);
  if (!snippet) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Cannot verify an updated post with empty text content."
    );
  }

  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);

  const verified = await waitForCondition(async () => {
    const postRoot = await findVisiblePostBySnippet(page, snippet);
    return postRoot !== null;
  }, 12_000);

  if (!verified) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Edited LinkedIn post could not be verified.",
      {
        post_url: postUrl,
        verification_snippet: snippet,
        artifact_paths: artifactPaths
      }
    );
  }

  return {
    verified: true,
    postUrl
  };
}

async function verifyDeletedPostAtUrl(
  page: Page,
  postUrl: string,
  previousSnippet: string,
  artifactPaths: string[]
): Promise<{ verified: true; postUrl: string }> {
  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);

  const deleted = await waitForCondition(async () => {
    if (!previousSnippet) {
      return !page.url().startsWith(postUrl);
    }

    const postRoot = await findVisiblePostBySnippet(page, previousSnippet);
    return postRoot === null;
  }, 12_000);

  if (!deleted) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Deleted LinkedIn post could not be verified.",
      {
        post_url: postUrl,
        verification_snippet: previousSnippet,
        artifact_paths: artifactPaths
      }
    );
  }

  return {
    verified: true,
    postUrl
  };
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

type PublishedPostVerificationSurface = "feed" | "profile_activity";

async function locatePublishedPostOnSurface(
  page: Page,
  snippet: string,
  surface: PublishedPostVerificationSurface
): Promise<Locator | null> {
  if (surface === "feed") {
    if (!page.url().startsWith(LINKEDIN_FEED_URL)) {
      await page.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);
    }
    await page.evaluate(() => {
      globalThis.scrollTo({ top: 0, behavior: "auto" });
    });
    await waitForFeedSurface(page);
    return findVisiblePostBySnippet(page, snippet);
  }

  await page.goto(LINKEDIN_PROFILE_ACTIVITY_URL, {
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page);
  await page.evaluate(() => {
    globalThis.scrollTo({ top: 0, behavior: "auto" });
  });
  await waitForProfileActivitySurface(page);
  return findVisiblePostBySnippet(page, snippet);
}

export async function verifyPublishedPost(
  page: Page,
  text: string,
  artifactPaths: string[]
): Promise<{
  verified: true;
  postUrl: string | null;
  surface: PublishedPostVerificationSurface;
}> {
  const snippet = createVerificationSnippet(text);
  if (!snippet) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Cannot verify a post with empty text content."
    );
  }

  const surfaces: readonly PublishedPostVerificationSurface[] = [
    "feed",
    "profile_activity"
  ];
  let locatedSurface: PublishedPostVerificationSurface | null = null;
  let postRoot: Locator | null = null;
  for (const surface of surfaces) {
    postRoot = await locatePublishedPostOnSurface(page, snippet, surface);
    if (postRoot) {
      locatedSurface = surface;
      break;
    }
  }

  if (!postRoot) {
    const verified = await waitForCondition(async () => {
      for (const surface of surfaces) {
        const located = await locatePublishedPostOnSurface(page, snippet, surface);
        if (located) {
          postRoot = located;
          locatedSurface = surface;
          return true;
        }
      }

      return false;
    }, 12_000);

    if (!verified) {
      throw new LinkedInAssistantError(
        "UNKNOWN",
        "Published LinkedIn post could not be verified on LinkedIn.",
        {
          current_url: page.url(),
          verification_snippet: snippet,
          artifact_paths: artifactPaths,
          verification_urls: [LINKEDIN_FEED_URL, LINKEDIN_PROFILE_ACTIVITY_URL]
        }
      );
    }
  }

  return {
    verified: true,
    postUrl: await extractPublishedPostUrl(page, postRoot),
    surface: locatedSurface ?? "feed"
  };
}

export class LinkedInPostsService {
  constructor(private readonly runtime: LinkedInPostsRuntime) {}

  async prepareCreate(
    input: PrepareCreatePostInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const lintResult = await lintLinkedInPostContent(
      input.text,
      this.runtime.postSafetyLint
    );
    const validatedText = lintResult.validatedText;
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
              this.runtime.selectorLocale,
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

            await closeComposerBestEffort(
              page,
              composerRoot,
              this.runtime.selectorLocale
            );

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
                max_length: this.runtime.postSafetyLint.maxLength,
                linkedin_max_length: LINKEDIN_POST_MAX_LENGTH,
                contains_url: validatedText.containsUrl,
                contains_mention: validatedText.containsMention,
                contains_hashtag: validatedText.containsHashtag,
                checked_url_count: lintResult.urls.length,
                checked_urls: lintResult.urls,
                banned_phrase_count: this.runtime.postSafetyLint.bannedPhrases.length,
                link_preview_validation_enabled:
                  this.runtime.postSafetyLint.validateLinkPreviews,
                link_preview_validation_timeout_ms:
                  this.runtime.postSafetyLint.linkPreviewValidationTimeoutMs
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

  async prepareCreateMedia(
    input: PrepareCreateMediaPostInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const lintResult = await lintLinkedInPostContent(
      input.text,
      this.runtime.postSafetyLint
    );
    const validatedText = lintResult.validatedText;
    const attachments = validateLinkedInPostMediaAttachments(input.mediaPaths);
    const visibility = normalizeLinkedInPostVisibility(input.visibility, "public");
    const tracePath = `linkedin/trace-post-media-prepare-${Date.now()}.zip`;
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
              this.runtime.selectorLocale,
              artifactPaths
            );
            const mediaSurface =
              (await findPresentScopedLocator(
                composerRoot,
                createMediaInputCandidates()
              )) ??
              (await findOptionalScopedLocator(
                composerRoot,
                createMediaButtonCandidates(this.runtime.selectorLocale)
              ));

            if (!mediaSurface) {
              throw new LinkedInAssistantError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Could not locate LinkedIn media controls in the post composer.",
                {
                  current_url: page.url(),
                  artifact_paths: artifactPaths
                }
              );
            }

            const screenshotPath = `linkedin/screenshot-post-media-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_create_media_post",
              profile_name: profileName,
              visibility,
              trigger_selector_key: triggerKey,
              composer_selector_key: rootKey,
              media_surface_selector_key: mediaSurface.key
            });
            artifactPaths.push(screenshotPath);

            await closeComposerBestEffort(
              page,
              composerRoot,
              this.runtime.selectorLocale
            );

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
              summary: `Create ${LINKEDIN_POST_VISIBILITY_MAP[visibility].label.toLowerCase()} LinkedIn media post`,
              target,
              outbound: {
                text: validatedText.normalizedText,
                media: attachments.map((attachment) => ({
                  path: attachment.path,
                  file_name: attachment.fileName,
                  kind: attachment.kind,
                  size_bytes: attachment.sizeBytes
                }))
              },
              validation: {
                character_count: validatedText.characterCount,
                line_count: validatedText.lineCount,
                paragraph_count: validatedText.paragraphCount,
                max_length: this.runtime.postSafetyLint.maxLength,
                linkedin_max_length: LINKEDIN_POST_MAX_LENGTH,
                contains_url: validatedText.containsUrl,
                contains_mention: validatedText.containsMention,
                contains_hashtag: validatedText.containsHashtag,
                checked_url_count: lintResult.urls.length,
                checked_urls: lintResult.urls,
                banned_phrase_count: this.runtime.postSafetyLint.bannedPhrases.length,
                link_preview_validation_enabled:
                  this.runtime.postSafetyLint.validateLinkPreviews,
                link_preview_validation_timeout_ms:
                  this.runtime.postSafetyLint.linkPreviewValidationTimeoutMs,
                media_count: attachments.length,
                media_kind: attachments[0]?.kind ?? null
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: CREATE_MEDIA_POST_ACTION_TYPE,
              target,
              payload: {
                text: validatedText.normalizedText,
                visibility,
                media_paths: attachments.map((attachment) => attachment.absolutePath)
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-post-media-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_create_media_post_error",
                profile_name: profileName,
                visibility
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn media post creation.",
              {
                profile_name: profileName,
                current_url: page.url(),
                requested_visibility: visibility,
                artifact_paths: artifactPaths
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_media_post",
                  profile_name: profileName,
                  visibility
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.post.prepare_media.trace.stop_failed",
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
        "Failed to prepare LinkedIn media post creation.",
        {
          profile_name: profileName,
          requested_visibility: visibility,
          artifact_paths: artifactPaths
        }
      );
    }
  }

  async prepareCreatePoll(
    input: PrepareCreatePollPostInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const lintResult = await lintOptionalLinkedInPostContent(
      input.text,
      this.runtime.postSafetyLint
    );
    const question = normalizePollQuestion(input.question);
    const options = normalizePollOptions(input.options);
    const durationDays = normalizePollDurationDays(input.durationDays);
    const visibility = normalizeLinkedInPostVisibility(input.visibility, "public");
    const tracePath = `linkedin/trace-post-poll-prepare-${Date.now()}.zip`;
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
              this.runtime.selectorLocale,
              artifactPaths
            );
            const pollButton = await findVisibleScopedLocatorOrThrow(
              composerRoot,
              createPollButtonCandidates(this.runtime.selectorLocale),
              "post_poll_button",
              artifactPaths,
              page.url()
            );

            const screenshotPath = `linkedin/screenshot-post-poll-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_create_poll_post",
              profile_name: profileName,
              visibility,
              trigger_selector_key: triggerKey,
              composer_selector_key: rootKey,
              poll_button_selector_key: pollButton.key
            });
            artifactPaths.push(screenshotPath);

            await closeComposerBestEffort(
              page,
              composerRoot,
              this.runtime.selectorLocale
            );

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
              summary: `Create ${LINKEDIN_POST_VISIBILITY_MAP[visibility].label.toLowerCase()} LinkedIn poll post`,
              target,
              outbound: {
                ...(lintResult
                  ? { text: lintResult.validatedText.normalizedText }
                  : {}),
                question,
                options,
                duration_days: durationDays
              },
              validation: {
                text_provided: lintResult !== null,
                ...(lintResult
                  ? {
                      character_count: lintResult.validatedText.characterCount,
                      line_count: lintResult.validatedText.lineCount,
                      paragraph_count: lintResult.validatedText.paragraphCount,
                      contains_url: lintResult.validatedText.containsUrl,
                      contains_mention: lintResult.validatedText.containsMention,
                      contains_hashtag: lintResult.validatedText.containsHashtag,
                      checked_url_count: lintResult.urls.length,
                      checked_urls: lintResult.urls
                    }
                  : {}),
                max_length: this.runtime.postSafetyLint.maxLength,
                linkedin_max_length: LINKEDIN_POST_MAX_LENGTH,
                banned_phrase_count: this.runtime.postSafetyLint.bannedPhrases.length,
                link_preview_validation_enabled:
                  this.runtime.postSafetyLint.validateLinkPreviews,
                link_preview_validation_timeout_ms:
                  this.runtime.postSafetyLint.linkPreviewValidationTimeoutMs,
                poll_option_count: options.length,
                poll_duration_days: durationDays
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: CREATE_POLL_POST_ACTION_TYPE,
              target,
              payload: {
                ...(lintResult ? { text: lintResult.validatedText.normalizedText } : {}),
                question,
                options,
                duration_days: durationDays,
                visibility
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-post-poll-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_create_poll_post_error",
                profile_name: profileName,
                visibility
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(
              error,
              "Failed to prepare LinkedIn poll post creation.",
              {
                profile_name: profileName,
                current_url: page.url(),
                requested_visibility: visibility,
                artifact_paths: artifactPaths
              }
            );
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_create_poll_post",
                  profile_name: profileName,
                  visibility
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.post.prepare_poll.trace.stop_failed",
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
        "Failed to prepare LinkedIn poll post creation.",
        {
          profile_name: profileName,
          requested_visibility: visibility,
          artifact_paths: artifactPaths
        }
      );
    }
  }

  async prepareEdit(input: PrepareEditPostInput): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const lintResult = await lintLinkedInPostContent(
      input.text,
      this.runtime.postSafetyLint
    );
    const validatedText = lintResult.validatedText;
    const tracePath = `linkedin/trace-post-edit-prepare-${Date.now()}.zip`;
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

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);

            const targetPost = await findTargetPostLocator(page, postUrl, artifactPaths);
            const currentSnippet = await extractPostSnippetFromLocator(targetPost.locator);
            const menuButtonKey = await openTargetPostActionMenu(
              page,
              targetPost,
              this.runtime.selectorLocale,
              artifactPaths
            );
            const editAction = await findVisibleLocatorOrThrow(
              page,
              createPostMenuActionCandidates(
                getPostUiActionLabels("edit", this.runtime.selectorLocale),
                "post-edit"
              ),
              "post_edit_menu_item",
              artifactPaths
            );

            const screenshotPath = `linkedin/screenshot-post-edit-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_edit_post",
              profile_name: profileName,
              post_url: postUrl,
              target_post_selector_key: targetPost.key,
              menu_button_selector_key: menuButtonKey,
              edit_selector_key: editAction.key
            });
            artifactPaths.push(screenshotPath);
            await page.keyboard.press("Escape").catch(() => undefined);

            const rateLimitState = this.runtime.rateLimiter.peek(
              EDIT_POST_RATE_LIMIT_CONFIG
            );
            const target = {
              profile_name: profileName,
              post_url: postUrl,
              current_verification_snippet: currentSnippet
            };

            const preview = {
              summary: `Edit LinkedIn post ${postUrl}`,
              target,
              outbound: {
                text: validatedText.normalizedText
              },
              validation: {
                character_count: validatedText.characterCount,
                line_count: validatedText.lineCount,
                paragraph_count: validatedText.paragraphCount,
                max_length: this.runtime.postSafetyLint.maxLength,
                linkedin_max_length: LINKEDIN_POST_MAX_LENGTH,
                contains_url: validatedText.containsUrl,
                contains_mention: validatedText.containsMention,
                contains_hashtag: validatedText.containsHashtag,
                checked_url_count: lintResult.urls.length,
                checked_urls: lintResult.urls,
                banned_phrase_count: this.runtime.postSafetyLint.bannedPhrases.length,
                link_preview_validation_enabled:
                  this.runtime.postSafetyLint.validateLinkPreviews,
                link_preview_validation_timeout_ms:
                  this.runtime.postSafetyLint.linkPreviewValidationTimeoutMs
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: EDIT_POST_ACTION_TYPE,
              target,
              payload: {
                post_url: postUrl,
                text: validatedText.normalizedText
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-post-edit-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_edit_post_error",
                profile_name: profileName,
                post_url: postUrl
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(error, "Failed to prepare LinkedIn post edit.", {
              profile_name: profileName,
              current_url: page.url(),
              post_url: postUrl,
              artifact_paths: artifactPaths
            });
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_edit_post",
                  profile_name: profileName,
                  post_url: postUrl
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.post.prepare_edit.trace.stop_failed",
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
      throw toAutomationError(error, "Failed to prepare LinkedIn post edit.", {
        profile_name: profileName,
        post_url: postUrl,
        artifact_paths: artifactPaths
      });
    }
  }

  async prepareDelete(
    input: PrepareDeletePostInput
  ): Promise<PreparedActionResult> {
    const profileName = input.profileName ?? "default";
    const postUrl = resolvePostUrl(input.postUrl);
    const tracePath = `linkedin/trace-post-delete-prepare-${Date.now()}.zip`;
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

            await page.goto(postUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);

            const targetPost = await findTargetPostLocator(page, postUrl, artifactPaths);
            const currentSnippet = await extractPostSnippetFromLocator(targetPost.locator);
            const menuButtonKey = await openTargetPostActionMenu(
              page,
              targetPost,
              this.runtime.selectorLocale,
              artifactPaths
            );
            const deleteAction = await findVisibleLocatorOrThrow(
              page,
              createPostMenuActionCandidates(
                getPostUiActionLabels("delete", this.runtime.selectorLocale),
                "post-delete"
              ),
              "post_delete_menu_item",
              artifactPaths
            );

            const screenshotPath = `linkedin/screenshot-post-delete-prepare-${Date.now()}.png`;
            await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
              action: "prepare_delete_post",
              profile_name: profileName,
              post_url: postUrl,
              target_post_selector_key: targetPost.key,
              menu_button_selector_key: menuButtonKey,
              delete_selector_key: deleteAction.key
            });
            artifactPaths.push(screenshotPath);
            await page.keyboard.press("Escape").catch(() => undefined);

            const rateLimitState = this.runtime.rateLimiter.peek(
              DELETE_POST_RATE_LIMIT_CONFIG
            );
            const target = {
              profile_name: profileName,
              post_url: postUrl,
              current_verification_snippet: currentSnippet
            };

            const preview = {
              summary: `Delete LinkedIn post ${postUrl}`,
              target,
              outbound: {
                destructive: true
              },
              validation: {
                destructive: true
              },
              artifacts: artifactPaths.map((path) => ({
                type: path.endsWith(".zip") ? "trace" : "screenshot",
                path
              })),
              rate_limit: formatRateLimitState(rateLimitState)
            } satisfies Record<string, unknown>;

            return this.runtime.twoPhaseCommit.prepare({
              actionType: DELETE_POST_ACTION_TYPE,
              target,
              payload: {
                post_url: postUrl
              },
              preview,
              ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
            });
          } catch (error) {
            const failureScreenshot = `linkedin/screenshot-post-delete-prepare-error-${Date.now()}.png`;
            try {
              await captureScreenshotArtifact(this.runtime, page, failureScreenshot, {
                action: "prepare_delete_post_error",
                profile_name: profileName,
                post_url: postUrl
              });
              artifactPaths.push(failureScreenshot);
            } catch {
              // Best effort.
            }

            throw toAutomationError(error, "Failed to prepare LinkedIn post deletion.", {
              profile_name: profileName,
              current_url: page.url(),
              post_url: postUrl,
              artifact_paths: artifactPaths
            });
          } finally {
            if (tracingStarted) {
              try {
                const absoluteTracePath = this.runtime.artifacts.resolve(tracePath);
                await context.tracing.stop({ path: absoluteTracePath });
                registerTraceArtifact(this.runtime, tracePath, {
                  action: "prepare_delete_post",
                  profile_name: profileName,
                  post_url: postUrl
                });
              } catch (error) {
                this.runtime.logger.log(
                  "warn",
                  "linkedin.post.prepare_delete.trace.stop_failed",
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
      throw toAutomationError(error, "Failed to prepare LinkedIn post deletion.", {
        profile_name: profileName,
        post_url: postUrl,
        artifact_paths: artifactPaths
      });
    }
  }
}

function getOptionalStringField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} has invalid ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key
    }
  );
}

function getRequiredStringArrayField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): string[] {
  const value = source[key];
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return value.map((entry) => entry.trim());
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

function getRequiredIntegerField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): number {
  const value = source[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
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
            runtime.selectorLocale,
            artifactPaths
          );
          const visibilityKey = await setPostVisibility(
            page,
            composerRoot,
            runtime.selectorLocale,
            visibility,
            artifactPaths
          );
          const inputKey = await setComposerText(
            page,
            composerRoot,
            runtime.selectorLocale,
            text,
            artifactPaths
          );

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
            createPublishButtonCandidates(runtime.selectorLocale),
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
            published_post_url: verification.postUrl,
            verification_surface: verification.surface
          });
          artifactPaths.push(postPublishScreenshot);

          return {
            ok: true,
            result: {
              posted: true,
              visibility,
              verification_snippet: createVerificationSnippet(text),
              published_post_url: verification.postUrl,
              verification_surface: verification.surface,
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

class CreateMediaPostActionExecutor
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
    const mediaPaths = getRequiredStringArrayField(
      action.payload,
      "media_paths",
      action.id,
      "payload"
    );
    const attachments = validateLinkedInPostMediaAttachments(mediaPaths);
    const tracePath = `linkedin/trace-post-media-confirm-${Date.now()}.zip`;
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
              "LinkedIn create_media_post confirm is rate limited for the current window.",
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
            runtime.selectorLocale,
            artifactPaths
          );
          const visibilityKey = await setPostVisibility(
            page,
            composerRoot,
            runtime.selectorLocale,
            visibility,
            artifactPaths
          );
          const inputKey = await setComposerText(
            page,
            composerRoot,
            runtime.selectorLocale,
            text,
            artifactPaths
          );
          const { mediaButtonKey, mediaInputKey } = await attachMediaToComposer(
            page,
            composerRoot,
            runtime.selectorLocale,
            attachments,
            artifactPaths
          );

          const prePublishScreenshot = `linkedin/screenshot-post-media-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, prePublishScreenshot, {
            action: CREATE_MEDIA_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            trigger_selector_key: triggerKey,
            composer_selector_key: rootKey,
            visibility_selector_key: visibilityKey,
            input_selector_key: inputKey,
            media_button_selector_key: mediaButtonKey,
            media_input_selector_key: mediaInputKey,
            media_count: attachments.length,
            media_kind: attachments[0]?.kind ?? null
          });
          artifactPaths.push(prePublishScreenshot);

          const publishButton = await findVisibleScopedLocatorOrThrow(
            composerRoot,
            createPublishButtonCandidates(runtime.selectorLocale),
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
              "LinkedIn publish button was not enabled after entering post content and media attachments.",
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
          await waitForCondition(
            async () => !(await isAnyLocatorVisible(composerRoot)),
            10_000
          );
          await waitForNetworkIdleBestEffort(page, 10_000);

          const verification = await verifyPublishedPost(page, text, artifactPaths);

          const postPublishScreenshot = `linkedin/screenshot-post-media-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postPublishScreenshot, {
            action: CREATE_MEDIA_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            published_post_url: verification.postUrl,
            verification_surface: verification.surface,
            media_count: attachments.length,
            media_kind: attachments[0]?.kind ?? null
          });
          artifactPaths.push(postPublishScreenshot);

          return {
            ok: true,
            result: {
              posted: true,
              post_kind: "media",
              visibility,
              media_count: attachments.length,
              media_kind: attachments[0]?.kind ?? null,
              verification_snippet: createVerificationSnippet(text),
              published_post_url: verification.postUrl,
              verification_surface: verification.surface,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-post-media-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${CREATE_MEDIA_POST_ACTION_TYPE}_error`,
              profile_name: profileName,
              visibility
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(
            error,
            "Failed to execute LinkedIn create_media_post action.",
            {
              action_id: action.id,
              profile_name: profileName,
              current_url: page.url(),
              requested_visibility: visibility,
              artifact_paths: artifactPaths
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: CREATE_MEDIA_POST_ACTION_TYPE,
                profile_name: profileName,
                visibility
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.post.confirm_media.trace.stop_failed", {
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

class CreatePollPostActionExecutor
  implements ActionExecutor<LinkedInPostsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPostsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const text = getOptionalStringField(action.payload, "text", action.id, "payload");
    const question = getRequiredStringField(action.payload, "question", action.id, "payload");
    const options = getRequiredStringArrayField(
      action.payload,
      "options",
      action.id,
      "payload"
    );
    const durationDays = normalizePollDurationDays(
      getRequiredIntegerField(action.payload, "duration_days", action.id, "payload")
    );
    const visibility = normalizeLinkedInPostVisibility(
      getRequiredStringField(action.payload, "visibility", action.id, "payload"),
      "public"
    );
    const verificationText = text ?? question;
    const tracePath = `linkedin/trace-post-poll-confirm-${Date.now()}.zip`;
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
              "LinkedIn create_poll_post confirm is rate limited for the current window.",
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
            runtime.selectorLocale,
            artifactPaths
          );
          const visibilityKey = await setPostVisibility(
            page,
            composerRoot,
            runtime.selectorLocale,
            visibility,
            artifactPaths
          );
          const inputKey = text
            ? await setComposerText(
                page,
                composerRoot,
                runtime.selectorLocale,
                text,
                artifactPaths
              )
            : null;
          const pollFields = await fillPollComposerFields(
            page,
            composerRoot,
            runtime.selectorLocale,
            question,
            options,
            durationDays,
            artifactPaths
          );

          const prePublishScreenshot = `linkedin/screenshot-post-poll-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, prePublishScreenshot, {
            action: CREATE_POLL_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            trigger_selector_key: triggerKey,
            composer_selector_key: rootKey,
            visibility_selector_key: visibilityKey,
            input_selector_key: inputKey,
            poll_button_selector_key: pollFields.pollButtonKey,
            poll_question_selector_key: pollFields.questionInputKey,
            poll_option_selector_keys: pollFields.optionInputKeys,
            poll_duration_selector_key: pollFields.durationKey,
            poll_option_count: options.length,
            poll_duration_days: durationDays
          });
          artifactPaths.push(prePublishScreenshot);

          const publishButton = await findVisibleScopedLocatorOrThrow(
            composerRoot,
            createPublishButtonCandidates(runtime.selectorLocale),
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
              "LinkedIn publish button was not enabled after entering poll content.",
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
          await waitForCondition(
            async () => !(await isAnyLocatorVisible(composerRoot)),
            10_000
          );
          await waitForNetworkIdleBestEffort(page, 10_000);

          const verification = await verifyPublishedPost(
            page,
            verificationText,
            artifactPaths
          );

          const postPublishScreenshot = `linkedin/screenshot-post-poll-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postPublishScreenshot, {
            action: CREATE_POLL_POST_ACTION_TYPE,
            profile_name: profileName,
            visibility,
            published_post_url: verification.postUrl,
            verification_surface: verification.surface,
            poll_option_count: options.length,
            poll_duration_days: durationDays
          });
          artifactPaths.push(postPublishScreenshot);

          return {
            ok: true,
            result: {
              posted: true,
              post_kind: "poll",
              visibility,
              poll_question: question,
              poll_option_count: options.length,
              poll_duration_days: durationDays,
              verification_snippet: createVerificationSnippet(verificationText),
              published_post_url: verification.postUrl,
              verification_surface: verification.surface,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-post-poll-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${CREATE_POLL_POST_ACTION_TYPE}_error`,
              profile_name: profileName,
              visibility
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(
            error,
            "Failed to execute LinkedIn create_poll_post action.",
            {
              action_id: action.id,
              profile_name: profileName,
              current_url: page.url(),
              requested_visibility: visibility,
              artifact_paths: artifactPaths
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: CREATE_POLL_POST_ACTION_TYPE,
                profile_name: profileName,
                visibility
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.post.confirm_poll.trace.stop_failed", {
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

class EditPostActionExecutor
  implements ActionExecutor<LinkedInPostsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPostsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = resolvePostUrl(
      getRequiredStringField(action.payload, "post_url", action.id, "payload")
    );
    const text = getRequiredStringField(action.payload, "text", action.id, "payload");
    const tracePath = `linkedin/trace-post-edit-confirm-${Date.now()}.zip`;
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

          const rateLimitState = runtime.rateLimiter.consume(EDIT_POST_RATE_LIMIT_CONFIG);
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn edit_post confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const targetPost = await findTargetPostLocator(page, postUrl, artifactPaths);
          const menuButtonKey = await openTargetPostActionMenu(
            page,
            targetPost,
            runtime.selectorLocale,
            artifactPaths
          );
          const editAction = await findVisibleLocatorOrThrow(
            page,
            createPostMenuActionCandidates(
              getPostUiActionLabels("edit", runtime.selectorLocale),
              "post-edit"
            ),
            "post_edit_menu_item",
            artifactPaths
          );
          await editAction.locator.click({ timeout: 5_000 });

          const dialog = await waitForVisibleDialog(page);
          const inputKey = await setComposerText(
            page,
            dialog,
            runtime.selectorLocale,
            text,
            artifactPaths
          );
          const saveButton = await findVisibleScopedLocatorOrThrow(
            dialog,
            createScopedSaveButtonCandidates(runtime.selectorLocale),
            "post_edit_save_button",
            artifactPaths,
            page.url()
          );

          const preSaveScreenshot = `linkedin/screenshot-post-edit-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, preSaveScreenshot, {
            action: EDIT_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            target_post_selector_key: targetPost.key,
            menu_button_selector_key: menuButtonKey,
            edit_selector_key: editAction.key,
            input_selector_key: inputKey,
            save_selector_key: saveButton.key
          });
          artifactPaths.push(preSaveScreenshot);

          const saveEnabled = await waitForCondition(async () => {
            try {
              return await saveButton.locator.isEnabled();
            } catch {
              return false;
            }
          }, 5_000);

          if (!saveEnabled) {
            throw new LinkedInAssistantError(
              "UI_CHANGED_SELECTOR_FAILED",
              "LinkedIn save button was not enabled after editing the post.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                selector_key: saveButton.key,
                artifact_paths: artifactPaths
              }
            );
          }

          await saveButton.locator.click({ timeout: 5_000 });
          await waitForCondition(async () => !(await isAnyLocatorVisible(dialog)), 10_000);
          await waitForNetworkIdleBestEffort(page, 10_000);

          const verification = await verifyUpdatedPostAtUrl(
            page,
            postUrl,
            text,
            artifactPaths
          );

          const postSaveScreenshot = `linkedin/screenshot-post-edit-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postSaveScreenshot, {
            action: EDIT_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            published_post_url: verification.postUrl
          });
          artifactPaths.push(postSaveScreenshot);

          return {
            ok: true,
            result: {
              edited: true,
              post_url: postUrl,
              verification_snippet: createVerificationSnippet(text),
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-post-edit-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${EDIT_POST_ACTION_TYPE}_error`,
              profile_name: profileName,
              post_url: postUrl
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(error, "Failed to execute LinkedIn edit_post action.", {
            action_id: action.id,
            profile_name: profileName,
            current_url: page.url(),
            post_url: postUrl,
            artifact_paths: artifactPaths
          });
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: EDIT_POST_ACTION_TYPE,
                profile_name: profileName,
                post_url: postUrl
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.post.confirm_edit.trace.stop_failed", {
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

class DeletePostActionExecutor
  implements ActionExecutor<LinkedInPostsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInPostsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const postUrl = resolvePostUrl(
      getRequiredStringField(action.payload, "post_url", action.id, "payload")
    );
    const tracePath = `linkedin/trace-post-delete-confirm-${Date.now()}.zip`;
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
            DELETE_POST_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn delete_post confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                post_url: postUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(postUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const targetPost = await findTargetPostLocator(page, postUrl, artifactPaths);
          const currentSnippet = await extractPostSnippetFromLocator(targetPost.locator);
          const menuButtonKey = await openTargetPostActionMenu(
            page,
            targetPost,
            runtime.selectorLocale,
            artifactPaths
          );
          const deleteAction = await findVisibleLocatorOrThrow(
            page,
            createPostMenuActionCandidates(
              getPostUiActionLabels("delete", runtime.selectorLocale),
              "post-delete"
            ),
            "post_delete_menu_item",
            artifactPaths
          );

          const preDeleteScreenshot = `linkedin/screenshot-post-delete-confirm-before-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, preDeleteScreenshot, {
            action: DELETE_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            target_post_selector_key: targetPost.key,
            menu_button_selector_key: menuButtonKey,
            delete_selector_key: deleteAction.key,
            current_verification_snippet: currentSnippet
          });
          artifactPaths.push(preDeleteScreenshot);

          await deleteAction.locator.click({ timeout: 5_000 });
          const dialog = await waitForVisibleDialog(page).catch(() => null);
          let confirmButtonKey: string | null = null;
          if (dialog) {
            const confirmButton = await findVisibleScopedLocatorOrThrow(
              dialog,
              createDeleteConfirmButtonCandidates(runtime.selectorLocale),
              "post_delete_confirm_button",
              artifactPaths,
              page.url()
            );
            confirmButtonKey = confirmButton.key;
            await confirmButton.locator.click({ timeout: 5_000 });
            await waitForCondition(async () => !(await isAnyLocatorVisible(dialog)), 10_000);
          }
          await waitForNetworkIdleBestEffort(page, 10_000);

          const verification = await verifyDeletedPostAtUrl(
            page,
            postUrl,
            currentSnippet,
            artifactPaths
          );

          const postDeleteScreenshot = `linkedin/screenshot-post-delete-confirm-after-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postDeleteScreenshot, {
            action: DELETE_POST_ACTION_TYPE,
            profile_name: profileName,
            post_url: postUrl,
            confirm_selector_key: confirmButtonKey,
            published_post_url: verification.postUrl
          });
          artifactPaths.push(postDeleteScreenshot);

          return {
            ok: true,
            result: {
              deleted: true,
              post_url: postUrl,
              verification_snippet: currentSnippet,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: artifactPaths
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-post-delete-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${DELETE_POST_ACTION_TYPE}_error`,
              profile_name: profileName,
              post_url: postUrl
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best effort.
          }

          throw toAutomationError(
            error,
            "Failed to execute LinkedIn delete_post action.",
            {
              action_id: action.id,
              profile_name: profileName,
              current_url: page.url(),
              post_url: postUrl,
              artifact_paths: artifactPaths
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              registerTraceArtifact(runtime, tracePath, {
                action: DELETE_POST_ACTION_TYPE,
                profile_name: profileName,
                post_url: postUrl
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.post.confirm_delete.trace.stop_failed", {
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
    [CREATE_POST_ACTION_TYPE]: new CreatePostActionExecutor(),
    [CREATE_MEDIA_POST_ACTION_TYPE]: new CreateMediaPostActionExecutor(),
    [CREATE_POLL_POST_ACTION_TYPE]: new CreatePollPostActionExecutor(),
    [EDIT_POST_ACTION_TYPE]: new EditPostActionExecutor(),
    [DELETE_POST_ACTION_TYPE]: new DeletePostActionExecutor()
  };
}
