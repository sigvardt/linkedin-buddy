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

interface JobTargetedActionInput {
  profileName?: string;
  jobId: string;
  operatorNote?: string;
}

export type SaveJobInput = JobTargetedActionInput;

export type UnsaveJobInput = JobTargetedActionInput;

export interface ListJobAlertsInput {
  profileName?: string;
  limit?: number;
}

export interface CreateJobAlertInput {
  profileName?: string;
  query: string;
  location?: string;
  operatorNote?: string;
}

export interface RemoveJobAlertInput {
  profileName?: string;
  searchUrl: string;
  operatorNote?: string;
}

export const LINKEDIN_JOB_ALERT_FREQUENCIES = [
  "daily",
  "weekly",
  "unknown"
] as const;

export type LinkedInJobAlertFrequency =
  (typeof LINKEDIN_JOB_ALERT_FREQUENCIES)[number];

export const LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES = [
  "email_and_notification",
  "email",
  "notification",
  "unknown"
] as const;

export type LinkedInJobAlertNotificationType =
  (typeof LINKEDIN_JOB_ALERT_NOTIFICATION_TYPES)[number];

export interface LinkedInJobAlert {
  alert_key: string;
  query: string;
  location: string;
  search_url: string;
  filters: string[];
  frequency: LinkedInJobAlertFrequency;
  notification_type: LinkedInJobAlertNotificationType;
}

export interface PrepareEasyApplyInput {
  profileName?: string;
  jobId: string;
}

export interface LinkedInEasyApplyField {
  field_key: string;
  label: string;
  input_type: string;
  required: boolean;
  has_value: boolean;
  option_count: number;
}

export interface LinkedInEasyApplyPreview {
  job_id: string;
  job_url: string;
  application_url: string;
  title: string;
  company: string;
  current_step: string;
  progress_percent: number | null;
  next_action_label: string;
  submit_available: boolean;
  field_count: number;
  required_field_count: number;
  fields: LinkedInEasyApplyField[];
  preview_only: true;
}

export interface SearchJobsOutput {
  query: string;
  location: string;
  results: LinkedInJobSearchResult[];
  count: number;
}

interface LinkedInJobsRuntimeBase {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
}

export interface LinkedInJobsExecutorRuntime extends LinkedInJobsRuntimeBase {
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

const SAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.save",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40
} as const;

const UNSAVE_JOB_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.unsave",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40
} as const;

const CREATE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.alerts.create",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} as const;

const REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.jobs.alerts.remove",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} as const;

const JOB_SAVE_BUTTON_SELECTORS = [
  ".jobs-save-button",
  ".jobs-details-top-card__job-save button",
  "button[aria-label*='Save the job' i]",
  "button[aria-label*='Unsave the job' i]"
] as const;

const JOB_ALERT_MANAGEMENT_URL = "https://www.linkedin.com/jobs/jam/";

const IGNORED_JOB_SEARCH_PARAMS = new Set([
  "currentJobId",
  "lipi",
  "origin",
  "pageNum",
  "position",
  "refId",
  "refresh",
  "sessionId",
  "start",
  "trackingId",
  "trk"
]);

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function readJobsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  return Math.max(1, Math.floor(value));
}

function readJobAlertsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 50;
  }
  return Math.max(1, Math.floor(value));
}

function formatRateLimitState(
  state: RateLimiterState
): Record<string, number | string | boolean> {
  return {
    allowed: state.allowed,
    counter_key: state.counterKey,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    window_size_ms: state.windowSizeMs,
    window_start_ms: state.windowStartMs
  };
}

function normalizeJobId(jobId: string): string {
  const normalizedJobId = normalizeText(jobId);
  if (!normalizedJobId) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "jobId is required."
    );
  }

  return normalizedJobId;
}

function getProfileName(target: Record<string, unknown>): string {
  const profileName = normalizeText(String(target.profile_name ?? "default"));
  return profileName || "default";
}

function getRequiredTargetString(
  target: Record<string, unknown>,
  field: string,
  actionId: string
): string {
  const value = normalizeText(String(target[field] ?? ""));
  if (!value) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} is missing target.${field}.`,
      {
        action_id: actionId,
        field
      }
    );
  }

  return value;
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

export function buildJobAlertsManagementUrl(): string {
  return JOB_ALERT_MANAGEMENT_URL;
}

export function buildJobEasyApplyUrl(jobId: string): string {
  return `${buildJobViewUrl(jobId)}apply/?openSDUIApplyFlow=true`;
}

export function normalizeLinkedInJobSearchUrl(url: string): string {
  const normalizedInput = normalizeText(url);
  if (!normalizedInput) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "searchUrl is required."
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedInput, "https://www.linkedin.com");
  } catch (error) {
    throw asLinkedInAssistantError(
      error,
      "ACTION_PRECONDITION_FAILED",
      "searchUrl must be a valid LinkedIn jobs search URL."
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isLinkedInHost =
    hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
  if (!isLinkedInHost || !parsedUrl.pathname.includes("/jobs/search")) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "searchUrl must point to a LinkedIn jobs search page.",
      {
        search_url: normalizedInput
      }
    );
  }

  const normalizedUrl = new URL("https://www.linkedin.com/jobs/search/");
  const keptParams = [...parsedUrl.searchParams.entries()]
    .filter(([key, value]) => {
      return !IGNORED_JOB_SEARCH_PARAMS.has(key) && normalizeText(value).length > 0;
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyComparison = leftKey.localeCompare(rightKey);
      return keyComparison !== 0
        ? keyComparison
        : leftValue.localeCompare(rightValue);
    });

  for (const [key, value] of keptParams) {
    normalizedUrl.searchParams.append(key, value);
  }

  return normalizeText(normalizedUrl.toString().replace(/\?$/, ""));
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 250
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

async function waitForJobAlertManagementSurface(page: Page): Promise<void> {
  await page.locator("main").first().waitFor({
    state: "visible",
    timeout: 10_000
  });
}

async function waitForEasyApplyModal(page: Page): Promise<void> {
  const selectors = [
    ".jobs-easy-apply-modal",
    "[data-test-modal][role='dialog']",
    "[data-live-test-easy-apply-next-button]",
    "[role='dialog']"
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 10_000
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Easy Apply is not available for this job.",
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

interface JobAlertSnapshot {
  alert_urn: string;
  filters_text: string;
  frequency_text: string;
  location: string;
  email_enabled: boolean;
  notification_enabled: boolean;
  query: string;
  search_url: string;
}

interface ExtractedJobAlert extends LinkedInJobAlert {
  alert_urn: string;
}

interface EasyApplyFieldSnapshot {
  field_key: string;
  label: string;
  input_type: string;
  required: boolean;
  has_value: boolean;
  option_count: number;
}

interface EasyApplyPreviewSnapshot {
  application_url: string;
  company: string;
  current_step: string;
  fields: EasyApplyFieldSnapshot[];
  next_action_label: string;
  progress_percent: number | null;
  submit_available: boolean;
  title: string;
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

    const isRemote = /\bremote\b/i.test(location) || /\bremote\b/i.test(allInsights);

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

  for (let i = 0; i < 6 && results.length < limit; i += 1) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    results = await extractJobSearchResults(page, limit);
  }

  return results.slice(0, Math.max(1, limit));
}

async function getLinkedInCsrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies("https://www.linkedin.com");
  const jsessionCookie = cookies.find((cookie) => {
    return (
      cookie.name === "JSESSIONID" &&
      cookie.domain.toLowerCase().includes("linkedin.com")
    );
  });
  const csrfToken = normalizeText(jsessionCookie?.value).replace(/^"+|"+$/g, "");

  if (!csrfToken) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Could not determine the LinkedIn CSRF token for job alerts."
    );
  }

  return csrfToken;
}

async function extractJobAlerts(
  page: Page,
  limit: number = 100
): Promise<ExtractedJobAlert[]> {
  const csrfToken = await getLinkedInCsrfToken(page);
  const response = await page.evaluate(
    async ({ count, token }) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const toRecord = (value: unknown): Record<string, unknown> | null => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return null;
        }
        return value as Record<string, unknown>;
      };
      const readString = (
        record: Record<string, unknown>,
        keys: readonly string[]
      ): string => {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "string") {
            const normalized = normalize(value);
            if (normalized) {
              return normalized;
            }
          }
        }
        return "";
      };
      const readBoolean = (
        record: Record<string, unknown>,
        key: string
      ): boolean => {
        return record[key] === true;
      };
      const toAbsoluteHref = (value: string): string => {
        if (!value) {
          return "";
        }
        if (/^https?:\/\//i.test(value)) {
          return value;
        }
        return value.startsWith("/")
          ? `${globalThis.window.location.origin}${value}`
          : `${globalThis.window.location.origin}/${value}`;
      };

      const apiResponse = await fetch(
        `/voyager/api/voyagerJobsDashJobAlerts?count=${encodeURIComponent(
          String(Math.max(1, count))
        )}&start=0`,
        {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "application/json",
            "csrf-token": token,
            "x-restli-protocol-version": "2.0.0"
          }
        }
      );
      const rawBody = await apiResponse.text();

      if (!apiResponse.ok) {
        return {
          ok: false,
          status: apiResponse.status,
          statusText: apiResponse.statusText,
          body: rawBody
        };
      }

      let payload: unknown = null;
      try {
        payload = rawBody ? (JSON.parse(rawBody) as unknown) : null;
      } catch {
        payload = null;
      }

      const payloadRecord = toRecord(payload);
      const elements = Array.isArray(payloadRecord?.elements)
        ? payloadRecord.elements
        : [];
      const snapshots: JobAlertSnapshot[] = [];

      for (const entry of elements) {
        const record = toRecord(entry);
        if (!record) {
          continue;
        }

        const alertUrn = readString(record, ["entityUrn", "entity_urn"]);
        const query = readString(record, ["title"]);
        const location = readString(record, ["subTitle", "subtitle"]);
        const searchUrl = toAbsoluteHref(
          readString(record, ["searchUrl", "search_url"])
        );

        if (!alertUrn || !query || !searchUrl) {
          continue;
        }

        snapshots.push({
          alert_urn: alertUrn,
          filters_text: readString(record, ["filtersText", "filters_text"]),
          frequency_text: readString(record, ["frequencyText", "frequency_text"]),
          location,
          email_enabled: readBoolean(record, "emailEnabled"),
          notification_enabled: readBoolean(record, "notificationEnabled"),
          query,
          search_url: searchUrl
        });
      }

      return {
        ok: true,
        snapshots
      };
    },
    {
      count: Math.max(1, limit),
      token: csrfToken
    }
  );

  if (!response.ok) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "LinkedIn job alerts API request failed.",
      {
        current_url: page.url(),
        status: response.status,
        status_text: response.statusText,
        response_body: normalizeText(response.body).slice(0, 500)
      }
    );
  }

  const snapshots = "snapshots" in response ? response.snapshots : [];

  return snapshots.map((snapshot) => ({
    alert_key: normalizeLinkedInJobSearchUrl(snapshot.search_url),
    query: normalizeText(snapshot.query),
    location: normalizeText(snapshot.location),
    search_url: normalizeLinkedInJobSearchUrl(snapshot.search_url),
    filters: parseJobAlertFilters(snapshot.filters_text),
    frequency: parseJobAlertFrequency(snapshot.frequency_text),
    notification_type: parseJobAlertNotificationType(snapshot.frequency_text, {
      emailEnabled: snapshot.email_enabled,
      notificationEnabled: snapshot.notification_enabled
    }),
    alert_urn: normalizeText(snapshot.alert_urn)
  }));
}

async function extractEasyApplyPreview(
  page: Page,
  jobId: string
): Promise<LinkedInEasyApplyPreview> {
  const snapshot = await page.evaluate((passedJobId: string) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const dedupeRepeatedLabel = (value: string): string => {
      const normalized = normalize(value);
      if (!normalized) {
        return "";
      }
      if (
        normalized.length % 2 === 0 &&
        normalized.slice(0, normalized.length / 2) ===
          normalized.slice(normalized.length / 2)
      ) {
        return normalized.slice(0, normalized.length / 2);
      }
      return normalized;
    };
    const parseProgressPercent = (value: string): number | null => {
      const normalized = normalize(value);
      if (!normalized) {
        return null;
      }
      const percentMatch = /(\d{1,3})\s*(?:%|percent)\b/i.exec(normalized);
      if (!percentMatch?.[1]) {
        return null;
      }
      const parsed = Number.parseInt(percentMatch[1], 10);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const dialog = (globalThis.document.querySelector(
      ".jobs-easy-apply-modal, [data-test-modal][role='dialog'], [role='dialog']"
    ) ?? null) as HTMLElement | null;

    if (!dialog) {
      throw new Error("Easy Apply modal not found.");
    }

    const headerText = normalize(
      dialog.querySelector("#jobs-apply-header")?.textContent
    );
    const company = headerText.replace(/^Apply to\s+/i, "");
    const stepTitle = normalize(dialog.querySelector("h3")?.textContent);
    const progressElement = dialog.querySelector(
      "progress"
    ) as HTMLProgressElement | null;
    const progressNow = progressElement?.getAttribute("aria-valuenow");
    const progressLabels = Array.from(
      dialog.querySelectorAll("[aria-label]")
    ).map((element) => normalize(element.getAttribute("aria-label")));
    const progressPercent = [
      typeof progressNow === "string" ? progressNow : "",
      normalize(progressElement?.textContent),
      ...progressLabels.filter((value) => /progress|percent/i.test(value)),
      normalize(dialog.textContent)
    ].reduce<number | null>((resolved, candidate) => {
      return resolved ?? parseProgressPercent(candidate);
    }, null);

    const fieldMap = new Map<string, EasyApplyFieldSnapshot>();
    const controls = Array.from(
      dialog.querySelectorAll("input, select, textarea")
    ) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;

    for (const control of controls) {
      const id = normalize(control.id);
      const name = normalize(control.getAttribute("name"));
      const escapedId =
        id && typeof globalThis.CSS?.escape === "function"
          ? globalThis.CSS.escape(id)
          : id.replace(/"/g, '\\"');
      const explicitLabel = id
        ? normalize(
            (
              dialog.querySelector(`label[for="${escapedId}"]`) as HTMLLabelElement | null
            )?.textContent
          )
        : "";
      const fieldContainer = control.closest(
        ".jobs-easy-apply-form-section__grouping, .fb-dash-form-element, .artdeco-text-input, .artdeco-select, fieldset, label"
      );
      const containerLabel = normalize(
        fieldContainer
          ?.querySelector(
            "label, legend, .fb-dash-form-element__label, .artdeco-text-input--label"
          )
          ?.textContent
      );
      const fallbackLabel =
        normalize(control.getAttribute("aria-label")) ||
        normalize(control.closest("label")?.textContent);
      const label = dedupeRepeatedLabel(
        explicitLabel || fallbackLabel || containerLabel || name || id
      );

      if (!label) {
        continue;
      }

      const rawType =
        control instanceof HTMLSelectElement
          ? "select"
          : control instanceof HTMLTextAreaElement
            ? "textarea"
            : normalize(control.type) || "text";
      if (rawType === "hidden") {
        continue;
      }
      const fieldKey = `${label.toLowerCase()}::${name || id || rawType}`;
      const required =
        control.hasAttribute("required") ||
        control.getAttribute("aria-required") === "true";

      let hasValue = false;
      let optionCount = 0;

      if (control instanceof HTMLSelectElement) {
        const selectedValue = normalize(control.value);
        hasValue =
          selectedValue.length > 0 &&
          selectedValue.toLowerCase() !== "select an option";
        optionCount = Array.from(control.options)
          .map((option) => normalize(option.value || option.textContent))
          .filter(
            (option) =>
              option.length > 0 && option.toLowerCase() !== "select an option"
          ).length;
      } else if (rawType === "checkbox" || rawType === "radio") {
        hasValue = control instanceof HTMLInputElement && control.checked;
      } else {
        hasValue = normalize(control.value).length > 0;
      }

      const existing = fieldMap.get(fieldKey);
      if (existing) {
        existing.required ||= required;
        existing.has_value ||= hasValue;
        existing.option_count = Math.max(existing.option_count, optionCount);
        continue;
      }

      fieldMap.set(fieldKey, {
        field_key: fieldKey,
        label,
        input_type: rawType,
        required,
        has_value: hasValue,
        option_count: optionCount
      });
    }

    const footerButtons = Array.from(
      dialog.querySelectorAll("button")
    ) as HTMLButtonElement[];
    const actionableButtons = footerButtons.filter((button) => {
      return !button.disabled && button.getAttribute("aria-disabled") !== "true";
    });
    const nextButton =
      actionableButtons.find((button) => {
        const text = normalize(button.textContent).toLowerCase();
        const aria = normalize(button.getAttribute("aria-label")).toLowerCase();
        return (
          text === "next" ||
          text === "continue" ||
          text.startsWith("review") ||
          aria.includes("next step") ||
          aria.includes("continue to next step") ||
          aria.startsWith("review")
        );
      }) ?? null;
    const submitButton =
      actionableButtons.find((button) => {
        const text = normalize(button.textContent).toLowerCase();
        const aria = normalize(button.getAttribute("aria-label")).toLowerCase();
        return text.includes("submit") || aria.includes("submit");
      }) ?? null;
    const primaryButton =
      nextButton ??
      submitButton ??
      actionableButtons[actionableButtons.length - 1] ??
      null;
    const pageTitle =
      normalize(
        globalThis.document.querySelector(
          ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, main h1"
        )?.textContent
      ) || normalize(globalThis.document.title.split("|")[0]);

    return {
      application_url: normalize(
        `${globalThis.window.location.origin}/jobs/view/${encodeURIComponent(passedJobId)}/apply/?openSDUIApplyFlow=true`
      ),
      company,
      current_step: stepTitle || "Application details",
      fields: [...fieldMap.values()],
      next_action_label: normalize(
        primaryButton?.textContent || primaryButton?.getAttribute("aria-label")
      ),
      progress_percent:
        typeof progressPercent === "number" && Number.isFinite(progressPercent)
          ? progressPercent
          : null,
      submit_available: Boolean(submitButton),
      title: pageTitle
    } satisfies EasyApplyPreviewSnapshot;
  }, jobId);

  const fields = snapshot.fields
    .map((field) => ({
      field_key: normalizeText(field.field_key),
      label: normalizeText(field.label),
      input_type: normalizeText(field.input_type) || "unknown",
      required: Boolean(field.required),
      has_value: Boolean(field.has_value),
      option_count:
        typeof field.option_count === "number" && Number.isFinite(field.option_count)
          ? Math.max(0, Math.floor(field.option_count))
          : 0
    }))
    .filter((field) => field.label.length > 0);

  const jobUrl = buildJobViewUrl(jobId);
  const requiredFieldCount = fields.filter((field) => field.required).length;

  return {
    job_id: jobId,
    job_url: jobUrl,
    application_url: buildJobEasyApplyUrl(jobId),
    title: normalizeText(snapshot.title),
    company: normalizeText(snapshot.company),
    current_step: normalizeText(snapshot.current_step),
    progress_percent:
      typeof snapshot.progress_percent === "number" &&
      Number.isFinite(snapshot.progress_percent)
        ? snapshot.progress_percent
        : null,
    next_action_label: normalizeText(snapshot.next_action_label),
    submit_available: Boolean(snapshot.submit_available),
    field_count: fields.length,
    required_field_count: requiredFieldCount,
    fields,
    preview_only: true
  };
}
/* eslint-enable no-undef */

function parseJobAlertFilters(filtersText: string): string[] {
  const normalizedFiltersText = normalizeText(filtersText).replace(/^Filters:\s*/i, "");
  return normalizedFiltersText
    .split("·")
    .map((item) => normalizeText(item))
    .filter((item) => item.length > 0);
}

function parseJobAlertFrequency(
  frequencyText: string
): LinkedInJobAlertFrequency {
  const normalizedFrequencyText = normalizeText(frequencyText).toLowerCase();
  if (normalizedFrequencyText.includes("weekly")) {
    return "weekly";
  }
  if (normalizedFrequencyText.includes("daily")) {
    return "daily";
  }
  return "unknown";
}

function parseJobAlertNotificationType(
  frequencyText: string,
  options: {
    emailEnabled?: boolean;
    notificationEnabled?: boolean;
  } = {}
): LinkedInJobAlertNotificationType {
  if (options.emailEnabled === true && options.notificationEnabled === true) {
    return "email_and_notification";
  }
  if (options.notificationEnabled === true) {
    return "notification";
  }
  if (options.emailEnabled === true) {
    return "email";
  }

  const normalizedFrequencyText = normalizeText(frequencyText).toLowerCase();
  if (normalizedFrequencyText.includes("email and notification")) {
    return "email_and_notification";
  }
  if (
    normalizedFrequencyText.includes("notification") &&
    !normalizedFrequencyText.includes("email")
  ) {
    return "notification";
  }
  if (normalizedFrequencyText.includes("email")) {
    return "email";
  }
  return "unknown";
}

function stripJobAlertEditMetadata(alert: ExtractedJobAlert): LinkedInJobAlert {
  return {
    alert_key: alert.alert_key,
    query: alert.query,
    location: alert.location,
    search_url: alert.search_url,
    filters: [...alert.filters],
    frequency: alert.frequency,
    notification_type: alert.notification_type
  };
}

async function findFirstVisibleLocator(
  page: Page,
  selectors: readonly string[]
): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return { locator, selector };
    }
  }

  return null;
}

async function readJobSavedState(page: Page): Promise<boolean | null> {
  const saveButton = await findFirstVisibleLocator(page, JOB_SAVE_BUTTON_SELECTORS);
  if (!saveButton) {
    return null;
  }

  const ariaLabel = normalizeText(
    await saveButton.locator.getAttribute("aria-label").catch(() => null)
  ).toLowerCase();
  const text = normalizeText(
    await saveButton.locator.textContent().catch(() => null)
  ).toLowerCase();

  if (ariaLabel.includes("unsave") || /^saved\b/.test(text)) {
    return true;
  }
  if (ariaLabel.includes("save") || /^save\b/.test(text)) {
    return false;
  }

  return null;
}

async function locateJobSaveButton(page: Page): Promise<{
  locator: Locator;
  selector: string;
}> {
  const found = await findFirstVisibleLocator(page, JOB_SAVE_BUTTON_SELECTORS);
  if (found) {
    return found;
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not find the LinkedIn job save control.",
    {
      current_url: page.url(),
      attempted_selectors: JOB_SAVE_BUTTON_SELECTORS
    }
  );
}

async function readJobAlertToggleState(page: Page): Promise<boolean | null> {
  const toggle = await findFirstVisibleLocator(page, [
    ".jobs-search-create-alert__artdeco-toggle input[role='switch']",
    ".jobs-search-create-alert__artdeco-toggle input[type='checkbox']"
  ]);
  if (!toggle) {
    return null;
  }

  return toggle.locator.isChecked().catch(() => null);
}

async function locateJobAlertToggle(page: Page): Promise<{
  locator: Locator;
  selector: string;
}> {
  const found = await findFirstVisibleLocator(page, [
    ".jobs-search-create-alert__artdeco-toggle input[role='switch']",
    ".jobs-search-create-alert__artdeco-toggle input[type='checkbox']"
  ]);
  if (found) {
    return found;
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not find the LinkedIn job alert toggle.",
    {
      current_url: page.url(),
      attempted_selectors: [
        ".jobs-search-create-alert__artdeco-toggle input[role='switch']",
        ".jobs-search-create-alert__artdeco-toggle input[type='checkbox']"
      ]
    }
  );
}

async function clickJobAlertToggle(toggle: Locator): Promise<void> {
  await toggle.scrollIntoViewIfNeeded().catch(() => undefined);
  await toggle.evaluate((element) => {
    const candidate = element as {
      click?: () => void;
      tagName?: string;
    };
    if (candidate.tagName !== "INPUT" || typeof candidate.click !== "function") {
      throw new Error("LinkedIn job alert toggle did not resolve to an input.");
    }
    candidate.click();
  });
}

async function deleteJobAlertByUrn(page: Page, alertUrn: string): Promise<void> {
  const csrfToken = await getLinkedInCsrfToken(page);
  const response = await page.evaluate(
    async ({ token, urn }) => {
      const apiResponse = await fetch(
        `/voyager/api/voyagerJobsDashJobAlerts/${urn}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: {
            accept: "application/json",
            "csrf-token": token,
            "x-restli-protocol-version": "2.0.0"
          }
        }
      );
      const body = await apiResponse.text();
      return {
        ok: apiResponse.ok,
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        body
      };
    },
    {
      token: csrfToken,
      urn: alertUrn
    }
  );

  if (!response.ok) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "LinkedIn job alert removal API request failed.",
      {
        current_url: page.url(),
        alert_urn: alertUrn,
        status: response.status,
        status_text: response.statusText,
        response_body: normalizeText(response.body).slice(0, 500)
      }
    );
  }
}

async function navigateToJobView(page: Page, jobId: string): Promise<void> {
  await page.goto(buildJobViewUrl(jobId), {
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page);
  await waitForJobDetailSurface(page);
}

async function executeJobSaveStateChange(
  runtime: LinkedInJobsExecutorRuntime,
  input: {
    actionId: string;
    actionType: string;
    desiredSaved: boolean;
    jobId: string;
    profileName: string;
    rateLimitConfig: {
      counterKey: string;
      windowSizeMs: number;
      limit: number;
    };
  }
): Promise<ActionExecutorResult> {
  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName: input.profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      const jobUrl = buildJobViewUrl(input.jobId);

      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId: input.actionId,
        actionType: input.actionType,
        profileName: input.profileName,
        targetUrl: jobUrl,
        metadata: {
          job_id: input.jobId,
          job_url: jobUrl
        },
        errorDetails: {
          job_id: input.jobId,
          job_url: jobUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            `Failed to execute LinkedIn ${
              input.desiredSaved ? "save" : "unsave"
            } job action.`
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(input.rateLimitConfig);
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              `LinkedIn ${
                input.desiredSaved ? "save" : "unsave"
              } job confirm is rate limited for the current window.`,
              {
                action_id: input.actionId,
                job_id: input.jobId,
                profile_name: input.profileName,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await navigateToJobView(page, input.jobId);

          const saveButton = await locateJobSaveButton(page);
          const initialSavedState = await readJobSavedState(page);

          if (initialSavedState !== input.desiredSaved) {
            await saveButton.locator.click({ timeout: 5_000 });
          }

          let verified = initialSavedState === input.desiredSaved;
          if (!verified) {
            verified = await waitForCondition(async () => {
              return (await readJobSavedState(page)) === input.desiredSaved;
            }, 6_000);
          }

          if (!verified) {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobDetailSurface(page);
            verified = (await readJobSavedState(page)) === input.desiredSaved;
          }

          if (!verified) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              `Job save state could not be verified for job ${input.jobId}.`,
              {
                action_id: input.actionId,
                job_id: input.jobId,
                profile_name: input.profileName,
                selector: saveButton.selector
              }
            );
          }

          const screenshotPath = `linkedin/screenshot-job-save-${input.desiredSaved ? "saved" : "unsaved"}-${Date.now()}.png`;
          await page.screenshot({
            path: runtime.artifacts.resolve(screenshotPath),
            fullPage: true
          });
          runtime.artifacts.registerArtifact(screenshotPath, "image/png", {
            action: input.actionType,
            action_id: input.actionId,
            job_id: input.jobId,
            job_url: jobUrl,
            profile_name: input.profileName
          });

          return {
            ok: true,
            result: {
              job_id: input.jobId,
              job_url: jobUrl,
              saved: input.desiredSaved,
              ...(input.desiredSaved
                ? { already_saved: initialSavedState === true }
                : { already_unsaved: initialSavedState === false }),
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: [screenshotPath]
          };
        }
      });
    }
  );
}

async function executeCreateJobAlert(
  runtime: LinkedInJobsExecutorRuntime,
  input: {
    actionId: string;
    profileName: string;
    query: string;
    location: string;
  }
): Promise<ActionExecutorResult> {
  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName: input.profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      const searchUrl = buildJobSearchUrl(
        input.query,
        input.location || undefined
      );

      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId: input.actionId,
        actionType: CREATE_JOB_ALERT_ACTION_TYPE,
        profileName: input.profileName,
        targetUrl: searchUrl,
        metadata: {
          query: input.query,
          location: input.location,
          search_url: searchUrl
        },
        errorDetails: {
          query: input.query,
          location: input.location,
          search_url: searchUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn job alert creation."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            CREATE_JOB_ALERT_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn job alert creation is rate limited for the current window.",
              {
                action_id: input.actionId,
                profile_name: input.profileName,
                query: input.query,
                location: input.location,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobSearchSurface(page);

          const toggle = await locateJobAlertToggle(page);
          const initialAlertState = await readJobAlertToggleState(page);

          if (initialAlertState !== true) {
            await clickJobAlertToggle(toggle.locator);
          }

          let verified = initialAlertState === true;
          if (!verified) {
            verified = await waitForCondition(async () => {
              return (await readJobAlertToggleState(page)) === true;
            }, 6_000);
          }

          if (!verified) {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobSearchSurface(page);
            verified = (await readJobAlertToggleState(page)) === true;
          }

          if (!verified) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "Job alert creation could not be verified on the search page.",
              {
                action_id: input.actionId,
                profile_name: input.profileName,
                query: input.query,
                location: input.location,
                selector: toggle.selector
              }
            );
          }

          let resolvedSearchUrl = normalizeLinkedInJobSearchUrl(searchUrl);
          const alerts = await extractJobAlerts(page, 100);
          const matchingAlert = alerts.find((alert) => {
            const sameQuery =
              alert.query.toLowerCase() === input.query.toLowerCase();
            if (!sameQuery) {
              return false;
            }

            if (!input.location) {
              return true;
            }

            return alert.location.toLowerCase().includes(input.location.toLowerCase());
          });
          if (matchingAlert) {
            resolvedSearchUrl = matchingAlert.search_url;
          }

          const screenshotPath = `linkedin/screenshot-job-alert-created-${Date.now()}.png`;
          await page.screenshot({
            path: runtime.artifacts.resolve(screenshotPath),
            fullPage: true
          });
          runtime.artifacts.registerArtifact(screenshotPath, "image/png", {
            action: CREATE_JOB_ALERT_ACTION_TYPE,
            action_id: input.actionId,
            profile_name: input.profileName,
            query: input.query,
            location: input.location,
            search_url: resolvedSearchUrl
          });

          return {
            ok: true,
            result: {
              alert_created: true,
              already_created: initialAlertState === true,
              query: input.query,
              location: input.location,
              search_url: resolvedSearchUrl,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: [screenshotPath]
          };
        }
      });
    }
  );
}

async function executeRemoveJobAlert(
  runtime: LinkedInJobsExecutorRuntime,
  input: {
    actionId: string;
    profileName: string;
    searchUrl: string;
  }
): Promise<ActionExecutorResult> {
  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName: input.profileName,
      headless: true
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      const normalizedSearchUrl = normalizeLinkedInJobSearchUrl(input.searchUrl);

      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId: input.actionId,
        actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
        profileName: input.profileName,
        targetUrl: buildJobAlertsManagementUrl(),
        metadata: {
          search_url: normalizedSearchUrl
        },
        errorDetails: {
          search_url: normalizedSearchUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn job alert removal."
          ),
        execute: async () => {
          const rateLimitState = runtime.rateLimiter.consume(
            REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn job alert removal is rate limited for the current window.",
              {
                action_id: input.actionId,
                profile_name: input.profileName,
                search_url: normalizedSearchUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          await page.goto(buildJobAlertsManagementUrl(), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobAlertManagementSurface(page);

          const alerts = await extractJobAlerts(page, 100);
          const matchingAlert = alerts.find(
            (alert) => alert.search_url === normalizedSearchUrl
          );

          if (!matchingAlert) {
            return {
              ok: true,
              result: {
                removed: false,
                already_removed: true,
                search_url: normalizedSearchUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: []
            };
          }

          await deleteJobAlertByUrn(page, matchingAlert.alert_urn);

          let verified = await waitForCondition(async () => {
            const remainingAlerts = await extractJobAlerts(page, 100);
            return !remainingAlerts.some(
              (alert) => alert.search_url === normalizedSearchUrl
            );
          }, 10_000);

          if (!verified) {
            await page.reload({ waitUntil: "domcontentloaded" });
            await waitForNetworkIdleBestEffort(page);
            await waitForJobAlertManagementSurface(page);
            verified = !(await extractJobAlerts(page, 100)).some(
              (alert) => alert.search_url === normalizedSearchUrl
            );
          }

          if (!verified) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "Job alert removal could not be verified on the management page.",
              {
                action_id: input.actionId,
                search_url: normalizedSearchUrl
              }
            );
          }

          const screenshotPath = `linkedin/screenshot-job-alert-removed-${Date.now()}.png`;
          await page.screenshot({
            path: runtime.artifacts.resolve(screenshotPath),
            fullPage: true
          });
          runtime.artifacts.registerArtifact(screenshotPath, "image/png", {
            action: REMOVE_JOB_ALERT_ACTION_TYPE,
            action_id: input.actionId,
            profile_name: input.profileName,
            search_url: normalizedSearchUrl
          });

          return {
            ok: true,
            result: {
              removed: true,
              already_removed: false,
              search_url: normalizedSearchUrl,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: [screenshotPath]
          };
        }
      });
    }
  );
}

export class SaveJobActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const profileName = getProfileName(input.action.target);
    const jobId = getRequiredTargetString(input.action.target, "job_id", input.action.id);

    await input.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: input.runtime.cdpUrl
    });

    return executeJobSaveStateChange(input.runtime, {
      actionId: input.action.id,
      actionType: SAVE_JOB_ACTION_TYPE,
      desiredSaved: true,
      jobId,
      profileName,
      rateLimitConfig: SAVE_JOB_RATE_LIMIT_CONFIG
    });
  }
}

export class UnsaveJobActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const profileName = getProfileName(input.action.target);
    const jobId = getRequiredTargetString(input.action.target, "job_id", input.action.id);

    await input.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: input.runtime.cdpUrl
    });

    return executeJobSaveStateChange(input.runtime, {
      actionId: input.action.id,
      actionType: UNSAVE_JOB_ACTION_TYPE,
      desiredSaved: false,
      jobId,
      profileName,
      rateLimitConfig: UNSAVE_JOB_RATE_LIMIT_CONFIG
    });
  }
}

export class CreateJobAlertActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const profileName = getProfileName(input.action.target);
    const query = getRequiredTargetString(input.action.target, "query", input.action.id);
    const location = normalizeText(String(input.action.target.location ?? ""));

    await input.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: input.runtime.cdpUrl
    });

    return executeCreateJobAlert(input.runtime, {
      actionId: input.action.id,
      profileName,
      query,
      location
    });
  }
}

export class RemoveJobAlertActionExecutor
  implements ActionExecutor<LinkedInJobsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInJobsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const profileName = getProfileName(input.action.target);
    const searchUrl = getRequiredTargetString(
      input.action.target,
      "search_url",
      input.action.id
    );

    await input.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: input.runtime.cdpUrl
    });

    return executeRemoveJobAlert(input.runtime, {
      actionId: input.action.id,
      profileName,
      searchUrl
    });
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
    [REMOVE_JOB_ALERT_ACTION_TYPE]: new RemoveJobAlertActionExecutor()
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
    const jobId = normalizeJobId(input.jobId);

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

  prepareSaveJob(input: SaveJobInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const jobId = normalizeJobId(input.jobId);
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
          action: "save_job"
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
    const jobId = normalizeJobId(input.jobId);
    const jobUrl = buildJobViewUrl(jobId);
    const rateLimitState = this.runtime.rateLimiter.peek(UNSAVE_JOB_RATE_LIMIT_CONFIG);

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
        summary: `Remove LinkedIn job ${jobId} from your saved jobs`,
        target,
        outbound: {
          action: "unsave_job"
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async listJobAlerts(
    input: ListJobAlertsInput = {}
  ): Promise<LinkedInJobAlert[]> {
    const profileName = input.profileName ?? "default";
    const limit = readJobAlertsLimit(input.limit);

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
          await page.goto(buildJobAlertsManagementUrl(), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForJobAlertManagementSurface(page);
          const alerts = await extractJobAlerts(page, limit);
          return alerts.slice(0, limit).map(stripJobAlertEditMetadata);
        }
      );
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

    const searchUrl = buildJobSearchUrl(query, location || undefined);
    const rateLimitState = this.runtime.rateLimiter.peek(
      CREATE_JOB_ALERT_RATE_LIMIT_CONFIG
    );
    const target = {
      profile_name: profileName,
      query,
      location,
      search_url: searchUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: CREATE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: location
          ? `Create LinkedIn job alert for ${query} in ${location}`
          : `Create LinkedIn job alert for ${query}`,
        target,
        outbound: {
          action: "create_job_alert"
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
    const searchUrl = normalizeLinkedInJobSearchUrl(input.searchUrl);
    const rateLimitState = this.runtime.rateLimiter.peek(
      REMOVE_JOB_ALERT_RATE_LIMIT_CONFIG
    );

    const target = {
      profile_name: profileName,
      search_url: searchUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: REMOVE_JOB_ALERT_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Remove LinkedIn job alert ${searchUrl}`,
        target,
        outbound: {
          action: "remove_job_alert"
        },
        rate_limit: formatRateLimitState(rateLimitState)
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareEasyApply(
    input: PrepareEasyApplyInput
  ): Promise<LinkedInEasyApplyPreview> {
    const profileName = input.profileName ?? "default";
    const jobId = normalizeJobId(input.jobId);

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
          await page.goto(buildJobEasyApplyUrl(jobId), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForEasyApplyModal(page);
          return extractEasyApplyPreview(page, jobId);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to prepare LinkedIn Easy Apply preview."
      );
    }
  }
}
