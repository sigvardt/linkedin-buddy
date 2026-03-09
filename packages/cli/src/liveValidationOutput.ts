import type {
  LinkedInAssistantErrorPayload,
  ReadOnlyValidationDiffEntry,
  ReadOnlyValidationOperationResult,
  ReadOnlyValidationReport
} from "@linkedin-assistant/core";

export type ReadOnlyValidationOutputMode = "human" | "json";

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatOutcome(report: ReadOnlyValidationReport): string {
  return report.outcome === "fail" ? "FAIL" : "PASS";
}

function formatOperationStatus(operation: ReadOnlyValidationOperationResult): string {
  return operation.status === "fail" ? "FAIL" : "PASS";
}

function formatOperationSummary(operation: ReadOnlyValidationOperationResult): string {
  const warningSuffix = operation.warnings.length > 0
    ? ` | ${operation.warnings.length} warning${operation.warnings.length === 1 ? "" : "s"}`
    : "";
  return `- ${formatOperationStatus(operation)} ${operation.operation}: ${operation.matched_count} matched, ${operation.failed_count} failed, ${operation.page_load_ms}ms${warningSuffix}`;
}

function formatDiffEntry(entry: ReadOnlyValidationDiffEntry): string {
  const changeLabel = entry.change === "new_failure"
    ? "New failure"
    : entry.change === "fallback_drift"
      ? "Selector drift"
      : "Recovered";
  const previousCandidate = entry.previous_candidate_key ?? "none";
  const currentCandidate = entry.current_candidate_key ?? "none";

  return `- ${changeLabel}: ${entry.operation}/${entry.selector_key} (${previousCandidate} → ${currentCandidate})`;
}

function formatBlockedRequests(report: ReadOnlyValidationReport): string[] {
  return report.blocked_requests.slice(0, 5).map((blockedRequest) => {
    return `- ${blockedRequest.method} ${blockedRequest.url} [${blockedRequest.reason}]`;
  });
}

function formatFailedSelectorBlocks(
  report: ReadOnlyValidationReport
): string[] {
  return report.operations.flatMap((operation) => {
    return operation.selector_results
      .filter((selectorResult) => selectorResult.status === "fail")
      .map((selectorResult) => {
        return `- ${operation.operation}/${selectorResult.selector_key} — ${selectorResult.error ?? "No selector candidate matched."}`;
      });
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
    `Live Validation: ${formatOutcome(report)}`,
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

  appendSection(lines, "Failures", formatFailedSelectorBlocks(report));
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
        ...formatBlockedRequests(report)
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
