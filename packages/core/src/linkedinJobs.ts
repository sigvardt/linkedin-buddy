import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";

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
  profileManager: ProfileManager;
  logger: JsonEventLogger;
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

  throw new LinkedInBuddyError(
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

  throw new LinkedInBuddyError(
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

export class LinkedInJobsService {
  constructor(private readonly runtime: LinkedInJobsRuntime) {}

  async searchJobs(input: SearchJobsInput): Promise<SearchJobsOutput> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const location = normalizeText(input.location);
    const limit = readJobsLimit(input.limit);

    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const results = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
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
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to search LinkedIn jobs."
      );
    }
  }

  async viewJob(input: ViewJobInput): Promise<LinkedInJobPosting> {
    const profileName = input.profileName ?? "default";
    const jobId = normalizeText(input.jobId);

    if (!jobId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "jobId is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      return await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
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
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn job posting."
      );
    }
  }
}
