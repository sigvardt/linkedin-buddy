import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_WATCH_KINDS,
  ACTIVITY_WATCH_STATUSES,
  LinkedInBuddyError,
  isSearchCategory,
  normalizeLinkedInMemberReportReason,
  normalizeLinkedInPrivacySettingKey,
  SEARCH_CATEGORIES,
  WEBHOOK_DELIVERY_ATTEMPT_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type ActivityEventType,
  type ActivityWatchKind,
  type ActivityWatchStatus,
  type SearchCategory,
  type WebhookDeliveryAttemptStatus,
  type WebhookSubscriptionStatus,
} from "@linkedin-buddy/core";

export type ToolArgs = Record<string, unknown>;

export function readString(
  args: ToolArgs,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function readRequiredString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`,
  );
}

export function readBoundedString(
  args: ToolArgs,
  key: string,
  maxLength = 5000,
  fallback?: string,
): string {
  const value =
    typeof fallback === "string"
      ? readString(args, key, fallback)
      : readRequiredString(args, key);

  if (value.length > maxLength) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be ${maxLength} characters or fewer.`,
      {
        path: `arguments.${key}`,
        actual_length: value.length,
        max_length: maxLength,
      },
    );
  }

  return value;
}

export function readValidatedUrl(args: ToolArgs, key: string): string {
  const value = readRequiredString(args, key);

  try {
    return new URL(value).toString();
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a valid URL.`,
      {
        path: `arguments.${key}`,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export function readValidatedFilePath(args: ToolArgs, key: string): string {
  const value = readRequiredString(args, key);

  if (value.includes("../") || value.includes("..\\")) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must not include path traversal segments.`,
      {
        path: `arguments.${key}`,
      },
    );
  }

  return value;
}

export function readPositiveNumber(
  args: ToolArgs,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a positive number.`,
    );
  }

  return value;
}

export function readNonNegativeNumber(
  args: ToolArgs,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be zero or a positive number.`,
    );
  }

  return value;
}

export function readBoolean(
  args: ToolArgs,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

export function readRequiredBoolean(args: ToolArgs, key: string): boolean {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`,
  );
}

export function readOptionalPositiveNumber(
  args: ToolArgs,
  key: string,
): number | undefined {
  if (!(key in args) || args[key] === undefined) {
    return undefined;
  }

  return readPositiveNumber(args, key, 1);
}

export function readOptionalNonNegativeNumber(
  args: ToolArgs,
  key: string,
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
      `${key} must be a non-negative integer.`,
    );
  }

  return value;
}

export function readStringArray(
  args: ToolArgs,
  key: string,
): string[] | undefined {
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
    `${key} must be a string or array of strings.`,
  );
}

export function readRequiredStringArray(args: ToolArgs, key: string): string[] {
  const values = readStringArray(args, key);
  if (values && values.length > 0) {
    return values;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`,
  );
}

export function readObject(
  args: ToolArgs,
  key: string,
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
    `${key} must be an object.`,
  );
}

export async function readJsonInputFile(
  filePath: string,
  label: string,
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
        cause: error instanceof Error ? error.message : String(error),
      },
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
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export function coerceEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${label} must be one of: ${allowed.join(", ")}.`,
  );
}

export function readActivityWatchKind(
  args: ToolArgs,
  key: string,
): ActivityWatchKind {
  return coerceEnumValue(
    readRequiredString(args, key),
    ACTIVITY_WATCH_KINDS,
    key,
  );
}

export function readOptionalActivityWatchStatus(
  args: ToolArgs,
  key: string,
): ActivityWatchStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(value.trim(), ACTIVITY_WATCH_STATUSES, key);
}

export function readOptionalWebhookSubscriptionStatus(
  args: ToolArgs,
  key: string,
): WebhookSubscriptionStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(value.trim(), WEBHOOK_SUBSCRIPTION_STATUSES, key);
}

export function readOptionalWebhookDeliveryStatus(
  args: ToolArgs,
  key: string,
): WebhookDeliveryAttemptStatus | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return coerceEnumValue(value.trim(), WEBHOOK_DELIVERY_ATTEMPT_STATUSES, key);
}

export function readActivityEventTypes(
  args: ToolArgs,
  key: string,
): ActivityEventType[] | undefined {
  const values = readStringArray(args, key);
  if (!values) {
    return undefined;
  }

  return values.map((value) =>
    coerceEnumValue(value, ACTIVITY_EVENT_TYPES, key),
  );
}

export function readSearchCategory(
  args: ToolArgs,
  key: string,
  fallback: SearchCategory,
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
    `${key} must be one of: ${SEARCH_CATEGORIES.join(", ")}.`,
  );
}

export function readMemberReportReason(
  args: ToolArgs,
  key: string,
): ReturnType<typeof normalizeLinkedInMemberReportReason> {
  return normalizeLinkedInMemberReportReason(readRequiredString(args, key));
}

export function readPrivacySettingKey(args: ToolArgs, key: string) {
  return normalizeLinkedInPrivacySettingKey(readRequiredString(args, key));
}

export function readTargetProfileName(
  target: Record<string, unknown>,
): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
