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
import type { LinkedInBuddyErrorCode } from "./errors.js";
import type { JsonLogEntry } from "./logging.js";
import type { CoreRuntime } from "./runtime.js";
import type {
  ConfirmByTokenResult,
  PreparedActionResult
} from "./twoPhaseCommit.js";
import type { WriteValidationAccount } from "./writeValidationAccounts.js";

/** Canonical action key used for validated outbound inbox replies. */
export const SEND_MESSAGE_ACTION_TYPE = "send_message";

/** Operator-facing warning emitted before the harness performs real LinkedIn writes. */
export const WRITE_VALIDATION_WARNING =
  "This will perform REAL actions on LinkedIn.";

/** Run-relative artifact directory used for Tier 3 reports, screenshots, and report assets. */
export const WRITE_VALIDATION_REPORT_DIR = "live-write-validation";

/** Stable filename used for the account-level rolling latest snapshot. */
export const WRITE_VALIDATION_LATEST_REPORT_NAME = "latest-report.json";

/** Default safety pause inserted between consecutive write-validation actions. */
export const DEFAULT_WRITE_VALIDATION_COOLDOWN_MS = 10_000;

/** Default navigation and selector timeout for stored-session write validation. */
export const DEFAULT_WRITE_VALIDATION_TIMEOUT_MS = 30_000;

/** Default retry count for recoverable write-validation stage failures. */
export const DEFAULT_WRITE_VALIDATION_MAX_RETRIES = 1;

/** Initial exponential-backoff delay for recoverable write-validation retries. */
export const DEFAULT_WRITE_VALIDATION_RETRY_BASE_DELAY_MS = 1_000;

/** Upper bound for exponential-backoff delay during write-validation retries. */
export const DEFAULT_WRITE_VALIDATION_RETRY_MAX_DELAY_MS = 5_000;

/** Feed URL used as the authenticated landing page and default screenshot baseline. */
export const WRITE_VALIDATION_FEED_URL = "https://www.linkedin.com/feed/";

/** Visibility bucket used to communicate the operator risk of a write action. */
export type WriteValidationRiskClass = "private" | "network" | "public";

/** Union of every action type supported by the Tier 3 write-validation harness. */
export type LinkedInWriteValidationActionType =
  | typeof CREATE_POST_ACTION_TYPE
  | typeof SEND_INVITATION_ACTION_TYPE
  | typeof SEND_MESSAGE_ACTION_TYPE
  | typeof FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE
  | typeof LIKE_POST_ACTION_TYPE;

/** Per-action status recorded in the final write-validation report. */
export type WriteValidationResultStatus = "pass" | "fail" | "cancelled";

/** Overall run outcome derived from the set of per-action statuses. */
export type WriteValidationOutcome = WriteValidationResultStatus;

/** Lifecycle stage used for progress events, retries, and failure attribution. */
export type WriteValidationActionStage =
  | "prepare"
  | "prompt"
  | "before_screenshot"
  | "confirm"
  | "after_screenshot"
  | "verify";

/** Public metadata advertised for one supported write-validation scenario. */
export interface LinkedInWriteValidationActionDefinition {
  actionType: LinkedInWriteValidationActionType;
  expectedOutcome: string;
  riskClass: WriteValidationRiskClass;
  summary: string;
}

/** Preview payload shown to the operator before confirming a real action. */
export interface WriteValidationActionPreview {
  action_type: LinkedInWriteValidationActionType;
  expected_outcome: string;
  outbound: Record<string, unknown>;
  risk_class: WriteValidationRiskClass;
  summary: string;
  target: Record<string, unknown>;
}

/** Verification result returned after a scenario confirms the prepared action. */
export interface WriteValidationVerificationResult {
  details: Record<string, unknown>;
  message: string;
  source: string;
  state_synced: boolean | null;
  verified: boolean;
}

/** Persisted report row describing one action attempt in a write-validation run. */
export interface WriteValidationActionResult {
  action_type: LinkedInWriteValidationActionType;
  after_screenshot_paths: string[];
  artifact_paths: string[];
  before_screenshot_paths: string[];
  cleanup_guidance: string[];
  completed_at: string;
  confirm_artifacts: string[];
  duration_ms: number;
  error_code?: LinkedInBuddyErrorCode;
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

/** Top-level report contract written to JSON, surfaced in the CLI, and rendered to HTML. */
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

/** Core API options for running the Tier 3 write-validation harness. */
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

/** Data a scenario prepare step must return for confirmation, screenshots, and verification. */
export interface ScenarioPrepareResult {
  beforeScreenshotUrl?: string;
  cleanupGuidance: string[];
  prepared: PreparedActionResult;
  verificationContext: Record<string, unknown>;
}

/** Full contract implemented by each real-action scenario in the fixed Tier 3 suite. */
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

/** Returns whether a value is a plain object rather than `null` or an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trims text and collapses internal whitespace for stable comparisons and output. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

/** Removes blank strings and duplicates while preserving the first-seen order. */
export function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/** Returns whether an artifact path points at a captured PNG screenshot. */
export function isScreenshotPath(value: string): boolean {
  return /\.png$/iu.test(value.trim());
}

/** Extracts artifact paths from a prepared-action preview payload when available. */
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

/** Normalizes a prepared action into the public preview payload shown to operators. */
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

/** Maps a verification result to the final status stored for an action. */
export function determineActionStatus(
  verification: WriteValidationVerificationResult
): WriteValidationResultStatus {
  if (!verification.verified || verification.state_synced === false) {
    return "fail";
  }

  return "pass";
}

/** Tallies pass, fail, and cancelled counts across a set of action results. */
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

/** Resolves the run outcome, with `fail` taking precedence over `cancelled` and `pass`. */
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

/** Builds the one-line human-readable summary used by Tier 3 reports and CLI output. */
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

/** Derives follow-up guidance from report paths, cleanup steps, and common failure modes. */
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

/** Writes pretty JSON with a trailing newline, creating parent directories as needed. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Projects an internal account record into the report-safe account payload. */
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
