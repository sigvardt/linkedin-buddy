import {
  LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS,
  type JsonLogEntry,
  type LinkedInReadOnlyValidationOperationId,
  type LinkedInBuddyErrorPayload,
  type ReadOnlyValidationDiffChange,
  type ReadOnlyValidationDiffEntry,
  type ReadOnlyValidationOperationResult,
  type ReadOnlyValidationReport,
  type ReadOnlyValidationStatus
} from "@linkedin-buddy/core";

/**
 * Console output modes supported by the live validation CLI.
 */
export type ReadOnlyValidationOutputMode = "human" | "json";

/**
 * Rendering options for the human-readable live validation report.
 */
export interface FormatReadOnlyValidationReportOptions {
  /** Enable ANSI colors in the formatted output. */
  color?: boolean;
}

/**
 * Rendering options for the human-readable live validation error summary.
 */
export interface FormatReadOnlyValidationErrorOptions {
  /** Enable ANSI colors in the formatted output. */
  color?: boolean;

  /** Help command shown in the final remediation hint. */
  helpCommand?: string;
}

/**
 * Options for the progress reporter that mirrors structured log events to the
 * terminal.
 */
export interface ReadOnlyValidationProgressReporterOptions {
  /** Disable all progress output when set to `false`. */
  enabled?: boolean;

  /** Custom line writer used by tests or alternative terminals. */
  writeLine?: (line: string) => void;
}

const BLOCKED_REQUEST_PREVIEW_LIMIT = 5;
const TOTAL_READ_ONLY_OPERATIONS = LINKEDIN_READ_ONLY_VALIDATION_OPERATIONS.length;
const DIFF_CHANGE_LABELS: Record<ReadOnlyValidationDiffChange, string> = {
  fallback_drift: "Selector drift",
  new_failure: "New failure",
  recovered: "Recovered"
};
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+`,
  "g"
);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);

type TerminalStyle = "bold" | "dim" | "red" | "green" | "yellow" | "cyan";

type ReadOnlyValidationProgressLogEntry = Pick<JsonLogEntry, "event" | "payload">;

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
    .replace(/\s+/g, " ")
    .trim();

  return sanitized.length > 0 ? sanitized : "[sanitized]";
}

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatValueForDisplay(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeConsoleText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || value === undefined) {
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

  const prefix = styles.map((style) => TERMINAL_STYLE_CODES[style]).join("");
  return `${prefix}${text}\u001B[0m`;
}

function formatSectionTitle(title: string, color: boolean): string {
  return applyTextStyle(title, color, "bold", "cyan");
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 1_000) {
    return `${Math.max(0, Math.round(value))}ms`;
  }

  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readWarningCount(payload: Record<string, unknown>): number {
  const warnings = payload.warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning) => typeof warning === "string").length
    : 0;
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function isMixedValidationReport(report: ReadOnlyValidationReport): boolean {
  return report.pass_count > 0 && report.fail_count > 0;
}

function formatRunStatusLabel(
  report: ReadOnlyValidationReport,
  color: boolean
): string {
  if (isMixedValidationReport(report)) {
    return applyTextStyle("MIXED", color, "bold", "yellow");
  }

  return report.outcome === "fail"
    ? applyTextStyle("FAIL", color, "bold", "red")
    : applyTextStyle("PASS", color, "bold", "green");
}

function formatOperationStatusLabel(
  status: ReadOnlyValidationStatus,
  color: boolean
): string {
  return status === "fail"
    ? applyTextStyle("FAIL", color, "bold", "red")
    : applyTextStyle("PASS", color, "bold", "green");
}

function formatProgressStatusLabel(
  status: ReadOnlyValidationStatus,
  warningCount: number,
  color: boolean
): string {
  if (status === "fail") {
    return applyTextStyle("FAIL", color, "bold", "red");
  }

  if (warningCount > 0) {
    return applyTextStyle("WARN", color, "bold", "yellow");
  }

  return applyTextStyle("PASS", color, "bold", "green");
}

function formatOperationSummary(
  operation: ReadOnlyValidationOperationResult,
  color: boolean
): string {
  const warningSuffix = operation.warnings.length > 0
    ? ` | ${operation.warnings.length} warning${operation.warnings.length === 1 ? "" : "s"}`
    : "";
  const retrySuffix = operation.attempt_count > 1
    ? ` | ${operation.attempt_count} attempts`
    : "";
  const errorSuffix = operation.error_code ? ` | ${operation.error_code}` : "";
  return `- ${formatOperationStatusLabel(operation.status, color)} ${sanitizeConsoleText(operation.operation)}: ${operation.matched_count} matched, ${operation.failed_count} failed, ${formatDurationMs(operation.page_load_ms)}${warningSuffix}${retrySuffix}${errorSuffix}`;
}

function formatDiffEntry(entry: ReadOnlyValidationDiffEntry): string {
  const previousCandidate = entry.previous_candidate_key ?? "none";
  const currentCandidate = entry.current_candidate_key ?? "none";

  return `- ${DIFF_CHANGE_LABELS[entry.change]}: ${sanitizeConsoleText(entry.operation)}/${sanitizeConsoleText(entry.selector_key)} (${sanitizeConsoleText(previousCandidate)} → ${sanitizeConsoleText(currentCandidate)})`;
}

function formatBlockedRequests(
  blockedRequests: ReadOnlyValidationReport["blocked_requests"]
): string[] {
  return blockedRequests.slice(0, BLOCKED_REQUEST_PREVIEW_LIMIT).map((blockedRequest) => {
    return `- ${sanitizeConsoleText(blockedRequest.method)} ${sanitizeConsoleText(blockedRequest.url)} [${sanitizeConsoleText(blockedRequest.reason)}]`;
  });
}

function formatFailedSelectorBlocks(
  operations: ReadOnlyValidationReport["operations"]
): string[] {
  return operations.flatMap((operation) => {
    if (operation.error_code) {
      return [];
    }

    return operation.selector_results
      .filter((selectorResult) => selectorResult.status === "fail")
      .map((selectorResult) => {
        return `- ${sanitizeConsoleText(operation.operation)}/${sanitizeConsoleText(selectorResult.selector_key)} — ${sanitizeConsoleText(selectorResult.error ?? "No selector candidate matched.")}`;
      });
  });
}

function formatOperationWarnings(
  operations: ReadOnlyValidationReport["operations"]
): string[] {
  return operations.flatMap((operation) => {
    return operation.warnings.map((warning) => {
      return `- ${sanitizeConsoleText(operation.operation)} — ${sanitizeConsoleText(warning)}`;
    });
  });
}

function formatOperationErrors(
  operations: ReadOnlyValidationReport["operations"]
): string[] {
  return operations.flatMap((operation) => {
    if (!operation.error_code || !operation.error_message) {
      return [];
    }

    return [
      `- ${sanitizeConsoleText(operation.operation)} [${sanitizeConsoleText(operation.error_code)}] — ${sanitizeConsoleText(operation.error_message)}`
    ];
  });
}

function formatOverviewEntries(report: ReadOnlyValidationReport): string[] {
  const warningCount = report.operations.reduce((count, operation) => {
    return count + operation.warnings.length;
  }, 0);
  const overviewEntries = [
    `- Operations: ${formatCountLabel(report.pass_count, "passed operation")} | ${formatCountLabel(report.fail_count, "failed operation")} | ${formatCountLabel(warningCount, "warning")}`,
    `- Requests: ${report.request_limits.used_requests}/${report.request_limits.max_requests} used | ${formatCountLabel(report.blocked_request_count, "blocked request")}`,
    `- Selector diff: ${formatCountLabel(report.diff.regressions.length, "regression")} | ${formatCountLabel(report.diff.recoveries.length, "recovery")} | ${formatCountLabel(report.diff.unchanged_count, "unchanged selector")}`
  ];

  if (isMixedValidationReport(report)) {
    overviewEntries.unshift(
      "- Mixed result: at least one validation step passed and at least one failed in the same run."
    );
  }

  if (report.operation_count < TOTAL_READ_ONLY_OPERATIONS) {
    overviewEntries.push(
      `- Coverage: ${report.operation_count}/${TOTAL_READ_ONLY_OPERATIONS} steps ran before the validation stopped early.`
    );
  }

  if (report.request_limits.max_requests_reached) {
    overviewEntries.push(
      "- Request cap reached: the run stopped when the configured request budget was exhausted."
    );
  }

  return overviewEntries;
}

function formatBlockedRequestEntries(report: ReadOnlyValidationReport): string[] {
  const entries = [
    `- ${formatCountLabel(report.blocked_request_count, "request")} blocked by the read-only guard`,
    ...formatBlockedRequests(report.blocked_requests)
  ];

  if (report.blocked_request_count > BLOCKED_REQUEST_PREVIEW_LIMIT) {
    entries.push(
      `- ${report.blocked_request_count - BLOCKED_REQUEST_PREVIEW_LIMIT} more blocked request${report.blocked_request_count - BLOCKED_REQUEST_PREVIEW_LIMIT === 1 ? "" : "s"} recorded in the report JSON.`
    );
  }

  return entries;
}

function formatErrorDetailEntries(details: Record<string, unknown>): string | null {
  const detailEntries = Object.entries(details);

  if (detailEntries.length === 0) {
    return null;
  }

  return detailEntries
    .map(([key, value]) => `${key}=${formatValueForDisplay(value)}`)
    .join(", ");
}

function readSessionName(details: Record<string, unknown>): string | null {
  const sessionName = details.session_name;
  return typeof sessionName === "string" && sessionName.trim().length > 0
    ? sanitizeConsoleText(sessionName)
    : null;
}

function formatReadOnlyValidationSuggestion(
  payload: LinkedInBuddyErrorPayload
): string {
  switch (payload.code) {
    case "ACTION_PRECONDITION_FAILED":
      return "Review the command flags, fix the precondition, and rerun the validation.";
    case "AUTH_REQUIRED": {
      const sessionName = readSessionName(payload.details) ?? "default";
      return `Capture a fresh stored session with "linkedin auth session --session ${sessionName}" and rerun.`;
    }
    case "CAPTCHA_OR_CHALLENGE":
      return "Complete the LinkedIn challenge in a manual browser session, capture a fresh stored session, and rerun.";
    case "NETWORK_ERROR":
      return "Check browser/network connectivity, then rerun. If LinkedIn is flaky, keep retries enabled or increase the retry window.";
    case "RATE_LIMITED":
      return "Wait for the session to cool down, then rerun. If this happens often, raise --min-interval-ms or lower the workload per run.";
    case "TIMEOUT":
      return "Rerun with a larger --timeout-seconds value after confirming the stored session still loads LinkedIn normally.";
    default:
      return "Rerun the command. If it keeps failing, inspect the event log or rerun with --json for the structured payload.";
  }
}

function formatProgressIndex(index: number): string {
  return `${index}/${TOTAL_READ_ONLY_OPERATIONS}`;
}

function readOperationId(
  payload: Record<string, unknown>
): LinkedInReadOnlyValidationOperationId | null {
  const operation = payload.operation;
  return typeof operation === "string"
    ? (operation as LinkedInReadOnlyValidationOperationId)
    : null;
}

/**
 * Converts structured live validation log events into concise terminal progress
 * lines.
 */
export class ReadOnlyValidationProgressReporter {
  private readonly enabled: boolean;
  private readonly writeLine: (line: string) => void;
  private readonly operationIndexes = new Map<string, number>();
  private nextOperationIndex = 1;

  constructor(options: ReadOnlyValidationProgressReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.writeLine = options.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  /**
   * Feeds one structured live validation log entry into the progress renderer.
   */
  handleLog(entry: ReadOnlyValidationProgressLogEntry): void {
    if (!this.enabled) {
      return;
    }

    if (entry.event === "live_validation.start") {
      const sessionName = readString(entry.payload, "session_name") ?? "default";
      const maxRequests = readNumber(entry.payload, "max_requests");
      const minIntervalMs = readNumber(entry.payload, "min_interval_ms");
      const summaryParts = [formatCountLabel(TOTAL_READ_ONLY_OPERATIONS, "step")];

      if (maxRequests !== null) {
        summaryParts.push(`request cap ${maxRequests}`);
      }

      if (minIntervalMs !== null) {
        summaryParts.push(`min interval ${formatDurationMs(minIntervalMs)}`);
      }

      this.writeLine(
        `Starting live validation for session ${sanitizeConsoleText(sessionName)} (${summaryParts.join(", ")}).`
      );
      return;
    }

    if (entry.event === "live_validation.operation.start") {
      const operation = readOperationId(entry.payload) ?? "feed";
      const operationIndex = this.getOperationIndex(operation);
      this.writeLine(
        `Checking ${formatProgressIndex(operationIndex)}: ${sanitizeConsoleText(operation)}...`
      );
      return;
    }

    if (
      entry.event === "live_validation.operation.done" ||
      entry.event === "live_validation.operation.degraded"
    ) {
      const operation = readOperationId(entry.payload) ?? "feed";
      const operationIndex = this.getOperationIndex(operation);
      const status = readString(entry.payload, "status") === "fail" ? "fail" : "pass";
      const warningCount = readWarningCount(entry.payload);
      const lineParts = [
        `Finished ${formatProgressIndex(operationIndex)}: ${sanitizeConsoleText(operation)} — ${formatProgressStatusLabel(status, warningCount, false)}`
      ];
      const matchedCount = readNumber(entry.payload, "matched_count");
      const failedCount = readNumber(entry.payload, "failed_count");
      const pageLoadMs = readNumber(entry.payload, "page_load_ms");
      const attemptCount = readNumber(entry.payload, "attempt_count");
      const detailParts: string[] = [];

      if (matchedCount !== null) {
        detailParts.push(`${matchedCount} matched`);
      }

      if (failedCount !== null) {
        detailParts.push(`${failedCount} failed`);
      }

      if (pageLoadMs !== null) {
        detailParts.push(formatDurationMs(pageLoadMs));
      }

      if (warningCount > 0) {
        detailParts.push(formatCountLabel(warningCount, "warning"));
      }

      if (attemptCount !== null && attemptCount > 1) {
        detailParts.push(formatCountLabel(attemptCount, "attempt"));
      }

      if (detailParts.length > 0) {
        lineParts.push(`| ${detailParts.join(" | ")}`);
      }

      this.writeLine(lineParts.join(" "));
      return;
    }

    if (entry.event === "live_validation.operation.failed") {
      const operation = readOperationId(entry.payload) ?? "feed";
      const operationIndex = this.getOperationIndex(operation);
      const code = readString(entry.payload, "code");
      const pageLoadMs = readNumber(entry.payload, "page_load_ms");
      const attemptCount = readNumber(entry.payload, "attempt_count");
      const warningCount = readWarningCount(entry.payload);
      const detailParts: string[] = [];

      if (code) {
        detailParts.push(sanitizeConsoleText(code));
      }

      if (attemptCount !== null) {
        detailParts.push(formatCountLabel(attemptCount, "attempt"));
      }

      if (pageLoadMs !== null) {
        detailParts.push(formatDurationMs(pageLoadMs));
      }

      if (warningCount > 0) {
        detailParts.push(formatCountLabel(warningCount, "warning"));
      }

      this.writeLine(
        `Finished ${formatProgressIndex(operationIndex)}: ${sanitizeConsoleText(operation)} — FAIL${detailParts.length > 0 ? ` | ${detailParts.join(" | ")}` : ""}`
      );
      return;
    }

    if (entry.event === "live_validation.stopped_early") {
      const operation = readOperationId(entry.payload) ?? "feed";
      const operationIndex = this.getOperationIndex(operation);
      const code = readString(entry.payload, "code") ?? "UNKNOWN";
      const remainingOperations = readNumber(entry.payload, "remaining_operations") ?? 0;
      this.writeLine(
        `Stopping early after ${formatProgressIndex(operationIndex)}: ${sanitizeConsoleText(operation)} [${sanitizeConsoleText(code)}] left ${formatCountLabel(remainingOperations, "remaining step")}.`
      );
      return;
    }

    if (entry.event === "live_validation.done") {
      const passCount = readNumber(entry.payload, "pass_count") ?? 0;
      const failCount = readNumber(entry.payload, "fail_count") ?? 0;
      const reportPath = readString(entry.payload, "report_path");
      this.writeLine(
        `Live validation finished — ${passCount} passed, ${failCount} failed${reportPath ? `. Report: ${sanitizeConsoleText(reportPath)}` : "."}`
      );
    }
  }

  private getOperationIndex(operation: string): number {
    const existing = this.operationIndexes.get(operation);
    if (existing !== undefined) {
      return existing;
    }

    const operationIndex = this.nextOperationIndex;
    this.operationIndexes.set(operation, operationIndex);
    this.nextOperationIndex += 1;
    return operationIndex;
  }
}

/**
 * Resolves whether the CLI should print the human-readable report or the raw
 * structured JSON payload.
 */
export function resolveReadOnlyValidationOutputMode(
  options: { json: boolean },
  isInteractiveOutput: boolean
): ReadOnlyValidationOutputMode {
  return options.json || !isInteractiveOutput ? "json" : "human";
}

/**
 * Formats a structured live validation report for human-readable terminal
 * output.
 */
export function formatReadOnlyValidationReport(
  report: ReadOnlyValidationReport,
  options: FormatReadOnlyValidationReportOptions = {}
): string {
  const color = options.color ?? false;
  const lines = [
    `${formatSectionTitle("Live Validation", color)}: ${formatRunStatusLabel(report, color)}`,
    `Summary: ${sanitizeConsoleText(report.summary)}`,
    `Session: ${sanitizeConsoleText(report.session.session_name)} (captured ${sanitizeConsoleText(report.session.captured_at)})`,
    `Report JSON: ${sanitizeConsoleText(report.report_path)}`,
    `Events: ${sanitizeConsoleText(report.events_path)}`
  ];

  appendSection(
    lines,
    formatSectionTitle("Overview", color),
    formatOverviewEntries(report)
  );

  appendSection(
    lines,
    formatSectionTitle("Operations", color),
    report.operations.map((operation) => formatOperationSummary(operation, color))
  );

  appendSection(
    lines,
    formatSectionTitle("Warnings", color),
    formatOperationWarnings(report.operations)
  );
  appendSection(
    lines,
    formatSectionTitle("Operation Errors", color),
    formatOperationErrors(report.operations)
  );
  appendSection(
    lines,
    formatSectionTitle("Failures", color),
    formatFailedSelectorBlocks(report.operations)
  );
  appendSection(
    lines,
    formatSectionTitle("Regressions", color),
    report.diff.regressions.map((entry) => formatDiffEntry(entry))
  );
  appendSection(
    lines,
    formatSectionTitle("Recoveries", color),
    report.diff.recoveries.map((entry) => formatDiffEntry(entry))
  );

  if (report.blocked_request_count > 0) {
    appendSection(
      lines,
      formatSectionTitle("Blocked Requests", color),
      formatBlockedRequestEntries(report)
    );
  }

  appendSection(
    lines,
    formatSectionTitle("Next Steps", color),
    report.recommended_actions.map((action) => `- ${sanitizeConsoleText(action)}`)
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Formats a structured live validation failure into a concise operator-facing
 * error summary.
 */
export function formatReadOnlyValidationError(
  payload: LinkedInBuddyErrorPayload,
  options: FormatReadOnlyValidationErrorOptions = {}
): string {
  const color = options.color ?? false;
  const helpCommand = options.helpCommand ?? "linkedin test live --help";
  const lines = [
    applyTextStyle(`Live validation failed [${payload.code}]`, color, "bold", "red"),
    sanitizeConsoleText(payload.message),
    `Suggested fix: ${formatReadOnlyValidationSuggestion(payload)}`
  ];

  const detailSummary = formatErrorDetailEntries(payload.details);

  if (detailSummary) {
    lines.push(`Details: ${detailSummary}`);
  }

  lines.push(
    `Tip: run ${helpCommand} for usage and exit codes, or rerun with --json for the structured error payload.`
  );

  return lines.join("\n");
}
