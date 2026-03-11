import type {
  LinkedInBuddyErrorPayload,
  SchedulerConfig,
  SchedulerLane,
  SchedulerTickJobResult,
  SchedulerTickResult
} from "@linkedin-buddy/core";

export type SchedulerOutputMode = "human" | "json";

export interface SchedulerStateSummaryView {
  skippedReason: SchedulerTickResult["skippedReason"];
  discoveredAcceptedConnections: number;
  queuedJobs: number;
  updatedJobs: number;
  reopenedJobs: number;
  cancelledJobs: number;
  claimedJobs: number;
  preparedJobs: number;
  rescheduledJobs: number;
  failedJobs: number;
}

export interface SchedulerStateView {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "idle" | "degraded" | "stopped";
  pollIntervalMs: number;
  businessHours: SchedulerConfig["businessHours"];
  maxJobsPerTick: number;
  maxActiveJobsPerProfile: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  lastTickAt?: string;
  lastSuccessfulTickAt?: string;
  lastPreparedAt?: string;
  nextWindowStartAt?: string | null;
  lastSummary?: SchedulerStateSummaryView;
  lastError?: string;
  cdpUrl?: string;
  stoppedAt?: string;
}

export interface SchedulerJobPreview {
  id: string;
  lane: SchedulerLane;
  status: "pending" | "leased" | "prepared" | "failed" | "cancelled";
  targetLabel?: string;
  scheduledAt: string;
  updatedAt: string;
  attemptCount: number;
  maxAttempts: number;
  preparedActionId?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

export interface SchedulerJobCounts {
  total: number;
  pending: number;
  pendingDueNow: number;
  pendingLater: number;
  leased: number;
  prepared: number;
  failed: number;
  cancelled: number;
}

export interface SchedulerStatusReport {
  profile_name: string;
  running: boolean;
  pid: number | null;
  state: SchedulerStateView | null;
  stale_pid_file: boolean;
  state_path: string;
  log_path: string;
  scheduler_config?: SchedulerConfig;
  scheduler_config_error?: LinkedInBuddyErrorPayload;
  job_counts: SchedulerJobCounts;
  next_jobs: SchedulerJobPreview[];
  recent_jobs: SchedulerJobPreview[];
}

export interface SchedulerStartReport {
  started: boolean;
  reason?: string;
  profile_name: string;
  pid?: number;
  state?: SchedulerStateView | null;
  state_path: string;
  log_path: string;
  scheduler_config?: SchedulerConfig;
  scheduler_config_error?: LinkedInBuddyErrorPayload;
}

export interface SchedulerStopReport {
  stopped: boolean;
  profile_name: string;
  pid?: number;
  forced?: boolean;
  reason?: string;
  state_path: string;
  log_path: string;
}

export interface SchedulerRunOnceReport extends SchedulerTickResult {
  run_id: string;
  scheduler_config: SchedulerConfig;
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

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBusinessHours(config: SchedulerConfig["businessHours"]): string {
  return `${sanitizeConsoleText(config.startTime)}-${sanitizeConsoleText(config.endTime)} ${sanitizeConsoleText(config.timeZone)}`;
}

function formatLaneList(lanes: SchedulerConfig["enabledLanes"]): string {
  if (lanes.length === 0) {
    return "none";
  }

  return lanes.map((lane) => sanitizeConsoleText(lane)).join(", ");
}

function formatSchedulerSkipReason(
  reason: SchedulerTickResult["skippedReason"]
): string | null {
  if (reason === null) {
    return null;
  }

  switch (reason) {
    case "disabled":
      return "Scheduler work is disabled by the current scheduler configuration.";
    case "outside_business_hours":
      return "The scheduler is waiting for the next configured business-hours window.";
    case "profile_busy":
      return "The profile is currently busy with another CLI, MCP, or daemon task.";
    default:
      return sanitizeConsoleText(reason);
  }
}

function formatJobDescriptor(job: {
  lane: SchedulerLane;
  targetLabel?: string;
}): string {
  const lane = sanitizeConsoleText(job.lane);
  const target =
    typeof job.targetLabel === "string" && job.targetLabel.trim().length > 0
      ? ` / ${sanitizeConsoleText(job.targetLabel)}`
      : "";

  return `${lane}${target}`;
}

function formatJobPreviewLine(job: SchedulerJobPreview): string {
  const suffixes = [
    `${formatStatusLabel(job.status).toLowerCase()}, due ${sanitizeConsoleText(job.scheduledAt)}`,
    `attempt ${job.attemptCount}/${job.maxAttempts}`
  ];

  if (job.preparedActionId) {
    suffixes.push(`prepared action ${sanitizeConsoleText(job.preparedActionId)}`);
  }
  if (job.lastErrorCode) {
    suffixes.push(`code=${sanitizeConsoleText(job.lastErrorCode)}`);
  }
  if (job.lastErrorMessage) {
    suffixes.push(sanitizeConsoleText(job.lastErrorMessage));
  }

  return `- ${formatJobDescriptor(job)} — ${suffixes.join(" | ")}`;
}

function formatRecentJobLine(job: SchedulerJobPreview): string {
  const suffixes = [`updated ${sanitizeConsoleText(job.updatedAt)}`];
  if (job.preparedActionId) {
    suffixes.push(`prepared action ${sanitizeConsoleText(job.preparedActionId)}`);
  }
  if (job.lastErrorCode) {
    suffixes.push(`code=${sanitizeConsoleText(job.lastErrorCode)}`);
  }
  if (job.lastErrorMessage) {
    suffixes.push(sanitizeConsoleText(job.lastErrorMessage));
  }

  return `- ${formatStatusLabel(job.status)} ${formatJobDescriptor(job)} — ${suffixes.join(" | ")}`;
}

function formatProcessedJobLine(job: SchedulerTickJobResult): string {
  const parts = [`${sanitizeConsoleText(job.lane)} / ${sanitizeConsoleText(job.jobId)}`];

  if (job.preparedActionId) {
    parts.push(`prepared action ${sanitizeConsoleText(job.preparedActionId)}`);
  }
  if (job.scheduledAtMs) {
    parts.push(`next attempt ${sanitizeConsoleText(new Date(job.scheduledAtMs).toISOString())}`);
  }
  if (job.errorCode) {
    parts.push(`code=${sanitizeConsoleText(job.errorCode)}`);
  }
  if (job.errorMessage) {
    parts.push(sanitizeConsoleText(job.errorMessage));
  }

  return `- ${formatStatusLabel(job.outcome)} ${parts.join(" | ")}`;
}

function formatConfigSummary(config: SchedulerConfig): string[] {
  return [
    `- Poll interval: every ${formatDurationMs(config.pollIntervalMs)}`,
    `- Business hours: ${formatBusinessHours(config.businessHours)}`,
    `- Enabled lanes: ${formatLaneList(config.enabledLanes)}`,
    `- Max jobs per tick: ${config.maxJobsPerTick} | Active job cap: ${config.maxActiveJobsPerProfile}`
  ];
}

function formatStateSummary(summary: SchedulerStateSummaryView): string {
  const parts = [
    `${formatCountLabel(summary.discoveredAcceptedConnections, "accepted connection")} discovered`,
    `${summary.queuedJobs} queued`,
    `${summary.updatedJobs} updated`,
    `${summary.reopenedJobs} reopened`,
    `${summary.cancelledJobs} cancelled`,
    `${summary.claimedJobs} claimed`,
    `${summary.preparedJobs} prepared`,
    `${summary.rescheduledJobs} rescheduled`,
    `${summary.failedJobs} failed`
  ];

  if (summary.skippedReason !== null) {
    parts.push(`skipped=${sanitizeConsoleText(summary.skippedReason)}`);
  }

  return parts.join(" | ");
}

function formatStatusHeadline(report: SchedulerStatusReport): string {
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

function formatStatusNextSteps(report: SchedulerStatusReport): string[] {
  const profile = sanitizeConsoleText(report.profile_name);
  const steps: string[] = [];

  if (report.stale_pid_file) {
    steps.push(
      `Run \`linkedin scheduler stop --profile ${profile}\` to clear the stale PID file safely.`
    );
  } else if (report.running) {
    steps.push(
      `Run \`linkedin scheduler run-once --profile ${profile}\` to force an immediate tick.`
    );
    steps.push(
      `Run \`linkedin scheduler stop --profile ${profile}\` to stop the daemon.`
    );
  } else {
    steps.push(
      `Run \`linkedin scheduler start --profile ${profile}\` to start the daemon.`
    );
  }

  if (report.scheduler_config_error) {
    steps.push(
      "Fix the scheduler environment variable listed above, or unset it to fall back to the default scheduler setting."
    );
  } else if (report.scheduler_config && report.scheduler_config.enabledLanes.length === 0) {
    steps.push(
      "Re-enable at least one scheduler lane before expecting queued follow-ups to prepare automatically."
    );
  }

  if (report.job_counts.total === 0) {
    steps.push(
      "Accepted invitations create follow-up jobs when they are discovered; an empty queue is normal on a fresh profile."
    );
  }

  steps.push("Use `--json` if you need the structured scheduler payload for automation.");
  return steps;
}

function formatRunOnceNextSteps(report: SchedulerRunOnceReport): string[] {
  const profile = sanitizeConsoleText(report.profileName);
  const steps: string[] = [];

  if (report.preparedJobs > 0) {
    steps.push(
      "Review and manually confirm any prepared follow-up actions; the scheduler never auto-confirms them."
    );
  }

  if (report.skippedReason === "outside_business_hours" && report.nextWindowStartAt) {
    steps.push(
      `Rerun after ${sanitizeConsoleText(report.nextWindowStartAt)} or wait for the daemon to resume inside business hours.`
    );
  } else if (report.skippedReason === "profile_busy") {
    steps.push(
      `Wait for the current profile activity to finish, then rerun \`linkedin scheduler run-once --profile ${profile}\`.`
    );
  } else if (report.processedJobs.length === 0) {
    steps.push(
      `Run \`linkedin scheduler status --profile ${profile}\` to inspect the queue and recent job history.`
    );
  }

  steps.push(
    `Run \`linkedin scheduler start --profile ${profile}\` if you want the scheduler to keep polling in the background.`
  );
  return steps;
}

function formatStartNextSteps(report: SchedulerStartReport): string[] {
  const profile = sanitizeConsoleText(report.profile_name);

  if (!report.started) {
    return [
      `Run \`linkedin scheduler status --profile ${profile}\` to inspect the existing daemon.`,
      `Run \`linkedin scheduler stop --profile ${profile}\` if you need to restart it cleanly.`,
      "Use `--json` if you need the structured scheduler payload for automation."
    ];
  }

  return [
    `Run \`linkedin scheduler status --profile ${profile}\` to inspect daemon health, queue state, and recent job history.`,
    "Prepared follow-up actions still require manual confirmation; nothing is sent automatically.",
    "Use `--json` if you need the structured scheduler payload for automation."
  ];
}

function formatStopNextSteps(report: SchedulerStopReport): string[] {
  const profile = sanitizeConsoleText(report.profile_name);

  if (report.stopped) {
    return [
      `Run \`linkedin scheduler status --profile ${profile}\` to confirm the daemon is idle.`,
      `Run \`linkedin scheduler start --profile ${profile}\` when you want background scheduling again.`,
      "Use `--json` if you need the structured scheduler payload for automation."
    ];
  }

  return [
    `Run \`linkedin scheduler start --profile ${profile}\` to launch the daemon.`,
    "Use `--json` if you need the structured scheduler payload for automation."
  ];
}

export function resolveSchedulerOutputMode(
  input: { json?: boolean },
  interactiveTerminal: boolean
): SchedulerOutputMode {
  if (input.json) {
    return "json";
  }

  return interactiveTerminal ? "human" : "json";
}

export function formatSchedulerStatusReport(report: SchedulerStatusReport): string {
  const lines = [`Scheduler Status: ${formatStatusHeadline(report)}`];

  lines.push(`Profile: ${sanitizeConsoleText(report.profile_name)}`);
  lines.push(`PID: ${report.pid === null ? "none" : report.pid}`);
  lines.push(`State file: ${sanitizeConsoleText(report.state_path)}`);
  lines.push(`Event log: ${sanitizeConsoleText(report.log_path)}`);

  if (report.scheduler_config_error) {
    appendSection(lines, "Config Warning", [
      `- ${sanitizeConsoleText(report.scheduler_config_error.message)}`
    ]);
  } else if (report.scheduler_config) {
    appendSection(lines, "Config", formatConfigSummary(report.scheduler_config));
  }

  if (report.state) {
    const daemonEntries = [
      `- State: ${formatStatusLabel(report.state.status)} | Updated: ${sanitizeConsoleText(report.state.updatedAt)}`,
      `- Started: ${sanitizeConsoleText(report.state.startedAt)}`,
      `- Consecutive failures: ${report.state.consecutiveFailures}/${report.state.maxConsecutiveFailures}`
    ];

    if (report.state.lastTickAt) {
      daemonEntries.push(`- Last tick: ${sanitizeConsoleText(report.state.lastTickAt)}`);
    }
    if (report.state.lastSuccessfulTickAt) {
      daemonEntries.push(
        `- Last successful tick: ${sanitizeConsoleText(report.state.lastSuccessfulTickAt)}`
      );
    }
    if (report.state.lastPreparedAt) {
      daemonEntries.push(
        `- Last prepared action: ${sanitizeConsoleText(report.state.lastPreparedAt)}`
      );
    }
    if (report.state.nextWindowStartAt) {
      daemonEntries.push(
        `- Next business window: ${sanitizeConsoleText(report.state.nextWindowStartAt)}`
      );
    }
    if (report.state.lastSummary) {
      daemonEntries.push(`- Last summary: ${formatStateSummary(report.state.lastSummary)}`);
      const skippedMessage = formatSchedulerSkipReason(report.state.lastSummary.skippedReason);
      if (skippedMessage) {
        daemonEntries.push(`- Last skip reason: ${skippedMessage}`);
      }
    }
    if (report.state.lastError) {
      daemonEntries.push(`- Last error: ${sanitizeConsoleText(report.state.lastError)}`);
    }
    if (report.state.stoppedAt) {
      daemonEntries.push(`- Stopped: ${sanitizeConsoleText(report.state.stoppedAt)}`);
    }

    appendSection(lines, "Daemon", daemonEntries);
  }

  const queueEntries = [
    `- Jobs: ${report.job_counts.total} total | ${report.job_counts.pending} pending (${report.job_counts.pendingDueNow} due now, ${report.job_counts.pendingLater} later) | ${report.job_counts.leased} leased | ${report.job_counts.prepared} prepared | ${report.job_counts.failed} failed | ${report.job_counts.cancelled} cancelled`
  ];

  if (report.job_counts.total === 0) {
    queueEntries.push(
      "- No scheduler jobs are recorded for this profile yet."
    );
  }

  appendSection(lines, "Queue", queueEntries);
  appendSection(
    lines,
    "Next Jobs",
    report.next_jobs.length > 0
      ? report.next_jobs.map((job) => formatJobPreviewLine(job))
      : ["- No pending or leased jobs are currently queued."]
  );
  appendSection(
    lines,
    "Recent History",
    report.recent_jobs.length > 0
      ? report.recent_jobs.map((job) => formatRecentJobLine(job))
      : ["- No prepared, failed, or cancelled jobs have been recorded yet."]
  );
  appendSection(
    lines,
    "Next Steps",
    formatStatusNextSteps(report).map((step) => `- ${step}`)
  );

  return lines.join("\n");
}

export function formatSchedulerStartReport(report: SchedulerStartReport): string {
  const title = report.started ? "Scheduler Start: STARTED" : "Scheduler Start: ALREADY RUNNING";
  const lines = [title];

  lines.push(`Profile: ${sanitizeConsoleText(report.profile_name)}`);
  if (typeof report.pid === "number") {
    lines.push(`PID: ${report.pid}`);
  }
  lines.push(`State file: ${sanitizeConsoleText(report.state_path)}`);
  lines.push(`Event log: ${sanitizeConsoleText(report.log_path)}`);

  if (report.scheduler_config_error) {
    appendSection(lines, "Config Warning", [
      `- ${sanitizeConsoleText(report.scheduler_config_error.message)}`
    ]);
  } else if (report.scheduler_config) {
    appendSection(lines, "Config", formatConfigSummary(report.scheduler_config));
  }

  if (report.reason) {
    appendSection(lines, "Status", [`- ${sanitizeConsoleText(report.reason)}`]);
  }

  if (report.state?.lastSummary) {
    appendSection(lines, "Current State", [
      `- Daemon state: ${formatStatusLabel(report.state.status)}`,
      `- Last summary: ${formatStateSummary(report.state.lastSummary)}`
    ]);
  }

  appendSection(
    lines,
    "Notes",
    [
      "- The scheduler prepares follow-ups near their due time and only during configured business hours.",
      "- Prepared follow-up actions still require manual confirmation."
    ]
  );
  appendSection(
    lines,
    "Next Steps",
    formatStartNextSteps(report).map((step) => `- ${step}`)
  );

  return lines.join("\n");
}

export function formatSchedulerStopReport(report: SchedulerStopReport): string {
  const title = report.stopped ? "Scheduler Stop: STOPPED" : "Scheduler Stop: NOT RUNNING";
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
  appendSection(lines, "Status", statusEntries);
  appendSection(
    lines,
    "Next Steps",
    formatStopNextSteps(report).map((step) => `- ${step}`)
  );

  return lines.join("\n");
}

export function formatSchedulerRunOnceReport(report: SchedulerRunOnceReport): string {
  const headline = report.skippedReason === null ? "Scheduler Tick: COMPLETED" : "Scheduler Tick: SKIPPED";
  const lines = [headline];

  lines.push(`Profile: ${sanitizeConsoleText(report.profileName)}`);
  lines.push(`Run: ${sanitizeConsoleText(report.run_id)}`);

  appendSection(lines, "Config", formatConfigSummary(report.scheduler_config));

  const summaryEntries = [
    `- Window open: ${report.windowOpen ? "yes" : "no"}`,
    `- Accepted connections discovered: ${report.discoveredAcceptedConnections}`,
    `- Queue sync: ${report.queuedJobs} queued | ${report.updatedJobs} updated | ${report.reopenedJobs} reopened | ${report.cancelledJobs} cancelled`,
    `- Execution: ${report.claimedJobs} claimed | ${report.preparedJobs} prepared | ${report.rescheduledJobs} rescheduled | ${report.failedJobs} failed`
  ];

  if (report.skippedReason !== null) {
    const skippedMessage = formatSchedulerSkipReason(report.skippedReason);
    if (skippedMessage) {
      summaryEntries.push(`- Result: ${skippedMessage}`);
    }
  }
  if (report.nextWindowStartAt) {
    summaryEntries.push(
      `- Next business window: ${sanitizeConsoleText(report.nextWindowStartAt)}`
    );
  }
  appendSection(lines, "Summary", summaryEntries);

  appendSection(
    lines,
    "Processed Jobs",
    report.processedJobs.length > 0
      ? report.processedJobs.map((job) => formatProcessedJobLine(job))
      : ["- No scheduler jobs were processed in this tick."]
  );
  appendSection(
    lines,
    "Next Steps",
    formatRunOnceNextSteps(report).map((step) => `- ${step}`)
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

function readStringArray(
  payload: Record<string, unknown>,
  key: string
): string[] | null {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return null;
  }

  const strings = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());

  return strings.length > 0 ? strings : null;
}

export function formatSchedulerError(error: LinkedInBuddyErrorPayload): string {
  const lines = [`Scheduler command failed [${sanitizeConsoleText(error.code)}]`, sanitizeConsoleText(error.message)];
  const env = readString(error.details, "env");
  const value = readString(error.details, "value");
  const path = readString(error.details, "path");
  const cause = readString(error.details, "cause");
  const invalidLanes = readStringArray(error.details, "invalid_lanes");
  const supportedLanes = readStringArray(error.details, "supported_lanes");
  const startTime = readString(error.details, "start_time");
  const endTime = readString(error.details, "end_time");
  const timeZone = readString(error.details, "time_zone");
  const maxJobsPerTick = readNumber(error.details, "max_jobs_per_tick");
  const maxActiveJobsPerProfile = readNumber(
    error.details,
    "max_active_jobs_per_profile"
  );

  if (env) {
    lines.push(`Setting: ${sanitizeConsoleText(env)}`);
  }
  if (path) {
    lines.push(`Path: ${sanitizeConsoleText(path)}`);
  }
  if (value) {
    lines.push(`Provided value: ${sanitizeConsoleText(value)}`);
  }
  if (invalidLanes) {
    lines.push(`Invalid lanes: ${invalidLanes.map(sanitizeConsoleText).join(", ")}`);
  }
  if (supportedLanes) {
    lines.push(`Supported lanes: ${supportedLanes.map(sanitizeConsoleText).join(", ")}`);
  }
  if (startTime && endTime) {
    lines.push(
      `Business hours: ${sanitizeConsoleText(startTime)} → ${sanitizeConsoleText(endTime)}${timeZone ? ` (${sanitizeConsoleText(timeZone)})` : ""}`
    );
  }
  if (
    typeof maxJobsPerTick === "number" &&
    typeof maxActiveJobsPerProfile === "number"
  ) {
    lines.push(
      `Constraint: max jobs per tick (${maxJobsPerTick}) must be less than or equal to max active jobs per profile (${maxActiveJobsPerProfile}).`
    );
  }
  if (cause) {
    lines.push(`Cause: ${sanitizeConsoleText(cause)}`);
  }

  if (env?.startsWith("LINKEDIN_BUDDY_SCHEDULER_")) {
    lines.push(
      "Tip: fix the scheduler setting above, or unset it to use the default scheduler value."
    );
  }

  lines.push("Tip: run `linkedin scheduler --help` for scheduler command examples.");
  lines.push("Tip: rerun with --json if you need the structured error payload.");
  return lines.join("\n");
}
