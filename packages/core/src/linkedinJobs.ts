import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
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
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import { valueContainsLinkedInSelectorPhrase } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

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

export interface SearchJobsOutput {
  query: string;
  location: string;
  results: LinkedInJobSearchResult[];
  count: number;
}

export interface LinkedInJobsRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInJobsExecutorRuntime>, "prepare">;
}

export interface LinkedInJobsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface SaveJobInput {
  profileName?: string;
  jobId: string;
  operatorNote?: string;
}

export interface UnsaveJobInput {
  profileName?: string;
  jobId: string;
  operatorNote?: string;
}

export const LINKEDIN_JOB_ALERT_FREQUENCIES = ["daily", "weekly"] as const;
export type LinkedInJobAlertFrequency =
  (typeof LINKEDIN_JOB_ALERT_FREQUENCIES)[number];

export const LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES = [
  "email_and_notification",
  "email",
  "notification"
] as const;
export type LinkedInJobAlertNotificationType =
  (typeof LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES)[number];

export interface CreateJobAlertInput {
  profileName?: string;
  query: string;
  location?: string;
  frequency?: LinkedInJobAlertFrequency | string;
  notificationType?: LinkedInJobAlertNotificationType | string;
  includeSimilarJobs?: boolean;
  operatorNote?: string;
}

export interface ListJobAlertsInput {
  profileName?: string;
}

export interface RemoveJobAlertInput {
  profileName?: string;
  alertId: string;
  operatorNote?: string;
}

export interface LinkedInJobAlert {
  alert_id: string;
  query: string;
  location: string;
  search_url: string;
  filters_text: string;
  frequency: LinkedInJobAlertFrequency;
  notification_type: LinkedInJobAlertNotificationType;
  frequency_text: string;
  include_similar_jobs: boolean;
}

export interface ListJobAlertsOutput {
  alerts: LinkedInJobAlert[];
  count: number;
}

export interface LinkedInEasyApplyApplicationDraft {
  email?: string;
  phoneCountryCode?: string;
  phoneNumber?: string;
  resumePath?: string;
  coverLetterPath?: string;
  answers?: Record<string, string | boolean>;
}

export interface PrepareEasyApplyInput {
  profileName?: string;
  jobId: string;
  application?: LinkedInEasyApplyApplicationDraft;
  operatorNote?: string;
}

export const SAVE_JOB_ACTION_TYPE = "jobs.save_job";
export const UNSAVE_JOB_ACTION_TYPE = "jobs.unsave_job";
export const CREATE_JOB_ALERT_ACTION_TYPE = "jobs.create_alert";
export const REMOVE_JOB_ALERT_ACTION_TYPE = "jobs.remove_alert";
export const EASY_APPLY_ACTION_TYPE = "jobs.easy_apply";

const JOB_ALERTS_URL = "https://www.linkedin.com/jobs/jam/";

const SAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.save_job",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40
} as const;

const UNSAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.unsave_job",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40
} as const;

const CREATE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.create_alert",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} as const;

const REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.remove_alert",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} as const;

const EASY_APPLY_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.easy_apply",
  windowSizeMs: 24 * 60 * 60 * 1000,
  limit: 5
} as const;

interface ExtractedJobAlertRow {
  alertId: string;
  query: string;
  location: string;
  searchUrl: string;
  filtersText: string;
  frequencyText: string;
  rowIndex: number;
}

interface JobAlertEditSettings {
  frequency: LinkedInJobAlertFrequency;
  notificationType: LinkedInJobAlertNotificationType;
  includeSimilarJobs: boolean;
}

interface EasyApplyFieldOption {
  value: string;
  label: string;
  id: string;
}

interface EasyApplyFieldSnapshot {
  fieldKey: string;
  id: string;
  name: string;
  label: string;
  inputType: string;
  required: boolean;
  currentValue: string | boolean | null;
  options: EasyApplyFieldOption[];
}

interface EasyApplyStepSnapshot {
  stepIndex: number;
  stepTitle: string;
  fields: EasyApplyFieldSnapshot[];
  availableActions: string[];
}

interface EasyApplyPreparedField {
  field_key: string;
  label: string;
  input_type: string;
  required: boolean;
  step_index: number;
  step_title: string;
  options?: string[];
  supplied: boolean;
}

interface EasyApplyInspectionResult {
  readyToConfirm: boolean;
  steps: EasyApplyStepSnapshot[];
  fields: EasyApplyPreparedField[];
  blockingFields: EasyApplyPreparedField[];
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function readJobsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  return Math.max(1, Math.floor(value));
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

export function buildJobSearchUrl(
  query: string,
  location?: string
): string {
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

async function waitForJobSearchSurface(page: Page): Promise<void> {
  const selectors = [
    ".job-card-container",
    ".base-search-card",
    ".jobs-search-results-list",
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
    "Could not locate LinkedIn job search content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForJobDetailSurface(page: Page): Promise<void> {
  const selectors = [
    ".job-details-jobs-unified-top-card",
    ".jobs-details",
    ".jobs-unified-top-card",
    ".job-view-layout",
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
    "Could not locate LinkedIn job detail content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

interface JobSearchSnapshot {
  job_id: string;
  title: string;
  company: string;
  location: string;
  posted_at: string;
  job_url: string;
  salary_range: string;
  employment_type: string;
}

interface JobDetailSnapshot {
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

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractJobSearchResults(
  page: Page,
  limit: number
): Promise<LinkedInJobSearchResult[]> {
  const snapshots = await page.evaluate((maxJobs: number) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const origin = globalThis.window.location.origin;

    const pickText = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const text = normalize(root.querySelector(selector)?.textContent);
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

    const pickHref = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const linkElement = root.querySelector(
          selector
        ) as HTMLAnchorElement | null;
        const href = toAbsoluteHref(
          normalize(linkElement?.getAttribute("href")) ||
            normalize(linkElement?.href)
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
        normalize(root.querySelector("[data-job-id]")?.getAttribute("data-job-id"))
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
      const signal = pickText(root, [
        ".job-card-container__metadata-item",
        ".job-card-container__job-insight",
        ".base-search-card__metadata"
      ]);
      if (!signal) {
        return "";
      }

      const match = /(Full-time|Part-time|Contract|Temporary|Internship)/i.exec(
        signal
      );
      return normalize(match?.[1] ?? "");
    };

    const cards = Array.from(
      globalThis.document.querySelectorAll(
        ".job-card-container, .base-search-card, .job-card-list__entity-lockup"
      )
    ).slice(0, maxJobs);

    const results: JobSearchSnapshot[] = [];
    for (const card of cards) {
      const jobUrl = pickHref(card, [
        "a[href*='/jobs/view/']",
        ".job-card-container__link",
        ".base-search-card__full-link",
        "a"
      ]);

      results.push({
        job_id: extractJobId(jobUrl, card),
        title: pickText(card, [
          ".job-card-container__link",
          ".base-search-card__title",
          ".job-card-list__title"
        ]),
        company: pickText(card, [
          ".job-card-container__company-name",
          ".base-search-card__subtitle",
          ".job-card-container__primary-description"
        ]),
        location: pickText(card, [
          ".job-card-container__metadata-wrapper",
          ".job-search-card__location",
          ".job-card-container__metadata-item"
        ]),
        posted_at: pickText(card, [
          "time",
          ".job-card-container__footer",
          ".job-card-container__listed-time"
        ]),
        job_url: jobUrl,
        salary_range: pickText(card, [
          ".job-card-container__salary-info",
          ".salary-main-rail__compensation-text"
        ]),
        employment_type: pickEmploymentType(card)
      });

      if (results.length >= maxJobs) {
        break;
      }
    }

    return results;
  }, Math.max(1, limit));

  return snapshots
    .map((snapshot) => ({
      job_id: normalizeText(snapshot.job_id),
      title: normalizeText(snapshot.title),
      company: normalizeText(snapshot.company),
      location: normalizeText(snapshot.location),
      posted_at: normalizeText(snapshot.posted_at),
      job_url: normalizeText(snapshot.job_url),
      salary_range: normalizeText(snapshot.salary_range),
      employment_type: normalizeText(snapshot.employment_type)
    }))
    .filter((result) => result.title.length > 0 || result.job_url.length > 0)
    .slice(0, limit);
}

async function extractJobDetail(
  page: Page,
  jobId: string
): Promise<LinkedInJobPosting> {
  const snapshot = await page.evaluate((passedJobId: string) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const origin = globalThis.window.location.origin;

    const pickText = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const text = normalize(root.querySelector(selector)?.textContent);
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

    const companyLinkElement = main.querySelector(
      "a[href*='/company/']"
    ) as HTMLAnchorElement | null;

    const title = pickText(main, [
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",
      "h1"
    ]);

    const company = pickText(main, [
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name",
      ".top-card-layout__card-link",
      "a[href*='/company/']"
    ]);

    const companyUrl = toAbsoluteHref(
      normalize(companyLinkElement?.getAttribute("href")) ||
        normalize(companyLinkElement?.href)
    );

    const location = pickText(main, [
      ".job-details-jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__subtitle-primary-grouping .jobs-unified-top-card__bullet",
      ".top-card-layout__second-subline .topcard__flavor--bullet",
      ".jobs-unified-top-card__workplace-type"
    ]);

    const postedAt = pickText(main, [
      ".job-details-jobs-unified-top-card__posted-date",
      ".jobs-unified-top-card__posted-date",
      "time",
      ".posted-time-ago__text"
    ]);

    const description = pickText(main, [
      ".jobs-description__content",
      ".jobs-description-content__text",
      ".jobs-box__html-content",
      ".description__text",
      "#job-details"
    ]);

    const insightTexts = Array.from(
      main.querySelectorAll(
        ".job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight, .description__job-criteria-item, .job-criteria__item"
      )
    ).map((el) => normalize(el.textContent));

    const allInsights = insightTexts.join(" ");

    const salaryRange =
      pickText(main, [
        ".salary-main-rail__compensation-text",
        ".job-details-jobs-unified-top-card__salary-info",
        ".compensation__salary"
      ]) || (() => {
        const salaryMatch =
          /(\$[\d,]+\s*[-–]\s*\$[\d,]+|€[\d,]+\s*[-–]\s*€[\d,]+|£[\d,]+\s*[-–]\s*£[\d,]+|[\d,]+\s*[-–]\s*[\d,]+\s*(?:kr|DKK|USD|EUR|GBP))/i.exec(
            allInsights
          );
        return normalize(salaryMatch?.[1] ?? "");
      })();

    const employmentTypeMatch =
      /(Full-time|Part-time|Contract|Temporary|Internship)/i.exec(allInsights);
    const employmentType = normalize(employmentTypeMatch?.[1] ?? "");

    const seniorityMatch =
      /(Entry level|Associate|Mid-Senior level|Director|Executive|Internship|Not Applicable)/i.exec(
        allInsights
      );
    const seniorityLevel = normalize(seniorityMatch?.[1] ?? "");

    const applicantCount = pickText(main, [
      ".jobs-unified-top-card__applicant-count",
      ".job-details-jobs-unified-top-card__applicant-count",
      ".num-applicants__caption"
    ]);

    const isRemote =
      /\bremote\b/i.test(location) ||
      /\bremote\b/i.test(allInsights);

    const jobUrl = globalThis.window.location.href;

    const result: JobDetailSnapshot = {
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
      is_remote: isRemote
    };

    return result;
  }, jobId);

  return {
    job_id: normalizeText(snapshot.job_id) || jobId,
    title: normalizeText(snapshot.title),
    company: normalizeText(snapshot.company),
    company_url: normalizeText(snapshot.company_url),
    location: normalizeText(snapshot.location),
    posted_at: normalizeText(snapshot.posted_at),
    description: normalizeText(snapshot.description),
    salary_range: normalizeText(snapshot.salary_range),
    employment_type: normalizeText(snapshot.employment_type),
    job_url: normalizeText(snapshot.job_url),
    applicant_count: normalizeText(snapshot.applicant_count),
    seniority_level: normalizeText(snapshot.seniority_level),
    is_remote: Boolean(snapshot.is_remote)
  };
}

async function loadJobSearchResults(
  page: Page,
  limit: number
): Promise<LinkedInJobSearchResult[]> {
  let results = await extractJobSearchResults(page, limit);

  for (let i = 0; i < 6 && results.length < limit; i++) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    results = await extractJobSearchResults(page, limit);
  }

  return results.slice(0, Math.max(1, limit));
}
/* eslint-enable no-undef */

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

function normalizeComparisonText(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function dedupeRepeatedText(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const duplicateMatch = /^(.+?)\s*\1$/iu.exec(normalized);
  if (duplicateMatch?.[1]) {
    return normalizeText(duplicateMatch[1]);
  }

  return normalized;
}

function buildJobAlertId(searchUrl: string): string {
  const digest = createHash("sha256")
    .update(normalizeText(searchUrl))
    .digest("hex")
    .slice(0, 16);
  return `ja_${digest}`;
}

export function normalizeLinkedInJobAlertFrequency(
  value: string | undefined,
  fallback: LinkedInJobAlertFrequency = "daily"
): LinkedInJobAlertFrequency {
  const normalized = normalizeComparisonText(value).replace(/[\s-]+/gu, "_");
  if (!normalized) {
    return fallback;
  }

  if (normalized === "daily" || normalized === "day") {
    return "daily";
  }
  if (normalized === "weekly" || normalized === "week") {
    return "weekly";
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `frequency must be one of: ${LINKEDIN_JOB_ALERT_FREQUENCIES.join(", ")}.`
  );
}

export function normalizeLinkedInJobAlertNotificationType(
  value: string | undefined,
  fallback: LinkedInJobAlertNotificationType = "email_and_notification"
): LinkedInJobAlertNotificationType {
  const normalized = normalizeComparisonText(value).replace(/[\s-]+/gu, "_");
  if (!normalized) {
    return fallback;
  }

  if (
    normalized === "email_and_notification" ||
    normalized === "both" ||
    normalized === "email_notification"
  ) {
    return "email_and_notification";
  }
  if (normalized === "email" || normalized === "email_only") {
    return "email";
  }
  if (normalized === "notification" || normalized === "notification_only") {
    return "notification";
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `notificationType must be one of: ${LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES.join(", ")}.`
  );
}

function parseJobAlertFrequencyText(value: string): {
  frequency: LinkedInJobAlertFrequency;
  notificationType: LinkedInJobAlertNotificationType;
} {
  const normalized = normalizeComparisonText(value);
  const frequency: LinkedInJobAlertFrequency = normalized.includes("weekly")
    ? "weekly"
    : "daily";

  if (normalized.includes("email and notification")) {
    return {
      frequency,
      notificationType: "email_and_notification"
    };
  }

  if (
    normalized.includes("notification only") ||
    normalized.endsWith("via notification") ||
    normalized.includes(" via notification ")
  ) {
    return {
      frequency,
      notificationType: "notification"
    };
  }

  return {
    frequency,
    notificationType: "email"
  };
}

export function resolveLinkedInJobId(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "jobId is required."
    );
  }

  if (/^\d+$/.test(normalized)) {
    return normalized;
  }

  try {
    const parsedUrl = new URL(
      normalized.startsWith("http")
        ? normalized
        : normalized.startsWith("/")
          ? `https://www.linkedin.com${normalized}`
          : `https://www.linkedin.com/jobs/view/${encodeURIComponent(normalized)}/`
    );
    const viewMatch = /\/jobs\/view\/(\d+)/iu.exec(parsedUrl.pathname);
    if (viewMatch?.[1]) {
      return viewMatch[1];
    }

    const currentJobId = normalizeText(parsedUrl.searchParams.get("currentJobId"));
    if (/^\d+$/.test(currentJobId)) {
      return currentJobId;
    }
  } catch {
    // Fall through to pattern matching on the raw string.
  }

  const rawMatch = /(\d{6,})/u.exec(normalized);
  if (rawMatch?.[1]) {
    return rawMatch[1];
  }

  return normalized;
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function normalizeEasyApplyKey(value: string): string {
  return normalizeComparisonText(value)
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function ensureLocalFileExists(filePath: string, label: string): string {
  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} does not exist.`,
      {
        path: resolvedPath
      }
    );
  }

  return resolvedPath;
}

function normalizeEasyApplyApplicationDraft(
  application: LinkedInEasyApplyApplicationDraft | undefined
): LinkedInEasyApplyApplicationDraft {
  if (!application) {
    return {};
  }

  const normalizedAnswers: Record<string, string | boolean> = {};
  if (application.answers) {
    for (const [rawKey, rawValue] of Object.entries(application.answers)) {
      const normalizedKey = normalizeEasyApplyKey(rawKey);
      if (!normalizedKey) {
        continue;
      }

      if (typeof rawValue === "boolean") {
        normalizedAnswers[normalizedKey] = rawValue;
        continue;
      }

      if (typeof rawValue === "string") {
        const normalizedValue = normalizeText(rawValue);
        if (normalizedValue) {
          normalizedAnswers[normalizedKey] = normalizedValue;
        }
      }
    }
  }

  const normalizedApplication: LinkedInEasyApplyApplicationDraft = {
    ...(application.email
      ? {
          email: normalizeText(application.email)
        }
      : {}),
    ...(application.phoneCountryCode
      ? {
          phoneCountryCode: normalizeText(application.phoneCountryCode)
        }
      : {}),
    ...(application.phoneNumber
      ? {
          phoneNumber: normalizeText(application.phoneNumber)
        }
      : {}),
    ...(application.resumePath
      ? {
          resumePath: ensureLocalFileExists(application.resumePath, "resumePath")
        }
      : {}),
    ...(application.coverLetterPath
      ? {
          coverLetterPath: ensureLocalFileExists(
            application.coverLetterPath,
            "coverLetterPath"
          )
        }
      : {}),
    ...(Object.keys(normalizedAnswers).length > 0
      ? {
          answers: normalizedAnswers
        }
      : {})
  };

  return normalizedApplication;
}

function lookupEasyApplyAnswer(
  field: EasyApplyFieldSnapshot,
  application: LinkedInEasyApplyApplicationDraft
): string | boolean | undefined {
  const label = normalizeComparisonText(field.label);

  if (field.inputType === "file") {
    if (label.includes("resume")) {
      return application.resumePath;
    }
    if (label.includes("cover")) {
      return application.coverLetterPath;
    }
  }

  if (label.includes("email")) {
    return application.email;
  }
  if (label.includes("phone country")) {
    return application.phoneCountryCode;
  }
  if (label.includes("phone")) {
    return application.phoneNumber;
  }

  return application.answers?.[field.fieldKey];
}

function isEasyApplyFieldRequired(field: EasyApplyFieldSnapshot): boolean {
  const label = normalizeComparisonText(field.label);
  return (
    field.required ||
    (field.inputType === "file" && label.includes("resume"))
  );
}

function isEasyApplyFieldSatisfied(
  field: EasyApplyFieldSnapshot,
  application: LinkedInEasyApplyApplicationDraft
): boolean {
  const providedValue = lookupEasyApplyAnswer(field, application);
  if (typeof providedValue === "boolean") {
    return true;
  }
  if (typeof providedValue === "string" && normalizeText(providedValue).length > 0) {
    return true;
  }
  if (typeof field.currentValue === "boolean") {
    return true;
  }
  return normalizeText(
    typeof field.currentValue === "string" ? field.currentValue : ""
  ).length > 0;
}

function toPreparedEasyApplyField(
  field: EasyApplyFieldSnapshot,
  step: EasyApplyStepSnapshot,
  application: LinkedInEasyApplyApplicationDraft
): EasyApplyPreparedField {
  return {
    field_key: field.fieldKey,
    label: field.label,
    input_type: field.inputType,
    required: isEasyApplyFieldRequired(field),
    step_index: step.stepIndex,
    step_title: step.stepTitle,
    ...(field.options.length > 0
      ? {
          options: field.options.map((option) => option.label || option.value)
        }
      : {}),
    supplied: isEasyApplyFieldSatisfied(field, application)
  };
}

async function captureScreenshotArtifact(
  runtime: LinkedInJobsExecutorRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return false;
}

async function waitForJobAlertsSurface(page: Page): Promise<void> {
  const selectors = [
    ".jam-index-modal--body ul li",
    ".jam-index-modal",
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
    "Could not locate LinkedIn job alerts content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForJobAlertEditSurface(page: Page): Promise<void> {
  const selectors = [
    "input[name='notificationFrequency']",
    "input[name='notificationPlatform']",
    ".artdeco-modal"
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
    "Could not locate the LinkedIn job alert editor.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForEasyApplyModal(page: Page): Promise<void> {
  const selectors = [
    ".artdeco-modal button",
    ".jobs-easy-apply-modal",
    "[role='dialog']"
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
    "Could not locate the LinkedIn Easy Apply modal.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function resolveJobSaveButton(page: Page): Promise<Locator> {
  const locator = page.locator(".jobs-save-button").first();
  if ((await locator.count()) === 0) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn save job button.",
      {
        current_url: page.url(),
        attempted_selectors: [".jobs-save-button"]
      }
    );
  }

  await locator.waitFor({
    state: "visible",
    timeout: 5_000
  });

  return locator;
}

async function readJobSavedState(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<boolean> {
  const button = await resolveJobSaveButton(page);
  const textLocator = button.locator(".jobs-save-button__text").first();
  const label =
    normalizeText(
      (await textLocator.count()) > 0
        ? await textLocator.textContent()
        : await button.textContent()
    ) || normalizeText(await button.getAttribute("aria-label"));

  if (!label) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not determine the LinkedIn save job button state.",
      {
        current_url: page.url()
      }
    );
  }

  if (
    valueContainsLinkedInSelectorPhrase(label, "saved", selectorLocale) ||
    /^saved\b/iu.test(label)
  ) {
    return true;
  }

  return false;
}

async function readJobAlertToggleState(page: Page): Promise<boolean> {
  const locator = page
    .locator(".jobs-search-create-alert__artdeco-toggle input[type='checkbox']")
    .first();
  if ((await locator.count()) === 0) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn job alert toggle on the search page.",
      {
        current_url: page.url(),
        attempted_selectors: [
          ".jobs-search-create-alert__artdeco-toggle input[type='checkbox']"
        ]
      }
    );
  }

  return locator.isChecked();
}

/* eslint-disable no-undef -- DOM globals and element types are valid inside page.evaluate() */
async function extractJobAlertRows(page: Page): Promise<ExtractedJobAlertRow[]> {
  const rows = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    return Array.from(
      document.querySelectorAll(".jam-index-modal--body ul li")
    ).map((row, rowIndex) => {
      const linkElement = row.querySelector("a[href*='/jobs/search']");
      const query = normalize(linkElement?.textContent);
      const searchUrl =
        normalize((linkElement as HTMLAnchorElement | null)?.href) ||
        normalize(linkElement?.getAttribute("href"));
      const location = normalize(
        row.querySelector(".display-flex > div > span")?.textContent
      );
      const detailBlocks = Array.from(row.querySelectorAll(".t-12")).map((block) =>
        normalize(block.textContent)
      );

      return {
        query,
        location,
        searchUrl,
        filtersText: detailBlocks.find((block) => block.startsWith("Filters:")) ?? "",
        frequencyText:
          detailBlocks.find((block) => block.startsWith("Frequency:")) ?? "",
        rowIndex
      };
    });
  });

  return rows
    .map((row) => ({
      ...row,
      alertId: buildJobAlertId(row.searchUrl)
    }))
    .filter((row) => row.query.length > 0 && row.searchUrl.length > 0);
}

async function openJobAlertEditModal(
  page: Page,
  rowIndex: number
): Promise<void> {
  const locator = page.locator(`#editAlertIndex__${rowIndex}`).first();
  if ((await locator.count()) === 0) {
    throw new LinkedInAssistantError(
      "TARGET_NOT_FOUND",
      "Could not locate the requested LinkedIn job alert row.",
      {
        row_index: rowIndex,
        current_url: page.url()
      }
    );
  }

  await locator.click({
    timeout: 5_000
  });
  await waitForJobAlertEditSurface(page);
}

async function readJobAlertEditSettings(
  page: Page
): Promise<JobAlertEditSettings> {
  const state = await page.evaluate(() => {
    const dialog =
      Array.from(document.querySelectorAll(".artdeco-modal")).at(-1) ??
      document.body;

    const frequencyId = (
      dialog.querySelector(
        "input[name='notificationFrequency']:checked"
      ) as HTMLInputElement | null
    )?.id;
    const notificationValue = (
      dialog.querySelector(
        "input[name='notificationPlatform']:checked"
      ) as HTMLInputElement | null
    )?.value;
    const includeSimilarJobs = Boolean(
      (
        dialog.querySelector(
          "input[type='checkbox'].artdeco-toggle__button"
        ) as HTMLInputElement | null
      )?.checked
    );

    return {
      frequencyId: frequencyId ?? "",
      notificationValue: notificationValue ?? "",
      includeSimilarJobs
    };
  });

  return {
    frequency:
      state.frequencyId === "alert-frequency-weekly" ? "weekly" : "daily",
    notificationType:
      state.notificationValue === "notificationOnly"
        ? "notification"
        : state.notificationValue === "emailOnly"
          ? "email"
          : "email_and_notification",
    includeSimilarJobs: state.includeSimilarJobs
  };
}

function toLinkedInJobAlert(
  row: ExtractedJobAlertRow,
  settings?: JobAlertEditSettings
): LinkedInJobAlert {
  const parsed = parseJobAlertFrequencyText(row.frequencyText);
  const resolvedSettings = settings ?? {
    frequency: parsed.frequency,
    notificationType: parsed.notificationType,
    includeSimilarJobs: false
  };

  return {
    alert_id: row.alertId,
    query: row.query,
    location: row.location,
    search_url: row.searchUrl,
    filters_text: row.filtersText,
    frequency: resolvedSettings.frequency,
    notification_type: resolvedSettings.notificationType,
    frequency_text: row.frequencyText,
    include_similar_jobs: resolvedSettings.includeSimilarJobs
  };
}

function findMatchingJobAlertRow(
  rows: ExtractedJobAlertRow[],
  query: string,
  location: string
): ExtractedJobAlertRow | undefined {
  const normalizedQuery = normalizeComparisonText(query);
  const normalizedLocation = normalizeComparisonText(location);

  return rows.find((row) => {
    if (normalizeComparisonText(row.query) !== normalizedQuery) {
      return false;
    }

    if (!normalizedLocation) {
      return true;
    }

    const rowLocation = normalizeComparisonText(row.location);
    return (
      rowLocation.includes(normalizedLocation) ||
      normalizedLocation.includes(rowLocation)
    );
  });
}

async function closeJobAlertEditModal(page: Page, save: boolean): Promise<void> {
  const selector = save
    ? ".artdeco-modal button.artdeco-button--primary"
    : ".artdeco-modal button.artdeco-button--secondary";
  const button = page.locator(selector).last();
  if ((await button.count()) === 0) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the expected LinkedIn job alert modal footer button.",
      {
        current_url: page.url(),
        selector
      }
    );
  }

  await button.click({
    timeout: 5_000
  });

  await waitForCondition(async () => {
    const editorCount = await page
      .locator("input[name='notificationFrequency']")
      .count();
    return editorCount === 0;
  }, 5_000);
  await waitForJobAlertsSurface(page);
}

async function updateJobAlertSettings(
  page: Page,
  desired: JobAlertEditSettings
): Promise<JobAlertEditSettings> {
  const current = await readJobAlertEditSettings(page);
  let changed = false;

  if (current.frequency !== desired.frequency) {
    await page
      .locator(
        desired.frequency === "weekly"
          ? "#alert-frequency-weekly"
          : "#alert-frequency-daily"
      )
      .check({
        timeout: 5_000
      });
    changed = true;
  }

  if (current.notificationType !== desired.notificationType) {
    const notificationSelector =
      desired.notificationType === "notification"
        ? "#alert-notification-preference-in-app"
        : desired.notificationType === "email"
          ? "#alert-notification-preference-email"
          : "#alert-notification-preference-both";
    await page.locator(notificationSelector).check({
      timeout: 5_000
    });
    changed = true;
  }

  if (current.includeSimilarJobs !== desired.includeSimilarJobs) {
    await page
      .locator(".artdeco-modal input[type='checkbox'].artdeco-toggle__button")
      .last()
      .setChecked(desired.includeSimilarJobs, {
        timeout: 5_000
      });
    changed = true;
  }

  await closeJobAlertEditModal(page, changed);
  return changed ? desired : current;
}

async function openEasyApplyModal(page: Page): Promise<void> {
  const locator = page.locator(".jobs-apply-button").filter({
    hasText: /Easy Apply/iu
  });

  if ((await locator.count()) === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "This job does not currently expose an Easy Apply flow.",
      {
        current_url: page.url()
      }
    );
  }

  await locator.first().click({
    timeout: 5_000
  });
  await waitForEasyApplyModal(page);
}

interface EasyApplyButtonSnapshot {
  text: string;
  aria: string;
  disabled: boolean;
}

async function extractCurrentEasyApplyStep(
  page: Page,
  stepIndex: number
): Promise<EasyApplyStepSnapshot & { buttons: EasyApplyButtonSnapshot[] }> {
  const step = await page.evaluate((currentStepIndex: number) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const dedupeRepeated = (value: string): string => {
      const normalized = normalize(value);
      if (!normalized) {
        return "";
      }

      const duplicateMatch = /^(.+?)\s*\1$/iu.exec(normalized);
      return normalize(duplicateMatch?.[1] ?? normalized);
    };

    const normalizeSelectValue = (selectElement: HTMLSelectElement): string => {
      const selectedOption =
        selectElement.selectedOptions[0] ??
        selectElement.options[selectElement.selectedIndex] ??
        null;
      const label = normalize(selectedOption?.textContent);
      if (label === "Select an option") {
        return "";
      }
      return label || normalize(selectElement.value);
    };

    const getLabelText = (element: Element): string => {
      const inputElement = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const id = normalize(inputElement.id);
      if (id) {
        const linkedLabel = document.querySelector(`label[for="${id}"]`);
        if (linkedLabel) {
          return dedupeRepeated(linkedLabel.textContent ?? "");
        }
      }

      const parentLabel = inputElement.closest("label");
      if (parentLabel) {
        return dedupeRepeated(parentLabel.textContent ?? "");
      }

      const fieldset = inputElement.closest("fieldset");
      const legend = fieldset?.querySelector("legend");
      if (legend) {
        return dedupeRepeated(legend.textContent ?? "");
      }

      return "";
    };

    const dialog =
      Array.from(document.querySelectorAll(".artdeco-modal, [role='dialog']")).at(-1) ??
      document.body;
    const headings = Array.from(
      dialog.querySelectorAll("h1, h2, h3, h4, legend")
    )
      .map((heading) => dedupeRepeated(heading.textContent ?? ""))
      .filter((heading) => heading.length > 0);
    const stepTitle =
      headings.find((heading) => !/^apply to\b/iu.test(heading)) ??
      `Step ${currentStepIndex + 1}`;

    const radioGroups = new Map<
      string,
      {
        fieldKey: string;
        id: string;
        name: string;
        label: string;
        inputType: string;
        required: boolean;
        currentValue: string | boolean | null;
        options: Array<{ value: string; label: string; id: string }>;
      }
    >();
    const fields: Array<{
      fieldKey: string;
      id: string;
      name: string;
      label: string;
      inputType: string;
      required: boolean;
      currentValue: string | boolean | null;
      options: Array<{ value: string; label: string; id: string }>;
    }> = [];

    const controls = Array.from(
      dialog.querySelectorAll("input, select, textarea")
    ).filter((control) => {
      const type = normalize(control.getAttribute("type")).toLowerCase();
      return type !== "hidden";
    });

    for (const control of controls) {
      const inputElement = control as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement;
      const type =
        control.tagName === "SELECT"
          ? "select"
          : control.tagName === "TEXTAREA"
            ? "textarea"
            : normalize((control as HTMLInputElement).type).toLowerCase() || "text";
      const id = normalize(inputElement.id);
      const name = normalize((inputElement as HTMLInputElement).name);
      const label = getLabelText(control);
      const fieldKey = (() => {
        const base = label || id || name || `${type}_${fields.length + radioGroups.size}`;
        return base
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "_")
          .replace(/^_+|_+$/gu, "");
      })();
      const required =
        inputElement.required ||
        inputElement.getAttribute("aria-required") === "true" ||
        /\brequired\b/iu.test(label);

      if (type === "radio") {
        const groupKey = name || fieldKey;
        const group = radioGroups.get(groupKey) ?? {
          fieldKey,
          id: "",
          name,
          label,
          inputType: "radio",
          required,
          currentValue: null,
          options: []
        };
        const optionLabel = label;
        const optionValue = normalize((inputElement as HTMLInputElement).value);
        if ((inputElement as HTMLInputElement).checked) {
          group.currentValue = optionLabel || optionValue;
        }
        group.options.push({
          value: optionValue,
          label: optionLabel,
          id
        });
        radioGroups.set(groupKey, group);
        continue;
      }

      const currentValue =
        type === "checkbox"
          ? Boolean((inputElement as HTMLInputElement).checked)
          : type === "select"
            ? normalizeSelectValue(inputElement as HTMLSelectElement)
            : normalize(inputElement.value);

      const options =
        type === "select"
          ? Array.from((inputElement as HTMLSelectElement).options).map((option) => ({
              value: normalize(option.value),
              label: normalize(option.textContent),
              id: ""
            }))
          : [];

      fields.push({
        fieldKey,
        id,
        name,
        label,
        inputType: type,
        required,
        currentValue,
        options
      });
    }

    for (const group of radioGroups.values()) {
      fields.push(group);
    }

    const buttons = Array.from(dialog.querySelectorAll("button")).map((button) => ({
      text: dedupeRepeated(button.textContent ?? ""),
      aria: dedupeRepeated(button.getAttribute("aria-label") ?? ""),
      disabled:
        button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true"
    }));

    return {
      stepIndex: currentStepIndex,
      stepTitle,
      fields,
      buttons,
      availableActions: buttons
        .map((button) => `${button.text} ${button.aria}`.trim())
        .filter((value) => value.length > 0)
    };
  }, stepIndex);

  return {
    stepIndex: step.stepIndex,
    stepTitle: step.stepTitle,
    fields: step.fields.map((field) => ({
      fieldKey: field.fieldKey || normalizeEasyApplyKey(field.label || field.id || field.name),
      id: field.id,
      name: field.name,
      label: dedupeRepeatedText(field.label),
      inputType: field.inputType,
      required: Boolean(field.required),
      currentValue:
        typeof field.currentValue === "string"
          ? normalizeText(field.currentValue)
          : typeof field.currentValue === "boolean"
            ? field.currentValue
            : null,
      options: field.options.map((option) => ({
        value: normalizeText(option.value),
        label: dedupeRepeatedText(option.label),
        id: normalizeText(option.id)
      }))
    })),
    availableActions: step.availableActions.map((value) => normalizeText(value)),
    buttons: step.buttons.map((button) => ({
      text: normalizeText(button.text),
      aria: normalizeText(button.aria),
      disabled: Boolean(button.disabled)
    }))
  };
}
/* eslint-enable no-undef */

function resolveEasyApplyPrimaryAction(
  buttons: EasyApplyButtonSnapshot[]
): "submit" | "review" | "next" | null {
  const enabledButtons = buttons.filter((button) => !button.disabled);

  if (
    enabledButtons.some((button) =>
      /submit application|submit/iu.test(`${button.text} ${button.aria}`)
    )
  ) {
    return "submit";
  }
  if (
    enabledButtons.some((button) =>
      /review your application|review/iu.test(`${button.text} ${button.aria}`)
    )
  ) {
    return "review";
  }
  if (
    enabledButtons.some((button) =>
      /continue to next step|next/iu.test(`${button.text} ${button.aria}`)
    )
  ) {
    return "next";
  }

  return null;
}

function matchEasyApplyOption(
  field: EasyApplyFieldSnapshot,
  desiredValue: string | boolean
): EasyApplyFieldOption | undefined {
  const normalizedDesired = normalizeComparisonText(
    typeof desiredValue === "boolean"
      ? desiredValue
        ? "yes"
        : "no"
      : desiredValue
  );

  return field.options.find((option) => {
    const normalizedLabel = normalizeComparisonText(option.label);
    const normalizedValue = normalizeComparisonText(option.value);
    return (
      normalizedLabel === normalizedDesired ||
      normalizedValue === normalizedDesired ||
      normalizedLabel.includes(normalizedDesired) ||
      normalizedDesired.includes(normalizedLabel)
    );
  });
}

function getEasyApplyFieldLocator(
  page: Page,
  field: EasyApplyFieldSnapshot
): Locator {
  const modal = page.locator(".artdeco-modal").last();
  if (field.id) {
    return modal.locator(`[id="${escapeCssAttributeValue(field.id)}"]`).first();
  }
  if (field.name) {
    return modal.locator(`[name="${escapeCssAttributeValue(field.name)}"]`).first();
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Could not resolve a DOM locator for Easy Apply field ${field.fieldKey}.`,
    {
      field_key: field.fieldKey,
      label: field.label
    }
  );
}

async function fillEasyApplyField(
  page: Page,
  field: EasyApplyFieldSnapshot,
  application: LinkedInEasyApplyApplicationDraft
): Promise<void> {
  const providedValue = lookupEasyApplyAnswer(field, application);
  if (providedValue === undefined) {
    return;
  }

  if (field.inputType === "radio") {
    const matchedOption = matchEasyApplyOption(field, providedValue);
    if (!matchedOption) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `No matching option was found for Easy Apply field ${field.label}.`,
        {
          field_key: field.fieldKey,
          provided_value: String(providedValue)
        }
      );
    }

    const modal = page.locator(".artdeco-modal").last();
    const radioLocator = matchedOption.id
      ? modal.locator(`[id="${escapeCssAttributeValue(matchedOption.id)}"]`).first()
      : modal
          .locator(
            `input[type="radio"][name="${escapeCssAttributeValue(field.name)}"][value="${escapeCssAttributeValue(matchedOption.value)}"]`
          )
          .first();
    await radioLocator.check({
      timeout: 5_000
    });
    return;
  }

  const locator = getEasyApplyFieldLocator(page, field);

  if (field.inputType === "file") {
    if (typeof providedValue !== "string") {
      return;
    }
    await locator.setInputFiles(providedValue);
    return;
  }

  if (field.inputType === "checkbox") {
    await locator.setChecked(Boolean(providedValue), {
      timeout: 5_000
    });
    return;
  }

  if (field.inputType === "select") {
    const desiredString = normalizeText(String(providedValue));
    const matchedOption = matchEasyApplyOption(field, desiredString);
    if (matchedOption?.label) {
      try {
        await locator.selectOption({
          label: matchedOption.label
        });
        return;
      } catch {
        // Fall through to value-based selection.
      }
    }
    if (matchedOption?.value) {
      await locator.selectOption({
        value: matchedOption.value
      });
      return;
    }

    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `No matching select option was found for Easy Apply field ${field.label}.`,
      {
        field_key: field.fieldKey,
        provided_value: desiredString
      }
    );
  }

  await locator.fill(String(providedValue), {
    timeout: 5_000
  });
}

async function advanceEasyApplyModal(
  page: Page,
  action: "review" | "next" | "submit"
): Promise<void> {
  const modal = page.locator(".artdeco-modal").last();
  const buttons = modal.locator("button");
  const buttonCount = await buttons.count();

  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    const combinedText = normalizeText(
      `${(await button.textContent()) ?? ""} ${(await button.getAttribute("aria-label")) ?? ""}`
    );
    const matches =
      action === "submit"
        ? /submit application|submit/iu.test(combinedText)
        : action === "review"
          ? /review your application|review/iu.test(combinedText)
          : /continue to next step|next/iu.test(combinedText);

    if (!matches) {
      continue;
    }

    await button.click({
      timeout: 5_000
    });
    return;
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate the Easy Apply ${action} button.`,
    {
      current_url: page.url(),
      action
    }
  );
}

async function inspectEasyApplyFlow(
  page: Page,
  application: LinkedInEasyApplyApplicationDraft,
  options: {
    submitOnFinalStep: boolean;
  }
): Promise<
  EasyApplyInspectionResult & {
    submitted: boolean;
  }
> {
  const steps: EasyApplyStepSnapshot[] = [];
  const fields: EasyApplyPreparedField[] = [];
  const blockingFields: EasyApplyPreparedField[] = [];
  let submitted = false;

  for (let stepIndex = 0; stepIndex < 8; stepIndex += 1) {
    await waitForEasyApplyModal(page);
    let step = await extractCurrentEasyApplyStep(page, stepIndex);

    for (const field of step.fields) {
      const providedValue = lookupEasyApplyAnswer(field, application);
      if (providedValue !== undefined) {
        await fillEasyApplyField(page, field, application);
      }
    }

    step = await extractCurrentEasyApplyStep(page, stepIndex);
    steps.push(step);

    for (const field of step.fields) {
      const preparedField = toPreparedEasyApplyField(field, step, application);
      fields.push(preparedField);
      if (preparedField.required && !preparedField.supplied) {
        blockingFields.push(preparedField);
      }
    }

    if (blockingFields.length > 0) {
      return {
        readyToConfirm: false,
        steps,
        fields,
        blockingFields,
        submitted
      };
    }

    const action = resolveEasyApplyPrimaryAction(step.buttons);
    if (!action) {
      return {
        readyToConfirm: true,
        steps,
        fields,
        blockingFields,
        submitted
      };
    }

    if (action === "submit") {
      if (options.submitOnFinalStep) {
        await advanceEasyApplyModal(page, "submit");
        submitted = true;
      }

      return {
        readyToConfirm: true,
        steps,
        fields,
        blockingFields,
        submitted
      };
    }

    await advanceEasyApplyModal(page, action);
    await page.waitForTimeout(1_250);
  }

  return {
    readyToConfirm: false,
    steps,
    fields,
    blockingFields:
      blockingFields.length > 0
        ? blockingFields
        : [
            {
              field_key: "unknown",
              label: "Easy Apply flow exceeded the supported step limit.",
              input_type: "unknown",
              required: true,
              step_index: steps.length,
              step_title: "Unknown",
              supplied: false
            }
          ],
    submitted
  };
}

export class SaveJobActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = resolveLinkedInJobId(
      getRequiredStringField(action.target, "job_id", action.id, "target")
    );
    const jobUrl = buildJobViewUrl(jobId);

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
            job_url: jobUrl
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl
          },
          mapError: (error) =>
            asLinkedInAssistantError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn save job action."
            ),
          execute: async () => {
            const rateLimitState = runtime.rateLimiter.consume(
              SAVE_JOB_RATE_LIMIT_CONFIG
            );
            if (!rateLimitState.allowed) {
              throw new LinkedInAssistantError(
                "RATE_LIMITED",
                "LinkedIn save job confirm is rate limited for the current window.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  rate_limit: formatRateLimitState(rateLimitState)
                }
              );
            }

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);

            const initialSaved = await readJobSavedState(
              page,
              runtime.selectorLocale
            );

            if (!initialSaved) {
              await (await resolveJobSaveButton(page)).click({
                timeout: 5_000
              });
            }

            let saved = initialSaved;
            if (!saved) {
              saved = await waitForCondition(async () => {
                try {
                  return await readJobSavedState(page, runtime.selectorLocale);
                } catch {
                  return false;
                }
              }, 6_000);
            }

            if (!saved) {
              await page.reload({ waitUntil: "domcontentloaded" });
              await waitForNetworkIdleBestEffort(page);
              await waitForJobDetailSurface(page);
              saved = await readJobSavedState(page, runtime.selectorLocale);
            }

            if (!saved) {
              throw new LinkedInAssistantError(
                "UNKNOWN",
                "Save job action could not be verified on the target job.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  job_url: jobUrl
                }
              );
            }

            const screenshotPath = `linkedin/screenshot-job-save-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: SAVE_JOB_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl
            });

            return {
              ok: true,
              result: {
                saved: true,
                already_saved: initialSaved,
                job_id: jobId,
                job_url: jobUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: [screenshotPath]
            };
          }
        });
      }
    );
  }
}

export class UnsaveJobActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = resolveLinkedInJobId(
      getRequiredStringField(action.target, "job_id", action.id, "target")
    );
    const jobUrl = buildJobViewUrl(jobId);

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
            job_url: jobUrl
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl
          },
          mapError: (error) =>
            asLinkedInAssistantError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn unsave job action."
            ),
          execute: async () => {
            const rateLimitState = runtime.rateLimiter.consume(
              UNSAVE_JOB_RATE_LIMIT_CONFIG
            );
            if (!rateLimitState.allowed) {
              throw new LinkedInAssistantError(
                "RATE_LIMITED",
                "LinkedIn unsave job confirm is rate limited for the current window.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  rate_limit: formatRateLimitState(rateLimitState)
                }
              );
            }

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);

            const initialSaved = await readJobSavedState(
              page,
              runtime.selectorLocale
            );

            if (initialSaved) {
              await (await resolveJobSaveButton(page)).click({
                timeout: 5_000
              });
            }

            let saved = initialSaved;
            if (initialSaved) {
              saved = await waitForCondition(async () => {
                try {
                  return await readJobSavedState(page, runtime.selectorLocale);
                } catch {
                  return true;
                }
              }, 6_000);
            }

            if (initialSaved && saved) {
              await page.reload({ waitUntil: "domcontentloaded" });
              await waitForNetworkIdleBestEffort(page);
              await waitForJobDetailSurface(page);
              saved = await readJobSavedState(page, runtime.selectorLocale);
            }

            if (saved) {
              throw new LinkedInAssistantError(
                "UNKNOWN",
                "Unsave job action could not be verified on the target job.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  job_url: jobUrl
                }
              );
            }

            const screenshotPath = `linkedin/screenshot-job-unsave-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: UNSAVE_JOB_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl
            });

            return {
              ok: true,
              result: {
                saved: false,
                already_unsaved: !initialSaved,
                job_id: jobId,
                job_url: jobUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: [screenshotPath]
            };
          }
        });
      }
    );
  }
}

export class CreateJobAlertActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const query = getRequiredStringField(action.target, "query", action.id, "target");
    const location = normalizeText(
      getRequiredStringField(action.target, "location", action.id, "target")
    );
    const searchUrl = getRequiredStringField(
      action.target,
      "search_url",
      action.id,
      "target"
    );
    const desiredSettings: JobAlertEditSettings = {
      frequency: normalizeLinkedInJobAlertFrequency(
        typeof action.payload.frequency === "string"
          ? action.payload.frequency
          : undefined
      ),
      notificationType: normalizeLinkedInJobAlertNotificationType(
        typeof action.payload.notification_type === "string"
          ? action.payload.notification_type
          : undefined
      ),
      includeSimilarJobs:
        typeof action.payload.include_similar_jobs === "boolean"
          ? action.payload.include_similar_jobs
          : false
    };

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
            search_url: searchUrl
          },
          errorDetails: {
            query,
            location,
            search_url: searchUrl
          },
          mapError: (error) =>
            asLinkedInAssistantError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn create job alert action."
            ),
          execute: async () => {
            const rateLimitState = runtime.rateLimiter.consume(
              CREATE_JOB_ALERT_RATE_LIMIT_CONFIG
            );
            if (!rateLimitState.allowed) {
              throw new LinkedInAssistantError(
                "RATE_LIMITED",
                "LinkedIn create job alert confirm is rate limited for the current window.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  query,
                  location,
                  rate_limit: formatRateLimitState(rateLimitState)
                }
              );
            }

            await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobSearchSurface(page);

            const alreadyEnabled = await readJobAlertToggleState(page);
            if (!alreadyEnabled) {
              await page
                .locator(".jobs-search-create-alert__artdeco-toggle")
                .first()
                .click({
                  timeout: 5_000
                });

              const enabled = await waitForCondition(async () => {
                try {
                  return await readJobAlertToggleState(page);
                } catch {
                  return false;
                }
              }, 5_000);

              if (!enabled) {
                throw new LinkedInAssistantError(
                  "UNKNOWN",
                  "Job alert creation could not be verified on the search page.",
                  {
                    query,
                    location,
                    search_url: searchUrl
                  }
                );
              }
            }

            await page.goto(JOB_ALERTS_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobAlertsSurface(page);

            const rows = await extractJobAlertRows(page);
            const matchedRow = findMatchingJobAlertRow(rows, query, location);
            if (!matchedRow) {
              throw new LinkedInAssistantError(
                "TARGET_NOT_FOUND",
                "The newly created LinkedIn job alert could not be found in alert management.",
                {
                  query,
                  location
                }
              );
            }

            await openJobAlertEditModal(page, matchedRow.rowIndex);
            const resolvedSettings = await updateJobAlertSettings(
              page,
              desiredSettings
            );

            const screenshotPath = `linkedin/screenshot-job-alert-create-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: CREATE_JOB_ALERT_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              query,
              location,
              search_url: matchedRow.searchUrl
            });

            return {
              ok: true,
              result: {
                created: !alreadyEnabled,
                alert: toLinkedInJobAlert(matchedRow, resolvedSettings),
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: [screenshotPath]
            };
          }
        });
      }
    );
  }
}

export class RemoveJobAlertActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const alertId = getRequiredStringField(
      action.target,
      "alert_id",
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

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
          profileName,
          targetUrl: JOB_ALERTS_URL,
          metadata: {
            alert_id: alertId
          },
          errorDetails: {
            alert_id: alertId
          },
          mapError: (error) =>
            asLinkedInAssistantError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn remove job alert action."
            ),
          execute: async () => {
            const rateLimitState = runtime.rateLimiter.consume(
              REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG
            );
            if (!rateLimitState.allowed) {
              throw new LinkedInAssistantError(
                "RATE_LIMITED",
                "LinkedIn remove job alert confirm is rate limited for the current window.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  alert_id: alertId,
                  rate_limit: formatRateLimitState(rateLimitState)
                }
              );
            }

            await page.goto(JOB_ALERTS_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobAlertsSurface(page);

            const rows = await extractJobAlertRows(page);
            const matchedRow = rows.find((row) => row.alertId === alertId);
            if (!matchedRow) {
              throw new LinkedInAssistantError(
                "TARGET_NOT_FOUND",
                "Could not find the requested LinkedIn job alert.",
                {
                  alert_id: alertId
                }
              );
            }

            const parsedSettings = parseJobAlertFrequencyText(
              matchedRow.frequencyText
            );
            await openJobAlertEditModal(page, matchedRow.rowIndex);

            const deleteButton = page
              .locator(".artdeco-modal button.artdeco-button--tertiary")
              .last();
            if ((await deleteButton.count()) === 0) {
              throw new LinkedInAssistantError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Could not locate the LinkedIn delete job alert button.",
                {
                  alert_id: alertId,
                  current_url: page.url()
                }
              );
            }

            await deleteButton.click({
              timeout: 5_000
            });

            const removed = await waitForCondition(async () => {
              await waitForJobAlertsSurface(page);
              const refreshedRows = await extractJobAlertRows(page);
              return !refreshedRows.some((row) => row.alertId === alertId);
            }, 7_500);

            if (!removed) {
              throw new LinkedInAssistantError(
                "UNKNOWN",
                "The LinkedIn job alert removal could not be verified.",
                {
                  alert_id: alertId
                }
              );
            }

            const screenshotPath = `linkedin/screenshot-job-alert-remove-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: REMOVE_JOB_ALERT_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              alert_id: alertId
            });

            return {
              ok: true,
              result: {
                removed: true,
                alert: toLinkedInJobAlert(matchedRow, {
                  frequency: parsedSettings.frequency,
                  notificationType: parsedSettings.notificationType,
                  includeSimilarJobs: false
                }),
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: [screenshotPath]
            };
          }
        });
      }
    );
  }
}

export class EasyApplyActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const jobId = resolveLinkedInJobId(
      getRequiredStringField(action.target, "job_id", action.id, "target")
    );
    const jobUrl = getRequiredStringField(
      action.target,
      "job_url",
      action.id,
      "target"
    );
    const application = normalizeEasyApplyApplicationDraft(
      (action.payload.application ?? undefined) as
        | LinkedInEasyApplyApplicationDraft
        | undefined
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

        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: EASY_APPLY_ACTION_TYPE,
          profileName,
          targetUrl: jobUrl,
          metadata: {
            job_id: jobId,
            job_url: jobUrl
          },
          errorDetails: {
            job_id: jobId,
            job_url: jobUrl
          },
          mapError: (error) =>
            asLinkedInAssistantError(
              error,
              "UNKNOWN",
              "Failed to execute LinkedIn Easy Apply action."
            ),
          execute: async () => {
            const rateLimitState = runtime.rateLimiter.consume(
              EASY_APPLY_RATE_LIMIT_CONFIG
            );
            if (!rateLimitState.allowed) {
              throw new LinkedInAssistantError(
                "RATE_LIMITED",
                "LinkedIn Easy Apply confirm is rate limited for the current window.",
                {
                  action_id: action.id,
                  profile_name: profileName,
                  job_id: jobId,
                  rate_limit: formatRateLimitState(rateLimitState)
                }
              );
            }

            await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);
            await openEasyApplyModal(page);

            const inspection = await inspectEasyApplyFlow(page, application, {
              submitOnFinalStep: true
            });

            if (!inspection.readyToConfirm || !inspection.submitted) {
              throw new LinkedInAssistantError(
                "ACTION_PRECONDITION_FAILED",
                "Easy Apply confirmation is missing required application inputs.",
                {
                  job_id: jobId,
                  blocking_fields: inspection.blockingFields.map((field) => field.label)
                }
              );
            }

            const submitted = await waitForCondition(async () => {
              const modalCount = await page.locator(".artdeco-modal").count();
              if (modalCount === 0) {
                return true;
              }

              const bodyText = normalizeText(await page.textContent("body"));
              return /application submitted|your application was sent/iu.test(
                bodyText
              );
            }, 10_000);

            if (!submitted) {
              throw new LinkedInAssistantError(
                "UNKNOWN",
                "LinkedIn Easy Apply submission could not be verified.",
                {
                  action_id: action.id,
                  job_id: jobId
                }
              );
            }

            const screenshotPath = `linkedin/screenshot-job-easy-apply-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: EASY_APPLY_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              job_id: jobId,
              job_url: jobUrl
            });

            return {
              ok: true,
              result: {
                submitted: true,
                job_id: jobId,
                job_url: jobUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: [screenshotPath]
            };
          }
        });
      }
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
    [EASY_APPLY_ACTION_TYPE]: new EasyApplyActionExecutor()
  };
}

export class LinkedInJobsService {
  constructor(private readonly runtime: LinkedInJobsRuntime) {}

  async searchJobs(input: SearchJobsInput): Promise<SearchJobsOutput> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const location = normalizeText(input.location);
    const limit = readJobsLimit(input.limit);

    if (!query) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const results = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildJobSearchUrl(query, location || undefined), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobSearchSurface(page);
          return loadJobSearchResults(page, limit);
        }
      );

      return {
        query,
        location,
        results,
        count: results.length
      };
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to search LinkedIn jobs."
      );
    }
  }

  async viewJob(input: ViewJobInput): Promise<LinkedInJobPosting> {
    const profileName = input.profileName ?? "default";
    const jobId = resolveLinkedInJobId(input.jobId);

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
          await page.goto(buildJobViewUrl(jobId), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobDetailSurface(page);
          return extractJobDetail(page, jobId);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn job posting."
      );
    }
  }

  listJobAlerts(input: ListJobAlertsInput = {}): Promise<ListJobAlertsOutput> {
    const profileName = input.profileName ?? "default";

    return this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        await this.runtime.auth.ensureAuthenticated({
          profileName,
          cdpUrl: this.runtime.cdpUrl
        });

        try {
          const page = await getOrCreatePage(context);
          await page.goto(JOB_ALERTS_URL, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobAlertsSurface(page);

          const rows = await extractJobAlertRows(page);
          const alerts: LinkedInJobAlert[] = [];

          for (const row of rows) {
            await openJobAlertEditModal(page, row.rowIndex);
            const settings = await readJobAlertEditSettings(page);
            alerts.push(toLinkedInJobAlert(row, settings));
            await closeJobAlertEditModal(page, false);
          }

          return {
            alerts,
            count: alerts.length
          };
        } catch (error) {
          if (error instanceof LinkedInAssistantError) {
            throw error;
          }
          throw asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to list LinkedIn job alerts."
          );
        }
      }
    );
  }

  prepareSaveJob(input: SaveJobInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const jobId = resolveLinkedInJobId(input.jobId);
    const jobUrl = buildJobViewUrl(jobId);
    const rateLimitState = this.runtime.rateLimiter.peek(SAVE_JOB_RATE_LIMIT_CONFIG);

    const target = {
      profile_name: profileName,
      job_id: jobId,
      job_url: jobUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: SAVE_JOB_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Save LinkedIn job ${jobId} for later`,
        target,
        outbound: {
          action: "save"
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareUnsaveJob(input: UnsaveJobInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const jobId = resolveLinkedInJobId(input.jobId);
    const jobUrl = buildJobViewUrl(jobId);
    const rateLimitState = this.runtime.rateLimiter.peek(
      UNSAVE_JOB_RATE_LIMIT_CONFIG
    );

    const target = {
      profile_name: profileName,
      job_id: jobId,
      job_url: jobUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UNSAVE_JOB_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Unsave LinkedIn job ${jobId}`,
        target,
        outbound: {
          action: "unsave"
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareCreateJobAlert(input: CreateJobAlertInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const location = normalizeText(input.location);

    if (!query) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      CREATE_JOB_ALERT_RATE_LIMIT_CONFIG
    );
    const frequency = normalizeLinkedInJobAlertFrequency(input.frequency);
    const notificationType = normalizeLinkedInJobAlertNotificationType(
      input.notificationType
    );
    const includeSimilarJobs = Boolean(input.includeSimilarJobs);
    const target = {
      profile_name: profileName,
      query,
      location,
      search_url: buildJobSearchUrl(query, location || undefined)
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: CREATE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {
        frequency,
        notification_type: notificationType,
        include_similar_jobs: includeSimilarJobs
      },
      preview: {
        summary: `Create a LinkedIn job alert for ${query}${location ? ` in ${location}` : ""}`,
        target,
        outbound: {
          action: "create_alert",
          frequency,
          notification_type: notificationType,
          include_similar_jobs: includeSimilarJobs
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareRemoveJobAlert(input: RemoveJobAlertInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const alertId = normalizeText(input.alertId);

    if (!alertId) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "alertId is required."
      );
    }

    const rateLimitState = this.runtime.rateLimiter.peek(
      REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      alert_id: alertId
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Remove LinkedIn job alert ${alertId}`,
        target,
        outbound: {
          action: "remove_alert"
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareEasyApply(input: PrepareEasyApplyInput): Promise<{
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  }> {
    const profileName = input.profileName ?? "default";
    const jobId = resolveLinkedInJobId(input.jobId);
    const jobUrl = buildJobViewUrl(jobId);
    const application = normalizeEasyApplyApplicationDraft(input.application);
    const rateLimitState = this.runtime.rateLimiter.peek(EASY_APPLY_RATE_LIMIT_CONFIG);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    const inspection = await this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        await page.goto(jobUrl, { waitUntil: "domcontentloaded" });
        await waitForNetworkIdleBestEffort(page);
        await waitForJobDetailSurface(page);
        await openEasyApplyModal(page);
        return inspectEasyApplyFlow(page, application, {
          submitOnFinalStep: false
        });
      }
    );

    const target = {
      profile_name: profileName,
      job_id: jobId,
      job_url: jobUrl
    };

    const preview = {
      summary: `Prepare LinkedIn Easy Apply for job ${jobId}`,
      target,
      outbound: {
        action: "easy_apply"
      },
      ready_to_confirm: inspection.readyToConfirm,
      steps: inspection.steps.map((step) => ({
        step_index: step.stepIndex,
        step_title: step.stepTitle,
        available_actions: step.availableActions
      })),
      fields: inspection.fields,
      blocking_fields: inspection.blockingFields,
      application_inputs_present: {
        email: Boolean(application.email),
        phone_country_code: Boolean(application.phoneCountryCode),
        phone_number: Boolean(application.phoneNumber),
        resume_path: Boolean(application.resumePath),
        cover_letter_path: Boolean(application.coverLetterPath),
        answer_count: Object.keys(application.answers ?? {}).length
      },
      rate_limit: formatRateLimitState(rateLimitState)
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: EASY_APPLY_ACTION_TYPE,
      target,
      payload: {
        application
      },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
