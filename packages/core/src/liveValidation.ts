import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route
} from "playwright-core";
import { ArtifactHelpers } from "./artifacts.js";
import {
  ensureConfigPaths,
  resolveConfigPaths,
  type ConfigPaths
} from "./config.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import { createRunId } from "./run.js";
import {
  LinkedInSessionStore,
  type LoadStoredLinkedInSessionResult
} from "./auth/sessionStore.js";
import { inspectLinkedInSession } from "./auth/sessionInspection.js";

export const LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS = [
  {
    id: "feed",
    summary: "Load the LinkedIn feed and verify the main feed surface."
  },
  {
    id: "profile",
    summary: "Open the signed-in profile and verify the header selectors."
  },
  {
    id: "notifications",
    summary: "Open notifications and verify the notifications surface."
  },
  {
    id: "inbox",
    summary: "Open messaging and verify the inbox plus one readable thread when available."
  },
  {
    id: "connections",
    summary: "Open connections and verify the connections list surface."
  }
] as const;

export type LinkedInReadOnlyValidationOperation =
  (typeof LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS)[number];

export type LinkedInReadOnlyValidationOperationId =
  LinkedInReadOnlyValidationOperation["id"];

export type ReadOnlyValidationStatus = "pass" | "fail";
export type ReadOnlyValidationDiffChange =
  | "fallback_drift"
  | "new_failure"
  | "recovered";

interface ReadOnlySelectorCandidateDefinition {
  key: string;
  selector: string;
}

interface ReadOnlySelectorDefinition {
  candidates: ReadOnlySelectorCandidateDefinition[];
  description: string;
  key: string;
}

interface ReadOnlyOperationDefinition {
  expectedPath: RegExp;
  id: LinkedInReadOnlyValidationOperationId;
  selectors: ReadOnlySelectorDefinition[];
  summary: string;
  url: string;
}

interface ReadOnlyOperationExecutionResult {
  additionalWarnings: string[];
  finalUrl: string;
  selectorResults: ReadOnlyValidationSelectorResult[];
  threadUrl?: string;
}

export interface ReadOnlyValidationSelectorResult {
  description: string;
  error?: string;
  matched_candidate_key: string | null;
  matched_candidate_rank: number | null;
  matched_selector: string | null;
  selector_key: string;
  status: ReadOnlyValidationStatus;
}

export interface ReadOnlyValidationOperationResult {
  completed_at: string;
  failed_count: number;
  final_url: string;
  matched_count: number;
  operation: LinkedInReadOnlyValidationOperationId;
  page_load_ms: number;
  selector_results: ReadOnlyValidationSelectorResult[];
  started_at: string;
  status: ReadOnlyValidationStatus;
  summary: string;
  thread_url?: string;
  url: string;
  warnings: string[];
}

export interface ReadOnlyValidationDiffEntry {
  change: ReadOnlyValidationDiffChange;
  current_candidate_key: string | null;
  current_status: ReadOnlyValidationStatus;
  operation: LinkedInReadOnlyValidationOperationId;
  previous_candidate_key: string | null;
  previous_status: ReadOnlyValidationStatus;
  selector_key: string;
}

export interface ReadOnlyValidationDiff {
  previous_report_path?: string;
  recoveries: ReadOnlyValidationDiffEntry[];
  regressions: ReadOnlyValidationDiffEntry[];
  unchanged_count: number;
}

export interface ReadOnlyValidationBlockedRequest {
  blocked_at: string;
  method: string;
  reason: "non_get" | "non_linkedin_domain";
  resource_type: string;
  url: string;
}

export interface ReadOnlyValidationReport {
  blocked_request_count: number;
  blocked_requests: ReadOnlyValidationBlockedRequest[];
  checked_at: string;
  diff: ReadOnlyValidationDiff;
  events_path: string;
  fail_count: number;
  latest_report_path: string;
  operation_count: number;
  operations: ReadOnlyValidationOperationResult[];
  outcome: ReadOnlyValidationStatus;
  pass_count: number;
  previous_report_path?: string;
  recommended_actions: string[];
  report_path: string;
  request_limits: {
    max_requests: number;
    max_requests_reached: boolean;
    min_interval_ms: number;
    used_requests: number;
  };
  run_id: string;
  session: {
    captured_at: string;
    file_path: string;
    li_at_expires_at: string | null;
    session_name: string;
  };
  summary: string;
}

export interface RunReadOnlyValidationOptions {
  baseDir?: string;
  maxRequests?: number;
  minIntervalMs?: number;
  onBeforeOperation?: (
    operation: LinkedInReadOnlyValidationOperation
  ) => Promise<void>;
  sessionName?: string;
  timeoutMs?: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
const READ_ONLY_REPORT_DIR = "live-readonly";
const READ_ONLY_LATEST_REPORT_NAME = "latest-report.json";
const ALLOWED_LINKEDIN_HOST_SUFFIXES = ["linkedin.com", "licdn.com"] as const;

const READ_ONLY_OPERATION_REGISTRY: ReadonlyArray<ReadOnlyOperationDefinition> = [
  {
    id: "feed",
    summary: "Load the LinkedIn feed and verify the main feed surface.",
    url: "https://www.linkedin.com/feed/",
    expectedPath: /^\/feed\//u,
    selectors: [
      {
        key: "feed_surface",
        description: "Feed content surface",
        candidates: [
          { key: "feed-update-card", selector: "div.feed-shared-update-v2" },
          { key: "feed-data-urn", selector: "main [data-urn]" },
          { key: "feed-main", selector: "main[role='main']" }
        ]
      },
      {
        key: "global_nav",
        description: "Authenticated global navigation",
        candidates: [
          { key: "global-nav", selector: "nav.global-nav" },
          { key: "header-nav", selector: "header nav" },
          { key: "global-nav-link", selector: "a[href='/feed/']" }
        ]
      }
    ]
  },
  {
    id: "profile",
    summary: "Open the signed-in profile and verify the header selectors.",
    url: "https://www.linkedin.com/in/me/",
    expectedPath: /^\/in\//u,
    selectors: [
      {
        key: "profile_header",
        description: "Profile headline card",
        candidates: [
          { key: "profile-h1", selector: "main h1" },
          { key: "profile-heading", selector: "h1.text-heading-xlarge" },
          { key: "profile-card", selector: "main section.artdeco-card" }
        ]
      },
      {
        key: "profile_main",
        description: "Profile main content area",
        candidates: [
          { key: "profile-main", selector: "main" },
          { key: "profile-top-card", selector: "section.artdeco-card" },
          { key: "profile-about", selector: "#about" }
        ]
      }
    ]
  },
  {
    id: "notifications",
    summary: "Open notifications and verify the notifications surface.",
    url: "https://www.linkedin.com/notifications/",
    expectedPath: /^\/notifications\//u,
    selectors: [
      {
        key: "notification_surface",
        description: "Notifications list or container",
        candidates: [
          { key: "notification-list", selector: "main ul[role='list']" },
          { key: "notification-card", selector: "main li.notification-card" },
          { key: "notification-main", selector: "main" }
        ]
      },
      {
        key: "notification_link",
        description: "Notification entry link",
        candidates: [
          { key: "notification-anchor", selector: "a[href*='/notifications/']" },
          { key: "notification-update-link", selector: "a[href*='/feed/update/']" },
          { key: "notification-list-item", selector: "main li" }
        ]
      }
    ]
  },
  {
    id: "connections",
    summary: "Open connections and verify the connections list surface.",
    url: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
    expectedPath: /^\/mynetwork\/invite-connect\/connections\//u,
    selectors: [
      {
        key: "connections_surface",
        description: "Connections list or container",
        candidates: [
          { key: "connections-list", selector: "main ul[role='list']" },
          { key: "connection-card", selector: "main li.mn-connection-card" },
          { key: "connections-main", selector: "main" }
        ]
      },
      {
        key: "connection_entry",
        description: "Connection profile entry",
        candidates: [
          { key: "connection-profile-link", selector: "main a[href*='/in/']" },
          { key: "connection-name", selector: "main span.mn-connection-card__name" },
          { key: "connection-list-item", selector: "main li" }
        ]
      }
    ]
  }
];

const INBOX_OPERATION: ReadOnlyOperationDefinition = {
  id: "inbox",
  summary: "Open messaging and verify the inbox plus one readable thread when available.",
  url: "https://www.linkedin.com/messaging/",
  expectedPath: /^\/messaging\//u,
  selectors: [
    {
      key: "conversation_list",
      description: "Conversation list surface",
      candidates: [
        {
          key: "conversation-list",
          selector: ".msg-conversations-container__conversations-list"
        },
        { key: "conversation-thread-link", selector: "a[href*='/messaging/thread/']" },
        { key: "messaging-main", selector: "main" }
      ]
    },
    {
      key: "message_thread",
      description: "Readable message thread",
      candidates: [
        { key: "message-event", selector: "li.msg-s-message-list__event" },
        {
          key: "message-list-container",
          selector: ".msg-s-message-list-container"
        },
        { key: "message-group", selector: ".msg-s-message-group__messages" }
      ]
    }
  ]
};

function withPlaywrightInstallHint(error: unknown): Error {
  if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
    return new Error(
      'Playwright browser executable is missing. Install Chromium with "npx playwright install chromium" or set PLAYWRIGHT_EXECUTABLE_PATH.'
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isFinitePositiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function resolvePositiveInt(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (!isFinitePositiveNumber(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive number.`
    );
  }

  return Math.floor(value);
}

function resolveLatestReportPath(paths: ConfigPaths): string {
  return path.join(paths.artifactsDir, READ_ONLY_REPORT_DIR, READ_ONLY_LATEST_REPORT_NAME);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    return null;
  }
}

function isAllowedLinkedInHost(hostname: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  return ALLOWED_LINKEDIN_HOST_SUFFIXES.some(
    (suffix) =>
      normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)
  );
}

export function isAllowedLinkedInReadOnlyRequest(
  urlString: string,
  method: string
): boolean {
  if (method.trim().toUpperCase() !== "GET") {
    return false;
  }

  try {
    const parsedUrl = new URL(urlString);
    if (!/^https?:$/u.test(parsedUrl.protocol)) {
      return true;
    }

    return isAllowedLinkedInHost(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function getOperationDefinition(
  operationId: LinkedInReadOnlyValidationOperationId
): ReadOnlyOperationDefinition {
  if (operationId === "inbox") {
    return INBOX_OPERATION;
  }

  const definition = READ_ONLY_OPERATION_REGISTRY.find(
    (candidate) => candidate.id === operationId
  );

  if (!definition) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Unsupported read-only live validation operation: ${operationId}.`
    );
  }

  return definition;
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];
  if (existingPage) {
    return existingPage;
  }

  return context.newPage();
}

async function assertHealthyStoredSession(
  page: Page,
  sessionName: string,
  operationId: LinkedInReadOnlyValidationOperationId
): Promise<void> {
  const status = await inspectLinkedInSession(page);
  if (status.authenticated) {
    return;
  }

  const challengeDetected =
    status.currentUrl.includes("/checkpoint") || status.currentUrl.includes("/challenge");

  throw new LinkedInAssistantError(
    challengeDetected ? "CAPTCHA_OR_CHALLENGE" : "AUTH_REQUIRED",
    challengeDetected
      ? `Stored LinkedIn session "${sessionName}" triggered a challenge while running ${operationId}. Capture a fresh session with "owa auth:session --session ${sessionName}" and retry.`
      : `Stored LinkedIn session "${sessionName}" is missing or expired while running ${operationId}. Capture a fresh session with "owa auth:session --session ${sessionName}" and retry.`,
    {
      checked_at: status.checkedAt,
      current_url: status.currentUrl,
      operation: operationId,
      reason: status.reason,
      session_name: sessionName
    }
  );
}

function assertExpectedOperationUrl(
  currentUrl: string,
  definition: ReadOnlyOperationDefinition
): void {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(currentUrl);
  } catch (error) {
    throw new LinkedInAssistantError(
      "NETWORK_ERROR",
      `Unexpected redirect while running ${definition.id}: ${currentUrl}`,
      {
        current_url: currentUrl,
        operation: definition.id
      },
      {
        cause: error instanceof Error ? error : undefined
      }
    );
  }

  if (!isAllowedLinkedInHost(parsedUrl.hostname) || !definition.expectedPath.test(parsedUrl.pathname)) {
    throw new LinkedInAssistantError(
      "NETWORK_ERROR",
      `Unexpected redirect while running ${definition.id}. Expected a LinkedIn ${definition.id} page but reached ${currentUrl}.`,
      {
        current_url: currentUrl,
        expected_path: definition.expectedPath.source,
        operation: definition.id
      }
    );
  }
}

async function resolveSelectorResult(
  page: Page,
  selectorDefinition: ReadOnlySelectorDefinition,
  timeoutMs: number
): Promise<ReadOnlyValidationSelectorResult> {
  for (const [index, candidate] of selectorDefinition.candidates.entries()) {
    try {
      await page
        .locator(candidate.selector)
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });

      return {
        description: selectorDefinition.description,
        matched_candidate_key: candidate.key,
        matched_candidate_rank: index,
        matched_selector: candidate.selector,
        selector_key: selectorDefinition.key,
        status: "pass"
      };
    } catch {
      // Try the next selector candidate.
    }
  }

  return {
    description: selectorDefinition.description,
    error: `No selector candidate matched ${selectorDefinition.key}.`,
    matched_candidate_key: null,
    matched_candidate_rank: null,
    matched_selector: null,
    selector_key: selectorDefinition.key,
    status: "fail"
  };
}

async function resolveSelectorResults(
  page: Page,
  selectorDefinitions: readonly ReadOnlySelectorDefinition[],
  timeoutMs: number
): Promise<ReadOnlyValidationSelectorResult[]> {
  const results: ReadOnlyValidationSelectorResult[] = [];

  for (const selectorDefinition of selectorDefinitions) {
    results.push(await resolveSelectorResult(page, selectorDefinition, timeoutMs));
  }

  return results;
}

function buildBlockedRequest(
  request: Request,
  reason: ReadOnlyValidationBlockedRequest["reason"]
): ReadOnlyValidationBlockedRequest {
  return {
    blocked_at: new Date().toISOString(),
    method: request.method(),
    reason,
    resource_type: request.resourceType(),
    url: request.url()
  };
}

async function installReadOnlyNetworkGuard(
  context: BrowserContext,
  blockedRequests: ReadOnlyValidationBlockedRequest[]
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();

    if (isAllowedLinkedInReadOnlyRequest(url, method)) {
      await route.continue();
      return;
    }

    blockedRequests.push(
      buildBlockedRequest(
        request,
        method.trim().toUpperCase() !== "GET" ? "non_get" : "non_linkedin_domain"
      )
    );
    await route.abort();
  });
}

export class ReadOnlyOperationRateLimiter {
  private lastRequestAtMs: number | null = null;

  private requestCount = 0;

  constructor(
    private readonly maxRequests: number = DEFAULT_MAX_REQUESTS,
    private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (delayMs: number) => Promise<void> = async (
      delayMs
    ) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  ) {
    if (!isFinitePositiveNumber(maxRequests)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "maxRequests must be a positive number."
      );
    }

    if (!isFinitePositiveNumber(minIntervalMs)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "minIntervalMs must be a positive number."
      );
    }
  }

  async waitTurn(operationId: LinkedInReadOnlyValidationOperationId): Promise<void> {
    if (this.requestCount >= this.maxRequests) {
      throw new LinkedInAssistantError(
        "RATE_LIMITED",
        `Read-only live validation reached the per-session request cap (${this.maxRequests}) before ${operationId}.`,
        {
          max_requests: this.maxRequests,
          operation: operationId,
          used_requests: this.requestCount
        }
      );
    }

    const currentTimeMs = this.now();
    if (this.lastRequestAtMs !== null) {
      const elapsedMs = currentTimeMs - this.lastRequestAtMs;
      const remainingDelayMs = this.minIntervalMs - elapsedMs;
      if (remainingDelayMs > 0) {
        await this.sleep(remainingDelayMs);
      }
    }

    this.lastRequestAtMs = this.now();
    this.requestCount += 1;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  hasReachedLimit(): boolean {
    return this.requestCount >= this.maxRequests;
  }
}

function summarizeReport(
  operations: readonly ReadOnlyValidationOperationResult[],
  diff: ReadOnlyValidationDiff
): string {
  const passCount = operations.filter((operation) => operation.status === "pass").length;
  const failCount = operations.length - passCount;
  const regressionSuffix = diff.regressions.length > 0
    ? ` ${diff.regressions.length} selector regression${diff.regressions.length === 1 ? "" : "s"} detected versus the previous run.`
    : "";

  return `Checked ${operations.length} read-only LinkedIn operation${operations.length === 1 ? "" : "s"}. ${passCount} passed. ${failCount} failed.${regressionSuffix}`;
}

function buildRecommendedActions(
  sessionName: string,
  reportPath: string,
  diff: ReadOnlyValidationDiff,
  operations: readonly ReadOnlyValidationOperationResult[]
): string[] {
  const actions = [
    `Open ${reportPath} to review selector matches, failures, timings, and blocked requests.`
  ];

  if (operations.some((operation) => operation.status === "fail")) {
    actions.push(
      `Capture a fresh session with "owa auth:session --session ${sessionName}" if the report shows login or challenge redirects.`
    );
    actions.push(
      "Review failed selector groups and update the read-only validation selectors if LinkedIn changed the UI."
    );
  }

  if (diff.regressions.length > 0 && diff.previous_report_path) {
    actions.push(
      `Compare this run with ${diff.previous_report_path} to confirm whether the regression is a real UI change or environment-specific drift.`
    );
  }

  return actions;
}

function buildSelectorIndex(
  report: Pick<ReadOnlyValidationReport, "operations">
): Map<
  string,
  {
    matchedCandidateKey: string | null;
    matchedCandidateRank: number | null;
    status: ReadOnlyValidationStatus;
  }
> {
  const index = new Map<
    string,
    {
      matchedCandidateKey: string | null;
      matchedCandidateRank: number | null;
      status: ReadOnlyValidationStatus;
    }
  >();

  for (const operation of report.operations) {
    for (const selectorResult of operation.selector_results) {
      index.set(`${operation.operation}:${selectorResult.selector_key}`, {
        matchedCandidateKey: selectorResult.matched_candidate_key,
        matchedCandidateRank: selectorResult.matched_candidate_rank,
        status: selectorResult.status
      });
    }
  }

  return index;
}

function isReadOnlyValidationReport(value: unknown): value is ReadOnlyValidationReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "operations" in value &&
    Array.isArray((value as { operations: unknown }).operations)
  );
}

export function computeReadOnlyValidationDiff(
  currentReport: Pick<ReadOnlyValidationReport, "operations">,
  previousReport:
    | Pick<ReadOnlyValidationReport, "operations" | "report_path">
    | null
): ReadOnlyValidationDiff {
  if (!previousReport) {
    return {
      recoveries: [],
      regressions: [],
      unchanged_count: currentReport.operations.reduce(
        (total, operation) => total + operation.selector_results.length,
        0
      )
    };
  }

  const previousIndex = buildSelectorIndex(previousReport);
  const regressions: ReadOnlyValidationDiffEntry[] = [];
  const recoveries: ReadOnlyValidationDiffEntry[] = [];
  let unchangedCount = 0;

  for (const operation of currentReport.operations) {
    for (const selectorResult of operation.selector_results) {
      const entryKey = `${operation.operation}:${selectorResult.selector_key}`;
      const previousEntry = previousIndex.get(entryKey);
      if (!previousEntry) {
        unchangedCount += 1;
        continue;
      }

      if (previousEntry.status === selectorResult.status) {
        if (
          previousEntry.status === "pass" &&
          selectorResult.status === "pass" &&
          previousEntry.matchedCandidateRank !== null &&
          selectorResult.matched_candidate_rank !== null &&
          selectorResult.matched_candidate_rank > previousEntry.matchedCandidateRank
        ) {
          regressions.push({
            change: "fallback_drift",
            current_candidate_key: selectorResult.matched_candidate_key,
            current_status: selectorResult.status,
            operation: operation.operation,
            previous_candidate_key: previousEntry.matchedCandidateKey,
            previous_status: previousEntry.status,
            selector_key: selectorResult.selector_key
          });
          continue;
        }

        unchangedCount += 1;
        continue;
      }

      if (previousEntry.status === "pass" && selectorResult.status === "fail") {
        regressions.push({
          change: "new_failure",
          current_candidate_key: selectorResult.matched_candidate_key,
          current_status: selectorResult.status,
          operation: operation.operation,
          previous_candidate_key: previousEntry.matchedCandidateKey,
          previous_status: previousEntry.status,
          selector_key: selectorResult.selector_key
        });
        continue;
      }

      recoveries.push({
        change: "recovered",
        current_candidate_key: selectorResult.matched_candidate_key,
        current_status: selectorResult.status,
        operation: operation.operation,
        previous_candidate_key: previousEntry.matchedCandidateKey,
        previous_status: previousEntry.status,
        selector_key: selectorResult.selector_key
      });
    }
  }

  return {
    previous_report_path: previousReport.report_path,
    recoveries,
    regressions,
    unchanged_count: unchangedCount
  };
}

async function runGenericOperation(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number
): Promise<ReadOnlyOperationExecutionResult> {
  await page.goto(definition.url, {
    timeout: timeoutMs,
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page, Math.min(timeoutMs, 5_000));
  await assertHealthyStoredSession(page, sessionName, definition.id);
  assertExpectedOperationUrl(page.url(), definition);

  return {
    additionalWarnings: [],
    finalUrl: page.url(),
    selectorResults: await resolveSelectorResults(
      page,
      definition.selectors,
      Math.min(timeoutMs, 5_000)
    )
  };
}

async function clickFirstVisibleThreadLink(page: Page, timeoutMs: number): Promise<boolean> {
  const threadLinkSelectors = [
    "a[href*='/messaging/thread/']",
    "a[href*='/messaging/detail/']"
  ];

  for (const selector of threadLinkSelectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      await locator.click({ timeout: timeoutMs });
      return true;
    } catch {
      // Try the next selector.
    }
  }

  return false;
}

async function runInboxOperation(
  page: Page,
  sessionName: string,
  timeoutMs: number
): Promise<ReadOnlyOperationExecutionResult> {
  await page.goto(INBOX_OPERATION.url, {
    timeout: timeoutMs,
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page, Math.min(timeoutMs, 5_000));
  await assertHealthyStoredSession(page, sessionName, INBOX_OPERATION.id);
  assertExpectedOperationUrl(page.url(), INBOX_OPERATION);

  const conversationSelectorDefinition = INBOX_OPERATION.selectors[0];
  const messageSelectorDefinition = INBOX_OPERATION.selectors[1];
  if (!conversationSelectorDefinition || !messageSelectorDefinition) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Inbox live validation is misconfigured because required selector groups are missing."
    );
  }

  const selectorTimeoutMs = Math.min(timeoutMs, 5_000);
  const conversationSelector = await resolveSelectorResult(
    page,
    conversationSelectorDefinition,
    selectorTimeoutMs
  );

  const warnings: string[] = [];
  const threadClicked = await clickFirstVisibleThreadLink(page, selectorTimeoutMs);
  let threadUrl: string | undefined;
  if (threadClicked) {
    await waitForNetworkIdleBestEffort(page, Math.min(timeoutMs, 5_000));
    await assertHealthyStoredSession(page, sessionName, INBOX_OPERATION.id);
    assertExpectedOperationUrl(page.url(), INBOX_OPERATION);
    threadUrl = page.url();
  } else {
    warnings.push(
      "No inbox thread was available to validate message-thread selectors; only the conversation list surface was checked."
    );
  }

  const messageSelector = threadClicked
    ? await resolveSelectorResult(page, messageSelectorDefinition, selectorTimeoutMs)
    : {
        description: messageSelectorDefinition.description,
        error: "No inbox thread was available to validate message-thread selectors.",
        matched_candidate_key: null,
        matched_candidate_rank: null,
        matched_selector: null,
        selector_key: messageSelectorDefinition.key,
        status: "fail" as const
      };

  return {
    additionalWarnings: warnings,
    finalUrl: page.url(),
    selectorResults: [conversationSelector, messageSelector],
    ...(threadUrl ? { threadUrl } : {})
  };
}

function createOperationResult(
  definition: ReadOnlyOperationDefinition,
  startedAt: string,
  completedAt: string,
  pageLoadMs: number,
  execution: ReadOnlyOperationExecutionResult
): ReadOnlyValidationOperationResult {
  const matchedCount = execution.selectorResults.filter(
    (result) => result.status === "pass"
  ).length;
  const failedCount = execution.selectorResults.length - matchedCount;

  return {
    completed_at: completedAt,
    failed_count: failedCount,
    final_url: execution.finalUrl,
    matched_count: matchedCount,
    operation: definition.id,
    page_load_ms: pageLoadMs,
    selector_results: execution.selectorResults,
    started_at: startedAt,
    status: failedCount > 0 ? "fail" : "pass",
    summary: definition.summary,
    ...(execution.threadUrl ? { thread_url: execution.threadUrl } : {}),
    url: definition.url,
    warnings: execution.additionalWarnings
  };
}

async function runOperation(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number
): Promise<ReadOnlyValidationOperationResult> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  const execution = definition.id === "inbox"
    ? await runInboxOperation(page, sessionName, timeoutMs)
    : await runGenericOperation(page, definition, sessionName, timeoutMs);

  return createOperationResult(
    definition,
    startedAt,
    new Date().toISOString(),
    Date.now() - startedAtMs,
    execution
  );
}

async function createBrowserContext(
  loadedSession: LoadStoredLinkedInSessionResult,
  timeoutMs: number,
  blockedRequests: ReadOnlyValidationBlockedRequest[]
): Promise<{ browser: Browser; context: BrowserContext }> {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const context = await browser.newContext({
    storageState: loadedSession.storageState
  });
  context.setDefaultNavigationTimeout(timeoutMs);
  context.setDefaultTimeout(timeoutMs);
  await installReadOnlyNetworkGuard(context, blockedRequests);

  return { browser, context };
}

export async function runReadOnlyLinkedInLiveValidation(
  options: RunReadOnlyValidationOptions = {}
): Promise<ReadOnlyValidationReport> {
  const sessionName = (options.sessionName ?? "default").trim() || "default";
  const timeoutMs = resolvePositiveInt(
    options.timeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    "timeoutMs"
  );
  const maxRequests = resolvePositiveInt(
    options.maxRequests,
    DEFAULT_MAX_REQUESTS,
    "maxRequests"
  );
  const minIntervalMs = resolvePositiveInt(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "minIntervalMs"
  );

  const store = new LinkedInSessionStore(options.baseDir);
  const loadedSession = await store.load(sessionName);

  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);

  const runId = createRunId();
  const logger = new JsonEventLogger(paths, runId);
  const artifacts = new ArtifactHelpers(paths, runId);
  const reportPath = artifacts.resolve(`${READ_ONLY_REPORT_DIR}/report.json`);
  const latestReportPath = resolveLatestReportPath(paths);
  const previousReportValue = await readJsonFile<unknown>(latestReportPath);
  const previousReport = isReadOnlyValidationReport(previousReportValue)
    ? previousReportValue
    : null;
  const blockedRequests: ReadOnlyValidationBlockedRequest[] = [];
  const rateLimiter = new ReadOnlyOperationRateLimiter(
    maxRequests,
    minIntervalMs
  );

  logger.log("info", "live_validation.start", {
    max_requests: maxRequests,
    min_interval_ms: minIntervalMs,
    report_path: reportPath,
    session_name: sessionName,
    timeout_ms: timeoutMs
  });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const browserContext = await createBrowserContext(
      loadedSession,
      timeoutMs,
      blockedRequests
    );
    browser = browserContext.browser;
    context = browserContext.context;

    const page = await getOrCreatePage(context);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);

    const operationResults: ReadOnlyValidationOperationResult[] = [];
    for (const operation of LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS) {
      if (options.onBeforeOperation) {
        await options.onBeforeOperation(operation);
      }

      logger.log("info", "live_validation.operation.start", {
        operation: operation.id,
        session_name: sessionName
      });
      await rateLimiter.waitTurn(operation.id);

      const operationDefinition = getOperationDefinition(operation.id);
      const operationResult = await runOperation(
        page,
        operationDefinition,
        sessionName,
        timeoutMs
      );
      operationResults.push(operationResult);

      logger.log("info", "live_validation.operation.done", {
        failed_count: operationResult.failed_count,
        matched_count: operationResult.matched_count,
        operation: operation.id,
        page_load_ms: operationResult.page_load_ms,
        status: operationResult.status,
        warnings: operationResult.warnings
      });
    }

    const diff = computeReadOnlyValidationDiff({ operations: operationResults }, previousReport);
    const failCount = operationResults.filter(
      (operation) => operation.status === "fail"
    ).length;
    const passCount = operationResults.length - failCount;
    const report: ReadOnlyValidationReport = {
      blocked_request_count: blockedRequests.length,
      blocked_requests: blockedRequests,
      checked_at: new Date().toISOString(),
      diff,
      events_path: logger.getEventsPath(),
      fail_count: failCount,
      latest_report_path: latestReportPath,
      operation_count: operationResults.length,
      operations: operationResults,
      outcome: failCount > 0 ? "fail" : "pass",
      pass_count: passCount,
      ...(diff.previous_report_path
        ? { previous_report_path: diff.previous_report_path }
        : {}),
      recommended_actions: [],
      report_path: reportPath,
      request_limits: {
        max_requests: maxRequests,
        max_requests_reached: rateLimiter.hasReachedLimit(),
        min_interval_ms: minIntervalMs,
        used_requests: rateLimiter.getRequestCount()
      },
      run_id: runId,
      session: {
        captured_at: loadedSession.metadata.capturedAt,
        file_path: loadedSession.metadata.filePath,
        li_at_expires_at: loadedSession.metadata.liAtCookieExpiresAt,
        session_name: loadedSession.metadata.sessionName
      },
      summary: summarizeReport(operationResults, diff)
    };

    report.recommended_actions = buildRecommendedActions(
      sessionName,
      reportPath,
      diff,
      operationResults
    );

    artifacts.writeJson(`${READ_ONLY_REPORT_DIR}/report.json`, report, {
      blocked_request_count: report.blocked_request_count,
      fail_count: report.fail_count,
      pass_count: report.pass_count,
      session_name: sessionName
    });
    await writeJsonFile(latestReportPath, report);

    logger.log("info", "live_validation.done", {
      blocked_request_count: report.blocked_request_count,
      fail_count: report.fail_count,
      pass_count: report.pass_count,
      report_path: report.report_path,
      session_name: sessionName
    });

    return report;
  } catch (error) {
    logger.log("error", "live_validation.failed", {
      error: asLinkedInAssistantError(error).message,
      session_name: sessionName
    });
    throw asLinkedInAssistantError(
      withPlaywrightInstallHint(error),
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      "Failed to run the read-only LinkedIn live validation."
    );
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
