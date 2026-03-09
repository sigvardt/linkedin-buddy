import {
  type LinkedInAssistantErrorPayload,
  type WriteValidationActionResult,
  type WriteValidationReport,
  type WriteValidationResultStatus
} from "@linkedin-assistant/core";

export type WriteValidationOutputMode = "human" | "json";

export interface FormatWriteValidationReportOptions {
  color?: boolean;
}

export interface FormatWriteValidationErrorOptions {
  color?: boolean;
  helpCommand?: string;
}

type TerminalStyle = "bold" | "cyan" | "green" | "red" | "yellow";

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

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatActionSummary(
  action: WriteValidationActionResult,
  color: boolean
): string {
  const verification = action.verification?.verified === true ? "verified" : "unverified";
  const sync = formatStateSyncLabel(action.state_synced);
  const artifactCount = action.artifact_paths.length;
  const errorSuffix = action.error_code ? ` | ${sanitizeConsoleText(action.error_code)}` : "";

  return `- ${formatActionStatusLabel(action.status, color)} ${sanitizeConsoleText(action.action_type)} | ${verification} | ${sync} | ${artifactCount} artifact${artifactCount === 1 ? "" : "s"}${errorSuffix}`;
}

function formatStateSyncLabel(stateSynced: boolean | null): string {
  if (stateSynced === null) {
    return "state=n/a";
  }

  return stateSynced ? "state=ok" : "state=failed";
}

function formatArtifactPathList(
  label: string,
  artifactPaths: readonly string[]
): string | null {
  if (artifactPaths.length === 0) {
    return null;
  }

  return `  ${label}: ${artifactPaths.map(sanitizeConsoleText).join(", ")}`;
}

function formatActionDetails(action: WriteValidationActionResult): string[] {
  const target = action.preview?.target ?? {};
  const outbound = action.preview?.outbound ?? {};
  const detailLines = [
    `  target: ${formatValueForDisplay(target)}`,
    `  outbound: ${formatValueForDisplay(outbound)}`,
    `  expected: ${sanitizeConsoleText(action.expected_outcome)}`
  ];

  if (action.verification) {
    detailLines.push(
      `  verification: ${sanitizeConsoleText(action.verification.message)} (${sanitizeConsoleText(action.verification.source)})`
    );
  }

  if (action.error_message) {
    detailLines.push(`  error: ${sanitizeConsoleText(action.error_message)}`);
  }

  const beforePaths = formatArtifactPathList("before", action.before_screenshot_paths);
  if (beforePaths) {
    detailLines.push(beforePaths);
  }

  const afterPaths = formatArtifactPathList("after", action.after_screenshot_paths);
  if (afterPaths) {
    detailLines.push(afterPaths);
  }

  return detailLines;
}

function formatRecommendations(report: WriteValidationReport): string[] {
  return report.recommended_actions.map((action) => `- ${sanitizeConsoleText(action)}`);
}

export function resolveWriteValidationOutputMode(
  input: { json?: boolean },
  stdoutIsTty: boolean
): WriteValidationOutputMode {
  if (input.json || !stdoutIsTty) {
    return "json";
  }

  return "human";
}

export function formatWriteValidationReport(
  report: WriteValidationReport,
  options: FormatWriteValidationReportOptions = {}
): string {
  const color = options.color === true;
  const lines = [
    `${formatSectionTitle("Write Validation", color)} ${formatActionStatusLabel(report.outcome, color)}`,
    `- Account: ${sanitizeConsoleText(report.account.id)} (${sanitizeConsoleText(report.account.designation)})`,
    `- Warning: ${sanitizeConsoleText(report.warning)}`,
    `- Summary: ${sanitizeConsoleText(report.summary)}`,
    `- Audit log: ${sanitizeConsoleText(report.audit_log_path)}`,
    `- Report: ${sanitizeConsoleText(report.report_path)}`
  ];

  const actionEntries = report.actions.flatMap((action) => [
    formatActionSummary(action, color),
    ...formatActionDetails(action)
  ]);
  appendSection(lines, formatSectionTitle("Actions", color), actionEntries);
  appendSection(
    lines,
    formatSectionTitle("Recommendations", color),
    formatRecommendations(report)
  );

  return lines.join("\n");
}

export function formatWriteValidationError(
  error: LinkedInAssistantErrorPayload,
  options: FormatWriteValidationErrorOptions = {}
): string {
  const color = options.color === true;
  const helpCommand = options.helpCommand ?? "linkedin test live --help";
  const lines = [
    `${applyTextStyle("Write validation failed", color, "bold", "red")} [${sanitizeConsoleText(error.code)}]`,
    sanitizeConsoleText(error.message)
  ];

  const detailEntries = Object.entries(error.details).map(([key, value]) => {
    return `- ${sanitizeConsoleText(key)}: ${formatValueForDisplay(value)}`;
  });
  appendSection(lines, formatSectionTitle("Details", color), detailEntries);
  appendSection(lines, formatSectionTitle("Help", color), [
    `- Re-run ${sanitizeConsoleText(helpCommand)} for usage and safety guidance.`
  ]);

  return lines.join("\n");
}
