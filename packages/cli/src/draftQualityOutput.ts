import type {
  DraftQualityCaseResult,
  DraftQualityHardFailure,
  DraftQualityReport,
  LinkedInAssistantErrorPayload
} from "@linkedin-assistant/core";

export type DraftQualityOutputMode = "human" | "json";

export interface FormatDraftQualityReportOptions {
  verbose?: boolean;
}

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

function formatSourceCounts(report: DraftQualityReport): string | null {
  const entries = Object.entries(report.summary.source_counts)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${sanitizeConsoleText(source)}=${count}`);

  return entries.length > 0 ? entries.join(" | ") : null;
}

function formatFailureCounts(report: DraftQualityReport): string {
  return [
    `relevance ${report.summary.failed_metric_counts.relevance}`,
    `tone ${report.summary.failed_metric_counts.tone}`,
    `length ${report.summary.failed_metric_counts.length}`,
    `hard checks ${report.summary.hard_failure_count}`,
    `judge fallbacks ${report.summary.judge_failure_count}`,
    `warnings ${report.summary.warning_count}`
  ].join(" | ");
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

  if (result.overall.failed_metrics.length > 0) {
    lines.push(
      `  Overall: failed ${result.overall.failed_metrics.map(sanitizeConsoleText).join(", ")}`
    );
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
  const hardFailures = formatHardFailures(result.overall.hard_failures);

  lines.push(
    `  Relevance: ${formatStatus(result.metrics.relevance.passed)} ${
      result.metrics.relevance.details.covered_point_ids.length
    }/${result.metrics.relevance.details.total_required_points} required points covered`
  );
  lines.push(
    `  Tone: ${formatStatus(result.metrics.tone.passed)} matched ${matchedTones}${optionalTones}`
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
  if (report.dataset_path) {
    lines.push(`Dataset: ${sanitizeConsoleText(report.dataset_path)}`);
  }
  if (report.candidates_path) {
    lines.push(`Candidates: ${sanitizeConsoleText(report.candidates_path)}`);
  }

  lines.push(
    `Summary: Evaluated ${report.summary.total_drafts} drafts across ${report.summary.evaluated_case_count}/${report.summary.total_cases} cases. ${report.summary.passed_drafts} passed. ${report.summary.failed_drafts} failed. Pass rate ${formatPercent(report.summary.pass_rate)}.`
  );
  lines.push(
    `Metric Averages: relevance ${formatPercent(report.summary.metric_averages.relevance)} | tone ${formatPercent(report.summary.metric_averages.tone)} | length ${formatPercent(report.summary.metric_averages.length)}`
  );
  lines.push(`Failure Counts: ${formatFailureCounts(report)}`);

  const sources = formatSourceCounts(report);
  if (sources) {
    lines.push(`Sources: ${sources}`);
  }

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

  return lines.join("\n");
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatDraftQualityError(error: LinkedInAssistantErrorPayload): string {
  const lines = [`Draft quality evaluation failed: ${sanitizeConsoleText(error.message)}`];
  const location = readString(error.details, "location") ?? readString(error.details, "path");
  const field = readString(error.details, "field");
  const caseId = readString(error.details, "case_id");
  const draftId = readString(error.details, "draft_id");

  if (location) {
    lines.push(`Location: ${sanitizeConsoleText(location)}`);
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

  return lines.join("\n");
}
