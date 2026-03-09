#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_WATCH_KINDS,
  ACTIVITY_WATCH_STATUSES,
  DEFAULT_FOLLOWUP_SINCE,
  LINKEDIN_FEED_REACTION_TYPES,
  LINKEDIN_POST_VISIBILITY_TYPES,
  LINKEDIN_SELECTOR_LOCALES,
  LinkedInAssistantError,
  createCoreRuntime,
  normalizeLinkedInFeedReaction,
  normalizeLinkedInPostVisibility,
  resolveFollowupSinceWindow,
  redactStructuredValue,
  resolvePrivacyConfig,
  toLinkedInAssistantErrorPayload,
  WEBHOOK_DELIVERY_ATTEMPT_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type ActivityEventType,
  type ActivityWatchKind,
  type ActivityWatchStatus,
  type SearchCategory,
  type WebhookDeliveryAttemptStatus,
  type WebhookSubscriptionStatus
} from "@linkedin-assistant/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import {
  LINKEDIN_ACTIONS_CONFIRM_TOOL,
  LINKEDIN_ACTIVITY_DELIVERIES_LIST_TOOL,
  LINKEDIN_ACTIVITY_EVENTS_LIST_TOOL,
  LINKEDIN_ACTIVITY_POLLER_RUN_ONCE_TOOL,
  LINKEDIN_ACTIVITY_WATCH_CREATE_TOOL,
  LINKEDIN_ACTIVITY_WATCH_LIST_TOOL,
  LINKEDIN_ACTIVITY_WATCH_PAUSE_TOOL,
  LINKEDIN_ACTIVITY_WATCH_REMOVE_TOOL,
  LINKEDIN_ACTIVITY_WATCH_RESUME_TOOL,
  LINKEDIN_ACTIVITY_WEBHOOK_CREATE_TOOL,
  LINKEDIN_ACTIVITY_WEBHOOK_LIST_TOOL,
  LINKEDIN_ACTIVITY_WEBHOOK_PAUSE_TOOL,
  LINKEDIN_ACTIVITY_WEBHOOK_REMOVE_TOOL,
  LINKEDIN_ACTIVITY_WEBHOOK_RESUME_TOOL,
  LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  LINKEDIN_CONNECTIONS_INVITE_TOOL,
  LINKEDIN_CONNECTIONS_LIST_TOOL,
  LINKEDIN_CONNECTIONS_PENDING_TOOL,
  LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  LINKEDIN_FEED_COMMENT_TOOL,
  LINKEDIN_FEED_LIKE_TOOL,
  LINKEDIN_FEED_LIST_TOOL,
  LINKEDIN_FEED_VIEW_POST_TOOL,
  LINKEDIN_INBOX_GET_THREAD_TOOL,
  LINKEDIN_INBOX_LIST_THREADS_TOOL,
  LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  LINKEDIN_PROFILE_VIEW_TOOL,
  LINKEDIN_JOBS_SEARCH_TOOL,
  LINKEDIN_JOBS_VIEW_TOOL,
  LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_TOOL,
  LINKEDIN_SEARCH_TOOL,
  LINKEDIN_SESSION_HEALTH_TOOL,
  LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  LINKEDIN_SESSION_STATUS_TOOL
} from "../index.js";

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }> };
type ToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
};
type ToolHandler = (args: ToolArgs) => Promise<ToolResult>;

const mcpPrivacyConfig = resolvePrivacyConfig();
const SELECTOR_AUDIT_DOC_PATH = "docs/selector-audit.md";
const SELECTOR_AUDIT_MCP_HINT =
  `For broader UI-drift diagnostics, run the CLI selector audit ("linkedin audit selectors") and see ${SELECTOR_AUDIT_DOC_PATH}.`;

function withSelectorAuditHint(description: string): string {
  return `${description} ${SELECTOR_AUDIT_MCP_HINT}`;
}

function readString(args: ToolArgs, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readRequiredString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`
  );
}

function readPositiveNumber(
  args: ToolArgs,
  key: string,
  fallback: number
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a positive number.`
    );
  }

  return value;
}

function readBoolean(args: ToolArgs, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalPositiveNumber(
  args: ToolArgs,
  key: string
): number | undefined {
  if (!(key in args) || args[key] === undefined) {
    return undefined;
  }

  return readPositiveNumber(args, key, 1);
}

function readStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be a string or array of strings.`
  );
}

function readObject(
  args: ToolArgs,
  key: string
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be an object.`
  );
}

function coerceEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} must be one of: ${allowed.join(", ")}.`
  );
}

function readActivityWatchKind(args: ToolArgs, key: string): ActivityWatchKind {
  return coerceEnumValue(
    readRequiredString(args, key),
    ACTIVITY_WATCH_KINDS,
    key
  );
}

function readOptionalActivityWatchStatus(
  args: ToolArgs,
  key: string
): ActivityWatchStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(
    value.trim(),
    ACTIVITY_WATCH_STATUSES,
    key
  );
}

function readOptionalWebhookSubscriptionStatus(
  args: ToolArgs,
  key: string
): WebhookSubscriptionStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(
    value.trim(),
    WEBHOOK_SUBSCRIPTION_STATUSES,
    key
  );
}

function readOptionalWebhookDeliveryStatus(
  args: ToolArgs,
  key: string
): WebhookDeliveryAttemptStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(
    value.trim(),
    WEBHOOK_DELIVERY_ATTEMPT_STATUSES,
    key
  );
}

function readActivityEventTypes(
  args: ToolArgs,
  key: string
): ActivityEventType[] | undefined {
  const values = readStringArray(args, key);
  if (!values) {
    return undefined;
  }

  return values.map((value) =>
    coerceEnumValue(value, ACTIVITY_EVENT_TYPES, key)
  );
}


function readSearchCategory(
  args: ToolArgs,
  key: string,
  fallback: SearchCategory
): SearchCategory {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const category = value.trim();
  if (category === "people" || category === "companies" || category === "jobs") {
    return category;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be one of: people, companies, jobs.`
  );
}

function toToolResult(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          redactStructuredValue(payload, mcpPrivacyConfig, "cli"),
          null,
          2
        )
      }
    ]
  };
}

function toErrorResult(error: unknown): ToolErrorResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          toLinkedInAssistantErrorPayload(error, mcpPrivacyConfig),
          null,
          2
        )
      }
    ]
  };
}

function readTargetProfileName(target: Record<string, unknown>): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

const cdpUrlInputSchemaProperty = {
  type: "string",
  description:
    "Connect to an existing browser via CDP endpoint (for example http://127.0.0.1:18800)."
} as const;

const selectorLocaleInputSchemaProperty = {
  type: "string",
  description: `Prefer localized LinkedIn UI text first (${LINKEDIN_SELECTOR_LOCALES.join(
    ", "
  )}; region tags like da-DK normalize to da). Unsupported values fall back to en.`
} as const;

function withCdpSchemaProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...properties,
    cdpUrl: cdpUrlInputSchemaProperty,
    selectorLocale: selectorLocaleInputSchemaProperty
  };
}

function createRuntime(args: ToolArgs) {
  const cdpUrl = readString(args, "cdpUrl", "");
  const selectorLocale = readString(args, "selectorLocale", "");
  return createCoreRuntime(
    cdpUrl
      ? {
          cdpUrl,
          privacy: mcpPrivacyConfig,
          ...(selectorLocale ? { selectorLocale } : {})
        }
      : {
          privacy: mcpPrivacyConfig,
          ...(selectorLocale ? { selectorLocale } : {})
        }
  );
}

async function handleSessionStatus(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.session.status.start", {
      profileName
    });

    const status = await runtime.auth.status({
      profileName
    });

    runtime.logger.log("info", "mcp.session.status.done", {
      profileName,
      authenticated: status.authenticated
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      status
    });
  } finally {
    runtime.close();
  }
}

async function handleSessionOpenLogin(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const timeoutMs = readPositiveNumber(args, "timeoutMs", 5 * 60_000);

    runtime.logger.log("info", "mcp.session.open_login.start", {
      profileName,
      timeoutMs
    });

    const status = await runtime.auth.openLogin({
      profileName,
      timeoutMs
    });

    runtime.logger.log("info", "mcp.session.open_login.done", {
      profileName,
      authenticated: status.authenticated,
      timedOut: status.timedOut
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      status
    });
  } finally {
    runtime.close();
  }
}

async function handleSessionHealth(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.session.health.start", {
      profileName
    });

    const health = await runtime.healthCheck({
      profileName
    });

    runtime.logger.log("info", "mcp.session.health.done", {
      profileName,
      browserHealthy: health.browser.healthy,
      authenticated: health.session.authenticated
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...health
    });
  } finally {
    runtime.close();
  }
}

async function handleListThreads(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 20);
    const unreadOnly = readBoolean(args, "unreadOnly", false);

    runtime.logger.log("info", "mcp.inbox.list_threads.start", {
      profileName,
      limit,
      unreadOnly
    });

    const threads = await runtime.inbox.listThreads({
      profileName,
      limit,
      unreadOnly
    });

    runtime.logger.log("info", "mcp.inbox.list_threads.done", {
      profileName,
      count: threads.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: threads.length,
      threads
    });
  } finally {
    runtime.close();
  }
}

async function handleGetThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const limit = readPositiveNumber(args, "limit", 20);

    runtime.logger.log("info", "mcp.inbox.get_thread.start", {
      profileName,
      thread,
      limit
    });

    const detail = await runtime.inbox.getThread({
      profileName,
      thread,
      limit
    });

    runtime.logger.log("info", "mcp.inbox.get_thread.done", {
      profileName,
      threadId: detail.thread_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      thread: detail
    });
  } finally {
    runtime.close();
  }
}

async function handlePrepareReply(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.inbox.prepare_reply.start", {
      profileName,
      thread
    });

    const prepared = await runtime.inbox.prepareReply({
      profileName,
      thread,
      text,
      ...(operatorNote
        ? {
            operatorNote
          }
        : {})
    });

    runtime.logger.log("info", "mcp.inbox.prepare_reply.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleProfileView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readString(args, "target", "me");

    runtime.logger.log("info", "mcp.profile.view.start", {
      profileName,
      target
    });

    const profile = await runtime.profile.viewProfile({
      profileName,
      target
    });

    runtime.logger.log("info", "mcp.profile.view.done", {
      profileName,
      fullName: profile.full_name
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      profile
    });
  } finally {
    runtime.close();
  }
}

async function handleNotificationsList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 20);

    runtime.logger.log("info", "mcp.notifications.list.start", {
      profileName,
      limit
    });

    const notifications = await runtime.notifications.listNotifications({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.notifications.list.done", {
      profileName,
      count: notifications.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: notifications.length,
      notifications
    });
  } finally {
    runtime.close();
  }
}

async function handleJobsSearch(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const location = readString(args, "location", "");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.jobs.search.start", {
      profileName,
      query,
      location,
      limit
    });

    const result = await runtime.jobs.searchJobs({
      profileName,
      query,
      ...(location ? { location } : {}),
      limit
    });

    runtime.logger.log("info", "mcp.jobs.search.done", {
      profileName,
      count: result.count
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...result
    });
  } finally {
    runtime.close();
  }
}

async function handleJobsView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const jobId = readRequiredString(args, "jobId");

    runtime.logger.log("info", "mcp.jobs.view.start", {
      profileName,
      jobId
    });

    const job = await runtime.jobs.viewJob({
      profileName,
      jobId
    });

    runtime.logger.log("info", "mcp.jobs.view.done", {
      profileName,
      jobId: job.job_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      job
    });
  } finally {
    runtime.close();
  }
}

async function handleSearch(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const category = readSearchCategory(args, "category", "people");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.search.start", {
      profileName,
      query,
      category,
      limit
    });

    const search = await runtime.search.search({
      profileName,
      query,
      category,
      limit
    });

    runtime.logger.log("info", "mcp.search.done", {
      profileName,
      category: search.category,
      count: search.count
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...search
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 40);

    runtime.logger.log("info", "mcp.connections.list.start", {
      profileName,
      limit
    });

    const connections = await runtime.connections.listConnections({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.connections.list.done", {
      profileName,
      count: connections.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: connections.length,
      connections
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsPending(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const filterRaw = readString(args, "filter", "all");
    const filter = (["sent", "received", "all"].includes(filterRaw)
      ? filterRaw
      : "all") as "sent" | "received" | "all";

    runtime.logger.log("info", "mcp.connections.pending.start", {
      profileName,
      filter
    });

    const invitations = await runtime.connections.listPendingInvitations({
      profileName,
      filter
    });

    runtime.logger.log("info", "mcp.connections.pending.done", {
      profileName,
      count: invitations.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      filter,
      count: invitations.length,
      invitations
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsInvite(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const note = readString(args, "note", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.invite.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareSendInvitation({
      profileName,
      targetProfile,
      ...(note ? { note } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.invite.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsAccept(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.accept.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareAcceptInvitation({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.accept.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsWithdraw(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.withdraw.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareWithdrawInvitation({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.withdraw.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handlePrepareFollowupAfterAccept(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const since = readString(args, "since", DEFAULT_FOLLOWUP_SINCE);
    const { sinceMs } = resolveFollowupSinceWindow(since);
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.followups.prepare.start", {
      profileName,
      since
    });

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      profileName,
      since,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.followups.prepare.done", {
      profileName,
      acceptedConnectionCount: result.acceptedConnections.length,
      preparedCount: result.preparedFollowups.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      since,
      since_ms: sinceMs,
      since_at: new Date(sinceMs).toISOString(),
      accepted_connection_count: result.acceptedConnections.length,
      prepared_count: result.preparedFollowups.length,
      accepted_connections: result.acceptedConnections,
      prepared_followups: result.preparedFollowups
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.feed.list.start", {
      profileName,
      limit
    });

    const posts = await runtime.feed.viewFeed({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.feed.list.done", {
      profileName,
      count: posts.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: posts.length,
      posts
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedViewPost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");

    runtime.logger.log("info", "mcp.feed.view_post.start", {
      profileName,
      postUrl
    });

    const post = await runtime.feed.viewPost({
      profileName,
      postUrl
    });

    runtime.logger.log("info", "mcp.feed.view_post.done", {
      profileName,
      postId: post.post_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      post
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedLike(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const reaction = normalizeLinkedInFeedReaction(readString(args, "reaction", "like"));
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.like.start", {
      profileName,
      postUrl,
      reaction
    });

    const prepared = runtime.feed.prepareLikePost({
      profileName,
      postUrl,
      reaction,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.like.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      reaction
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedComment(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.comment.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareCommentOnPost({
      profileName,
      postUrl,
      text,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.comment.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handlePostPrepareCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const text = readRequiredString(args, "text");
    const visibility = normalizeLinkedInPostVisibility(
      readString(args, "visibility", "public"),
      "public"
    );
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.post.prepare_create.start", {
      profileName,
      visibility
    });

    const prepared = await runtime.posts.prepareCreate({
      profileName,
      text,
      visibility,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.post.prepare_create.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      visibility
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWatchCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const kind = readActivityWatchKind(args, "kind");
    const target = readObject(args, "target");
    const intervalSeconds = readOptionalPositiveNumber(args, "intervalSeconds");
    const cron = readString(args, "cron", "");

    runtime.logger.log("info", "mcp.activity_watch.create.start", {
      profileName,
      kind
    });

    const watch = runtime.activityWatches.createWatch({
      profileName,
      kind,
      ...(target ? { target } : {}),
      ...(typeof intervalSeconds === "number" ? { intervalSeconds } : {}),
      ...(cron ? { cron } : {})
    });

    runtime.logger.log("info", "mcp.activity_watch.create.done", {
      profileName,
      watchId: watch.id,
      kind: watch.kind
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      watch
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWatchList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const status = readOptionalActivityWatchStatus(args, "status");

    runtime.logger.log("info", "mcp.activity_watch.list.start", {
      profileName,
      status: status ?? null
    });

    const watches = runtime.activityWatches.listWatches({
      profileName,
      ...(status ? { status } : {})
    });

    runtime.logger.log("info", "mcp.activity_watch.list.done", {
      profileName,
      count: watches.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: watches.length,
      watches
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWatchPause(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const watchId = readRequiredString(args, "watchId");
    const watch = runtime.activityWatches.pauseWatch(watchId);
    return toToolResult({
      run_id: runtime.runId,
      watch
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWatchResume(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const watchId = readRequiredString(args, "watchId");
    const watch = runtime.activityWatches.resumeWatch(watchId);
    return toToolResult({
      run_id: runtime.runId,
      watch
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWatchRemove(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const watchId = readRequiredString(args, "watchId");
    const removed = runtime.activityWatches.removeWatch(watchId);
    return toToolResult({
      run_id: runtime.runId,
      watch_id: watchId,
      removed
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWebhookCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const watchId = readRequiredString(args, "watchId");
    const deliveryUrl = readRequiredString(args, "deliveryUrl");
    const eventTypes = readActivityEventTypes(args, "eventTypes");
    const signingSecret = readString(args, "signingSecret", "");
    const maxAttempts = readOptionalPositiveNumber(args, "maxAttempts");

    runtime.logger.log("info", "mcp.activity_webhook.create.start", {
      watchId,
      eventTypeCount: eventTypes?.length ?? 0
    });

    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId,
      deliveryUrl,
      ...(eventTypes ? { eventTypes } : {}),
      ...(signingSecret ? { signingSecret } : {}),
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {})
    });

    runtime.logger.log("info", "mcp.activity_webhook.create.done", {
      watchId,
      subscriptionId: subscription.id
    });

    return toToolResult({
      run_id: runtime.runId,
      subscription
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWebhookList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const watchId = readString(args, "watchId", "");
    const status = readOptionalWebhookSubscriptionStatus(args, "status");

    const subscriptions = runtime.activityWatches.listWebhookSubscriptions({
      profileName,
      ...(watchId ? { watchId } : {}),
      ...(status ? { status } : {})
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: subscriptions.length,
      subscriptions
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWebhookPause(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const subscriptionId = readRequiredString(args, "subscriptionId");
    const subscription = runtime.activityWatches.pauseWebhookSubscription(
      subscriptionId
    );
    return toToolResult({
      run_id: runtime.runId,
      subscription
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWebhookResume(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const subscriptionId = readRequiredString(args, "subscriptionId");
    const subscription = runtime.activityWatches.resumeWebhookSubscription(
      subscriptionId
    );
    return toToolResult({
      run_id: runtime.runId,
      subscription
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityWebhookRemove(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const subscriptionId = readRequiredString(args, "subscriptionId");
    const removed = runtime.activityWatches.removeWebhookSubscription(
      subscriptionId
    );
    return toToolResult({
      run_id: runtime.runId,
      subscription_id: subscriptionId,
      removed
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityEventsList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const watchId = readString(args, "watchId", "");
    const limit = readPositiveNumber(args, "limit", 20);
    const events = runtime.activityWatches.listEvents({
      profileName,
      ...(watchId ? { watchId } : {}),
      limit
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: events.length,
      events
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityDeliveriesList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const watchId = readString(args, "watchId", "");
    const subscriptionId = readString(args, "subscriptionId", "");
    const status = readOptionalWebhookDeliveryStatus(args, "status");
    const limit = readPositiveNumber(args, "limit", 20);
    const deliveries = runtime.activityWatches.listDeliveries({
      profileName,
      ...(watchId ? { watchId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(status ? { status } : {}),
      limit
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: deliveries.length,
      deliveries
    });
  } finally {
    runtime.close();
  }
}

async function handleActivityPollerRunOnce(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.activity_poller.run_once.start", {
      profileName
    });

    const result = await runtime.activityPoller.runTick({
      profileName,
      workerId: `mcp:${runtime.runId}`
    });

    runtime.logger.log("info", "mcp.activity_poller.run_once.done", {
      profileName,
      emittedEvents: result.emittedEvents,
      deliveredAttempts: result.deliveredAttempts
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      result
    });
  } finally {
    runtime.close();
  }
}

async function handleConfirm(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const token = readRequiredString(args, "token");

    runtime.logger.log("info", "mcp.actions.confirm.start", {
      profileName
    });

    const preview = runtime.twoPhaseCommit.getPreparedActionPreviewByToken({
      confirmToken: token
    });

    const preparedProfileName = readTargetProfileName(preview.target);
    if (preparedProfileName && preparedProfileName !== profileName) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action belongs to profile "${preparedProfileName}", but "${profileName}" was provided.`,
        {
          expected_profile_name: preparedProfileName,
          provided_profile_name: profileName
        }
      );
    }

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: token
    });

    runtime.logger.log("info", "mcp.actions.confirm.done", {
      profileName,
      preparedActionId: result.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      preview,
      result
    });
  } finally {
    runtime.close();
  }
}

const server = new Server(
  {
    name: "linkedin-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: LINKEDIN_SESSION_STATUS_TOOL,
        description: "Check LinkedIn session authentication status for a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            }
          })
        }
      },
      {
        name: LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
        description: "Open LinkedIn login and wait for authentication in a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            timeoutMs: {
              type: "number",
              description: "Maximum time to wait for authentication, in milliseconds."
            }
          })
        }
      },
      {
        name: LINKEDIN_SESSION_HEALTH_TOOL,
        description: "Check browser connectivity and LinkedIn session health for a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_LIST_THREADS_TOOL,
        description: withSelectorAuditHint(
          "List LinkedIn inbox threads for a profile."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of threads to return."
            },
            unreadOnly: {
              type: "boolean",
              description: "If true, only unread threads are returned."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_GET_THREAD_TOOL,
        description: withSelectorAuditHint(
          "Get one LinkedIn thread with recent messages."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["thread"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            thread: {
              type: "string",
              description: "Thread id or LinkedIn thread URL."
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to include."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
        description: "Prepare a two-phase send_message action for a thread.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["thread", "text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            thread: {
              type: "string",
              description: "Thread id or LinkedIn thread URL."
            },
            text: {
              type: "string",
              description: "Message text to prepare for sending."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_VIEW_TOOL,
        description:
          withSelectorAuditHint(
            "View a LinkedIn profile. Returns structured profile data including name, headline, location, about, experience, and education."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Vanity name (e.g. 'johndoe'), profile URL, or 'me' for own profile. Defaults to 'me'."
            }
          })
        }
      },
      {
        name: LINKEDIN_SEARCH_TOOL,
        description: withSelectorAuditHint(
          "Search LinkedIn for people, companies, or jobs."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            query: {
              type: "string",
              description: "Search keywords."
            },
            category: {
              type: "string",
              enum: ["people", "companies", "jobs"],
              description: "Search category. Defaults to people."
            },
            limit: {
              type: "number",
              description: "Max results. Defaults to 10."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_LIST_TOOL,
        description:
          withSelectorAuditHint(
            "List your LinkedIn connections. Returns connection names, headlines, profile URLs, and when connected."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of connections to return. Defaults to 40."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_PENDING_TOOL,
        description:
          withSelectorAuditHint(
            "List pending LinkedIn connection invitations (sent, received, or both)."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            filter: {
              type: "string",
              enum: ["sent", "received", "all"],
              description:
                "Filter invitations by direction. Defaults to all."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_INVITE_TOOL,
        description:
          "Prepare a connection invitation to a LinkedIn user (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name (e.g. 'johndoe') or full profile URL."
            },
            note: {
              type: "string",
              description: "Optional invitation note (max 300 chars)."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
        description:
          "Prepare to accept a pending connection invitation (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name or profile URL of the person who sent the invitation."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
        description:
          "Prepare to withdraw a sent connection invitation (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name or profile URL of the person to withdraw the invitation from."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
        description:
          "Detect newly accepted sent invitations and prepare follow-up messages (two-phase: returns confirm tokens). Use linkedin.actions.confirm to execute each prepared follow-up.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            since: {
              type: "string",
              description:
                "Lookback window such as 30m, 12h, 7d, or 2w. Defaults to 7d."
            },
            operatorNote: {
              type: "string",
              description: "Internal note attached to each prepared follow-up."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_LIST_TOOL,
        description:
          withSelectorAuditHint(
            "List posts from your LinkedIn feed with author, text, and engagement counts."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of feed posts to return. Defaults to 10."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_VIEW_POST_TOOL,
        description: withSelectorAuditHint(
          "View one LinkedIn feed post by URL, URN, or activity id."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_LIKE_TOOL,
        description:
          "Prepare to react to a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            },
            reaction: {
              type: "string",
              enum: [...LINKEDIN_FEED_REACTION_TYPES],
              description: "Reaction type. Defaults to like."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_COMMENT_TOOL,
        description:
          "Prepare to comment on a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl", "text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            },
            text: {
              type: "string",
              description: "Comment text to prepare."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_POST_PREPARE_CREATE_TOOL,
        description:
          "Prepare a new LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to publish.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            text: {
              type: "string",
              description: "Post text to prepare for publishing."
            },
            visibility: {
              type: "string",
              enum: [...LINKEDIN_POST_VISIBILITY_TYPES],
              description: "Post visibility. Defaults to public."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NOTIFICATIONS_LIST_TOOL,
        description:
          withSelectorAuditHint(
            "List your LinkedIn notifications. Returns notification type, message, timestamp, link, and read/unread status."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of notifications to return. Defaults to 20."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_SEARCH_TOOL,
        description:
          withSelectorAuditHint(
            "Search for LinkedIn job postings by keyword and optional location."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            query: {
              type: "string",
              description: "Search keywords for jobs."
            },
            location: {
              type: "string",
              description: "Location filter for jobs."
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 10."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_VIEW_TOOL,
        description:
          withSelectorAuditHint(
            "View details of a specific LinkedIn job posting by job ID."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            jobId: {
              type: "string",
              description: "LinkedIn job ID."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WATCH_CREATE_TOOL,
        description:
          "Create a durable poll-based LinkedIn activity watch for one profile and activity source.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            kind: {
              type: "string",
              enum: [...ACTIVITY_WATCH_KINDS],
              description: "Activity watch kind."
            },
            target: {
              type: "object",
              description: "Optional watch target object for profile/feed/inbox filters."
            },
            intervalSeconds: {
              type: "number",
              description: "Optional polling interval in seconds."
            },
            cron: {
              type: "string",
              description: "Optional cron schedule expression."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WATCH_LIST_TOOL,
        description: "List configured LinkedIn activity watches for a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            status: {
              type: "string",
              enum: [...ACTIVITY_WATCH_STATUSES],
              description: "Optional watch status filter."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WATCH_PAUSE_TOOL,
        description: "Pause one activity watch by id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["watchId"],
          properties: withCdpSchemaProperties({
            watchId: {
              type: "string",
              description: "Activity watch id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WATCH_RESUME_TOOL,
        description: "Resume one activity watch by id and make it due immediately.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["watchId"],
          properties: withCdpSchemaProperties({
            watchId: {
              type: "string",
              description: "Activity watch id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WATCH_REMOVE_TOOL,
        description: "Remove one activity watch by id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["watchId"],
          properties: withCdpSchemaProperties({
            watchId: {
              type: "string",
              description: "Activity watch id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WEBHOOK_CREATE_TOOL,
        description: "Create a webhook subscription for one activity watch.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["watchId", "deliveryUrl"],
          properties: withCdpSchemaProperties({
            watchId: {
              type: "string",
              description: "Activity watch id."
            },
            deliveryUrl: {
              type: "string",
              description: "Webhook delivery URL."
            },
            eventTypes: {
              type: "array",
              items: {
                type: "string",
                enum: [...ACTIVITY_EVENT_TYPES]
              },
              description: "Optional event filters for this subscription."
            },
            signingSecret: {
              type: "string",
              description: "Optional pre-shared signing secret."
            },
            maxAttempts: {
              type: "number",
              description: "Optional maximum delivery attempts."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WEBHOOK_LIST_TOOL,
        description: "List webhook subscriptions for activity watches.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            watchId: {
              type: "string",
              description: "Optional watch id filter."
            },
            status: {
              type: "string",
              enum: [...WEBHOOK_SUBSCRIPTION_STATUSES],
              description: "Optional webhook subscription status filter."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WEBHOOK_PAUSE_TOOL,
        description: "Pause one activity webhook subscription by id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["subscriptionId"],
          properties: withCdpSchemaProperties({
            subscriptionId: {
              type: "string",
              description: "Webhook subscription id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WEBHOOK_RESUME_TOOL,
        description: "Resume one activity webhook subscription by id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["subscriptionId"],
          properties: withCdpSchemaProperties({
            subscriptionId: {
              type: "string",
              description: "Webhook subscription id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_WEBHOOK_REMOVE_TOOL,
        description: "Remove one activity webhook subscription by id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["subscriptionId"],
          properties: withCdpSchemaProperties({
            subscriptionId: {
              type: "string",
              description: "Webhook subscription id."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_EVENTS_LIST_TOOL,
        description: "List emitted LinkedIn activity events from local persistent state.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            watchId: {
              type: "string",
              description: "Optional watch id filter."
            },
            limit: {
              type: "number",
              description: "Maximum number of events to return. Defaults to 20."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_DELIVERIES_LIST_TOOL,
        description: "List webhook delivery attempts from local persistent state.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            watchId: {
              type: "string",
              description: "Optional watch id filter."
            },
            subscriptionId: {
              type: "string",
              description: "Optional webhook subscription id filter."
            },
            status: {
              type: "string",
              enum: [...WEBHOOK_DELIVERY_ATTEMPT_STATUSES],
              description: "Optional delivery status filter."
            },
            limit: {
              type: "number",
              description: "Maximum number of delivery attempts to return. Defaults to 20."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIVITY_POLLER_RUN_ONCE_TOOL,
        description:
          "Run one local activity polling tick now and return the watch and delivery summary.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            }
          })
        }
      },
      {
        name: LINKEDIN_ACTIONS_CONFIRM_TOOL,
        description: "Confirm and execute a prepared action by confirm token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent profile expected for this action."
            },
            token: {
              type: "string",
              description: "Confirmation token in ct_... format."
            }
          })
        }
      }
    ]
  };
});

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  [LINKEDIN_SESSION_STATUS_TOOL]: handleSessionStatus,
  [LINKEDIN_SESSION_OPEN_LOGIN_TOOL]: handleSessionOpenLogin,
  [LINKEDIN_SESSION_HEALTH_TOOL]: handleSessionHealth,
  [LINKEDIN_INBOX_LIST_THREADS_TOOL]: handleListThreads,
  [LINKEDIN_INBOX_GET_THREAD_TOOL]: handleGetThread,
  [LINKEDIN_INBOX_PREPARE_REPLY_TOOL]: handlePrepareReply,
  [LINKEDIN_PROFILE_VIEW_TOOL]: handleProfileView,
  [LINKEDIN_SEARCH_TOOL]: handleSearch,
  [LINKEDIN_CONNECTIONS_LIST_TOOL]: handleConnectionsList,
  [LINKEDIN_CONNECTIONS_PENDING_TOOL]: handleConnectionsPending,
  [LINKEDIN_CONNECTIONS_INVITE_TOOL]: handleConnectionsInvite,
  [LINKEDIN_CONNECTIONS_ACCEPT_TOOL]: handleConnectionsAccept,
  [LINKEDIN_CONNECTIONS_WITHDRAW_TOOL]: handleConnectionsWithdraw,
  [LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL]: handlePrepareFollowupAfterAccept,
  [LINKEDIN_FEED_LIST_TOOL]: handleFeedList,
  [LINKEDIN_FEED_VIEW_POST_TOOL]: handleFeedViewPost,
  [LINKEDIN_FEED_LIKE_TOOL]: handleFeedLike,
  [LINKEDIN_FEED_COMMENT_TOOL]: handleFeedComment,
  [LINKEDIN_POST_PREPARE_CREATE_TOOL]: handlePostPrepareCreate,
  [LINKEDIN_NOTIFICATIONS_LIST_TOOL]: handleNotificationsList,
  [LINKEDIN_JOBS_SEARCH_TOOL]: handleJobsSearch,
  [LINKEDIN_JOBS_VIEW_TOOL]: handleJobsView,
  [LINKEDIN_ACTIVITY_WATCH_CREATE_TOOL]: handleActivityWatchCreate,
  [LINKEDIN_ACTIVITY_WATCH_LIST_TOOL]: handleActivityWatchList,
  [LINKEDIN_ACTIVITY_WATCH_PAUSE_TOOL]: handleActivityWatchPause,
  [LINKEDIN_ACTIVITY_WATCH_RESUME_TOOL]: handleActivityWatchResume,
  [LINKEDIN_ACTIVITY_WATCH_REMOVE_TOOL]: handleActivityWatchRemove,
  [LINKEDIN_ACTIVITY_WEBHOOK_CREATE_TOOL]: handleActivityWebhookCreate,
  [LINKEDIN_ACTIVITY_WEBHOOK_LIST_TOOL]: handleActivityWebhookList,
  [LINKEDIN_ACTIVITY_WEBHOOK_PAUSE_TOOL]: handleActivityWebhookPause,
  [LINKEDIN_ACTIVITY_WEBHOOK_RESUME_TOOL]: handleActivityWebhookResume,
  [LINKEDIN_ACTIVITY_WEBHOOK_REMOVE_TOOL]: handleActivityWebhookRemove,
  [LINKEDIN_ACTIVITY_EVENTS_LIST_TOOL]: handleActivityEventsList,
  [LINKEDIN_ACTIVITY_DELIVERIES_LIST_TOOL]: handleActivityDeliveriesList,
  [LINKEDIN_ACTIVITY_POLLER_RUN_ONCE_TOOL]: handleActivityPollerRunOnce,
  [LINKEDIN_ACTIONS_CONFIRM_TOOL]: handleConfirm
};

/** Dispatches one MCP tool call to the registered LinkedIn tool handlers. */
export async function handleToolCall(
  name: string,
  args: ToolArgs = {}
): Promise<ToolResult | ToolErrorResult> {
  try {
    const handler = TOOL_HANDLERS[name];
    if (handler) {
      return await handler(args);
    }

    return toErrorResult(`Unknown tool: ${name}`);
  } catch (error) {
    return toErrorResult(error);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as ToolArgs;
  return handleToolCall(name, args);
});

async function startLinkedInMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isDirectExecution(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return pathToFileURL(entrypoint).href === moduleUrl;
}

if (isDirectExecution(import.meta.url)) {
  startLinkedInMcpServer().catch((error: unknown) => {
    console.error(
      JSON.stringify(toLinkedInAssistantErrorPayload(error, mcpPrivacyConfig), null, 2)
    );
    process.exit(1);
  });
}
