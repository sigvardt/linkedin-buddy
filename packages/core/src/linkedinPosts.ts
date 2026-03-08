import { existsSync, readFileSync } from "node:fs";
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
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  ActionExecutorRegistry,
  PreparedActionResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_ASSISTANT_CONFIG_FILENAME = "config.json";
const DEFAULT_LINK_PREVIEW_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_LINK_PREVIEW_VALIDATION_TIMEOUT_MS = 30_000;
const LINK_PREVIEW_BODY_BYTE_LIMIT = 64 * 1024;

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
