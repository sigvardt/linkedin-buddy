import { mkdirSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";

export const LINKEDIN_SELECTOR_AUDIT_PAGES = [
  "feed",
  "inbox",
  "profile",
  "connections",
  "notifications"
] as const;

export type LinkedInSelectorAuditPage =
  (typeof LINKEDIN_SELECTOR_AUDIT_PAGES)[number];

export const LINKEDIN_SELECTOR_AUDIT_STRATEGIES = [
  "primary",
  "secondary",
  "tertiary"
] as const;

export type LinkedInSelectorAuditStrategy =
  (typeof LINKEDIN_SELECTOR_AUDIT_STRATEGIES)[number];

export interface SelectorAuditCandidate {
  strategy: LinkedInSelectorAuditStrategy;
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

export interface SelectorAuditSelectorDefinition {
  key: string;
  description: string;
  candidates: SelectorAuditCandidate[];
}

export interface SelectorAuditPageDefinition {
  page: LinkedInSelectorAuditPage;
  url: string;
  selectors: SelectorAuditSelectorDefinition[];
  readyCandidates?: SelectorAuditCandidate[];
}

export interface SelectorAuditInput {
  profileName?: string;
}

export interface SelectorAuditStrategyResult {
  strategy: LinkedInSelectorAuditStrategy;
  status: "pass" | "fail";
  selector_key: string;
  selector_hint: string;
  error?: string;
}

export interface SelectorAuditFailureArtifacts {
  screenshot_path?: string;
  dom_snapshot_path?: string;
  accessibility_snapshot_path?: string;
}

export interface SelectorAuditResult {
  page: LinkedInSelectorAuditPage;
  page_url: string;
  selector_key: string;
  description: string;
  status: "pass" | "fail";
  matched_strategy: LinkedInSelectorAuditStrategy | null;
  matched_selector_key: string | null;
  fallback_used: string | null;
  fallback_strategy: LinkedInSelectorAuditStrategy | null;
  strategies: Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>;
  failure_artifacts: SelectorAuditFailureArtifacts;
  error?: string;
}

export interface SelectorAuditPageSummary {
  page: LinkedInSelectorAuditPage;
  total_count: number;
  pass_count: number;
  fail_count: number;
  fallback_count: number;
}

export interface SelectorAuditReport {
  run_id: string;
  profile_name: string;
  checked_at: string;
  total_count: number;
  pass_count: number;
  fail_count: number;
  fallback_count: number;
  artifact_dir: string;
  report_path: string;
  page_summaries: SelectorAuditPageSummary[];
  results: SelectorAuditResult[];
}

export interface LinkedInSelectorAuditRuntime {
  runId: string;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
}

export interface LinkedInSelectorAuditServiceOptions {
  registry?: SelectorAuditPageDefinition[];
  candidateTimeoutMs?: number;
  pageReadyTimeoutMs?: number;
}

interface SelectorAuditCandidateDefinition {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

type SelectorAuditCandidateDefinitions = Record<
  LinkedInSelectorAuditStrategy,
  SelectorAuditCandidateDefinition
>;

interface SelectorAuditSummaryCounts {
  totalCount: number;
  passCount: number;
  failCount: number;
  fallbackCount: number;
}

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const LINKEDIN_PROFILE_URL = "https://www.linkedin.com/in/me/";
const LINKEDIN_CONNECTIONS_URL =
  "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LINKEDIN_NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";

const DEFAULT_SELECTOR_AUDIT_CANDIDATE_TIMEOUT_MS = 2_000;
const DEFAULT_SELECTOR_AUDIT_PAGE_READY_TIMEOUT_MS = 8_000;
const SELECTOR_AUDIT_ARTIFACT_DIR = "selector-audit";

function createSelectorAuditCandidates(
  candidates: SelectorAuditCandidateDefinitions
): SelectorAuditCandidate[] {
  return LINKEDIN_SELECTOR_AUDIT_STRATEGIES.map((strategy) => ({
    strategy,
    ...candidates[strategy]
  }));
}

function createSelectorAuditSelectorDefinition(
  key: string,
  description: string,
  candidates: SelectorAuditCandidateDefinitions
): SelectorAuditSelectorDefinition {
  return {
    key,
    description,
    candidates: createSelectorAuditCandidates(candidates)
  };
}

function createDefaultSelectorAuditRegistry(): SelectorAuditPageDefinition[] {
  return [
    {
      page: "feed",
      url: LINKEDIN_FEED_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "post_composer_trigger",
          "Feed post composer trigger",
          {
            primary: {
              key: "role-button-start-post",
              selectorHint: "getByRole(button, /start a post/i)",
              locatorFactory: (page) =>
                page.getByRole("button", { name: /start a post/i })
            },
            secondary: {
              key: "aria-or-share-box-start-post",
              selectorHint:
                "button[aria-label*='start a post' i], .share-box-feed-entry__trigger, .share-box__open",
              locatorFactory: (page) =>
                page.locator(
                  "button[aria-label*='start a post' i], [role='button'][aria-label*='start a post' i], .share-box-feed-entry__trigger, .share-box__open"
                )
            },
            tertiary: {
              key: "text-start-post",
              selectorHint: "button, [role='button'] hasText /start a post/i",
              locatorFactory: (page) =>
                page
                  .locator("button, [role='button']")
                  .filter({ hasText: /start a post/i })
            }
          }
        )
      ]
    },
    {
      page: "inbox",
      url: LINKEDIN_MESSAGING_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "conversation_list_surface",
          "Inbox conversation list surface",
          {
            primary: {
              key: "role-main-with-thread-link",
              selectorHint: "getByRole(main) has a[href*='/messaging/thread/']",
              locatorFactory: (page) =>
                page
                  .getByRole("main")
                  .filter({ has: page.locator("a[href*='/messaging/thread/']") })
            },
            secondary: {
              key: "thread-link-or-conversation-card",
              selectorHint:
                "a[href*='/messaging/thread/'], li.msg-conversation-listitem, .msg-conversation-card, .msg-conversations-container",
              locatorFactory: (page) =>
                page.locator(
                  "a[href*='/messaging/thread/'], li.msg-conversation-listitem, .msg-conversation-card, .msg-conversations-container"
                )
            },
            tertiary: {
              key: "main-text-messaging",
              selectorHint: "main hasText /messaging|write a message/i",
              locatorFactory: (page) =>
                page.locator("main").filter({
                  hasText: /messaging|write a message/i
                })
            }
          }
        )
      ]
    },
    {
      page: "profile",
      url: LINKEDIN_PROFILE_URL,
      selectors: [
        createSelectorAuditSelectorDefinition("profile_header", "Profile header", {
          primary: {
            key: "role-heading-h1",
            selectorHint: "getByRole(heading, level: 1)",
            locatorFactory: (page) => page.getByRole("heading", { level: 1 })
          },
          secondary: {
            key: "profile-h1",
            selectorHint: "h1.text-heading-xlarge, h1[class*='text-heading'], h1",
            locatorFactory: (page) =>
              page.locator("h1.text-heading-xlarge, h1[class*='text-heading'], h1")
          },
          tertiary: {
            key: "main-text-profile-sections",
            selectorHint: "main hasText /about|experience|education|resources|open to/i",
            locatorFactory: (page) =>
              page.locator("main").filter({
                hasText: /about|experience|education|resources|open to/i
              })
          }
        })
      ]
    },
    {
      page: "connections",
      url: LINKEDIN_CONNECTIONS_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "connections_surface",
          "Connections page surface",
          {
            primary: {
              key: "role-heading-connections",
              selectorHint: "getByRole(heading, /connections/i)",
              locatorFactory: (page) =>
                page.getByRole("heading", { name: /connections/i })
            },
            secondary: {
              key: "connection-card",
              selectorHint:
                "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']",
              locatorFactory: (page) =>
                page.locator(
                  "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']"
                )
            },
            tertiary: {
              key: "main-text-connections",
              selectorHint: "main hasText /connections|message|remove connection/i",
              locatorFactory: (page) =>
                page.locator("main").filter({
                  hasText: /connections|message|remove connection/i
                })
            }
          }
        )
      ]
    },
    {
      page: "notifications",
      url: LINKEDIN_NOTIFICATIONS_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "notifications_surface",
          "Notifications list surface",
          {
            primary: {
              key: "role-heading-notifications",
              selectorHint: "getByRole(heading, /notifications/i)",
              locatorFactory: (page) =>
                page.getByRole("heading", { name: /notifications/i })
            },
            secondary: {
              key: "notification-card",
              selectorHint: ".nt-card, .notification-card, div[data-urn], article",
              locatorFactory: (page) =>
                page.locator(".nt-card, .notification-card, div[data-urn], article")
            },
            tertiary: {
              key: "main-text-notifications",
              selectorHint: "main hasText /notifications|ago/i",
              locatorFactory: (page) =>
                page.locator("main").filter({ hasText: /notifications|ago/i })
            }
          }
        )
      ]
    }
  ];
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return Promise.resolve(existing);
  }
  return context.newPage();
}

function createMissingStrategyResult(
  strategy: LinkedInSelectorAuditStrategy
): SelectorAuditStrategyResult {
  const titleCaseStrategy = `${strategy[0]?.toUpperCase() ?? ""}${strategy.slice(1)}`;

  return {
    strategy,
    status: "fail",
    selector_key: `missing-${strategy}`,
    selector_hint: `${strategy} selector missing from registry`,
    error: `${titleCaseStrategy} selector missing from registry.`
  };
}

function createEmptyPageSummary(page: LinkedInSelectorAuditPage): SelectorAuditPageSummary {
  return {
    page,
    total_count: 0,
    pass_count: 0,
    fail_count: 0,
    fallback_count: 0
  };
}

function countSelectorAuditResults(
  results: SelectorAuditResult[]
): SelectorAuditSummaryCounts {
  return results.reduce<SelectorAuditSummaryCounts>(
    (counts, result) => ({
      totalCount: counts.totalCount + 1,
      passCount: counts.passCount + (result.status === "pass" ? 1 : 0),
      failCount: counts.failCount + (result.status === "fail" ? 1 : 0),
      fallbackCount: counts.fallbackCount + (result.fallback_used !== null ? 1 : 0)
    }),
    {
      totalCount: 0,
      passCount: 0,
      failCount: 0,
      fallbackCount: 0
    }
  );
}

function validateSelectorAuditRegistry(
  registry: SelectorAuditPageDefinition[]
): SelectorAuditPageDefinition[] {
  const pageKeys = new Set<LinkedInSelectorAuditPage>();

  for (const pageDefinition of registry) {
    if (pageKeys.has(pageDefinition.page)) {
      throw new Error(`Duplicate selector audit page definition: ${pageDefinition.page}`);
    }

    pageKeys.add(pageDefinition.page);

    if (pageDefinition.selectors.length === 0) {
      throw new Error(`Selector audit page ${pageDefinition.page} has no selectors.`);
    }

    const selectorKeys = new Set<string>();
    for (const selectorDefinition of pageDefinition.selectors) {
      if (selectorKeys.has(selectorDefinition.key)) {
        throw new Error(
          `Duplicate selector audit key ${selectorDefinition.key} on ${pageDefinition.page}.`
        );
      }

      selectorKeys.add(selectorDefinition.key);

      if (selectorDefinition.candidates.length === 0) {
        throw new Error(
          `Selector audit key ${selectorDefinition.key} on ${pageDefinition.page} has no candidates.`
        );
      }

      const candidateKeys = new Set<string>();
      const strategies = new Set<LinkedInSelectorAuditStrategy>();
      for (const candidate of selectorDefinition.candidates) {
        if (candidateKeys.has(candidate.key)) {
          throw new Error(
            `Duplicate selector audit candidate key ${candidate.key} on ${pageDefinition.page}:${selectorDefinition.key}.`
          );
        }
        candidateKeys.add(candidate.key);

        if (strategies.has(candidate.strategy)) {
          throw new Error(
            `Duplicate selector audit strategy ${candidate.strategy} on ${pageDefinition.page}:${selectorDefinition.key}.`
          );
        }
        strategies.add(candidate.strategy);
      }
    }
  }

  return registry;
}

async function getAccessibilitySnapshot(page: Page): Promise<unknown> {
  const accessiblePage = page as unknown as {
    accessibility?: {
      snapshot: (options?: { interestingOnly?: boolean }) => Promise<unknown>;
    };
  };

  if (!accessiblePage.accessibility) {
    return null;
  }

  return accessiblePage.accessibility.snapshot({ interestingOnly: false });
}

function createStrategyResults(
  strategyResults: SelectorAuditStrategyResult[]
): Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult> {
  const indexed = new Map<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>();
  for (const result of strategyResults) {
    indexed.set(result.strategy, result);
  }

  return Object.fromEntries(
    LINKEDIN_SELECTOR_AUDIT_STRATEGIES.map((strategy) => [
      strategy,
      indexed.get(strategy) ?? createMissingStrategyResult(strategy)
    ])
  ) as Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>;
}

export class LinkedInSelectorAuditService {
  private readonly registry: SelectorAuditPageDefinition[];
  private readonly candidateTimeoutMs: number;
  private readonly pageReadyTimeoutMs: number;

  constructor(
    private readonly runtime: LinkedInSelectorAuditRuntime,
    options: LinkedInSelectorAuditServiceOptions = {}
  ) {
    this.registry = validateSelectorAuditRegistry(
      options.registry ?? createDefaultSelectorAuditRegistry()
    );
    this.candidateTimeoutMs =
      options.candidateTimeoutMs ?? DEFAULT_SELECTOR_AUDIT_CANDIDATE_TIMEOUT_MS;
    this.pageReadyTimeoutMs =
      options.pageReadyTimeoutMs ?? DEFAULT_SELECTOR_AUDIT_PAGE_READY_TIMEOUT_MS;
  }

  async auditSelectors(input: SelectorAuditInput = {}): Promise<SelectorAuditReport> {
    const profileName = input.profileName ?? "default";

    this.runtime.logger.log("info", "selector.audit.start", {
      profileName,
      pageCount: this.registry.length
    });

    await this.runtime.auth.ensureAuthenticated({ profileName });

    const results = await this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        const pageResults: SelectorAuditResult[] = [];

        for (const pageDefinition of this.registry) {
          this.runtime.logger.log("info", "selector.audit.page.start", {
            profileName,
            page: pageDefinition.page,
            url: pageDefinition.url,
            selectorCount: pageDefinition.selectors.length
          });

          const currentPageResults = await this.auditPage(page, pageDefinition);
          pageResults.push(...currentPageResults);
          const counts = countSelectorAuditResults(currentPageResults);

          this.runtime.logger.log("info", "selector.audit.page.done", {
            profileName,
            page: pageDefinition.page,
            passCount: counts.passCount,
            failCount: counts.failCount,
            fallbackCount: counts.fallbackCount
          });
        }

        return pageResults;
      }
    );

    const artifactDir = this.runtime.artifacts.resolve(SELECTOR_AUDIT_ARTIFACT_DIR);
    const reportPath = this.runtime.artifacts.resolve(
      `${SELECTOR_AUDIT_ARTIFACT_DIR}/report.json`
    );
    const checkedAt = new Date().toISOString();
    const pageSummaries = this.buildPageSummaries(results);
    const counts = countSelectorAuditResults(results);
    const report: SelectorAuditReport = {
      run_id: this.runtime.runId,
      profile_name: profileName,
      checked_at: checkedAt,
      total_count: counts.totalCount,
      pass_count: counts.passCount,
      fail_count: counts.failCount,
      fallback_count: counts.fallbackCount,
      artifact_dir: artifactDir,
      report_path: reportPath,
      page_summaries: pageSummaries,
      results
    };

    this.runtime.artifacts.writeJson(
      `${SELECTOR_AUDIT_ARTIFACT_DIR}/report.json`,
      report,
      {
        profile_name: profileName,
        checked_at: checkedAt,
        pass_count: report.pass_count,
        fail_count: report.fail_count,
        fallback_count: report.fallback_count
      }
    );

    this.runtime.logger.log("info", "selector.audit.done", {
      profileName,
      totalCount: report.total_count,
      passCount: report.pass_count,
      failCount: report.fail_count,
      fallbackCount: report.fallback_count,
      reportPath
    });

    return report;
  }

  private async auditPage(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition
  ): Promise<SelectorAuditResult[]> {
    try {
      await page.goto(pageDefinition.url, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);
      await this.waitForPageReady(page, pageDefinition);
    } catch (error) {
      return Promise.all(
        pageDefinition.selectors.map((selectorDefinition) =>
          this.createFailedResult(page, pageDefinition, selectorDefinition, error)
        )
      );
    }

    return Promise.all(
      pageDefinition.selectors.map((selectorDefinition) =>
        this.evaluateSelectorDefinition(page, pageDefinition, selectorDefinition)
      )
    );
  }

  private async waitForPageReady(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition
  ): Promise<void> {
    const readyCandidates =
      pageDefinition.readyCandidates ?? pageDefinition.selectors[0]?.candidates ?? [];

    for (const candidate of readyCandidates) {
      const result = await this.evaluateCandidate(
        page,
        candidate,
        this.pageReadyTimeoutMs
      );
      if (result.status === "pass") {
        return;
      }
    }
  }

  private async evaluateSelectorDefinition(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition
  ): Promise<SelectorAuditResult> {
    const strategyResults: SelectorAuditStrategyResult[] = [];

    for (const candidate of selectorDefinition.candidates) {
      strategyResults.push(
        await this.evaluateCandidate(page, candidate)
      );
    }

    const matchedResult = strategyResults.find((result) => result.status === "pass") ?? null;
    const failureArtifacts =
      matchedResult === null
        ? await this.captureFailureArtifacts(page, pageDefinition, selectorDefinition)
        : {};

    return {
      page: pageDefinition.page,
      page_url: page.url(),
      selector_key: selectorDefinition.key,
      description: selectorDefinition.description,
      status: matchedResult ? "pass" : "fail",
      matched_strategy: matchedResult?.strategy ?? null,
      matched_selector_key: matchedResult?.selector_key ?? null,
      fallback_used:
        matchedResult && matchedResult.strategy !== "primary"
          ? matchedResult.selector_key
          : null,
      fallback_strategy:
        matchedResult && matchedResult.strategy !== "primary"
          ? matchedResult.strategy
          : null,
      strategies: createStrategyResults(strategyResults),
      failure_artifacts: failureArtifacts,
      ...(matchedResult
        ? {}
        : {
            error: `No selector strategy matched for ${selectorDefinition.key} on ${pageDefinition.page}.`
          })
    };
  }

  private async evaluateCandidate(
    page: Page,
    candidate: SelectorAuditCandidate,
    timeoutMs: number = this.candidateTimeoutMs
  ): Promise<SelectorAuditStrategyResult> {
    const locator = candidate.locatorFactory(page).first();

    try {
      await locator.waitFor({
        state: "visible",
        timeout: timeoutMs
      });

      return {
        strategy: candidate.strategy,
        status: "pass",
        selector_key: candidate.key,
        selector_hint: candidate.selectorHint
      };
    } catch (error) {
      return {
        strategy: candidate.strategy,
        status: "fail",
        selector_key: candidate.key,
        selector_hint: candidate.selectorHint,
        error: getErrorMessage(error)
      };
    }
  }

  private async createFailedResult(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition,
    error: unknown
  ): Promise<SelectorAuditResult> {
    const errorMessage = getErrorMessage(error);
    const strategyResults = selectorDefinition.candidates.map((candidate) => ({
      strategy: candidate.strategy,
      status: "fail" as const,
      selector_key: candidate.key,
      selector_hint: candidate.selectorHint,
      error: errorMessage
    }));

    const failureArtifacts = await this.captureFailureArtifacts(
      page,
      pageDefinition,
      selectorDefinition
    );

    return {
      page: pageDefinition.page,
      page_url: page.url(),
      selector_key: selectorDefinition.key,
      description: selectorDefinition.description,
      status: "fail",
      matched_strategy: null,
      matched_selector_key: null,
      fallback_used: null,
      fallback_strategy: null,
      strategies: createStrategyResults(strategyResults),
      failure_artifacts: failureArtifacts,
      error: errorMessage
    };
  }

  private async captureFailureArtifacts(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition
  ): Promise<SelectorAuditFailureArtifacts> {
    const prefix = path.join(
      SELECTOR_AUDIT_ARTIFACT_DIR,
      sanitizePathSegment(pageDefinition.page),
      `${sanitizePathSegment(selectorDefinition.key)}-${Date.now()}`
    );

    const screenshotPath = `${prefix}.png`;
    const domSnapshotPath = `${prefix}.html`;
    const accessibilitySnapshotPath = `${prefix}.a11y.json`;

    const failureArtifacts: SelectorAuditFailureArtifacts = {};

    try {
      const absoluteScreenshotPath = this.runtime.artifacts.resolve(screenshotPath);
      mkdirSync(path.dirname(absoluteScreenshotPath), { recursive: true });
      await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
      this.runtime.artifacts.registerArtifact(screenshotPath, "image/png", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_failure_screenshot"
      });
      failureArtifacts.screenshot_path = absoluteScreenshotPath;
    } catch {
      // Best effort.
    }

    try {
      const html = await page.content();
      this.runtime.artifacts.writeText(domSnapshotPath, html, "text/html", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_dom_snapshot"
      });
      failureArtifacts.dom_snapshot_path = this.runtime.artifacts.resolve(domSnapshotPath);
    } catch {
      // Best effort.
    }

    try {
      const accessibilitySnapshot = await getAccessibilitySnapshot(page);
      this.runtime.artifacts.writeJson(accessibilitySnapshotPath, accessibilitySnapshot, {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_accessibility_snapshot"
      });
      failureArtifacts.accessibility_snapshot_path = this.runtime.artifacts.resolve(
        accessibilitySnapshotPath
      );
    } catch {
      // Best effort.
    }

    return failureArtifacts;
  }

  private buildPageSummaries(results: SelectorAuditResult[]): SelectorAuditPageSummary[] {
    const pageSummaries = new Map<LinkedInSelectorAuditPage, SelectorAuditPageSummary>(
      this.registry.map((pageDefinition) => [
        pageDefinition.page,
        createEmptyPageSummary(pageDefinition.page)
      ])
    );

    for (const result of results) {
      const summary = pageSummaries.get(result.page) ?? createEmptyPageSummary(result.page);
      summary.total_count += 1;
      summary.pass_count += result.status === "pass" ? 1 : 0;
      summary.fail_count += result.status === "fail" ? 1 : 0;
      summary.fallback_count += result.fallback_used !== null ? 1 : 0;
      pageSummaries.set(result.page, summary);
    }

    return [...pageSummaries.values()];
  }
}

export function createLinkedInSelectorAuditRegistry(): SelectorAuditPageDefinition[] {
  return createDefaultSelectorAuditRegistry();
}
