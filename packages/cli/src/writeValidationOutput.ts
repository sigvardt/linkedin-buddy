import {
  LINKEDIN_WRITE_VALIDATION_ACTIONS,
  type JsonLogEntry,
  type LinkedInAssistantErrorPayload,
  type WriteValidationActionResult,
  type WriteValidationReport,
  type WriteValidationResultStatus
} from "@linkedin-assistant/core";

/** Output modes supported by the Tier 3 CLI formatter. */
export type WriteValidationOutputMode = "human" | "json";

/** Options for rendering the human-readable write-validation report. */
export interface FormatWriteValidationReportOptions {
  color?: boolean;
}

/** Options for rendering human-readable write-validation errors. */
export interface FormatWriteValidationErrorOptions {
  color?: boolean;
  helpCommand?: string;
}

/** Options for the stderr progress reporter that mirrors structured run events. */
export interface WriteValidationProgressReporterOptions {
  enabled?: boolean;
  writeLine?: (line: string) => void;
}

type TerminalStyle = "bold" | "cyan" | "dim" | "green" | "red" | "yellow";
type WriteValidationProgressLogEntry = Pick<JsonLogEntry, "event" | "payload">;
type WriteValidationActionStage =
  | "prepare"
  | "prompt"
  | "before_screenshot"
  | "confirm"
  | "after_screenshot"
  | "verify";

const TOTAL_WRITE_VALIDATION_ACTIONS = LINKEDIN_WRITE_VALIDATION_ACTIONS.length;
const ACTION_INDEX_BY_TYPE = new Map<string, number>(
  LINKEDIN_WRITE_VALIDATION_ACTIONS.map((action, index) => [action.actionType, index + 1])
);
const ACTION_SUMMARY_BY_TYPE = new Map<string, string>(
  LINKEDIN_WRITE_VALIDATION_ACTIONS.map((action) => [action.actionType, action.summary])
);
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+`,
  "g"
);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);
const TERMINAL_STYLE_CODES: Record<TerminalStyle, string> = {
  bold: "\u001B[1m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  yellow: "\u001B[33m"
};

function sanitizeConsoleText(value: string): string {
  const sanitized = value
    .replace(ANSI_ESCAPE_PATTERN, " ")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return sanitized.length > 0 ? sanitized : "[sanitized]";
}

function truncateForDisplay(value: string, maxLength: number = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatValueForDisplay(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeConsoleText(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return sanitizeConsoleText(JSON.stringify(value));
  } catch {
    return sanitizeConsoleText(String(value));
  }
}

function applyTextStyle(
  text: string,
  enabled: boolean,
  ...styles: TerminalStyle[]
): string {
  if (!enabled || styles.length === 0) {
    return text;
  }

  return `${styles.map((style) => TERMINAL_STYLE_CODES[style]).join("")}${text}\u001B[0m`;
}

function formatSectionTitle(title: string, color: boolean): string {
  return applyTextStyle(title, color, "bold", "cyan");
}

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatDurationMs(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "0ms";
  }

  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }

  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1)}s`;
  }

  return `${Math.round(value / 1_000)}s`;
}

function calculateDurationMs(startedAt: string, completedAt: string): number {
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);

  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return 0;
  }

  return Math.max(0, completedAtMs - startedAtMs);
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function readWarningCount(payload: Record<string, unknown>): number {
  const warnings = payload.warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning) => typeof warning === "string").length
    : 0;
}

function formatRunStatusLabel(
  outcome: WriteValidationReport["outcome"],
  color: boolean
): string {
  if (outcome === "pass") {
    return applyTextStyle("PASS", color, "bold", "green");
  }

  if (outcome === "cancelled") {
    return applyTextStyle("CANCELLED", color, "bold", "yellow");
  }

  return applyTextStyle("FAIL", color, "bold", "red");
}

function formatActionStatusLabel(
  status: WriteValidationResultStatus,
  color: boolean
): string {
  if (status === "pass") {
    return applyTextStyle("PASS", color, "bold", "green");
  }

  if (status === "cancelled") {
    return applyTextStyle("CANCELLED", color, "bold", "yellow");
  }

  return applyTextStyle("FAIL", color, "bold", "red");
}

function formatProgressStatusLabel(status: WriteValidationResultStatus): string {
  if (status === "pass") {
    return "PASS";
  }

  if (status === "cancelled") {
    return "CANCELLED";
  }

  return "FAIL";
}

function formatStateSyncLabel(stateSynced: boolean | null): string {
  if (stateSynced === null) {
    return "state=n/a";
  }

  return stateSynced ? "state=ok" : "state=failed";
}

function formatVerificationLabel(action: WriteValidationActionResult): string {
  return action.verification?.verified === true ? "verified" : "unverified";
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatArtifactPathList(
  label: string,
  artifactPaths: readonly string[]
): string[] {
  if (artifactPaths.length === 0) {
    return [];
  }

  return [`  ${label}: ${artifactPaths.map(sanitizeConsoleText).join(", ")}`];
}

function formatActionSummary(
  action: WriteValidationActionResult,
  color: boolean,
  index: number,
  total: number
): string {
  const warnings = action.warnings?.length ?? 0;
  const durationMs =
    typeof action.duration_ms === "number"
      ? action.duration_ms
      : calculateDurationMs(action.started_at, action.completed_at);
  const detailParts = [
    action.risk_class,
    formatVerificationLabel(action),
    formatStateSyncLabel(action.state_synced),
    formatDurationMs(durationMs),
    formatCountLabel(action.artifact_paths.length, "artifact")
  ];

  if (warnings > 0) {
    detailParts.push(formatCountLabel(warnings, "warning"));
  }

  if (action.error_code) {
    detailParts.push(sanitizeConsoleText(action.error_code));
  }

  return `- ${index}/${total} ${formatActionStatusLabel(action.status, color)} ${sanitizeConsoleText(action.action_type)} | ${detailParts.join(" | ")}`;
}

function formatActionDetails(action: WriteValidationActionResult): string[] {
  const detailLines = [
    `  summary: ${sanitizeConsoleText(action.summary)}`,
    `  expected: ${sanitizeConsoleText(action.expected_outcome)}`,
    `  target: ${formatValueForDisplay(action.preview?.target ?? {})}`,
    `  outbound: ${formatValueForDisplay(action.preview?.outbound ?? {})}`,
    `  started: ${sanitizeConsoleText(action.started_at)}`,
    `  completed: ${sanitizeConsoleText(action.completed_at)}`
  ];

  if (action.verification) {
    detailLines.push(
      `  verification: ${sanitizeConsoleText(action.verification.message)} (${sanitizeConsoleText(action.verification.source)})`
    );
  }

  if (action.failure_stage) {
    detailLines.push(`  stage: ${sanitizeConsoleText(action.failure_stage)}`);
  }

  if (action.error_message) {
    detailLines.push(`  error: ${sanitizeConsoleText(action.error_message)}`);
  }

  for (const warning of action.warnings ?? []) {
    detailLines.push(`  warning: ${sanitizeConsoleText(warning)}`);
  }

  for (const guidance of action.cleanup_guidance) {
    detailLines.push(`  cleanup: ${sanitizeConsoleText(guidance)}`);
  }

  detailLines.push(...formatArtifactPathList("artifacts", action.artifact_paths));
  detailLines.push(...formatArtifactPathList("before", action.before_screenshot_paths));
  detailLines.push(...formatArtifactPathList("after", action.after_screenshot_paths));
  detailLines.push(...formatArtifactPathList("confirm", action.confirm_artifacts));

  return detailLines;
}

function formatOverviewEntries(report: WriteValidationReport): string[] {
  const cleanupActionCount = report.actions.filter((action) => action.cleanup_guidance.length > 0)
    .length;
  const warningCount = report.actions.reduce((count, action) => {
    return count + (action.warnings?.length ?? 0);
  }, 0);
  const artifactCount = report.actions.reduce((count, action) => {
    return count + action.artifact_paths.length;
  }, 0);
  const durationMs =
    typeof report.duration_ms === "number"
      ? report.duration_ms
      : calculateDurationMs(report.started_at, report.checked_at);

  return [
    `- Actions: ${formatCountLabel(report.pass_count, "passed action")} | ${formatCountLabel(report.fail_count, "failed action")} | ${formatCountLabel(report.cancelled_count, "cancelled action")}`,
    `- Timing: ${formatDurationMs(durationMs)} total | cooldown ${formatDurationMs(report.cooldown_ms)}`,
    `- Side effects: ${formatCountLabel(cleanupActionCount, "action needs cleanup", "actions need cleanup")} | ${formatCountLabel(artifactCount, "artifact")} | ${formatCountLabel(warningCount, "warning")}`,
    `- Snapshot: latest ${sanitizeConsoleText(report.latest_report_path)}`
  ];
}

function formatRecommendations(report: WriteValidationReport): string[] {
  return report.recommended_actions.map((action) => `- ${sanitizeConsoleText(action)}`);
}

function formatReportPaths(report: WriteValidationReport): string[] {
  const entries = [
    `- Report JSON: ${sanitizeConsoleText(report.report_path)}`,
    `- Audit log: ${sanitizeConsoleText(report.audit_log_path)}`,
    `- Latest snapshot: ${sanitizeConsoleText(report.latest_report_path)}`
  ];

  if (report.html_report_path) {
    entries.splice(1, 0, `- Report HTML: ${sanitizeConsoleText(report.html_report_path)}`);
  }

  return entries;
}

function formatErrorDetailEntries(details: Record<string, unknown>): string[] {
  return Object.entries(details)
    .filter(([key]) => key !== "raw_error" && key !== "startup_validation")
    .map(([key, value]) => `- ${sanitizeConsoleText(key)}: ${formatValueForDisplay(value)}`);
}

function readAccountId(details: Record<string, unknown>): string | null {
  const accountId = details.account_id ?? details.account;
  return typeof accountId === "string" && accountId.trim().length > 0
    ? sanitizeConsoleText(accountId)
    : null;
}

function readConfigPath(details: Record<string, unknown>): string | null {
  const configPath = details.config_path;
  return typeof configPath === "string" && configPath.trim().length > 0
    ? sanitizeConsoleText(configPath)
    : null;
}

function readSessionName(details: Record<string, unknown>): string | null {
  const sessionName = details.session_name;
  return typeof sessionName === "string" && sessionName.trim().length > 0
    ? sanitizeConsoleText(sessionName)
    : null;
}

function readMissingTargetKey(details: Record<string, unknown>): string | null {
  const missingTargetKey = details.missing_target_key;
  return typeof missingTargetKey === "string" && missingTargetKey.trim().length > 0
    ? sanitizeConsoleText(missingTargetKey)
    : null;
}

function buildMissingTargetSuggestion(
  missingTargetKey: string,
  accountId: string,
  sessionName: string,
  configPath: string | null
): string {
  const configSuffix = configPath ? ` or update ${configPath} manually.` : ".";

  switch (missingTargetKey) {
    case "send_message":
      return `Add an approved message thread with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName} --message-thread /messaging/thread/<id>/ --force"${configSuffix}`;
    case "connections.send_invitation":
      return `Add an approved invitation target with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName} --invite-profile https://www.linkedin.com/in/<slug>/ --force"${configSuffix}`;
    case "network.followup_after_accept":
      return `Add an approved follow-up target with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName} --followup-profile https://www.linkedin.com/in/<slug>/ --force"${configSuffix}`;
    case "feed.like_post":
      return `Add an approved reaction target with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName} --reaction-post https://www.linkedin.com/feed/update/urn:li:activity:<id>/ --reaction like --force"${configSuffix}`;
    case "post.create":
      return `Set post visibility with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName} --post-visibility connections --force" or rely on the default "connections" visibility${configSuffix}`;
    default:
      return `Add the missing approved target to the write-validation account config for ${accountId}${configSuffix}`;
  }
}

function formatWriteValidationSuggestion(
  error: LinkedInAssistantErrorPayload
): string {
  const sessionName = readSessionName(error.details) ?? "secondary-session";
  const accountId = readAccountId(error.details) ?? "secondary";
  const configPath = readConfigPath(error.details);
  const missingTargetKey = readMissingTargetKey(error.details);

  switch (error.code) {
    case "ACTION_PRECONDITION_FAILED": {
      if (missingTargetKey) {
        return buildMissingTargetSuggestion(
          missingTargetKey,
          accountId,
          sessionName,
          configPath
        );
      }

      if (error.message.includes('requires "--account <id>"')) {
        return "Choose a registered secondary account and rerun with --write-validation --account <id>.";
      }

      if (error.message.includes('Remove "--session"')) {
        return "Rerun without --session. Write validation always uses the stored session from the account registry.";
      }

      if (error.message.includes('typing "yes"')) {
        return "Keep per-action confirmations enabled. The harness intentionally requires typing yes for each real action.";
      }

      if (error.message.includes("interactive terminal") || error.message.includes("visible browser")) {
        return "Run the harness locally from an interactive terminal with a visible browser window.";
      }

      if (error.message.includes("cannot run in CI")) {
        return "Run the harness manually outside CI from a local interactive terminal.";
      }

      if (error.message.includes("No write-validation account named")) {
        return `Register the account with "linkedin accounts add ${accountId} --designation secondary --session ${sessionName}" or update ${configPath ?? "config.json"}.`;
      }

      return "Review the command flags, approved targets, and stored session configuration, then rerun the harness.";
    }
    case "AUTH_REQUIRED":
      return `Capture a fresh stored session with "linkedin auth session --session ${sessionName}" and rerun.`;
    case "CAPTCHA_OR_CHALLENGE":
      return "Complete the LinkedIn challenge in a manual browser session, capture a fresh stored session, and rerun.";
    case "RATE_LIMITED":
      return "Wait for the session to cool down, then rerun. If this happens often, increase --cooldown-seconds or reduce how frequently you run the harness.";
    case "NETWORK_ERROR":
      return "Check browser and network connectivity, then rerun. If LinkedIn is flaky, keep retries enabled and try again later.";
    case "TIMEOUT":
      return "Rerun with a larger --timeout-seconds value after confirming the stored session still loads LinkedIn normally.";
    case "TARGET_NOT_FOUND":
      return "Confirm the approved LinkedIn target still exists, update the account registry if needed, and rerun.";
    case "UI_CHANGED_SELECTOR_FAILED":
      return "Open the HTML report or screenshots, update the validator selectors, and rerun the harness.";
    default:
      return "Rerun the command. If it keeps failing, review the audit log or rerun with --json for the structured payload.";
  }
}

function describeActionStage(stage: WriteValidationActionStage): string {
  switch (stage) {
    case "prepare":
      return "preparing the approved action";
    case "prompt":
      return "waiting for operator confirmation";
    case "before_screenshot":
      return "capturing the before screenshot";
    case "confirm":
      return "executing the live action";
    case "after_screenshot":
      return "capturing the after screenshot";
    case "verify":
      return "verifying the LinkedIn outcome";
  }

  return "processing the action";
}

function formatProgressIndex(actionType: string): string {
  const index = ACTION_INDEX_BY_TYPE.get(actionType);
  return typeof index === "number"
    ? `${index}/${TOTAL_WRITE_VALIDATION_ACTIONS}`
    : `?/${TOTAL_WRITE_VALIDATION_ACTIONS}`;
}

/** Turns structured write-validation log events into concise operator progress lines. */
export class WriteValidationProgressReporter {
  private readonly enabled: boolean;
  private readonly writeLine: (line: string) => void;
  private readonly lastStageByAction = new Map<string, WriteValidationActionStage>();

  constructor(options: WriteValidationProgressReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.writeLine = options.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  handleLog(entry: WriteValidationProgressLogEntry): void {
    if (!this.enabled) {
      return;
    }

    if (entry.event === "write_validation.start") {
      const accountId = readString(entry.payload, "account_id") ?? "secondary";
      const cooldownMs = readNumber(entry.payload, "cooldown_ms");
      const timeoutMs = readNumber(entry.payload, "timeout_ms");
      const summaryParts = [formatCountLabel(TOTAL_WRITE_VALIDATION_ACTIONS, "action")];

      if (cooldownMs !== null) {
        summaryParts.push(`cooldown ${formatDurationMs(cooldownMs)}`);
      }

      if (timeoutMs !== null) {
        summaryParts.push(`timeout ${formatDurationMs(timeoutMs)}`);
      }

      this.writeLine(
        `Starting write validation for account ${sanitizeConsoleText(accountId)} (${summaryParts.join(", ")}).`
      );
      return;
    }

    if (entry.event === "write_validation.action.start") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const summary = ACTION_SUMMARY_BY_TYPE.get(actionType);
      this.writeLine(
        `Running ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)}${summary ? ` — ${truncateForDisplay(sanitizeConsoleText(summary), 110)}` : ""}`
      );
      return;
    }

    if (entry.event === "write_validation.action.attempt") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const stage = readString(entry.payload, "stage");
      const attempt = readNumber(entry.payload, "attempt") ?? 1;

      if (!stage || attempt !== 1) {
        return;
      }

      const normalizedStage = stage as WriteValidationActionStage;
      if (this.lastStageByAction.get(actionType) === normalizedStage) {
        return;
      }

      this.lastStageByAction.set(actionType, normalizedStage);
      this.writeLine(
        `${formatProgressIndex(actionType)} ${sanitizeConsoleText(actionType)} — ${describeActionStage(normalizedStage)}...`
      );
      return;
    }

    if (entry.event === "write_validation.action.prepared") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const retryCount = readNumber(entry.payload, "retry_count") ?? 0;
      this.writeLine(
        `Ready ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} — preview shown${retryCount > 0 ? ` after ${formatCountLabel(retryCount, "retry")}` : ""}; waiting for yes.`
      );
      return;
    }

    if (entry.event === "write_validation.action.retry") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const attempt = readNumber(entry.payload, "attempt") ?? 1;
      const maxAttempts = readNumber(entry.payload, "max_attempts") ?? attempt + 1;
      const backoffMs = readNumber(entry.payload, "backoff_ms");
      const code = readString(entry.payload, "code") ?? "UNKNOWN";
      const nextAttempt = Math.min(maxAttempts, attempt + 1);
      this.writeLine(
        `Retrying ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} — ${sanitizeConsoleText(code)}; waiting ${formatDurationMs(backoffMs ?? 0)} before attempt ${nextAttempt}/${maxAttempts}.`
      );
      return;
    }

    if (entry.event === "write_validation.action.degraded") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const stage = readString(entry.payload, "stage");
      const errorMessage = readString(entry.payload, "error_message") ?? "degraded but continuing";
      this.writeLine(
        `Warning ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)}${stage ? ` (${sanitizeConsoleText(stage)})` : ""} — ${truncateForDisplay(sanitizeConsoleText(errorMessage), 140)}.`
      );
      return;
    }

    if (entry.event === "write_validation.action.cancelled") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      this.writeLine(
        `Cancelled ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} by operator.`
      );
      return;
    }

    if (entry.event === "write_validation.action.completed") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const status = readString(entry.payload, "status") as WriteValidationResultStatus | null;
      const verified = readBoolean(entry.payload, "verified");
      const warningCount = readWarningCount(entry.payload);
      const detailParts = [
        verified === true ? "verified" : "needs review"
      ];
      if (warningCount > 0) {
        detailParts.push(formatCountLabel(warningCount, "warning"));
      }
      this.writeLine(
        `Finished ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} — ${formatProgressStatusLabel(status ?? "pass")}${detailParts.length > 0 ? ` | ${detailParts.join(" | ")}` : ""}`
      );
      return;
    }

    if (entry.event === "write_validation.action.failed") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const code = readString(entry.payload, "code");
      const failureStage = readString(entry.payload, "failure_stage");
      const detailParts = [
        ...(failureStage ? [sanitizeConsoleText(failureStage)] : []),
        ...(code ? [sanitizeConsoleText(code)] : [])
      ];
      this.writeLine(
        `Finished ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} — FAIL${detailParts.length > 0 ? ` | ${detailParts.join(" | ")}` : ""}`
      );
      return;
    }

    if (entry.event === "write_validation.cooldown.start") {
      const cooldownMs = readNumber(entry.payload, "cooldown_ms") ?? 0;
      this.writeLine(`Cooling down for ${formatDurationMs(cooldownMs)} before the next action...`);
      return;
    }

    if (entry.event === "write_validation.stopped_early") {
      const actionType = readString(entry.payload, "action_type") ?? "unknown";
      const code = readString(entry.payload, "code") ?? "UNKNOWN";
      const remainingActions = readNumber(entry.payload, "remaining_actions") ?? 0;
      this.writeLine(
        `Stopping early after ${formatProgressIndex(actionType)}: ${sanitizeConsoleText(actionType)} [${sanitizeConsoleText(code)}]; ${formatCountLabel(remainingActions, "remaining action")} marked cancelled.`
      );
      return;
    }

    if (entry.event === "write_validation.completed") {
      const passCount = readNumber(entry.payload, "pass_count") ?? 0;
      const failCount = readNumber(entry.payload, "fail_count") ?? 0;
      const cancelledCount = readNumber(entry.payload, "cancelled_count") ?? 0;
      const reportPath = readString(entry.payload, "report_path");
      this.writeLine(
        `Write validation finished — ${passCount} passed, ${failCount} failed, ${cancelledCount} cancelled${reportPath ? `. Report: ${sanitizeConsoleText(reportPath)}` : "."}`
      );
    }
  }
}

/** Resolves whether Tier 3 should emit human text or JSON for the current stdout target. */
export function resolveWriteValidationOutputMode(
  input: { json?: boolean },
  stdoutIsTty: boolean
): WriteValidationOutputMode {
  if (input.json || !stdoutIsTty) {
    return "json";
  }

  return "human";
}

/** Formats the final Tier 3 report for human-readable CLI output. */
export function formatWriteValidationReport(
  report: WriteValidationReport,
  options: FormatWriteValidationReportOptions = {}
): string {
  const color = options.color === true;
  const durationMs =
    typeof report.duration_ms === "number"
      ? report.duration_ms
      : calculateDurationMs(report.started_at, report.checked_at);
  const lines = [
    `${formatSectionTitle("Write Validation", color)} ${formatRunStatusLabel(report.outcome, color)}`,
    `Account: ${sanitizeConsoleText(report.account.label)} [${sanitizeConsoleText(report.account.id)} / ${sanitizeConsoleText(report.account.designation)}]`,
    `Summary: ${sanitizeConsoleText(report.summary)}`,
    `Run: ${sanitizeConsoleText(report.run_id)} | Started ${sanitizeConsoleText(report.started_at)} | Finished ${sanitizeConsoleText(report.checked_at)} | Duration ${formatDurationMs(durationMs)}`,
    `Warning: ${sanitizeConsoleText(report.warning)}`
  ];

  appendSection(lines, formatSectionTitle("Overview", color), formatOverviewEntries(report));
  appendSection(lines, formatSectionTitle("Reports", color), formatReportPaths(report));
  appendSection(
    lines,
    formatSectionTitle("Actions", color),
    report.actions.flatMap((action, index) => [
      formatActionSummary(action, color, index + 1, report.actions.length),
      ...formatActionDetails(action)
    ])
  );
  appendSection(
    lines,
    formatSectionTitle("Recommendations", color),
    formatRecommendations(report)
  );

  return lines.join("\n");
}

/** Formats a structured write-validation failure into human-readable CLI guidance. */
export function formatWriteValidationError(
  error: LinkedInAssistantErrorPayload,
  options: FormatWriteValidationErrorOptions = {}
): string {
  const color = options.color === true;
  const helpCommand = options.helpCommand ?? "linkedin test live --help";
  const lines = [
    `${applyTextStyle("Write validation failed", color, "bold", "red")} [${sanitizeConsoleText(error.code)}]`,
    sanitizeConsoleText(error.message),
    `Suggested fix: ${formatWriteValidationSuggestion(error)}`
  ];

  appendSection(lines, formatSectionTitle("Details", color), formatErrorDetailEntries(error.details));
  appendSection(lines, formatSectionTitle("Help", color), [
    `- Re-run ${sanitizeConsoleText(helpCommand)} for usage, safety guidance, and examples.`,
    "- Review docs/write-validation.md for account setup, approved-target examples, and report details.",
    "- Rerun with --json if you need the structured error payload for automation or debugging."
  ]);

  return lines.join("\n");
}
