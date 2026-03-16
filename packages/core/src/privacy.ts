import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
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
/**
 * Matches a single title-cased word (same character class as the former
 * two-word LIKELY_FULL_NAME_PATTERN).  Used by {@link redactLikelyFullNames}
 * to locate individual capitalised tokens before pairing them.
 */
const CAPITALIZED_WORD_PATTERN = /\b[A-Z][A-Za-z'\u2019-]+\b/g;

/**
 * Words that commonly appear title-cased in LinkedIn content but are NOT
 * person names.  Used to filter false positives from two-word name detection.
 *
 * Selection criteria \u2014 each word is included because it:
 *  1. Frequently appears capitalised (sentence starts, headings, titles)
 *  2. Is virtually never used as a given name or surname
 *
 * Words that double as real names (e.g. May, Grace, Will, Rose, Paris,
 * London, Sydney) are intentionally EXCLUDED to avoid masking genuine
 * name matches.
 */
const LIKELY_NAME_FALSE_POSITIVES: ReadonlySet<string> = new Set([
  // Function words (prepositions, conjunctions, determiners)
  "About", "Above", "Across", "After", "Against", "Along", "Among",
  "And", "Around", "Before", "Behind", "Below", "Beneath", "Beside",
  "Between", "Beyond", "Both", "But", "Despite", "Down", "During",
  "Each", "Either", "Else", "Every", "Except", "For", "From",
  "How", "Into", "Its", "Nor", "Not", "Off", "Onto", "Our",
  "Out", "Over", "Per", "Since", "Than", "That", "The",
  "Their", "Them", "Then", "There", "These", "This", "Those",
  "Through", "Throughout", "Too", "Toward", "Towards", "Under",
  "Until", "Upon", "Very", "What", "When", "Where", "Which",
  "While", "With", "Within", "Without", "Yet", "Your",

  // Pronouns and verb forms (excluding common given names like Will / May)
  "Are", "Been", "Being", "Could", "Did", "Does", "Got",
  "Had", "Has", "Have", "Having", "Her", "His", "Might",
  "Must", "Neither", "She", "Should", "Such", "They", "Was",
  "Were", "Who", "Whom", "Why", "Would", "You",

  // Adverbs and adjectives (never person names)
  "Also", "Already", "Always", "Any", "Ever", "Few", "Here",
  "However", "Indeed", "Just", "Like", "Many", "Meanwhile",
  "Moreover", "More", "Most", "Much", "Nevertheless", "Never",
  "New", "Next", "Now", "Often", "Old", "Only", "Other", "Own",
  "Perhaps", "Quite", "Rather", "Really", "Several", "Some",
  "Still", "Therefore", "Thus", "Today", "Tomorrow", "Truly",

  // Greetings and salutations
  "Dear", "Fellow", "Good", "Great", "Hello", "Hey", "Hi",

  // Professional and LinkedIn-specific terms
  "Based", "Building", "Certified", "Connecting", "Digital",
  "Driven", "Engineering", "Excited", "Global", "Growth",
  "Hiring", "Hybrid", "Industry", "Innovation", "Junior",
  "Leading", "Looking", "Management", "Marketing", "Open",
  "Passionate", "Product", "Professional", "Remote", "Seeking",
  "Senior", "Sustainable", "Thrilled", "Working",

  // Geographic names (extremely rarely used as person names)
  "Amsterdam", "Bangalore", "Bangkok", "Barcelona", "Beijing",
  "Berlin", "Brussels", "Budapest", "Copenhagen", "Delhi",
  "Dubai", "Dublin", "Edinburgh", "Frankfurt", "Hamburg",
  "Helsinki", "Istanbul", "Jakarta", "Johannesburg", "Lagos",
  "Lisbon", "Madrid", "Manchester", "Melbourne", "Montreal",
  "Moscow", "Mumbai", "Munich", "Nairobi", "Oslo", "Prague",
  "Riyadh", "Seoul", "Shanghai", "Singapore", "Stockholm",
  "Taipei", "Tokyo", "Toronto", "Vancouver", "Vienna",
  "Warsaw", "Zurich",

  // Contractions (common at sentence starts, never person names)
  "I've", "I'm", "I'll", "I'd",
  "We've", "We're", "We'll", "We'd",
  "They've", "They'll", "They'd",
  "You've", "You'll", "You'd",
  "He'd", "He'll",
  "She'd", "She'll",
  "It's", "It'll",
  "That's", "That'll",
  "What's", "Who's", "Where's", "When's", "How's",
  "There's", "Here's", "Let's",
  "Don't", "Can't", "Won't", "Isn't", "Aren't",
  "Wasn't", "Weren't", "Doesn't", "Didn't",
  "Haven't", "Hasn't", "Hadn't",
  "Couldn't", "Wouldn't", "Shouldn't", "Mightn't",

  // Compound words and indefinite pronouns (sentence starts)
  "Something", "Everything", "Nothing", "Anything",
  "Someone", "Everyone", "Anyone", "Somebody", "Everybody",
  "Anybody", "Somewhere", "Everywhere", "Anywhere",
  "Sometimes", "Another", "Whatever", "Whenever", "Wherever",
  "Whoever", "Ourselves", "Themselves", "Yourself", "Myself",

  // Common sentence-start words in professional writing
  "Because", "Although", "Whether", "Whereas", "Moreover",
  "Furthermore", "Regardless", "Alternatively", "Additionally",
  "Consequently", "Specifically", "Essentially", "Unfortunately",
  "Fortunately", "Apparently", "Obviously", "Certainly",
  "Absolutely", "Definitely", "Ultimately", "Previously",
  "Currently", "Recently", "Typically", "Generally",
  "Particularly", "Especially", "Importantly", "Interestingly",
  "Surprisingly", "Significantly", "Increasingly", "Successfully",
]);

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
  "vanity_name"
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

function objectLooksLikePerson(parent: Record<string, unknown> | undefined): boolean {
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

function objectLooksLikeInboxThread(parent: Record<string, unknown> | undefined): boolean {
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
  parent: Record<string, unknown> | undefined
): boolean {
  if (!parent) {
    return false;
  }

  return "timestamp" in parent && "is_read" in parent && "link" in parent;
}

function shouldHashNames(config: PrivacyConfig, surface: PrivacySurface): boolean {
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
  surface: PrivacySurface
): boolean {
  if (surface === "storage" || surface === "artifact") {
    return config.redactionMode === "full";
  }

  return config.redactionMode === "full";
}

function shouldUseExcerptMessageRedaction(
  config: PrivacyConfig,
  surface: PrivacySurface
): boolean {
  if (surface === "storage" || surface === "artifact") {
    return config.redactionMode === "partial" || config.storageMode === "excerpt";
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
  return value.replace(LINKEDIN_PROFILE_URL_PATTERN, (_, prefix: string, slug: string) => {
    return `${prefix}${redactProfileSlug(slug, config)}`;
  });
}

function redactEmails(value: string, config: PrivacyConfig): string {
  return value.replace(EMAIL_PATTERN, (email) => redactEmail(email, config));
}

/**
 * Returns true when every letter character in {@link word} is upper-case,
 * indicating an acronym (AI, CEO, ML\u2026) rather than a person name.
 */
function isAllUpperCase(word: string): boolean {
  return word.length >= 2 && word === word.toUpperCase();
}

/**
 * Returns true when a two-word candidate is very unlikely to be a real
 * person name.  A candidate is rejected when either word is:
 *
 *  - An all-caps token (likely an acronym: AI, CEO, ML\u2026)
 *  - A member of the {@link LIKELY_NAME_FALSE_POSITIVES} set
 */
function isLikelyFalsePositiveName(first: string, second: string): boolean {
  if (isAllUpperCase(first) || isAllUpperCase(second)) {
    return true;
  }

  return LIKELY_NAME_FALSE_POSITIVES.has(first) || LIKELY_NAME_FALSE_POSITIVES.has(second);
}

/**
 * Redact sequences of two consecutive capitalised words that look like
 * person names while skipping known false positives (acronyms, common
 * English words, city names, professional terms).
 *
 * When the first word of a candidate pair is a false positive it is skipped
 * and the algorithm tries to pair the second word with the *next*
 * capitalised word \u2014 so \u201cHello Jane Doe\u201d correctly redacts \u201cJane Doe\u201d.
 */
function redactLikelyFullNames(value: string, config: PrivacyConfig): string {
  // Collect every capitalised word with its position.
  const words: Array<{ word: string; start: number; end: number }> = [];
  const re = new RegExp(CAPITALIZED_WORD_PATTERN.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(value)) !== null) {
    words.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }

  // Greedily pair consecutive capitalised words separated by exactly one
  // space.  When the leading word is a known false-positive we skip it and
  // try pairing the trailing word with the next capitalised word instead.
  const pairs: Array<{ start: number; end: number; text: string }> = [];
  let i = 0;

  while (i < words.length - 1) {
    const a = words[i]!;
    const b = words[i + 1]!;

    // Only consider words separated by exactly one space.
    if (b.start - a.end !== 1 || value[a.end] !== " ") {
      i++;
      continue;
    }

    if (isLikelyFalsePositiveName(a.word, b.word)) {
      i++;
      continue;
    }

    pairs.push({ start: a.start, end: b.end, text: `${a.word} ${b.word}` });
    i += 2;
  }

  // Replace backwards so earlier indices remain stable.
  let result = value;

  for (let j = pairs.length - 1; j >= 0; j--) {
    const p = pairs[j]!;
    result = result.slice(0, p.start) + redactName(p.text, config) + result.slice(p.end);
  }

  return result;
}

function redactActionSummary(value: string, config: PrivacyConfig): string {
  const replacements = [
    {
      regex: /(Send message to )"([^"]+)"/,
      replacer: (prefix: string, subject: string) => `${prefix}"${redactName(subject, config)}"`
    },
    {
      regex: /(Send connection invitation to )(.+)$/,
      replacer: (prefix: string, subject: string) => `${prefix}${redactName(subject, config)}`
    },
    {
      regex: /(Accept connection invitation from )(.+)$/,
      replacer: (prefix: string, subject: string) => `${prefix}${redactName(subject, config)}`
    },
    {
      regex: /(Withdraw sent invitation to )(.+)$/,
      replacer: (prefix: string, subject: string) => `${prefix}${redactName(subject, config)}`
    }
  ] as const;

  let sanitized = value;

  for (const replacement of replacements) {
    sanitized = sanitized.replace(replacement.regex, (_, prefix: string, subject: string) => {
      return replacement.replacer(prefix, subject.trim());
    });
  }

  return sanitized;
}

export function redactFreeformText(value: string, config: PrivacyConfig): string {
  let sanitized = redactEmails(value, config);
  sanitized = redactProfileUrls(sanitized, config);
  sanitized = redactActionSummary(sanitized, config);
  sanitized = sanitized.replace(/(profile )"([^"]+)"/gi, (_, prefix: string, subject: string) => {
    return `${prefix}"${redactName(subject, config)}"`;
  });
  return sanitized;
}

function redactMessageText(
  value: string,
  config: PrivacyConfig,
  surface: PrivacySurface
): string {
  const sanitized = redactLikelyFullNames(redactFreeformText(value, config), config);
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

  const revealLength = Math.min(config.messageExcerptLength, originalLength - 1);
  const excerpt = sanitized.slice(0, revealLength);
  return `${excerpt}… [len=${originalLength} hash=${hash}]`;
}

function redactStringValue(value: string, context: RedactionContext): string {
  const key = normalizeKey(context.key);

  if (key === "summary" && shouldHashNames(context.config, context.surface)) {
    return redactActionSummary(redactFreeformText(value, context.config), context.config);
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

function redactUnknownValue(value: unknown, context: RedactionContext): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactUnknownValue(item, {
        ...context,
        key: String(index),
        path: [...context.path, String(index)]
      })
    );
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactUnknownValue(entryValue, {
        ...context,
        key: entryKey,
        path: [...context.path, entryKey],
        parent: value
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
  config: PrivacyConfig
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveCipherKey(confirmToken, config), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function unsealJsonRecord(
  sealedValue: string,
  confirmToken: string,
  config: PrivacyConfig
): Record<string, unknown> {
  const [version, ivEncoded, authTagEncoded, ciphertextEncoded] = sealedValue.split(".");
  if (
    version !== "v1" ||
    !ivEncoded ||
    !authTagEncoded ||
    !ciphertextEncoded
  ) {
    throw new Error("Invalid sealed JSON record format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveCipherKey(confirmToken, config),
    Buffer.from(ivEncoded, "base64url")
  );
  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final()
  ]).toString("utf8");

  const parsed = JSON.parse(decrypted) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Decrypted JSON record must be an object.");
  }

  return parsed;
}

export function createDefaultPrivacyConfig(
  env: EnvironmentMap = process.env
): PrivacyConfig {
  const redactionModeRaw = env.LINKEDIN_BUDDY_REDACTION_MODE?.trim().toLowerCase();
  const storageModeRaw = env.LINKEDIN_BUDDY_STORAGE_MODE?.trim().toLowerCase();
  const messageExcerptLengthRaw = Number.parseInt(
    env.LINKEDIN_BUDDY_MESSAGE_EXCERPT_LENGTH ?? "",
    10
  );

  return {
    redactionMode: redactionModeRaw && isPrivacyRedactionMode(redactionModeRaw)
      ? redactionModeRaw
      : "off",
    storageMode: storageModeRaw && isPrivacyStorageMode(storageModeRaw)
      ? storageModeRaw
      : "full",
    hashSalt: env.LINKEDIN_BUDDY_REDACTION_HASH_SALT ?? "",
    messageExcerptLength: clampExcerptLength(messageExcerptLengthRaw)
  };
}

export function resolvePrivacyConfig(
  overrides: Partial<PrivacyConfig> = {},
  env: EnvironmentMap = process.env
): PrivacyConfig {
  const defaults = createDefaultPrivacyConfig(env);

  return {
    redactionMode: overrides.redactionMode ?? defaults.redactionMode,
    storageMode: overrides.storageMode ?? defaults.storageMode,
    hashSalt: overrides.hashSalt ?? defaults.hashSalt,
    messageExcerptLength: clampExcerptLength(
      overrides.messageExcerptLength ?? defaults.messageExcerptLength
    )
  };
}

export function redactStructuredValue<T>(
  value: T,
  config: PrivacyConfig,
  surface: PrivacySurface
): T {
  return redactUnknownValue(value, {
    config,
    surface,
    path: []
  }) as T;
}
