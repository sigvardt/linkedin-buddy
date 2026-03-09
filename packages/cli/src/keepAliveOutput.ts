import type { LinkedInAssistantErrorPayload } from "@linkedin-assistant/core";

/**
 * Output mode used by the keepalive CLI formatters.
 */
export type KeepAliveOutputMode = "human" | "json";

/**
 * Saved keepalive daemon state as read from the profile state file.
 */
export interface KeepAliveStateView {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "degraded" | "stopped";
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastCheckStartedAt?: string;
  lastHealthyAt?: string;
  authenticated?: boolean;
  browserHealthy?: boolean;
  currentUrl?: string;
  reason?: string;
  lastError?: string;
  cdpUrl?: string;
  healthCheckInProgress?: boolean;
  stoppedAt?: string;
}

/**
 * Recent keepalive event-log entry surfaced in status output.
 */
export interface KeepAliveRecentEvent extends Record<string, unknown> {
  ts: string;
  event: string;
}

/**
 * Normalized payload rendered by `linkedin keepalive status`.
 */
export interface KeepAliveStatusReport {
  profile_name: string;
  running: boolean;
  pid: number | null;
  state: KeepAliveStateView | null;
  stale_pid_file: boolean;
  state_path: string;
  log_path: string;
  recent_events: KeepAliveRecentEvent[];
}

/**
 * Normalized payload rendered by `linkedin keepalive start`.
 */
export interface KeepAliveStartReport {
  started: boolean;
  reason?: string;
  profile_name: string;
  pid?: number;
  state?: KeepAliveStateView | null;
  state_path: string;
  log_path: string;
  recovered_stale_pid?: boolean;
}

/**
 * Normalized payload rendered by `linkedin keepalive stop`.
 */
export interface KeepAliveStopReport {
  stopped: boolean;
  profile_name: string;
  pid?: number;
  forced?: boolean;
  reason?: string;
  state?: KeepAliveStateView | null;
  state_path: string;
  log_path: string;
}

/**
 * Formatting toggles for human-readable keepalive output.
 */
export interface KeepAliveFormatOptions {
  quiet?: boolean;
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

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  lines.push("");
  lines.push(title);
  lines.push(...entries);
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 1_000) {
    return `${Math.max(0, Math.round(value))}ms`;
  }

  const seconds = Math.round(value / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

function formatStatusLabel(status: string): string {
  return sanitizeConsoleText(status.replace(/_/g, " ").toUpperCase());
}

function formatTimestamp(value?: string | null): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "not recorded";
  }

  return sanitizeConsoleText(value);
}

function formatHealthLabel(value: boolean | undefined, positive: string, negative: string): string {
  if (typeof value !== "boolean") {
    return "unknown";
  }

  return value ? positive : negative;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stateConditionSummary(state: KeepAliveStateView | null): string {
  if (!state) {
    return "no saved daemon state";
  }

  return [
    formatStatusLabel(state.status).toLowerCase(),
    `browser ${formatHealthLabel(state.browserHealthy, "healthy", "unhealthy")}`,
    `session ${formatHealthLabel(state.authenticated, "authenticated", "not authenticated")}`
  ].join(" | ");
}

function formatCadenceSummary(state: KeepAliveStateView): string {
  return `every ${formatDurationMs(state.intervalMs)} with ±${formatDurationMs(state.jitterMs)} jitter`;
}

function inferOperatorGuidance(state: KeepAliveStateView | null): string | null {
  if (!state) {
    return null;
  }

  const reason = state.reason?.toLowerCase() ?? "";
  const currentUrl = state.currentUrl?.toLowerCase() ?? "";
  const lastError = state.lastError?.toLowerCase() ?? "";

  if (
    reason.includes("challenge") ||
    reason.includes("checkpoint") ||
    currentUrl.includes("/checkpoint")
  ) {
    return "Complete the LinkedIn checkpoint or verification manually in the same browser session, then rerun the daemon or status check.";
  }

  if (
    reason.includes("login wall") ||
    reason.includes("login form") ||
    currentUrl.includes("/login") ||
    currentUrl.includes("/authwall")
  ) {
    return "Open LinkedIn in the same browser session, sign in again until the feed loads normally, then rerun keepalive.";
  }

  if (reason.includes("rate-limit") || lastError.includes("rate-limit")) {
    return "LinkedIn is throttling session checks right now. Wait a bit before retrying or restarting the daemon.";
  }

  if (
    lastError.includes("profile lock") ||
    lastError.includes("lock") ||
    lastError.includes("busy")
  ) {
    return "Another CLI, MCP, or daemon task is using this profile. Let that work finish before retrying keepalive.";
  }

  if (
    lastError.includes("network") ||
    lastError.includes("timeout") ||
    lastError.includes("cdp") ||
    lastError.includes("browser")
  ) {
    return "Check browser connectivity and any --cdp-url endpoint, then rerun status or restart the daemon if the issue persists.";
  }

  return null;
}

function formatEventSummary(event: KeepAliveRecentEvent): string {
  const reason = readString(event, "reason");
  const error = readString(event, "error");
  const healthy = event.healthy;

  switch (event.event) {
    case "keepalive.daemon.started":
      return "Daemon started";
    case "keepalive.tick.started":
      return "Health check started";
    case "keepalive.tick":
      if (healthy === true) {
        return "Health check passed";
      }
      if (healthy === false) {
        return reason ? `Health check completed with warning: ${sanitizeConsoleText(reason)}` : "Health check completed with warnings";
      }
      return "Health check finished";
    case "keepalive.tick.skipped":
      return reason ? `Health check skipped: ${sanitizeConsoleText(reason)}` : "Health check skipped";
    case "keepalive.tick.error":
      return error ? `Health check failed: ${sanitizeConsoleText(error)}` : "Health check failed";
    case "keepalive.daemon.stopped":
      return "Daemon stopped";
    default:
      return sanitizeConsoleText(event.event);
  }
}

function formatRecentEventLine(event: KeepAliveRecentEvent): string {
  return `- ${formatTimestamp(event.ts)} — ${formatEventSummary(event)}`;
}

function formatStateHeadline(report: KeepAliveStatusReport): string {
  if (report.stale_pid_file) {
    return "STALE PID FILE";
  }

  if (report.running) {
    return report.state ? formatStatusLabel(report.state.status) : "RUNNING";
  }

  if (report.state) {
    return formatStatusLabel(report.state.status);
  }

  return "STOPPED";
}

function formatStartNextSteps(report: KeepAliveStartReport, verbose: boolean): string[] {
  const profile = sanitizeConsoleText(report.profile_name);

  if (!report.started) {
    const steps = [
      `Run \`linkedin keepalive status --profile ${profile}\` to inspect the existing daemon state.`,
      `Run \`linkedin keepalive stop --profile ${profile}\` if you need to restart it cleanly.`
    ];
    if (!verbose) {
      steps.push("Rerun with `--verbose` to include recent daemon-event context in human-readable output.");
    }
    steps.push("Use `--json` if you need the structured payload for automation.");
    return steps;
  }

  const steps = [
    `Run \`linkedin keepalive status --profile ${profile}\` to inspect health, daemon state, and recovery guidance.`,
    `Run \`linkedin keepalive stop --profile ${profile}\` when you want to stop background health checks.`
  ];
  if (!verbose) {
    steps.push("Rerun status with `--verbose` to include recent daemon events and extra diagnostics.");
  }
  steps.push("Use `--json` if you need the structured payload for automation.");
  return steps;
}

function formatStatusNextSteps(
  report: KeepAliveStatusReport,
  verbose: boolean
): string[] {
  const profile = sanitizeConsoleText(report.profile_name);
  const steps: string[] = [];
  const guidance = inferOperatorGuidance(report.state);

  if (report.stale_pid_file) {
    steps.push(
      `Run \`linkedin keepalive stop --profile ${profile}\` to clear the stale PID file safely.`
    );
  } else if (report.running) {
    steps.push(
      `Run \`linkedin keepalive stop --profile ${profile}\` to stop background health checks.`
    );
  } else {
    steps.push(
      `Run \`linkedin keepalive start --profile ${profile}\` to resume background health checks.`
    );
  }

  if (guidance) {
    steps.push(guidance);
  }

  if (report.state?.healthCheckInProgress) {
    steps.push(
      `Rerun \`linkedin keepalive status --profile ${profile}\` after the current health check completes for the latest saved result.`
    );
  }

  if (!verbose) {
    steps.push("Rerun with `--verbose` to inspect recent daemon events and raw session diagnostics.");
  }
  steps.push("Use `--json` if you need the structured payload for automation.");
  return steps;
}

function formatStopNextSteps(report: KeepAliveStopReport, verbose: boolean): string[] {
  const profile = sanitizeConsoleText(report.profile_name);

  if (report.stopped) {
    const steps = [
      `Run \`linkedin keepalive status --profile ${profile}\` to confirm the daemon is idle.`,
      `Run \`linkedin keepalive start --profile ${profile}\` when you want background health checks again.`
    ];
    if (!verbose) {
      steps.push("Rerun status with `--verbose` if you want recent daemon-event context before restarting.");
    }
    steps.push("Use `--json` if you need the structured payload for automation.");
    return steps;
  }

  return [
    `Run \`linkedin keepalive start --profile ${profile}\` to launch the daemon.`,
    "Use `--json` if you need the structured payload for automation."
  ];
}

function formatErrorLines(error: LinkedInAssistantErrorPayload): string[] {
  const lines = [
    `Keepalive command failed [${sanitizeConsoleText(error.code)}]`,
    sanitizeConsoleText(error.message)
  ];

  const profileName = readString(error.details, "profile_name");
  const path = readString(error.details, "path");
  const env = readString(error.details, "env");
  const cause = readString(error.details, "cause");

  if (profileName) {
    lines.push(`Profile: ${sanitizeConsoleText(profileName)}`);
  }
  if (path) {
    lines.push(`Path: ${sanitizeConsoleText(path)}`);
  }
  if (env) {
    lines.push(`Setting: ${sanitizeConsoleText(env)}`);
  }
  if (cause) {
    lines.push(`Cause: ${sanitizeConsoleText(cause)}`);
  }

  return lines;
}

function formatErrorNextSteps(error: LinkedInAssistantErrorPayload): string[] {
  switch (error.code) {
    case "AUTH_REQUIRED":
      return [
        "Open LinkedIn in the same browser session and sign back in until the feed loads normally.",
        "After the session is healthy again, rerun the keepalive command that failed.",
        "If you are using a stored-session workflow elsewhere, refresh it with `linkedin auth session --session <name>` after reauth."
      ];
    case "CAPTCHA_OR_CHALLENGE":
      return [
        "Complete the LinkedIn checkpoint or challenge manually in the same browser session.",
        "After LinkedIn returns you to the feed, rerun the keepalive command that failed.",
        "Avoid restarting the daemon until manual verification is complete."
      ];
    case "RATE_LIMITED":
      return [
        "Wait for LinkedIn's temporary throttle or cooldown window to pass before retrying.",
        "Use `linkedin keepalive status --profile <profile>` to inspect the last saved daemon state before restarting.",
        "Reduce other browser activity on the same profile if the throttle keeps recurring."
      ];
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return [
        "Confirm the browser is reachable and any `--cdp-url` endpoint is still listening.",
        "Retry after the browser or network stabilizes.",
        "Check the keepalive event log for recent failures if the problem persists."
      ];
    case "ACTION_PRECONDITION_FAILED": {
      const message = error.message.toLowerCase();
      if (message.includes("path separators") || message.includes("relative path segments")) {
        return [
          "Use a simple profile name such as `default` or `sales`, not a filesystem path.",
          "Rerun the keepalive command with `--profile <name>` using that label.",
          "Run `linkedin keepalive --help` to review the supported flags."
        ];
      }

      return [
        "Review the message above, correct the input or environment setting, and rerun the command.",
        "Run `linkedin keepalive --help` to review command usage and examples."
      ];
    }
    default: {
      if (error.message.toLowerCase().includes("resolve cli entrypoint")) {
        return [
          "Ensure the CLI was built correctly before starting background daemons.",
          "Run `npm run build` and then retry the keepalive command.",
          "Run `linkedin keepalive --help` if you want to verify the supported startup flags first."
        ];
      }

      return [
        "Retry the command after checking the browser session, keepalive state file, and event log.",
        "Run `linkedin keepalive --help` to review supported usage and recovery options."
      ];
    }
  }
}

/**
 * Chooses human-readable output on interactive terminals unless JSON is
 * requested explicitly.
 */
export function resolveKeepAliveOutputMode(
  input: { json?: boolean },
  interactiveTerminal: boolean
): KeepAliveOutputMode {
  if (input.json) {
    return "json";
  }

  return interactiveTerminal ? "human" : "json";
}

/**
 * Formats a keepalive status report for either operator-facing CLI output or
 * structured automation output.
 */
export function formatKeepAliveStatusReport(
  report: KeepAliveStatusReport,
  options: KeepAliveFormatOptions = {}
): string {
  if (options.quiet) {
    const parts = [
      `Keepalive Status: ${formatStateHeadline(report)}`,
      `profile ${sanitizeConsoleText(report.profile_name)}`
    ];
    if (typeof report.pid === "number") {
      parts.push(`PID ${report.pid}`);
    }
    parts.push(stateConditionSummary(report.state));
    if (report.state?.healthCheckInProgress) {
      parts.push("health check in progress");
    }
    if (report.state?.reason) {
      parts.push(sanitizeConsoleText(report.state.reason));
    }
    return parts.join(" — ");
  }

  const lines = [`Keepalive Status: ${formatStateHeadline(report)}`];

  lines.push(`Profile: ${sanitizeConsoleText(report.profile_name)}`);
  if (typeof report.pid === "number") {
    lines.push(`PID: ${report.pid}`);
  }
  lines.push(`State file: ${sanitizeConsoleText(report.state_path)}`);
  lines.push(`Event log: ${sanitizeConsoleText(report.log_path)}`);

  if (!report.state) {
    appendSection(lines, "Summary", [
      "- No saved keepalive state was found for this profile.",
      `- Running now: ${report.running ? "yes" : "no"}`
    ]);
  } else {
    const summaryEntries = [
      `- Daemon state: ${formatStatusLabel(report.state.status)}`,
      `- Browser health: ${formatHealthLabel(report.state.browserHealthy, "healthy", "unhealthy")}`,
      `- Session health: ${formatHealthLabel(report.state.authenticated, "authenticated", "not authenticated")}`,
      `- Consecutive failures: ${report.state.consecutiveFailures}/${report.state.maxConsecutiveFailures}`,
      `- Health-check cadence: ${formatCadenceSummary(report.state)}`,
      `- Last tick: ${formatTimestamp(report.state.lastTickAt)}`
    ];

    if (report.state.healthCheckInProgress) {
      summaryEntries.push(
        `- Health check progress: running since ${formatTimestamp(report.state.lastCheckStartedAt)}`
      );
    } else {
      summaryEntries.push(
        `- Last healthy tick: ${formatTimestamp(report.state.lastHealthyAt)}`
      );
    }

    if (report.stale_pid_file) {
      summaryEntries.push("- PID file is stale: the recorded process is no longer running.");
    }

    appendSection(lines, "Summary", summaryEntries);

    const sessionEntries = [
      `- Current URL: ${formatTimestamp(report.state.currentUrl)}`,
      `- LinkedIn reason: ${formatTimestamp(report.state.reason)}`
    ];

    if (report.state.lastError) {
      sessionEntries.push(`- Last error: ${sanitizeConsoleText(report.state.lastError)}`);
    }
    if (options.verbose && report.state.cdpUrl) {
      sessionEntries.push(`- External CDP session: ${sanitizeConsoleText(report.state.cdpUrl)}`);
    }
    if (options.verbose) {
      sessionEntries.push(`- Started at: ${formatTimestamp(report.state.startedAt)}`);
      sessionEntries.push(`- Updated at: ${formatTimestamp(report.state.updatedAt)}`);
      if (report.state.stoppedAt) {
        sessionEntries.push(`- Stopped at: ${formatTimestamp(report.state.stoppedAt)}`);
      }
    }
    appendSection(lines, "Session", sessionEntries);

    const guidance = inferOperatorGuidance(report.state);
    if (guidance) {
      appendSection(lines, "Action Needed", [`- ${sanitizeConsoleText(guidance)}`]);
    }
  }

  if (options.verbose) {
    appendSection(
      lines,
      "Recent Events",
      report.recent_events.length > 0
        ? report.recent_events.map((event) => formatRecentEventLine(event))
        : ["- No keepalive events have been recorded yet."]
    );
  }

  appendSection(
    lines,
    "Next Steps",
    formatStatusNextSteps(report, Boolean(options.verbose)).map((step) => `- ${sanitizeConsoleText(step)}`)
  );

  return lines.join("\n");
}

/**
 * Formats the result of a keepalive daemon start attempt.
 */
export function formatKeepAliveStartReport(
  report: KeepAliveStartReport,
  options: KeepAliveFormatOptions = {}
): string {
  const title = report.started
    ? "Keepalive Start: STARTED"
    : "Keepalive Start: ALREADY RUNNING";

  if (options.quiet) {
    const parts = [title, `profile ${sanitizeConsoleText(report.profile_name)}`];
    if (typeof report.pid === "number") {
      parts.push(`PID ${report.pid}`);
    }
    if (report.reason) {
      parts.push(sanitizeConsoleText(report.reason));
    }
    return parts.join(" — ");
  }

  const lines = [title];

  lines.push(`Profile: ${sanitizeConsoleText(report.profile_name)}`);
  if (typeof report.pid === "number") {
    lines.push(`PID: ${report.pid}`);
  }
  lines.push(`State file: ${sanitizeConsoleText(report.state_path)}`);
  lines.push(`Event log: ${sanitizeConsoleText(report.log_path)}`);

  const statusEntries: string[] = [];
  if (report.reason) {
    statusEntries.push(`- ${sanitizeConsoleText(report.reason)}`);
  }
  if (report.recovered_stale_pid) {
    statusEntries.push("- Removed a stale keepalive PID file before starting the new daemon.");
  }
  if (report.started) {
    statusEntries.push(
      "- The daemon starts a session health check in the background right away; use status to inspect live progress and saved results."
    );
  }
  if (report.state?.healthCheckInProgress) {
    statusEntries.push(
      `- Health check progress: running since ${formatTimestamp(report.state.lastCheckStartedAt)}`
    );
  }
  appendSection(lines, "Status", statusEntries);

  if (options.verbose && report.state) {
    appendSection(lines, "State", [
      `- Daemon state: ${formatStatusLabel(report.state.status)}`,
      `- Health-check cadence: ${formatCadenceSummary(report.state)}`,
      `- Consecutive failures: ${report.state.consecutiveFailures}/${report.state.maxConsecutiveFailures}`,
      `- Current URL: ${formatTimestamp(report.state.currentUrl)}`,
      `- LinkedIn reason: ${formatTimestamp(report.state.reason)}`
    ]);
  }

  appendSection(
    lines,
    "Next Steps",
    formatStartNextSteps(report, Boolean(options.verbose)).map((step) => `- ${sanitizeConsoleText(step)}`)
  );

  return lines.join("\n");
}

/**
 * Formats the result of a keepalive daemon stop attempt.
 */
export function formatKeepAliveStopReport(
  report: KeepAliveStopReport,
  options: KeepAliveFormatOptions = {}
): string {
  const title = report.stopped ? "Keepalive Stop: STOPPED" : "Keepalive Stop: NOT RUNNING";

  if (options.quiet) {
    const parts = [title, `profile ${sanitizeConsoleText(report.profile_name)}`];
    if (typeof report.pid === "number") {
      parts.push(`PID ${report.pid}`);
    }
    if (report.reason) {
      parts.push(sanitizeConsoleText(report.reason));
    }
    return parts.join(" — ");
  }

  const lines = [title];

  lines.push(`Profile: ${sanitizeConsoleText(report.profile_name)}`);
  if (typeof report.pid === "number") {
    lines.push(`PID: ${report.pid}`);
  }
  lines.push(`State file: ${sanitizeConsoleText(report.state_path)}`);
  lines.push(`Event log: ${sanitizeConsoleText(report.log_path)}`);

  const statusEntries: string[] = [];
  if (report.reason) {
    statusEntries.push(`- ${sanitizeConsoleText(report.reason)}`);
  }
  if (report.forced) {
    statusEntries.push("- Stop required SIGKILL after the daemon ignored SIGTERM for 5 seconds.");
  }
  if (options.verbose && report.state?.lastError) {
    statusEntries.push(`- Last recorded error: ${sanitizeConsoleText(report.state.lastError)}`);
  }
  appendSection(lines, "Status", statusEntries);

  appendSection(
    lines,
    "Next Steps",
    formatStopNextSteps(report, Boolean(options.verbose)).map((step) => `- ${sanitizeConsoleText(step)}`)
  );

  return lines.join("\n");
}

/**
 * Formats a keepalive CLI error with operator guidance for human-readable
 * output.
 */
export function formatKeepAliveError(
  error: LinkedInAssistantErrorPayload,
  options: Pick<KeepAliveFormatOptions, "quiet"> = {}
): string {
  const lines = formatErrorLines(error);

  if (options.quiet) {
    return lines.join(" — ");
  }

  appendSection(
    lines,
    "What To Do",
    formatErrorNextSteps(error).map((step) => `- ${sanitizeConsoleText(step)}`)
  );
  return lines.join("\n");
}
