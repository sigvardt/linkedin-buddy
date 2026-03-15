import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import { scrollLinkedInPageToBottom } from "./linkedinPage.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  createPrepareRateLimitMessage,
  formatRateLimitState,
  peekRateLimitOrThrow,
} from "./rateLimiter.js";
import type { RateLimiter } from "./rateLimiter.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService,
} from "./twoPhaseCommit.js";
import { dedupeRepeatedText, stripTitleBadgeText, cleanPostedAt, normalizeText, getOrCreatePage } from "./shared.js";

export interface LinkedInJobSearchResult {
  job_id: string;
  title: string;
  company: string;
  location: string;
  posted_at: string;
  job_url: string;
  salary_range: string;
  employment_type: string;
}

export interface LinkedInJobPosting {
  job_id: string;
  title: string;
  company: string;
  company_url: string;
  location: string;
  posted_at: string;
  description: string;
  salary_range: string;
  employment_type: string;
  job_url: string;
  applicant_count: string;
  seniority_level: string;
  is_remote: boolean;
}

export interface LinkedInJobAlert {
  alert_id: string;
  query: string;
  location: string;
  frequency: string;
  search_url: string;
  enabled: boolean;
}

export type LinkedInEasyApplyAnswerValue = string | boolean | number | string[];

export interface SearchJobsInput {
  profileName?: string;
  query: string;
  location?: string;
  limit?: number;
}

export interface ViewJobInput {
  profileName?: string;
  jobId: string;
}

export interface PrepareSaveJobInput {
  profileName?: string;
  jobId: string;
  operatorNote?: string;
}

export interface PrepareUnsaveJobInput {
  profileName?: string;
  jobId: string;
  operatorNote?: string;
}

export interface ListJobAlertsInput {
  profileName?: string;
  limit?: number;
}

export interface PrepareCreateJobAlertInput {
  profileName?: string;
  query: string;
  location?: string;
  operatorNote?: string;
}

export interface PrepareRemoveJobAlertInput {
  profileName?: string;
  alertId?: string;
  searchUrl?: string;
  query?: string;
  location?: string;
  operatorNote?: string;
}

export interface PrepareEasyApplyInput {
  profileName?: string;
  jobId: string;
  phoneNumber?: string;
  email?: string;
  city?: string;
  resumePath?: string;
  coverLetter?: string;
  answers?: Record<string, unknown>;
  operatorNote?: string;
}

export interface SearchJobsOutput {
  query: string;
  location: string;
  results: LinkedInJobSearchResult[];
  count: number;
}

export interface ListJobAlertsOutput {
  alerts: LinkedInJobAlert[];
  count: number;
}

export interface LinkedInJobsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInJobsRuntime extends LinkedInJobsExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInJobsExecutorRuntime>,
    "prepare"
  >;
}

export const SAVE_JOB_ACTION_TYPE = "jobs.save";
export const UNSAVE_JOB_ACTION_TYPE = "jobs.unsave";
export const CREATE_JOB_ALERT_ACTION_TYPE = "jobs.alerts.create";
export const REMOVE_JOB_ALERT_ACTION_TYPE = "jobs.alerts.remove";
export const EASY_APPLY_JOB_ACTION_TYPE = "jobs.easy_apply";

const SAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.save",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40,
} as const;

const UNSAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.unsave",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40,
} as const;

const CREATE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.alerts.create",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30,
} as const;

const REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.alerts.remove",
  windowSizeMs: 60 * 60 * 1000,
  limit: 30,
} as const;

const EASY_APPLY_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.easy_apply",
  windowSizeMs: 60 * 60 * 1000,
  limit: 6,
} as const;

export const JOB_SEARCH_QUERY_MAX_LENGTH = 400;
export const JOB_SEARCH_LIMIT_MAX = 100;
export const JOB_ALERTS_LIMIT_MAX = 100;
export const EASY_APPLY_COVER_LETTER_MAX_LENGTH = 4000;
export const EASY_APPLY_PHONE_MAX_LENGTH = 30;
export const EASY_APPLY_CITY_MAX_LENGTH = 200;
export const EASY_APPLY_EMAIL_MAX_LENGTH = 254;

const JOB_ALERTS_URL = "https://www.linkedin.com/jobs/job-alerts/";
export const LINKEDIN_JOB_ALERTS_URL = JOB_ALERTS_URL;
const EASY_APPLY_DIALOG_SELECTOR =
  "[role='dialog'], .jobs-easy-apply-modal, .jobs-apply-modal";
const EASY_APPLY_FIELD_ATTR = "data-linkedin-assistant-easy-apply-field";
const EASY_APPLY_GROUP_ATTR = "data-linkedin-assistant-easy-apply-group";
const EASY_APPLY_OPTION_ATTR = "data-linkedin-assistant-easy-apply-option";

type EasyApplyFieldKind =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file";

interface EasyApplyFieldSnapshot {
  fieldId: string;
  label: string;
  labelKey: string;
  kind: EasyApplyFieldKind;
  required: boolean;
  filled: boolean;
  options: string[];
  multiple: boolean;
  accept: string;
}

interface EasyApplyDialogSnapshot {
  visible: boolean;
  title: string;
  primaryActionLabel: string;
  success: boolean;
  fields: EasyApplyFieldSnapshot[];
}

interface ValidatedEasyApplyInput {
  profileName: string;
  jobId: string;
  jobUrl: string;
  phoneNumber?: string;
  email?: string;
  city?: string;
  resumePath?: string;
  coverLetter?: string;
  answers: Record<string, LinkedInEasyApplyAnswerValue>;
}

function normalizeLabelKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function readLimit(
  value: number | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultLimit;
  }

  return Math.max(1, Math.min(Math.floor(value), maxLimit));
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

function getOptionalStringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function getOptionalAnswersField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload",
): Record<string, LinkedInEasyApplyAnswerValue> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} is missing a valid ${location}.${key} object.`,
      {
        action_id: actionId,
        location,
        key,
      },
    );
  }

  const normalized: Record<string, LinkedInEasyApplyAnswerValue> = {};
  for (const [answerKey, answerValue] of Object.entries(value)) {
    if (typeof answerValue === "string") {
      normalized[answerKey] = answerValue;
      continue;
    }

    if (typeof answerValue === "boolean" || typeof answerValue === "number") {
      normalized[answerKey] = answerValue;
      continue;
    }

    if (
      Array.isArray(answerValue) &&
      answerValue.every((item) => typeof item === "string")
    ) {
      normalized[answerKey] = answerValue;
      continue;
    }

    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} contains an unsupported value at ${location}.${key}.${answerKey}.`,
      {
        action_id: actionId,
        location,
        key,
        answer_key: answerKey,
      },
    );
  }

  return normalized;
}

function buildJobAlertIdentifier(
  searchUrl: string,
  query: string,
  location: string,
): string {
  return (
    normalizeText(searchUrl) ||
    [normalizeText(query), normalizeText(location)]
      .filter(Boolean)
      .join("::") ||
    "job-alert"
  );
}

function normalizeAbsoluteLinkedInUrl(value: string): string {
  const trimmed = normalizeText(value);
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return trimmed.startsWith("/")
    ? `https://www.linkedin.com${trimmed}`
    : trimmed;
}

function parseJobSearchUrl(value: string): {
  normalizedUrl: string;
  query: string;
  location: string;
} {
  const normalizedUrl = normalizeAbsoluteLinkedInUrl(value);
  if (!normalizedUrl) {
    return {
      normalizedUrl: "",
      query: "",
      location: "",
    };
  }

  try {
    const parsed = new URL(normalizedUrl);
    return {
      normalizedUrl: parsed.toString(),
      query: normalizeText(parsed.searchParams.get("keywords")),
      location: normalizeText(parsed.searchParams.get("location")),
    };
  } catch {
    return {
      normalizedUrl,
      query: "",
      location: "",
    };
  }
}

function normalizeEasyApplyAnswerValue(
  value: unknown,
  key: string,
): LinkedInEasyApplyAnswerValue {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    if (!normalized) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `answers.${key} must not be empty when provided.`,
      );
    }
    return normalized;
  }

  if (typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `answers.${key} must be a finite number.`,
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    const normalizedValues = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0);

    if (
      normalizedValues.length === 0 ||
      normalizedValues.length !== value.length
    ) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `answers.${key} must be a non-empty array of strings.`,
      );
    }

    return normalizedValues;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `answers.${key} must be a string, boolean, number, or string array.`,
  );
}

function normalizeEasyApplyAnswers(
  input: Record<string, unknown> | undefined,
): Record<string, LinkedInEasyApplyAnswerValue> {
  if (!input) {
    return {};
  }

  const normalized: Record<string, LinkedInEasyApplyAnswerValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "answers contains an empty field name.",
      );
    }

    normalized[normalizedKey] = normalizeEasyApplyAnswerValue(
      value,
      normalizedKey,
    );
  }

  return normalized;
}

function validateEmail(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "email must look like a valid email address.",
    );
  }

  return normalized;
}

function validateResumePath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  const resolvedPath = path.resolve(normalized);
  if (!existsSync(resolvedPath)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `resumePath does not exist: ${resolvedPath}`,
    );
  }

  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `resumePath must point to a file: ${resolvedPath}`,
    );
  }

  return resolvedPath;
}

function validateEasyApplyInput(
  input: PrepareEasyApplyInput,
): ValidatedEasyApplyInput {
  const profileName = input.profileName ?? "default";
  const jobId = normalizeText(input.jobId);

  if (!jobId) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "jobId is required.",
    );
  }

  const phoneNumber = normalizeText(input.phoneNumber);

  if (phoneNumber && phoneNumber.length > EASY_APPLY_PHONE_MAX_LENGTH) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `phoneNumber must not exceed ${EASY_APPLY_PHONE_MAX_LENGTH} characters.`,
    );
  }

  const city = normalizeText(input.city);

  if (city && city.length > EASY_APPLY_CITY_MAX_LENGTH) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `city must not exceed ${EASY_APPLY_CITY_MAX_LENGTH} characters.`,
    );
  }

  const coverLetter = normalizeText(input.coverLetter);

  if (coverLetter && coverLetter.length > EASY_APPLY_COVER_LETTER_MAX_LENGTH) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `coverLetter must not exceed ${EASY_APPLY_COVER_LETTER_MAX_LENGTH} characters.`,
    );
  }

  const email = validateEmail(input.email);

  if (email && email.length > EASY_APPLY_EMAIL_MAX_LENGTH) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `email must not exceed ${EASY_APPLY_EMAIL_MAX_LENGTH} characters.`,
    );
  }

  const resumePath = validateResumePath(input.resumePath);

  return {
    profileName,
    jobId,
    jobUrl: buildJobViewUrl(jobId),
    ...(phoneNumber ? { phoneNumber } : {}),
    ...(email ? { email } : {}),
    ...(city ? { city } : {}),
    ...(resumePath ? { resumePath } : {}),
    ...(coverLetter ? { coverLetter } : {}),
    answers: normalizeEasyApplyAnswers(input.answers),
  };
}

export function buildJobSearchUrl(query: string, location?: string): string {
  const encodedQuery = encodeURIComponent(query);
  let url = `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}`;
  if (location && location.trim().length > 0) {
    url += `&location=${encodeURIComponent(location.trim())}`;
  }
  return url;
}

export function buildJobViewUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${encodeURIComponent(jobId)}/`;
}

export function buildJobAlertsUrl(): string {
  return JOB_ALERTS_URL;
}

async function captureScreenshotArtifact(
  runtime: LinkedInJobsExecutorRuntime,
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

async function waitForJobSearchSurface(page: Page): Promise<void> {
  const selectors = [
    "li[data-occludable-job-id]",
    "a[href*='/jobs/view/']",
    ".job-card-container",
    ".base-search-card",
    ".jobs-search-results-list",
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
    "Could not locate LinkedIn job search content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

async function waitForJobDetailSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-testid='lazy-column']",
    "#job-details",
    "h1",
    "a[href*='/company/']",
    ".job-details-jobs-unified-top-card",
    ".jobs-details",
    ".jobs-unified-top-card",
    ".job-view-layout",
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
    "Could not locate LinkedIn job detail content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

async function waitForJobAlertsSurface(page: Page): Promise<void> {
  const selectors = [
    "[data-job-alert-id]",
    "[data-alert-id]",
    ".jobs-alert-card",
    ".job-alert-card",
    "a[href*='/jobs/search/']",
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
    "Could not locate LinkedIn job alerts content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractJobSearchResults(
  page: Page,
  limit: number,
): Promise<LinkedInJobSearchResult[]> {
  const snapshots = await page.evaluate(
    (maxJobs: number) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const origin = globalThis.window.location.origin;

      const dedupeRepeatedText = (text: string): string => {
        const normalized = normalize(text);
        if (!normalized) {
          return "";
        }

        if (normalized.length % 2 === 0) {
          const midpoint = normalized.length / 2;
          const firstHalf = normalize(normalized.slice(0, midpoint));
          const secondHalf = normalize(normalized.slice(midpoint));
          if (firstHalf && firstHalf === secondHalf) {
            return firstHalf;
          }
        }

        const words = normalized.split(" ");
        for (let i = 1; i * 2 <= words.length; i += 1) {
          const prefix = words.slice(0, i).join(" ");
          const nextSegment = words.slice(i, i * 2).join(" ");
          if (prefix === nextSegment) {
            return normalize(prefix);
          }
        }

        return normalized;
      };

      const stripBadgeSuffixes = (text: string): string => {
        let result = normalize(text);
        const patterns = [
          /\s+with verification$/i,
          /\s*·\s*Promoted$/i,
          /\s+Promoted$/i,
          /\s+Actively recruiting$/i,
          /\s+Easy Apply$/i,
        ];
        for (const pattern of patterns) {
          result = result.replace(pattern, "");
        }
        return normalize(result);
      };

      const pickText = (root: ParentNode, selectors: string[]): string => {
        for (const selector of selectors) {
          const el = root.querySelector(selector);
          if (!el) {
            continue;
          }
          const ariaHidden = el.querySelector("span[aria-hidden='true']");
          const ariaText = dedupeRepeatedText(normalize(ariaHidden?.textContent));
          if (ariaText) {
            return ariaText;
          }
          const ltrSpan = el.querySelector("span[dir='ltr']");
          const ltrText = dedupeRepeatedText(normalize(ltrSpan?.textContent));
          if (ltrText) {
            return ltrText;
          }
          const text = dedupeRepeatedText(normalize(el.textContent));
          if (text) {
            return text;
          }
        }
        return "";
      };

      const toAbsoluteHref = (value: string): string => {
        if (!value) {
          return "";
        }
        if (/^https?:\/\//i.test(value)) {
          return value;
        }
        return value.startsWith("/")
          ? `${origin}${value}`
          : `${origin}/${value}`;
      };

      const pickHref = (root: ParentNode, selectors: string[]): string => {
        for (const selector of selectors) {
          const linkElement = root.querySelector(
            selector,
          ) as HTMLAnchorElement | null;
          const href = toAbsoluteHref(
            normalize(linkElement?.getAttribute("href")) ||
              normalize(linkElement?.href),
          );
          if (href) {
            return href;
          }
        }
        return "";
      };

      const extractJobId = (jobUrl: string, root: Element): string => {
        const urlMatch = /\/jobs\/view\/(\d+)/i.exec(jobUrl);
        if (urlMatch?.[1]) {
          return urlMatch[1];
        }

        const idCandidates = [
          normalize(root.getAttribute("data-job-id")),
          normalize(root.getAttribute("data-entity-urn")),
          normalize(root.getAttribute("data-occludable-job-id")),
          normalize(
            root.querySelector("[data-job-id]")?.getAttribute("data-job-id"),
          ),
        ];

        for (const candidate of idCandidates) {
          if (candidate) {
            const urnMatch = /(\d+)$/.exec(candidate);
            return urnMatch?.[1] ?? candidate;
          }
        }

        return "";
      };

      const pickEmploymentType = (root: ParentNode): string => {
        const insightText = normalize(
          (
            root.querySelector(".job-card-list__insight") as HTMLElement | null
          )?.innerText,
        );
        const signal =
          insightText ||
          pickText(root, [
            ".job-card-container__metadata-item",
            ".job-card-container__job-insight",
            ".base-search-card__metadata",
          ]);
        if (!signal) {
          return "";
        }

        const match =
          /(Full-time|Part-time|Contract|Temporary|Internship)/i.exec(signal);
        return normalize(match?.[1] ?? "");
      };

      /* Scope card selection to the search results list to avoid matching
         elements in the job-detail side panel which causes duplicates. */
      const resultsContainer =
        globalThis.document.querySelector(".jobs-search-results-list") ??
        globalThis.document.querySelector("[role='list']") ??
        globalThis.document.querySelector("main") ??
        globalThis.document;

      const rawCards = Array.from(
        resultsContainer.querySelectorAll(
          "li[data-occludable-job-id], .job-card-container, .base-search-card, .job-card-list__entity-lockup",
        ),
      );

      const cards = rawCards
        .filter(
          (card) => !rawCards.some((other) => other !== card && other.contains(card)),
        )
        .slice(0, maxJobs * 2);

      const pickTimeText = (root: ParentNode): string => {
        const timeEl = root.querySelector("time");
        if (!timeEl) {
          return "";
        }
        const datetime = normalize(timeEl.getAttribute("datetime"));

        for (const node of Array.from(timeEl.childNodes)) {
          if (node.nodeType === 3) {
            const t = normalize(node.textContent);
            if (t) {
              return t;
            }
          }
        }

        if (timeEl.firstElementChild) {
          const t = normalize(timeEl.firstElementChild.textContent);
          if (t) {
            return t;
          }
        }

        return datetime || normalize(timeEl.textContent);
      };

      const results: LinkedInJobSearchResult[] = [];
      const seen = new Set<string>();
      for (const card of cards) {
        const jobUrl = pickHref(card, [
          "a[href*='/jobs/view/']",
          ".job-card-container__link",
          ".base-search-card__full-link",
          "a",
        ]);

        const jobId = extractJobId(jobUrl, card);
        const dedupKey = jobId || jobUrl;
        if (dedupKey && seen.has(dedupKey)) {
          continue;
        }
        if (dedupKey) {
          seen.add(dedupKey);
        }

        results.push({
          job_id: jobId,
          title: stripBadgeSuffixes(pickText(card, [
            "a[href*='/jobs/view/'] span[aria-hidden='true']",
            ".job-card-container__link",
            ".job-card-list__title",
            ".base-search-card__title",
          ])),
          company: pickText(card, [
            ".artdeco-entity-lockup__subtitle span[dir='ltr']",
            "a[href*='/company/'] span[dir='ltr']",
            ".job-card-container__primary-description span[dir='ltr']",
            ".artdeco-entity-lockup__subtitle",
            "a[href*='/company/']",
            ".job-card-container__primary-description",
            ".job-card-container__company-name",
            ".base-search-card__subtitle",
          ]),
          location: pickText(card, [
            ".artdeco-entity-lockup__caption span[dir='ltr']",
            ".job-card-container__metadata-wrapper span[dir='ltr']",
            ".job-card-container__metadata-item",
            ".job-search-card__location",
          ]),
          posted_at:
            pickTimeText(card) ||
            pickText(card, [
              ".job-card-container__listed-status",
              ".job-card-container__footer",
              ".job-card-container__listed-time",
            ]),
          job_url: jobUrl,
          salary_range: pickText(card, [
            ".job-card-container__salary-info",
            ".salary-main-rail__salary-range",
            ".salary-main-rail__compensation-text",
          ]),
          employment_type: pickEmploymentType(card),
        });

        if (results.length >= maxJobs) {
          break;
        }
      }

      return results;
    },
    Math.max(1, limit),
  );

  const seenIds = new Set<string>();
  return snapshots
    .map((snapshot) => ({
      job_id: normalizeText(snapshot.job_id),
      title: stripTitleBadgeText(dedupeRepeatedText(snapshot.title)),
      company: normalizeText(snapshot.company),
      location: normalizeText(snapshot.location),
      posted_at: cleanPostedAt(snapshot.posted_at),
      job_url: normalizeText(snapshot.job_url),
      salary_range: normalizeText(snapshot.salary_range),
      employment_type: normalizeText(snapshot.employment_type),
    }))
    .filter((result) => {
      if (result.title.length === 0 && result.job_url.length === 0) {
        return false;
      }
      if (result.job_id && seenIds.has(result.job_id)) {
        return false;
      }
      if (result.job_id) {
        seenIds.add(result.job_id);
      }
      /* Fallback dedup by title+location for entries missing a job_id. */
      const titleKey = `${result.title.toLowerCase()}|${result.location.toLowerCase()}`;
      if (seenIds.has(titleKey)) {
        return false;
      }
      seenIds.add(titleKey);
      return true;
    })
    .slice(0, limit);
}

async function extractJobDetail(
  page: Page,
  jobId: string,
): Promise<LinkedInJobPosting> {
  const snapshot = await page.evaluate((passedJobId: string) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const origin = globalThis.window.location.origin;

    const pickText = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        if (!el) {
          continue;
        }
        const ariaHidden = el.querySelector("span[aria-hidden='true']");
        const text = normalize((ariaHidden ?? el).textContent);
        if (text) {
          return text;
        }
      }
      return "";
    };

    const toAbsoluteHref = (value: string): string => {
      if (!value) {
        return "";
      }
      if (/^https?:\/\//i.test(value)) {
        return value;
      }
      return value.startsWith("/") ? `${origin}${value}` : `${origin}/${value}`;
    };

    const doc = globalThis.document;
    const main = doc.querySelector("main") ?? doc.body;
    const lazyColumn = doc.querySelector("[data-testid='lazy-column']");
    const detailRoot = lazyColumn ?? main;

    const companyLinkElement = (detailRoot.querySelector(
      "a[href*='/company/']",
    ) ??
      main.querySelector("a[href*='/company/']")) as HTMLAnchorElement | null;

    const topCardContainer = (() => {
      let node = companyLinkElement?.parentElement ?? null;
      while (node && node !== main && node.tagName !== "MAIN") {
        const companyLink = node.querySelector("a[href*='/company/']");
        if (companyLink) {
          /* The container must include at least one <p> outside
             the company link — that indicates we have reached the
             card that also contains the title and metadata rows. */
          const pElements = Array.from(node.querySelectorAll("p"));
          const hasNonLinkP = pElements.some(
            (p) => !p.closest("a[href*='/company/']"),
          );
          if (hasNonLinkP && pElements.length >= 2) {
            return node;
          }
        }
        node = node.parentElement;
      }
      return detailRoot;
    })();


    const hasNonEmptySpan = (el: Element): boolean =>
      Array.from(el.querySelectorAll("span")).some(
        (s) => normalize(s.textContent).length > 0,
      );

    const metadataRow = (() => {
      const rows = Array.from(topCardContainer.querySelectorAll("p"));
      for (const row of rows) {
        if (row.closest("a")) {
          continue;
        }
        if (hasNonEmptySpan(row)) {
          return row;
        }
      }
      return null;
    })();

    const metadataSpans = metadataRow
      ? Array.from(metadataRow.querySelectorAll("span"))
          .map((span) => normalize(span.textContent))
          .filter(Boolean)
      : [];

    const isTimeLike = (value: string): boolean =>
      /\b(?:\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago|reposted)\b/i.test(
        value,
      );

    const isApplicantLike = (value: string): boolean =>
      /\b\d+\s*(?:people\s+clicked\s+apply|applicants?)\b/i.test(value);

    /* Collect non-title text blocks from the job detail top card via
       structural DOM traversal (resilient to class name obfuscation). */
    const collectTopCardTexts = (): string[] => {
      const titleText = normalize(
        topCardContainer
          .querySelector("h1, p")
          ?.textContent,
      );

      const candidates: string[] = [];

      const dirSpans = Array.from(
        topCardContainer.querySelectorAll("span[dir='ltr']"),
      );
      for (const span of dirSpans) {
        if (span.closest("h1") || span.closest("#job-details")) {
          continue;
        }
        const ariaHidden = span.querySelector("span[aria-hidden='true']");
        const text = normalize((ariaHidden ?? span).textContent);
        if (text && text !== titleText) {
          candidates.push(text);
        }
      }

      const liItems = Array.from(topCardContainer.querySelectorAll("li"));
      for (const li of liItems) {
        const text = normalize(li.textContent);
        if (text && !candidates.includes(text)) {
          candidates.push(text);
        }
      }

      return candidates;
    };

    const topCardTexts = collectTopCardTexts();
    const topCardBlob = topCardTexts.join(" ");

    const structuralTitle = (() => {
      const rows = Array.from(topCardContainer.querySelectorAll("p"));
      for (const row of rows) {
        if (row.closest("a")) {
          continue;
        }
        /* Skip the metadata row (the <p> with meaningful span children
           that holds location, time-ago, and applicant count). */
        if (hasNonEmptySpan(row)) {
          continue;
        }
        const text = normalize(row.textContent);
        if (text) {
          return text;
        }
      }
      return "";
    })();

    const title =
      structuralTitle ||
      pickText(main, [
        "h1",
        ".job-details-jobs-unified-top-card__job-title",
        ".jobs-unified-top-card__job-title",
        ".top-card-layout__title",
      ]);

    const company =
      normalize(companyLinkElement?.textContent) ||
      pickText(main, [
        "a[href*='/company/']",
        ".job-details-jobs-unified-top-card__company-name",
        ".jobs-unified-top-card__company-name",
        ".top-card-layout__card-link",
      ]);

    const companyUrl = toAbsoluteHref(
      normalize(companyLinkElement?.getAttribute("href")) ||
        normalize(companyLinkElement?.href),
    );

    const location =
      (() => {
        /* First pass: pick the span that looks like a geographic location. */
        for (const spanText of metadataSpans) {
          if (isTimeLike(spanText) || isApplicantLike(spanText)) {
            continue;
          }
          if (
            /,/.test(spanText) ||
            /\b(?:remote|hybrid|on-site|on site)\b/i.test(spanText)
          ) {
            return spanText;
          }
        }
        /* Second pass: pick the first metadata span that is not a
           recognised time-ago, applicant count, or boilerplate string. */
        for (const spanText of metadataSpans) {
          if (isTimeLike(spanText) || isApplicantLike(spanText)) {
            continue;
          }
          if (/\b(?:response|managed|linkedin|apply|application)\b/i.test(spanText)) {
            continue;
          }
          if (spanText.length > 2) {
            return spanText;
          }
        }
        return "";
      })() ||
      pickText(main, [
        ".job-details-jobs-unified-top-card__bullet",
        ".jobs-unified-top-card__subtitle-primary-grouping .jobs-unified-top-card__bullet",
        ".top-card-layout__second-subline .topcard__flavor--bullet",
        ".jobs-unified-top-card__workplace-type",
      ]) ||
      (() => {
        const companyText = normalize(companyLinkElement?.textContent ?? "");
        for (const text of topCardTexts) {
          if (text === companyText || text === title) {
            continue;
          }
          if (
            /\b(?:remote|hybrid|on-site|on site)\b/i.test(text) ||
            /,/.test(text)
          ) {
            return text;
          }
        }
        /* Second pass: pick the first top-card text that is not the
           title, company, or a pure time-ago string. */
        for (const text of topCardTexts) {
          if (text === companyText || text === title) {
            continue;
          }
          if (
            /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago$/i.test(
              text,
            )
          ) {
            continue;
          }
          if (/\d+\s*applicants?/i.test(text)) {
            continue;
          }
          if (text.length > 2) {
            return text;
          }
        }
        return "";
      })();

    const postedAt =
      (() => {
        for (const spanText of metadataSpans) {
          if (isTimeLike(spanText)) {
            return spanText;
          }
        }
        const timeEl = detailRoot.querySelector("time") ?? main.querySelector("time");
        if (timeEl) {
          const text = normalize(timeEl.textContent);
          const datetime = normalize(timeEl.getAttribute("datetime"));
          if (text) {
            return text;
          }
          if (datetime) {
            return datetime;
          }
        }
        return "";
      })() ||
      pickText(main, [
        ".job-details-jobs-unified-top-card__posted-date",
        ".jobs-unified-top-card__posted-date",
        ".posted-time-ago__text",
      ]) ||
      (() => {
        for (const text of topCardTexts) {
          if (
            /\b(?:\d+\s*(?:second|minute|hour|day|week|month|year)s?\s*ago|reposted)\b/i.test(
              text,
            )
          ) {
            return text;
          }
        }
        return "";
      })();

    const aboutHeading = Array.from(detailRoot.querySelectorAll("h2")).find((el) =>
      /about\s+the\s+job/i.test(normalize(el.textContent)),
    );

    const structuralDescription = (() => {
      if (!aboutHeading) {
        return "";
      }
      const directTarget = aboutHeading.parentElement?.querySelector(
        "[data-testid='expandable-text-box']",
      );
      if (directTarget) {
        return normalize(directTarget.textContent);
      }
      let sibling: Element | null = aboutHeading.parentElement?.nextElementSibling ?? null;
      while (sibling) {
        const box = sibling.matches("[data-testid='expandable-text-box']")
          ? sibling
          : sibling.querySelector("[data-testid='expandable-text-box']");
        if (box) {
          return normalize(box.textContent);
        }
        if (sibling.tagName === "H2") {
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      const withinRoot = aboutHeading.closest("section, div")?.querySelector(
        "[data-testid='expandable-text-box']",
      );
      return normalize(withinRoot?.textContent);
    })();

    const description =
      structuralDescription ||
      pickText(main, [
        "#job-details",
        ".jobs-description__content",
        ".jobs-description-content__text",
        ".jobs-box__html-content",
        ".description__text",
      ]);

    const betweenTopCardAndAboutTexts = (() => {
      const texts: string[] = [];
      const candidateRoot = detailRoot;
      const candidates = Array.from(candidateRoot.querySelectorAll("span, li, p"));
      for (const node of candidates) {
        if (metadataRow) {
          const isAfterMetadata =
            (metadataRow.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !==
            0;
          if (!isAfterMetadata) {
            continue;
          }
        }
        if (aboutHeading) {
          const isBeforeAbout =
            (node.compareDocumentPosition(aboutHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !==
            0;
          if (!isBeforeAbout) {
            continue;
          }
        }
        if (
          node.closest("[data-testid='expandable-text-box']") ||
          node.closest("h2") ||
          node.closest("a[href*='/company/']")
        ) {
          continue;
        }
        const text = normalize(node.textContent);
        if (text && !texts.includes(text)) {
          texts.push(text);
        }
      }
      return texts;
    })();
    const betweenBlob = betweenTopCardAndAboutTexts.join(" ");

    const insightTexts = Array.from(
      main.querySelectorAll(
        ".job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight, .description__job-criteria-item, .job-criteria__item",
      ),
    ).map((el) => normalize(el.textContent));

    const allInsights = [...insightTexts, topCardBlob, betweenBlob]
      .filter(Boolean)
      .join(" ");

    const salaryRange =
      (() => {
        const salaryMatch =
          /((?:\$|€|£)?[\d,.]+\s*(?:[-–]|to)\s*(?:\$|€|£)?[\d,.]+\s*(?:kr|DKK|USD|EUR|GBP)?|[\d,.]+\s*(?:kr|DKK|USD|EUR|GBP))/i.exec(
            betweenBlob,
          );
        return normalize(salaryMatch?.[1] ?? "");
      })() ||
      pickText(main, [
        ".salary-main-rail__compensation-text",
        ".job-details-jobs-unified-top-card__salary-info",
        ".compensation__salary",
        ".salary-main-rail__salary-range",
      ]) ||
      (() => {
        const salaryMatch =
          /(\$[\d,]+\s*[-–]\s*\$[\d,]+|€[\d,]+\s*[-–]\s*€[\d,]+|£[\d,]+\s*[-–]\s*£[\d,]+|[\d,]+\s*[-–]\s*[\d,]+\s*(?:kr|DKK|USD|EUR|GBP))/i.exec(
            allInsights,
          );
        return normalize(salaryMatch?.[1] ?? "");
      })();

    const employmentTypeMatch =
      /(Full-time|Part-time|Contract|Temporary|Internship)/i.exec(
        betweenBlob || allInsights,
      );
    const employmentType = normalize(employmentTypeMatch?.[1] ?? "");

    const seniorityMatch =
      /(Entry level|Associate|Mid-Senior level|Director|Executive|Internship|Not Applicable)/i.exec(
        betweenBlob || allInsights,
      );
    const seniorityLevel = normalize(seniorityMatch?.[1] ?? "");

    const applicantCount =
      (() => {
        for (const spanText of metadataSpans) {
          if (isApplicantLike(spanText)) {
            return spanText;
          }
        }
        return "";
      })() ||
      pickText(main, [
        ".jobs-unified-top-card__applicant-count",
        ".job-details-jobs-unified-top-card__applicant-count",
        ".num-applicants__caption",
      ]) ||
      (() => {
        for (const text of topCardTexts) {
          if (/\b\d+\s*applicants?\b/i.test(text)) {
            return text;
          }
        }
        const applicantMatch = /(\d[\d,]*\s*applicants?)/i.exec(allInsights);
        return normalize(applicantMatch?.[1] ?? "");
      })();

    const isRemote =
      /\bremote\b/i.test(location) ||
      /\bremote\b/i.test(allInsights) ||
      /\bremote\b/i.test(topCardBlob) ||
      /\bremote\b/i.test(betweenBlob);

    const jobUrl = globalThis.window.location.href;

    const result: LinkedInJobPosting = {
      job_id: passedJobId,
      title,
      company,
      company_url: companyUrl,
      location,
      posted_at: postedAt,
      description,
      salary_range: salaryRange,
      employment_type: employmentType,
      job_url: jobUrl,
      applicant_count: applicantCount,
      seniority_level: seniorityLevel,
      is_remote: isRemote,
    };

    return result;
  }, jobId);

  return {
    job_id: normalizeText(snapshot.job_id) || jobId,
    title: dedupeRepeatedText(snapshot.title),
    company: normalizeText(snapshot.company),
    company_url: normalizeText(snapshot.company_url),
    location: normalizeText(snapshot.location),
    posted_at: cleanPostedAt(snapshot.posted_at),
    description: normalizeText(snapshot.description),
    salary_range: normalizeText(snapshot.salary_range),
    employment_type: normalizeText(snapshot.employment_type),
    job_url: normalizeText(snapshot.job_url),
    applicant_count: normalizeText(snapshot.applicant_count),
    seniority_level: normalizeText(snapshot.seniority_level),
    is_remote: Boolean(snapshot.is_remote),
  };
}

async function extractJobAlerts(
  page: Page,
  limit: number,
): Promise<LinkedInJobAlert[]> {
  const snapshots = await page.evaluate(
    (maxAlerts: number) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const origin = globalThis.window.location.origin;

      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = globalThis.window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const toAbsoluteHref = (value: string): string => {
        if (!value) {
          return "";
        }
        if (/^https?:\/\//i.test(value)) {
          return value;
        }
        return value.startsWith("/")
          ? `${origin}${value}`
          : `${origin}/${value}`;
      };

      const parseSearchUrl = (
        value: string,
      ): { normalizedUrl: string; query: string; location: string } => {
        const absolute = toAbsoluteHref(value);
        if (!absolute) {
          return { normalizedUrl: "", query: "", location: "" };
        }

        try {
          const parsed = new URL(absolute);
          return {
            normalizedUrl: parsed.toString(),
            query: normalize(parsed.searchParams.get("keywords")),
            location: normalize(parsed.searchParams.get("location")),
          };
        } catch {
          return { normalizedUrl: absolute, query: "", location: "" };
        }
      };

      const pickText = (root: ParentNode, selectors: string[]): string => {
        for (const selector of selectors) {
          const el = root.querySelector(selector);
          if (!el) {
            continue;
          }
          const ariaHidden = el.querySelector("span[aria-hidden='true']");
          const text = normalize((ariaHidden ?? el).textContent);
          if (text) {
            return text;
          }
        }

        return "";
      };

      const cards = Array.from(
        globalThis.document.querySelectorAll(
          "[data-job-alert-id], [data-alert-id], .jobs-alert-card, .job-alert-card, article, li",
        ),
      ).filter((element) => isVisible(element));

      const results: LinkedInJobAlert[] = [];
      const seen = new Set<string>();
      for (const card of cards) {
        const text = normalize(card.textContent);
        const searchAnchor = card.querySelector(
          "a[href*='/jobs/search/']",
        ) as HTMLAnchorElement | null;

        if (!searchAnchor && !/alert/i.test(text)) {
          continue;
        }

        const parsedSearch = parseSearchUrl(
          normalize(searchAnchor?.getAttribute("href")) ||
            normalize(searchAnchor?.href),
        );
        const query =
          pickText(card, [
            "h1",
            "h2",
            "h3",
            "h4",
            ".job-alert-card__title",
            ".jobs-alert-card__title",
            "a[href*='/jobs/search/']",
          ]) || parsedSearch.query;
        const location =
          pickText(card, [
            ".job-alert-card__location",
            ".jobs-alert-card__location",
            ".t-14",
            ".t-12",
          ]) || parsedSearch.location;
        const frequencyMatch = /(Daily|Weekly|Instant|Immediate)/i.exec(text);
        const frequency = normalize(frequencyMatch?.[1] ?? "");
        const alertId =
          normalize(card.getAttribute("data-job-alert-id")) ||
          normalize(card.getAttribute("data-alert-id")) ||
          normalize(card.getAttribute("id")) ||
          parsedSearch.normalizedUrl ||
          `${query}::${location}`;

        if (!alertId || seen.has(alertId)) {
          continue;
        }

        seen.add(alertId);
        results.push({
          alert_id: alertId,
          query,
          location,
          frequency,
          search_url: parsedSearch.normalizedUrl,
          enabled: !/\b(paused|off|disabled|muted)\b/i.test(text),
        });

        if (results.length >= maxAlerts) {
          break;
        }
      }

      return results;
    },
    Math.max(1, limit),
  );

  return snapshots.map((snapshot) => ({
    alert_id: normalizeText(snapshot.alert_id),
    query: normalizeText(snapshot.query),
    location: normalizeText(snapshot.location),
    frequency: normalizeText(snapshot.frequency),
    search_url: normalizeText(snapshot.search_url),
    enabled: Boolean(snapshot.enabled),
  }));
}

async function loadJobSearchResults(
  page: Page,
  limit: number,
): Promise<LinkedInJobSearchResult[]> {
  let results = await extractJobSearchResults(page, limit);

  for (let index = 0; index < 6 && results.length < limit; index += 1) {
    await scrollLinkedInPageToBottom(page);
    await page.waitForTimeout(800);
    results = await extractJobSearchResults(page, limit);
  }

  return results.slice(0, Math.max(1, limit));
}

async function markJobsButton(
  page: Page,
  kind: "save" | "easy-apply" | "alert-toggle",
): Promise<Locator> {
  const attributeName = `data-linkedin-assistant-jobs-${kind}`;
  const markerValue = `marked-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const marked = await page.evaluate(
    ({
      attributeName: buttonAttributeName,
      markerValue: buttonMarkerValue,
      kind: buttonKind,
    }) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement;
        const style = globalThis.window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const buttons = Array.from(
        (
          globalThis.document.querySelector("main") ?? globalThis.document.body
        ).querySelectorAll("button, a[role='button']"),
      ).filter((element) => isVisible(element));

      const getScore = (element: Element): number => {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const text = normalize(htmlElement.textContent);
        const ariaLabel = normalize(htmlElement.getAttribute("aria-label"));
        const title = normalize(htmlElement.getAttribute("title"));
        const className = normalize(htmlElement.getAttribute("class"));
        const controlName = normalize(
          htmlElement.getAttribute("data-control-name"),
        );
        const haystack = [text, ariaLabel, title, className, controlName]
          .filter(Boolean)
          .join(" ");

        let score = 0;
        if (buttonKind === "save") {
          if (!/\bsave(?:d)?\b/.test(haystack)) {
            return 0;
          }
          if (/search|alert/.test(haystack)) {
            score -= 50;
          }
          if (/job|top card|jobs-unified-top-card|job-details/.test(haystack)) {
            score += 20;
          }
        }

        if (buttonKind === "easy-apply") {
          if (!/easy apply/.test(haystack)) {
            return 0;
          }
          score += 50;
        }

        if (buttonKind === "alert-toggle") {
          if (!/alert/.test(haystack)) {
            return 0;
          }
          if (/security|privacy|saved searches/.test(haystack)) {
            score -= 50;
          }
        }

        if (rect.top >= 0 && rect.top < 420) {
          score += 25;
        }
        if (rect.left >= 0) {
          score += Math.max(0, 20 - Math.floor(rect.left / 150));
        }
        if (
          buttonKind !== "alert-toggle" &&
          htmlElement.closest(
            ".jobs-unified-top-card, .job-details-jobs-unified-top-card, .top-card-layout",
          )
        ) {
          score += 40;
        }
        if (
          buttonKind === "alert-toggle" &&
          htmlElement.closest(
            ".jobs-search-two-pane, .jobs-search-results-list",
          )
        ) {
          score += 20;
        }

        return score;
      };

      const sorted = buttons
        .map((element) => ({
          element,
          score: getScore(element),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

      const best = sorted[0]?.element;
      if (!best) {
        return false;
      }

      best.setAttribute(buttonAttributeName, buttonMarkerValue);
      return true;
    },
    {
      attributeName,
      markerValue,
      kind,
    },
  );

  if (!marked) {
    const message =
      kind === "easy-apply"
        ? "Could not locate an Easy Apply button on the LinkedIn job page."
        : kind === "alert-toggle"
          ? "Could not locate a LinkedIn job alert toggle on the search page."
          : "Could not locate a LinkedIn job save toggle on the job page.";

    throw new LinkedInBuddyError("UI_CHANGED_SELECTOR_FAILED", message, {
      current_url: page.url(),
      button_kind: kind,
    });
  }

  return page.locator(`[${attributeName}="${markerValue}"]`).first();
}

async function readJobsToggleState(
  page: Page,
  kind: "save" | "alert-toggle",
): Promise<boolean | null> {
  const button = await markJobsButton(page, kind);
  const state = await button.evaluate((element, buttonKind) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

    const htmlElement = element as HTMLElement;
    const text = normalize(htmlElement.textContent);
    const ariaLabel = normalize(htmlElement.getAttribute("aria-label"));
    const title = normalize(htmlElement.getAttribute("title"));
    const ariaPressed = normalize(htmlElement.getAttribute("aria-pressed"));
    const ariaChecked = normalize(htmlElement.getAttribute("aria-checked"));
    const combined = [text, ariaLabel, title].filter(Boolean).join(" ");

    if (ariaPressed === "true" || ariaChecked === "true") {
      return true;
    }
    if (ariaPressed === "false" || ariaChecked === "false") {
      return false;
    }

    if (buttonKind === "save") {
      if (/\b(saved|unsave)\b/.test(combined)) {
        return true;
      }
      if (/\bsave\b/.test(combined)) {
        return false;
      }
      return null;
    }

    if (
      /\b(job alert set|remove alert|manage alert|alert on)\b/.test(combined)
    ) {
      return true;
    }
    if (/\b(set alert|create alert|alert off)\b/.test(combined)) {
      return false;
    }

    return null;
  }, kind);

  return typeof state === "boolean" ? state : null;
}

function classifyEasyApplyActionLabel(
  value: string,
): "submit" | "review" | "next" | "unknown" {
  const normalized = normalizeLabelKey(value);
  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.includes("submit application") ||
    normalized.includes("send application") ||
    normalized === "submit"
  ) {
    return "submit";
  }

  if (normalized.includes("review")) {
    return "review";
  }

  if (
    normalized.includes("next") ||
    normalized.includes("continue") ||
    normalized.includes("continue to next")
  ) {
    return "next";
  }

  return "unknown";
}

async function readEasyApplyDialogSnapshot(
  page: Page,
): Promise<EasyApplyDialogSnapshot> {
  const snapshot = await page.evaluate(
    ({ dialogSelector, fieldAttribute, groupAttribute, optionAttribute }) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const normalizeKey = (value: string): string =>
        normalize(value)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = globalThis.window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const dialog = Array.from(
        globalThis.document.querySelectorAll(dialogSelector),
      ).find((element) => isVisible(element));

      if (!dialog || !isVisible(dialog)) {
        return {
          visible: false,
          title: "",
          primaryActionLabel: "",
          success: false,
          fields: [],
        };
      }

      const readAssociatedLabel = (element: HTMLElement): string => {
        const htmlInput = element as HTMLInputElement;
        if (htmlInput.id) {
          const explicitLabel = dialog.querySelector(
            `label[for="${htmlInput.id}"]`,
          );
          const explicitLabelText = normalize(explicitLabel?.textContent);
          if (explicitLabelText) {
            return explicitLabelText;
          }
        }

        const wrappedLabelText = normalize(
          element.closest("label")?.textContent,
        );
        if (wrappedLabelText) {
          return wrappedLabelText;
        }

        const fieldsetText = normalize(
          element.closest("fieldset")?.querySelector("legend")?.textContent,
        );
        if (fieldsetText) {
          return fieldsetText;
        }

        const formElement = element.closest(
          ".fb-dash-form-element, .jobs-easy-apply-form-element",
        );
        const formElementLabel = normalize(
          formElement?.querySelector("label")?.textContent,
        );
        if (formElementLabel) {
          return formElementLabel;
        }

        return (
          normalize(element.getAttribute("aria-label")) ||
          normalize(element.getAttribute("placeholder")) ||
          normalize(htmlInput.name)
        );
      };

      const isRequiredElement = (element: HTMLElement): boolean => {
        const htmlInput = element as HTMLInputElement;
        const labelText = readAssociatedLabel(element);
        const ariaRequired = normalize(element.getAttribute("aria-required"));
        return Boolean(
          htmlInput.required ||
          ariaRequired === "true" ||
          labelText.includes("*"),
        );
      };

      const fields: EasyApplyFieldSnapshot[] = [];
      const handledGroups = new Set<string>();
      let counter = 0;

      const createFieldId = (): string => `field-${counter++}`;

      const inputs = Array.from(
        dialog.querySelectorAll("input, textarea, select"),
      ).filter((element) => isVisible(element));

      for (const element of inputs) {
        const htmlElement = element as HTMLElement;
        const inputElement = element as HTMLInputElement;
        const tagName = element.tagName.toLowerCase();
        const inputType = normalize(inputElement.type || tagName);

        if (
          inputType === "hidden" ||
          inputType === "submit" ||
          inputType === "button" ||
          inputType === "reset"
        ) {
          continue;
        }

        if (
          (inputType === "radio" || inputType === "checkbox") &&
          inputElement.name
        ) {
          const groupKey = `${inputType}:${inputElement.name}`;
          if (handledGroups.has(groupKey)) {
            continue;
          }
          handledGroups.add(groupKey);

          const groupInputs = inputs.filter((candidate) => {
            const candidateInput = candidate as HTMLInputElement;
            return (
              normalize(candidateInput.type) === inputType &&
              candidateInput.name === inputElement.name
            );
          }) as HTMLInputElement[];

          const fieldId = createFieldId();
          const options = groupInputs
            .map((candidate) => {
              const optionLabel = readAssociatedLabel(candidate);
              candidate.setAttribute(groupAttribute, fieldId);
              candidate.setAttribute(
                optionAttribute,
                normalizeKey(optionLabel),
              );
              return optionLabel;
            })
            .map((candidate) => normalize(candidate))
            .filter((candidate) => candidate.length > 0);

          const label = readAssociatedLabel(inputElement);
          fields.push({
            fieldId,
            label,
            labelKey: normalizeKey(label),
            kind: inputType as "radio" | "checkbox",
            required: groupInputs.some((candidate) =>
              isRequiredElement(candidate),
            ),
            filled: groupInputs.some((candidate) => candidate.checked),
            options,
            multiple: inputType === "checkbox" && groupInputs.length > 1,
            accept: "",
          });
          continue;
        }

        const fieldId = createFieldId();
        htmlElement.setAttribute(fieldAttribute, fieldId);
        const label = readAssociatedLabel(htmlElement);
        const kind =
          tagName === "textarea"
            ? "textarea"
            : tagName === "select"
              ? "select"
              : inputType === "file"
                ? "file"
                : "text";

        const filled =
          kind === "file"
            ? Array.from(inputElement.files ?? []).length > 0
            : tagName === "select"
              ? normalize((element as HTMLSelectElement).value).length > 0
              : normalize(inputElement.value).length > 0;

        const options =
          tagName === "select"
            ? Array.from((element as HTMLSelectElement).options)
                .map((option) => normalize(option.textContent))
                .filter((option) => option.length > 0)
            : [];

        fields.push({
          fieldId,
          label,
          labelKey: normalizeKey(label),
          kind,
          required: isRequiredElement(htmlElement),
          filled,
          options,
          multiple:
            kind === "file"
              ? inputElement.multiple
              : tagName === "select"
                ? (element as HTMLSelectElement).multiple
                : false,
          accept: normalize(inputElement.accept),
        });
      }

      const buttons = Array.from(dialog.querySelectorAll("button")).filter(
        (element) => isVisible(element),
      );
      const primaryButton = buttons
        .map((button) => {
          const label = normalize(
            button.getAttribute("aria-label") || button.textContent,
          );
          const key = normalizeKey(label);
          let score = 0;
          if (key.includes("submit application") || key === "submit") {
            score += 300;
          }
          if (key.includes("review")) {
            score += 200;
          }
          if (key.includes("next") || key.includes("continue")) {
            score += 100;
          }
          if (
            button.classList.contains("artdeco-button--primary") ||
            button.getAttribute("data-easy-apply-next-button")
          ) {
            score += 50;
          }
          return {
            label,
            score,
          };
        })
        .sort((left, right) => right.score - left.score)[0];

      return {
        visible: true,
        title: normalize(dialog.querySelector("h1, h2, h3")?.textContent),
        primaryActionLabel: primaryButton?.label ?? "",
        success: /application (submitted|sent)|your application was sent/i.test(
          normalize(dialog.textContent),
        ),
        fields,
      };
    },
    {
      dialogSelector: EASY_APPLY_DIALOG_SELECTOR,
      fieldAttribute: EASY_APPLY_FIELD_ATTR,
      groupAttribute: EASY_APPLY_GROUP_ATTR,
      optionAttribute: EASY_APPLY_OPTION_ATTR,
    },
  );

  return snapshot;
}

function resolveEasyApplyFieldValue(
  field: EasyApplyFieldSnapshot,
  input: ValidatedEasyApplyInput,
): LinkedInEasyApplyAnswerValue | string | undefined {
  const labelKey = field.labelKey;
  const answerEntries = Object.entries(input.answers);
  const matchedAnswer = answerEntries.find(([key]) => {
    const normalizedKey = normalizeLabelKey(key);
    return normalizedKey === labelKey || labelKey.includes(normalizedKey);
  });

  if (matchedAnswer) {
    return matchedAnswer[1];
  }

  if (field.kind === "file") {
    return input.resumePath;
  }
  if (labelKey.includes("resume")) {
    return input.resumePath;
  }
  if (labelKey.includes("phone")) {
    return input.phoneNumber;
  }
  if (labelKey.includes("email")) {
    return input.email;
  }
  if (labelKey.includes("city")) {
    return input.city;
  }
  if (labelKey.includes("cover letter")) {
    return input.coverLetter;
  }

  return undefined;
}

async function applyEasyApplyFieldValue(
  page: Page,
  field: EasyApplyFieldSnapshot,
  value: LinkedInEasyApplyAnswerValue | string,
): Promise<void> {
  if (field.kind === "text" || field.kind === "textarea") {
    await page
      .locator(`[${EASY_APPLY_FIELD_ATTR}="${field.fieldId}"]`)
      .first()
      .fill(String(value));
    return;
  }

  if (field.kind === "select") {
    const locator = page
      .locator(`[${EASY_APPLY_FIELD_ATTR}="${field.fieldId}"]`)
      .first();
    const optionValue = String(Array.isArray(value) ? value[0] : value);
    await locator.selectOption({ label: optionValue }).catch(async () => {
      await locator.selectOption({ value: optionValue });
    });
    return;
  }

  if (field.kind === "file") {
    await page
      .locator(`[${EASY_APPLY_FIELD_ATTR}="${field.fieldId}"]`)
      .first()
      .setInputFiles(String(value));
    return;
  }

  if (field.kind === "radio") {
    const optionKey = normalizeLabelKey(String(value));
    const clicked = await page.evaluate(
      ({ groupAttribute, groupId, desiredOption, optionAttribute }) => {
        const normalizeKey = (candidate: string): string =>
          candidate
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        const inputs = Array.from(
          globalThis.document.querySelectorAll(
            `[${groupAttribute}="${groupId}"]`,
          ),
        ) as HTMLInputElement[];

        const match = inputs.find(
          (input) =>
            normalizeKey(input.getAttribute(optionAttribute) ?? "") ===
            desiredOption,
        );

        if (!match) {
          return false;
        }

        match.click();
        return true;
      },
      {
        groupId: field.fieldId,
        desiredOption: optionKey,
        groupAttribute: EASY_APPLY_GROUP_ATTR,
        optionAttribute: EASY_APPLY_OPTION_ATTR,
      },
    );

    if (!clicked) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `No Easy Apply radio option matched "${String(value)}" for "${field.label}".`,
        {
          field_label: field.label,
          provided_value: String(value),
          options: field.options,
        },
      );
    }
    return;
  }

  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  const selectionKeys = values.map((candidate) => normalizeLabelKey(candidate));

  const selectionResult = await page.evaluate(
    ({ groupAttribute, groupId, desiredOptions, optionAttribute }) => {
      const normalizeKey = (candidate: string): string =>
        candidate
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const inputs = Array.from(
        globalThis.document.querySelectorAll(
          `[${groupAttribute}="${groupId}"]`,
        ),
      ) as HTMLInputElement[];

      const matchedOptions: string[] = [];
      for (const input of inputs) {
        const optionKey = normalizeKey(
          input.getAttribute(optionAttribute) ?? "",
        );
        const shouldCheck = desiredOptions.includes(optionKey);
        if (shouldCheck !== input.checked) {
          input.click();
        }
        if (shouldCheck) {
          matchedOptions.push(optionKey);
        }
      }

      return matchedOptions;
    },
    {
      groupId: field.fieldId,
      desiredOptions: selectionKeys,
      groupAttribute: EASY_APPLY_GROUP_ATTR,
      optionAttribute: EASY_APPLY_OPTION_ATTR,
    },
  );

  if (selectionResult.length === 0 && values.length > 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `No Easy Apply checkbox option matched "${values.join(", ")}" for "${field.label}".`,
      {
        field_label: field.label,
        provided_value: values,
        options: field.options,
      },
    );
  }
}

async function fillEasyApplyStep(
  page: Page,
  snapshot: EasyApplyDialogSnapshot,
  input: ValidatedEasyApplyInput,
): Promise<void> {
  const missingRequiredFields: string[] = [];

  for (const field of snapshot.fields) {
    const resolvedValue = resolveEasyApplyFieldValue(field, input);
    if (resolvedValue === undefined) {
      if (field.required && !field.filled) {
        missingRequiredFields.push(field.label || field.fieldId);
      }
      continue;
    }

    await applyEasyApplyFieldValue(page, field, resolvedValue);
  }

  if (missingRequiredFields.length > 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Easy Apply requires additional answers before confirmation.",
      {
        missing_fields: missingRequiredFields,
      },
    );
  }
}

async function clickEasyApplyPrimaryAction(page: Page): Promise<string> {
  const dialog = page.locator(EASY_APPLY_DIALOG_SELECTOR).filter({
    has: page.locator("button"),
  });

  const buttons = dialog.locator("button");
  const buttonCount = await buttons.count();
  let bestIndex = -1;
  let bestLabel = "";
  let bestScore = -1;

  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    const label = normalizeText(
      (await button.getAttribute("aria-label").catch(() => "")) ??
        (await button.textContent().catch(() => "")),
    );
    const actionKind = classifyEasyApplyActionLabel(label);
    const score =
      actionKind === "submit"
        ? 300
        : actionKind === "review"
          ? 200
          : actionKind === "next"
            ? 100
            : 0;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestLabel = label;
    }
  }

  if (bestIndex < 0 || bestScore <= 0) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not determine the primary Easy Apply action button.",
      {
        current_url: page.url(),
      },
    );
  }

  await buttons.nth(bestIndex).click();
  return bestLabel;
}

async function waitForEasyApplySuccess(page: Page): Promise<boolean> {
  return waitForCondition(async () => {
    const dialogSnapshot = await readEasyApplyDialogSnapshot(page);
    if (dialogSnapshot.success) {
      return true;
    }

    const pageText = await page
      .locator("body")
      .textContent()
      .catch(() => "");
    return /application (submitted|sent)|your application was sent/i.test(
      normalizeText(pageText),
    );
  }, 12_000);
}
/* eslint-enable no-undef */

export class SaveJobActionExecutor implements ActionExecutor<LinkedInJobsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = getRequiredStringField(
      action.target,
      "job_id",
      action.id,
      "target",
    );
    const jobUrl = getRequiredStringField(
      action.target,
      "job_url",
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
          actionType: SAVE_JOB_ACTION_TYPE,
          profileName,
          targetUrl: jobUrl,
          metadata: {
            job_id: jobId,
            job_url: jobUrl,
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn save job action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: SAVE_JOB_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(SAVE_JOB_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                },
              },
            );

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);

            const initialSavedState = await readJobsToggleState(page, "save");
            if (initialSavedState !== true) {
              const button = await markJobsButton(page, "save");
              await button.click();
            }

            const verified = await waitForCondition(async () => {
              return (await readJobsToggleState(page, "save")) === true;
            }, 8_000);

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Save job action could not be verified on the LinkedIn job page.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  job_url: jobUrl,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-job-save-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: SAVE_JOB_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl,
            });

            return {
              ok: true,
              result: {
                saved: true,
                already_saved: initialSavedState === true,
                job_id: jobId,
                job_url: jobUrl,
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

export class UnsaveJobActionExecutor implements ActionExecutor<LinkedInJobsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = getRequiredStringField(
      action.target,
      "job_id",
      action.id,
      "target",
    );
    const jobUrl = getRequiredStringField(
      action.target,
      "job_url",
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
          actionType: UNSAVE_JOB_ACTION_TYPE,
          profileName,
          targetUrl: jobUrl,
          metadata: {
            job_id: jobId,
            job_url: jobUrl,
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn unsave job action.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: UNSAVE_JOB_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(UNSAVE_JOB_ACTION_TYPE),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                },
              },
            );

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);

            const initialSavedState = await readJobsToggleState(page, "save");
            if (initialSavedState !== false) {
              const button = await markJobsButton(page, "save");
              await button.click();
            }

            const verified = await waitForCondition(async () => {
              return (await readJobsToggleState(page, "save")) === false;
            }, 8_000);

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Unsave job action could not be verified on the LinkedIn job page.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  job_url: jobUrl,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-job-unsave-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: UNSAVE_JOB_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl,
            });

            return {
              ok: true,
              result: {
                saved: false,
                already_unsaved: initialSavedState === false,
                job_id: jobId,
                job_url: jobUrl,
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

export class CreateJobAlertActionExecutor implements ActionExecutor<LinkedInJobsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const query = getRequiredStringField(
      action.target,
      "query",
      action.id,
      "target",
    );
    const searchUrl = getRequiredStringField(
      action.target,
      "search_url",
      action.id,
      "target",
    );
    const location = getOptionalStringField(action.target, "location") ?? "";

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
          actionType: CREATE_JOB_ALERT_ACTION_TYPE,
          profileName,
          targetUrl: searchUrl,
          metadata: {
            query,
            location,
            search_url: searchUrl,
          },
          errorDetails: {
            query,
            location,
            search_url: searchUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to create a LinkedIn job alert.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: CREATE_JOB_ALERT_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(
                  CREATE_JOB_ALERT_ACTION_TYPE,
                ),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  search_url: searchUrl,
                },
              },
            );

            await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobSearchSurface(page);

            const initialAlertState = await readJobsToggleState(
              page,
              "alert-toggle",
            );
            if (initialAlertState !== true) {
              const button = await markJobsButton(page, "alert-toggle");
              await button.click();
            }

            const verified = await waitForCondition(async () => {
              return (await readJobsToggleState(page, "alert-toggle")) === true;
            }, 8_000);

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Job alert creation could not be verified on the search page.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  query,
                  location,
                  search_url: searchUrl,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-job-alert-create-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: CREATE_JOB_ALERT_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              query,
              location,
              search_url: searchUrl,
            });

            return {
              ok: true,
              result: {
                alert_enabled: true,
                already_enabled: initialAlertState === true,
                query,
                location,
                search_url: searchUrl,
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

export class RemoveJobAlertActionExecutor implements ActionExecutor<LinkedInJobsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const query = getRequiredStringField(
      action.target,
      "query",
      action.id,
      "target",
    );
    const searchUrl = getRequiredStringField(
      action.target,
      "search_url",
      action.id,
      "target",
    );
    const location = getOptionalStringField(action.target, "location") ?? "";
    const alertId =
      getOptionalStringField(action.target, "alert_id") ??
      buildJobAlertIdentifier(searchUrl, query, location);

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
          actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
          profileName,
          targetUrl: searchUrl,
          metadata: {
            alert_id: alertId,
            query,
            location,
            search_url: searchUrl,
          },
          errorDetails: {
            alert_id: alertId,
            query,
            location,
            search_url: searchUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to remove a LinkedIn job alert.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(
                  REMOVE_JOB_ALERT_ACTION_TYPE,
                ),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  search_url: searchUrl,
                },
              },
            );

            await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobSearchSurface(page);

            const initialAlertState = await readJobsToggleState(
              page,
              "alert-toggle",
            );
            if (initialAlertState !== false) {
              const button = await markJobsButton(page, "alert-toggle");
              await button.click();
            }

            const verified = await waitForCondition(async () => {
              return (
                (await readJobsToggleState(page, "alert-toggle")) === false
              );
            }, 8_000);

            if (!verified) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Job alert removal could not be verified on the search page.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  alert_id: alertId,
                  query,
                  location,
                  search_url: searchUrl,
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-job-alert-remove-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: REMOVE_JOB_ALERT_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              alert_id: alertId,
              query,
              location,
              search_url: searchUrl,
            });

            return {
              ok: true,
              result: {
                alert_enabled: false,
                already_disabled: initialAlertState === false,
                alert_id: alertId,
                query,
                location,
                search_url: searchUrl,
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

export class EasyApplyJobActionExecutor implements ActionExecutor<LinkedInJobsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = getRequiredStringField(
      action.target,
      "job_id",
      action.id,
      "target",
    );
    const jobUrl = getRequiredStringField(
      action.target,
      "job_url",
      action.id,
      "target",
    );
    const phoneNumber = getOptionalStringField(action.payload, "phone_number");
    const email = getOptionalStringField(action.payload, "email");
    const city = getOptionalStringField(action.payload, "city");
    const resumePath = getOptionalStringField(action.payload, "resume_path");
    const coverLetter = getOptionalStringField(action.payload, "cover_letter");
    const answers = getOptionalAnswersField(
      action.payload,
      "answers",
      action.id,
      "payload",
    );

    const validatedInput: ValidatedEasyApplyInput = {
      profileName,
      jobId,
      jobUrl,
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(email ? { email } : {}),
      ...(city ? { city } : {}),
      ...(resumePath ? { resumePath } : {}),
      ...(coverLetter ? { coverLetter } : {}),
      answers,
    };

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
          actionType: EASY_APPLY_JOB_ACTION_TYPE,
          profileName,
          targetUrl: jobUrl,
          metadata: {
            job_id: jobId,
            job_url: jobUrl,
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl,
          },
          mapError: (error) =>
            asLinkedInBuddyError(
              error,
              "UNKNOWN",
              "Failed to submit a LinkedIn Easy Apply application.",
            ),
          execute: async () => {
            const rateLimitState = consumeRateLimitOrThrow(
              runtime.rateLimiter,
              {
                config: EASY_APPLY_RATE_LIMIT_CONFIG,
                message: createConfirmRateLimitMessage(
                  EASY_APPLY_JOB_ACTION_TYPE,
                ),
                details: {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                },
              },
            );

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);

            const easyApplyButton = await markJobsButton(page, "easy-apply");
            await easyApplyButton.click();

            const dialogVisible = await waitForCondition(async () => {
              const dialogSnapshot = await readEasyApplyDialogSnapshot(page);
              return dialogSnapshot.visible;
            }, 8_000);

            if (!dialogVisible) {
              throw new LinkedInBuddyError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Easy Apply modal did not appear after clicking the Easy Apply button.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  job_url: jobUrl,
                },
              );
            }

            const encounteredFields = new Set<string>();
            let currentActionLabel = "";

            for (let stepIndex = 0; stepIndex < 6; stepIndex += 1) {
              const snapshot = await readEasyApplyDialogSnapshot(page);
              if (!snapshot.visible) {
                break;
              }

              for (const field of snapshot.fields) {
                if (field.label) {
                  encounteredFields.add(field.label);
                }
              }

              if (snapshot.success) {
                break;
              }

              await fillEasyApplyStep(page, snapshot, validatedInput);

              currentActionLabel = snapshot.primaryActionLabel;
              const actionKind =
                classifyEasyApplyActionLabel(currentActionLabel);
              if (actionKind === "unknown") {
                throw new LinkedInBuddyError(
                  "UI_CHANGED_SELECTOR_FAILED",
                  "Easy Apply surfaced an unsupported primary action button.",
                  {
                    action_id: action.id,
                    profile_name: profileName,
                    job_id: jobId,
                    primary_action_label: currentActionLabel,
                  },
                );
              }

              await clickEasyApplyPrimaryAction(page);
              await page.waitForTimeout(500);
              await waitForNetworkIdleBestEffort(page, 4_000);

              if (actionKind === "submit") {
                break;
              }
            }

            const success = await waitForEasyApplySuccess(page);
            if (!success) {
              throw new LinkedInBuddyError(
                "UNKNOWN",
                "Easy Apply submission could not be verified.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  last_primary_action_label: currentActionLabel,
                  encountered_fields: [...encounteredFields],
                },
              );
            }

            const screenshotPath = `linkedin/screenshot-job-easy-apply-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: EASY_APPLY_JOB_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl,
            });

            return {
              ok: true,
              result: {
                submitted: true,
                job_id: jobId,
                job_url: jobUrl,
                answered_fields: [...encounteredFields],
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

export function createJobActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInJobsExecutorRuntime>
> {
  return {
    [SAVE_JOB_ACTION_TYPE]: new SaveJobActionExecutor(),
    [UNSAVE_JOB_ACTION_TYPE]: new UnsaveJobActionExecutor(),
    [CREATE_JOB_ALERT_ACTION_TYPE]: new CreateJobAlertActionExecutor(),
    [REMOVE_JOB_ALERT_ACTION_TYPE]: new RemoveJobAlertActionExecutor(),
    [EASY_APPLY_JOB_ACTION_TYPE]: new EasyApplyJobActionExecutor(),
  };
}

export class LinkedInJobsService {
  constructor(private readonly runtime: LinkedInJobsRuntime) {}

  private prepareJobToggleAction(input: {
    actionType: string;
    profileName?: string | undefined;
    jobId: string;
    summary: string;
    rateLimitConfig: {
      counterKey: string;
      windowSizeMs: number;
      limit: number;
    };
    operatorNote?: string | undefined;
    outboundAction: "save" | "unsave";
  }): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const jobId = normalizeText(input.jobId);

    if (!jobId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "jobId is required.",
      );
    }

    const jobUrl = buildJobViewUrl(jobId);
    const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
      config: input.rateLimitConfig,
      message: createPrepareRateLimitMessage(input.actionType),
    });
    const target = {
      profile_name: profileName,
      job_id: jobId,
      job_url: jobUrl,
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target,
      payload: {},
      preview: {
        summary: input.summary,
        target,
        outbound: {
          action: input.outboundAction,
        },
        risk_level: "low",
        rate_limit: formatRateLimitState(rateLimitState),
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  async searchJobs(input: SearchJobsInput): Promise<SearchJobsOutput> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const location = normalizeText(input.location);
    const limit = readLimit(input.limit, 10, JOB_SEARCH_LIMIT_MAX);

    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    if (query.length > JOB_SEARCH_QUERY_MAX_LENGTH) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      const results = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildJobSearchUrl(query, location || undefined), {
            waitUntil: "domcontentloaded",
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobSearchSurface(page);
          return loadJobSearchResults(page, limit);
        },
      );

      return {
        query,
        location,
        results,
        count: results.length,
      };
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to search LinkedIn jobs.",
      );
    }
  }

  async viewJob(input: ViewJobInput): Promise<LinkedInJobPosting> {
    const profileName = input.profileName ?? "default";
    const jobId = normalizeText(input.jobId);

    if (!jobId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "jobId is required.",
      );
    }

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
          await page.goto(buildJobViewUrl(jobId), {
            waitUntil: "domcontentloaded",
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobDetailSurface(page);
          return extractJobDetail(page, jobId);
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn job posting.",
      );
    }
  }

  prepareSaveJob(input: PrepareSaveJobInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const jobId = normalizeText(input.jobId);
    return this.prepareJobToggleAction({
      actionType: SAVE_JOB_ACTION_TYPE,
      profileName: input.profileName,
      jobId,
      summary: `Save LinkedIn job ${buildJobViewUrl(jobId)} for later`,
      rateLimitConfig: SAVE_JOB_RATE_LIMIT_CONFIG,
      operatorNote: input.operatorNote,
      outboundAction: "save",
    });
  }

  prepareUnsaveJob(input: PrepareUnsaveJobInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const jobId = normalizeText(input.jobId);
    return this.prepareJobToggleAction({
      actionType: UNSAVE_JOB_ACTION_TYPE,
      profileName: input.profileName,
      jobId,
      summary: `Unsave LinkedIn job ${buildJobViewUrl(jobId)}`,
      rateLimitConfig: UNSAVE_JOB_RATE_LIMIT_CONFIG,
      operatorNote: input.operatorNote,
      outboundAction: "unsave",
    });
  }

  async listJobAlerts(
    input: ListJobAlertsInput = {},
  ): Promise<ListJobAlertsOutput> {
    const profileName = input.profileName ?? "default";
    const limit = readLimit(input.limit, 20, JOB_ALERTS_LIMIT_MAX);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      const alerts = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildJobAlertsUrl(), {
            waitUntil: "domcontentloaded",
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobAlertsSurface(page);
          return extractJobAlerts(page, limit);
        },
      );

      return {
        alerts,
        count: alerts.length,
      };
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to list LinkedIn job alerts.",
      );
    }
  }

  prepareCreateJobAlert(input: PrepareCreateJobAlertInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const location = normalizeText(input.location);

    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    if (query.length > JOB_SEARCH_QUERY_MAX_LENGTH) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
      );
    }

    const searchUrl = buildJobSearchUrl(query, location || undefined);
    const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
      config: CREATE_JOB_ALERT_RATE_LIMIT_CONFIG,
      message: createPrepareRateLimitMessage(CREATE_JOB_ALERT_ACTION_TYPE),
    });
    const target = {
      profile_name: profileName,
      query,
      location,
      search_url: searchUrl,
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: CREATE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Create a LinkedIn job alert for "${query}"${location ? ` in ${location}` : ""}`,
        target,
        outbound: {
          action: "create_alert",
        },
        risk_level: "low",
        rate_limit: formatRateLimitState(rateLimitState),
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  async prepareRemoveJobAlert(input: PrepareRemoveJobAlertInput): Promise<{
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  }> {
    const profileName = input.profileName ?? "default";
    const providedAlertId = normalizeText(input.alertId);
    const providedSearch = parseJobSearchUrl(input.searchUrl ?? "");
    const query = normalizeText(input.query) || providedSearch.query;
    const location = normalizeText(input.location) || providedSearch.location;
    let searchUrl = providedSearch.normalizedUrl;
    let alertId = providedAlertId;

    if (query.length > JOB_SEARCH_QUERY_MAX_LENGTH) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `query must not exceed ${JOB_SEARCH_QUERY_MAX_LENGTH} characters.`,
      );
    }

    if (!searchUrl && query) {
      searchUrl = buildJobSearchUrl(query, location || undefined);
    }

    if (!searchUrl && providedAlertId) {
      const alerts = await this.listJobAlerts({
        profileName,
        limit: 100,
      });
      const matchedAlert = alerts.alerts.find(
        (alert) => normalizeText(alert.alert_id) === providedAlertId,
      );
      if (!matchedAlert) {
        throw new LinkedInBuddyError(
          "TARGET_NOT_FOUND",
          `Could not find a LinkedIn job alert with id "${providedAlertId}".`,
          {
            alert_id: providedAlertId,
          },
        );
      }

      searchUrl = matchedAlert.search_url;
      alertId = matchedAlert.alert_id;
    }

    if (!searchUrl) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Provide alertId, searchUrl, or query to remove a job alert.",
      );
    }

    const resolvedSearch = parseJobSearchUrl(searchUrl);
    const resolvedQuery = query || resolvedSearch.query;
    const resolvedLocation = location || resolvedSearch.location;
    const resolvedAlertId =
      alertId ||
      buildJobAlertIdentifier(searchUrl, resolvedQuery, resolvedLocation);
    const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
      config: REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG,
      message: createPrepareRateLimitMessage(REMOVE_JOB_ALERT_ACTION_TYPE),
    });
    const target = {
      profile_name: profileName,
      alert_id: resolvedAlertId,
      query: resolvedQuery,
      location: resolvedLocation,
      search_url: resolvedSearch.normalizedUrl || searchUrl,
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Remove LinkedIn job alert for "${resolvedQuery}"${resolvedLocation ? ` in ${resolvedLocation}` : ""}`,
        target,
        outbound: {
          action: "remove_alert",
        },
        risk_level: "low",
        rate_limit: formatRateLimitState(rateLimitState),
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }

  prepareEasyApply(input: PrepareEasyApplyInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const validatedInput = validateEasyApplyInput(input);
    const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
      config: EASY_APPLY_RATE_LIMIT_CONFIG,
      message: createPrepareRateLimitMessage(EASY_APPLY_JOB_ACTION_TYPE),
    });

    const target = {
      profile_name: validatedInput.profileName,
      job_id: validatedInput.jobId,
      job_url: validatedInput.jobUrl,
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: EASY_APPLY_JOB_ACTION_TYPE,
      target,
      payload: {
        ...(validatedInput.phoneNumber
          ? { phone_number: validatedInput.phoneNumber }
          : {}),
        ...(validatedInput.email ? { email: validatedInput.email } : {}),
        ...(validatedInput.city ? { city: validatedInput.city } : {}),
        ...(validatedInput.resumePath
          ? { resume_path: validatedInput.resumePath }
          : {}),
        ...(validatedInput.coverLetter
          ? { cover_letter: validatedInput.coverLetter }
          : {}),
        ...(Object.keys(validatedInput.answers).length > 0
          ? { answers: validatedInput.answers }
          : {}),
      },
      preview: {
        summary: `Submit LinkedIn Easy Apply application for ${validatedInput.jobUrl}`,
        target,
        outbound: {
          action: "easy_apply",
          phone_number_supplied: Boolean(validatedInput.phoneNumber),
          email_supplied: Boolean(validatedInput.email),
          city_supplied: Boolean(validatedInput.city),
          resume_filename: validatedInput.resumePath
            ? path.basename(validatedInput.resumePath)
            : "",
          cover_letter_supplied: Boolean(validatedInput.coverLetter),
          answer_keys: Object.keys(validatedInput.answers),
        },
        risk_level: "high",
        rate_limit: formatRateLimitState(rateLimitState),
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
  }
}
