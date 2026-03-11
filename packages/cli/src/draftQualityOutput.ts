import type {
  DraftQualityCaseResult,
  DraftQualityHardFailure,
  DraftQualityReport,
  JsonLogEntry,
  LinkedInBuddyErrorPayload
} from "@linkedin-buddy/core";

export type DraftQualityOutputMode = "human" | "json";

export interface FormatDraftQualityReportOptions {
  verbose?: boolean;
  reportPath?: string;
}

export interface DraftQualityProgressReporterOptions {
  enabled?: boolean;
  writeLine?: (line: string) => void;
}

type DraftQualityProgressLogEntry = Pick<JsonLogEntry, "event" | "payload">;

const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+`,
  "g"
);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);

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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatStatus(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
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

  try {
    return truncateForDisplay(JSON.stringify(value));
  } catch {
    return truncateForDisplay(String(value));
  }
}

function formatSourceCounts(report: DraftQualityReport): string | null {
  const entries = Object.entries(report.summary.source_counts)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${sanitizeConsoleText(source)}=${count}`);

  return entries.length > 0 ? entries.join(" | ") : null;
}

function formatMetricSummaryLine(
  label: string,
  average: number,
  failedDraftCount: number
): string {
  return `- ${label}: ${formatPercent(average)} average | ${formatCountLabel(failedDraftCount, "failing draft")}`;
}

function formatCheckSummaryLine(report: DraftQualityReport): string {
  return `- Checks: ${formatCountLabel(report.summary.hard_failure_count, "hard-check hit")} | ${formatCountLabel(report.summary.judge_failure_count, "judge fallback")} | ${formatCountLabel(report.summary.warning_count, "warning")}`;
}

function formatSummary(report: DraftQualityReport): string {
  return `Summary: ${report.summary.passed_drafts} of ${report.summary.total_drafts} drafts passed (${formatPercent(report.summary.pass_rate)}) across ${report.summary.evaluated_case_count}/${report.summary.total_cases} cases.`;
}

function formatOverviewEntries(report: DraftQualityReport): string[] {
  const entries = [
    `- Cases: ${report.summary.total_cases} total | ${report.summary.evaluated_case_count} evaluated | ${report.summary.skipped_case_count} skipped`,
    `- Drafts: ${report.summary.passed_drafts} passed | ${report.summary.failed_drafts} failed`,
    formatCheckSummaryLine(report)
  ];

  const sources = formatSourceCounts(report);
  if (sources) {
    entries.push(`- Sources: ${sources}`);
  }

  return entries;
}

function formatMetricEntries(report: DraftQualityReport): string[] {
  return [
    formatMetricSummaryLine(
      "Relevance",
      report.summary.metric_averages.relevance,
      report.summary.failed_metric_counts.relevance
    ),
    formatMetricSummaryLine(
      "Tone",
      report.summary.metric_averages.tone,
      report.summary.failed_metric_counts.tone
    ),
    formatMetricSummaryLine(
      "Length",
      report.summary.metric_averages.length,
      report.summary.failed_metric_counts.length
    )
  ];
}

function formatNextSteps(
  report: DraftQualityReport,
  options: FormatDraftQualityReportOptions
): string[] {
  const steps: string[] = [];

  if (!options.verbose) {
    steps.push("Rerun with --verbose to inspect every evaluated draft.");
  }

  if (report.summary.skipped_case_count > 0) {
    steps.push("Review skipped cases with no candidate drafts before comparing pass rates.");
  }

  if (!options.reportPath) {
    steps.push("Use --output <path> to save the JSON report to a file.");
  }

  steps.push("Use --json for automation or to capture the structured report.");
  return steps;
}

function formatLengthExpectation(result: DraftQualityCaseResult): string {
  const details = result.metrics.length.details;
  const range = `${details.min_words}-${details.max_words} words`;
  const sentenceLimit =
    details.max_sentences === null ? "" : `, <= ${details.max_sentences} sentences`;

  return `${details.word_count} words / ${details.sentence_count} sentences (expected ${range}${sentenceLimit})`;
}

function formatHardFailures(hardFailures: DraftQualityHardFailure[]): string | null {
  if (hardFailures.length === 0) {
    return null;
  }

  return hardFailures.map((failure) => sanitizeConsoleText(failure.message)).join(" | ");
}

function formatFailureBlock(result: DraftQualityCaseResult): string[] {
  const lines = [
    `- ${sanitizeConsoleText(result.case_id)}/${sanitizeConsoleText(result.draft_id)} (${sanitizeConsoleText(result.draft_source)})`
  ];
  const missingPoints = result.metrics.relevance.details.missing_point_ids.map(sanitizeConsoleText);
  const toneMissing = result.metrics.tone.details.missing.map(sanitizeConsoleText);
  const toneForbidden = result.metrics.tone.details.forbidden_triggered.map(sanitizeConsoleText);
  const hardFailures = formatHardFailures(result.overall.hard_failures);

  if (result.case_scenario) {
    lines.push(`  Scenario: ${sanitizeConsoleText(result.case_scenario)}`);
  }

  if (result.case_channel) {
    lines.push(`  Channel: ${sanitizeConsoleText(result.case_channel)}`);
  }

  if (result.overall.failed_metrics.length > 0) {
    lines.push(
      `  Overall: failed ${result.overall.failed_metrics.map(sanitizeConsoleText).join(", ")} (score ${formatPercent(result.overall.score)})`
    );
  } else {
    lines.push(`  Overall: failed (score ${formatPercent(result.overall.score)})`);
  }

  if (!result.metrics.relevance.passed) {
    lines.push(
      `  Relevance: missing points ${
        missingPoints.length > 0 ? missingPoints.join(", ") : "none"
      }`
    );
  }

  if (result.metrics.relevance.details.off_topic_signals.length > 0) {
    lines.push(
      `  Relevance notes: ${result.metrics.relevance.details.off_topic_signals.map(sanitizeConsoleText).join(" | ")}`
    );
  }

  if (!result.metrics.tone.passed) {
    const toneDetails: string[] = [];
    if (toneMissing.length > 0) {
      toneDetails.push(`missing ${toneMissing.join(", ")}`);
    }
    if (toneForbidden.length > 0) {
      toneDetails.push(`forbidden ${toneForbidden.join(", ")}`);
    }
    lines.push(`  Tone: ${toneDetails.join("; ")}`);
  }

  if (!result.metrics.length.passed) {
    lines.push(`  Length: ${formatLengthExpectation(result)}`);
  }

  if (hardFailures) {
    lines.push(`  Hard checks: ${hardFailures}`);
  }

  if (result.notes.length > 0) {
    lines.push(`  Notes: ${result.notes.map(sanitizeConsoleText).join(" | ")}`);
  }

  return lines;
}

function formatDraftDetail(result: DraftQualityCaseResult): string[] {
  const lines = [
    `- ${formatStatus(result.overall.passed)} ${sanitizeConsoleText(result.case_id)}/${sanitizeConsoleText(result.draft_id)} (${sanitizeConsoleText(result.draft_source)})`
  ];
  const toneDetails = result.metrics.tone.details;
  const matchedTones =
    toneDetails.matched.length > 0
      ? toneDetails.matched.map(sanitizeConsoleText).join(", ")
      : "none";
  const optionalTones =
    toneDetails.optional_matched.length > 0
      ? `; optional ${toneDetails.optional_matched.map(sanitizeConsoleText).join(", ")}`
      : "";
  const toneNotes: string[] = [];
  const hardFailures = formatHardFailures(result.overall.hard_failures);

  if (toneDetails.missing.length > 0) {
    toneNotes.push(`missing ${toneDetails.missing.map(sanitizeConsoleText).join(", ")}`);
  }

  if (toneDetails.forbidden_triggered.length > 0) {
    toneNotes.push(
      `forbidden ${toneDetails.forbidden_triggered.map(sanitizeConsoleText).join(", ")}`
    );
  }

  if (result.case_scenario) {
    lines.push(`  Scenario: ${sanitizeConsoleText(result.case_scenario)}`);
  }

  if (result.case_channel) {
    lines.push(`  Channel: ${sanitizeConsoleText(result.case_channel)}`);
  }

  lines.push(`  Overall: ${formatStatus(result.overall.passed)} score ${formatPercent(result.overall.score)}`);

  lines.push(
    `  Relevance: ${formatStatus(result.metrics.relevance.passed)} ${
      result.metrics.relevance.details.covered_point_ids.length
    }/${result.metrics.relevance.details.total_required_points} required points covered`
  );

  if (result.metrics.relevance.details.missing_point_ids.length > 0) {
    lines.push(
      `  Missing points: ${result.metrics.relevance.details.missing_point_ids.map(sanitizeConsoleText).join(", ")}`
    );
  }

  if (result.metrics.relevance.details.off_topic_signals.length > 0) {
    lines.push(
      `  Relevance notes: ${result.metrics.relevance.details.off_topic_signals.map(sanitizeConsoleText).join(" | ")}`
    );
  }

  lines.push(
    `  Tone: ${formatStatus(result.metrics.tone.passed)} matched ${matchedTones}${optionalTones}${toneNotes.length > 0 ? `; ${toneNotes.join("; ")}` : ""}`
  );
  lines.push(`  Length: ${formatStatus(result.metrics.length.passed)} ${formatLengthExpectation(result)}`);

  if (hardFailures) {
    lines.push(`  Hard checks: ${hardFailures}`);
  }

  if (result.notes.length > 0) {
    lines.push(`  Notes: ${result.notes.map(sanitizeConsoleText).join(" | ")}`);
  }

  return lines;
}

export function resolveDraftQualityOutputMode(
  input: { json?: boolean },
  interactiveTerminal: boolean
): DraftQualityOutputMode {
  if (input.json) {
    return "json";
  }

  return interactiveTerminal ? "human" : "json";
}

export function formatDraftQualityReport(
  report: DraftQualityReport,
  options: FormatDraftQualityReportOptions = {}
): string {
  const lines = [`Draft Quality Evaluation: ${report.outcome.toUpperCase()}`];

  lines.push(`Run: ${sanitizeConsoleText(report.run_id)}`);
  lines.push(`Generated At: ${sanitizeConsoleText(report.generated_at)}`);
  if (report.dataset_path) {
    lines.push(`Dataset: ${sanitizeConsoleText(report.dataset_path)}`);
  }
  if (report.candidates_path) {
    lines.push(`Candidates: ${sanitizeConsoleText(report.candidates_path)}`);
  }

  if (options.reportPath) {
    lines.push(`Report JSON: ${sanitizeConsoleText(options.reportPath)}`);
  }

  lines.push(formatSummary(report));

  appendSection(lines, "Overview", formatOverviewEntries(report));
  appendSection(lines, "Metrics", formatMetricEntries(report));

  appendSection(
    lines,
    "Warnings",
    report.warnings.map((warning) => `- ${sanitizeConsoleText(warning)}`)
  );

  appendSection(
    lines,
    "Failures",
    report.cases
      .filter((result) => !result.overall.passed)
      .flatMap((result) => formatFailureBlock(result))
  );

  if (options.verbose) {
    appendSection(
      lines,
      "Draft Details",
      report.cases.flatMap((result) => formatDraftDetail(result))
    );
  }

  appendSection(
    lines,
    "Next Steps",
    formatNextSteps(report, options).map((step) => `- ${step}`)
  );

  return lines.join("\n");
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatDraftQualityError(error: LinkedInBuddyErrorPayload): string {
  const lines = [`Draft quality evaluation failed [${sanitizeConsoleText(error.code)}]`, sanitizeConsoleText(error.message)];
  const location = readString(error.details, "location");
  const filePath = readString(error.details, "path");
  const field = readString(error.details, "field");
  const caseId = readString(error.details, "case_id");
  const draftId = readString(error.details, "draft_id");

  if (location) {
    lines.push(`Location: ${sanitizeConsoleText(location)}`);
  }

  if (filePath) {
    lines.push(`Path: ${sanitizeConsoleText(filePath)}`);
  }

  if (field) {
    lines.push(`Field: ${sanitizeConsoleText(field)}`);
  }
  if (caseId) {
    lines.push(`Case: ${sanitizeConsoleText(caseId)}`);
  }
  if (draftId) {
    lines.push(`Draft: ${sanitizeConsoleText(draftId)}`);
  }

  const knownDetailKeys = new Set(["location", "path", "field", "case_id", "draft_id"]);
  const extraDetails = Object.entries(error.details).filter(([key]) => !knownDetailKeys.has(key));

  if (extraDetails.length > 0) {
    lines.push(
      `Details: ${extraDetails.map(([key, value]) => `${key}=${formatValueForDisplay(value)}`).join(", ")}`
    );
  }

  lines.push(
    "Tip: run linkedin audit draft-quality --help for usage examples, or rerun with --json for the structured error payload."
  );

  return lines.join("\n");
}

export class DraftQualityProgressReporter {
  private readonly enabled: boolean;
  private readonly writeLine: (line: string) => void;
  private totalCases: number | null = null;
  private nextCaseIndex = 1;
  private readonly caseIndexes = new Map<string, number>();

  constructor(options: DraftQualityProgressReporterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.writeLine = options.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  handleLog(entry: DraftQualityProgressLogEntry): void {
    if (!this.enabled) {
      return;
    }

    if (entry.event === "draft_quality.evaluate.start") {
      this.totalCases = readNumber(entry.payload, "total_cases");
      const totalDrafts = readNumber(entry.payload, "candidate_draft_count");
      const summaryParts: string[] = [];

      if (this.totalCases !== null) {
        summaryParts.push(formatCountLabel(this.totalCases, "case"));
      }

      if (totalDrafts !== null) {
        summaryParts.push(formatCountLabel(totalDrafts, "draft"));
      }

      const summarySuffix =
        summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : "";

      this.writeLine(`Starting draft quality evaluation${summarySuffix}.`);
      return;
    }

    if (entry.event === "draft_quality.case.start") {
      const caseId = readString(entry.payload, "case_id") ?? "unknown";
      const caseIndex = this.getCaseIndex(caseId, readNumber(entry.payload, "case_index"));
      const totalCases = readNumber(entry.payload, "total_cases") ?? this.totalCases;
      const draftCount = readNumber(entry.payload, "draft_count");
      const draftSuffix =
        draftCount === null ? "" : ` (${formatCountLabel(draftCount, "draft")})`;

      this.writeLine(
        `Evaluating ${formatProgressCaseIndex(caseIndex, totalCases)}: ${sanitizeConsoleText(caseId)}${draftSuffix}...`
      );
      return;
    }

    if (entry.event === "draft_quality.case.skipped") {
      const caseId = readString(entry.payload, "case_id") ?? "unknown";
      const caseIndex = this.getCaseIndex(caseId, readNumber(entry.payload, "case_index"));
      const totalCases = readNumber(entry.payload, "total_cases") ?? this.totalCases;
      this.writeLine(
        `Skipping ${formatProgressCaseIndex(caseIndex, totalCases)}: ${sanitizeConsoleText(caseId)} — no candidate drafts.`
      );
      return;
    }

    if (entry.event === "draft_quality.case.done") {
      const caseId = readString(entry.payload, "case_id") ?? "unknown";
      const caseIndex = this.getCaseIndex(caseId, readNumber(entry.payload, "case_index"));
      const totalCases = readNumber(entry.payload, "total_cases") ?? this.totalCases;
      const passedDrafts = readNumber(entry.payload, "passed_drafts") ?? 0;
      const failedDrafts = readNumber(entry.payload, "failed_drafts") ?? 0;

      this.writeLine(
        `Finished ${formatProgressCaseIndex(caseIndex, totalCases)}: ${sanitizeConsoleText(caseId)} — ${passedDrafts} passed, ${failedDrafts} failed.`
      );
      return;
    }

    if (entry.event === "draft_quality.evaluate.complete") {
      const passedDrafts = readNumber(entry.payload, "total_drafts");
      const failedDrafts = readNumber(entry.payload, "failed_drafts");

      if (passedDrafts !== null && failedDrafts !== null) {
        const passingCount = Math.max(passedDrafts - failedDrafts, 0);
        this.writeLine(
          `Draft quality evaluation finished. ${passingCount} passed, ${failedDrafts} failed.`
        );
        return;
      }

      this.writeLine("Draft quality evaluation finished.");
    }
  }

  private getCaseIndex(caseId: string, explicitIndex: number | null): number {
    if (explicitIndex !== null) {
      this.caseIndexes.set(caseId, explicitIndex);
      return explicitIndex;
    }

    const existing = this.caseIndexes.get(caseId);
    if (existing !== undefined) {
      return existing;
    }

    const caseIndex = this.nextCaseIndex;
    this.caseIndexes.set(caseId, caseIndex);
    this.nextCaseIndex += 1;
    return caseIndex;
  }
}

function formatProgressCaseIndex(caseIndex: number, totalCases: number | null): string {
  return totalCases === null ? `case ${caseIndex}` : `case ${caseIndex}/${totalCases}`;
}
