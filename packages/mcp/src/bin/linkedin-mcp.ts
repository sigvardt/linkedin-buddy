#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_WATCH_KINDS,
  ACTIVITY_WATCH_STATUSES,
  buildFeedbackHintMessage,
  DEFAULT_LINKEDIN_PERSONA_POST_IMAGE_COUNT,
  DEFAULT_FOLLOWUP_SINCE,
  createFeedbackTechnicalContext,
  LINKEDIN_FEED_REACTION_TYPES,
  LINKEDIN_INBOX_REACTION_TYPES,
  LINKEDIN_MEMBER_REPORT_REASONS,
  LINKEDIN_NEWSLETTER_CADENCE_TYPES,
  LINKEDIN_POST_VISIBILITY_TYPES,
  LINKEDIN_PRIVACY_SETTING_KEYS,
  LINKEDIN_SELECTOR_LOCALES,
  LinkedInBuddyError,
  buildLinkedInImagePersonaFromProfileSeed,
  createCoreRuntime,
  isSearchCategory,
  normalizeFeedbackInputType,
  normalizeLinkedInFeedReaction,
  normalizeLinkedInInboxReaction,
  normalizeLinkedInMemberReportReason,
  normalizeLinkedInNotificationPreferenceChannel,
  normalizeLinkedInPostVisibility,
  normalizeLinkedInPrivacySettingKey,
  normalizeLinkedInPrivacySettingValue,
  readFeedbackStateSnapshot,
  recordFeedbackInvocation,
  resolveFollowupSinceWindow,
  redactStructuredValue,
  resolvePrivacyConfig,
  SEARCH_CATEGORIES,
  toLinkedInBuddyErrorPayload,
  submitFeedback,
  WEBHOOK_DELIVERY_ATTEMPT_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type ActivityEventType,
  type ActivityWatchKind,
  type ActivityWatchStatus,
  type SearchCategory,
  type WebhookDeliveryAttemptStatus,
  type WebhookSubscriptionStatus
} from "@linkedin-buddy/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import {
  SUBMIT_FEEDBACK_TOOL,
  LINKEDIN_ACTIONS_CONFIRM_TOOL,
  LINKEDIN_ASSETS_GENERATE_PROFILE_IMAGES_TOOL,
  LINKEDIN_ANALYTICS_CONTENT_METRICS_TOOL,
  LINKEDIN_ANALYTICS_POST_METRICS_TOOL,
  LINKEDIN_ANALYTICS_PROFILE_VIEWS_TOOL,
  LINKEDIN_ANALYTICS_SEARCH_APPEARANCES_TOOL,
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
  LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL,
  LINKEDIN_COMPANY_PREPARE_UNFOLLOW_TOOL,
  LINKEDIN_COMPANY_VIEW_TOOL,
  LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  LINKEDIN_CONNECTIONS_INVITE_TOOL,
  LINKEDIN_CONNECTIONS_LIST_TOOL,
  LINKEDIN_CONNECTIONS_PENDING_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_FOLLOW_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_IGNORE_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_REMOVE_TOOL,
  LINKEDIN_CONNECTIONS_PREPARE_UNFOLLOW_TOOL,
  LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL,
  LINKEDIN_MEMBERS_PREPARE_BLOCK_TOOL,
  LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL,
  LINKEDIN_MEMBERS_PREPARE_UNBLOCK_TOOL,
  LINKEDIN_FEED_COMMENT_TOOL,
  LINKEDIN_FEED_LIKE_TOOL,
  LINKEDIN_FEED_LIST_TOOL,
  LINKEDIN_FEED_PREPARE_REMOVE_REACTION_TOOL,
  LINKEDIN_FEED_PREPARE_REPOST_TOOL,
  LINKEDIN_FEED_PREPARE_SHARE_TOOL,
  LINKEDIN_FEED_SAVE_POST_TOOL,
  LINKEDIN_FEED_UNSAVE_POST_TOOL,
  LINKEDIN_FEED_VIEW_POST_TOOL,
  LINKEDIN_INBOX_GET_THREAD_TOOL,
  LINKEDIN_INBOX_ARCHIVE_THREAD_TOOL,
  LINKEDIN_INBOX_LIST_THREADS_TOOL,
  LINKEDIN_INBOX_MARK_UNREAD_TOOL,
  LINKEDIN_INBOX_PREPARE_ADD_RECIPIENTS_TOOL,
  LINKEDIN_INBOX_PREPARE_NEW_THREAD_TOOL,
  LINKEDIN_INBOX_PREPARE_REACT_TOOL,
  LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  LINKEDIN_INBOX_MUTE_THREAD_TOOL,
  LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
  LINKEDIN_INBOX_UNARCHIVE_THREAD_TOOL,
  LINKEDIN_PROFILE_PREPARE_FEATURED_ADD_TOOL,
  LINKEDIN_PROFILE_PREPARE_FEATURED_REMOVE_TOOL,
  LINKEDIN_PROFILE_PREPARE_FEATURED_REORDER_TOOL,
  LINKEDIN_PROFILE_PREPARE_ADD_SKILL_TOOL,
  LINKEDIN_PROFILE_PREPARE_REORDER_SKILLS_TOOL,
  LINKEDIN_PROFILE_PREPARE_ENDORSE_SKILL_TOOL,
  LINKEDIN_PROFILE_PREPARE_REQUEST_RECOMMENDATION_TOOL,
  LINKEDIN_PROFILE_PREPARE_WRITE_RECOMMENDATION_TOOL,
  LINKEDIN_PROFILE_PREPARE_REMOVE_SECTION_ITEM_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPLOAD_BANNER_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPLOAD_PHOTO_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPDATE_INTRO_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPDATE_PUBLIC_PROFILE_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPDATE_SETTINGS_TOOL,
  LINKEDIN_PROFILE_PREPARE_UPSERT_SECTION_ITEM_TOOL,
  LINKEDIN_PROFILE_VIEW_TOOL,
  LINKEDIN_PROFILE_VIEW_EDITABLE_TOOL,
  LINKEDIN_PRIVACY_GET_SETTINGS_TOOL,
  LINKEDIN_PRIVACY_PREPARE_UPDATE_SETTING_TOOL,
  LINKEDIN_GROUPS_PREPARE_JOIN_TOOL,
  LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL,
  LINKEDIN_GROUPS_PREPARE_POST_TOOL,
  LINKEDIN_GROUPS_SEARCH_TOOL,
  LINKEDIN_GROUPS_VIEW_TOOL,
  LINKEDIN_EVENTS_PREPARE_RSVP_TOOL,
  LINKEDIN_EVENTS_SEARCH_TOOL,
  LINKEDIN_EVENTS_VIEW_TOOL,
  LINKEDIN_JOBS_ALERTS_CREATE_TOOL,
  LINKEDIN_JOBS_ALERTS_LIST_TOOL,
  LINKEDIN_JOBS_ALERTS_REMOVE_TOOL,
  LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL,
  LINKEDIN_JOBS_SEARCH_TOOL,
  LINKEDIN_JOBS_SAVE_TOOL,
  LINKEDIN_JOBS_UNSAVE_TOOL,
  LINKEDIN_JOBS_VIEW_TOOL,
  LINKEDIN_NOTIFICATIONS_LIST_TOOL,
  LINKEDIN_ARTICLE_PREPARE_CREATE_TOOL,
  LINKEDIN_ARTICLE_PREPARE_PUBLISH_TOOL,
  LINKEDIN_NEWSLETTER_LIST_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
  LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL,
  LINKEDIN_NOTIFICATIONS_DISMISS_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
  LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_MEDIA_TOOL,
  LINKEDIN_POST_PREPARE_CREATE_POLL_TOOL,
  LINKEDIN_POST_PREPARE_DELETE_TOOL,
  LINKEDIN_POST_PREPARE_EDIT_TOOL,
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
type LinkedInMcpSchemaPrimitiveType =
  | "array"
  | "boolean"
  | "integer"
  | "number"
  | "object"
  | "string";
type LinkedInMcpSchemaEnumValue = boolean | number | string;

export interface LinkedInMcpInputSchema {
  type?: LinkedInMcpSchemaPrimitiveType;
  description?: string;
  properties?: Record<string, LinkedInMcpInputSchema>;
  required?: string[];
  additionalProperties?: boolean | LinkedInMcpInputSchema;
  items?: LinkedInMcpInputSchema;
  enum?: readonly LinkedInMcpSchemaEnumValue[];
  anyOf?: readonly LinkedInMcpInputSchema[];
}

export interface LinkedInMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: LinkedInMcpInputSchema;
}

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

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readRequiredString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new LinkedInBuddyError(
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
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a positive number.`
    );
  }

  return value;
}

function readNonNegativeNumber(
  args: ToolArgs,
  key: string,
  fallback: number
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be zero or a positive number.`
    );
  }

  return value;
}

function readBoolean(args: ToolArgs, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function readRequiredBoolean(args: ToolArgs, key: string): boolean {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`
  );
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

function readOptionalNonNegativeNumber(
  args: ToolArgs,
  key: string
): number | undefined {
  if (!(key in args) || args[key] === undefined) {
    return undefined;
  }

  const value = args[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a non-negative integer.`
    );
  }

  return value;
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

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be a string or array of strings.`
  );
}

function readRequiredStringArray(args: ToolArgs, key: string): string[] {
  const values = readStringArray(args, key);
  if (values && values.length > 0) {
    return values;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`
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

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be an object.`
  );
}

async function readJsonInputFile(
  filePath: string,
  label: string
): Promise<unknown> {
  const resolvedPath = path.resolve(filePath);
  let rawValue: string;

  try {
    rawValue = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Could not read ${label}.`,
      {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }

  try {
    return JSON.parse(rawValue) as unknown;
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must contain valid JSON.`,
      {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

function coerceEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new LinkedInBuddyError(
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
  if (isSearchCategory(category)) {
    return category;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} must be one of: ${SEARCH_CATEGORIES.join(", ")}.`
  );
}

function readMemberReportReason(
  args: ToolArgs,
  key: string
): ReturnType<typeof normalizeLinkedInMemberReportReason> {
  return normalizeLinkedInMemberReportReason(readRequiredString(args, key));
}

function readPrivacySettingKey(args: ToolArgs, key: string) {
  return normalizeLinkedInPrivacySettingKey(readRequiredString(args, key));
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
          toLinkedInBuddyErrorPayload(error, mcpPrivacyConfig),
          null,
          2
        )
      }
    ]
  };
}

function shouldTrackMcpFeedback(toolName: string): boolean {
  return toolName !== SUBMIT_FEEDBACK_TOOL;
}

function addFeedbackHintToResult<T extends ToolResult | ToolErrorResult>(
  result: T
): T {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== "text") {
    return result;
  }

  try {
    const parsed = JSON.parse(firstContent.text) as Record<string, unknown>;
    parsed.feedback_hint = buildFeedbackHintMessage();

    return {
      ...result,
      content: [
        {
          type: "text",
          text: JSON.stringify(parsed, null, 2)
        }
      ]
    };
  } catch {
    return result;
  }
}

function readTargetProfileName(target: Record<string, unknown>): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

const cdpUrlInputSchemaProperty: LinkedInMcpInputSchema = {
  type: "string",
  description:
    "Connect to an existing browser via CDP endpoint (for example http://127.0.0.1:18800)."
};

const selectorLocaleInputSchemaProperty: LinkedInMcpInputSchema = {
  type: "string",
  description: `Prefer localized LinkedIn UI text first (${LINKEDIN_SELECTOR_LOCALES.join(
    ", "
  )}; region tags like da-DK normalize to da). Unsupported values fall back to en.`
};

function withCdpSchemaProperties(
  properties: Record<string, LinkedInMcpInputSchema>
): Record<string, LinkedInMcpInputSchema> {
  return {
    ...properties,
    cdpUrl: cdpUrlInputSchemaProperty,
    selectorLocale: selectorLocaleInputSchemaProperty
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeToolArgValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return "non-finite number";
  }

  return typeof value;
}

function appendToolSchemaPath(path: string, segment: string): string {
  if (path.length === 0) {
    return segment;
  }

  if (segment.startsWith("[")) {
    return `${path}${segment}`;
  }

  return `${path}.${segment}`;
}

function formatToolSchemaPath(path: string): string {
  return path.length > 0 ? path : "arguments";
}

function describeToolSchemaTypes(schema: LinkedInMcpInputSchema): string {
  if (schema.anyOf && schema.anyOf.length > 0) {
    return schema.anyOf.map((entry) => describeToolSchemaTypes(entry)).join(", ");
  }

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((entry) => JSON.stringify(entry)).join(", ");
  }

  if (schema.type) {
    return schema.type;
  }

  return "supported value";
}

function throwToolSchemaValidationError(
  path: string,
  message: string,
  details: Record<string, unknown> = {}
): never {
  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${formatToolSchemaPath(path)} ${message}`,
    {
      path: formatToolSchemaPath(path),
      ...details
    }
  );
}

function validateToolArgEnum(
  schema: LinkedInMcpInputSchema,
  value: unknown,
  path: string
): void {
  if (schema.enum && !schema.enum.includes(value as LinkedInMcpSchemaEnumValue)) {
    throwToolSchemaValidationError(
      path,
      `must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}.`,
      {
        actual_type: describeToolArgValue(value),
        allowed_values: [...schema.enum]
      }
    );
  }
}

function validateToolArgValueAgainstSchema(
  schema: LinkedInMcpInputSchema,
  value: unknown,
  path: string
): void {
  if (schema.anyOf && schema.anyOf.length > 0) {
    for (const candidate of schema.anyOf) {
      try {
        validateToolArgValueAgainstSchema(candidate, value, path);
        return;
      } catch (error) {
        if (!(error instanceof LinkedInBuddyError)) {
          throw error;
        }
      }
    }

    throwToolSchemaValidationError(
      path,
      `must match one of: ${describeToolSchemaTypes(schema)}.`,
      {
        actual_type: describeToolArgValue(value),
        expected: describeToolSchemaTypes(schema)
      }
    );
  }

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        throwToolSchemaValidationError(path, "must be a string.", {
          actual_type: describeToolArgValue(value)
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throwToolSchemaValidationError(path, "must be a finite number.", {
          actual_type: describeToolArgValue(value)
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value)
      ) {
        throwToolSchemaValidationError(path, "must be an integer.", {
          actual_type: describeToolArgValue(value)
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        throwToolSchemaValidationError(path, "must be a boolean.", {
          actual_type: describeToolArgValue(value)
        });
      }
      validateToolArgEnum(schema, value, path);
      return;
    case "array":
      if (!Array.isArray(value)) {
        throwToolSchemaValidationError(path, "must be an array.", {
          actual_type: describeToolArgValue(value)
        });
      }

      if (schema.items) {
        value.forEach((entry, index) => {
          validateToolArgValueAgainstSchema(
            schema.items!,
            entry,
            appendToolSchemaPath(path, `[${index}]`)
          );
        });
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        throwToolSchemaValidationError(path, "must be an object.", {
          actual_type: describeToolArgValue(value)
        });
      }

      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      for (const requiredKey of required) {
        if (!(requiredKey in value) || value[requiredKey] === undefined) {
          throwToolSchemaValidationError(
            appendToolSchemaPath(path, requiredKey),
            "is required."
          );
        }
      }

      for (const [key, entryValue] of Object.entries(value)) {
        const propertyPath = appendToolSchemaPath(path, key);
        const propertySchema = properties[key];

        if (propertySchema) {
          if (entryValue !== undefined) {
            validateToolArgValueAgainstSchema(propertySchema, entryValue, propertyPath);
          }
          continue;
        }

        if (schema.additionalProperties === false) {
          throwToolSchemaValidationError(propertyPath, "is not allowed.");
        }

        if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object"
        ) {
          validateToolArgValueAgainstSchema(
            schema.additionalProperties,
            entryValue,
            propertyPath
          );
        }
      }
      return;
    }
    default:
      validateToolArgEnum(schema, value, path);
      return;
  }
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
      authenticated: status.authenticated,
      evasion_level: status.evasion?.level,
      evasion_diagnostics_enabled: status.evasion?.diagnosticsEnabled ?? false
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
      authenticated: health.session.authenticated,
      evasion_level: health.session.evasion.level,
      evasion_diagnostics_enabled: health.session.evasion.diagnosticsEnabled
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

async function handleSubmitFeedback(args: ToolArgs): Promise<ToolResult> {
  const snapshot = await readFeedbackStateSnapshot();
  const feedbackType = normalizeFeedbackInputType(readRequiredString(args, "type"));
  const title = readRequiredString(args, "title");
  const description = readRequiredString(args, "description");

  const result = await submitFeedback({
    type: feedbackType,
    title,
    description,
    technicalContext: createFeedbackTechnicalContext({
      cliVersion: packageJson.version,
      mcpToolName: SUBMIT_FEEDBACK_TOOL,
      snapshot,
      source: "mcp"
    })
  });

  return toToolResult({
    repository: result.repository,
    status: result.status,
    title: result.title,
    type: result.type,
    labels: result.labels,
    redaction_applied: result.redactionApplied,
    ...(result.url ? { url: result.url } : {}),
    ...(result.pendingFilePath
      ? {
          pending_file_path: path.join(
            ".linkedin-buddy",
            "pending-feedback",
            path.basename(result.pendingFilePath)
          )
        }
      : {})
  });
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

async function handleSearchRecipients(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.inbox.search_recipients.start", {
      profileName,
      query,
      limit
    });

    const result = await runtime.inbox.searchRecipients({
      profileName,
      query,
      limit
    });

    runtime.logger.log("info", "mcp.inbox.search_recipients.done", {
      profileName,
      query,
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

async function handlePrepareNewThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const recipients = readRequiredStringArray(args, "recipients");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.inbox.prepare_new_thread.start", {
      profileName,
      recipientCount: recipients.length
    });

    const prepared = await runtime.inbox.prepareNewThread({
      profileName,
      recipients,
      text,
      ...(operatorNote
        ? {
            operatorNote
          }
        : {})
    });

    runtime.logger.log("info", "mcp.inbox.prepare_new_thread.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      recipientCount: recipients.length
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

async function handlePrepareAddRecipients(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const recipients = readRequiredStringArray(args, "recipients");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.inbox.prepare_add_recipients.start", {
      profileName,
      recipientCount: recipients.length,
      thread
    });

    const prepared = await runtime.inbox.prepareAddRecipients({
      profileName,
      thread,
      recipients,
      ...(operatorNote
        ? {
            operatorNote
          }
        : {})
    });

    runtime.logger.log("info", "mcp.inbox.prepare_add_recipients.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      recipientCount: recipients.length,
      thread
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

async function handlePrepareReact(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const reaction = normalizeLinkedInInboxReaction(readString(args, "reaction", "like"));
    const messageIndex = readOptionalNonNegativeNumber(args, "messageIndex");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.inbox.prepare_react.start", {
      profileName,
      thread,
      reaction,
      messageIndex
    });

    const prepared = await runtime.inbox.prepareReact({
      profileName,
      thread,
      reaction,
      ...(messageIndex !== undefined ? { messageIndex } : {}),
      ...(operatorNote
        ? {
            operatorNote
          }
        : {})
    });

    runtime.logger.log("info", "mcp.inbox.prepare_react.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      reaction,
      messageIndex
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

async function handleArchiveThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");

    runtime.logger.log("info", "mcp.inbox.archive_thread.start", {
      profileName,
      thread
    });

    const result = await runtime.inbox.archiveThread({
      profileName,
      thread
    });

    runtime.logger.log("info", "mcp.inbox.archive_thread.done", {
      profileName,
      threadId: result.thread_id
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

async function handleUnarchiveThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");

    runtime.logger.log("info", "mcp.inbox.unarchive_thread.start", {
      profileName,
      thread
    });

    const result = await runtime.inbox.unarchiveThread({
      profileName,
      thread
    });

    runtime.logger.log("info", "mcp.inbox.unarchive_thread.done", {
      profileName,
      threadId: result.thread_id
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

async function handleMarkUnread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");

    runtime.logger.log("info", "mcp.inbox.mark_unread.start", {
      profileName,
      thread
    });

    const result = await runtime.inbox.markUnread({
      profileName,
      thread
    });

    runtime.logger.log("info", "mcp.inbox.mark_unread.done", {
      profileName,
      threadId: result.thread_id
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

async function handleMuteThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");

    runtime.logger.log("info", "mcp.inbox.mute_thread.start", {
      profileName,
      thread
    });

    const result = await runtime.inbox.muteThread({
      profileName,
      thread
    });

    runtime.logger.log("info", "mcp.inbox.mute_thread.done", {
      profileName,
      threadId: result.thread_id
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

async function handleCompanyView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readRequiredString(args, "target");

    runtime.logger.log("info", "mcp.company.view.start", {
      profileName,
      target
    });

    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target
    });

    runtime.logger.log("info", "mcp.company.view.done", {
      profileName,
      companyName: company.name
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      company
    });
  } finally {
    runtime.close();
  }
}

async function handleProfileViewEditable(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.profile.view_editable.start", {
      profileName
    });

    const profile = await runtime.profile.viewEditableProfile({
      profileName
    });

    runtime.logger.log("info", "mcp.profile.view_editable.done", {
      profileName,
      sectionCount: profile.sections.length
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

async function handleProfilePrepareUpdateIntro(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_update_intro.start", {
      profileName
    });

    const prepared = runtime.profile.prepareUpdateIntro({
      profileName,
      ...(typeof args.firstName === "string"
        ? { firstName: readString(args, "firstName", "") }
        : {}),
      ...(typeof args.lastName === "string"
        ? { lastName: readString(args, "lastName", "") }
        : {}),
      ...(typeof args.headline === "string"
        ? { headline: readString(args, "headline", "") }
        : {}),
      ...(typeof args.location === "string"
        ? { location: readString(args, "location", "") }
        : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_update_intro.done", {
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

async function handleProfilePrepareUpdateSettings(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const industry = readRequiredString(args, "industry");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_update_settings.start", {
      profileName
    });

    const prepared = runtime.profile.prepareUpdateSettings({
      profileName,
      industry,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_update_settings.done", {
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

async function handleProfilePrepareUpdatePublicProfile(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const operatorNote = readString(args, "operatorNote", "");
    const vanityName =
      typeof args.vanityName === "string" ? readString(args, "vanityName", "") : "";
    const customProfileUrl =
      typeof args.customProfileUrl === "string"
        ? readString(args, "customProfileUrl", "")
        : "";
    const publicProfileUrl =
      typeof args.publicProfileUrl === "string"
        ? readString(args, "publicProfileUrl", "")
        : "";

    if (!vanityName && !customProfileUrl && !publicProfileUrl) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "vanityName, customProfileUrl, or publicProfileUrl is required."
      );
    }

    runtime.logger.log(
      "info",
      "mcp.profile.prepare_update_public_profile.start",
      {
        profileName
      }
    );

    const prepared = runtime.profile.prepareUpdatePublicProfile({
      profileName,
      ...(vanityName ? { vanityName } : {}),
      ...(customProfileUrl ? { customProfileUrl } : {}),
      ...(publicProfileUrl ? { publicProfileUrl } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_update_public_profile.done", {
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

async function handleProfilePrepareUpsertSectionItem(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const section = readRequiredString(args, "section");
    const values = readObject(args, "values");
    const match = readObject(args, "match");
    const itemId = readString(args, "itemId", "");
    const operatorNote = readString(args, "operatorNote", "");

    if (!values) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "values is required."
      );
    }

    runtime.logger.log("info", "mcp.profile.prepare_upsert_section_item.start", {
      profileName,
      section,
      hasItemId: itemId.length > 0
    });

    const prepared = runtime.profile.prepareUpsertSectionItem({
      profileName,
      section,
      values,
      ...(itemId ? { itemId } : {}),
      ...(match ? { match } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_upsert_section_item.done", {
      profileName,
      section,
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

async function handleProfilePrepareRemoveSectionItem(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const section = readRequiredString(args, "section");
    const match = readObject(args, "match");
    const itemId = readString(args, "itemId", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_remove_section_item.start", {
      profileName,
      section,
      hasItemId: itemId.length > 0
    });

    const prepared = runtime.profile.prepareRemoveSectionItem({
      profileName,
      section,
      ...(itemId ? { itemId } : {}),
      ...(match ? { match } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_remove_section_item.done", {
      profileName,
      section,
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

async function handleProfilePrepareUploadPhoto(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const filePath = readRequiredString(args, "filePath");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_upload_photo.start", {
      profileName
    });

    const prepared = await runtime.profile.prepareUploadPhoto({
      profileName,
      filePath,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_upload_photo.done", {
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

async function handleProfilePrepareUploadBanner(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const filePath = readRequiredString(args, "filePath");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_upload_banner.start", {
      profileName
    });

    const prepared = await runtime.profile.prepareUploadBanner({
      profileName,
      filePath,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_upload_banner.done", {
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

async function handleProfilePrepareFeaturedAdd(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const kind = readRequiredString(args, "kind");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_featured_add.start", {
      profileName,
      kind
    });

    const prepared = await runtime.profile.prepareFeaturedAdd({
      profileName,
      kind,
      ...(typeof args.url === "string" ? { url: readString(args, "url", "") } : {}),
      ...(typeof args.filePath === "string"
        ? { filePath: readString(args, "filePath", "") }
        : {}),
      ...(typeof args.title === "string" ? { title: readString(args, "title", "") } : {}),
      ...(typeof args.description === "string"
        ? { description: readString(args, "description", "") }
        : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_featured_add.done", {
      profileName,
      kind,
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

async function handleProfilePrepareFeaturedRemove(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const itemId = readString(args, "itemId", "");
    const match = readObject(args, "match");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_featured_remove.start", {
      profileName,
      hasItemId: itemId.length > 0
    });

    const prepared = runtime.profile.prepareFeaturedRemove({
      profileName,
      ...(itemId ? { itemId } : {}),
      ...(match ? { match } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_featured_remove.done", {
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

async function handleProfilePrepareFeaturedReorder(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const itemIds = readStringArray(args, "itemIds");
    const operatorNote = readString(args, "operatorNote", "");

    if (!itemIds || itemIds.length === 0) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "itemIds is required."
      );
    }

    runtime.logger.log("info", "mcp.profile.prepare_featured_reorder.start", {
      profileName,
      itemCount: itemIds.length
    });

    const prepared = runtime.profile.prepareFeaturedReorder({
      profileName,
      itemIds,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_featured_reorder.done", {
      profileName,
      itemCount: itemIds.length,
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

async function handleProfilePrepareAddSkill(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const skillName = readRequiredString(args, "skillName");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_add_skill.start", {
      profileName,
      skillName
    });

    const prepared = runtime.profile.prepareAddSkill({
      profileName,
      skillName,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_add_skill.done", {
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

async function handleProfilePrepareReorderSkills(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const skillNames = readRequiredStringArray(args, "skillNames");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_reorder_skills.start", {
      profileName,
      skillCount: skillNames.length
    });

    const prepared = runtime.profile.prepareReorderSkills({
      profileName,
      skillNames,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_reorder_skills.done", {
      profileName,
      skillCount: skillNames.length,
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

async function handleProfilePrepareEndorseSkill(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readRequiredString(args, "target");
    const skillName = readRequiredString(args, "skillName");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.profile.prepare_endorse_skill.start", {
      profileName,
      target
    });

    const prepared = runtime.profile.prepareEndorseSkill({
      profileName,
      target,
      skillName,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.profile.prepare_endorse_skill.done", {
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

async function handleProfilePrepareRequestRecommendation(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readRequiredString(args, "target");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log(
      "info",
      "mcp.profile.prepare_request_recommendation.start",
      {
        profileName,
        target
      }
    );

    const prepared = runtime.profile.prepareRequestRecommendation({
      profileName,
      target,
      ...(typeof args.relationship === "string"
        ? { relationship: readString(args, "relationship", "") }
        : {}),
      ...(typeof args.position === "string"
        ? { position: readString(args, "position", "") }
        : {}),
      ...(typeof args.company === "string"
        ? { company: readString(args, "company", "") }
        : {}),
      ...(typeof args.message === "string"
        ? { message: readString(args, "message", "") }
        : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log(
      "info",
      "mcp.profile.prepare_request_recommendation.done",
      {
        profileName,
        preparedActionId: prepared.preparedActionId
      }
    );

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleProfilePrepareWriteRecommendation(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readRequiredString(args, "target");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log(
      "info",
      "mcp.profile.prepare_write_recommendation.start",
      {
        profileName,
        target
      }
    );

    const prepared = runtime.profile.prepareWriteRecommendation({
      profileName,
      target,
      text,
      ...(typeof args.relationship === "string"
        ? { relationship: readString(args, "relationship", "") }
        : {}),
      ...(typeof args.position === "string"
        ? { position: readString(args, "position", "") }
        : {}),
      ...(typeof args.company === "string"
        ? { company: readString(args, "company", "") }
        : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log(
      "info",
      "mcp.profile.prepare_write_recommendation.done",
      {
        profileName,
        preparedActionId: prepared.preparedActionId
      }
    );

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleAssetsGenerateProfileImages(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const specPath = readRequiredString(args, "specPath");
    const postImageCount = readPositiveNumber(
      args,
      "postImageCount",
      DEFAULT_LINKEDIN_PERSONA_POST_IMAGE_COUNT
    );
    const uploadProfileMedia = readBoolean(args, "uploadProfileMedia", false);
    const uploadDelayMs = readNonNegativeNumber(args, "uploadDelayMs", 4_500);
    const model = readString(args, "model", "");
    const operatorNote = readString(args, "operatorNote", "");
    const resolvedSpecPath = path.resolve(specPath);
    const persona = buildLinkedInImagePersonaFromProfileSeed(
      await readJsonInputFile(resolvedSpecPath, "image persona spec")
    );

    runtime.logger.log("info", "mcp.assets.generate_profile_images.start", {
      profileName,
      specPath: resolvedSpecPath,
      postImageCount,
      uploadProfileMedia,
      model: model || null
    });

    const report = await runtime.imageAssets.generatePersonaImageSet({
      persona,
      postImageCount,
      uploadProfileMedia,
      profileName,
      uploadDelayMs,
      operatorNote:
        operatorNote || `issue-211 persona images: ${path.basename(resolvedSpecPath)}`,
      ...(model ? { model } : {})
    });

    runtime.logger.log("info", "mcp.assets.generate_profile_images.done", {
      profileName,
      specPath: resolvedSpecPath,
      postImageCount,
      uploadProfileMedia
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      spec_path: resolvedSpecPath,
      ...report
    });
  } finally {
    runtime.close();
  }
}

async function handleAnalyticsProfileViews(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.analytics.profile_views.start", {
      profileName
    });

    const summary = await runtime.analytics.getProfileViews({
      profileName
    });

    runtime.logger.log("info", "mcp.analytics.profile_views.done", {
      profileName,
      card_count: summary.cards.length,
      metric_count: summary.metrics.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...summary
    });
  } finally {
    runtime.close();
  }
}

async function handleAnalyticsSearchAppearances(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.analytics.search_appearances.start", {
      profileName
    });

    const summary = await runtime.analytics.getSearchAppearances({
      profileName
    });

    runtime.logger.log("info", "mcp.analytics.search_appearances.done", {
      profileName,
      card_count: summary.cards.length,
      metric_count: summary.metrics.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...summary
    });
  } finally {
    runtime.close();
  }
}

async function handleAnalyticsContentMetrics(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 4);

    runtime.logger.log("info", "mcp.analytics.content_metrics.start", {
      profileName,
      limit
    });

    const summary = await runtime.analytics.getContentMetrics({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.analytics.content_metrics.done", {
      profileName,
      card_count: summary.cards.length,
      metric_count: summary.metrics.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...summary
    });
  } finally {
    runtime.close();
  }
}

async function handleAnalyticsPostMetrics(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");

    runtime.logger.log("info", "mcp.analytics.post_metrics.start", {
      profileName,
      postUrl
    });

    const summary = await runtime.analytics.getPostMetrics({
      profileName,
      postUrl
    });

    runtime.logger.log("info", "mcp.analytics.post_metrics.done", {
      profileName,
      post_url: summary.post.post_url,
      metric_count: summary.metrics.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...summary
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

async function handleNotificationsMarkRead(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const notificationId = readRequiredString(args, "notificationId");

    runtime.logger.log("info", "mcp.notifications.mark_read.start", {
      profileName,
      notificationId
    });

    const result = await runtime.notifications.markRead({
      profileName,
      notificationId
    });

    runtime.logger.log("info", "mcp.notifications.mark_read.done", {
      profileName,
      notificationId,
      wasAlreadyRead: result.was_already_read
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

async function handleNotificationsDismiss(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const notificationId = readRequiredString(args, "notificationId");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.notifications.dismiss.start", {
      profileName,
      notificationId
    });

    const prepared = await runtime.notifications.prepareDismissNotification({
      profileName,
      notificationId,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.notifications.dismiss.done", {
      profileName,
      notificationId,
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

async function handleNotificationPreferencesGet(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const preferenceUrl = readString(args, "preferenceUrl", "");

    runtime.logger.log("info", "mcp.notifications.preferences.get.start", {
      profileName,
      preferenceUrl: preferenceUrl || null
    });

    const preferences = await runtime.notifications.getPreferences({
      profileName,
      ...(preferenceUrl ? { preferenceUrl } : {})
    });

    runtime.logger.log("info", "mcp.notifications.preferences.get.done", {
      profileName,
      viewType: preferences.view_type,
      preferenceUrl: preferences.preference_url
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      preferences
    });
  } finally {
    runtime.close();
  }
}

async function handleNotificationPreferencesPrepareUpdate(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const preferenceUrl = readRequiredString(args, "preferenceUrl");
    const enabled = readRequiredBoolean(args, "enabled");
    const channel = typeof args.channel === "string"
      ? normalizeLinkedInNotificationPreferenceChannel(readRequiredString(args, "channel"))
      : undefined;
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.notifications.preferences.prepare_update.start", {
      profileName,
      preferenceUrl,
      enabled,
      channel: channel ?? null
    });

    const prepared = await runtime.notifications.prepareUpdatePreference({
      profileName,
      preferenceUrl,
      enabled,
      ...(channel ? { channel } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.notifications.preferences.prepare_update.done", {
      profileName,
      preferenceUrl,
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

async function handleJobsSave(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const jobId = readRequiredString(args, "jobId");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.jobs.save.start", {
      profileName,
      jobId
    });

    const prepared = runtime.jobs.prepareSaveJob({
      profileName,
      jobId,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.jobs.save.done", {
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

async function handleJobsUnsave(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const jobId = readRequiredString(args, "jobId");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.jobs.unsave.start", {
      profileName,
      jobId
    });

    const prepared = runtime.jobs.prepareUnsaveJob({
      profileName,
      jobId,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.jobs.unsave.done", {
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

async function handleJobsAlertsList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 20);

    runtime.logger.log("info", "mcp.jobs.alerts.list.start", {
      profileName,
      limit
    });

    const result = await runtime.jobs.listJobAlerts({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.jobs.alerts.list.done", {
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

async function handleJobsAlertsCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const location = readString(args, "location", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.jobs.alerts.create.start", {
      profileName,
      query,
      location
    });

    const prepared = runtime.jobs.prepareCreateJobAlert({
      profileName,
      query,
      ...(location ? { location } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.jobs.alerts.create.done", {
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

async function handleJobsAlertsRemove(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const alertId = readString(args, "alertId", "");
    const searchUrl = readString(args, "searchUrl", "");
    const query = readString(args, "query", "");
    const location = readString(args, "location", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.jobs.alerts.remove.start", {
      profileName,
      hasAlertId: alertId.length > 0,
      hasSearchUrl: searchUrl.length > 0,
      hasQuery: query.length > 0
    });

    const prepared = await runtime.jobs.prepareRemoveJobAlert({
      profileName,
      ...(alertId ? { alertId } : {}),
      ...(searchUrl ? { searchUrl } : {}),
      ...(query ? { query } : {}),
      ...(location ? { location } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.jobs.alerts.remove.done", {
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

async function handleJobsPrepareEasyApply(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const jobId = readRequiredString(args, "jobId");
    const phoneNumber = readString(args, "phoneNumber", "");
    const email = readString(args, "email", "");
    const city = readString(args, "city", "");
    const resumePath = readString(args, "resumePath", "");
    const coverLetter = readString(args, "coverLetter", "");
    const answers = readObject(args, "answers");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.jobs.easy_apply.start", {
      profileName,
      jobId,
      hasResumePath: resumePath.length > 0,
      hasAnswers: Boolean(answers)
    });

    const prepared = runtime.jobs.prepareEasyApply({
      profileName,
      jobId,
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(email ? { email } : {}),
      ...(city ? { city } : {}),
      ...(resumePath ? { resumePath } : {}),
      ...(coverLetter ? { coverLetter } : {}),
      ...(answers ? { answers } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.jobs.easy_apply.done", {
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

async function handleGroupsSearch(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.groups.search.start", {
      profileName,
      query,
      limit
    });

    const result = await runtime.groups.searchGroups({
      profileName,
      query,
      limit
    });

    runtime.logger.log("info", "mcp.groups.search.done", {
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

async function handleGroupsView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const group = readRequiredString(args, "group");

    runtime.logger.log("info", "mcp.groups.view.start", {
      profileName,
      group
    });

    const groupDetails = await runtime.groups.viewGroup({
      profileName,
      group
    });

    runtime.logger.log("info", "mcp.groups.view.done", {
      profileName,
      groupId: groupDetails.group_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      group: groupDetails
    });
  } finally {
    runtime.close();
  }
}

async function handleGroupsPrepareJoin(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const group = readRequiredString(args, "group");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.groups.prepare_join.start", {
      profileName,
      group
    });

    const prepared = runtime.groups.prepareJoinGroup({
      profileName,
      group,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.groups.prepare_join.done", {
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

async function handleGroupsPrepareLeave(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const group = readRequiredString(args, "group");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.groups.prepare_leave.start", {
      profileName,
      group
    });

    const prepared = runtime.groups.prepareLeaveGroup({
      profileName,
      group,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.groups.prepare_leave.done", {
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

async function handleGroupsPreparePost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const group = readRequiredString(args, "group");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.groups.prepare_post.start", {
      profileName,
      group
    });

    const prepared = runtime.groups.preparePostToGroup({
      profileName,
      group,
      text,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.groups.prepare_post.done", {
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

async function handleEventsSearch(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const query = readRequiredString(args, "query");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.events.search.start", {
      profileName,
      query,
      limit
    });

    const result = await runtime.events.searchEvents({
      profileName,
      query,
      limit
    });

    runtime.logger.log("info", "mcp.events.search.done", {
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

async function handleEventsView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const event = readRequiredString(args, "event");

    runtime.logger.log("info", "mcp.events.view.start", {
      profileName,
      event
    });

    const eventDetails = await runtime.events.viewEvent({
      profileName,
      event
    });

    runtime.logger.log("info", "mcp.events.view.done", {
      profileName,
      eventId: eventDetails.event_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      event: eventDetails
    });
  } finally {
    runtime.close();
  }
}

async function handleEventsPrepareRsvp(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const event = readRequiredString(args, "event");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.events.prepare_rsvp.start", {
      profileName,
      event
    });

    const prepared = runtime.events.prepareRsvp({
      profileName,
      event,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.events.prepare_rsvp.done", {
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

async function handleConnectionsPrepareIgnore(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.prepare_ignore.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareIgnoreInvitation({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.prepare_ignore.done", {
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

async function handleConnectionsPrepareRemove(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.prepare_remove.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareRemoveConnection({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.prepare_remove.done", {
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

async function handleConnectionsPrepareFollow(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.prepare_follow.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareFollowMember({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.prepare_follow.done", {
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

async function handleConnectionsPrepareUnfollow(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.prepare_unfollow.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareUnfollowMember({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.prepare_unfollow.done", {
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

async function handleCompanyPrepareFollow(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetCompany = readRequiredString(args, "targetCompany");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.company.prepare_follow.start", {
      profileName,
      targetCompany
    });

    const prepared = runtime.companyPages.prepareFollowCompanyPage({
      profileName,
      targetCompany,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.company.prepare_follow.done", {
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

async function handleCompanyPrepareUnfollow(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetCompany = readRequiredString(args, "targetCompany");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.company.prepare_unfollow.start", {
      profileName,
      targetCompany
    });

    const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName,
      targetCompany,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.company.prepare_unfollow.done", {
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

async function handleMembersPrepareBlock(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.members.prepare_block.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.members.prepareBlockMember({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.members.prepare_block.done", {
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

async function handleMembersPrepareUnblock(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.members.prepare_unblock.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.members.prepareUnblockMember({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.members.prepare_unblock.done", {
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

async function handleMembersPrepareReport(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const reason = readMemberReportReason(args, "reason");
    const details = readString(args, "details", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.members.prepare_report.start", {
      profileName,
      targetProfile,
      reason
    });

    const prepared = runtime.members.prepareReportMember({
      profileName,
      targetProfile,
      reason,
      ...(details ? { details } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.members.prepare_report.done", {
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

async function handlePrivacyGetSettings(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.privacy.get_settings.start", {
      profileName
    });

    const settings = await runtime.privacySettings.getSettings({
      profileName
    });

    runtime.logger.log("info", "mcp.privacy.get_settings.done", {
      profileName,
      count: settings.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      settings
    });
  } finally {
    runtime.close();
  }
}

async function handlePrivacyPrepareUpdateSetting(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const settingKey = readPrivacySettingKey(args, "settingKey");
    const value = normalizeLinkedInPrivacySettingValue(
      settingKey,
      readRequiredString(args, "value")
    );
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.privacy.prepare_update_setting.start", {
      profileName,
      settingKey,
      value
    });

    const prepared = runtime.privacySettings.prepareUpdateSetting({
      profileName,
      settingKey,
      value,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.privacy.prepare_update_setting.done", {
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

async function handleFeedPrepareRepost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.prepare_repost.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareRepostPost({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.prepare_repost.done", {
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

async function handleFeedPrepareShare(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.prepare_share.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareSharePost({
      profileName,
      postUrl,
      text,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.prepare_share.done", {
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

async function handleFeedSavePost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.save_post.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareSavePost({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.save_post.done", {
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

async function handleFeedUnsavePost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.unsave_post.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareUnsavePost({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.unsave_post.done", {
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

async function handleFeedPrepareRemoveReaction(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.prepare_remove_reaction.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareRemoveReaction({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.prepare_remove_reaction.done", {
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

async function handlePostPrepareCreateMedia(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const text = readRequiredString(args, "text");
    const mediaPaths = readStringArray(args, "mediaPaths");
    if (!mediaPaths) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "mediaPaths is required."
      );
    }
    const visibility = normalizeLinkedInPostVisibility(
      readString(args, "visibility", "public"),
      "public"
    );
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.post.prepare_create_media.start", {
      profileName,
      visibility,
      mediaCount: mediaPaths.length
    });

    const prepared = await runtime.posts.prepareCreateMedia({
      profileName,
      text,
      mediaPaths,
      visibility,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.post.prepare_create_media.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      visibility,
      mediaCount: mediaPaths.length
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

async function handlePostPrepareCreatePoll(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const question = readRequiredString(args, "question");
    const options = readStringArray(args, "options");
    if (!options) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "options is required."
      );
    }
    const text = readString(args, "text", "");
    const durationDays = readOptionalPositiveNumber(args, "durationDays");
    const visibility = normalizeLinkedInPostVisibility(
      readString(args, "visibility", "public"),
      "public"
    );
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.post.prepare_create_poll.start", {
      profileName,
      visibility,
      optionCount: options.length,
      ...(typeof durationDays === "number" ? { durationDays } : {})
    });

    const prepared = await runtime.posts.prepareCreatePoll({
      profileName,
      question,
      options,
      ...(text ? { text } : {}),
      ...(typeof durationDays === "number" ? { durationDays } : {}),
      visibility,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.post.prepare_create_poll.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      visibility,
      optionCount: options.length,
      ...(typeof durationDays === "number" ? { durationDays } : {})
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

async function handlePostPrepareEdit(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.post.prepare_edit.start", {
      profileName,
      postUrl
    });

    const prepared = await runtime.posts.prepareEdit({
      profileName,
      postUrl,
      text,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.post.prepare_edit.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      postUrl
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

async function handlePostPrepareDelete(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.post.prepare_delete.start", {
      profileName,
      postUrl
    });

    const prepared = await runtime.posts.prepareDelete({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.post.prepare_delete.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      postUrl
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

async function handleArticlePrepareCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const title = readRequiredString(args, "title");
    const body = readRequiredString(args, "body");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.article.prepare_create.start", {
      profileName,
      titleLength: title.length
    });

    const prepared = await runtime.articles.prepareCreate({
      profileName,
      title,
      body,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.article.prepare_create.done", {
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

async function handleArticlePreparePublish(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const draftUrl = readRequiredString(args, "draftUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.article.prepare_publish.start", {
      profileName,
      draftUrl
    });

    const prepared = await runtime.articles.preparePublish({
      profileName,
      draftUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.article.prepare_publish.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      draftUrl
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

async function handleNewsletterPrepareCreate(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const title = readRequiredString(args, "title");
    const description = readRequiredString(args, "description");
    const cadence = readRequiredString(args, "cadence");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.newsletter.prepare_create.start", {
      profileName,
      cadence
    });

    const prepared = await runtime.newsletters.prepareCreate({
      profileName,
      title,
      description,
      cadence,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.newsletter.prepare_create.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      cadence
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

async function handleNewsletterPreparePublishIssue(
  args: ToolArgs
): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");
    const newsletter = readRequiredString(args, "newsletter");
    const title = readRequiredString(args, "title");
    const body = readRequiredString(args, "body");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.newsletter.prepare_publish_issue.start", {
      profileName,
      newsletter
    });

    const prepared = await runtime.newsletters.preparePublishIssue({
      profileName,
      newsletter,
      title,
      body,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.newsletter.prepare_publish_issue.done", {
      profileName,
      preparedActionId: prepared.preparedActionId,
      newsletter
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

async function handleNewsletterList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createRuntime(args);

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.newsletter.list.start", {
      profileName
    });

    const newsletters = await runtime.newsletters.list({
      profileName
    });

    runtime.logger.log("info", "mcp.newsletter.list.done", {
      profileName,
      count: newsletters.count
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...newsletters
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
      throw new LinkedInBuddyError(
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
    version: packageJson.version
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

export const LINKEDIN_MCP_TOOL_DEFINITIONS: LinkedInMcpToolDefinition[] = [
      {
        name: SUBMIT_FEEDBACK_TOOL,
        description:
          "File agent feedback as a GitHub issue or save it locally when GitHub CLI authentication is unavailable.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "description"],
          properties: {
            type: {
              type: "string",
              enum: ["bug", "feature", "improvement"],
              description: "Feedback classification chosen by the agent."
            },
            title: {
              type: "string",
              description: "Short summary for the feedback issue."
            },
            description: {
              type: "string",
              description: "Detailed explanation of the bug, feature request, or improvement."
            }
          }
        }
      },
      {
        name: LINKEDIN_SESSION_STATUS_TOOL,
        description:
          "Check LinkedIn session authentication status for a profile, including the resolved anti-bot evasion configuration.",
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
        description:
          "Check browser connectivity and LinkedIn session health for a profile, including the resolved anti-bot evasion configuration.",
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
        name: LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL,
        description: withSelectorAuditHint(
          "Search LinkedIn people to resolve recipient identities for messaging flows."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            query: {
              type: "string",
              description: "Recipient keywords to search for."
            },
            limit: {
              type: "number",
              description: "Maximum number of recipients to return. Defaults to 10."
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
        name: LINKEDIN_INBOX_PREPARE_NEW_THREAD_TOOL,
        description:
          "Prepare a two-phase first-message action for a new LinkedIn thread. Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["recipients", "text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            recipients: {
              type: "array",
              items: {
                type: "string"
              },
              description:
                "Recipient LinkedIn profile URLs, /in/ paths, or vanity names. Use linkedin.inbox.search_recipients to resolve free-text names first."
            },
            text: {
              type: "string",
              description: "First message text to prepare."
            },
            operatorNote: {
              type: "string",
              description: "Internal note stored with the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_PREPARE_ADD_RECIPIENTS_TOOL,
        description:
          "Prepare a two-phase add_recipients action for an existing LinkedIn thread. Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["thread", "recipients"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            thread: {
              type: "string",
              description: "Thread id or LinkedIn thread URL."
            },
            recipients: {
              type: "array",
              items: {
                type: "string"
              },
              description:
                "Recipient LinkedIn profile URLs, /in/ paths, or vanity names to add to the thread."
            },
            operatorNote: {
              type: "string",
              description: "Internal note stored with the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_PREPARE_REACT_TOOL,
        description:
          "Prepare a two-phase reaction for a message in an existing LinkedIn thread. Use linkedin.actions.confirm to execute.",
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
            reaction: {
              type: "string",
              description:
                `Reaction to apply. Accepts canonical or alias values and normalizes to one of: ${LINKEDIN_INBOX_REACTION_TYPES.join(", ")}. Defaults to like.`
            },
            messageIndex: {
              type: "integer",
              description:
                "Zero-based thread message index to react to. Defaults to the latest message returned by the thread."
            },
            operatorNote: {
              type: "string",
              description: "Internal note stored with the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_ARCHIVE_THREAD_TOOL,
        description: withSelectorAuditHint(
          "Archive a LinkedIn inbox thread immediately."
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
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_UNARCHIVE_THREAD_TOOL,
        description: withSelectorAuditHint(
          "Move an archived LinkedIn inbox thread back to the main inbox immediately."
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
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_MARK_UNREAD_TOOL,
        description: withSelectorAuditHint(
          "Mark a LinkedIn inbox thread as unread immediately."
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
            }
          })
        }
      },
      {
        name: LINKEDIN_INBOX_MUTE_THREAD_TOOL,
        description: withSelectorAuditHint(
          "Mute a LinkedIn inbox thread immediately."
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
            }
          })
        }
      },
      {
        name: LINKEDIN_COMPANY_VIEW_TOOL,
        description: withSelectorAuditHint(
          "View a LinkedIn company page. Returns structured company overview, details, and current follow state."
        ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Company slug, /company/ path, or LinkedIn company URL."
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
        name: LINKEDIN_PROFILE_VIEW_EDITABLE_TOOL,
        description: withSelectorAuditHint(
          "Inspect the logged-in member's editable LinkedIn profile surface. Returns intro metadata, supported editable fields, stable-ish section item identifiers for structured profile sections, and featured item identifiers for remove/reorder workflows."
        ),
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
        name: LINKEDIN_PROFILE_PREPARE_UPDATE_INTRO_TOOL,
        description:
          "Prepare a LinkedIn profile intro update (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            firstName: {
              type: "string",
              description: "Optional new first name."
            },
            lastName: {
              type: "string",
              description: "Optional new last name."
            },
            headline: {
              type: "string",
              description: "Optional new headline."
            },
            location: {
              type: "string",
              description: "Optional new location text."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_UPDATE_SETTINGS_TOOL,
        description:
          "Prepare a LinkedIn profile settings update (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["industry"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            industry: {
              type: "string",
              description: "Primary professional category / industry."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_UPDATE_PUBLIC_PROFILE_TOOL,
        description:
          "Prepare a LinkedIn public profile URL / vanity URL update (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            vanityName: {
              type: "string",
              description: "Requested public profile vanity name (slug only)."
            },
            customProfileUrl: {
              type: "string",
              description:
                "Requested public profile vanity name or full LinkedIn profile URL. Alias for vanityName."
            },
            publicProfileUrl: {
              type: "string",
              description:
                "Requested public profile URL. Use this instead of vanityName if you already have a linkedin.com/in/... URL."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_UPSERT_SECTION_ITEM_TOOL,
        description:
          "Prepare to create or update an editable LinkedIn profile section item (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["section", "values"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            section: {
              type: "string",
              enum: [
                "about",
                "experience",
                "education",
                "certifications",
                "languages",
                "projects",
                "volunteer_experience",
                "honors_awards"
              ],
              description: "Editable LinkedIn profile section to create or update."
            },
            itemId: {
              type: "string",
              description:
                "Stable-ish item identifier returned by linkedin.profile.view_editable. Provide this (or match) to update an existing item. Omit both to create a new item."
            },
            match: {
              type: "object",
              additionalProperties: {
                anyOf: [{ type: "string" }]
              },
              description:
                "Optional optimistic matching object for legacy items when itemId is unavailable. Supported keys include sourceId, primaryText, secondaryText, tertiaryText, and rawText."
            },
            values: {
              type: "object",
              additionalProperties: {
                anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
              },
              description:
                "Section field values to create or update. Use linkedin.profile.view_editable.supported_fields as the canonical field list for each section."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_REMOVE_SECTION_ITEM_TOOL,
        description:
          "Prepare to remove an editable LinkedIn profile section item (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["section"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            section: {
              type: "string",
              enum: [
                "about",
                "experience",
                "education",
                "certifications",
                "languages",
                "projects",
                "volunteer_experience",
                "honors_awards"
              ],
              description: "Editable LinkedIn profile section to remove from."
            },
            itemId: {
              type: "string",
              description:
                "Stable-ish item identifier returned by linkedin.profile.view_editable. Optional for about; otherwise provide this or match."
            },
            match: {
              type: "object",
              additionalProperties: {
                anyOf: [{ type: "string" }]
              },
              description:
                "Optional optimistic matching object for legacy items when itemId is unavailable. Supported keys include sourceId, primaryText, secondaryText, tertiaryText, and rawText."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_UPLOAD_PHOTO_TOOL,
        description:
          "Prepare a LinkedIn profile photo upload (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["filePath"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            filePath: {
              type: "string",
              description: "Local path to a JPG or PNG file that will be staged into artifacts before confirm."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_UPLOAD_BANNER_TOOL,
        description:
          "Prepare a LinkedIn profile banner upload (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["filePath"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            filePath: {
              type: "string",
              description: "Local path to a JPG or PNG file that will be staged into artifacts before confirm."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_FEATURED_ADD_TOOL,
        description:
          "Prepare to add a Featured item (link, media, or post) on the logged-in member's LinkedIn profile. Returns a confirm token; use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            kind: {
              type: "string",
              enum: ["link", "media", "post"],
              description: "Featured item type to add."
            },
            url: {
              type: "string",
              description: "Required for link/post. External absolute URL for links, or a LinkedIn post/article/newsletter URL for post."
            },
            filePath: {
              type: "string",
              description: "Required for media. Local path to a supported document or image file that will be staged into artifacts before confirm."
            },
            title: {
              type: "string",
              description: "Optional title override for link/media flows when the dialog exposes it."
            },
            description: {
              type: "string",
              description: "Optional description override for link/media flows when the dialog exposes it."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_FEATURED_REMOVE_TOOL,
        description:
          "Prepare to remove one item from the LinkedIn Featured section (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            itemId: {
              type: "string",
              description:
                "Stable-ish featured item identifier returned by linkedin.profile.view_editable.featured.items. Provide this or match."
            },
            match: {
              type: "object",
              additionalProperties: {
                anyOf: [{ type: "string" }]
              },
              description:
                "Optional optimistic matching object when itemId is unavailable. Supported keys include sourceId, url, title, subtitle, and rawText."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_FEATURED_REORDER_TOOL,
        description:
          "Prepare to reorder Featured items on the logged-in member's LinkedIn profile (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["itemIds"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            itemIds: {
              type: "array",
              items: {
                type: "string"
              },
              description:
                "Ordered featured item ids from linkedin.profile.view_editable.featured.items. The specified ids are moved to the top in the provided order."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_ADD_SKILL_TOOL,
        description:
          "Prepare to add one skill to the logged-in member's LinkedIn profile (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["skillName"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            skillName: {
              type: "string",
              description: "Skill name to add to the profile."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_REORDER_SKILLS_TOOL,
        description:
          "Prepare to reorder Skills on the logged-in member's LinkedIn profile (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["skillNames"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            skillNames: {
              type: "array",
              items: {
                type: "string"
              },
              description:
                "Ordered skill names to move to the top of the Skills section in the provided order."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_ENDORSE_SKILL_TOOL,
        description:
          "Prepare to endorse one visible skill on another member's LinkedIn profile (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target", "skillName"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Target member vanity name or LinkedIn profile URL. Must refer to another member, not 'me'."
            },
            skillName: {
              type: "string",
              description: "Skill name to endorse on the target profile."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_REQUEST_RECOMMENDATION_TOOL,
        description:
          "Prepare to request a LinkedIn recommendation from another member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Target member vanity name or LinkedIn profile URL. Must refer to another member, not 'me'."
            },
            relationship: {
              type: "string",
              description: "Optional relationship selection for LinkedIn's recommendation dialog."
            },
            position: {
              type: "string",
              description: "Optional role/position selection for LinkedIn's recommendation dialog."
            },
            company: {
              type: "string",
              description: "Optional company selection for LinkedIn's recommendation dialog."
            },
            message: {
              type: "string",
              description: "Optional personal message to include with the request."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_PROFILE_PREPARE_WRITE_RECOMMENDATION_TOOL,
        description:
          "Prepare to write a LinkedIn recommendation for another member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target", "text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Target member vanity name or LinkedIn profile URL. Must refer to another member, not 'me'."
            },
            text: {
              type: "string",
              description: "Recommendation text to submit."
            },
            relationship: {
              type: "string",
              description: "Optional relationship selection for LinkedIn's recommendation dialog."
            },
            position: {
              type: "string",
              description: "Optional role/position selection for LinkedIn's recommendation dialog."
            },
            company: {
              type: "string",
              description: "Optional company selection for LinkedIn's recommendation dialog."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_ASSETS_GENERATE_PROFILE_IMAGES_TOOL,
        description:
          "Generate a LinkedIn-ready profile photo, banner, and reusable post images from a local persona JSON spec using OpenAI. Optionally uploads the photo and banner through the existing LinkedIn profile upload flow.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["specPath"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            specPath: {
              type: "string",
              description: "Local path to the JSON persona/profile seed spec."
            },
            postImageCount: {
              type: "number",
              description:
                "Number of post images to generate. Defaults to 6 and must be 10 or fewer."
            },
            model: {
              type: "string",
              description: "Optional OpenAI image model override."
            },
            uploadProfileMedia: {
              type: "boolean",
              description:
                "If true, upload the generated profile photo and banner after generation."
            },
            uploadDelayMs: {
              type: "number",
              description:
                "Base delay between the photo and banner uploads when uploadProfileMedia is true. Defaults to 4500."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the upload actions."
            }
          })
        }
      },
      {
        name: LINKEDIN_ANALYTICS_PROFILE_VIEWS_TOOL,
        description:
          withSelectorAuditHint(
            "Read the logged-in member's LinkedIn profile-view analytics cards with normalized numeric metrics."
          ),
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
        name: LINKEDIN_ANALYTICS_SEARCH_APPEARANCES_TOOL,
        description:
          withSelectorAuditHint(
            "Read the logged-in member's LinkedIn search-appearance analytics cards with normalized numeric metrics."
          ),
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
        name: LINKEDIN_ANALYTICS_CONTENT_METRICS_TOOL,
        description:
          withSelectorAuditHint(
            "Read LinkedIn content and impression analytics cards from the logged-in member's profile analytics surface."
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
              description:
                "Maximum number of content analytics cards to return. Defaults to 4."
            }
          })
        }
      },
      {
        name: LINKEDIN_ANALYTICS_POST_METRICS_TOOL,
        description:
          withSelectorAuditHint(
            "Read normalized engagement metrics for one LinkedIn post URL, URN, or activity/share identifier."
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
        name: LINKEDIN_SEARCH_TOOL,
        description: withSelectorAuditHint(
          `Search LinkedIn for ${SEARCH_CATEGORIES.join(", ")}.`
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
              enum: [...SEARCH_CATEGORIES],
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
        name: LINKEDIN_CONNECTIONS_PREPARE_IGNORE_TOOL,
        description:
          "Prepare to ignore a received connection invitation (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the person whose received invitation should be ignored."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_PREPARE_REMOVE_TOOL,
        description:
          "Prepare to remove an existing connection (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the existing connection to remove."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL,
        description:
          "Prepare to follow a LinkedIn company page (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetCompany"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            targetCompany: {
              type: "string",
              description: "Company slug, /company/ path, or company URL."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_COMPANY_PREPARE_UNFOLLOW_TOOL,
        description:
          "Prepare to unfollow a LinkedIn company page (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetCompany"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            targetCompany: {
              type: "string",
              description: "Company slug, /company/ path, or company URL."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_PREPARE_FOLLOW_TOOL,
        description:
          "Prepare to follow a LinkedIn member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the member to follow."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_PREPARE_UNFOLLOW_TOOL,
        description:
          "Prepare to unfollow a LinkedIn member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the member to unfollow."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_MEMBERS_PREPARE_BLOCK_TOOL,
        description:
          "Prepare to block a LinkedIn member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the LinkedIn member to block."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_MEMBERS_PREPARE_UNBLOCK_TOOL,
        description:
          "Prepare to unblock a LinkedIn member from the blocked-members settings page (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
                "Vanity name or profile URL of the LinkedIn member to unblock."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL,
        description:
          "Prepare to report a LinkedIn member (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile", "reason"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name or profile URL of the LinkedIn member to report."
            },
            reason: {
              type: "string",
              enum: [...LINKEDIN_MEMBER_REPORT_REASONS],
              description: "Structured report reason for the dialog flow."
            },
            details: {
              type: "string",
              description:
                "Optional free-text details that will be filled when the dialog exposes a text field."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_PRIVACY_GET_SETTINGS_TOOL,
        description:
          withSelectorAuditHint(
            "Read the supported LinkedIn privacy settings surfaced by the automation runtime, including profile viewing mode and related visibility controls."
          ),
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
        name: LINKEDIN_PRIVACY_PREPARE_UPDATE_SETTING_TOOL,
        description:
          "Prepare to update one supported LinkedIn privacy setting (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["settingKey", "value"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            settingKey: {
              type: "string",
              enum: [...LINKEDIN_PRIVACY_SETTING_KEYS],
              description: "Supported LinkedIn privacy setting key."
            },
            value: {
              type: "string",
              description: "Requested setting value."
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
        name: LINKEDIN_FEED_PREPARE_REPOST_TOOL,
        description:
          "Prepare to repost a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_PREPARE_SHARE_TOOL,
        description:
          "Prepare to share a LinkedIn post with your own text (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
              description: "Text to publish with the shared post."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_SAVE_POST_TOOL,
        description:
          "Prepare to save a LinkedIn post for later (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_UNSAVE_POST_TOOL,
        description:
          "Prepare to remove a LinkedIn post from your saved items (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_FEED_PREPARE_REMOVE_REACTION_TOOL,
        description:
          "Prepare to remove your current reaction from a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
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
        name: LINKEDIN_POST_PREPARE_CREATE_MEDIA_TOOL,
        description:
          "Prepare a new LinkedIn media post with attachments (two-phase: returns confirm token). Use linkedin.actions.confirm to publish.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text", "mediaPaths"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            text: {
              type: "string",
              description: "Post text to publish alongside the media attachments."
            },
            mediaPaths: {
              type: "array",
              items: {
                type: "string"
              },
              description:
                "One or more local file paths for image/video attachments."
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
        name: LINKEDIN_POST_PREPARE_CREATE_POLL_TOOL,
        description:
          "Prepare a new LinkedIn poll post (two-phase: returns confirm token). Use linkedin.actions.confirm to publish.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["question", "options"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            text: {
              type: "string",
              description: "Optional lead-in text that appears above the poll."
            },
            question: {
              type: "string",
              description: "Poll question to publish."
            },
            options: {
              type: "array",
              items: {
                type: "string"
              },
              description: "Two to four poll options."
            },
            durationDays: {
              type: "number",
              description: "Poll duration in days. Supported values: 1, 3, 7, or 14."
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
        name: LINKEDIN_POST_PREPARE_EDIT_TOOL,
        description:
          "Prepare to edit one of your LinkedIn posts (two-phase: returns confirm token). Use linkedin.actions.confirm to save the update.",
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
              description: "Replacement post text to save."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_POST_PREPARE_DELETE_TOOL,
        description:
          "Prepare to delete one of your LinkedIn posts (two-phase: returns confirm token). Use linkedin.actions.confirm to execute the deletion.",
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
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_ARTICLE_PREPARE_CREATE_TOOL,
        description:
          "Prepare a new LinkedIn long-form article draft (two-phase: returns confirm token). Use linkedin.actions.confirm to create the draft in the publishing editor.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            title: {
              type: "string",
              description: "Article headline to stage in the publishing editor."
            },
            body: {
              type: "string",
              description:
                "Plain-text article body. Paragraph breaks are preserved."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_ARTICLE_PREPARE_PUBLISH_TOOL,
        description:
          "Prepare to publish an existing LinkedIn article draft (two-phase: returns confirm token). Use linkedin.actions.confirm to publish the draft.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["draftUrl"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            draftUrl: {
              type: "string",
              description:
                "Absolute LinkedIn article editor or draft URL returned by linkedin.article.prepare_create."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
        description:
          "Prepare a new LinkedIn newsletter series (two-phase: returns confirm token). Use linkedin.actions.confirm to create the newsletter shell.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "cadence"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            title: {
              type: "string",
              description: "Newsletter title."
            },
            description: {
              type: "string",
              description: "Short newsletter description."
            },
            cadence: {
              type: "string",
              enum: [...LINKEDIN_NEWSLETTER_CADENCE_TYPES],
              description: "Newsletter publish cadence."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
        description:
          "Prepare a new LinkedIn newsletter issue (two-phase: returns confirm token). Use linkedin.actions.confirm to publish the issue.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["newsletter", "title", "body"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            newsletter: {
              type: "string",
              description:
                "Newsletter title as returned by linkedin.newsletter.list."
            },
            title: {
              type: "string",
              description: "Issue headline."
            },
            body: {
              type: "string",
              description:
                "Plain-text issue body. Paragraph breaks are preserved."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NEWSLETTER_LIST_TOOL,
        description:
          withSelectorAuditHint(
            "List newsletter series currently available in the LinkedIn publishing editor."
          ),
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
        name: LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL,
        description:
          withSelectorAuditHint(
            "Mark one LinkedIn notification as read by notification ID."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["notificationId"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            notificationId: {
              type: "string",
              description:
                "Notification ID returned by linkedin.notifications.list."
            }
          })
        }
      },
      {
        name: LINKEDIN_NOTIFICATIONS_DISMISS_TOOL,
        description:
          withSelectorAuditHint(
            "Prepare a dismiss action for one LinkedIn notification (two-phase: returns confirm token). Use linkedin.actions.confirm to execute."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["notificationId"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            notificationId: {
              type: "string",
              description:
                "Notification ID returned by linkedin.notifications.list."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL,
        description:
          withSelectorAuditHint(
            "Read LinkedIn notification preference categories or one specific notification preference page."
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
            preferenceUrl: {
              type: "string",
              description:
                "Optional LinkedIn notification preference URL. When omitted, returns the notifications preferences overview."
            }
          })
        }
      },
      {
        name: LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL,
        description:
          withSelectorAuditHint(
            "Prepare a LinkedIn notification preference update (two-phase: returns confirm token). Use linkedin.actions.confirm to execute."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["preferenceUrl", "enabled"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            preferenceUrl: {
              type: "string",
              description:
                "LinkedIn notification category or subcategory URL returned by linkedin.notifications.preferences.get."
            },
            enabled: {
              type: "boolean",
              description: "Whether the selected preference should be enabled."
            },
            channel: {
              type: "string",
              description:
                "Optional channel key for subcategory pages: in_app, push, or email."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_SEARCH_TOOL,
        description:
          withSelectorAuditHint(
            "Search for LinkedIn job postings by keyword and optional location. Returns { results: [{ job_id, title, company, location, posted_at, job_url, salary_range, employment_type }], count }. Use linkedin.jobs.view for full details on a specific result."
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
            "View details of a specific LinkedIn job posting by job ID. Returns { job_id, title, company, company_url, location, description, salary_range, employment_type, seniority_level, applicant_count, is_remote }. Use linkedin.jobs.save or linkedin.jobs.prepare_easy_apply to act on the result."
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
        name: LINKEDIN_JOBS_SAVE_TOOL,
        description:
          "Prepare to save a LinkedIn job for later (two-phase: returns confirm token, low risk). Use linkedin.actions.confirm to execute. Use linkedin.jobs.unsave to reverse.",
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
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_UNSAVE_TOOL,
        description:
          "Prepare to unsave a previously saved LinkedIn job (two-phase: returns confirm token, low risk). Use linkedin.actions.confirm to execute.",
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
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_ALERTS_LIST_TOOL,
        description:
          withSelectorAuditHint("List LinkedIn job alerts for the current account. Returns { alerts: [{ alert_id, query, location, frequency, search_url, enabled }], count }. Use alert_id with linkedin.jobs.alerts.remove to manage alerts."),
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
              description: "Maximum number of alerts to return. Defaults to 20."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_ALERTS_CREATE_TOOL,
        description:
          "Prepare to create a LinkedIn job alert from a search query (two-phase: returns confirm token, low risk). Use linkedin.actions.confirm to execute. Use linkedin.jobs.alerts.list to view existing alerts.",
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
              description: "Search keywords for the alert."
            },
            location: {
              type: "string",
              description: "Optional location filter for the alert."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_ALERTS_REMOVE_TOOL,
        description:
          "Prepare to remove a LinkedIn job alert by alertId, searchUrl, or query (two-phase: returns confirm token, low risk). Use linkedin.actions.confirm to execute. Use linkedin.jobs.alerts.list to find the alertId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            alertId: {
              type: "string",
              description: "Alert id previously returned by linkedin.jobs.alerts.list."
            },
            searchUrl: {
              type: "string",
              description: "LinkedIn jobs search URL for the alert."
            },
            query: {
              type: "string",
              description: "Alert query if alertId or searchUrl are not available."
            },
            location: {
              type: "string",
              description: "Alert location if query is provided."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL,
        description:
          "Prepare a LinkedIn Easy Apply submission (two-phase: returns confirm token, high risk). Fills multi-step application forms with supplied answers. Use linkedin.jobs.view to check if a job supports Easy Apply before calling. Use linkedin.actions.confirm to execute.",
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
            },
            phoneNumber: {
              type: "string",
              description: "Phone number value for Easy Apply forms."
            },
            email: {
              type: "string",
              description: "Email value for Easy Apply forms."
            },
            city: {
              type: "string",
              description: "City value for Easy Apply forms."
            },
            resumePath: {
              type: "string",
              description: "Absolute or relative path to the resume file to upload."
            },
            coverLetter: {
              type: "string",
              description: "Cover letter text for Easy Apply forms."
            },
            answers: {
              type: "object",
              description:
                "Additional Easy Apply answers keyed by field label. Values may be strings, booleans, numbers, or string arrays."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_GROUPS_SEARCH_TOOL,
        description:
          withSelectorAuditHint(
            "Search LinkedIn groups by keyword and return matching communities."
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
              description: "Search keywords for LinkedIn groups."
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 10."
            }
          })
        }
      },
      {
        name: LINKEDIN_GROUPS_VIEW_TOOL,
        description:
          withSelectorAuditHint(
            "View details of a specific LinkedIn group by URL or numeric group ID."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["group"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            group: {
              type: "string",
              description: "LinkedIn group URL or numeric group ID."
            }
          })
        }
      },
      {
        name: LINKEDIN_GROUPS_PREPARE_JOIN_TOOL,
        description:
          "Prepare to join a LinkedIn group (two-phase: returns confirm token). Use linkedin.actions.confirm to request or complete the join.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["group"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            group: {
              type: "string",
              description: "LinkedIn group URL or numeric group ID."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL,
        description:
          "Prepare to leave a LinkedIn group (two-phase: returns confirm token). Use linkedin.actions.confirm to complete the leave flow.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["group"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            group: {
              type: "string",
              description: "LinkedIn group URL or numeric group ID."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_GROUPS_PREPARE_POST_TOOL,
        description:
          "Prepare a post inside a LinkedIn group (two-phase: returns confirm token). Use linkedin.actions.confirm to publish the post.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["group", "text"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            group: {
              type: "string",
              description: "LinkedIn group URL or numeric group ID."
            },
            text: {
              type: "string",
              description: "Post text to publish inside the group."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          })
        }
      },
      {
        name: LINKEDIN_EVENTS_SEARCH_TOOL,
        description:
          withSelectorAuditHint(
            "Search LinkedIn events by keyword and return matching event cards."
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
              description: "Search keywords for LinkedIn events."
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 10."
            }
          })
        }
      },
      {
        name: LINKEDIN_EVENTS_VIEW_TOOL,
        description:
          withSelectorAuditHint(
            "View details of a specific LinkedIn event by URL or numeric event ID."
          ),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["event"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            event: {
              type: "string",
              description: "LinkedIn event URL or numeric event ID."
            }
          })
        }
      },
      {
        name: LINKEDIN_EVENTS_PREPARE_RSVP_TOOL,
        description:
          "Prepare to RSVP attend for a LinkedIn event (two-phase: returns confirm token). Use linkedin.actions.confirm to complete the RSVP.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["event"],
          properties: withCdpSchemaProperties({
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            event: {
              type: "string",
              description: "LinkedIn event URL or numeric event ID."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
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
];

const TOOL_DEFINITION_BY_NAME = new Map(
  LINKEDIN_MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool] as const)
);

export function validateToolArguments(name: string, args: unknown): ToolArgs {
  const definition = TOOL_DEFINITION_BY_NAME.get(name);
  if (!definition) {
    throw new LinkedInBuddyError("TARGET_NOT_FOUND", `Unknown tool: ${name}.`, {
      tool: name
    });
  }

  validateToolArgValueAgainstSchema(definition.inputSchema, args, "");
  return args as ToolArgs;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: LINKEDIN_MCP_TOOL_DEFINITIONS
  };
});

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  [SUBMIT_FEEDBACK_TOOL]: handleSubmitFeedback,
  [LINKEDIN_SESSION_STATUS_TOOL]: handleSessionStatus,
  [LINKEDIN_SESSION_OPEN_LOGIN_TOOL]: handleSessionOpenLogin,
  [LINKEDIN_SESSION_HEALTH_TOOL]: handleSessionHealth,
  [LINKEDIN_INBOX_SEARCH_RECIPIENTS_TOOL]: handleSearchRecipients,
  [LINKEDIN_INBOX_LIST_THREADS_TOOL]: handleListThreads,
  [LINKEDIN_INBOX_GET_THREAD_TOOL]: handleGetThread,
  [LINKEDIN_INBOX_PREPARE_REPLY_TOOL]: handlePrepareReply,
  [LINKEDIN_INBOX_PREPARE_NEW_THREAD_TOOL]: handlePrepareNewThread,
  [LINKEDIN_INBOX_PREPARE_ADD_RECIPIENTS_TOOL]: handlePrepareAddRecipients,
  [LINKEDIN_INBOX_PREPARE_REACT_TOOL]: handlePrepareReact,
  [LINKEDIN_INBOX_ARCHIVE_THREAD_TOOL]: handleArchiveThread,
  [LINKEDIN_INBOX_UNARCHIVE_THREAD_TOOL]: handleUnarchiveThread,
  [LINKEDIN_INBOX_MARK_UNREAD_TOOL]: handleMarkUnread,
  [LINKEDIN_INBOX_MUTE_THREAD_TOOL]: handleMuteThread,
  [LINKEDIN_COMPANY_VIEW_TOOL]: handleCompanyView,
  [LINKEDIN_PROFILE_VIEW_TOOL]: handleProfileView,
  [LINKEDIN_PROFILE_VIEW_EDITABLE_TOOL]: handleProfileViewEditable,
  [LINKEDIN_PROFILE_PREPARE_UPDATE_INTRO_TOOL]: handleProfilePrepareUpdateIntro,
  [LINKEDIN_PROFILE_PREPARE_UPDATE_SETTINGS_TOOL]:
    handleProfilePrepareUpdateSettings,
  [LINKEDIN_PROFILE_PREPARE_UPDATE_PUBLIC_PROFILE_TOOL]:
    handleProfilePrepareUpdatePublicProfile,
  [LINKEDIN_PROFILE_PREPARE_UPSERT_SECTION_ITEM_TOOL]:
    handleProfilePrepareUpsertSectionItem,
  [LINKEDIN_PROFILE_PREPARE_REMOVE_SECTION_ITEM_TOOL]:
    handleProfilePrepareRemoveSectionItem,
  [LINKEDIN_PROFILE_PREPARE_UPLOAD_PHOTO_TOOL]: handleProfilePrepareUploadPhoto,
  [LINKEDIN_PROFILE_PREPARE_UPLOAD_BANNER_TOOL]: handleProfilePrepareUploadBanner,
  [LINKEDIN_PROFILE_PREPARE_FEATURED_ADD_TOOL]: handleProfilePrepareFeaturedAdd,
  [LINKEDIN_PROFILE_PREPARE_FEATURED_REMOVE_TOOL]:
    handleProfilePrepareFeaturedRemove,
  [LINKEDIN_PROFILE_PREPARE_FEATURED_REORDER_TOOL]:
    handleProfilePrepareFeaturedReorder,
  [LINKEDIN_PROFILE_PREPARE_ADD_SKILL_TOOL]: handleProfilePrepareAddSkill,
  [LINKEDIN_PROFILE_PREPARE_REORDER_SKILLS_TOOL]:
    handleProfilePrepareReorderSkills,
  [LINKEDIN_PROFILE_PREPARE_ENDORSE_SKILL_TOOL]:
    handleProfilePrepareEndorseSkill,
  [LINKEDIN_PROFILE_PREPARE_REQUEST_RECOMMENDATION_TOOL]:
    handleProfilePrepareRequestRecommendation,
  [LINKEDIN_PROFILE_PREPARE_WRITE_RECOMMENDATION_TOOL]:
    handleProfilePrepareWriteRecommendation,
  [LINKEDIN_ASSETS_GENERATE_PROFILE_IMAGES_TOOL]:
    handleAssetsGenerateProfileImages,
  [LINKEDIN_ANALYTICS_PROFILE_VIEWS_TOOL]: handleAnalyticsProfileViews,
  [LINKEDIN_ANALYTICS_SEARCH_APPEARANCES_TOOL]:
    handleAnalyticsSearchAppearances,
  [LINKEDIN_ANALYTICS_CONTENT_METRICS_TOOL]: handleAnalyticsContentMetrics,
  [LINKEDIN_ANALYTICS_POST_METRICS_TOOL]: handleAnalyticsPostMetrics,
  [LINKEDIN_SEARCH_TOOL]: handleSearch,
  [LINKEDIN_CONNECTIONS_LIST_TOOL]: handleConnectionsList,
  [LINKEDIN_CONNECTIONS_PENDING_TOOL]: handleConnectionsPending,
  [LINKEDIN_CONNECTIONS_INVITE_TOOL]: handleConnectionsInvite,
  [LINKEDIN_CONNECTIONS_ACCEPT_TOOL]: handleConnectionsAccept,
  [LINKEDIN_CONNECTIONS_WITHDRAW_TOOL]: handleConnectionsWithdraw,
  [LINKEDIN_CONNECTIONS_PREPARE_IGNORE_TOOL]: handleConnectionsPrepareIgnore,
  [LINKEDIN_CONNECTIONS_PREPARE_REMOVE_TOOL]: handleConnectionsPrepareRemove,
  [LINKEDIN_COMPANY_PREPARE_FOLLOW_TOOL]: handleCompanyPrepareFollow,
  [LINKEDIN_COMPANY_PREPARE_UNFOLLOW_TOOL]: handleCompanyPrepareUnfollow,
  [LINKEDIN_CONNECTIONS_PREPARE_FOLLOW_TOOL]: handleConnectionsPrepareFollow,
  [LINKEDIN_CONNECTIONS_PREPARE_UNFOLLOW_TOOL]: handleConnectionsPrepareUnfollow,
  [LINKEDIN_MEMBERS_PREPARE_BLOCK_TOOL]: handleMembersPrepareBlock,
  [LINKEDIN_MEMBERS_PREPARE_UNBLOCK_TOOL]: handleMembersPrepareUnblock,
  [LINKEDIN_MEMBERS_PREPARE_REPORT_TOOL]: handleMembersPrepareReport,
  [LINKEDIN_PRIVACY_GET_SETTINGS_TOOL]: handlePrivacyGetSettings,
  [LINKEDIN_PRIVACY_PREPARE_UPDATE_SETTING_TOOL]:
    handlePrivacyPrepareUpdateSetting,
  [LINKEDIN_NETWORK_PREPARE_FOLLOWUP_AFTER_ACCEPT_TOOL]: handlePrepareFollowupAfterAccept,
  [LINKEDIN_FEED_LIST_TOOL]: handleFeedList,
  [LINKEDIN_FEED_VIEW_POST_TOOL]: handleFeedViewPost,
  [LINKEDIN_FEED_LIKE_TOOL]: handleFeedLike,
  [LINKEDIN_FEED_COMMENT_TOOL]: handleFeedComment,
  [LINKEDIN_FEED_PREPARE_REPOST_TOOL]: handleFeedPrepareRepost,
  [LINKEDIN_FEED_PREPARE_SHARE_TOOL]: handleFeedPrepareShare,
  [LINKEDIN_FEED_SAVE_POST_TOOL]: handleFeedSavePost,
  [LINKEDIN_FEED_UNSAVE_POST_TOOL]: handleFeedUnsavePost,
  [LINKEDIN_FEED_PREPARE_REMOVE_REACTION_TOOL]: handleFeedPrepareRemoveReaction,
  [LINKEDIN_POST_PREPARE_CREATE_TOOL]: handlePostPrepareCreate,
  [LINKEDIN_POST_PREPARE_CREATE_MEDIA_TOOL]: handlePostPrepareCreateMedia,
  [LINKEDIN_POST_PREPARE_CREATE_POLL_TOOL]: handlePostPrepareCreatePoll,
  [LINKEDIN_POST_PREPARE_EDIT_TOOL]: handlePostPrepareEdit,
  [LINKEDIN_POST_PREPARE_DELETE_TOOL]: handlePostPrepareDelete,
  [LINKEDIN_ARTICLE_PREPARE_CREATE_TOOL]: handleArticlePrepareCreate,
  [LINKEDIN_ARTICLE_PREPARE_PUBLISH_TOOL]: handleArticlePreparePublish,
  [LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL]: handleNewsletterPrepareCreate,
  [LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL]:
    handleNewsletterPreparePublishIssue,
  [LINKEDIN_NEWSLETTER_LIST_TOOL]: handleNewsletterList,
  [LINKEDIN_NOTIFICATIONS_LIST_TOOL]: handleNotificationsList,
  [LINKEDIN_NOTIFICATIONS_MARK_READ_TOOL]: handleNotificationsMarkRead,
  [LINKEDIN_NOTIFICATIONS_DISMISS_TOOL]: handleNotificationsDismiss,
  [LINKEDIN_NOTIFICATIONS_PREFERENCES_GET_TOOL]: handleNotificationPreferencesGet,
  [LINKEDIN_NOTIFICATIONS_PREFERENCES_PREPARE_UPDATE_TOOL]:
    handleNotificationPreferencesPrepareUpdate,
  [LINKEDIN_JOBS_SEARCH_TOOL]: handleJobsSearch,
  [LINKEDIN_JOBS_VIEW_TOOL]: handleJobsView,
  [LINKEDIN_JOBS_SAVE_TOOL]: handleJobsSave,
  [LINKEDIN_JOBS_UNSAVE_TOOL]: handleJobsUnsave,
  [LINKEDIN_JOBS_ALERTS_LIST_TOOL]: handleJobsAlertsList,
  [LINKEDIN_JOBS_ALERTS_CREATE_TOOL]: handleJobsAlertsCreate,
  [LINKEDIN_JOBS_ALERTS_REMOVE_TOOL]: handleJobsAlertsRemove,
  [LINKEDIN_JOBS_PREPARE_EASY_APPLY_TOOL]: handleJobsPrepareEasyApply,
  [LINKEDIN_GROUPS_SEARCH_TOOL]: handleGroupsSearch,
  [LINKEDIN_GROUPS_VIEW_TOOL]: handleGroupsView,
  [LINKEDIN_GROUPS_PREPARE_JOIN_TOOL]: handleGroupsPrepareJoin,
  [LINKEDIN_GROUPS_PREPARE_LEAVE_TOOL]: handleGroupsPrepareLeave,
  [LINKEDIN_GROUPS_PREPARE_POST_TOOL]: handleGroupsPreparePost,
  [LINKEDIN_EVENTS_SEARCH_TOOL]: handleEventsSearch,
  [LINKEDIN_EVENTS_VIEW_TOOL]: handleEventsView,
  [LINKEDIN_EVENTS_PREPARE_RSVP_TOOL]: handleEventsPrepareRsvp,
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
  let errorForTracking: unknown;

  try {
    const handler = TOOL_HANDLERS[name];
    if (handler) {
      const validatedArgs = validateToolArguments(name, args);
      const profileName = trimOrUndefined(
        readString(validatedArgs, "profileName", "")
      );
      const result = await handler(validatedArgs);

      if (!shouldTrackMcpFeedback(name)) {
        return result;
      }

      const decision = await recordFeedbackInvocation({
        source: "mcp",
        invocationName: name,
        mcpToolName: name,
        ...(profileName ? { activeProfileName: profileName } : {})
      });

      return decision.showHint ? addFeedbackHintToResult(result) : result;
    }

    errorForTracking = new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Unknown tool: ${name}`
    );
    const unknownToolResult = toErrorResult(errorForTracking);

    if (!shouldTrackMcpFeedback(name)) {
      return unknownToolResult;
    }

    const decision = await recordFeedbackInvocation({
      source: "mcp",
      invocationName: name,
      mcpToolName: name,
      error: errorForTracking
    });

    return decision.showHint
      ? addFeedbackHintToResult(unknownToolResult)
      : unknownToolResult;
  } catch (error) {
    errorForTracking = error;
    const errorResult = toErrorResult(error);

    if (!shouldTrackMcpFeedback(name)) {
      return errorResult;
    }

    try {
      const validatedArgs = name in TOOL_HANDLERS
        ? validateToolArguments(name, args)
        : args;
      const profileName = trimOrUndefined(
        readString(validatedArgs, "profileName", "")
      );
      const decision = await recordFeedbackInvocation({
        source: "mcp",
        invocationName: name,
        mcpToolName: name,
        ...(profileName ? { activeProfileName: profileName } : {}),
        error: errorForTracking
      });

      return decision.showHint ? addFeedbackHintToResult(errorResult) : errorResult;
    } catch {
      return errorResult;
    }
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
      JSON.stringify(toLinkedInBuddyErrorPayload(error, mcpPrivacyConfig), null, 2)
    );
    process.exit(1);
  });
}
