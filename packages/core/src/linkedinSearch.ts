import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import { getOrCreatePage, normalizeText } from "./shared.js";

export interface LinkedInSearchResult {
  name: string;
  headline: string;
  location: string;
  profile_url: string;
  vanity_name: string | null;
  connection_degree: string;
  mutual_connections: string;
}

export interface LinkedInCompanyResult {
  name: string;
  industry: string;
  follower_count: string;
  description: string;
  company_url: string;
  logo_url: string;
}

export interface LinkedInJobResult {
  title: string;
  company: string;
  location: string;
  posted_at: string;
  job_url: string;
  salary_range: string;
  employment_type: string;
}

export interface LinkedInPostSearchResult {
  author: string;
  author_headline: string;
  posted_at: string;
  text: string;
  post_url: string;
  reaction_count: string;
  comment_count: string;
}

export interface LinkedInGroupSearchResult {
  name: string;
  group_type: string;
  member_count: string;
  description: string;
  group_url: string;
}

export interface LinkedInEventSearchResult {
  title: string;
  date: string;
  location: string;
  organizer: string;
  description: string;
  attendee_count: string;
  event_url: string;
}

export const SEARCH_CATEGORIES = [
  "people",
  "companies",
  "jobs",
  "posts",
  "groups",
  "events",
] as const;

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export function isSearchCategory(value: string): value is SearchCategory {
  return (SEARCH_CATEGORIES as readonly string[]).includes(value);
}

export interface SearchInput {
  profileName?: string;
  query: string;
  category?: SearchCategory;
  limit?: number;
}

export interface SearchPeopleResult {
  query: string;
  category: "people";
  results: LinkedInSearchResult[];
  count: number;
}

export interface SearchCompaniesResult {
  query: string;
  category: "companies";
  results: LinkedInCompanyResult[];
  count: number;
}

export interface SearchJobsResult {
  query: string;
  category: "jobs";
  results: LinkedInJobResult[];
  count: number;
}

export interface SearchPostsResult {
  query: string;
  category: "posts";
  results: LinkedInPostSearchResult[];
  count: number;
}

export interface SearchGroupsResult {
  query: string;
  category: "groups";
  results: LinkedInGroupSearchResult[];
  count: number;
}

export interface SearchEventsResult {
  query: string;
  category: "events";
  results: LinkedInEventSearchResult[];
  count: number;
}

export type SearchResult =
  | SearchPeopleResult
  | SearchCompaniesResult
  | SearchJobsResult
  | SearchPostsResult
  | SearchGroupsResult
  | SearchEventsResult;

export interface LinkedInSearchRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
}

function readSearchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  return Math.max(1, Math.floor(value));
}

function extractVanityName(url: string): string | null {
  const match = /\/in\/([^/?#]+)/.exec(url);
  const vanityNameRaw = match?.[1];
  if (!vanityNameRaw) {
    return null;
  }

  try {
    return decodeURIComponent(vanityNameRaw);
  } catch {
    return vanityNameRaw;
  }
}

export function buildSearchUrl(
  query: string,
  category: SearchCategory = "people",
): string {
  const encodedQuery = encodeURIComponent(query);
  switch (category) {
    case "people":
      return `https://www.linkedin.com/search/results/people/?keywords=${encodedQuery}`;
    case "companies":
      return `https://www.linkedin.com/search/results/companies/?keywords=${encodedQuery}`;
    case "jobs":
      return `https://www.linkedin.com/search/results/jobs/?keywords=${encodedQuery}`;
    case "posts":
      return `https://www.linkedin.com/search/results/posts/?keywords=${encodedQuery}&skipRedirect=true`;
    case "groups":
      return `https://www.linkedin.com/search/results/groups/?keywords=${encodedQuery}`;
    case "events":
      return `https://www.linkedin.com/search/results/events/?keywords=${encodedQuery}`;
  }
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
export class LinkedInSearchService {
  constructor(private readonly runtime: LinkedInSearchRuntime) {}

  async search(input: SearchInput): Promise<SearchResult> {
    const category = input.category ?? "people";
    switch (category) {
      case "people":
        return this.searchPeople(input);
      case "companies":
        return this.searchCompanies(input);
      case "jobs":
        return this.searchJobs(input);
      case "posts":
        return this.searchPosts(input);
      case "groups":
        return this.searchGroups(input);
      case "events":
        return this.searchEvents(input);
    }
  }

  private async searchPeople(input: SearchInput): Promise<SearchPeopleResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "people"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page
              .locator(
                ".reusable-search__result-container, li.reusable-search__result-container",
              )
              .first()
              .waitFor({ state: "visible", timeout: 10_000 })
              .catch(() => undefined);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
              const pickText = (
                root: ParentNode,
                selectors: string[],
              ): string => {
                for (const selector of selectors) {
                  const text = normalize(
                    root.querySelector(selector)?.textContent,
                  );
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
              const pickHref = (
                root: ParentNode,
                selectors: string[],
              ): string => {
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

              const cards = Array.from(
                globalThis.document.querySelectorAll(
                  ".reusable-search__result-container, li.reusable-search__result-container",
                ),
              ).slice(0, lim);

              return cards.map((card) => ({
                name: pickText(card, [
                  ".entity-result__title-text a span[aria-hidden='true']",
                  ".app-aware-link span[dir='ltr']",
                ]),
                headline: pickText(card, [
                  ".entity-result__primary-subtitle",
                  ".entity-result__summary",
                ]),
                location: pickText(card, [
                  ".entity-result__secondary-subtitle",
                ]),
                profile_url: pickHref(card, ["a[href*='/in/']"]),
                connection_degree: pickText(card, [
                  ".entity-result__badge-text",
                  ".dist-value",
                ]),
                mutual_connections: pickText(card, [
                  ".entity-result__summary",
                  ".member-insights",
                ]),
              }));
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => {
          const profileUrl = normalizeText(snapshot.profile_url);
          return {
            name: normalizeText(snapshot.name),
            headline: normalizeText(snapshot.headline),
            location: normalizeText(snapshot.location),
            profile_url: profileUrl,
            vanity_name: extractVanityName(profileUrl),
            connection_degree: normalizeText(snapshot.connection_degree),
            mutual_connections: normalizeText(snapshot.mutual_connections),
          } satisfies LinkedInSearchResult;
        })
        .filter(
          (result) => result.name.length > 0 || result.profile_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "people",
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
        "Failed to search LinkedIn people.",
      );
    }
  }

  private async searchCompanies(
    input: SearchInput,
  ): Promise<SearchCompaniesResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "companies"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page
              .locator(
                ".reusable-search__result-container, li.reusable-search__result-container",
              )
              .first()
              .waitFor({ state: "visible", timeout: 10_000 })
              .catch(() => undefined);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
              const pickText = (
                root: ParentNode,
                selectors: string[],
              ): string => {
                for (const selector of selectors) {
                  const text = normalize(
                    root.querySelector(selector)?.textContent,
                  );
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

              const cards = Array.from(
                globalThis.document.querySelectorAll(
                  ".reusable-search__result-container, li.reusable-search__result-container",
                ),
              ).slice(0, lim);

              return cards.map((card) => {
                const companyLinkElement = card.querySelector(
                  "a[href*='/company/']",
                ) as HTMLAnchorElement | null;
                const logoElement = card.querySelector(
                  "img",
                ) as HTMLImageElement | null;
                return {
                  name: pickText(card, [
                    ".entity-result__title-text a span[aria-hidden='true']",
                  ]),
                  industry: pickText(card, [
                    ".entity-result__primary-subtitle",
                  ]),
                  follower_count: pickText(card, [
                    ".entity-result__secondary-subtitle",
                  ]),
                  description: pickText(card, [".entity-result__summary"]),
                  company_url: toAbsoluteHref(
                    normalize(companyLinkElement?.getAttribute("href")) ||
                      normalize(companyLinkElement?.href),
                  ),
                  logo_url: normalize(logoElement?.src),
                };
              });
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => ({
          name: normalizeText(snapshot.name),
          industry: normalizeText(snapshot.industry),
          follower_count: normalizeText(snapshot.follower_count),
          description: normalizeText(snapshot.description),
          company_url: normalizeText(snapshot.company_url),
          logo_url: normalizeText(snapshot.logo_url),
        }))
        .filter(
          (result) => result.name.length > 0 || result.company_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "companies",
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
        "Failed to search LinkedIn companies.",
      );
    }
  }

  private async searchJobs(input: SearchInput): Promise<SearchJobsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "jobs"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page
              .locator(".job-card-container, .base-search-card")
              .first()
              .waitFor({ state: "visible", timeout: 10_000 })
              .catch(() => undefined);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
              const pickText = (
                root: ParentNode,
                selectors: string[],
              ): string => {
                for (const selector of selectors) {
                  const text = normalize(
                    root.querySelector(selector)?.textContent,
                  );
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

              const pickEmploymentType = (root: ParentNode): string => {
                const signal = pickText(root, [
                  ".job-card-container__metadata-item",
                  ".job-card-container__job-insight",
                  ".base-search-card__metadata",
                ]);
                if (!signal) {
                  return "";
                }

                const match =
                  /(Full-time|Part-time|Contract|Temporary|Internship)/i.exec(
                    signal,
                  );
                return normalize(match?.[1] ?? signal);
              };

              const cards = Array.from(
                globalThis.document.querySelectorAll(
                  ".job-card-container, .base-search-card",
                ),
              ).slice(0, lim);

              return cards.map((card) => {
                const jobLinkElement = card.querySelector(
                  "a[href*='/jobs/view/']",
                ) as HTMLAnchorElement | null;
                return {
                  title: pickText(card, [
                    ".job-card-container__link",
                    ".base-search-card__title",
                  ]),
                  company: pickText(card, [
                    ".job-card-container__company-name",
                    ".base-search-card__subtitle",
                  ]),
                  location: pickText(card, [
                    ".job-card-container__metadata-wrapper",
                    ".job-search-card__location",
                  ]),
                  posted_at: pickText(card, [
                    "time",
                    ".job-card-container__footer",
                  ]),
                  job_url: toAbsoluteHref(
                    normalize(jobLinkElement?.getAttribute("href")) ||
                      normalize(jobLinkElement?.href),
                  ),
                  salary_range: pickText(card, [
                    ".job-card-container__salary-info",
                  ]),
                  employment_type: pickEmploymentType(card),
                };
              });
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => ({
          title: normalizeText(snapshot.title),
          company: normalizeText(snapshot.company),
          location: normalizeText(snapshot.location),
          posted_at: normalizeText(snapshot.posted_at),
          job_url: normalizeText(snapshot.job_url),
          salary_range: normalizeText(snapshot.salary_range),
          employment_type: normalizeText(snapshot.employment_type),
        }))
        .filter(
          (result) => result.title.length > 0 || result.job_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "jobs",
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

  private async searchPosts(input: SearchInput): Promise<SearchPostsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "posts"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page.waitForTimeout(2_000);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
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

              if (
                normalize(globalThis.document.body?.innerText).includes(
                  "We've filed a report for this error.",
                )
              ) {
                return [] as Array<Record<string, string>>;
              }

              const anchors = Array.from(
                globalThis.document.querySelectorAll(
                  "a[href*='/feed/update/'], a[href*='/posts/']",
                ),
              ) as HTMLAnchorElement[];
              const seen = new Set<string>();
              const results: Array<Record<string, string>> = [];

              for (const anchor of anchors) {
                const href = toAbsoluteHref(
                  normalize(anchor.getAttribute("href")) ||
                    normalize(anchor.href),
                );
                if (!href || seen.has(href)) {
                  continue;
                }
                seen.add(href);

                const container = anchor.closest("article, li, div") ?? anchor;
                const lines = (
                  (container as HTMLElement).innerText ??
                  container.textContent ??
                  ""
                )
                  .split(/\n+/)
                  .map((value) => normalize(value))
                  .filter((value) => value.length > 0);
                if (lines.length === 0) {
                  continue;
                }

                const postedAt =
                  lines.find((line) =>
                    /\b(?:h|d|w|mo|yr|hour|day|week|month|year)s?\b/i.test(
                      line,
                    ),
                  ) ?? "";
                const reactionCount =
                  lines.find((line) => /\breactions?\b/i.test(line)) ?? "";
                const commentCount =
                  lines.find((line) => /\bcomments?\b/i.test(line)) ?? "";
                const author =
                  container.querySelector(
                    "span[dir='ltr'], span[aria-hidden='true']",
                  )?.textContent ??
                  lines[0] ??
                  "";

                results.push({
                  author: normalize(author),
                  author_headline: "",
                  posted_at: postedAt,
                  text: lines.slice(0, 8).join(" "),
                  post_url: href,
                  reaction_count: reactionCount,
                  comment_count: commentCount,
                });

                if (results.length >= lim) {
                  break;
                }
              }

              return results;
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => ({
          author: normalizeText(snapshot.author),
          author_headline: normalizeText(snapshot.author_headline),
          posted_at: normalizeText(snapshot.posted_at),
          text: normalizeText(snapshot.text),
          post_url: normalizeText(snapshot.post_url),
          reaction_count: normalizeText(snapshot.reaction_count),
          comment_count: normalizeText(snapshot.comment_count),
        }))
        .filter(
          (result) => result.text.length > 0 || result.post_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "posts",
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
        "Failed to search LinkedIn posts.",
      );
    }
  }

  private async searchGroups(input: SearchInput): Promise<SearchGroupsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "groups"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page.waitForTimeout(2_000);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
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

              const anchors = Array.from(
                globalThis.document.querySelectorAll("a[href*='/groups/']"),
              ) as HTMLAnchorElement[];
              const seen = new Set<string>();
              const results: Array<Record<string, string>> = [];

              for (const anchor of anchors) {
                const href = toAbsoluteHref(
                  normalize(anchor.getAttribute("href")) ||
                    normalize(anchor.href),
                );
                if (!href || seen.has(href)) {
                  continue;
                }
                seen.add(href);

                const lines = (anchor.innerText ?? "")
                  .split(/\n+/)
                  .map((value) => normalize(value))
                  .filter((value) => value.length > 0);
                if (lines.length < 2) {
                  continue;
                }

                const filteredLines = lines.filter(
                  (line) => !/^(Join|Requested|View)$/i.test(line),
                );

                results.push({
                  name: filteredLines[0] ?? "",
                  group_type: filteredLines[1] ?? "",
                  member_count: filteredLines[2] ?? "",
                  description: filteredLines.slice(3).join(" "),
                  group_url: href,
                });

                if (results.length >= lim) {
                  break;
                }
              }

              return results;
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => ({
          name: normalizeText(snapshot.name),
          group_type: normalizeText(snapshot.group_type),
          member_count: normalizeText(snapshot.member_count),
          description: normalizeText(snapshot.description),
          group_url: normalizeText(snapshot.group_url),
        }))
        .filter(
          (result) => result.name.length > 0 || result.group_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "groups",
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
        "Failed to search LinkedIn groups.",
      );
    }
  }

  private async searchEvents(input: SearchInput): Promise<SearchEventsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
    });

    try {
      const snapshots =
        await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(buildSearchUrl(query, "events"), {
              waitUntil: "domcontentloaded",
            });
            await waitForNetworkIdleBestEffort(page);
            await page.waitForTimeout(2_000);

            return page.evaluate((lim: number) => {
              const normalize = (value: string | null | undefined): string =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const origin = globalThis.window.location.origin;
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

              const anchors = Array.from(
                globalThis.document.querySelectorAll("a[href*='/events/']"),
              ) as HTMLAnchorElement[];
              const seen = new Set<string>();
              const results: Array<Record<string, string>> = [];

              for (const anchor of anchors) {
                const href = toAbsoluteHref(
                  normalize(anchor.getAttribute("href")) ||
                    normalize(anchor.href),
                );
                if (!href || seen.has(href)) {
                  continue;
                }
                seen.add(href);

                const lines = (anchor.innerText ?? "")
                  .split(/\n+/)
                  .map((value) => normalize(value))
                  .filter((value) => value.length > 0);
                if (lines.length < 2) {
                  continue;
                }

                const venueLine = lines[2] ?? "";
                const organizerMatch = /^(.*)\s+.\s+By\s+(.*)$/.exec(venueLine);
                const descriptionLines = lines.slice(3);
                const attendeeIndex = descriptionLines.findIndex((line) =>
                  /\battendees?\b/i.test(line),
                );

                results.push({
                  title: lines[0] ?? "",
                  date: lines[1] ?? "",
                  location: normalize(organizerMatch?.[1] ?? venueLine),
                  organizer: normalize(organizerMatch?.[2] ?? ""),
                  description:
                    attendeeIndex >= 0
                      ? descriptionLines.slice(0, attendeeIndex).join(" ")
                      : descriptionLines.join(" "),
                  attendee_count:
                    attendeeIndex >= 0
                      ? (descriptionLines[attendeeIndex] ?? "")
                      : "",
                  event_url: href,
                });

                if (results.length >= lim) {
                  break;
                }
              }

              return results;
            }, limit);
          },
        );

      const results = snapshots
        .map((snapshot) => ({
          title: normalizeText(snapshot.title),
          date: normalizeText(snapshot.date),
          location: normalizeText(snapshot.location),
          organizer: normalizeText(snapshot.organizer),
          description: normalizeText(snapshot.description),
          attendee_count: normalizeText(snapshot.attendee_count),
          event_url: normalizeText(snapshot.event_url),
        }))
        .filter(
          (result) => result.title.length > 0 || result.event_url.length > 0,
        )
        .slice(0, limit);

      return {
        query,
        category: "events",
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
        "Failed to search LinkedIn events.",
      );
    }
  }
}
/* eslint-enable no-undef */
