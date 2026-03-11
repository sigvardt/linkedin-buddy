import type {
  ActivityEventRecord,
  ActivityPollTickResult,
  ActivityWatch,
  ActivityWebhookConfig,
  CreatedWebhookSubscription,
  LinkedInBuddyErrorPayload,
  WebhookDeliveryAttemptRecord,
  WebhookSubscription
} from "@linkedin-buddy/core";

export type ActivityOutputMode = "human" | "json";

export type ActivityDaemonStateSummary = Pick<
  ActivityPollTickResult,
  | "claimedWatches"
  | "polledWatches"
  | "failedWatches"
  | "emittedEvents"
  | "enqueuedDeliveries"
  | "claimedDeliveries"
  | "deliveredAttempts"
  | "retriedDeliveries"
  | "failedDeliveries"
  | "deadLetterDeliveries"
  | "disabledSubscriptions"
>;

export interface ActivityDaemonState {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "idle" | "degraded" | "stopped";
  daemonPollIntervalMs: number;
  maxWatchesPerTick: number;
  maxDeliveriesPerTick: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  lastTickAt?: string;
  lastSuccessfulTickAt?: string;
  lastSummary?: ActivityDaemonStateSummary;
  lastError?: string;
  cdpUrl?: string;
  stoppedAt?: string;
}

export interface ActivityWatchAddReport {
  run_id: string;
  profile_name: string;
  watch: ActivityWatch;
}

export interface ActivityWatchListReport {
  run_id: string;
  profile_name: string;
  count: number;
  watches: ActivityWatch[];
}

export interface ActivityWatchMutationReport {
  run_id: string;
  watch: ActivityWatch;
}

export interface ActivityWatchRemovalReport {
  run_id: string;
  watch_id: string;
  removed: boolean;
}

export interface ActivityWebhookAddReport {
  run_id: string;
  subscription: CreatedWebhookSubscription;
}

export interface ActivityWebhookListReport {
  run_id: string;
  profile_name: string;
  count: number;
  subscriptions: WebhookSubscription[];
}

export interface ActivityWebhookMutationReport {
  run_id: string;
  subscription: WebhookSubscription;
}

export interface ActivityWebhookRemovalReport {
  run_id: string;
  subscription_id: string;
  removed: boolean;
}

export interface ActivityEventListReport {
  run_id: string;
  profile_name: string;
  count: number;
  events: ActivityEventRecord[];
}

export interface ActivityDeliveryListReport {
  run_id: string;
  profile_name: string;
  count: number;
  deliveries: WebhookDeliveryAttemptRecord[];
}

export interface ActivityStartReport {
  started: boolean;
  reason?: string;
  profile_name: string;
  pid?: number;
  state?: ActivityDaemonState | null;
  state_path: string;
  log_path: string;
  activity_config?: ActivityWebhookConfig;
  activity_config_error?: LinkedInBuddyErrorPayload;
}

export interface ActivityStatusReport {
  profile_name: string;
  running: boolean;
  pid: number | null;
  state: ActivityDaemonState | null;
  stale_pid_file: boolean;
  state_path: string;
  log_path: string;
  watch_count: number;
  active_watch_count: number;
  subscription_count: number;
  active_subscription_count: number;
  recent_event_count: number;
  recent_delivery_count: number;
  activity_config?: ActivityWebhookConfig;
  activity_config_error?: LinkedInBuddyErrorPayload;
}

export interface ActivityStopReport {
  stopped: boolean;
  profile_name: string;
  pid?: number;
  forced?: boolean;
  reason?: string;
  state_path: string;
  log_path: string;
}

export interface ActivityRunOnceReport extends ActivityPollTickResult {
  run_id: string;
  profile_name: string;
  activity_config: ActivityWebhookConfig;
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

function formatTimestamp(value: string | number | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return sanitizeConsoleText(value.trim());
  }

  return "n/a";
}

function formatCompactJson(value: unknown): string {
  try {
    return sanitizeConsoleText(JSON.stringify(value));
  } catch {
    return "{}";
  }
}

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatWatchSchedule(watch: ActivityWatch): string {
  if (watch.scheduleKind === "cron" && watch.cronExpression) {
    return `cron ${sanitizeConsoleText(watch.cronExpression)}`;
  }

  if (typeof watch.pollIntervalMs === "number") {
    return `every ${formatDurationMs(watch.pollIntervalMs)}`;
  }

  return sanitizeConsoleText(watch.scheduleKind);
}

function formatWatchTarget(watch: ActivityWatch): string {
  return formatCompactJson(watch.target);
}

function formatWatchLine(watch: ActivityWatch): string {
  const errorSuffix =
    watch.lastErrorCode || watch.lastErrorMessage
      ? `, last error ${sanitizeConsoleText(watch.lastErrorCode ?? "UNKNOWN")}: ${sanitizeConsoleText(watch.lastErrorMessage ?? "Unknown activity watch failure.")}`
      : "";

  return `- ${sanitizeConsoleText(watch.id)} — ${sanitizeConsoleText(watch.kind)}, ${sanitizeConsoleText(watch.status)}, ${formatWatchSchedule(watch)}, next poll ${formatTimestamp(watch.nextPollAtMs)}, target ${formatWatchTarget(watch)}${errorSuffix}`;
}

function formatSubscriptionLine(subscription: WebhookSubscription): string {
  const eventTypes = subscription.eventTypes.length > 0
    ? subscription.eventTypes.map(sanitizeConsoleText).join(", ")
    : "all supported events";
  const errorSuffix =
    subscription.lastErrorCode || subscription.lastErrorMessage
      ? `, last error ${sanitizeConsoleText(subscription.lastErrorCode ?? "UNKNOWN")}: ${sanitizeConsoleText(subscription.lastErrorMessage ?? "Unknown webhook delivery failure.")}`
      : "";

  return `- ${sanitizeConsoleText(subscription.id)} — ${sanitizeConsoleText(subscription.status)}, watch ${sanitizeConsoleText(subscription.watchId)}, events ${eventTypes}, max attempts ${subscription.maxAttempts}, endpoint ${sanitizeConsoleText(subscription.deliveryUrl)}${errorSuffix}`;
}

function formatEventLine(event: ActivityEventRecord): string {
  return `- ${sanitizeConsoleText(event.id)} — ${sanitizeConsoleText(event.eventType)}, watch ${sanitizeConsoleText(event.watchId)}, entity ${sanitizeConsoleText(event.entityKey)}, occurred ${formatTimestamp(event.occurredAtMs)}`;
}

function formatDeliveryLine(delivery: WebhookDeliveryAttemptRecord): string {
  const responseSuffix =
    typeof delivery.responseStatus === "number"
      ? `, HTTP ${delivery.responseStatus}`
      : "";
  const errorSuffix =
    delivery.lastErrorCode || delivery.lastErrorMessage
      ? `, error ${sanitizeConsoleText(delivery.lastErrorCode ?? "UNKNOWN")}: ${sanitizeConsoleText(delivery.lastErrorMessage ?? "Unknown webhook delivery failure.")}`
      : "";

  return `- ${sanitizeConsoleText(delivery.id)} — ${sanitizeConsoleText(delivery.status)}, attempt ${delivery.attemptNumber}, event ${sanitizeConsoleText(delivery.eventType)}, next attempt ${formatTimestamp(delivery.nextAttemptAtMs)}, endpoint ${sanitizeConsoleText(delivery.deliveryUrl)}${responseSuffix}${errorSuffix}`;
}

function formatActivityConfigSummary(config: ActivityWebhookConfig): string[] {
  return [
    `- Enabled: ${config.enabled ? "yes" : "no"}`,
    `- Polling: daemon every ${formatDurationMs(config.daemonPollIntervalMs)}, minimum watch interval ${formatDurationMs(config.minPollIntervalMs)}`,
    `- Capacity: ${formatCountLabel(config.maxWatchesPerTick, "watch")} per tick, ${formatCountLabel(config.maxConcurrentWatches, "active watch")} per profile, ${formatCountLabel(config.maxDeliveriesPerTick, "delivery")} per tick`,
    `- Queueing: depth ${config.maxEventQueueDepth}, watch lease ${formatDurationMs(config.watchLeaseTtlMs)}, delivery lease ${formatDurationMs(config.deliveryLeaseTtlMs)}`,
    `- Delivery: timeout ${formatDurationMs(config.deliveryTimeoutMs)}, clock skew ${formatDurationMs(config.clockSkewAllowanceMs)}, retry ${config.retry.maxAttempts} attempts with ${formatDurationMs(config.retry.initialBackoffMs)} → ${formatDurationMs(config.retry.maxBackoffMs)} backoff`
  ];
}

function formatActivitySummary(summary: ActivityDaemonStateSummary): string {
  return [
    `${summary.claimedWatches} claimed watch${summary.claimedWatches === 1 ? "" : "es"}`,
    `${summary.polledWatches} polled`,
    `${summary.failedWatches} failed`,
    `${summary.emittedEvents} event${summary.emittedEvents === 1 ? "" : "s"}`,
    `${summary.enqueuedDeliveries} enqueued ${summary.enqueuedDeliveries === 1 ? "delivery" : "deliveries"}`,
    `${summary.claimedDeliveries} claimed ${summary.claimedDeliveries === 1 ? "delivery" : "deliveries"}`,
    `${summary.deliveredAttempts} delivered`,
    `${summary.retriedDeliveries} retry`,
    `${summary.failedDeliveries} failed ${summary.failedDeliveries === 1 ? "delivery" : "deliveries"}`,
    `${summary.deadLetterDeliveries} dead-letter`,
    `${summary.disabledSubscriptions} disabled subscription${summary.disabledSubscriptions === 1 ? "" : "s"}`
  ].join(", ");
}

function readString(
  details: LinkedInBuddyErrorPayload["details"],
  key: string
): string | null {
  const value = details[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(
  details: LinkedInBuddyErrorPayload["details"],
  key: string
): number | null {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(
  details: LinkedInBuddyErrorPayload["details"],
  key: string
): string[] | null {
  const value = details[key];
  if (!Array.isArray(value)) {
    return null;
  }

  const strings = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());

  return strings.length > 0 ? strings : null;
}

function formatActivityErrorDetails(error: LinkedInBuddyErrorPayload): string[] {
  const lines = [sanitizeConsoleText(error.message)];
  const env = readString(error.details, "env");
  const field = readString(error.details, "field");
  const value = readString(error.details, "value");
  const example = readString(error.details, "example");
  const suggestion = readString(error.details, "suggestion");
  const defaultValue = readString(error.details, "default_value");
  const providedKind = readString(error.details, "provided_kind");
  const kind = readString(error.details, "kind");
  const profileName = readString(error.details, "profile_name");
  const supportedKinds = readStringArray(error.details, "supported_kinds");
  const supportedEventTypes = readStringArray(error.details, "supported_event_types");
  const providedEventTypes = readStringArray(error.details, "provided_event_types");
  const allowedValues = readStringArray(error.details, "allowed_values");
  const minimum = readNumber(error.details, "minimum");
  const maximum = readNumber(error.details, "maximum");
  const minimumSeconds = readNumber(error.details, "minimum_seconds");
  const activeWatchCount = readNumber(error.details, "active_watch_count");
  const maxConcurrentWatches = readNumber(
    error.details,
    "max_concurrent_watches"
  );

  if (env) {
    lines.push(`Setting: ${sanitizeConsoleText(env)}`);
  }
  if (field) {
    lines.push(`Field: ${sanitizeConsoleText(field)}`);
  }
  if (value) {
    lines.push(`Provided value: ${sanitizeConsoleText(value)}`);
  }
  if (providedKind) {
    lines.push(`Provided kind: ${sanitizeConsoleText(providedKind)}`);
  }
  if (kind) {
    lines.push(`Watch kind: ${sanitizeConsoleText(kind)}`);
  }
  if (profileName) {
    lines.push(`Profile: ${sanitizeConsoleText(profileName)}`);
  }
  if (typeof minimum === "number" && typeof maximum === "number") {
    lines.push(`Allowed range: ${minimum} to ${maximum}`);
  } else if (typeof minimum === "number") {
    lines.push(`Minimum allowed: ${minimum}`);
  } else if (typeof maximum === "number") {
    lines.push(`Maximum allowed: ${maximum}`);
  }
  if (typeof minimumSeconds === "number") {
    lines.push(`Minimum interval: ${minimumSeconds}s`);
  }
  if (supportedKinds) {
    lines.push(`Supported watch kinds: ${supportedKinds.map(sanitizeConsoleText).join(", ")}`);
  }
  if (supportedEventTypes) {
    lines.push(
      `Supported event types: ${supportedEventTypes.map(sanitizeConsoleText).join(", ")}`
    );
  }
  if (providedEventTypes) {
    lines.push(
      `Provided event types: ${providedEventTypes.map(sanitizeConsoleText).join(", ")}`
    );
  }
  if (allowedValues) {
    lines.push(`Allowed values: ${allowedValues.map(sanitizeConsoleText).join(", ")}`);
  }
  if (
    typeof activeWatchCount === "number" &&
    typeof maxConcurrentWatches === "number"
  ) {
    lines.push(
      `Active watch usage: ${activeWatchCount}/${maxConcurrentWatches} active watches already allocated.`
    );
  }
  if (defaultValue) {
    lines.push(`Default value: ${sanitizeConsoleText(defaultValue)}`);
  }
  if (example) {
    lines.push(`Example: ${sanitizeConsoleText(example)}`);
  }
  if (suggestion) {
    lines.push(`Suggested fix: ${sanitizeConsoleText(suggestion)}`);
  }

  return lines;
}

function formatActivityErrorNextSteps(error: LinkedInBuddyErrorPayload): string[] {
  const env = readString(error.details, "env");
  const field = readString(error.details, "field");
  const steps: string[] = [];

  if (env?.startsWith("LINKEDIN_BUDDY_ACTIVITY_")) {
    steps.push(
      "Fix the activity setting above, or unset it to fall back to the default value."
    );
  }

  if (field === "deliveryUrl") {
    steps.push(
      "Use an absolute http(s) webhook endpoint, then rerun the subscription command."
    );
  }

  if (error.code === "TARGET_NOT_FOUND") {
    steps.push(
      "List current watches or webhook subscriptions again to confirm the id you want to update."
    );
  }

  if (error.code === "AUTH_REQUIRED") {
    steps.push(
      "Open LinkedIn in the same browser session, sign in until the feed loads, then rerun the activity command."
    );
  }

  if (error.code === "CAPTCHA_OR_CHALLENGE") {
    steps.push(
      "Complete the LinkedIn checkpoint or verification in the same browser session before retrying."
    );
  }

  if (error.code === "RATE_LIMITED") {
    steps.push(
      "Wait for LinkedIn or the webhook endpoint throttle window to cool down before retrying."
    );
  }

  if (steps.length === 0) {
    steps.push(
      "Rerun the command. If it keeps failing, inspect the activity status output or rerun with --json for the structured payload."
    );
  }

  steps.push("Run `linkedin activity --help` for activity command examples.");
  steps.push("Rerun with --json if you need the structured error payload.");
  return steps;
}

export function resolveActivityOutputMode(
  input: { json?: boolean },
  stdoutIsTty: boolean
): ActivityOutputMode {
  return input.json || !stdoutIsTty ? "json" : "human";
}

export function formatActivityError(error: LinkedInBuddyErrorPayload): string {
  const lines = [
    `Activity command failed [${sanitizeConsoleText(error.code)}]`,
    ...formatActivityErrorDetails(error)
  ];

  lines.push(...formatActivityErrorNextSteps(error).map((step) => `Tip: ${sanitizeConsoleText(step)}`));
  return lines.join("\n");
}

export function formatActivityWatchAddReport(
  report: ActivityWatchAddReport
): string {
  const lines = [
    `Created activity watch for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- Watch id: ${sanitizeConsoleText(report.watch.id)}`,
    `- Kind: ${sanitizeConsoleText(report.watch.kind)}`,
    `- Status: ${sanitizeConsoleText(report.watch.status)}`,
    `- Schedule: ${formatWatchSchedule(report.watch)}`,
    `- Next poll: ${formatTimestamp(report.watch.nextPollAtMs)}`,
    `- Target: ${formatWatchTarget(report.watch)}`
  ];

  appendSection(lines, "Next Steps", [
    `- Run \`linkedin activity webhook add --watch ${sanitizeConsoleText(report.watch.id)} --url https://example.com/hooks/linkedin\` to deliver new activity events.`,
    `- Run \`linkedin activity watch list --profile ${sanitizeConsoleText(report.profile_name)}\` to review active watch state.`
  ]);

  return lines.join("\n");
}

export function formatActivityWatchListReport(
  report: ActivityWatchListReport
): string {
  const lines = [
    `Activity watches for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- ${formatCountLabel(report.count, "watch")} matched.`
  ];

  if (report.watches.length > 0) {
    appendSection(lines, "Watches", report.watches.map(formatWatchLine));
  } else {
    lines.push("- No activity watches found for this profile and filter combination.");
  }

  lines.push("");
  lines.push("Use `--json` if you need the structured activity payload for automation.");
  return lines.join("\n");
}

export function formatActivityWatchMutationReport(
  report: ActivityWatchMutationReport,
  action: "paused" | "resumed"
): string {
  const lines = [
    `Activity watch ${action} for profile ${sanitizeConsoleText(report.watch.profileName)}`,
    `- Watch id: ${sanitizeConsoleText(report.watch.id)}`,
    `- Kind: ${sanitizeConsoleText(report.watch.kind)}`,
    `- Status: ${sanitizeConsoleText(report.watch.status)}`,
    `- Next poll: ${formatTimestamp(report.watch.nextPollAtMs)}`
  ];

  appendSection(lines, "Next Steps", [
    `- Run \`linkedin activity watch list --profile ${sanitizeConsoleText(report.watch.profileName)}\` to confirm the updated watch state.`
  ]);

  return lines.join("\n");
}

export function formatActivityWatchRemovalReport(
  report: ActivityWatchRemovalReport
): string {
  const lines = [
    `Removed activity watch ${sanitizeConsoleText(report.watch_id)}`,
    `- Removed: ${report.removed ? "yes" : "no"}`
  ];

  appendSection(lines, "Next Steps", [
    "- Run `linkedin activity watch list --profile <profile>` to confirm the remaining watch set.",
    "- Removing a watch also removes its webhook subscriptions and future deliveries."
  ]);

  return lines.join("\n");
}

export function formatActivityWebhookAddReport(
  report: ActivityWebhookAddReport
): string {
  const eventTypes = report.subscription.eventTypes.length > 0
    ? report.subscription.eventTypes.map(sanitizeConsoleText).join(", ")
    : "all supported events";
  const lines = [
    `Registered activity webhook subscription ${sanitizeConsoleText(report.subscription.id)}`,
    `- Watch id: ${sanitizeConsoleText(report.subscription.watchId)}`,
    `- Endpoint: ${sanitizeConsoleText(report.subscription.deliveryUrl)}`,
    `- Event filters: ${eventTypes}`,
    `- Max attempts: ${report.subscription.maxAttempts}`,
    `- Signing secret: ${sanitizeConsoleText(report.subscription.signingSecret)}`
  ];

  appendSection(lines, "Next Steps", [
    `- Save the signing secret now. It is only returned when the subscription is created.`,
    `- Run \`linkedin activity deliveries --subscription ${sanitizeConsoleText(report.subscription.id)}\` after the next poll to inspect delivery attempts.`
  ]);

  return lines.join("\n");
}

export function formatActivityWebhookListReport(
  report: ActivityWebhookListReport
): string {
  const lines = [
    `Activity webhook subscriptions for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- ${formatCountLabel(report.count, "subscription")} matched.`
  ];

  if (report.subscriptions.length > 0) {
    appendSection(lines, "Subscriptions", report.subscriptions.map(formatSubscriptionLine));
  } else {
    lines.push("- No webhook subscriptions found for this profile and filter combination.");
  }

  lines.push("");
  lines.push("Use `--json` if you need the structured activity payload for automation.");
  return lines.join("\n");
}

export function formatActivityWebhookMutationReport(
  report: ActivityWebhookMutationReport,
  action: "paused" | "resumed"
): string {
  const lines = [
    `Webhook subscription ${action}`,
    `- Subscription id: ${sanitizeConsoleText(report.subscription.id)}`,
    `- Watch id: ${sanitizeConsoleText(report.subscription.watchId)}`,
    `- Status: ${sanitizeConsoleText(report.subscription.status)}`,
    `- Endpoint: ${sanitizeConsoleText(report.subscription.deliveryUrl)}`
  ];

  appendSection(lines, "Next Steps", [
    "- Run `linkedin activity webhook list --profile <profile>` to review current webhook routing state."
  ]);

  return lines.join("\n");
}

export function formatActivityWebhookRemovalReport(
  report: ActivityWebhookRemovalReport
): string {
  const lines = [
    `Removed webhook subscription ${sanitizeConsoleText(report.subscription_id)}`,
    `- Removed: ${report.removed ? "yes" : "no"}`
  ];

  appendSection(lines, "Next Steps", [
    "- Run `linkedin activity webhook list --profile <profile>` to confirm the remaining subscriptions.",
    "- Existing queued deliveries may still appear in history until they are processed or expire."
  ]);

  return lines.join("\n");
}

export function formatActivityEventListReport(
  report: ActivityEventListReport
): string {
  const lines = [
    `Recent activity events for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- Showing ${formatCountLabel(report.count, "event")}.`
  ];

  if (report.events.length > 0) {
    appendSection(lines, "Events", report.events.map(formatEventLine));
  } else {
    lines.push("- No activity events are recorded for this profile yet.");
  }

  lines.push("");
  lines.push("Use `--json` if you need the structured activity payload for automation.");
  return lines.join("\n");
}

export function formatActivityDeliveryListReport(
  report: ActivityDeliveryListReport
): string {
  const lines = [
    `Recent webhook deliveries for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- Showing ${formatCountLabel(report.count, "delivery attempt")}.`
  ];

  if (report.deliveries.length > 0) {
    appendSection(lines, "Deliveries", report.deliveries.map(formatDeliveryLine));
  } else {
    lines.push("- No webhook delivery attempts are recorded for this profile yet.");
  }

  lines.push("");
  lines.push("Use `--json` if you need the structured activity payload for automation.");
  return lines.join("\n");
}

export function formatActivityStartReport(
  report: ActivityStartReport
): string {
  const lines = [
    report.started
      ? `Activity daemon started for profile ${sanitizeConsoleText(report.profile_name)}`
      : `Activity daemon not started for profile ${sanitizeConsoleText(report.profile_name)}`,
    ...(typeof report.pid === "number"
      ? [`- PID: ${report.pid}`]
      : []),
    `- State path: ${sanitizeConsoleText(report.state_path)}`,
    `- Event log: ${sanitizeConsoleText(report.log_path)}`
  ];

  if (report.reason) {
    lines.push(`- Status: ${sanitizeConsoleText(report.reason)}`);
  }

  if (report.activity_config) {
    appendSection(lines, "Config", formatActivityConfigSummary(report.activity_config));
  }

  if (report.activity_config_error) {
    appendSection(
      lines,
      "Config Issue",
      formatActivityErrorDetails(report.activity_config_error).map(
        (entry) => `- ${sanitizeConsoleText(entry)}`
      )
    );
  }

  appendSection(lines, "Next Steps", [
    `- Run \`linkedin activity status --profile ${sanitizeConsoleText(report.profile_name)}\` to confirm the daemon becomes running or idle.`,
    `- Run \`linkedin activity stop --profile ${sanitizeConsoleText(report.profile_name)}\` when you want to stop background polling.`,
    "- Use `--json` if you need the structured activity payload for automation."
  ]);

  return lines.join("\n");
}

export function formatActivityStatusReport(
  report: ActivityStatusReport
): string {
  const lines = [
    `Activity daemon status for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- Daemon: ${report.running ? "running" : "not running"}`,
    `- PID: ${report.pid ?? "n/a"}`,
    `- State path: ${sanitizeConsoleText(report.state_path)}`,
    `- Event log: ${sanitizeConsoleText(report.log_path)}`
  ];

  if (report.stale_pid_file) {
    lines.push("- Warning: a stale PID file is present for this profile.");
  }

  appendSection(lines, "Queues", [
    `- Watches: ${report.active_watch_count}/${report.watch_count} active`,
    `- Webhooks: ${report.active_subscription_count}/${report.subscription_count} active`,
    `- Recent history: ${report.recent_event_count} events, ${report.recent_delivery_count} delivery attempts`
  ]);

  if (report.state) {
    const stateEntries = [
      `- State: ${sanitizeConsoleText(report.state.status)}`,
      `- Started: ${formatTimestamp(report.state.startedAt)}`,
      `- Updated: ${formatTimestamp(report.state.updatedAt)}`,
      `- Poll interval: ${formatDurationMs(report.state.daemonPollIntervalMs)}`,
      `- Per tick: ${report.state.maxWatchesPerTick} watches, ${report.state.maxDeliveriesPerTick} deliveries`,
      `- Consecutive failures: ${report.state.consecutiveFailures}/${report.state.maxConsecutiveFailures}`
    ];

    if (report.state.lastTickAt) {
      stateEntries.push(`- Last tick: ${formatTimestamp(report.state.lastTickAt)}`);
    }
    if (report.state.lastSuccessfulTickAt) {
      stateEntries.push(
        `- Last successful tick: ${formatTimestamp(report.state.lastSuccessfulTickAt)}`
      );
    }
    if (report.state.lastSummary) {
      stateEntries.push(
        `- Last summary: ${formatActivitySummary(report.state.lastSummary)}`
      );
    }
    if (report.state.lastError) {
      stateEntries.push(
        `- Last recorded error: ${sanitizeConsoleText(report.state.lastError)}`
      );
    }

    appendSection(lines, "State", stateEntries);
  }

  if (report.activity_config) {
    appendSection(lines, "Config", formatActivityConfigSummary(report.activity_config));
  }

  if (report.activity_config_error) {
    appendSection(
      lines,
      "Config Issue",
      formatActivityErrorDetails(report.activity_config_error).map(
        (entry) => `- ${sanitizeConsoleText(entry)}`
      )
    );
  }

  const nextSteps = [
    report.running
      ? `Run \`linkedin activity stop --profile ${sanitizeConsoleText(report.profile_name)}\` to stop background polling.`
      : `Run \`linkedin activity start --profile ${sanitizeConsoleText(report.profile_name)}\` to start background polling.`,
    `Run \`linkedin activity run-once --profile ${sanitizeConsoleText(report.profile_name)}\` to process due work immediately without leaving the daemon running.`,
    "Use `--json` if you need the structured activity payload for automation."
  ];

  if (report.activity_config_error) {
    nextSteps.unshift(
      "Fix the invalid activity configuration before relying on the daemon for webhook polling."
    );
  }
  if (report.stale_pid_file) {
    nextSteps.unshift(
      `Run \`linkedin activity stop --profile ${sanitizeConsoleText(report.profile_name)}\` once to clean up the stale PID file safely.`
    );
  }

  appendSection(lines, "Next Steps", nextSteps.map((step) => `- ${sanitizeConsoleText(step)}`));
  return lines.join("\n");
}

export function formatActivityStopReport(
  report: ActivityStopReport
): string {
  const lines = [
    report.stopped
      ? `Activity daemon stopped for profile ${sanitizeConsoleText(report.profile_name)}`
      : `Activity daemon already stopped for profile ${sanitizeConsoleText(report.profile_name)}`,
    ...(typeof report.pid === "number"
      ? [`- PID: ${report.pid}`]
      : []),
    `- State path: ${sanitizeConsoleText(report.state_path)}`,
    `- Event log: ${sanitizeConsoleText(report.log_path)}`
  ];

  if (report.reason) {
    lines.push(`- Status: ${sanitizeConsoleText(report.reason)}`);
  }
  if (report.forced) {
    lines.push("- Stop required SIGKILL after the daemon ignored SIGTERM for 5 seconds.");
  }

  appendSection(lines, "Next Steps", [
    `- Run \`linkedin activity status --profile ${sanitizeConsoleText(report.profile_name)}\` to confirm the daemon is stopped and inspect queue counts.`,
    `- Run \`linkedin activity start --profile ${sanitizeConsoleText(report.profile_name)}\` when you are ready to resume background polling.`
  ]);

  return lines.join("\n");
}

export function formatActivityRunOnceReport(
  report: ActivityRunOnceReport
): string {
  const lines = [
    `Activity poll tick completed for profile ${sanitizeConsoleText(report.profile_name)}`,
    `- Watches: ${report.claimedWatches} claimed, ${report.polledWatches} polled, ${report.failedWatches} failed, ${report.emittedEvents} events emitted, ${report.enqueuedDeliveries} deliveries enqueued`,
    `- Deliveries: ${report.claimedDeliveries} claimed, ${report.deliveredAttempts} delivered, ${report.retriedDeliveries} retry, ${report.failedDeliveries} failed, ${report.deadLetterDeliveries} dead-letter, ${report.disabledSubscriptions} subscriptions disabled`,
    `- Worker: ${sanitizeConsoleText(report.workerId)}`
  ];

  if (report.watchResults.length > 0) {
    appendSection(
      lines,
      "Watch Results",
      report.watchResults.map((result) => {
        const errorSuffix =
          result.errorCode || result.errorMessage
            ? `, error ${sanitizeConsoleText(result.errorCode ?? "UNKNOWN")}: ${sanitizeConsoleText(result.errorMessage ?? "Unknown poll failure.")}`
            : "";
        return `- ${sanitizeConsoleText(result.watchId)} — ${sanitizeConsoleText(result.kind)}, ${result.emittedEvents} events, ${result.enqueuedDeliveries} enqueued deliveries${errorSuffix}`;
      })
    );
  }

  if (report.deliveryResults.length > 0) {
    appendSection(
      lines,
      "Delivery Results",
      report.deliveryResults.map((result) => {
        const statusSuffix =
          typeof result.responseStatus === "number"
            ? `, HTTP ${result.responseStatus}`
            : "";
        const errorSuffix =
          result.errorCode || result.errorMessage
            ? `, error ${sanitizeConsoleText(result.errorCode ?? "UNKNOWN")}: ${sanitizeConsoleText(result.errorMessage ?? "Unknown delivery failure.")}`
            : "";
        return `- ${sanitizeConsoleText(result.deliveryId)} — ${sanitizeConsoleText(result.outcome)}, subscription ${sanitizeConsoleText(result.subscriptionId)}${statusSuffix}${errorSuffix}`;
      })
    );
  }

  const nextSteps = [
    `Run \`linkedin activity status --profile ${sanitizeConsoleText(report.profile_name)}\` to inspect daemon health and queue counts.`,
    `Run \`linkedin activity deliveries --profile ${sanitizeConsoleText(report.profile_name)}\` to inspect recent webhook outcomes.`,
    "Use `--json` if you need the structured activity payload for automation."
  ];

  if (
    report.failedWatches > 0 ||
    report.failedDeliveries > 0 ||
    report.deadLetterDeliveries > 0
  ) {
    nextSteps.unshift(
      "Review the failed watch or delivery entries above before relying on this polling configuration in production."
    );
  } else if (report.claimedWatches === 0 && report.claimedDeliveries === 0) {
    nextSteps.unshift(
      "No due activity work was found. Review watch schedules if you expected work to be processed now."
    );
  }

  appendSection(lines, "Next Steps", nextSteps.map((step) => `- ${sanitizeConsoleText(step)}`));
  return lines.join("\n");
}
