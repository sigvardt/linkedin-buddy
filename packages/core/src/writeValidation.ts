import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { errors as playwrightErrors } from "playwright-core";
import {
  ensureConfigPaths,
  resolveConfigPaths,
  type ConfigPaths
} from "./config.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError,
  type LinkedInAssistantErrorCode
} from "./errors.js";
import type { PreparedActionResult } from "./twoPhaseCommit.js";
import { resolveWriteValidationAccount } from "./writeValidationAccounts.js";
import type { WriteValidationProfileManager } from "./writeValidationRuntime.js";
import { createWriteValidationRuntime } from "./writeValidationRuntime.js";
import {
  LINKEDIN_WRITE_VALIDATION_ACTIONS,
  WRITE_VALIDATION_SCENARIOS
} from "./writeValidationScenarios.js";
import {
  DEFAULT_WRITE_VALIDATION_COOLDOWN_MS,
  DEFAULT_WRITE_VALIDATION_MAX_RETRIES,
  DEFAULT_WRITE_VALIDATION_RETRY_BASE_DELAY_MS,
  DEFAULT_WRITE_VALIDATION_RETRY_MAX_DELAY_MS,
  DEFAULT_WRITE_VALIDATION_TIMEOUT_MS,
  WRITE_VALIDATION_LATEST_REPORT_NAME,
  WRITE_VALIDATION_REPORT_DIR,
  WRITE_VALIDATION_WARNING,
  buildPreview,
  buildRecommendedActions,
  buildWriteValidationReportAccount,
  buildWriteValidationSummary,
  countActionStatuses,
  dedupeStrings,
  determineActionStatus,
  determineOutcome,
  isScreenshotPath,
  readPreviewArtifacts,
  writeJsonFile,
  type LinkedInWriteValidationActionDefinition,
  type RunLinkedInWriteValidationOptions,
  type WriteValidationActionPreview,
  type WriteValidationActionResult,
  type WriteValidationActionStage,
  type WriteValidationReport,
  type WriteValidationResultStatus,
  type WriteValidationScenarioDefinition,
  type WriteValidationVerificationResult
} from "./writeValidationShared.js";

export { LINKEDIN_WRITE_VALIDATION_ACTIONS } from "./writeValidationScenarios.js";
export type {
  LinkedInWriteValidationActionType,
  LinkedInWriteValidationActionDefinition,
  RunLinkedInWriteValidationOptions,
  WriteValidationActionPreview,
  WriteValidationActionResult,
  WriteValidationOutcome,
  WriteValidationReport,
  WriteValidationResultStatus,
  WriteValidationVerificationResult
} from "./writeValidationShared.js";

type WriteValidationRuntime =
  Awaited<ReturnType<typeof createWriteValidationRuntime>>["runtime"];
type WriteValidationLogger = WriteValidationRuntime["logger"];

interface PreparedArtifacts {
  beforeScreenshotPaths: string[];
  previewArtifacts: string[];
}

interface PartialActionContext {
  afterScreenshotPaths: string[];
  beforeScreenshotPaths: string[];
  cleanupGuidance: string[];
  confirmArtifacts: string[];
  linkedinResponse?: Record<string, unknown>;
  prepared?: PreparedActionResult;
  preparedArtifacts?: PreparedArtifacts;
  preview?: WriteValidationActionPreview;
  warnings: string[];
}

interface ScenarioExecutionResult {
  actionResult: WriteValidationActionResult;
  shouldStop: boolean;
}

interface StageRetryResult<T> {
  attemptCount: number;
  result: T;
}

interface WriteValidationRunLockState {
  account_id: string;
  cwd: string;
  pid: number;
  started_at: string;
}

interface WriteValidationRunLockHandle {
  lockPath: string;
  release: () => Promise<void>;
  state: WriteValidationRunLockState;
}

interface ValidatedWriteValidationOptions {
  accountId: string;
  baseDir?: string;
  cooldownMs: number;
  maxRetries: number;
  onBeforeAction?: RunLinkedInWriteValidationOptions["onBeforeAction"];
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  timeoutMs: number;
}

const WRITE_VALIDATION_ACTION_STAGES: readonly WriteValidationActionStage[] = [
  "prepare",
  "prompt",
  "before_screenshot",
  "confirm",
  "after_screenshot",
  "verify"
] as const;
const WRITE_VALIDATION_LOCK_NAME = "run.lock.json";

function isTruthyCiValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

function readPreparedArtifacts(prepared: PreparedActionResult): PreparedArtifacts {
  const previewArtifacts = dedupeStrings(readPreviewArtifacts(prepared.preview));

  return {
    previewArtifacts,
    beforeScreenshotPaths: previewArtifacts.filter(isScreenshotPath)
  };
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
  return error instanceof Error ? { cause: error } : undefined;
}

function isFinitePositiveInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeInteger(value: number): boolean {
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

  if (!isFinitePositiveInteger(value)) {
    throw new LinkedInAssistantError(
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

  if (!isFiniteNonNegativeInteger(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-negative integer.`
    );
  }

  return value;
}

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

function isTimeoutError(error: unknown): boolean {
  return error instanceof playwrightErrors.TimeoutError;
}

function isNetworkError(error: unknown): boolean {
  return /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|disconnected)/iu.test(
    getErrorMessage(error)
  );
}

function isRateLimitError(error: unknown): boolean {
  return /rate\s*limit|http\s*(429|999)\b|\b429\b|\b999\b/iu.test(
    getErrorMessage(error)
  );
}

function detectAuthErrorCode(message: string): LinkedInAssistantErrorCode | null {
  if (/checkpoint|challenge/iu.test(message)) {
    return "CAPTCHA_OR_CHALLENGE";
  }

  if (/auth|required|session expired|not authenticated|sign in|log in|login/iu.test(message)) {
    return "AUTH_REQUIRED";
  }

  return null;
}

function isWriteValidationActionStage(value: unknown): value is WriteValidationActionStage {
  return WRITE_VALIDATION_ACTION_STAGES.includes(value as WriteValidationActionStage);
}

function describeActionStage(stage: WriteValidationActionStage): string {
  switch (stage) {
    case "prepare":
      return "preparing the action";
    case "prompt":
      return "waiting for operator confirmation";
    case "before_screenshot":
      return "capturing the pre-action screenshot";
    case "confirm":
      return "executing the live action";
    case "after_screenshot":
      return "capturing the post-action screenshot";
    case "verify":
      return "verifying the LinkedIn outcome";
  }
}

function calculateRetryBackoffMs(
  attempt: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number
): number {
  return Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function getErrorAttemptCount(error: LinkedInAssistantError): number {
  const attemptCount = error.details.attempt_count;
  return typeof attemptCount === "number" && Number.isInteger(attemptCount) && attemptCount > 0
    ? attemptCount
    : 1;
}

function buildRetryRecoveryWarning(
  stage: WriteValidationActionStage,
  attemptCount: number
): string | null {
  if (attemptCount <= 1) {
    return null;
  }

  const retryCount = attemptCount - 1;
  return `Recovered after ${retryCount} transient retr${retryCount === 1 ? "y" : "ies"} while ${describeActionStage(stage)}.`;
}

function buildRetryExhaustedWarning(
  stage: WriteValidationActionStage,
  attemptCount: number
): string | null {
  if (attemptCount <= 1) {
    return null;
  }

  const retryCount = attemptCount - 1;
  return `Retried ${retryCount} ${retryCount === 1 ? "time" : "times"} before ${describeActionStage(stage)} still failed.`;
}

function isRetryableWriteValidationError(code: LinkedInAssistantErrorCode): boolean {
  return code === "NETWORK_ERROR" || code === "TIMEOUT";
}

function isBlockingWriteValidationErrorCode(code: LinkedInAssistantErrorCode): boolean {
  return code === "AUTH_REQUIRED" || code === "CAPTCHA_OR_CHALLENGE" || code === "RATE_LIMITED";
}

function normalizeWriteValidationError(input: {
  accountId: string;
  actionType: WriteValidationActionResult["action_type"];
  error: unknown;
  expectedOutcome: string;
  sessionName: string;
  stage: WriteValidationActionStage;
}): LinkedInAssistantError {
  const details = {
    account_id: input.accountId,
    action_type: input.actionType,
    expected_outcome: input.expectedOutcome,
    session_name: input.sessionName,
    stage: input.stage
  };

  if (input.error instanceof LinkedInAssistantError) {
    return new LinkedInAssistantError(
      input.error.code,
      input.error.message,
      {
        ...input.error.details,
        ...details
      },
      { cause: input.error }
    );
  }

  const rawMessage = getErrorMessage(input.error);
  const authCode = detectAuthErrorCode(rawMessage);
  if (authCode) {
    return new LinkedInAssistantError(
      authCode,
      authCode === "CAPTCHA_OR_CHALLENGE"
        ? `Stored session "${input.sessionName}" triggered a LinkedIn challenge while ${describeActionStage(input.stage)} for ${input.actionType}. Capture a fresh session with "owa auth:session --session ${input.sessionName}" and rerun the harness.`
        : `Stored session "${input.sessionName}" is no longer authenticated while ${describeActionStage(input.stage)} for ${input.actionType}. Capture a fresh session with "owa auth:session --session ${input.sessionName}" and rerun the harness.`,
      {
        ...details,
        raw_error: rawMessage
      },
      createErrorOptions(input.error)
    );
  }

  if (isTimeoutError(input.error)) {
    return new LinkedInAssistantError(
      "TIMEOUT",
      `Timed out while ${describeActionStage(input.stage)} for ${input.actionType}. LinkedIn may be slow; rerun the harness or increase the timeout.`,
      {
        ...details,
        raw_error: rawMessage
      },
      createErrorOptions(input.error)
    );
  }

  if (isRateLimitError(input.error)) {
    return new LinkedInAssistantError(
      "RATE_LIMITED",
      `LinkedIn rate limited ${input.actionType} while ${describeActionStage(input.stage)}. Wait for the account to cool down, then rerun the harness.`,
      {
        ...details,
        raw_error: rawMessage
      },
      createErrorOptions(input.error)
    );
  }

  if (isNetworkError(input.error)) {
    return new LinkedInAssistantError(
      "NETWORK_ERROR",
      `The browser or network connection failed while ${describeActionStage(input.stage)} for ${input.actionType}: ${rawMessage}. Check connectivity and rerun the harness.`,
      {
        ...details,
        raw_error: rawMessage
      },
      createErrorOptions(input.error)
    );
  }

  if (/selector|locator/iu.test(rawMessage)) {
    return new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      `LinkedIn's DOM no longer matched the expected selectors while ${describeActionStage(input.stage)} for ${input.actionType}. Review the screenshots and validator assumptions, then rerun the harness.`,
      {
        ...details,
        raw_error: rawMessage
      },
      createErrorOptions(input.error)
    );
  }

  return new LinkedInAssistantError(
    "UNKNOWN",
    `Write validation failed while ${describeActionStage(input.stage)} for ${input.actionType}: ${rawMessage}. Review the audit log and rerun the harness.`,
    {
      ...details,
      raw_error: rawMessage
    },
    createErrorOptions(input.error)
  );
}

function buildActionArtifactPaths(input: {
  afterScreenshotPaths?: readonly string[];
  beforeScreenshotPaths?: readonly string[];
  confirmArtifacts?: readonly string[];
  preparedArtifacts?: PreparedArtifacts;
}): string[] {
  return dedupeStrings([
    ...(input.preparedArtifacts?.previewArtifacts ?? []),
    ...(input.beforeScreenshotPaths ?? []),
    ...(input.confirmArtifacts ?? []),
    ...(input.afterScreenshotPaths ?? [])
  ]);
}

function resolveFailureStage(
  error: LinkedInAssistantError,
  fallback: WriteValidationActionStage
): WriteValidationActionStage {
  return isWriteValidationActionStage(error.details.stage) ? error.details.stage : fallback;
}

function assertInteractiveWriteValidation(input: { interactive?: boolean }): void {
  if (input.interactive === false) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Write validation requires an interactive terminal and a visible browser window."
    );
  }

  if (isTruthyCiValue(process.env.CI)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Write validation cannot run in CI. Run it manually from an interactive terminal."
    );
  }
}

export function validateWriteValidationOptions(
  options: RunLinkedInWriteValidationOptions
): ValidatedWriteValidationOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "write validation options must be an object.",
      {
        received_type: Array.isArray(options) ? "array" : typeof options
      }
    );
  }

  if (typeof options.accountId !== "string") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "accountId is required for write validation."
    );
  }

  if (typeof options.baseDir !== "undefined" && typeof options.baseDir !== "string") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "baseDir must be a string when provided."
    );
  }

  if (
    typeof options.onBeforeAction !== "undefined" &&
    typeof options.onBeforeAction !== "function"
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "onBeforeAction must be a function when provided."
    );
  }

  if (typeof options.interactive !== "undefined" && typeof options.interactive !== "boolean") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "interactive must be a boolean when provided."
    );
  }

  const accountId = options.accountId.trim();
  if (!accountId) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "accountId is required for write validation."
    );
  }

  const timeoutMs = resolvePositiveInt(
    options.timeoutMs,
    DEFAULT_WRITE_VALIDATION_TIMEOUT_MS,
    "timeoutMs"
  );
  const cooldownMs = resolveNonNegativeInt(
    options.cooldownMs,
    DEFAULT_WRITE_VALIDATION_COOLDOWN_MS,
    "cooldownMs"
  );
  const maxRetries = resolveNonNegativeInt(
    options.maxRetries,
    DEFAULT_WRITE_VALIDATION_MAX_RETRIES,
    "maxRetries"
  );
  const retryBaseDelayMs = resolvePositiveInt(
    options.retryBaseDelayMs,
    DEFAULT_WRITE_VALIDATION_RETRY_BASE_DELAY_MS,
    "retryBaseDelayMs"
  );
  const retryMaxDelayMs = resolvePositiveInt(
    options.retryMaxDelayMs,
    DEFAULT_WRITE_VALIDATION_RETRY_MAX_DELAY_MS,
    "retryMaxDelayMs"
  );

  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "retryMaxDelayMs must be greater than or equal to retryBaseDelayMs.",
      {
        retry_base_delay_ms: retryBaseDelayMs,
        retry_max_delay_ms: retryMaxDelayMs
      }
    );
  }

  return {
    accountId,
    ...(typeof options.baseDir === "string" ? { baseDir: options.baseDir } : {}),
    cooldownMs,
    maxRetries,
    ...(options.onBeforeAction ? { onBeforeAction: options.onBeforeAction } : {}),
    retryBaseDelayMs,
    retryMaxDelayMs,
    timeoutMs
  };
}

function ensureSecondaryWriteValidationAccount(account: {
  designation: string;
  id: string;
}): void {
  if (account.designation === "secondary") {
    return;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Write validation can run only against a registered secondary account. Account "${account.id}" is marked as ${account.designation}.`,
    {
      account_id: account.id,
      designation: account.designation
    }
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function validateWriteValidationScenarioDefinitions(
  scenarios: readonly WriteValidationScenarioDefinition[]
): void {
  const seenActionTypes = new Set<string>();

  for (const scenario of scenarios) {
    if (typeof scenario.actionType !== "string" || scenario.actionType.trim().length === 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "write-validation scenarios must define a non-empty actionType."
      );
    }

    if (seenActionTypes.has(scenario.actionType)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Duplicate write-validation scenario action type: ${scenario.actionType}.`,
        {
          action_type: scenario.actionType
        }
      );
    }
    seenActionTypes.add(scenario.actionType);

    if (typeof scenario.summary !== "string" || scenario.summary.trim().length === 0) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} is missing a summary.`,
        {
          action_type: scenario.actionType
        }
      );
    }

    if (
      typeof scenario.expectedOutcome !== "string" ||
      scenario.expectedOutcome.trim().length === 0
    ) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} is missing an expectedOutcome.`,
        {
          action_type: scenario.actionType
        }
      );
    }

    if (!["private", "network", "public"].includes(scenario.riskClass)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} has an unsupported risk class.`,
        {
          action_type: scenario.actionType,
          risk_class: scenario.riskClass
        }
      );
    }

    if (typeof scenario.prepare !== "function") {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} is missing a prepare function.`,
        {
          action_type: scenario.actionType
        }
      );
    }

    if (typeof scenario.resolveAfterScreenshotUrl !== "function") {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} is missing a resolveAfterScreenshotUrl function.`,
        {
          action_type: scenario.actionType
        }
      );
    }

    if (typeof scenario.verify !== "function") {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} is missing a verify function.`,
        {
          action_type: scenario.actionType
        }
      );
    }

    if (
      typeof scenario.validateConfig !== "undefined" &&
      typeof scenario.validateConfig !== "function"
    ) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `write-validation scenario ${scenario.actionType} has an invalid validateConfig hook.`,
        {
          action_type: scenario.actionType
        }
      );
    }
  }
}

function validateWriteValidationStartupConfig(
  account: ReturnType<typeof resolveWriteValidationAccount>,
  scenarios: readonly WriteValidationScenarioDefinition[]
): void {
  for (const scenario of scenarios) {
    if (!scenario.validateConfig) {
      continue;
    }

    try {
      scenario.validateConfig(account);
    } catch (error) {
      const normalizedError = asLinkedInAssistantError(
        error,
        error instanceof LinkedInAssistantError ? error.code : "ACTION_PRECONDITION_FAILED",
        `Invalid write-validation startup config for ${scenario.actionType}.`
      );
      throw new LinkedInAssistantError(
        normalizedError.code,
        normalizedError.message,
        {
          ...normalizedError.details,
          account_id: account.id,
          action_type: scenario.actionType,
          session_name: account.sessionName,
          startup_validation: true
        },
        { cause: normalizedError }
      );
    }
  }
}

async function readRunLockState(lockPath: string): Promise<WriteValidationRunLockState | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return typeof parsed.account_id === "string" &&
      typeof parsed.cwd === "string" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.started_at === "string"
      ? {
          account_id: parsed.account_id,
          cwd: parsed.cwd,
          pid: parsed.pid,
          started_at: parsed.started_at
        }
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    return code !== "ESRCH";
  }
}

async function acquireWriteValidationRunLock(
  paths: ConfigPaths,
  accountId: string
): Promise<WriteValidationRunLockHandle> {
  const lockDir = path.join(paths.artifactsDir, WRITE_VALIDATION_REPORT_DIR, accountId);
  const lockPath = path.join(lockDir, WRITE_VALIDATION_LOCK_NAME);
  const state: WriteValidationRunLockState = {
    account_id: accountId,
    cwd: process.cwd(),
    pid: process.pid,
    started_at: new Date().toISOString()
  };

  await mkdir(lockDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }

      return {
        lockPath,
        state,
        async release() {
          await unlink(lockPath).catch((error) => {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code ?? "")
                : "";
            if (code !== "ENOENT") {
              throw error;
            }
          });
        }
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "EEXIST") {
        throw error;
      }

      const existingLock = await readRunLockState(lockPath);
      if (existingLock && isProcessAlive(existingLock.pid)) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          `Write validation is already running for account "${accountId}" (pid ${existingLock.pid}, started ${existingLock.started_at}). Wait for that run to finish before starting another one.`,
          {
            account_id: accountId,
            lock_path: lockPath,
            pid: existingLock.pid,
            started_at: existingLock.started_at
          }
        );
      }

      await unlink(lockPath).catch((unlinkError) => {
        const unlinkCode =
          typeof unlinkError === "object" && unlinkError !== null && "code" in unlinkError
            ? String((unlinkError as { code?: unknown }).code ?? "")
            : "";
        if (unlinkCode !== "ENOENT") {
          throw unlinkError;
        }
      });
    }
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Could not acquire the write-validation run lock for account "${accountId}". Remove ${lockPath} manually if no other harness is active.`,
    {
      account_id: accountId,
      lock_path: lockPath
    }
  );
}

async function runWriteValidationStageWithRetry<T>(input: {
  accountId: string;
  actionType: WriteValidationActionResult["action_type"];
  execute: () => Promise<T>;
  expectedOutcome: string;
  logger: WriteValidationLogger;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  sessionName: string;
  stage: WriteValidationActionStage;
}): Promise<StageRetryResult<T>> {
  const maxAttempts = input.maxRetries + 1;
  let lastError: LinkedInAssistantError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.logger.log("debug", "write_validation.action.attempt", {
      account_id: input.accountId,
      action_type: input.actionType,
      attempt,
      max_attempts: maxAttempts,
      session_name: input.sessionName,
      stage: input.stage
    });

    try {
      return {
        attemptCount: attempt,
        result: await input.execute()
      };
    } catch (error) {
      const normalizedError = normalizeWriteValidationError({
        accountId: input.accountId,
        actionType: input.actionType,
        error,
        expectedOutcome: input.expectedOutcome,
        sessionName: input.sessionName,
        stage: input.stage
      });
      lastError = new LinkedInAssistantError(
        normalizedError.code,
        normalizedError.message,
        {
          ...normalizedError.details,
          attempt_count: attempt
        },
        { cause: normalizedError }
      );

      if (!isRetryableWriteValidationError(normalizedError.code) || attempt >= maxAttempts) {
        throw lastError;
      }

      const backoffMs = calculateRetryBackoffMs(
        attempt,
        input.retryBaseDelayMs,
        input.retryMaxDelayMs
      );
      input.logger.log("warn", "write_validation.action.retry", {
        account_id: input.accountId,
        action_type: input.actionType,
        attempt,
        backoff_ms: backoffMs,
        code: normalizedError.code,
        error_message: normalizedError.message,
        max_attempts: maxAttempts,
        session_name: input.sessionName,
        stage: input.stage
      });
      await sleep(backoffMs);
    }
  }

  throw (
    lastError ??
    new LinkedInAssistantError(
      "UNKNOWN",
      `Write validation exhausted retries while ${describeActionStage(input.stage)} for ${input.actionType}.`,
      {
        account_id: input.accountId,
        action_type: input.actionType,
        session_name: input.sessionName,
        stage: input.stage
      }
    )
  );
}

async function captureScenarioScreenshotBestEffort(input: {
  accountId: string;
  actionType: WriteValidationActionResult["action_type"];
  existingPaths: readonly string[];
  expectedOutcome: string;
  logger: WriteValidationLogger;
  maxRetries: number;
  profileManager: WriteValidationProfileManager;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  sessionName: string;
  stage: "before" | "after";
  url?: string | null | undefined;
}): Promise<{
  screenshotPaths: string[];
  warnings: string[];
}> {
  const screenshotPaths = [...input.existingPaths];
  const stage: WriteValidationActionStage =
    input.stage === "before" ? "before_screenshot" : "after_screenshot";

  if (screenshotPaths.length > 0 || typeof input.url !== "string" || input.url.trim().length === 0) {
    return {
      screenshotPaths: dedupeStrings(screenshotPaths),
      warnings: []
    };
  }

  try {
    const capture = await runWriteValidationStageWithRetry({
      accountId: input.accountId,
      actionType: input.actionType,
      execute: async () =>
        input.profileManager.capturePageScreenshot({
          actionType: input.actionType,
          stage: input.stage,
          url: input.url ?? ""
        }),
      expectedOutcome: input.expectedOutcome,
      logger: input.logger,
      maxRetries: input.maxRetries,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName: input.sessionName,
      stage
    });

    screenshotPaths.push(capture.result);
    const recoveryWarning = buildRetryRecoveryWarning(stage, capture.attemptCount);

    return {
      screenshotPaths: dedupeStrings(screenshotPaths),
      warnings: recoveryWarning ? [recoveryWarning] : []
    };
  } catch (error) {
    const normalizedError = asLinkedInAssistantError(
      error,
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      `Failed to capture the ${input.stage} screenshot for ${input.actionType}.`
    );
    const warnings: string[] = [];
    const retryWarning = buildRetryExhaustedWarning(stage, getErrorAttemptCount(normalizedError));
    if (retryWarning) {
      warnings.push(retryWarning);
    }
    warnings.push(normalizedError.message);

    input.logger.log("warn", "write_validation.action.degraded", {
      account_id: input.accountId,
      action_type: input.actionType,
      code: normalizedError.code,
      error_details: normalizedError.details,
      error_message: normalizedError.message,
      session_name: input.sessionName,
      stage
    });

    return {
      screenshotPaths: dedupeStrings(screenshotPaths),
      warnings
    };
  }
}

function buildCancelledActionResult(input: {
  preview: WriteValidationActionPreview;
  prepared: PreparedActionResult;
  preparedArtifacts: PreparedArtifacts;
  scenario: WriteValidationScenarioDefinition;
  startedAt: string;
  cleanupGuidance: string[];
  errorCode?: LinkedInAssistantErrorCode;
  errorDetails?: Record<string, unknown>;
  errorMessage?: string;
  warnings?: string[];
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: [],
    artifact_paths: buildActionArtifactPaths({
      beforeScreenshotPaths: input.preparedArtifacts.beforeScreenshotPaths,
      preparedArtifacts: input.preparedArtifacts
    }),
    before_screenshot_paths: input.preparedArtifacts.beforeScreenshotPaths,
    cleanup_guidance: input.cleanupGuidance,
    completed_at: new Date().toISOString(),
    confirm_artifacts: [],
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    ...(input.errorDetails ? { error_details: input.errorDetails } : {}),
    ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
    expected_outcome: input.scenario.expectedOutcome,
    prepared_action_id: input.prepared.preparedActionId,
    preview: input.preview,
    risk_class: input.scenario.riskClass,
    started_at: input.startedAt,
    state_synced: null,
    status: "cancelled",
    summary: input.scenario.summary,
    ...(input.warnings && input.warnings.length > 0
      ? { warnings: dedupeStrings(input.warnings) }
      : {})
  };
}

function buildCompletedActionResult(input: {
  afterScreenshotPaths: string[];
  beforeScreenshotPaths: string[];
  cleanupGuidance: string[];
  confirmArtifacts: string[];
  linkedinResponse: Record<string, unknown>;
  prepared: PreparedActionResult;
  preparedArtifacts: PreparedArtifacts;
  preview: WriteValidationActionPreview;
  scenario: WriteValidationScenarioDefinition;
  startedAt: string;
  status: WriteValidationResultStatus;
  verification: WriteValidationVerificationResult;
  warnings?: string[];
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: input.afterScreenshotPaths,
    artifact_paths: buildActionArtifactPaths({
      afterScreenshotPaths: input.afterScreenshotPaths,
      beforeScreenshotPaths: input.beforeScreenshotPaths,
      confirmArtifacts: input.confirmArtifacts,
      preparedArtifacts: input.preparedArtifacts
    }),
    before_screenshot_paths: input.beforeScreenshotPaths,
    cleanup_guidance: input.cleanupGuidance,
    completed_at: new Date().toISOString(),
    confirm_artifacts: input.confirmArtifacts,
    expected_outcome: input.scenario.expectedOutcome,
    linkedin_response: input.linkedinResponse,
    prepared_action_id: input.prepared.preparedActionId,
    preview: input.preview,
    risk_class: input.scenario.riskClass,
    started_at: input.startedAt,
    state_synced: input.verification.state_synced,
    status: input.status,
    summary: input.scenario.summary,
    verification: {
      details: input.verification.details,
      message: input.verification.message,
      source: input.verification.source,
      verified: input.verification.verified
    },
    ...(input.warnings && input.warnings.length > 0
      ? { warnings: dedupeStrings(input.warnings) }
      : {})
  };
}

function buildFailedActionResult(input: {
  error: LinkedInAssistantError;
  failureStage: WriteValidationActionStage;
  partial: PartialActionContext;
  scenario: WriteValidationScenarioDefinition;
  startedAt: string;
}): WriteValidationActionResult {
  const warnings = [...input.partial.warnings];
  const retryWarning = buildRetryExhaustedWarning(
    input.failureStage,
    getErrorAttemptCount(input.error)
  );
  if (retryWarning) {
    warnings.unshift(retryWarning);
  }

  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: input.partial.afterScreenshotPaths,
    artifact_paths: buildActionArtifactPaths({
      afterScreenshotPaths: input.partial.afterScreenshotPaths,
      beforeScreenshotPaths: input.partial.beforeScreenshotPaths,
      confirmArtifacts: input.partial.confirmArtifacts,
      ...(input.partial.preparedArtifacts
        ? { preparedArtifacts: input.partial.preparedArtifacts }
        : {})
    }),
    before_screenshot_paths: input.partial.beforeScreenshotPaths,
    cleanup_guidance: input.partial.cleanupGuidance,
    completed_at: new Date().toISOString(),
    confirm_artifacts: input.partial.confirmArtifacts,
    error_code: input.error.code,
    error_details: input.error.details,
    error_message: input.error.message,
    expected_outcome: input.scenario.expectedOutcome,
    failure_stage: input.failureStage,
    ...(input.partial.linkedinResponse
      ? { linkedin_response: input.partial.linkedinResponse }
      : {}),
    ...(input.partial.prepared
      ? { prepared_action_id: input.partial.prepared.preparedActionId }
      : {}),
    ...(input.partial.preview ? { preview: input.partial.preview } : {}),
    risk_class: input.scenario.riskClass,
    started_at: input.startedAt,
    state_synced: null,
    status: "fail",
    summary: input.scenario.summary,
    ...(warnings.length > 0 ? { warnings: dedupeStrings(warnings) } : {})
  };
}

function buildRemainingScenarioSkipMessage(input: {
  blockingCode: LinkedInAssistantErrorCode;
  blockedByActionType: string;
  sessionName: string;
}): string {
  switch (input.blockingCode) {
    case "AUTH_REQUIRED":
      return `Skipped because the stored session expired during ${input.blockedByActionType}. Capture a fresh session with "owa auth:session --session ${input.sessionName}" before rerunning the remaining write-validation actions.`;
    case "CAPTCHA_OR_CHALLENGE":
      return `Skipped because LinkedIn triggered a checkpoint challenge during ${input.blockedByActionType}. Resolve the challenge and capture a fresh session before rerunning the remaining write-validation actions.`;
    case "RATE_LIMITED":
      return `Skipped because LinkedIn rate limited the session during ${input.blockedByActionType}. Wait for the account to cool down before rerunning the remaining write-validation actions.`;
    default:
      return `Skipped because ${input.blockedByActionType} failed with ${input.blockingCode}.`;
  }
}

function buildSkippedActionResult(input: {
  blockedByActionType: string;
  blockingCode: LinkedInAssistantErrorCode;
  scenario: WriteValidationScenarioDefinition;
  sessionName: string;
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: [],
    artifact_paths: [],
    before_screenshot_paths: [],
    cleanup_guidance: [],
    completed_at: new Date().toISOString(),
    confirm_artifacts: [],
    error_code: input.blockingCode,
    error_details: {
      blocked_by_action_type: input.blockedByActionType,
      session_name: input.sessionName
    },
    error_message: buildRemainingScenarioSkipMessage({
      blockedByActionType: input.blockedByActionType,
      blockingCode: input.blockingCode,
      sessionName: input.sessionName
    }),
    expected_outcome: input.scenario.expectedOutcome,
    risk_class: input.scenario.riskClass,
    started_at: new Date().toISOString(),
    state_synced: null,
    status: "cancelled",
    summary: input.scenario.summary
  };
}

async function executeWriteValidationScenario(input: {
  account: ReturnType<typeof resolveWriteValidationAccount>;
  maxRetries: number;
  onBeforeAction?: RunLinkedInWriteValidationOptions["onBeforeAction"];
  profileManager: WriteValidationProfileManager;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  runtime: WriteValidationRuntime;
  scenario: WriteValidationScenarioDefinition;
}): Promise<ScenarioExecutionResult> {
  const startedAt = new Date().toISOString();
  const sessionName = input.account.sessionName;
  const partial: PartialActionContext = {
    afterScreenshotPaths: [],
    beforeScreenshotPaths: [],
    cleanupGuidance: [],
    confirmArtifacts: [],
    warnings: []
  };

  input.runtime.logger.log("info", "write_validation.action.start", {
    account_id: input.account.id,
    action_type: input.scenario.actionType,
    expected_outcome: input.scenario.expectedOutcome,
    session_name: sessionName
  });

  try {
    const preparedStage = await runWriteValidationStageWithRetry({
      accountId: input.account.id,
      actionType: input.scenario.actionType,
      execute: async () => input.scenario.prepare(input.runtime, input.account),
      expectedOutcome: input.scenario.expectedOutcome,
      logger: input.runtime.logger,
      maxRetries: input.maxRetries,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName,
      stage: "prepare"
    });
    const prepared = preparedStage.result;
    partial.prepared = prepared.prepared;
    partial.preparedArtifacts = readPreparedArtifacts(prepared.prepared);
    partial.preview = buildPreview(input.scenario, prepared.prepared);
    partial.cleanupGuidance = prepared.cleanupGuidance;

    const prepareWarning = buildRetryRecoveryWarning("prepare", preparedStage.attemptCount);
    if (prepareWarning) {
      partial.warnings.push(prepareWarning);
    }

    input.runtime.logger.log("info", "write_validation.action.prepared", {
      account_id: input.account.id,
      action_type: input.scenario.actionType,
      prepared_action_id: prepared.prepared.preparedActionId,
      preview: partial.preview,
      retry_count: preparedStage.attemptCount - 1,
      session_name: sessionName
    });

    let proceed = true;
    try {
      proceed = input.onBeforeAction ? await input.onBeforeAction(partial.preview) : true;
    } catch (error) {
      const normalizedError = normalizeWriteValidationError({
        accountId: input.account.id,
        actionType: input.scenario.actionType,
        error,
        expectedOutcome: input.scenario.expectedOutcome,
        sessionName,
        stage: "prompt"
      });

      input.runtime.logger.log("error", "write_validation.action.failed", {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        code: normalizedError.code,
        error_details: normalizedError.details,
        error_message: normalizedError.message,
        expected_outcome: input.scenario.expectedOutcome,
        failure_stage: "prompt",
        prepared_action_id: partial.prepared?.preparedActionId,
        session_name: sessionName
      });

      return {
        actionResult: buildFailedActionResult({
          error: normalizedError,
          failureStage: "prompt",
          partial,
          scenario: input.scenario,
          startedAt
        }),
        shouldStop: false
      };
    }

    if (!proceed && partial.preview && partial.prepared && partial.preparedArtifacts) {
      input.runtime.logger.log("warn", "write_validation.action.cancelled", {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        prepared_action_id: partial.prepared.preparedActionId,
        session_name: sessionName
      });

      return {
        actionResult: buildCancelledActionResult({
          preview: partial.preview,
          prepared: partial.prepared,
          preparedArtifacts: partial.preparedArtifacts,
          scenario: input.scenario,
          startedAt,
          cleanupGuidance: partial.cleanupGuidance,
          warnings: partial.warnings
        }),
        shouldStop: false
      };
    }

    const beforeCapture = await captureScenarioScreenshotBestEffort({
      accountId: input.account.id,
      actionType: input.scenario.actionType,
      existingPaths: partial.preparedArtifacts?.beforeScreenshotPaths ?? [],
      expectedOutcome: input.scenario.expectedOutcome,
      logger: input.runtime.logger,
      maxRetries: input.maxRetries,
      profileManager: input.profileManager,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName,
      stage: "before",
      url: prepared.beforeScreenshotUrl
    });
    partial.beforeScreenshotPaths = beforeCapture.screenshotPaths;
    partial.warnings.push(...beforeCapture.warnings);

    const confirmStage = await runWriteValidationStageWithRetry({
      accountId: input.account.id,
      actionType: input.scenario.actionType,
      execute: async () =>
        input.runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.prepared.confirmToken
        }),
      expectedOutcome: input.scenario.expectedOutcome,
      logger: input.runtime.logger,
      maxRetries: 0,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName,
      stage: "confirm"
    });
    const confirmed = confirmStage.result;
    partial.confirmArtifacts = dedupeStrings([...confirmed.artifacts]);
    partial.linkedinResponse = confirmed.result;

    let afterScreenshotUrl: string | null = null;
    try {
      afterScreenshotUrl = input.scenario.resolveAfterScreenshotUrl(
        input.account,
        prepared,
        confirmed
      );
    } catch (error) {
      const normalizedError = normalizeWriteValidationError({
        accountId: input.account.id,
        actionType: input.scenario.actionType,
        error,
        expectedOutcome: input.scenario.expectedOutcome,
        sessionName,
        stage: "after_screenshot"
      });
      partial.warnings.push(normalizedError.message);
      input.runtime.logger.log("warn", "write_validation.action.degraded", {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        code: normalizedError.code,
        error_details: normalizedError.details,
        error_message: normalizedError.message,
        prepared_action_id: partial.prepared?.preparedActionId,
        session_name: sessionName,
        stage: "after_screenshot"
      });
    }

    const afterCapture = await captureScenarioScreenshotBestEffort({
      accountId: input.account.id,
      actionType: input.scenario.actionType,
      existingPaths: partial.confirmArtifacts.filter(isScreenshotPath),
      expectedOutcome: input.scenario.expectedOutcome,
      logger: input.runtime.logger,
      maxRetries: input.maxRetries,
      profileManager: input.profileManager,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName,
      stage: "after",
      url: afterScreenshotUrl
    });
    partial.afterScreenshotPaths = afterCapture.screenshotPaths;
    partial.warnings.push(...afterCapture.warnings);

    const verificationStage = await runWriteValidationStageWithRetry({
      accountId: input.account.id,
      actionType: input.scenario.actionType,
      execute: async () =>
        input.scenario.verify(input.runtime, input.account, prepared, confirmed),
      expectedOutcome: input.scenario.expectedOutcome,
      logger: input.runtime.logger,
      maxRetries: input.maxRetries,
      retryBaseDelayMs: input.retryBaseDelayMs,
      retryMaxDelayMs: input.retryMaxDelayMs,
      sessionName,
      stage: "verify"
    });
    const verification = verificationStage.result;
    const verificationWarning = buildRetryRecoveryWarning(
      "verify",
      verificationStage.attemptCount
    );
    if (verificationWarning) {
      partial.warnings.push(verificationWarning);
    }
    const status = determineActionStatus(verification);

    input.runtime.logger.log(
      status === "pass" ? "info" : "warn",
      "write_validation.action.completed",
      {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        expected_outcome: input.scenario.expectedOutcome,
        prepared_action_id: partial.prepared?.preparedActionId,
        session_name: sessionName,
        state_synced: verification.state_synced,
        status,
        verification_details: verification.details,
        verification_message: verification.message,
        verification_source: verification.source,
        verified: verification.verified,
        warnings: dedupeStrings(partial.warnings)
      }
    );

    return {
      actionResult: buildCompletedActionResult({
        afterScreenshotPaths: partial.afterScreenshotPaths,
        beforeScreenshotPaths: partial.beforeScreenshotPaths,
        cleanupGuidance: partial.cleanupGuidance,
        confirmArtifacts: partial.confirmArtifacts,
        linkedinResponse: partial.linkedinResponse ?? {},
        prepared: partial.prepared ?? prepared.prepared,
        preparedArtifacts: partial.preparedArtifacts ?? readPreparedArtifacts(prepared.prepared),
        preview: partial.preview ?? buildPreview(input.scenario, prepared.prepared),
        scenario: input.scenario,
        startedAt,
        status,
        verification,
        warnings: partial.warnings
      }),
      shouldStop: false
    };
  } catch (error) {
    const normalizedError = asLinkedInAssistantError(
      error,
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      `Write validation failed while executing ${input.scenario.actionType}.`
    );
    const failureStage = resolveFailureStage(
      normalizedError,
      partial.linkedinResponse ? "verify" : partial.prepared ? "confirm" : "prepare"
    );

    input.runtime.logger.log("error", "write_validation.action.failed", {
      account_id: input.account.id,
      action_type: input.scenario.actionType,
      code: normalizedError.code,
      error_details: normalizedError.details,
      error_message: normalizedError.message,
      expected_outcome: input.scenario.expectedOutcome,
      failure_stage: failureStage,
      prepared_action_id: partial.prepared?.preparedActionId,
      session_name: sessionName
    });

    return {
      actionResult: buildFailedActionResult({
        error: normalizedError,
        failureStage,
        partial,
        scenario: input.scenario,
        startedAt
      }),
      shouldStop: isBlockingWriteValidationErrorCode(normalizedError.code)
    };
  }
}

function buildWriteValidationReport(input: {
  account: ReturnType<typeof resolveWriteValidationAccount>;
  actions: WriteValidationActionResult[];
  cooldownMs: number;
  latestReportPath: string;
  runtime: WriteValidationRuntime;
}): WriteValidationReport {
  const counts = countActionStatuses(input.actions);
  const outcome = determineOutcome(input.actions);
  const reportPath = input.runtime.artifacts.resolve(
    `${WRITE_VALIDATION_REPORT_DIR}/report.json`
  );
  const checkedAt = new Date().toISOString();
  const summary = buildWriteValidationSummary({
    action_count: input.actions.length,
    cancelled_count: counts.cancelledCount,
    fail_count: counts.failCount,
    outcome,
    pass_count: counts.passCount
  });

  const report: WriteValidationReport = {
    account: buildWriteValidationReportAccount(input.account),
    action_count: input.actions.length,
    actions: input.actions,
    audit_log_path: input.runtime.logger.getEventsPath(),
    checked_at: checkedAt,
    cooldown_ms: input.cooldownMs,
    fail_count: counts.failCount,
    latest_report_path: input.latestReportPath,
    outcome,
    pass_count: counts.passCount,
    cancelled_count: counts.cancelledCount,
    recommended_actions: [],
    report_path: reportPath,
    run_id: input.runtime.runId,
    summary,
    warning: WRITE_VALIDATION_WARNING
  };

  report.recommended_actions = buildRecommendedActions(report);

  return report;
}

async function cleanupWriteValidationResources(input: {
  accountId: string;
  lockHandle: WriteValidationRunLockHandle;
  primaryError: unknown;
  runtimeHandle?: Awaited<ReturnType<typeof createWriteValidationRuntime>>;
}): Promise<void> {
  const cleanupErrors: LinkedInAssistantError[] = [];
  const runtime = input.runtimeHandle?.runtime;
  const logger = runtime?.logger;

  if (input.runtimeHandle) {
    try {
      await input.runtimeHandle.profileManager.dispose();
    } catch (error) {
      const cleanupError = new LinkedInAssistantError(
        "UNKNOWN",
        `Failed to dispose the write-validation browser for account "${input.accountId}".`,
        {
          account_id: input.accountId,
          stage: "cleanup",
          raw_error: getErrorMessage(error)
        },
        createErrorOptions(error)
      );
      logger?.log("warn", "write_validation.cleanup.profile_manager_failed", {
        account_id: input.accountId,
        error_details: cleanupError.details,
        error_message: cleanupError.message
      });
      cleanupErrors.push(cleanupError);
    }
  }

  try {
    await input.lockHandle.release();
    logger?.log("debug", "write_validation.lock.released", {
      account_id: input.accountId,
      lock_path: input.lockHandle.lockPath,
      pid: input.lockHandle.state.pid
    });
  } catch (error) {
    const cleanupError = new LinkedInAssistantError(
      "UNKNOWN",
      `Failed to release the write-validation run lock for account "${input.accountId}". Remove ${input.lockHandle.lockPath} manually if the next run is blocked.`,
      {
        account_id: input.accountId,
        lock_path: input.lockHandle.lockPath,
        stage: "cleanup"
      },
      createErrorOptions(error)
    );
    logger?.log("warn", "write_validation.cleanup.lock_failed", {
      account_id: input.accountId,
      error_details: cleanupError.details,
      error_message: cleanupError.message,
      lock_path: input.lockHandle.lockPath
    });
    cleanupErrors.push(cleanupError);
  }

  if (runtime) {
    try {
      runtime.close();
    } catch (error) {
      const cleanupError = new LinkedInAssistantError(
        "UNKNOWN",
        `Failed to close the write-validation runtime for account "${input.accountId}".`,
        {
          account_id: input.accountId,
          stage: "cleanup",
          raw_error: getErrorMessage(error)
        },
        createErrorOptions(error)
      );
      logger?.log("warn", "write_validation.cleanup.runtime_failed", {
        account_id: input.accountId,
        error_details: cleanupError.details,
        error_message: cleanupError.message
      });
      cleanupErrors.push(cleanupError);
    }
  }

  if (cleanupErrors.length > 0 && typeof input.primaryError === "undefined") {
    throw cleanupErrors[0];
  }
}

export async function runLinkedInWriteValidation(
  options: RunLinkedInWriteValidationOptions
): Promise<WriteValidationReport> {
  const validatedOptions = validateWriteValidationOptions(options);
  assertInteractiveWriteValidation(options);

  const account = resolveWriteValidationAccount(
    validatedOptions.accountId,
    validatedOptions.baseDir
  );
  ensureSecondaryWriteValidationAccount(account);
  validateWriteValidationScenarioDefinitions(WRITE_VALIDATION_SCENARIOS);
  validateWriteValidationStartupConfig(account, WRITE_VALIDATION_SCENARIOS);

  const paths = resolveConfigPaths(validatedOptions.baseDir);
  ensureConfigPaths(paths);

  const lockHandle = await acquireWriteValidationRunLock(paths, account.id);
  let runtimeHandle: Awaited<ReturnType<typeof createWriteValidationRuntime>> | undefined;
  let primaryError: LinkedInAssistantError | undefined;

  try {
    runtimeHandle = await createWriteValidationRuntime({
      account,
      ...(validatedOptions.baseDir ? { baseDir: validatedOptions.baseDir } : {}),
      timeoutMs: validatedOptions.timeoutMs
    });

    const { runtime, profileManager } = runtimeHandle;
    const latestReportPath = path.join(
      paths.baseDir,
      WRITE_VALIDATION_REPORT_DIR,
      account.id,
      WRITE_VALIDATION_LATEST_REPORT_NAME
    );

    runtime.logger.log("debug", "write_validation.lock.acquired", {
      account_id: account.id,
      lock_path: lockHandle.lockPath,
      pid: lockHandle.state.pid,
      started_at: lockHandle.state.started_at
    });
    runtime.logger.log("info", "write_validation.start", {
      account_id: account.id,
      cooldown_ms: validatedOptions.cooldownMs,
      max_retries: validatedOptions.maxRetries,
      profile_name: account.profileName,
      retry_base_delay_ms: validatedOptions.retryBaseDelayMs,
      retry_max_delay_ms: validatedOptions.retryMaxDelayMs,
      session_name: account.sessionName,
      timeout_ms: validatedOptions.timeoutMs,
      warning: WRITE_VALIDATION_WARNING
    });

    const actions: WriteValidationActionResult[] = [];

    for (const [index, scenario] of WRITE_VALIDATION_SCENARIOS.entries()) {
      const execution = await executeWriteValidationScenario({
        account,
        maxRetries: validatedOptions.maxRetries,
        onBeforeAction: validatedOptions.onBeforeAction,
        profileManager,
        retryBaseDelayMs: validatedOptions.retryBaseDelayMs,
        retryMaxDelayMs: validatedOptions.retryMaxDelayMs,
        runtime,
        scenario
      });
      actions.push(execution.actionResult);

      if (execution.shouldStop) {
        runtime.logger.log("warn", "write_validation.stopped_early", {
          account_id: account.id,
          action_type: scenario.actionType,
          code: execution.actionResult.error_code,
          completed_actions: actions.length,
          remaining_actions: WRITE_VALIDATION_SCENARIOS.length - actions.length,
          session_name: account.sessionName
        });

        for (const remainingScenario of WRITE_VALIDATION_SCENARIOS.slice(index + 1)) {
          actions.push(
            buildSkippedActionResult({
              blockedByActionType: scenario.actionType,
              blockingCode: execution.actionResult.error_code ?? "UNKNOWN",
              scenario: remainingScenario,
              sessionName: account.sessionName
            })
          );
        }
        break;
      }

      if (
        validatedOptions.cooldownMs > 0 &&
        index < WRITE_VALIDATION_SCENARIOS.length - 1
      ) {
        runtime.logger.log("info", "write_validation.cooldown.start", {
          account_id: account.id,
          cooldown_ms: validatedOptions.cooldownMs
        });
        await sleep(validatedOptions.cooldownMs);
      }
    }

    const report = buildWriteValidationReport({
      account,
      actions,
      cooldownMs: validatedOptions.cooldownMs,
      latestReportPath,
      runtime
    });

    try {
      runtime.artifacts.writeJson(`${WRITE_VALIDATION_REPORT_DIR}/report.json`, report, {
        account_id: account.id,
        action_count: actions.length,
        outcome: report.outcome
      });
    } catch (error) {
      runtime.logger.log("warn", "write_validation.report_persist.failed", {
        account_id: account.id,
        error: getErrorMessage(error),
        report_path: report.report_path
      });
      report.recommended_actions.push(
        `The report could not be written to ${report.report_path}; inspect ${report.audit_log_path} for this run.`
      );
    }

    try {
      await writeJsonFile(latestReportPath, report);
    } catch (error) {
      runtime.logger.log("warn", "write_validation.latest_report_persist.failed", {
        account_id: account.id,
        error: getErrorMessage(error),
        latest_report_path: latestReportPath
      });
      report.recommended_actions.push(
        `The rolling latest report at ${latestReportPath} was not updated, so the next run may diff against an older snapshot.`
      );
    }

    report.recommended_actions = dedupeStrings(report.recommended_actions);

    runtime.logger.log("info", "write_validation.completed", {
      account_id: account.id,
      action_count: actions.length,
      cancelled_count: report.cancelled_count,
      fail_count: report.fail_count,
      outcome: report.outcome,
      pass_count: report.pass_count,
      report_path: report.report_path
    });

    return report;
  } catch (error) {
    const normalizedError = asLinkedInAssistantError(
      withPlaywrightInstallHint(error),
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      "Failed to run the LinkedIn write validation harness."
    );
    primaryError = normalizedError;

    runtimeHandle?.runtime.logger.log("error", "write_validation.failed", {
      account_id: account.id,
      code: normalizedError.code,
      error_details: normalizedError.details,
      error_message: normalizedError.message,
      session_name: account.sessionName,
      source_error_name: error instanceof Error ? error.name : typeof error
    });

    throw normalizedError;
  } finally {
    await cleanupWriteValidationResources({
      accountId: account.id,
      lockHandle,
      primaryError,
      ...(runtimeHandle ? { runtimeHandle } : {})
    });
  }
}

export function getWriteValidationActionDefinitions(): readonly LinkedInWriteValidationActionDefinition[] {
  return LINKEDIN_WRITE_VALIDATION_ACTIONS;
}
