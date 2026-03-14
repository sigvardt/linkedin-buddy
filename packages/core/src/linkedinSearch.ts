import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import { normalizeText, dedupeRepeatedText, cleanPostedAt, getOrCreatePage } from "./shared.js";

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
  "events"
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
  category: SearchCategory = "people"
): string {
  const encodedQuery = encodeURIComponent(query);
  switch (category) {
    case "people":
      return `https://www.linkedin.com/search/results/people/?keywords=${encodedQuery}`;
    case "companies":
      return `https://www.linkedin.com/search/results/companies/?keywords=${encodedQuery}`;
    case "jobs":
      return `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}`;
    case "posts":
      return `https://www.linkedin.com/search/results/content/?keywords=${encodedQuery}`;
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
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "people"), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await page
            .locator(
              "main a[href*='/in/'], div[data-view-name='search-entity-result-universal-template'], .reusable-search__result-container"
            )
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);

          return page.evaluate((lim: number) => {
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

            /**
             * Picks the Nth non-empty sibling text after an anchor element.
             * LinkedIn places headline (index 0) and location (index 1) as
             * sibling divs right after the name section (.t-roman.t-sans).
             */
            const pickSiblingText = (
              root: ParentNode,
              anchorSelector: string,
              index: number
            ): string => {
              const anchor = root.querySelector(anchorSelector);
              if (!anchor) {
                return "";
              }
              let el = anchor.nextElementSibling;
              let found = 0;
              while (el) {
                const text = normalize(el.textContent);
                if (text) {
                  if (found === index) {
                    return text;
                  }
                  found++;
                }
                el = el.nextElementSibling;
              }
              return "";
            };

            const extractModernCards = (): Array<Record<string, string>> => {
              const links = Array.from(
                globalThis.document.querySelectorAll("main a[href*='/in/']")
              ).filter((link): link is HTMLAnchorElement => {
                const href = normalize(link.getAttribute("href"));
                return /\/in\/[A-Za-z0-9-]+/.test(href);
              });

              const seen = new Set<string>();
              const uniqueLinks = links.filter((link) => {
                const href = normalize(link.getAttribute("href")) || normalize(link.href);
                const vanityMatch = /\/in\/([^/?#]+)/.exec(href);
                const vanityKey = normalize(vanityMatch?.[1]);
                if (!vanityKey || seen.has(vanityKey)) {
                  return false;
                }
                seen.add(vanityKey);
                return true;
              });

              return uniqueLinks.slice(0, lim).map((link) => {
                const card = link.closest("li") ?? link.closest("div");
                if (!card) {
                  return {
                    name: "",
                    headline: "",
                    location: "",
                    profile_url: "",
                    connection_degree: "",
                    mutual_connections: ""
                  };
                }

                const paragraphs = Array.from(card.querySelectorAll("p"));
                const rawName = normalize(
                  (paragraphs[0]?.innerText ?? "").split("\n")[0]
                );
                const allText = normalize((card as HTMLElement).innerText);
                const degreeMatch = /(\d(?:st|nd|rd))/i.exec(allText);
                const mutualMatch = /(\d+\s*mutual\s*connection(?:s)?)/i.exec(allText);

                return {
                  name: rawName,
                  headline: normalize(paragraphs[1]?.innerText),
                  location: normalize(paragraphs[2]?.innerText),
                  profile_url: toAbsoluteHref(
                    normalize(link.getAttribute("href")) || normalize(link.href)
                  ),
                  connection_degree: normalize(degreeMatch?.[1]),
                  mutual_connections: normalize(mutualMatch?.[1])
                };
              });
            };

            const modernCards = extractModernCards();
            if (modernCards.some((card) => card.name || card.profile_url)) {
              return modernCards;
            }

            const legacyCards = Array.from(
              globalThis.document.querySelectorAll(
                "div[data-view-name='search-entity-result-universal-template'], .reusable-search__result-container, li.reusable-search__result-container"
              )
            ).slice(0, lim);

            return legacyCards.map((card) => ({
              name: pickText(card, [
                "a[href*='/in/'] span[dir='ltr'] > span[aria-hidden='true']",
                ".entity-result__title-text a span[aria-hidden='true']",
                ".app-aware-link span[dir='ltr']"
              ]),
              headline:
                pickSiblingText(card, ".t-roman.t-sans", 0) ||
                pickText(card, [
                  ".entity-result__primary-subtitle",
                  ".entity-result__summary"
                ]),
              location:
                pickSiblingText(card, ".t-roman.t-sans", 1) ||
                pickText(card, [".entity-result__secondary-subtitle"]),
              profile_url: pickHref(card, ["a[href*='/in/']"]),
              connection_degree: pickText(card, [
                ".entity-result__badge-text span[aria-hidden='true']",
                ".entity-result__badge-text",
                ".dist-value"
              ]),
              mutual_connections: pickText(card, [
                ".reusable-search-simple-insight__text-container",
                ".entity-result__summary",
                ".member-insights"
              ])
            }));
          }, limit);
        }
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
            connection_degree: normalizeText(
              snapshot.connection_degree.replace(/^[•·]\s*/, "")
            ),
            mutual_connections: normalizeText(snapshot.mutual_connections)
          } satisfies LinkedInSearchResult;
        })
        .filter((result) => result.name.length > 0 || result.profile_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "people",
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
        "Failed to search LinkedIn people."
      );
    }
  }

  private async searchCompanies(
    input: SearchInput
  ): Promise<SearchCompaniesResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
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
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "companies"), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await page
            .locator(
              "main a[href*='/company/'], div[data-view-name='search-entity-result-universal-template'], .reusable-search__result-container"
            )
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);

          return page.evaluate((lim: number) => {
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

            const pickSiblingText = (
              root: ParentNode,
              anchorSelector: string,
              index: number
            ): string => {
              const anchor = root.querySelector(anchorSelector);
              if (!anchor) {
                return "";
              }
              let el = anchor.nextElementSibling;
              let found = 0;
              while (el) {
                const text = normalize(el.textContent);
                if (text) {
                  if (found === index) {
                    return text;
                  }
                  found++;
                }
                el = el.nextElementSibling;
              }
              return "";
            };

            const extractModernCards = (): Array<Record<string, string>> => {
              const links = Array.from(
                globalThis.document.querySelectorAll("main a[href*='/company/']")
              ).filter((link): link is HTMLAnchorElement => {
                const href = normalize(link.getAttribute("href"));
                return /\/company\/[A-Za-z0-9-]+/.test(href);
              });

              const seen = new Set<string>();
              const uniqueLinks = links.filter((link) => {
                const href = normalize(link.getAttribute("href")) || normalize(link.href);
                const slugMatch = /\/company\/([^/?#]+)/.exec(href);
                const slug = normalize(slugMatch?.[1]);
                if (!slug || seen.has(slug)) {
                  return false;
                }
                seen.add(slug);
                return true;
              });

              return uniqueLinks.slice(0, lim).map((link) => {
                const card = link.closest("li") ?? link.closest("div");
                if (!card) {
                  return {
                    name: "",
                    industry: "",
                    follower_count: "",
                    description: "",
                    company_url: "",
                    logo_url: ""
                  };
                }

                const paragraphs = Array.from(card.querySelectorAll("p"));
                const summaryParagraph = paragraphs.find((paragraph) =>
                  /follower|employee|industry/i.test(
                    normalize((paragraph as HTMLElement).innerText)
                  )
                );

                return {
                  name: normalize((paragraphs[0]?.innerText ?? "").split("\n")[0]),
                  industry: normalize(paragraphs[1]?.innerText),
                  follower_count:
                    normalize(paragraphs[2]?.innerText) ||
                    normalize((summaryParagraph as HTMLElement | undefined)?.innerText),
                  description: normalize(paragraphs[3]?.innerText),
                  company_url: toAbsoluteHref(
                    normalize(link.getAttribute("href")) || normalize(link.href)
                  ),
                  logo_url: normalize((card.querySelector("img") as HTMLImageElement | null)?.src)
                };
              });
            };

            const modernCards = extractModernCards();
            if (modernCards.some((card) => card.name || card.company_url)) {
              return modernCards;
            }

            const legacyCards = Array.from(
              globalThis.document.querySelectorAll(
                "div[data-view-name='search-entity-result-universal-template'], .reusable-search__result-container, li.reusable-search__result-container"
              )
            ).slice(0, lim);

            return legacyCards.map((card) => {
              const companyLinkElement = card.querySelector(
                "a[href*='/company/']"
              ) as HTMLAnchorElement | null;
              const logoElement = card.querySelector("img") as HTMLImageElement | null;

              const nameLink = card.querySelector(
                ".t-roman.t-sans a[data-test-app-aware-link]"
              );
              const name = nameLink
                ? normalize(nameLink.textContent)
                : pickText(card, [
                    ".entity-result__title-text a span[aria-hidden='true']"
                  ]);

              const subtitleRaw =
                pickSiblingText(card, ".t-roman.t-sans", 0) ||
                pickText(card, [".entity-result__primary-subtitle"]);
              const subtitleParts = subtitleRaw.split("•").map((s) => s.trim());

              return {
                name,
                industry: subtitleParts[0] ?? "",
                follower_count:
                  pickSiblingText(card, ".t-roman.t-sans", 1) ||
                  pickText(card, [".entity-result__secondary-subtitle"]),
                description: pickText(card, [
                  "p[class*='entity-result__summary']",
                  ".entity-result__summary"
                ]),
                company_url: toAbsoluteHref(
                  normalize(companyLinkElement?.getAttribute("href")) ||
                    normalize(companyLinkElement?.href)
                ),
                logo_url: normalize(logoElement?.src)
              };
            });
          }, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          name: normalizeText(snapshot.name),
          industry: normalizeText(snapshot.industry),
          follower_count: normalizeText(snapshot.follower_count),
          description: normalizeText(snapshot.description),
          company_url: normalizeText(snapshot.company_url),
          logo_url: normalizeText(snapshot.logo_url)
        }))
        .filter((result) => result.name.length > 0 || result.company_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "companies",
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
        "Failed to search LinkedIn companies."
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
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "jobs"), {
            waitUntil: "domcontentloaded"
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

            const pickEmploymentType = (root: ParentNode): string => {
              const insightText = normalize(
                (root.querySelector(".job-card-list__insight") as HTMLElement | null)
                  ?.innerText
              );
              const signal =
                insightText ||
                pickText(root, [
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
                ".job-card-container, .base-search-card"
              )
            ).slice(0, lim);

            return cards.map((card) => {
              const jobLinkElement = card.querySelector(
                "a[href*='/jobs/view/']"
              ) as HTMLAnchorElement | null;
              return {
                title: pickText(card, [
                  "a[href*='/jobs/view/'] span[aria-hidden='true']",
                  ".job-card-container__link",
                  ".job-card-list__title",
                  ".base-search-card__title"
                ]),
                company: pickText(card, [
                  ".artdeco-entity-lockup__subtitle span[dir='ltr']",
                  ".job-card-container__primary-description",
                  ".job-card-container__company-name",
                  ".base-search-card__subtitle"
                ]),
                location: pickText(card, [
                  ".artdeco-entity-lockup__caption span[dir='ltr']",
                  ".job-card-container__metadata-wrapper span[dir='ltr']",
                  ".job-card-container__metadata-item",
                  ".job-search-card__location"
                ]),
                posted_at: pickText(card, [
                  "time",
                  ".job-card-container__listed-status",
                  ".job-card-container__footer"
                ]),
                job_url: toAbsoluteHref(
                  normalize(jobLinkElement?.getAttribute("href")) ||
                    normalize(jobLinkElement?.href)
                ),
                salary_range: pickText(card, [
                  ".job-card-container__salary-info",
                  ".salary-main-rail__salary-range"
                ]),
                employment_type: pickEmploymentType(card)
              };
            });
          }, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          title: dedupeRepeatedText(snapshot.title),
          company: normalizeText(snapshot.company),
          location: normalizeText(snapshot.location),
          posted_at: cleanPostedAt(snapshot.posted_at),
          job_url: normalizeText(snapshot.job_url),
          salary_range: normalizeText(snapshot.salary_range),
          employment_type: normalizeText(snapshot.employment_type)
        }))
        .filter((result) => result.title.length > 0 || result.job_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "jobs",
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

  private async searchPosts(input: SearchInput): Promise<SearchPostsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
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
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "posts"), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await page
            .locator(
              "div[data-urn*='activity'], .occludable-update, .feed-shared-update-v2"
            )
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);

          return page.evaluate((lim: number) => {
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

            if (
              normalize(globalThis.document.body?.innerText).includes(
                "We've filed a report for this error."
              )
            ) {
              return [] as Array<Record<string, string>>;
            }

            const mapPost = (post: Element): Record<string, string> => {
              const dataUrn = post.getAttribute("data-urn") ?? "";
              const postUrl = dataUrn ? toAbsoluteHref(`/feed/update/${dataUrn}`) : "";

              const author = pickText(post, [
                ".update-components-actor__title span[dir='ltr'] > span[aria-hidden='true']",
                ".update-components-actor__title span[aria-hidden='true']",
                "span[dir='ltr'] > span[aria-hidden='true']"
              ]);

              const authorHeadline = pickText(post, [
                ".update-components-actor__description span[aria-hidden='true']",
                ".update-components-actor__description"
              ]);

              const subDescription = pickText(post, [
                ".update-components-actor__sub-description span[aria-hidden='true']",
                ".update-components-actor__sub-description"
              ]);
              const postedAtMatch = /(\d+[hmdwy]|\d+\s*(?:hour|day|week|month|year|min|sec)s?\s*ago)/i.exec(
                subDescription
              );
              const postedAt = normalize(postedAtMatch?.[0] ?? subDescription);

              const textElement = post.querySelector(
                ".feed-shared-text span.break-words, .update-components-text span.break-words"
              );
              const text = normalize(
                (textElement as HTMLElement | null)?.innerText ??
                  textElement?.textContent ??
                  ""
              );

              const reactionCount = pickText(post, [
                ".social-details-social-counts__reactions-count",
                ".social-details-social-counts__count-value"
              ]);

              const commentCount = normalize(
                (
                  post.querySelector(
                    "button[aria-label*='comment'] span, .social-details-social-counts__comments"
                  ) as HTMLElement | null
                )?.innerText
              );

              return {
                author,
                author_headline: authorHeadline,
                posted_at: postedAt,
                text: text.slice(0, 500),
                post_url: postUrl,
                reaction_count: reactionCount,
                comment_count: commentCount
              };
            };

            const modernPostContainers = Array.from(
              globalThis.document.querySelectorAll("div[data-urn*='activity']")
            )
              .filter((post) => normalize(post.getAttribute("data-urn")))
              .filter(
                (post, index, arr) =>
                  arr.findIndex(
                    (candidate) =>
                      normalize(candidate.getAttribute("data-urn")) ===
                      normalize(post.getAttribute("data-urn"))
                  ) === index
              )
              .slice(0, lim);

            if (modernPostContainers.length > 0) {
              return modernPostContainers.map(mapPost);
            }

            const legacyPostContainers = Array.from(
              globalThis.document.querySelectorAll(
                "div.feed-shared-update-v2[data-urn], .occludable-update[data-urn]"
              )
            ).slice(0, lim);

            if (legacyPostContainers.length === 0) {
              return [] as Array<Record<string, string>>;
            }

            return legacyPostContainers.map(mapPost);
          }, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          author: dedupeRepeatedText(snapshot.author),
          author_headline: dedupeRepeatedText(snapshot.author_headline),
          posted_at: cleanPostedAt(snapshot.posted_at),
          text: normalizeText(snapshot.text),
          post_url: normalizeText(snapshot.post_url),
          reaction_count: normalizeText(snapshot.reaction_count),
          comment_count: normalizeText(snapshot.comment_count)
        }))
        .filter((result) => result.text.length > 0 || result.post_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "posts",
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
        "Failed to search LinkedIn posts."
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
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "groups"), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await page
            .locator("main a[href*='/groups/'], div[data-view-name='search-entity-result-universal-template']")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);

          return page.evaluate((lim: number) => {
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

            const pickSiblingText = (
              root: ParentNode,
              anchorSelector: string,
              index: number
            ): string => {
              const anchor = root.querySelector(anchorSelector);
              if (!anchor) {
                return "";
              }
              let el = anchor.nextElementSibling;
              let found = 0;
              while (el) {
                const text = normalize(el.textContent);
                if (text) {
                  if (found === index) {
                    return text;
                  }
                  found++;
                }
                el = el.nextElementSibling;
              }
              return "";
            };

            const extractModernCards = (): Array<Record<string, string>> => {
              const links = Array.from(
                globalThis.document.querySelectorAll("main a[href*='/groups/']")
              ).filter((link): link is HTMLAnchorElement => {
                const href = normalize(link.getAttribute("href"));
                return /\/groups\/[A-Za-z0-9-]+/.test(href);
              });

              const seen = new Set<string>();
              const uniqueLinks = links.filter((link) => {
                const href = normalize(link.getAttribute("href")) || normalize(link.href);
                const idMatch = /\/groups\/([^/?#]+)/.exec(href);
                const groupKey = normalize(idMatch?.[1]);
                if (!groupKey || seen.has(groupKey)) {
                  return false;
                }
                seen.add(groupKey);
                return true;
              });

              return uniqueLinks.slice(0, lim).map((link) => {
                const card = link.closest("li") ?? link.closest("div");
                if (!card) {
                  return {
                    name: "",
                    group_type: "",
                    member_count: "",
                    description: "",
                    group_url: ""
                  };
                }

                const paragraphs = Array.from(card.querySelectorAll("p"));
                const memberParagraph = paragraphs.find((paragraph) =>
                  /member/i.test(normalize((paragraph as HTMLElement).innerText))
                );

                return {
                  name: normalize((paragraphs[0]?.innerText ?? "").split("\n")[0]),
                  group_type: normalize(paragraphs[1]?.innerText),
                  member_count: normalize((memberParagraph as HTMLElement | undefined)?.innerText),
                  description: normalize(paragraphs[2]?.innerText || paragraphs[3]?.innerText),
                  group_url: toAbsoluteHref(
                    normalize(link.getAttribute("href")) || normalize(link.href)
                  )
                };
              });
            };

            const modernCards = extractModernCards();
            if (modernCards.some((card) => card.name || card.group_url)) {
              return modernCards;
            }

            const legacyCards = Array.from(
              globalThis.document.querySelectorAll(
                "div[data-view-name='search-entity-result-universal-template']"
              )
            ).slice(0, lim);

            return legacyCards.map((card) => {
              const nameLink = card.querySelector(
                ".t-roman.t-sans a[data-test-app-aware-link]"
              );
              const name = nameLink
                ? normalize(nameLink.textContent)
                : pickText(card, [
                    "a[href*='/groups/'] span[aria-hidden='true']",
                    "a[href*='/groups/']"
                  ]);

              return {
                name,
                group_type: "",
                member_count:
                  pickSiblingText(card, ".t-roman.t-sans", 0) ||
                  pickText(card, [".entity-result__primary-subtitle"]),
                description: pickText(card, [
                  "p[class*='entity-result__summary']",
                  "[class*='entity-result__summary']",
                  ".entity-result__summary"
                ]),
                group_url: pickHref(card, ["a[href*='/groups/']"])
              };
            });
          }, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          name: normalizeText(snapshot.name),
          group_type: normalizeText(snapshot.group_type),
          member_count: normalizeText(snapshot.member_count),
          description: normalizeText(snapshot.description),
          group_url: normalizeText(snapshot.group_url)
        }))
        .filter((result) => result.name.length > 0 || result.group_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "groups",
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
        "Failed to search LinkedIn groups."
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
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildSearchUrl(query, "events"), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await page
            .locator("main a[href*='/events/'], div[data-view-name='search-entity-result-universal-template']")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);

          return page.evaluate((lim: number) => {
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

            const pickSiblingText = (
              root: ParentNode,
              anchorSelector: string,
              index: number
            ): string => {
              const anchor = root.querySelector(anchorSelector);
              if (!anchor) {
                return "";
              }
              let el = anchor.nextElementSibling;
              let found = 0;
              while (el) {
                const text = normalize(el.textContent);
                if (text) {
                  if (found === index) {
                    return text;
                  }
                  found++;
                }
                el = el.nextElementSibling;
              }
              return "";
            };

            const extractModernCards = (): Array<Record<string, string>> => {
              const links = Array.from(
                globalThis.document.querySelectorAll("main a[href*='/events/']")
              ).filter((link): link is HTMLAnchorElement => {
                const href = normalize(link.getAttribute("href"));
                return /\/events\/[A-Za-z0-9-]+/.test(href);
              });

              const seen = new Set<string>();
              const uniqueLinks = links.filter((link) => {
                const href = normalize(link.getAttribute("href")) || normalize(link.href);
                const idMatch = /\/events\/([^/?#]+)/.exec(href);
                const eventKey = normalize(idMatch?.[1]);
                if (!eventKey || seen.has(eventKey)) {
                  return false;
                }
                seen.add(eventKey);
                return true;
              });

              return uniqueLinks.slice(0, lim).map((link) => {
                const card = link.closest("li") ?? link.closest("div");
                if (!card) {
                  return {
                    title: "",
                    date: "",
                    location: "",
                    organizer: "",
                    description: "",
                    attendee_count: "",
                    event_url: ""
                  };
                }

                const paragraphs = Array.from(card.querySelectorAll("p"));
                const venueLine = normalize(paragraphs[2]?.innerText || paragraphs[1]?.innerText);
                const organizerMatch = /^(.*?)\s*[•·]\s*By\s+(.*)$/i.exec(venueLine);
                const attendeeParagraph = paragraphs.find((paragraph) =>
                  /attendee|going|interested/i.test(
                    normalize((paragraph as HTMLElement).innerText)
                  )
                );

                return {
                  title: normalize((paragraphs[0]?.innerText ?? "").split("\n")[0]),
                  date: normalize(paragraphs[1]?.innerText),
                  location: normalize(organizerMatch?.[1] ?? venueLine),
                  organizer: normalize(organizerMatch?.[2] ?? ""),
                  description: normalize(paragraphs[3]?.innerText || paragraphs[4]?.innerText),
                  attendee_count: normalize(
                    (attendeeParagraph as HTMLElement | undefined)?.innerText
                  ),
                  event_url: toAbsoluteHref(
                    normalize(link.getAttribute("href")) || normalize(link.href)
                  )
                };
              });
            };

            const modernCards = extractModernCards();
            if (modernCards.some((card) => card.title || card.event_url)) {
              return modernCards;
            }

            const legacyCards = Array.from(
              globalThis.document.querySelectorAll(
                "div[data-view-name='search-entity-result-universal-template']"
              )
            ).slice(0, lim);

            return legacyCards.map((card) => {
              const nameLink = card.querySelector(
                ".t-roman.t-sans a[data-test-app-aware-link]"
              );
              const title = nameLink
                ? normalize(nameLink.textContent)
                : pickText(card, [
                    "a[href*='/events/'] span[aria-hidden='true']",
                    "a[href*='/events/']"
                  ]);

              const date =
                pickSiblingText(card, ".t-roman.t-sans", 0) ||
                pickText(card, [".entity-result__primary-subtitle"]);

              const venueLine =
                pickSiblingText(card, ".t-roman.t-sans", 1) ||
                pickText(card, [".entity-result__secondary-subtitle"]);
              const organizerMatch = /^(.*?)\s*[•·]\s*By\s+(.*)$/i.exec(venueLine);

              const attendeeText = pickText(card, [
                ".entity-result__insights",
                ".entity-result__simple-insight"
              ]);

              return {
                title,
                date,
                location: normalize(organizerMatch?.[1] ?? venueLine),
                organizer: normalize(organizerMatch?.[2] ?? ""),
                description: pickText(card, [
                  "p[class*='entity-result__summary']",
                  "[class*='entity-result__summary']",
                  ".entity-result__summary"
                ]),
                attendee_count: attendeeText,
                event_url: pickHref(card, ["a[href*='/events/']"])
              };
            });
          }, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          title: normalizeText(snapshot.title),
          date: normalizeText(snapshot.date),
          location: normalizeText(snapshot.location),
          organizer: normalizeText(snapshot.organizer),
          description: normalizeText(snapshot.description),
          attendee_count: normalizeText(snapshot.attendee_count),
          event_url: normalizeText(snapshot.event_url)
        }))
        .filter((result) => result.title.length > 0 || result.event_url.length > 0)
        .slice(0, limit);

      return {
        query,
        category: "events",
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
        "Failed to search LinkedIn events."
      );
    }
  }
}
/* eslint-enable no-undef */
