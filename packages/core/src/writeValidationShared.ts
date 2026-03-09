import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LIKE_POST_ACTION_TYPE
} from "./linkedinFeed.js";
import {
  SEND_INVITATION_ACTION_TYPE
} from "./linkedinConnections.js";
import { FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE } from "./linkedinFollowups.js";
import { CREATE_POST_ACTION_TYPE } from "./linkedinPosts.js";
import type { LinkedInAssistantErrorCode } from "./errors.js";
import type { JsonLogEntry } from "./logging.js";
import type { CoreRuntime } from "./runtime.js";
import type {
  ConfirmByTokenResult,
  PreparedActionResult
} from "./twoPhaseCommit.js";
import type { WriteValidationAccount } from "./writeValidationAccounts.js";

export const SEND_MESSAGE_ACTION_TYPE = "send_message";
export const WRITE_VALIDATION_WARNING =
  "This will perform REAL actions on LinkedIn.";
export const WRITE_VALIDATION_REPORT_DIR = "live-write-validation";
export const WRITE_VALIDATION_LATEST_REPORT_NAME = "latest-report.json";
export const DEFAULT_WRITE_VALIDATION_COOLDOWN_MS = 10_000;
export const DEFAULT_WRITE_VALIDATION_TIMEOUT_MS = 30_000;
export const DEFAULT_WRITE_VALIDATION_MAX_RETRIES = 1;
export const DEFAULT_WRITE_VALIDATION_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_WRITE_VALIDATION_RETRY_MAX_DELAY_MS = 5_000;
export const WRITE_VALIDATION_FEED_URL = "https://www.linkedin.com/feed/";

export type WriteValidationRiskClass = "private" | "network" | "public";

export type LinkedInWriteValidationActionType =
  | typeof CREATE_POST_ACTION_TYPE
  | typeof SEND_INVITATION_ACTION_TYPE
  | typeof SEND_MESSAGE_ACTION_TYPE
  | typeof FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE
  | typeof LIKE_POST_ACTION_TYPE;

export type WriteValidationResultStatus = "pass" | "fail" | "cancelled";
export type WriteValidationOutcome = WriteValidationResultStatus;
export type WriteValidationActionStage =
  | "prepare"
  | "prompt"
  | "before_screenshot"
  | "confirm"
  | "after_screenshot"
  | "verify";

export interface LinkedInWriteValidationActionDefinition {
  actionType: LinkedInWriteValidationActionType;
  expectedOutcome: string;
  riskClass: WriteValidationRiskClass;
  summary: string;
}

export interface WriteValidationActionPreview {
  action_type: LinkedInWriteValidationActionType;
  expected_outcome: string;
  outbound: Record<string, unknown>;
  risk_class: WriteValidationRiskClass;
  summary: string;
  target: Record<string, unknown>;
}

export interface WriteValidationVerificationResult {
  details: Record<string, unknown>;
  message: string;
  source: string;
  state_synced: boolean | null;
  verified: boolean;
}

export interface WriteValidationActionResult {
  action_type: LinkedInWriteValidationActionType;
  after_screenshot_paths: string[];
  artifact_paths: string[];
  before_screenshot_paths: string[];
  cleanup_guidance: string[];
  completed_at: string;
  confirm_artifacts: string[];
  duration_ms: number;
  error_code?: LinkedInAssistantErrorCode;
  error_details?: Record<string, unknown>;
  error_message?: string;
  expected_outcome: string;
  failure_stage?: WriteValidationActionStage;
  linkedin_response?: Record<string, unknown>;
  prepared_action_id?: string;
  preview?: WriteValidationActionPreview;
  risk_class: WriteValidationRiskClass;
  started_at: string;
  status: WriteValidationResultStatus;
  state_synced: boolean | null;
  summary: string;
  verification?: {
    details: Record<string, unknown>;
    message: string;
    source: string;
    verified: boolean;
  };
  warnings?: string[];
}

export interface WriteValidationReport {
  account: {
    designation: WriteValidationAccount["designation"];
    id: string;
    label: string;
    profile_name: string;
    session_name: string;
  };
  action_count: number;
  actions: WriteValidationActionResult[];
  audit_log_path: string;
  checked_at: string;
  cooldown_ms: number;
  duration_ms: number;
  fail_count: number;
  html_report_path?: string;
  latest_report_path: string;
  outcome: WriteValidationOutcome;
  pass_count: number;
  cancelled_count: number;
  recommended_actions: string[];
  report_path: string;
  run_id: string;
  started_at: string;
  summary: string;
  warning: string;
}

export interface RunLinkedInWriteValidationOptions {
  accountId: string;
  baseDir?: string;
  cooldownMs?: number;
  interactive?: boolean;
  maxRetries?: number;
  onLog?: (entry: JsonLogEntry) => void;
  onBeforeAction?: (
    preview: WriteValidationActionPreview
  ) => Promise<boolean> | boolean;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  timeoutMs?: number;
}

export interface ScenarioPrepareResult {
  beforeScreenshotUrl?: string;
  cleanupGuidance: string[];
  prepared: PreparedActionResult;
  verificationContext: Record<string, unknown>;
}

export interface WriteValidationScenarioDefinition
  extends LinkedInWriteValidationActionDefinition {
  prepare: (
    runtime: CoreRuntime,
    account: WriteValidationAccount
  ) => Promise<ScenarioPrepareResult>;
  resolveAfterScreenshotUrl: (
    account: WriteValidationAccount,
    prepared: ScenarioPrepareResult,
    confirmed: ConfirmByTokenResult
  ) => string | null;
  validateConfig?: (account: WriteValidationAccount) => void;
  verify: (
    runtime: CoreRuntime,
    account: WriteValidationAccount,
    prepared: ScenarioPrepareResult,
    confirmed: ConfirmByTokenResult
  ) => Promise<WriteValidationVerificationResult>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

export function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function isScreenshotPath(value: string): boolean {
  return /\.png$/iu.test(value.trim());
}

export function readPreviewArtifacts(preview: Record<string, unknown>): string[] {
  const artifacts = preview.artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts
    .map((artifact) => {
      if (!isRecord(artifact)) {
        return null;
      }

      const pathValue = artifact.path;
      return typeof pathValue === "string" ? pathValue : null;
    })
    .filter((artifactPath): artifactPath is string => typeof artifactPath === "string");
}

export function buildPreview(
  scenario: WriteValidationScenarioDefinition,
  prepared: PreparedActionResult
): WriteValidationActionPreview {
  const target = isRecord(prepared.preview.target) ? prepared.preview.target : {};
  const outbound = isRecord(prepared.preview.outbound)
    ? prepared.preview.outbound
    : {};

  return {
    action_type: scenario.actionType,
    expected_outcome: scenario.expectedOutcome,
    outbound,
    risk_class: scenario.riskClass,
    summary: scenario.summary,
    target
  };
}

export function determineActionStatus(
  verification: WriteValidationVerificationResult
): WriteValidationResultStatus {
  if (!verification.verified || verification.state_synced === false) {
    return "fail";
  }

  return "pass";
}

export function countActionStatuses(
  actions: readonly WriteValidationActionResult[]
): {
  cancelledCount: number;
  failCount: number;
  passCount: number;
} {
  return actions.reduce(
    (counts, action) => {
      if (action.status === "pass") {
        counts.passCount += 1;
      } else if (action.status === "fail") {
        counts.failCount += 1;
      } else {
        counts.cancelledCount += 1;
      }

      return counts;
    },
    {
      cancelledCount: 0,
      failCount: 0,
      passCount: 0
    }
  );
}

export function determineOutcome(
  actions: readonly WriteValidationActionResult[]
): WriteValidationOutcome {
  if (actions.some((action) => action.status === "fail")) {
    return "fail";
  }

  if (actions.some((action) => action.status === "cancelled")) {
    return "cancelled";
  }

  return "pass";
}

export function buildWriteValidationSummary(
  report: Pick<
    WriteValidationReport,
    "action_count" | "pass_count" | "fail_count" | "cancelled_count" | "outcome"
  >
): string {
  const parts = [
    `Checked ${report.action_count} write-validation actions.`,
    `${report.pass_count} passed.`,
    `${report.fail_count} failed.`,
    `${report.cancelled_count} cancelled.`
  ];

  return `${parts.join(" ")} Overall outcome: ${report.outcome}.`;
}

export function buildRecommendedActions(
  report: Pick<WriteValidationReport, "actions" | "report_path" | "audit_log_path" | "account">
): string[] {
  const actions: string[] = [
    `Review ${report.report_path} for the full per-action report and screenshots.`,
    `Open ${report.audit_log_path} to inspect the structured audit log for this run.`
  ];

  for (const action of report.actions) {
    actions.push(...action.cleanup_guidance);

    if (action.error_code === "AUTH_REQUIRED" || action.error_code === "CAPTCHA_OR_CHALLENGE") {
      actions.push(
        `Capture a fresh stored session with "linkedin auth session --session ${report.account.session_name}" before rerunning write validation.`
      );
    }

    if (action.error_code === "RATE_LIMITED") {
      actions.push(
        `Wait for LinkedIn to lift rate limiting on session "${report.account.session_name}" before rerunning write validation.`
      );
    }

    if (action.error_code === "TARGET_NOT_FOUND") {
      actions.push(
        `Confirm the approved ${action.action_type} target in the write-validation account config still exists before rerunning.`
      );
    }

    if (action.error_code === "UI_CHANGED_SELECTOR_FAILED") {
      actions.push(
        `Review the failed ${action.action_type} screenshots and update the validator selectors before rerunning.`
      );
    }

    if (action.status === "fail") {
      actions.push(
        `Re-check ${action.action_type} after reviewing ${report.report_path} and the attached screenshots.`
      );
    }
  }

  return dedupeStrings(actions);
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function buildWriteValidationReportAccount(
  account: WriteValidationAccount
): WriteValidationReport["account"] {
  return {
    designation: account.designation,
    id: account.id,
    label: account.label,
    profile_name: account.profileName,
    session_name: account.sessionName
  };
}
