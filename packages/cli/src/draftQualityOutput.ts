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
    .map(([source, count]) => `${source}=${count}`);

  return entries.length > 0 ? entries.join(" | ") : null;
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

  return hardFailures.map((failure) => failure.message).join(" | ");
}

function formatFailureBlock(result: DraftQualityCaseResult): string[] {
  const lines = [`- ${result.case_id}/${result.draft_id} (${result.draft_source})`];
  const missingPoints = result.metrics.relevance.details.missing_point_ids;
  const toneMissing = result.metrics.tone.details.missing;
  const toneForbidden = result.metrics.tone.details.forbidden_triggered;
  const hardFailures = formatHardFailures(result.overall.hard_failures);

  if (result.case_scenario) {
    lines.push(`  Scenario: ${result.case_scenario}`);
  }

  if (result.overall.failed_metrics.length > 0) {
    lines.push(`  Overall: failed ${result.overall.failed_metrics.join(", ")}`);
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
      `  Relevance notes: ${result.metrics.relevance.details.off_topic_signals.join(" | ")}`
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
    lines.push(`  Notes: ${result.notes.join(" | ")}`);
  }

  return lines;
}

function formatDraftDetail(result: DraftQualityCaseResult): string[] {
  const lines = [
    `- ${formatStatus(result.overall.passed)} ${result.case_id}/${result.draft_id} (${result.draft_source})`
  ];
  const toneDetails = result.metrics.tone.details;
  const matchedTones =
    toneDetails.matched.length > 0 ? toneDetails.matched.join(", ") : "none";
  const optionalTones =
    toneDetails.optional_matched.length > 0
      ? `; optional ${toneDetails.optional_matched.join(", ")}`
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
    lines.push(`  Notes: ${result.notes.join(" | ")}`);
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

  lines.push(`Run: ${report.run_id}`);
  if (report.dataset_path) {
    lines.push(`Dataset: ${report.dataset_path}`);
  }
  if (report.candidates_path) {
    lines.push(`Candidates: ${report.candidates_path}`);
  }

  lines.push(
    `Summary: Evaluated ${report.summary.total_drafts} drafts across ${report.summary.evaluated_case_count}/${report.summary.total_cases} cases. ${report.summary.passed_drafts} passed. ${report.summary.failed_drafts} failed. Pass rate ${formatPercent(report.summary.pass_rate)}.`
  );
  lines.push(
    `Metric Averages: relevance ${formatPercent(report.summary.metric_averages.relevance)} | tone ${formatPercent(report.summary.metric_averages.tone)} | length ${formatPercent(report.summary.metric_averages.length)}`
  );

  const sources = formatSourceCounts(report);
  if (sources) {
    lines.push(`Sources: ${sources}`);
  }

  appendSection(
    lines,
    "Warnings",
    report.warnings.map((warning) => `- ${warning}`)
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
  const lines = [`Draft quality evaluation failed: ${error.message}`];
  const location = readString(error.details, "location") ?? readString(error.details, "path");
  const field = readString(error.details, "field");
  const caseId = readString(error.details, "case_id");
  const draftId = readString(error.details, "draft_id");

  if (location) {
    lines.push(`Location: ${location}`);
  }
  if (field) {
    lines.push(`Field: ${field}`);
  }
  if (caseId) {
    lines.push(`Case: ${caseId}`);
  }
  if (draftId) {
    lines.push(`Draft: ${draftId}`);
  }

  return lines.join("\n");
}
