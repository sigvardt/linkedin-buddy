import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureConfigPaths, resolveConfigPaths } from "./config.js";
import { LinkedInAssistantError } from "./errors.js";
import {
  normalizeLinkedInFeedReaction,
  type LinkedInFeedReaction
} from "./linkedinFeed.js";
import {
  normalizeLinkedInPostVisibility,
  type LinkedInPostVisibility
} from "./linkedinPosts.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";

const LINKEDIN_ASSISTANT_CONFIG_FILENAME = "config.json";

export const WRITE_VALIDATION_ACCOUNT_DESIGNATIONS = [
  "primary",
  "secondary"
] as const;

export type WriteValidationAccountDesignation =
  (typeof WRITE_VALIDATION_ACCOUNT_DESIGNATIONS)[number];

export interface WriteValidationMessageTargetConfig {
  thread: string;
  participantPattern?: string;
}

export interface WriteValidationConnectionTargetConfig {
  note?: string;
  targetProfile: string;
}

export interface WriteValidationFollowupTargetConfig {
  profileUrlKey: string;
}

export interface WriteValidationReactionTargetConfig {
  postUrl: string;
  reaction?: LinkedInFeedReaction;
}

export interface WriteValidationPostTargetConfig {
  visibility?: LinkedInPostVisibility;
}

export interface WriteValidationAccountTargets {
  "connections.send_invitation"?: WriteValidationConnectionTargetConfig;
  "feed.like_post"?: WriteValidationReactionTargetConfig;
  "network.followup_after_accept"?: WriteValidationFollowupTargetConfig;
  "post.create"?: WriteValidationPostTargetConfig;
  send_message?: WriteValidationMessageTargetConfig;
}

export interface WriteValidationAccount {
  id: string;
  designation: WriteValidationAccountDesignation;
  label: string;
  profileName: string;
  sessionName: string;
  targets: WriteValidationAccountTargets;
}

export interface WriteValidationAccountRegistry {
  accounts: Record<string, WriteValidationAccount>;
  configPath: string;
}

export interface UpsertWriteValidationAccountInput {
  accountId: string;
  baseDir?: string;
  designation: WriteValidationAccountDesignation;
  label?: string;
  overwrite?: boolean;
  profileName?: string;
  sessionName?: string;
  targets?: WriteValidationAccountTargets;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a string.`
    );
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  return normalized;
}

function assertLocalIdentifier(value: unknown, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not contain path separators or relative path segments.`
    );
  }

  return normalized;
}

function assertOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a string.`
    );
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseAccountDesignation(
  value: unknown,
  label: string
): WriteValidationAccountDesignation {
  if (
    value === "primary" ||
    value === "secondary"
  ) {
    return value;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${label} must be one of: ${WRITE_VALIDATION_ACCOUNT_DESIGNATIONS.join(", ")}.`,
    {
      label,
      provided_value: value
    }
  );
}

function resolveConfigPath(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).baseDir, LINKEDIN_ASSISTANT_CONFIG_FILENAME);
}

function readConfigShape(baseDir?: string): { config: JsonRecord; configPath: string } {
  const configPath = resolveConfigPath(baseDir);

  if (!existsSync(configPath)) {
    return {
      config: {},
      configPath
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Failed to parse LinkedIn assistant config file at ${configPath}.`,
      {
        config_path: configPath,
        message: error instanceof Error ? error.message : String(error)
      },
      error instanceof Error ? { cause: error } : undefined
    );
  }

  if (!isRecord(parsed)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `LinkedIn assistant config file at ${configPath} must contain a JSON object.`,
      {
        config_path: configPath
      }
    );
  }

  return {
    config: parsed,
    configPath
  };
}

function normalizeAccountId(value: string, label: string): string {
  return assertLocalIdentifier(value, label);
}

function normalizeThreadTarget(value: unknown, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (normalized.startsWith("/messaging/thread/")) {
    return `https://www.linkedin.com${normalized}`;
  }
  return normalized;
}

function normalizePostUrl(value: unknown, label: string): string {
  const normalized = assertNonEmptyString(value, label);
  if (normalized.startsWith("/")) {
    return `https://www.linkedin.com${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    return parsed.toString();
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a valid LinkedIn post URL.`,
      {
        label,
        provided_value: value,
        message: error instanceof Error ? error.message : String(error)
      },
      error instanceof Error ? { cause: error } : undefined
    );
  }
}

function parseMessageTarget(
  value: unknown,
  label: string
): WriteValidationMessageTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const participantPattern = assertOptionalString(
    value.participantPattern,
    `${label}.participantPattern`
  );

  return {
    thread: normalizeThreadTarget(value.thread, `${label}.thread`),
    ...(participantPattern ? { participantPattern } : {})
  };
}

function parseConnectionTarget(
  value: unknown,
  label: string
): WriteValidationConnectionTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const note = assertOptionalString(value.note, `${label}.note`);

  return {
    targetProfile: resolveProfileUrl(
      assertNonEmptyString(value.targetProfile, `${label}.targetProfile`)
    ),
    ...(note ? { note } : {})
  };
}

function parseFollowupTarget(
  value: unknown,
  label: string
): WriteValidationFollowupTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const profileUrlKey = normalizeLinkedInProfileUrl(
    resolveProfileUrl(assertNonEmptyString(value.profileUrlKey, `${label}.profileUrlKey`))
  );

  return {
    profileUrlKey
  };
}

function parseReactionTarget(
  value: unknown,
  label: string
): WriteValidationReactionTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const reaction = assertOptionalString(value.reaction, `${label}.reaction`);

  return {
    postUrl: normalizePostUrl(value.postUrl, `${label}.postUrl`),
    ...(reaction
      ? {
          reaction: normalizeLinkedInFeedReaction(reaction)
        }
      : {})
  };
}

function parsePostTarget(
  value: unknown,
  label: string
): WriteValidationPostTargetConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const visibility = assertOptionalString(value.visibility, `${label}.visibility`);

  return {
    ...(visibility
      ? {
          visibility: normalizeLinkedInPostVisibility(visibility, "connections")
        }
      : {})
  };
}

function parseTargets(
  value: unknown,
  label: string
): WriteValidationAccountTargets {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const messageTarget = parseMessageTarget(
    value.send_message,
    `${label}.send_message`
  );
  const invitationTarget = parseConnectionTarget(
    value["connections.send_invitation"],
    `${label}.connections.send_invitation`
  );
  const followupTarget = parseFollowupTarget(
    value["network.followup_after_accept"],
    `${label}.network.followup_after_accept`
  );
  const reactionTarget = parseReactionTarget(
    value["feed.like_post"],
    `${label}.feed.like_post`
  );
  const postTarget = parsePostTarget(
    value["post.create"],
    `${label}.post.create`
  );

  return {
    ...(messageTarget ? { send_message: messageTarget } : {}),
    ...(invitationTarget
      ? { "connections.send_invitation": invitationTarget }
      : {}),
    ...(followupTarget
      ? { "network.followup_after_accept": followupTarget }
      : {}),
    ...(reactionTarget ? { "feed.like_post": reactionTarget } : {}),
    ...(postTarget ? { "post.create": postTarget } : {})
  };
}

function parseAccount(
  accountId: string,
  value: unknown,
  configPath: string
): WriteValidationAccount {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `writeValidation.accounts.${accountId} in ${configPath} must be a JSON object.`,
      {
        config_path: configPath,
        account_id: accountId
      }
    );
  }

  const normalizedAccountId = normalizeAccountId(
    accountId,
    `writeValidation.accounts.${accountId}`
  );
  const designation = parseAccountDesignation(
    value.designation,
    `writeValidation.accounts.${accountId}.designation`
  );
  const label = assertNonEmptyString(
    value.label ?? normalizedAccountId,
    `writeValidation.accounts.${accountId}.label`
  );
  const profileName = normalizeAccountId(
    typeof value.profileName === "string" ? value.profileName : normalizedAccountId,
    `writeValidation.accounts.${accountId}.profileName`
  );
  const sessionName = normalizeAccountId(
    typeof value.sessionName === "string" ? value.sessionName : normalizedAccountId,
    `writeValidation.accounts.${accountId}.sessionName`
  );

  return {
    id: normalizedAccountId,
    designation,
    label,
    profileName,
    sessionName,
    targets: parseTargets(
      value.targets,
      `writeValidation.accounts.${accountId}.targets`
    )
  };
}

function serializeAccount(account: WriteValidationAccount): JsonRecord {
  return {
    designation: account.designation,
    label: account.label,
    profileName: account.profileName,
    sessionName: account.sessionName,
    targets: account.targets
  };
}

export function loadWriteValidationAccounts(
  baseDir?: string
): WriteValidationAccountRegistry {
  const { config, configPath } = readConfigShape(baseDir);
  const writeValidation = config.writeValidation;

  if (writeValidation === undefined) {
    return {
      accounts: {},
      configPath
    };
  }

  if (!isRecord(writeValidation)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `writeValidation in ${configPath} must be a JSON object.`,
      {
        config_path: configPath,
        provided_value: writeValidation
      }
    );
  }

  const accountsShape = writeValidation.accounts;
  if (accountsShape === undefined) {
    return {
      accounts: {},
      configPath
    };
  }

  if (!isRecord(accountsShape)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `writeValidation.accounts in ${configPath} must be a JSON object.`,
      {
        config_path: configPath,
        provided_value: accountsShape
      }
    );
  }

  const accounts = Object.fromEntries(
    Object.entries(accountsShape).map(([accountId, accountValue]) => [
      accountId,
      parseAccount(accountId, accountValue, configPath)
    ])
  ) as Record<string, WriteValidationAccount>;

  return {
    accounts,
    configPath
  };
}

export function resolveWriteValidationAccount(
  accountId: string,
  baseDir?: string
): WriteValidationAccount {
  const normalizedAccountId = normalizeAccountId(accountId, "account");
  const registry = loadWriteValidationAccounts(baseDir);
  const account = registry.accounts[normalizedAccountId];

  if (account) {
    return account;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `No write-validation account named "${normalizedAccountId}" was found. Register it with "owa accounts:add ${normalizedAccountId} --designation secondary --session ${normalizedAccountId}" or update ${registry.configPath}.`,
    {
      account_id: normalizedAccountId,
      config_path: registry.configPath
    }
  );
}

export async function upsertWriteValidationAccount(
  input: UpsertWriteValidationAccountInput
): Promise<WriteValidationAccountRegistry> {
  const normalizedAccountId = normalizeAccountId(input.accountId, "account");
  const paths = resolveConfigPaths(input.baseDir);
  ensureConfigPaths(paths);

  const { config, configPath } = readConfigShape(input.baseDir);
  const existingWriteValidation = config.writeValidation;
  const writeValidation = existingWriteValidation
    ? isRecord(existingWriteValidation)
      ? { ...existingWriteValidation }
      : (() => {
          throw new LinkedInAssistantError(
            "ACTION_PRECONDITION_FAILED",
            `writeValidation in ${configPath} must be a JSON object.`,
            {
              config_path: configPath,
              provided_value: existingWriteValidation
            }
          );
        })()
    : {};
  const existingAccounts = writeValidation.accounts;
  const accounts = existingAccounts
    ? isRecord(existingAccounts)
      ? { ...existingAccounts }
      : (() => {
          throw new LinkedInAssistantError(
            "ACTION_PRECONDITION_FAILED",
            `writeValidation.accounts in ${configPath} must be a JSON object.`,
            {
              config_path: configPath,
              provided_value: existingAccounts
            }
          );
        })()
    : {};

  if (accounts[normalizedAccountId] !== undefined && !input.overwrite) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Write-validation account "${normalizedAccountId}" already exists. Rerun with overwrite enabled to replace it.`,
      {
        account_id: normalizedAccountId,
        config_path: configPath
      }
    );
  }

  const account: WriteValidationAccount = {
    id: normalizedAccountId,
    designation: parseAccountDesignation(input.designation, "designation"),
    label: assertNonEmptyString(input.label ?? normalizedAccountId, "label"),
    profileName: normalizeAccountId(
      input.profileName ?? normalizedAccountId,
      "profile"
    ),
    sessionName: normalizeAccountId(
      input.sessionName ?? normalizedAccountId,
      "session"
    ),
    targets: parseTargets(input.targets, "targets")
  };

  accounts[normalizedAccountId] = serializeAccount(account);
  writeValidation.accounts = accounts;

  const nextConfig: JsonRecord = {
    ...config,
    writeValidation
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return loadWriteValidationAccounts(input.baseDir);
}
