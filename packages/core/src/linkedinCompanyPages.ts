import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  type LinkedInSelectorLocale,
  type LinkedInSelectorPhraseKey
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */

export interface LinkedInCompanyPage {
  company_url: string;
  about_url: string;
  slug: string | null;
  name: string;
  industry: string;
  location: string;
  follower_count: string;
  employee_count: string;
  associated_members: string;
  website: string;
  verified_on: string;
  headquarters: string;
  specialties: string;
  overview: string;
  follow_state: "following" | "not_following" | "unknown";
}

export interface ViewCompanyPageInput {
  profileName?: string;
  target: string;
}

interface PrepareCompanyPageActionInput {
  profileName?: string;
  targetCompany: string;
  operatorNote?: string;
}

export type PrepareFollowCompanyPageInput = PrepareCompanyPageActionInput;

export type PrepareUnfollowCompanyPageInput = PrepareCompanyPageActionInput;

interface LinkedInCompanyPagesRuntimeBase {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
}

export interface LinkedInCompanyPagesExecutorRuntime
  extends LinkedInCompanyPagesRuntimeBase {
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInCompanyPagesRuntime
  extends LinkedInCompanyPagesExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInCompanyPagesExecutorRuntime>,
    "prepare"
  >;
}

export const FOLLOW_COMPANY_PAGE_ACTION_TYPE = "company.follow";
export const UNFOLLOW_COMPANY_PAGE_ACTION_TYPE = "company.unfollow";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function resolveCompanyPageUrl(target: string): string {
  const trimmedTarget = normalizeText(target);
  if (!trimmedTarget) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Company page target is required."
    );
  }

  if (isAbsoluteUrl(trimmedTarget)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedTarget);
    } catch (error) {
      throw asLinkedInBuddyError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Company page URL must be a valid URL."
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);
    if (!isLinkedInDomain || segments[0] !== "company" || !segments[1]) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Company page URL must point to linkedin.com/company/.",
        { target: trimmedTarget }
      );
    }

    const slug = decodeURIComponent(segments[1]);
    return `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`;
  }

  if (trimmedTarget.startsWith("/company/")) {
    const [, , slug = ""] = trimmedTarget.split("/");
    const normalizedSlug = normalizeText(slug);
    if (!normalizedSlug) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Company page target is required."
      );
    }
    return `https://www.linkedin.com/company/${encodeURIComponent(normalizedSlug)}/`;
  }

  return `https://www.linkedin.com/company/${encodeURIComponent(trimmedTarget)}/`;
}

export function normalizeLinkedInCompanyPageUrl(target: string): string {
  const resolved = resolveCompanyPageUrl(target);

  try {
    const parsedUrl = new URL(resolved);
    parsedUrl.search = "";
    parsedUrl.hash = "";

    const pathname = parsedUrl.pathname.endsWith("/")
      ? parsedUrl.pathname
      : `${parsedUrl.pathname}/`;

    return `${parsedUrl.origin}${pathname}`;
  } catch {
    return resolved;
  }
}

function buildCompanyPageAboutUrl(target: string): string {
  return `${normalizeLinkedInCompanyPageUrl(target)}about/`;
}

function extractCompanySlug(url: string): string | null {
  const match = /\/company\/([^/?#]+)/i.exec(url);
  const slug = match?.[1];
  if (!slug) {
    return null;
  }

  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function waitForCompanyPageReady(page: Page): Promise<void> {
  await page
    .locator("main h1")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
}

type LocatorRoot = Page | Locator;

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: LocatorRoot) => Locator;
}

async function findVisibleLocator(
  root: LocatorRoot,
  candidates: VisibleLocatorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await locator.isVisible().catch(() => false)) {
      return { locator, key: candidate.key };
    }
  }

  return null;
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

function buildCompanyActionButtonCandidates(input: {
  root: Locator;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
}): VisibleLocatorCandidate[] {
  const exactRegex = buildLinkedInSelectorPhraseRegex(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const exactRegexHint = formatLinkedInSelectorRegexHint(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const ariaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    input.selectorKeys,
    input.selectorLocale
  );

  return [
    {
      key: `${input.candidateKeyPrefix}-root-role`,
      selectorHint: `root.getByRole(button, ${exactRegexHint})`,
      locatorFactory: () =>
        input.root.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-root-aria`,
      selectorHint: `root ${ariaSelector}`,
      locatorFactory: () => input.root.locator(ariaSelector)
    },
    {
      key: `${input.candidateKeyPrefix}-page-role`,
      selectorHint: `page.getByRole(button, ${exactRegexHint})`,
      locatorFactory: (pageRoot) =>
        pageRoot.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-page-aria`,
      selectorHint: ariaSelector,
      locatorFactory: (pageRoot) => pageRoot.locator(ariaSelector)
    }
  ];
}

async function readCompanyFollowState(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInCompanyPage["follow_state"]> {
  const root = page.locator("main").first();
  const followingCandidates = buildCompanyActionButtonCandidates({
    root,
    selectorLocale,
    selectorKeys: "following",
    candidateKeyPrefix: "company-following"
  });
  if (await findVisibleLocator(page, followingCandidates)) {
    return "following";
  }

  const followCandidates = buildCompanyActionButtonCandidates({
    root,
    selectorLocale,
    selectorKeys: "follow",
    candidateKeyPrefix: "company-follow"
  });
  if (await findVisibleLocator(page, followCandidates)) {
    return "not_following";
  }

  return "unknown";
}

async function clickCompanyAction(input: {
  page: Page;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  actionLabel: string;
  targetCompany: string;
  candidateKeyPrefix: string;
}): Promise<string> {
  const root = input.page.locator("main").first();
  const candidates = buildCompanyActionButtonCandidates({
    root,
    selectorLocale: input.selectorLocale,
    selectorKeys: input.selectorKeys,
    candidateKeyPrefix: input.candidateKeyPrefix
  });
  const found = await findVisibleLocator(input.page, candidates);

  if (!found) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${input.actionLabel} action is not available for "${input.targetCompany}".`,
      {
        target_company: input.targetCompany,
        selector_candidates: candidates.map((candidate) => ({
          key: candidate.key,
          selector_hint: candidate.selectorHint
        }))
      }
    );
  }

  await found.locator.click({ timeout: 5_000 });
  return found.key;
}

async function extractCompanyPageData(page: Page): Promise<
  Omit<LinkedInCompanyPage, "follow_state">
> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const main = globalThis.document.querySelector("main");
    const companyUrl = normalize(globalThis.location.href);
    const slug = (() => {
      const match = /\/company\/([^/?#]+)/i.exec(companyUrl);
      const value = match?.[1];
      if (!value) {
        return null;
      }
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    })();

    const firstSection = main?.querySelector("section");
    const topLines = (
      (firstSection as HTMLElement | null)?.innerText ?? firstSection?.textContent ?? ""
    )
      .split(/\n+/)
      .map((value) => normalize(value))
      .filter((value) => value.length > 0);
    const summaryLine =
      topLines.find(
        (line) => /\bfollowers\b/i.test(line) && /\bemployees\b/i.test(line)
      ) ??
      topLines[1] ??
      "";

    const overviewSection = Array.from(
      main?.querySelectorAll("section") ?? []
    ).find((section) => normalize(section.querySelector("h2, h3")?.textContent) === "Overview");
    const overview = normalize(overviewSection?.querySelector("p")?.textContent);

    const detailMap = new Map<string, string[]>();
    for (const dt of Array.from(main?.querySelectorAll("dt") ?? [])) {
      const label = normalize(dt.textContent);
      if (!label) {
        continue;
      }

      const values: string[] = [];
      let sibling = dt.nextElementSibling;
      while (sibling && sibling.tagName === "DD") {
        const value = normalize(sibling.textContent);
        if (value) {
          values.push(value);
        }
        sibling = sibling.nextElementSibling;
      }

      detailMap.set(label, values);
    }

    const industry = detailMap.get("Industry")?.[0] ?? "";
    const followerMatch = /([0-9][\w.,+]*\s+followers)/i.exec(summaryLine);
    const followerCount = normalize(followerMatch?.[1] ?? "");
    const employeeCount =
      detailMap.get("Company size")?.[0] ??
      normalize(/([0-9][\w.,+-]*\s+employees)$/i.exec(summaryLine)?.[1] ?? "");
    const locationPrefix = followerMatch
      ? normalize(summaryLine.slice(0, followerMatch.index))
      : "";
    const location = industry && locationPrefix.startsWith(industry)
      ? normalize(locationPrefix.slice(industry.length))
      : locationPrefix;

    return {
      company_url: slug
        ? `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`
        : companyUrl,
      about_url: slug
        ? `https://www.linkedin.com/company/${encodeURIComponent(slug)}/about/`
        : companyUrl,
      slug,
      name: normalize(main?.querySelector("h1")?.textContent),
      industry,
      location,
      follower_count: followerCount,
      employee_count: employeeCount,
      associated_members: detailMap.get("Company size")?.[1] ?? "",
      website: detailMap.get("Website")?.[0] ?? "",
      verified_on: detailMap.get("Verified page")?.[0] ?? "",
      headquarters: detailMap.get("Headquarters")?.[0] ?? "",
      specialties: detailMap.get("Specialties")?.[0] ?? "",
      overview
    };
  });
}

async function executeFollowCompanyPage(
  runtime: LinkedInCompanyPagesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetCompany = String(target.target_company ?? "");
  const profileName = String(target.profile_name ?? "default");
  const companyUrl = normalizeLinkedInCompanyPageUrl(
    String(target.company_url ?? targetCompany)
  );

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
        actionId,
        actionType: FOLLOW_COMPANY_PAGE_ACTION_TYPE,
        profileName,
        targetUrl: companyUrl,
        metadata: {
          target_company: targetCompany,
          company_url: companyUrl
        },
        errorDetails: {
          target_company: targetCompany,
          company_url: companyUrl
        },
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn company follow action."
          ),
        execute: async () => {
          await page.goto(buildCompanyPageAboutUrl(companyUrl), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForCompanyPageReady(page);

          const followState = await readCompanyFollowState(
            page,
            runtime.selectorLocale
          );
          if (followState === "following") {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              `Already following company "${targetCompany}".`,
              {
                target_company: targetCompany,
                company_url: companyUrl
              }
            );
          }

          const selectorKey = await clickCompanyAction({
            page,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "follow",
            actionLabel: "Follow",
            targetCompany,
            candidateKeyPrefix: "company-follow"
          });

          const followed = await waitForCondition(async () => {
            const nextState = await readCompanyFollowState(
              page,
              runtime.selectorLocale
            );
            return nextState === "following";
          }, 5_000);

          if (!followed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "Company follow action could not be verified after clicking the control.",
              {
                target_company: targetCompany,
                company_url: companyUrl,
                follow_selector_key: selectorKey
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "company_followed",
              target_company: targetCompany,
              company_url: companyUrl,
              follow_selector_key: selectorKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUnfollowCompanyPage(
  runtime: LinkedInCompanyPagesExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetCompany = String(target.target_company ?? "");
  const profileName = String(target.profile_name ?? "default");
  const companyUrl = normalizeLinkedInCompanyPageUrl(
    String(target.company_url ?? targetCompany)
  );

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
        actionId,
        actionType: UNFOLLOW_COMPANY_PAGE_ACTION_TYPE,
        profileName,
        targetUrl: companyUrl,
        metadata: {
          target_company: targetCompany,
          company_url: companyUrl
        },
        errorDetails: {
          target_company: targetCompany,
          company_url: companyUrl
        },
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn company unfollow action."
          ),
        execute: async () => {
          await page.goto(buildCompanyPageAboutUrl(companyUrl), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForCompanyPageReady(page);

          const followState = await readCompanyFollowState(
            page,
            runtime.selectorLocale
          );
          if (followState === "not_following") {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              `Already not following company "${targetCompany}".`,
              {
                target_company: targetCompany,
                company_url: companyUrl
              }
            );
          }

          const selectorKey = await clickCompanyAction({
            page,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "following",
            actionLabel: "Unfollow",
            targetCompany,
            candidateKeyPrefix: "company-unfollow"
          });

          const unfollowed = await waitForCondition(async () => {
            const nextState = await readCompanyFollowState(
              page,
              runtime.selectorLocale
            );
            return nextState === "not_following";
          }, 5_000);

          if (!unfollowed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "Company unfollow action could not be verified after clicking the control.",
              {
                target_company: targetCompany,
                company_url: companyUrl,
                unfollow_selector_key: selectorKey
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "company_unfollowed",
              target_company: targetCompany,
              company_url: companyUrl,
              unfollow_selector_key: selectorKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class FollowCompanyPageActionExecutor
  implements ActionExecutor<LinkedInCompanyPagesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInCompanyPagesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeFollowCompanyPage(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class UnfollowCompanyPageActionExecutor
  implements ActionExecutor<LinkedInCompanyPagesExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInCompanyPagesExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUnfollowCompanyPage(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export function createCompanyPageActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInCompanyPagesExecutorRuntime>
> {
  return {
    [FOLLOW_COMPANY_PAGE_ACTION_TYPE]: new FollowCompanyPageActionExecutor(),
    [UNFOLLOW_COMPANY_PAGE_ACTION_TYPE]: new UnfollowCompanyPageActionExecutor()
  };
}

export class LinkedInCompanyPagesService {
  constructor(private readonly runtime: LinkedInCompanyPagesRuntime) {}

  private prepareCompanyPageAction(input: {
    actionType: string;
    profileName?: string | undefined;
    targetCompany: string;
    operatorNote?: string | undefined;
    summary: string;
  }): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const targetCompany = normalizeText(input.targetCompany);
    if (!targetCompany) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "targetCompany is required."
      );
    }

    const companyUrl = normalizeLinkedInCompanyPageUrl(targetCompany);
    const target = {
      profile_name: profileName,
      target_company: targetCompany,
      company_url: companyUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target,
      payload: {},
      preview: {
        summary: input.summary,
        target
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async viewCompanyPage(input: ViewCompanyPageInput): Promise<LinkedInCompanyPage> {
    const profileName = input.profileName ?? "default";
    const companyUrl = normalizeLinkedInCompanyPageUrl(input.target);
    const aboutUrl = buildCompanyPageAboutUrl(companyUrl);

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
          await page.goto(aboutUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForCompanyPageReady(page);

          const company = await extractCompanyPageData(page);
          const followState = await readCompanyFollowState(
            page,
            this.runtime.selectorLocale
          );

          return {
            ...company,
            company_url: normalizeLinkedInCompanyPageUrl(
              company.company_url || companyUrl
            ),
            about_url: buildCompanyPageAboutUrl(
              company.company_url || companyUrl
            ),
            slug: company.slug ?? extractCompanySlug(companyUrl),
            follow_state: followState
          };
        }
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn company page."
      );
    }
  }

  prepareFollowCompanyPage(input: PrepareFollowCompanyPageInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareCompanyPageAction({
      actionType: FOLLOW_COMPANY_PAGE_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      targetCompany: input.targetCompany,
      summary: `Follow company ${normalizeText(input.targetCompany)}`
    });
  }

  prepareUnfollowCompanyPage(input: PrepareUnfollowCompanyPageInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareCompanyPageAction({
      actionType: UNFOLLOW_COMPANY_PAGE_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      targetCompany: input.targetCompany,
      summary: `Unfollow company ${normalizeText(input.targetCompany)}`
    });
  }
}
