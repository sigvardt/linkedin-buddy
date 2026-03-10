import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  errors as playwrightErrors,
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
import {
  LinkedInBuddyError,
  asLinkedInBuddyError,
  type LinkedInBuddyErrorCode
} from "./errors.js";
import { JsonEventLogger, type JsonLogEntry } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import { createRunId } from "./run.js";
import {
  LinkedInSessionStore,
  type LoadStoredLinkedInSessionResult
} from "./auth/sessionStore.js";
import { inspectLinkedInSession } from "./auth/sessionInspection.js";

/**
 * Fixed Tier 2 live validation operations executed by the CLI and Core API.
 *
 * The run always walks this list in order so report diffs stay comparable from
 * one execution to the next.
 */
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

/**
 * Descriptor for one built-in read-only live validation operation.
 */
export type LinkedInReadOnlyValidationOperation =
  (typeof LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS)[number];

/**
 * Stable identifier for a built-in read-only live validation operation.
 */
export type LinkedInReadOnlyValidationOperationId =
  LinkedInReadOnlyValidationOperation["id"];

/**
 * Top-level pass/fail status used by selector, operation, and report results.
 */
export type ReadOnlyValidationStatus = "pass" | "fail";

/**
 * Diff category emitted when the current run is compared against the rolling
 * `latest-report.json` snapshot.
 */
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

/**
 * Selector-level outcome recorded for one validation step.
 */
export interface ReadOnlyValidationSelectorResult {
  description: string;
  error?: string;
  matched_candidate_key: string | null;
  matched_candidate_rank: number | null;
  matched_selector: string | null;
  selector_key: string;
  status: ReadOnlyValidationStatus;
}

/**
 * Aggregated result for one page-level live validation operation.
 */
export interface ReadOnlyValidationOperationResult {
  attempt_count: number;
  completed_at: string;
  error_code?: LinkedInBuddyErrorCode;
  error_message?: string;
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

/**
 * Selector diff entry comparing the current run against the previous snapshot.
 */
export interface ReadOnlyValidationDiffEntry {
  change: ReadOnlyValidationDiffChange;
  current_candidate_key: string | null;
  current_status: ReadOnlyValidationStatus;
  operation: LinkedInReadOnlyValidationOperationId;
  previous_candidate_key: string | null;
  previous_status: ReadOnlyValidationStatus;
  selector_key: string;
}

/**
 * Regression and recovery summary for the current run.
 */
export interface ReadOnlyValidationDiff {
  previous_report_path?: string;
  recoveries: ReadOnlyValidationDiffEntry[];
  regressions: ReadOnlyValidationDiffEntry[];
  unchanged_count: number;
}

/**
 * Network request blocked by the read-only guard during the run.
 */
export interface ReadOnlyValidationBlockedRequest {
  blocked_at: string;
  method: string;
  reason: "non_get" | "non_linkedin_domain";
  resource_type: string;
  url: string;
}

/**
 * Full structured report returned by the Tier 2 live validation pipeline.
 */
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

/**
 * Optional overrides and hooks for `runReadOnlyLinkedInLiveValidation()`.
 */
export interface RunReadOnlyValidationOptions {
  /** Override the assistant home used for stored sessions, artifacts, and logs. */
  baseDir?: string;

  /** Maximum live requests allowed across the run, including retries. */
  maxRequests?: number;

  /** Maximum transient retries allowed per operation. */
  maxRetries?: number;

  /** Minimum delay enforced between live requests. */
  minIntervalMs?: number;

  /** Called before each operation so the CLI can prompt or pause the run. */
  onBeforeOperation?: (
    operation: LinkedInReadOnlyValidationOperation
  ) => Promise<void>;

  /** Receives structured log events as the run progresses. */
  onLog?: (entry: JsonLogEntry) => void;

  /** Initial exponential-backoff delay for transient retries. */
  retryBaseDelayMs?: number;

  /** Maximum exponential-backoff delay for transient retries. */
  retryMaxDelayMs?: number;

  /** Stored session name previously captured with `linkedin auth session`. */
  sessionName?: string;

  /** Navigation and selector timeout applied to each operation. */
  timeoutMs?: number;
}

type ReadOnlyValidationLogger = Pick<JsonEventLogger, "getEventsPath"> & {
  log: (...args: Parameters<JsonEventLogger["log"]>) => JsonLogEntry;
};

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
const READ_ONLY_DOM_SETTLE_TIMEOUT_MS = 5_000;
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

const READ_ONLY_OPERATION_MAP = new Map<
  LinkedInReadOnlyValidationOperationId,
  ReadOnlyOperationDefinition
>([...READ_ONLY_OPERATION_REGISTRY, INBOX_OPERATION].map((definition) => [definition.id, definition]));

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

function sanitizeUserFacingText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeUserFacingText(error.message);
  }

  return sanitizeUserFacingText(String(error));
}

function createErrorOptions(error: unknown): ErrorOptions | undefined {
  if (error instanceof Error) {
    return { cause: error };
  }

  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof playwrightErrors.TimeoutError;
}

function isNetworkError(error: unknown): boolean {
  return /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|disconnected)/iu.test(
    getErrorMessage(error)
  );
}

function isFinitePositiveNumber(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
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
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer.`
    );
  }

  return value;
}

function resolveNonNegativeInt(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (typeof value === "undefined") {
    return fallback;
  }

  if (!isFiniteNonNegativeNumber(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-negative integer.`
    );
  }

  return value;
}

function validateSessionName(sessionName: string | undefined): string {
  const normalized = (sessionName ?? "default").trim();
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "sessionName must not be empty."
    );
  }

  if (normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "sessionName must not contain path separators or relative path segments.",
      {
        session_name: normalized
      }
    );
  }

  return normalized;
}

function validateRunReadOnlyValidationOptions(
  options: RunReadOnlyValidationOptions | undefined
): RunReadOnlyValidationOptions {
  if (typeof options === "undefined") {
    return {};
  }

  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "read-only live validation options must be an object.",
      {
        received_type: Array.isArray(options) ? "array" : typeof options
      }
    );
  }

  if (
    typeof options.onBeforeOperation !== "undefined" &&
    typeof options.onBeforeOperation !== "function"
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "onBeforeOperation must be a function when provided."
    );
  }

  if (typeof options.onLog !== "undefined" && typeof options.onLog !== "function") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "onLog must be a function when provided."
    );
  }

  if (typeof options.baseDir !== "undefined" && typeof options.baseDir !== "string") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "baseDir must be a string when provided."
    );
  }

  if (
    typeof options.sessionName !== "undefined" &&
    typeof options.sessionName !== "string"
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "sessionName must be a string when provided."
    );
  }

  return options;
}

function calculateRetryBackoffMs(
  attempt: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number
): number {
  return Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** Math.max(0, attempt - 1));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
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
  } catch {
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

/**
 * Returns whether the request is allowed through the Tier 2 read-only network
 * guard.
 *
 * Only `GET` requests to LinkedIn-owned hosts are allowed to continue.
 */
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
      return false;
    }

    return isAllowedLinkedInHost(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function getOperationDefinition(
  operationId: LinkedInReadOnlyValidationOperationId
): ReadOnlyOperationDefinition {
  const definition = READ_ONLY_OPERATION_MAP.get(operationId);

  if (!definition) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Unsupported read-only live validation operation: ${operationId}.`
    );
  }

  return definition;
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];

  return existingPage ?? context.newPage();
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

  throw new LinkedInBuddyError(
    challengeDetected ? "CAPTCHA_OR_CHALLENGE" : "AUTH_REQUIRED",
    challengeDetected
      ? `Stored LinkedIn session "${sessionName}" triggered a challenge while running ${operationId}. Capture a fresh session with "buddy auth:session --session ${sessionName}" and retry.`
      : `Stored LinkedIn session "${sessionName}" is missing or expired while running ${operationId}. Capture a fresh session with "buddy auth:session --session ${sessionName}" and retry.`,
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
    throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
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

function getCurrentPageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

function readNavigationStatus(response: unknown): number | null {
  if (typeof response !== "object" || response === null || !("status" in response)) {
    return null;
  }

  const status = (response as { status?: unknown }).status;
  if (typeof status !== "function") {
    return null;
  }

  try {
    const value = status();
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function createNavigationStatusError(
  definition: ReadOnlyOperationDefinition,
  status: number,
  currentUrl: string
): LinkedInBuddyError {
  const details = {
    current_url: currentUrl,
    http_status: status,
    operation: definition.id
  };

  if (status === 401 || status === 403) {
    return new LinkedInBuddyError(
      "AUTH_REQUIRED",
      `LinkedIn rejected the stored session while loading ${definition.id}. Capture a fresh session and rerun the live validation.`,
      details
    );
  }

  if (status === 429 || status === 999) {
    return new LinkedInBuddyError(
      "RATE_LIMITED",
      `LinkedIn temporarily rate limited the ${definition.id} page (HTTP ${status}). Wait for the session to cool down, then rerun the live validation.`,
      details
    );
  }

  if (status >= 500) {
    return new LinkedInBuddyError(
      "NETWORK_ERROR",
      `LinkedIn returned HTTP ${status} while loading ${definition.id}. Check connectivity and rerun the live validation.`,
      details
    );
  }

  return new LinkedInBuddyError(
    "UNKNOWN",
    `LinkedIn returned HTTP ${status} while loading ${definition.id}. Refresh the session and rerun the live validation.`,
    details
  );
}

function createNetworkIdleWarning(
  definition: Pick<ReadOnlyOperationDefinition, "id">,
  timeoutMs: number
): string {
  return `The ${definition.id} page did not reach network idle within ${timeoutMs}ms. Selector checks continued with the current DOM state.`;
}

function normalizeOperationError(
  definition: ReadOnlyOperationDefinition,
  timeoutMs: number,
  currentUrl: string,
  error: unknown
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  const details = {
    current_url: currentUrl,
    operation: definition.id,
    page_url: definition.url
  };

  if (isTimeoutError(error)) {
    return new LinkedInBuddyError(
      "TIMEOUT",
      `Timed out after ${timeoutMs}ms while running ${definition.id}. LinkedIn may be slow or the page may be incomplete; rerun the live validation or increase the timeout.`,
      details,
      createErrorOptions(error)
    );
  }

  if (isNetworkError(error)) {
    return new LinkedInBuddyError(
      "NETWORK_ERROR",
      `Could not load the ${definition.id} page because the browser or network connection failed: ${getErrorMessage(error)}. Check connectivity and rerun the live validation.`,
      details,
      createErrorOptions(error)
    );
  }

  return new LinkedInBuddyError(
    "UNKNOWN",
    `Live validation failed while running ${definition.id}: ${getErrorMessage(error)}. Refresh the stored session or rerun the live validation.`,
    details,
    createErrorOptions(error)
  );
}

function isRetryableOperationError(code: LinkedInBuddyErrorCode): boolean {
  return code === "NETWORK_ERROR" || code === "TIMEOUT";
}

function isBlockingOperationErrorCode(code: LinkedInBuddyErrorCode): boolean {
  return code === "AUTH_REQUIRED" || code === "CAPTCHA_OR_CHALLENGE" || code === "RATE_LIMITED";
}

function getOperationAttemptCount(error: LinkedInBuddyError): number {
  const attemptCount = error.details.attempt_count;
  return typeof attemptCount === "number" && Number.isInteger(attemptCount) && attemptCount > 0
    ? attemptCount
    : 1;
}

function buildRetryRecoveryWarning(attemptCount: number): string | null {
  if (attemptCount <= 1) {
    return null;
  }

  const retryCount = attemptCount - 1;
  return `Recovered after ${retryCount} transient retr${retryCount === 1 ? "y" : "ies"}.`;
}

function buildRetryExhaustedWarning(attemptCount: number): string | null {
  if (attemptCount <= 1) {
    return null;
  }

  const retryCount = attemptCount - 1;
  return `Retried ${retryCount} ${retryCount === 1 ? "time" : "times"} before the page still failed.`;
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

  return createFailedSelectorResult(
    selectorDefinition,
    `No selector candidate matched ${selectorDefinition.key}.`
  );
}

async function resolveSelectorResults(
  page: Page,
  selectorDefinitions: readonly ReadOnlySelectorDefinition[],
  timeoutMs: number
): Promise<ReadOnlyValidationSelectorResult[]> {
  return Promise.all(
    selectorDefinitions.map((selectorDefinition) =>
      resolveSelectorResult(page, selectorDefinition, timeoutMs)
    )
  );
}

function createFailedSelectorResult(
  selectorDefinition: Pick<ReadOnlySelectorDefinition, "description" | "key">,
  error: string
): ReadOnlyValidationSelectorResult {
  return {
    description: selectorDefinition.description,
    error,
    matched_candidate_key: null,
    matched_candidate_rank: null,
    matched_selector: null,
    selector_key: selectorDefinition.key,
    status: "fail"
  };
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

/**
 * Enforces the per-run request cap and minimum interval between live requests.
 */
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
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "maxRequests must be a positive number."
      );
    }

    if (!isFinitePositiveNumber(minIntervalMs)) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "minIntervalMs must be a positive number."
      );
    }
  }

  /**
   * Waits until the next request slot is available or throws `RATE_LIMITED`
   * when the request budget has already been exhausted.
   */
  async waitTurn(operationId: LinkedInReadOnlyValidationOperationId): Promise<void> {
    if (this.requestCount >= this.maxRequests) {
      throw new LinkedInBuddyError(
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

  /**
   * Returns how many live requests have been consumed so far.
   */
  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Returns whether the configured request cap has been reached.
   */
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
  const incompleteCount =
    LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS.length - operations.length;
  const partialSuffix = incompleteCount > 0
    ? ` Validation stopped early; ${incompleteCount} operation${incompleteCount === 1 ? " did" : "s did"} not run after a blocking failure.`
    : "";

  return `Checked ${operations.length} read-only LinkedIn operation${operations.length === 1 ? "" : "s"}. ${passCount} passed. ${failCount} failed.${regressionSuffix}${partialSuffix}`;
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
  const blockingFailure = operations.find(
    (operation) => operation.error_code && isBlockingOperationErrorCode(operation.error_code)
  );

  if (operations.some((operation) => operation.status === "fail")) {
    actions.push(
      `Capture a fresh session with "buddy auth:session --session ${sessionName}" if the report shows login or challenge redirects.`
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

  if (blockingFailure?.error_code === "RATE_LIMITED") {
    actions.push(
      "Increase the request budget or rerun with a longer interval between checks if the read-only validation keeps hitting LinkedIn rate limits."
    );
  }

  if (blockingFailure) {
    actions.push(
      `Validation stopped early at ${blockingFailure.operation} [${blockingFailure.error_code}]. Address the blocking failure, then rerun the remaining checks.`
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
      index.set(
        getSelectorResultKey(operation.operation, selectorResult.selector_key),
        {
          matchedCandidateKey: selectorResult.matched_candidate_key,
          matchedCandidateRank: selectorResult.matched_candidate_rank,
          status: selectorResult.status
        }
      );
    }
  }

  return index;
}

function getSelectorResultKey(
  operationId: LinkedInReadOnlyValidationOperationId,
  selectorKey: string
): string {
  return `${operationId}:${selectorKey}`;
}

function isReadOnlyValidationReport(value: unknown): value is ReadOnlyValidationReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "operations" in value &&
    Array.isArray((value as { operations: unknown }).operations)
  );
}

/**
 * Compares the current run with the previous rolling snapshot and classifies
 * selector regressions, recoveries, and unchanged results.
 */
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
      const entryKey = getSelectorResultKey(
        operation.operation,
        selectorResult.selector_key
      );
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

interface ReadOnlyRetriedOperationExecutionResult {
  attemptCount: number;
  execution: ReadOnlyOperationExecutionResult;
}

async function runGenericOperation(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number
): Promise<ReadOnlyOperationExecutionResult> {
  const selectorTimeoutMs = Math.min(timeoutMs, READ_ONLY_DOM_SETTLE_TIMEOUT_MS);
  const warnings = await loadValidatedOperationPage(
    page,
    definition,
    sessionName,
    timeoutMs
  );

  return {
    additionalWarnings: warnings,
    finalUrl: page.url(),
    selectorResults: await resolveSelectorResults(page, definition.selectors, selectorTimeoutMs)
  };
}

async function loadValidatedOperationPage(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number
): Promise<string[]> {
  const warnings: string[] = [];
  const response = await page.goto(definition.url, {
    timeout: timeoutMs,
    waitUntil: "domcontentloaded"
  });
  const responseStatus = readNavigationStatus(response);
  if (responseStatus !== null && responseStatus >= 400) {
    throw createNavigationStatusError(
      definition,
      responseStatus,
      getCurrentPageUrl(page)
    );
  }

  const networkIdleTimeoutMs = Math.min(timeoutMs, READ_ONLY_DOM_SETTLE_TIMEOUT_MS);
  const networkIdleReached = await waitForNetworkIdleBestEffort(page, networkIdleTimeoutMs);
  if (!networkIdleReached) {
    warnings.push(createNetworkIdleWarning(definition, networkIdleTimeoutMs));
  }

  await assertHealthyStoredSession(page, sessionName, definition.id);
  assertExpectedOperationUrl(page.url(), definition);
  return warnings;
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
  const warnings = await loadValidatedOperationPage(
    page,
    INBOX_OPERATION,
    sessionName,
    timeoutMs
  );

  const conversationSelectorDefinition = INBOX_OPERATION.selectors[0];
  const messageSelectorDefinition = INBOX_OPERATION.selectors[1];
  if (!conversationSelectorDefinition || !messageSelectorDefinition) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Inbox live validation is misconfigured because required selector groups are missing."
    );
  }

  const selectorTimeoutMs = Math.min(timeoutMs, READ_ONLY_DOM_SETTLE_TIMEOUT_MS);
  const conversationSelector = await resolveSelectorResult(
    page,
    conversationSelectorDefinition,
    selectorTimeoutMs
  );

  const threadClicked = await clickFirstVisibleThreadLink(page, selectorTimeoutMs);
  let threadUrl: string | undefined;
  if (threadClicked) {
    const threadNetworkIdleReached = await waitForNetworkIdleBestEffort(
      page,
      selectorTimeoutMs
    );
    if (!threadNetworkIdleReached) {
      warnings.push(createNetworkIdleWarning(INBOX_OPERATION, selectorTimeoutMs));
    }
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
    : createFailedSelectorResult(
        messageSelectorDefinition,
        "No inbox thread was available to validate message-thread selectors."
      );

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
  execution: ReadOnlyOperationExecutionResult,
  attemptCount: number
): ReadOnlyValidationOperationResult {
  const matchedCount = execution.selectorResults.filter(
    (result) => result.status === "pass"
  ).length;
  const failedCount = execution.selectorResults.length - matchedCount;
  const warnings = [...execution.additionalWarnings];
  const retryRecoveryWarning = buildRetryRecoveryWarning(attemptCount);
  if (retryRecoveryWarning) {
    warnings.unshift(retryRecoveryWarning);
  }

  return {
    attempt_count: attemptCount,
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
    warnings
  };
}

function createOperationFailureResult(
  definition: ReadOnlyOperationDefinition,
  startedAt: string,
  completedAt: string,
  pageLoadMs: number,
  finalUrl: string,
  error: LinkedInBuddyError,
  attemptCount: number
): ReadOnlyValidationOperationResult {
  const warnings: string[] = [];
  const retryWarning = buildRetryExhaustedWarning(attemptCount);
  if (retryWarning) {
    warnings.push(retryWarning);
  }

  return {
    attempt_count: attemptCount,
    completed_at: completedAt,
    error_code: error.code,
    error_message: error.message,
    failed_count: definition.selectors.length,
    final_url: finalUrl,
    matched_count: 0,
    operation: definition.id,
    page_load_ms: pageLoadMs,
    selector_results: definition.selectors.map((selectorDefinition) =>
      createFailedSelectorResult(selectorDefinition, error.message)
    ),
    started_at: startedAt,
    status: "fail",
    summary: definition.summary,
    url: definition.url,
    warnings
  };
}

async function runOperationOnce(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number
): Promise<ReadOnlyOperationExecutionResult> {
  return definition.id === "inbox"
    ? await runInboxOperation(page, sessionName, timeoutMs)
    : await runGenericOperation(page, definition, sessionName, timeoutMs);
}

async function runOperationWithRetries(
  page: Page,
  definition: ReadOnlyOperationDefinition,
  sessionName: string,
  timeoutMs: number,
  rateLimiter: ReadOnlyOperationRateLimiter,
  maxRetries: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
  logger: ReadOnlyValidationLogger
): Promise<ReadOnlyRetriedOperationExecutionResult> {
  const maxAttempts = maxRetries + 1;
  let lastError: LinkedInBuddyError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger.log("debug", "live_validation.operation.attempt", {
      attempt,
      max_attempts: maxAttempts,
      operation: definition.id,
      session_name: sessionName
    });

    try {
      await rateLimiter.waitTurn(definition.id);
      const execution = await runOperationOnce(page, definition, sessionName, timeoutMs);
      return {
        attemptCount: attempt,
        execution
      };
    } catch (error) {
      const normalizedError = normalizeOperationError(
        definition,
        timeoutMs,
        getCurrentPageUrl(page),
        error
      );
      lastError = new LinkedInBuddyError(
        normalizedError.code,
        normalizedError.message,
        {
          ...normalizedError.details,
          attempt_count: attempt
        },
        { cause: normalizedError }
      );

      if (!isRetryableOperationError(normalizedError.code) || attempt >= maxAttempts) {
        throw lastError;
      }

      const backoffMs = calculateRetryBackoffMs(
        attempt,
        retryBaseDelayMs,
        retryMaxDelayMs
      );
      logger.log("warn", "live_validation.operation.retry", {
        attempt,
        backoff_ms: backoffMs,
        code: normalizedError.code,
        error: normalizedError.message,
        max_attempts: maxAttempts,
        operation: definition.id,
        session_name: sessionName
      });
      await sleep(backoffMs);
    }
  }

  throw (
    lastError ??
    new LinkedInBuddyError(
      "UNKNOWN",
      `Read-only live validation exhausted retries for ${definition.id}.`,
      {
        operation: definition.id,
        session_name: sessionName
      }
    )
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

  try {
    const context = await browser.newContext({
      storageState: loadedSession.storageState
    });
    context.setDefaultNavigationTimeout(timeoutMs);
    context.setDefaultTimeout(timeoutMs);
    await installReadOnlyNetworkGuard(context, blockedRequests);

    return { browser, context };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Runs the Tier 2 read-only LinkedIn live validation workflow and returns the
 * structured report persisted under the current run artifact directory.
 *
 * The pipeline loads an encrypted stored session, installs a read-only network
 * guard, walks the fixed operation suite, compares the result against the
 * previous snapshot, and writes both the run-scoped report and the rolling
 * `latest-report.json` snapshot.
 */
export async function runReadOnlyLinkedInLiveValidation(
  options: RunReadOnlyValidationOptions = {}
): Promise<ReadOnlyValidationReport> {
  const validatedOptions = validateRunReadOnlyValidationOptions(options);
  const sessionName = validateSessionName(validatedOptions.sessionName);
  const timeoutMs = resolvePositiveInt(
    validatedOptions.timeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    "timeoutMs"
  );
  const maxRequests = resolvePositiveInt(
    validatedOptions.maxRequests,
    DEFAULT_MAX_REQUESTS,
    "maxRequests"
  );
  const minIntervalMs = resolvePositiveInt(
    validatedOptions.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "minIntervalMs"
  );
  const maxRetries = resolveNonNegativeInt(
    validatedOptions.maxRetries,
    DEFAULT_MAX_RETRIES,
    "maxRetries"
  );
  const retryBaseDelayMs = resolvePositiveInt(
    validatedOptions.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    "retryBaseDelayMs"
  );
  const retryMaxDelayMs = resolvePositiveInt(
    validatedOptions.retryMaxDelayMs,
    DEFAULT_RETRY_MAX_DELAY_MS,
    "retryMaxDelayMs"
  );
  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "retryMaxDelayMs must be greater than or equal to retryBaseDelayMs.",
      {
        retry_base_delay_ms: retryBaseDelayMs,
        retry_max_delay_ms: retryMaxDelayMs
      }
    );
  }

  const store = new LinkedInSessionStore(validatedOptions.baseDir);
  const loadedSession = await store.load(sessionName);

  const paths = resolveConfigPaths(validatedOptions.baseDir);
  ensureConfigPaths(paths);

  const runId = createRunId();
  const eventLogger = new JsonEventLogger(paths, runId);
  const logger: ReadOnlyValidationLogger = {
    getEventsPath() {
      return eventLogger.getEventsPath();
    },
    log(level, event, payload = {}) {
      const entry = eventLogger.log(level, event, payload);
      validatedOptions.onLog?.(entry);
      return entry;
    }
  };
  const artifacts = new ArtifactHelpers(paths, runId);
  const reportPath = artifacts.resolve(`${READ_ONLY_REPORT_DIR}/report.json`);
  const latestReportPath = resolveLatestReportPath(paths);
  const previousReportValue = await readJsonFile<unknown>(latestReportPath);
  const previousReport = isReadOnlyValidationReport(previousReportValue)
    ? previousReportValue
    : null;
  if (previousReportValue !== null && !previousReport) {
    logger.log("warn", "live_validation.previous_report.invalid", {
      latest_report_path: latestReportPath,
      session_name: sessionName
    });
  }
  const blockedRequests: ReadOnlyValidationBlockedRequest[] = [];
  const rateLimiter = new ReadOnlyOperationRateLimiter(
    maxRequests,
    minIntervalMs
  );

  logger.log("info", "live_validation.start", {
    max_requests: maxRequests,
    max_retries: maxRetries,
    min_interval_ms: minIntervalMs,
    report_path: reportPath,
    retry_base_delay_ms: retryBaseDelayMs,
    retry_max_delay_ms: retryMaxDelayMs,
    session_name: sessionName,
    timeout_ms: timeoutMs
  });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let cleanedUp = false;
  const cleanupResources = async (
    trigger: "finally" | "signal"
  ): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    logger.log("debug", "live_validation.cleanup.start", {
      trigger,
      session_name: sessionName
    });

    if (context) {
      try {
        await context.close();
      } catch (error) {
        logger.log("warn", "live_validation.cleanup.context_failed", {
          error: getErrorMessage(error),
          session_name: sessionName,
          trigger
        });
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        logger.log("warn", "live_validation.cleanup.browser_failed", {
          error: getErrorMessage(error),
          session_name: sessionName,
          trigger
        });
      }
    }
  };
  const installTerminationHandlers = (): (() => void) => {
    type ProcessSignal = "SIGINT" | "SIGTERM";

    const handlers = new Map<ProcessSignal, () => void>();
    const removeHandlers = (): void => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      handlers.clear();
    };
    const registerHandler = (signal: ProcessSignal): void => {
      const handler = () => {
        removeHandlers();
        logger.log("warn", "live_validation.signal", {
          session_name: sessionName,
          signal
        });
        void cleanupResources("signal").finally(() => {
          try {
            process.kill(process.pid, signal);
          } catch {
            process.exit(signal === "SIGINT" ? 130 : 143);
          }
        });
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    };

    registerHandler("SIGINT");
    registerHandler("SIGTERM");
    return removeHandlers;
  };
  let removeTerminationHandlers: (() => void) | undefined;
  try {
    const browserContext = await createBrowserContext(
      loadedSession,
      timeoutMs,
      blockedRequests
    );
    browser = browserContext.browser;
    context = browserContext.context;
    removeTerminationHandlers = installTerminationHandlers();

    const page = await getOrCreatePage(context);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);

    const operationResults: ReadOnlyValidationOperationResult[] = [];
    for (const operation of LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS) {
      if (validatedOptions.onBeforeOperation) {
        await validatedOptions.onBeforeOperation(operation);
      }

      logger.log("info", "live_validation.operation.start", {
        operation: operation.id,
        session_name: sessionName
      });

      const operationDefinition = getOperationDefinition(operation.id);
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();

      try {
        const operationExecution = await runOperationWithRetries(
          page,
          operationDefinition,
          sessionName,
          timeoutMs,
          rateLimiter,
          maxRetries,
          retryBaseDelayMs,
          retryMaxDelayMs,
          logger
        );
        const operationResult = createOperationResult(
          operationDefinition,
          startedAt,
          new Date().toISOString(),
          Date.now() - startedAtMs,
          operationExecution.execution,
          operationExecution.attemptCount
        );
        operationResults.push(operationResult);

        logger.log(
          operationResult.status === "fail" || operationResult.warnings.length > 0
            ? "warn"
            : "info",
          operationResult.status === "fail" || operationResult.warnings.length > 0
            ? "live_validation.operation.degraded"
            : "live_validation.operation.done",
          {
            attempt_count: operationResult.attempt_count,
            failed_count: operationResult.failed_count,
            matched_count: operationResult.matched_count,
            operation: operation.id,
            page_load_ms: operationResult.page_load_ms,
            status: operationResult.status,
            warnings: operationResult.warnings
          }
        );
      } catch (error) {
        const normalizedError = asLinkedInBuddyError(
          error,
          error instanceof LinkedInBuddyError ? error.code : "UNKNOWN",
          `Read-only live validation failed while running ${operation.id}.`
        );

        if (
          operationResults.length === 0 &&
          (normalizedError.code === "AUTH_REQUIRED" ||
            normalizedError.code === "CAPTCHA_OR_CHALLENGE")
        ) {
          throw normalizedError;
        }

        const operationResult = createOperationFailureResult(
          operationDefinition,
          startedAt,
          new Date().toISOString(),
          Date.now() - startedAtMs,
          getCurrentPageUrl(page),
          normalizedError,
          getOperationAttemptCount(normalizedError)
        );
        operationResults.push(operationResult);

        logger.log("error", "live_validation.operation.failed", {
          attempt_count: operationResult.attempt_count,
          code: normalizedError.code,
          error_details: normalizedError.details,
          error_message: normalizedError.message,
          operation: operation.id,
          page_load_ms: operationResult.page_load_ms,
          session_name: sessionName,
          warnings: operationResult.warnings
        });

        if (isBlockingOperationErrorCode(normalizedError.code)) {
          logger.log("warn", "live_validation.stopped_early", {
            code: normalizedError.code,
            completed_operations: operationResults.length,
            operation: operation.id,
            remaining_operations:
              LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS.length - operationResults.length,
            session_name: sessionName
          });
          break;
        }
      }
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

    try {
      artifacts.writeJson(`${READ_ONLY_REPORT_DIR}/report.json`, report, {
        blocked_request_count: report.blocked_request_count,
        fail_count: report.fail_count,
        pass_count: report.pass_count,
        session_name: sessionName
      });
    } catch (error) {
      logger.log("warn", "live_validation.report_persist.failed", {
        error: getErrorMessage(error),
        report_path: reportPath,
        session_name: sessionName
      });
      report.recommended_actions.push(
        `The report could not be written to ${reportPath}; use --json output or inspect ${report.events_path} for this run.`
      );
    }

    try {
      await writeJsonFile(latestReportPath, report);
    } catch (error) {
      logger.log("warn", "live_validation.latest_report_persist.failed", {
        error: getErrorMessage(error),
        latest_report_path: latestReportPath,
        session_name: sessionName
      });
      report.recommended_actions.push(
        `The rolling latest report at ${latestReportPath} was not updated, so the next diff may use an older snapshot.`
      );
    }

    logger.log("info", "live_validation.done", {
      blocked_request_count: report.blocked_request_count,
      fail_count: report.fail_count,
      pass_count: report.pass_count,
      report_path: report.report_path,
      session_name: sessionName
    });

    return report;
  } catch (error) {
    const normalizedError = asLinkedInBuddyError(
      withPlaywrightInstallHint(error),
      error instanceof LinkedInBuddyError ? error.code : "UNKNOWN",
      "Failed to run the read-only LinkedIn live validation."
    );
    logger.log("error", "live_validation.failed", {
      code: normalizedError.code,
      error_details: normalizedError.details,
      error_message: normalizedError.message,
      source_error_name: error instanceof Error ? error.name : typeof error,
      session_name: sessionName
    });
    throw normalizedError;
  } finally {
    removeTerminationHandlers?.();
    await cleanupResources("finally");
  }
}
