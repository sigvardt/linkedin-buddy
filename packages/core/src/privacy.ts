import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { isRecord } from "./shared.js";

export const PRIVACY_REDACTION_MODES = ["off", "partial", "full"] as const;
export type PrivacyRedactionMode = (typeof PRIVACY_REDACTION_MODES)[number];

export const PRIVACY_STORAGE_MODES = ["full", "excerpt"] as const;
export type PrivacyStorageMode = (typeof PRIVACY_STORAGE_MODES)[number];

export type PrivacySurface = "log" | "cli" | "error" | "storage" | "artifact";

export interface PrivacyConfig {
  redactionMode: PrivacyRedactionMode;
  storageMode: PrivacyStorageMode;
  hashSalt: string;
  messageExcerptLength: number;
}

type EnvironmentMap = Record<string, string | undefined>;

interface RedactionContext {
  config: PrivacyConfig;
  surface: PrivacySurface;
  path: string[];
  key?: string;
  parent?: Record<string, unknown>;
}

const DEFAULT_HASH_NAMESPACE = "linkedin-buddy-privacy-v1";
const DEFAULT_MESSAGE_EXCERPT_LENGTH = 80;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LIKELY_FULL_NAME_PATTERN = /\b[A-Z][A-Za-z'’-]+ [A-Z][A-Za-z'’-]+\b/g;
const LINKEDIN_PROFILE_URL_PATTERN =
  /((?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/|\/in\/)([^/?#\s]+)/gi;

const EXPLICIT_NAME_KEYS = new Set([
  "author",
  "author_name",
  "display_name",
  "expected_participant_name",
  "full_name",
  "participant_name",
  "provided_profile_name",
  "target_profile",
  "vanity_name",
]);

const MESSAGE_KEYS = new Set(["body", "note", "snippet", "text"]);

function isPrivacyRedactionMode(value: string): value is PrivacyRedactionMode {
  return (PRIVACY_REDACTION_MODES as readonly string[]).includes(value);
}

function isPrivacyStorageMode(value: string): value is PrivacyStorageMode {
  return (PRIVACY_STORAGE_MODES as readonly string[]).includes(value);
}

function normalizeKey(key: string | undefined): string {
  return (key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function clampExcerptLength(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MESSAGE_EXCERPT_LENGTH;
  }

  return Math.max(8, Math.min(512, Math.floor(value)));
}

function objectLooksLikePerson(
  parent: Record<string, unknown> | undefined,
): boolean {
  if (!parent) {
    return false;
  }

  return (
    "profile_url" in parent ||
    "vanity_name" in parent ||
    "connection_degree" in parent ||
    "mutual_connections" in parent ||
    "author_profile_url" in parent
  );
}

function objectLooksLikeInboxThread(
  parent: Record<string, unknown> | undefined,
): boolean {
  if (!parent) {
    return false;
  }

  return (
    "thread_id" in parent ||
    "thread_url" in parent ||
    "unread_count" in parent ||
    "messages" in parent
  );
}

function objectLooksLikeNotification(
  parent: Record<string, unknown> | undefined,
): boolean {
  if (!parent) {
    return false;
  }

  return "timestamp" in parent && "is_read" in parent && "link" in parent;
}

function shouldHashNames(
  config: PrivacyConfig,
  surface: PrivacySurface,
): boolean {
  if (surface === "storage" || surface === "artifact") {
    return config.redactionMode !== "off";
  }

  return config.redactionMode !== "off";
}

function shouldHashNameValue(context: RedactionContext): boolean {
  if (!shouldHashNames(context.config, context.surface)) {
    return false;
  }

  const key = normalizeKey(context.key);

  if (EXPLICIT_NAME_KEYS.has(key)) {
    return true;
  }

  if (key === "name") {
    return objectLooksLikePerson(context.parent);
  }

  if (key === "title" || key === "actual_title") {
    return objectLooksLikeInboxThread(context.parent);
  }

  return false;
}

function shouldRedactMessageValue(context: RedactionContext): boolean {
  const key = normalizeKey(context.key);

  if (MESSAGE_KEYS.has(key)) {
    return true;
  }

  if (key !== "message") {
    return false;
  }

  return (
    objectLooksLikeNotification(context.parent) ||
    context.path.includes("messages") ||
    context.path.includes("notifications") ||
    context.path.includes("outbound")
  );
}

function shouldUseFullMessageRedaction(
  config: PrivacyConfig,
  surface: PrivacySurface,
): boolean {
  if (surface === "storage" || surface === "artifact") {
    return config.redactionMode === "full";
  }

  return config.redactionMode === "full";
}

function shouldUseExcerptMessageRedaction(
  config: PrivacyConfig,
  surface: PrivacySurface,
): boolean {
  if (surface === "storage" || surface === "artifact") {
    return (
      config.redactionMode === "partial" || config.storageMode === "excerpt"
    );
  }

  return config.redactionMode === "partial";
}

function shortHash(kind: string, value: string, config: PrivacyConfig): string {
  return createHash("sha256")
    .update(DEFAULT_HASH_NAMESPACE)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(config.hashSalt)
    .update("\0")
    .update(value)
    .digest("base64url")
    .slice(0, 12);
}

function redactName(value: string, config: PrivacyConfig): string {
  return `person#${shortHash("person", value, config)}`;
}

function redactEmail(value: string, config: PrivacyConfig): string {
  return `email#${shortHash("email", value, config)}`;
}

function redactProfileSlug(value: string, config: PrivacyConfig): string {
  return `profile#${shortHash("profile", value, config)}`;
}

function redactProfileUrls(value: string, config: PrivacyConfig): string {
  return value.replace(
    LINKEDIN_PROFILE_URL_PATTERN,
    (_, prefix: string, slug: string) => {
      return `${prefix}${redactProfileSlug(slug, config)}`;
    },
  );
}

function redactEmails(value: string, config: PrivacyConfig): string {
  return value.replace(EMAIL_PATTERN, (email) => redactEmail(email, config));
}

function redactLikelyFullNames(value: string, config: PrivacyConfig): string {
  return value.replace(LIKELY_FULL_NAME_PATTERN, (match) =>
    redactName(match, config),
  );
}

function redactActionSummary(value: string, config: PrivacyConfig): string {
  const replacements = [
    {
      regex: /(Send message to )"([^"]+)"/,
      replacer: (prefix: string, subject: string) =>
        `${prefix}"${redactName(subject, config)}"`,
    },
    {
      regex: /(Send connection invitation to )(.+)$/,
      replacer: (prefix: string, subject: string) =>
        `${prefix}${redactName(subject, config)}`,
    },
    {
      regex: /(Accept connection invitation from )(.+)$/,
      replacer: (prefix: string, subject: string) =>
        `${prefix}${redactName(subject, config)}`,
    },
    {
      regex: /(Withdraw sent invitation to )(.+)$/,
      replacer: (prefix: string, subject: string) =>
        `${prefix}${redactName(subject, config)}`,
    },
  ] as const;

  let sanitized = value;

  for (const replacement of replacements) {
    sanitized = sanitized.replace(
      replacement.regex,
      (_, prefix: string, subject: string) => {
        return replacement.replacer(prefix, subject.trim());
      },
    );
  }

  return sanitized;
}

export function redactFreeformText(
  value: string,
  config: PrivacyConfig,
): string {
  let sanitized = redactEmails(value, config);
  sanitized = redactProfileUrls(sanitized, config);
  sanitized = redactActionSummary(sanitized, config);
  sanitized = sanitized.replace(
    /(profile )"([^"]+)"/gi,
    (_, prefix: string, subject: string) => {
      return `${prefix}"${redactName(subject, config)}"`;
    },
  );
  return sanitized;
}

function redactMessageText(
  value: string,
  config: PrivacyConfig,
  surface: PrivacySurface,
): string {
  const sanitized = redactLikelyFullNames(
    redactFreeformText(value, config),
    config,
  );
  const hash = shortHash("text", value, config);
  const originalLength = value.length;

  if (shouldUseFullMessageRedaction(config, surface)) {
    return `[redacted len=${originalLength} hash=${hash}]`;
  }

  if (!shouldUseExcerptMessageRedaction(config, surface)) {
    return sanitized;
  }

  if (originalLength <= 1) {
    return `[excerpt len=${originalLength} hash=${hash}]`;
  }

  const revealLength = Math.min(
    config.messageExcerptLength,
    originalLength - 1,
  );
  const excerpt = sanitized.slice(0, revealLength);
  return `${excerpt}… [len=${originalLength} hash=${hash}]`;
}

function redactStringValue(value: string, context: RedactionContext): string {
  const key = normalizeKey(context.key);

  if (key === "summary" && shouldHashNames(context.config, context.surface)) {
    return redactActionSummary(
      redactFreeformText(value, context.config),
      context.config,
    );
  }

  if (key === "email") {
    return redactEmail(value, context.config);
  }

  if (shouldHashNameValue(context)) {
    return redactName(value, context.config);
  }

  if (shouldRedactMessageValue(context)) {
    return redactMessageText(value, context.config, context.surface);
  }

  if (shouldHashNames(context.config, context.surface)) {
    return redactFreeformText(value, context.config);
  }

  return value;
}

function redactUnknownValue(
  value: unknown,
  context: RedactionContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactUnknownValue(item, {
        ...context,
        key: String(index),
        path: [...context.path, String(index)],
      }),
    );
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactUnknownValue(entryValue, {
        ...context,
        key: entryKey,
        path: [...context.path, entryKey],
        parent: value,
      });
    }
    return output;
  }

  if (typeof value === "string") {
    return redactStringValue(value, context);
  }

  return value;
}

function deriveCipherKey(confirmToken: string, config: PrivacyConfig): Buffer {
  return createHash("sha256")
    .update(DEFAULT_HASH_NAMESPACE)
    .update("\0")
    .update("cipher")
    .update("\0")
    .update(config.hashSalt)
    .update("\0")
    .update(confirmToken)
    .digest();
}

export function sealJsonRecord(
  value: Record<string, unknown>,
  confirmToken: string,
  config: PrivacyConfig,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveCipherKey(confirmToken, config),
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function unsealJsonRecord(
  sealedValue: string,
  confirmToken: string,
  config: PrivacyConfig,
): Record<string, unknown> {
  const [version, ivEncoded, authTagEncoded, ciphertextEncoded] =
    sealedValue.split(".");
  if (version !== "v1" || !ivEncoded || !authTagEncoded || !ciphertextEncoded) {
    throw new Error("Invalid sealed JSON record format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveCipherKey(confirmToken, config),
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  const parsed = JSON.parse(decrypted) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Decrypted JSON record must be an object.");
  }

  return parsed;
}

export function createDefaultPrivacyConfig(
  env: EnvironmentMap = process.env,
): PrivacyConfig {
  const redactionModeRaw =
    env.LINKEDIN_BUDDY_REDACTION_MODE?.trim().toLowerCase();
  const storageModeRaw = env.LINKEDIN_BUDDY_STORAGE_MODE?.trim().toLowerCase();
  const messageExcerptLengthRaw = Number.parseInt(
    env.LINKEDIN_BUDDY_MESSAGE_EXCERPT_LENGTH ?? "",
    10,
  );

  return {
    redactionMode:
      redactionModeRaw && isPrivacyRedactionMode(redactionModeRaw)
        ? redactionModeRaw
        : "off",
    storageMode:
      storageModeRaw && isPrivacyStorageMode(storageModeRaw)
        ? storageModeRaw
        : "full",
    hashSalt: env.LINKEDIN_BUDDY_REDACTION_HASH_SALT ?? "",
    messageExcerptLength: clampExcerptLength(messageExcerptLengthRaw),
  };
}

export function resolvePrivacyConfig(
  overrides: Partial<PrivacyConfig> = {},
  env: EnvironmentMap = process.env,
): PrivacyConfig {
  const defaults = createDefaultPrivacyConfig(env);

  return {
    redactionMode: overrides.redactionMode ?? defaults.redactionMode,
    storageMode: overrides.storageMode ?? defaults.storageMode,
    hashSalt: overrides.hashSalt ?? defaults.hashSalt,
    messageExcerptLength: clampExcerptLength(
      overrides.messageExcerptLength ?? defaults.messageExcerptLength,
    ),
  };
}

export function redactStructuredValue<T>(
  value: T,
  config: PrivacyConfig,
  surface: PrivacySurface,
): T {
  return redactUnknownValue(value, {
    config,
    surface,
    path: [],
  }) as T;
}
