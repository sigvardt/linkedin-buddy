import path from "node:path";
import { ensureConfigPaths, resolveConfigPaths } from "./config.js";
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

interface PreparedArtifacts {
  beforeScreenshotPaths: string[];
  previewArtifacts: string[];
}

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

function assertInteractiveWriteValidation(
  options: RunLinkedInWriteValidationOptions
): void {
  if (options.interactive === false) {
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
): Required<Pick<RunLinkedInWriteValidationOptions, "accountId">> & {
  cooldownMs: number;
  timeoutMs: number;
} {
  const accountId = options.accountId.trim();
  if (!accountId) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "accountId is required for write validation."
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_WRITE_VALIDATION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "timeoutMs must be a positive integer."
    );
  }

  const cooldownMs = options.cooldownMs ?? DEFAULT_WRITE_VALIDATION_COOLDOWN_MS;
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "cooldownMs must be a non-negative integer."
    );
  }

  return {
    accountId,
    cooldownMs,
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureScenarioScreenshotPaths(input: {
  actionType: WriteValidationActionResult["action_type"];
  existingPaths: readonly string[];
  profileManager: WriteValidationProfileManager;
  stage: "before" | "after";
  url?: string | null | undefined;
}): Promise<string[]> {
  const screenshotPaths = [...input.existingPaths];

  if (screenshotPaths.length === 0 && typeof input.url === "string") {
    screenshotPaths.push(
      await input.profileManager.capturePageScreenshot({
        actionType: input.actionType,
        stage: input.stage,
        url: input.url
      })
    );
  }

  return dedupeStrings(screenshotPaths);
}

function buildCancelledActionResult(input: {
  preview: WriteValidationActionPreview;
  prepared: PreparedActionResult;
  preparedArtifacts: PreparedArtifacts;
  scenario: WriteValidationScenarioDefinition;
  startedAt: string;
  cleanupGuidance: string[];
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: [],
    artifact_paths: input.preparedArtifacts.previewArtifacts,
    before_screenshot_paths: input.preparedArtifacts.beforeScreenshotPaths,
    cleanup_guidance: input.cleanupGuidance,
    completed_at: new Date().toISOString(),
    confirm_artifacts: [],
    expected_outcome: input.scenario.expectedOutcome,
    prepared_action_id: input.prepared.preparedActionId,
    preview: input.preview,
    risk_class: input.scenario.riskClass,
    started_at: input.startedAt,
    state_synced: null,
    status: "cancelled",
    summary: input.scenario.summary
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
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: input.afterScreenshotPaths,
    artifact_paths: dedupeStrings([
      ...input.preparedArtifacts.previewArtifacts,
      ...input.beforeScreenshotPaths,
      ...input.confirmArtifacts,
      ...input.afterScreenshotPaths
    ]),
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
    }
  };
}

function buildFailedActionResult(input: {
  errorCode: LinkedInAssistantErrorCode;
  errorMessage: string;
  scenario: WriteValidationScenarioDefinition;
  startedAt: string;
}): WriteValidationActionResult {
  return {
    action_type: input.scenario.actionType,
    after_screenshot_paths: [],
    artifact_paths: [],
    before_screenshot_paths: [],
    cleanup_guidance: [],
    completed_at: new Date().toISOString(),
    confirm_artifacts: [],
    error_code: input.errorCode,
    error_message: input.errorMessage,
    expected_outcome: input.scenario.expectedOutcome,
    risk_class: input.scenario.riskClass,
    started_at: input.startedAt,
    state_synced: null,
    status: "fail",
    summary: input.scenario.summary
  };
}

async function executeWriteValidationScenario(input: {
  account: ReturnType<typeof resolveWriteValidationAccount>;
  onBeforeAction?: RunLinkedInWriteValidationOptions["onBeforeAction"];
  profileManager: WriteValidationProfileManager;
  runtime: Awaited<ReturnType<typeof createWriteValidationRuntime>>["runtime"];
  scenario: WriteValidationScenarioDefinition;
}): Promise<WriteValidationActionResult> {
  const startedAt = new Date().toISOString();

  input.runtime.logger.log("info", "write_validation.action.start", {
    account_id: input.account.id,
    action_type: input.scenario.actionType
  });

  try {
    const prepared = await input.scenario.prepare(input.runtime, input.account);
    const preview = buildPreview(input.scenario, prepared.prepared);

    input.runtime.logger.log("info", "write_validation.action.prepared", {
      account_id: input.account.id,
      action_type: input.scenario.actionType,
      prepared_action_id: prepared.prepared.preparedActionId,
      preview
    });

    const preparedArtifacts = readPreparedArtifacts(prepared.prepared);
    const proceed = input.onBeforeAction
      ? await input.onBeforeAction(preview)
      : true;

    if (!proceed) {
      input.runtime.logger.log("warn", "write_validation.action.cancelled", {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        prepared_action_id: prepared.prepared.preparedActionId
      });

      return buildCancelledActionResult({
        preview,
        prepared: prepared.prepared,
        preparedArtifacts,
        scenario: input.scenario,
        startedAt,
        cleanupGuidance: prepared.cleanupGuidance
      });
    }

    const beforeScreenshotPaths = await ensureScenarioScreenshotPaths({
      actionType: input.scenario.actionType,
      existingPaths: preparedArtifacts.beforeScreenshotPaths,
      profileManager: input.profileManager,
      stage: "before",
      url: prepared.beforeScreenshotUrl
    });

    const confirmed = await input.runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.prepared.confirmToken
    });
    const confirmArtifacts = dedupeStrings([...confirmed.artifacts]);
    const afterScreenshotPaths = await ensureScenarioScreenshotPaths({
      actionType: input.scenario.actionType,
      existingPaths: confirmArtifacts.filter(isScreenshotPath),
      profileManager: input.profileManager,
      stage: "after",
      url: input.scenario.resolveAfterScreenshotUrl(
        input.account,
        prepared,
        confirmed
      )
    });

    const verification = await input.scenario.verify(
      input.runtime,
      input.account,
      prepared,
      confirmed
    );
    const status = determineActionStatus(verification);

    input.runtime.logger.log(
      status === "pass" ? "info" : "warn",
      "write_validation.action.completed",
      {
        account_id: input.account.id,
        action_type: input.scenario.actionType,
        prepared_action_id: prepared.prepared.preparedActionId,
        verified: verification.verified,
        state_synced: verification.state_synced,
        status
      }
    );

    return buildCompletedActionResult({
      afterScreenshotPaths,
      beforeScreenshotPaths,
      cleanupGuidance: prepared.cleanupGuidance,
      confirmArtifacts,
      linkedinResponse: confirmed.result,
      prepared: prepared.prepared,
      preparedArtifacts,
      preview,
      scenario: input.scenario,
      startedAt,
      status,
      verification
    });
  } catch (error) {
    const normalizedError = asLinkedInAssistantError(
      error,
      error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
      `Write validation failed while executing ${input.scenario.actionType}.`
    );

    input.runtime.logger.log("error", "write_validation.action.failed", {
      account_id: input.account.id,
      action_type: input.scenario.actionType,
      code: normalizedError.code,
      error_message: normalizedError.message,
      error_details: normalizedError.details
    });

    return buildFailedActionResult({
      errorCode: normalizedError.code,
      errorMessage: normalizedError.message,
      scenario: input.scenario,
      startedAt
    });
  }
}

function buildWriteValidationReport(input: {
  account: ReturnType<typeof resolveWriteValidationAccount>;
  actions: WriteValidationActionResult[];
  cooldownMs: number;
  latestReportPath: string;
  runtime: Awaited<ReturnType<typeof createWriteValidationRuntime>>["runtime"];
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

export async function runLinkedInWriteValidation(
  options: RunLinkedInWriteValidationOptions
): Promise<WriteValidationReport> {
  assertInteractiveWriteValidation(options);
  const validatedOptions = validateWriteValidationOptions(options);
  const account = resolveWriteValidationAccount(
    validatedOptions.accountId,
    options.baseDir
  );
  ensureSecondaryWriteValidationAccount(account);

  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);

  const { runtime, profileManager } = await createWriteValidationRuntime({
    account,
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    timeoutMs: validatedOptions.timeoutMs
  });

  const latestReportPath = path.join(
    paths.baseDir,
    WRITE_VALIDATION_REPORT_DIR,
    account.id,
    WRITE_VALIDATION_LATEST_REPORT_NAME
  );

  runtime.logger.log("info", "write_validation.start", {
    account_id: account.id,
    cooldown_ms: validatedOptions.cooldownMs,
    profile_name: account.profileName,
    session_name: account.sessionName,
    warning: WRITE_VALIDATION_WARNING
  });

  const actions: WriteValidationActionResult[] = [];

  try {
    for (const [index, scenario] of WRITE_VALIDATION_SCENARIOS.entries()) {
      actions.push(
        await executeWriteValidationScenario({
          account,
          onBeforeAction: options.onBeforeAction,
          profileManager,
          runtime,
          scenario
        })
      );

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

    runtime.artifacts.writeJson(`${WRITE_VALIDATION_REPORT_DIR}/report.json`, report, {
      account_id: account.id,
      action_count: actions.length,
      outcome: report.outcome
    });
    await writeJsonFile(latestReportPath, report);

    runtime.logger.log("info", "write_validation.completed", {
      account_id: account.id,
      action_count: actions.length,
      fail_count: report.fail_count,
      outcome: report.outcome,
      pass_count: report.pass_count,
      cancelled_count: report.cancelled_count,
      report_path: report.report_path
    });

    return report;
  } finally {
    await profileManager.dispose();
    runtime.close();
  }
}

export function getWriteValidationActionDefinitions(): readonly LinkedInWriteValidationActionDefinition[] {
  return LINKEDIN_WRITE_VALIDATION_ACTIONS;
}
