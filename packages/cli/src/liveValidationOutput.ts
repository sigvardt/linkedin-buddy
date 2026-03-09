import type {
  LinkedInAssistantErrorPayload,
  ReadOnlyValidationDiffChange,
  ReadOnlyValidationDiffEntry,
  ReadOnlyValidationOperationResult,
  ReadOnlyValidationReport,
  ReadOnlyValidationStatus
} from "@linkedin-assistant/core";

export type ReadOnlyValidationOutputMode = "human" | "json";
const BLOCKED_REQUEST_PREVIEW_LIMIT = 5;
const DIFF_CHANGE_LABELS: Record<ReadOnlyValidationDiffChange, string> = {
  fallback_drift: "Selector drift",
  new_failure: "New failure",
  recovered: "Recovered"
};

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatStatusLabel(status: ReadOnlyValidationStatus): string {
  return status === "fail" ? "FAIL" : "PASS";
}

function formatOperationSummary(operation: ReadOnlyValidationOperationResult): string {
  const warningSuffix = operation.warnings.length > 0
    ? ` | ${operation.warnings.length} warning${operation.warnings.length === 1 ? "" : "s"}`
    : "";
  const retrySuffix = operation.attempt_count > 1
    ? ` | ${operation.attempt_count} attempts`
    : "";
  const errorSuffix = operation.error_code ? ` | ${operation.error_code}` : "";
  return `- ${formatStatusLabel(operation.status)} ${operation.operation}: ${operation.matched_count} matched, ${operation.failed_count} failed, ${operation.page_load_ms}ms${warningSuffix}${retrySuffix}${errorSuffix}`;
}

function formatDiffEntry(entry: ReadOnlyValidationDiffEntry): string {
  const previousCandidate = entry.previous_candidate_key ?? "none";
  const currentCandidate = entry.current_candidate_key ?? "none";

  return `- ${DIFF_CHANGE_LABELS[entry.change]}: ${entry.operation}/${entry.selector_key} (${previousCandidate} → ${currentCandidate})`;
}

function formatBlockedRequests(
  blockedRequests: ReadOnlyValidationReport["blocked_requests"]
): string[] {
  return blockedRequests.slice(0, BLOCKED_REQUEST_PREVIEW_LIMIT).map((blockedRequest) => {
    return `- ${blockedRequest.method} ${blockedRequest.url} [${blockedRequest.reason}]`;
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
        return `- ${operation.operation}/${selectorResult.selector_key} — ${selectorResult.error ?? "No selector candidate matched."}`;
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

    return [`- ${operation.operation} [${operation.error_code}] — ${operation.error_message}`];
  });
}

export function resolveReadOnlyValidationOutputMode(
  options: { json: boolean },
  isInteractiveOutput: boolean
): ReadOnlyValidationOutputMode {
  return options.json || !isInteractiveOutput ? "json" : "human";
}

export function formatReadOnlyValidationReport(
  report: ReadOnlyValidationReport
): string {
  const lines = [
    `Live Validation: ${formatStatusLabel(report.outcome)}`,
    `Summary: ${report.summary}`,
    `Session: ${report.session.session_name} (captured ${report.session.captured_at})`,
    `Report JSON: ${report.report_path}`,
    `Events: ${report.events_path}`
  ];

  appendSection(
    lines,
    "Operations",
    report.operations.map((operation) => formatOperationSummary(operation))
  );

  appendSection(lines, "Operation Errors", formatOperationErrors(report.operations));
  appendSection(lines, "Failures", formatFailedSelectorBlocks(report.operations));
  appendSection(
    lines,
    "Regressions",
    report.diff.regressions.map((entry) => formatDiffEntry(entry))
  );
  appendSection(
    lines,
    "Recoveries",
    report.diff.recoveries.map((entry) => formatDiffEntry(entry))
  );

  if (report.blocked_request_count > 0) {
    appendSection(
      lines,
      "Blocked Requests",
      [
        `- ${report.blocked_request_count} request${report.blocked_request_count === 1 ? "" : "s"} blocked by the read-only guard`,
        ...formatBlockedRequests(report.blocked_requests)
      ]
    );
  }

  appendSection(
    lines,
    "Next Steps",
    report.recommended_actions.map((action) => `- ${action}`)
  );

  return `${lines.join("\n")}\n`;
}

export function formatReadOnlyValidationError(
  payload: LinkedInAssistantErrorPayload
): string {
  const lines = [`Live validation failed [${payload.code}]`, payload.message];

  if (Object.keys(payload.details).length > 0) {
    lines.push(`Details: ${JSON.stringify(payload.details)}`);
  }

  return lines.join("\n");
}
