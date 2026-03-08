import type {
  JsonLogEntry,
  LinkedInAssistantErrorPayload,
  SelectorAuditFailureSummary,
  SelectorAuditFallbackSummary,
  SelectorAuditPageSummary,
  SelectorAuditPageWarningSummary,
  SelectorAuditReport,
  SelectorAuditResult
} from "@linkedin-assistant/core";

export type SelectorAuditOutputMode = "human" | "json";

export interface FormatSelectorAuditReportOptions {
  verbose?: boolean;
}

export interface SelectorAuditProgressReporterOptions {
  enabled?: boolean;
  writeLine?: (line: string) => void;
}

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatOutcome(report: SelectorAuditReport): string {
  if (report.outcome === "fail") {
    return "FAIL";
  }

  if (report.outcome === "pass_with_fallbacks") {
    return "PASS WITH FALLBACKS";
  }

  return "PASS";
}

function formatPageStatus(summary: SelectorAuditPageSummary): string {
  if (summary.fail_count > 0) {
    return "FAIL";
  }

  if (summary.fallback_count > 0) {
    return "WARN";
  }

  return "PASS";
}

function formatSelectorStatus(result: SelectorAuditResult): string {
  if (result.status === "fail") {
    return "FAIL";
  }

  if (result.fallback_strategy !== null) {
    return "WARN";
  }

  return "PASS";
}

function truncateForDisplay(value: string, maxLength: number = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatValueForDisplay(value: unknown): string {
  if (typeof value === "string") {
    return truncateForDisplay(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  return truncateForDisplay(JSON.stringify(value));
}

function formatFailureArtifacts(
  failure: SelectorAuditFailureSummary
): string[] {
  const artifactEntries: string[] = [];

  if (failure.failure_artifacts.screenshot_path) {
    artifactEntries.push(`screenshot=${failure.failure_artifacts.screenshot_path}`);
  }

  if (failure.failure_artifacts.dom_snapshot_path) {
    artifactEntries.push(`dom=${failure.failure_artifacts.dom_snapshot_path}`);
  }

  if (failure.failure_artifacts.accessibility_snapshot_path) {
    artifactEntries.push(`a11y=${failure.failure_artifacts.accessibility_snapshot_path}`);
  }

  return artifactEntries;
}

function formatFailureBlock(failure: SelectorAuditFailureSummary): string[] {
  const artifactEntries = formatFailureArtifacts(failure);

  return [
    `- ${failure.page}/${failure.selector_key} — ${failure.description}`,
    `  Error: ${failure.error}`,
    ...(failure.warnings ?? []).map((warning) => `  Warning: ${warning}`),
    ...(artifactEntries.length > 0 ? [`  Artifacts: ${artifactEntries.join(" | ")}`] : []),
    ...((failure.failure_artifacts.capture_warnings ?? []).map(
      (warning) => `  Artifact warning: ${warning}`
    )),
    `  Next: ${failure.recommended_action}`
  ];
}

function formatFallbackBlock(fallback: SelectorAuditFallbackSummary): string[] {
  return [
    `- ${fallback.page}/${fallback.selector_key} — ${fallback.description}`,
    `  Matched via ${fallback.fallback_strategy}: ${fallback.fallback_used}`,
    ...(fallback.warnings ?? []).map((warning) => `  Warning: ${warning}`),
    `  Next: ${fallback.recommended_action}`
  ];
}

function formatPageWarningBlock(pageWarning: SelectorAuditPageWarningSummary): string[] {
  return [
    `- ${pageWarning.page}`,
    ...pageWarning.warnings.map((warning) => `  Warning: ${warning}`)
  ];
}

function formatResultStrategySummary(result: SelectorAuditResult): string {
  return Object.values(result.strategies)
    .map((strategyResult) => {
      const status = strategyResult.status.toUpperCase();
      return `${strategyResult.strategy}=${status}`;
    })
    .join(", ");
}

function formatResultSummary(result: SelectorAuditResult): string {
  if (result.status === "fail") {
    return result.error ?? "Selector group failed.";
  }

  if (result.fallback_strategy !== null && result.fallback_used !== null) {
    return `Matched via ${result.fallback_strategy}: ${result.fallback_used}`;
  }

  return `Matched primary selector: ${result.matched_selector_key ?? "unknown"}`;
}

function formatVerboseResultBlock(result: SelectorAuditResult): string[] {
  return [
    `- ${formatSelectorStatus(result)} ${result.page}/${result.selector_key} — ${result.description}`,
    `  Result: ${formatResultSummary(result)}`,
    `  Strategies: ${formatResultStrategySummary(result)}`,
    ...(result.warnings ?? []).map((warning) => `  Warning: ${warning}`),
    ...(result.status === "fail" && result.error ? [`  Error: ${result.error}`] : [])
  ];
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatPageSummary(summary: SelectorAuditPageSummary): string {
  return `- ${formatPageStatus(summary)} ${summary.page}: ${summary.pass_count} passed, ${summary.fail_count} failed, ${summary.fallback_count} fallback-only`;
}

function formatProgressPageIndex(index: number, totalPages: number | null): string {
  return totalPages === null ? `page ${index}` : `page ${index}/${totalPages}`;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveSelectorAuditOutputMode(options: {
  json: boolean;
}, isInteractiveOutput: boolean): SelectorAuditOutputMode {
  return options.json || !isInteractiveOutput ? "json" : "human";
}

export function formatSelectorAuditReport(
  report: SelectorAuditReport,
  options: FormatSelectorAuditReportOptions = {}
): string {
  const lines = [
    `Selector Audit: ${formatOutcome(report)}`,
    `Profile: ${report.profile_name}`,
    `Checked At: ${report.checked_at}`,
    `Summary: ${report.summary}`,
    `Report JSON: ${report.report_path}`,
    `Artifacts: ${report.artifact_dir}`
  ];

  appendSection(lines, "Pages", report.page_summaries.map(formatPageSummary));
  appendSection(
    lines,
    "Failures",
    report.failed_selectors.flatMap((failure) => formatFailureBlock(failure))
  );
  appendSection(
    lines,
    "Fallbacks",
    report.fallback_selectors.flatMap((fallback) => formatFallbackBlock(fallback))
  );
  appendSection(
    lines,
    "Warnings",
    report.page_warnings.flatMap((pageWarning) => formatPageWarningBlock(pageWarning))
  );

  if (options.verbose) {
    appendSection(
      lines,
      "Selector Details",
      report.results.flatMap((result) => formatVerboseResultBlock(result))
    );
  }

  appendSection(
    lines,
    "Next Steps",
    report.recommended_actions.map((action) => `- ${action}`)
  );

  return lines.join("\n");
}

export function formatSelectorAuditError(
  payload: LinkedInAssistantErrorPayload
): string {
  const lines = [`Selector audit failed [${payload.code}]`, payload.message];
  const detailEntries = Object.entries(payload.details);

  if (detailEntries.length > 0) {
    lines.push(
      `Details: ${detailEntries.map(([key, value]) => `${key}=${formatValueForDisplay(value)}`).join(", ")}`
    );
  }

  lines.push("Tip: rerun with --json if you need the structured error payload.");
  return lines.join("\n");
}

export class SelectorAuditProgressReporter {
  private readonly enabled: boolean;
  private readonly writeLine: (line: string) => void;
  private totalPages: number | null = null;
  private nextPageIndex = 1;
  private readonly pageIndexes = new Map<string, number>();

  constructor(options: SelectorAuditProgressReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.writeLine = options.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  handleLog(entry: JsonLogEntry): void {
    if (!this.enabled) {
      return;
    }

    if (entry.event === "selector.audit.start") {
      this.totalPages = readNumber(entry.payload, "pageCount");
      const profileName = readString(entry.payload, "profileName");
      const pageCountSuffix =
        this.totalPages === null ? "" : ` (${formatCountLabel(this.totalPages, "page")})`;
      this.writeLine(
        `Starting selector audit${profileName ? ` for profile ${profileName}` : ""}${pageCountSuffix}.`
      );
      return;
    }

    if (entry.event === "selector.audit.page.start") {
      const page = readString(entry.payload, "page") ?? "unknown";
      const selectorCount = readNumber(entry.payload, "selectorCount");
      const pageIndex = this.getPageIndex(page);
      const selectorSuffix =
        selectorCount === null ? "" : ` (${formatCountLabel(selectorCount, "selector group")})`;
      this.writeLine(
        `Checking ${formatProgressPageIndex(pageIndex, this.totalPages)}: ${page}${selectorSuffix}...`
      );
      return;
    }

    if (entry.event === "selector.audit.page.done") {
      const page = readString(entry.payload, "page") ?? "unknown";
      const pageIndex = this.getPageIndex(page);
      const passCount = readNumber(entry.payload, "passCount") ?? 0;
      const failCount = readNumber(entry.payload, "failCount") ?? 0;
      const fallbackCount = readNumber(entry.payload, "fallbackCount") ?? 0;
      this.writeLine(
        `Finished ${formatProgressPageIndex(pageIndex, this.totalPages)}: ${page} — ${passCount} passed, ${failCount} failed, ${fallbackCount} fallback.`
      );
      return;
    }

    if (entry.event === "selector.audit.done") {
      const reportPath = readString(entry.payload, "reportPath");
      this.writeLine(
        `Selector audit finished${reportPath ? `. Report: ${reportPath}` : "."}`
      );
    }
  }

  private getPageIndex(page: string): number {
    const existing = this.pageIndexes.get(page);
    if (existing !== undefined) {
      return existing;
    }

    const pageIndex = this.nextPageIndex;
    this.pageIndexes.set(page, pageIndex);
    this.nextPageIndex += 1;
    return pageIndex;
  }
}
