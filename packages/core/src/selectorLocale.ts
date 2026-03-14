import { escapeRegExp, escapeCssAttributeValue } from "./shared.js";

const DEFAULT_SELECTOR_ATTRIBUTE_NAME = "aria-label";
const MAX_SELECTOR_LOCALE_INPUT_LENGTH = 64;
const SELECTOR_CACHE_KEY_SEPARATOR = "\u001f";
const VALID_SELECTOR_ATTRIBUTE_NAME_PATTERN = /^[a-z_][-a-z0-9_:.]*$/iu;
const VALID_SELECTOR_LOCALE_INPUT_PATTERN = /^[a-z0-9_-]+$/u;
const EMPTY_SELECTOR_PHRASES: readonly string[] = Object.freeze([] as string[]);

const selectorPhraseCache = new Map<string, readonly string[]>();
const selectorPhrasePatternCache = new Map<string, ResolvedSelectorPhrasePattern>();
const selectorPhraseRegexCache = new Map<string, RegExp>();

function normalizeUnicode(
  value: string,
  form: "NFC" | "NFD" | "NFKC" | "NFKD"
): string {
  return value.normalize(form);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizePhrase(value: string): string {
  return normalizeWhitespace(normalizeUnicode(value, "NFC"));
}

function normalizePhraseForComparison(value: string): string {
  return normalizeWhitespace(normalizeUnicode(value, "NFKC")).toLowerCase();
}

function normalizeLocaleInput(value: string): string {
  return normalizeUnicode(value, "NFKC").trim().toLowerCase();
}

function dedupePhrases(values: readonly unknown[]): string[] {
  const normalizedValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = normalizePhrase(value);
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalizePhraseForComparison(normalized);
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

function createSelectorPhraseCacheKey(parts: readonly string[]): string {
  return parts.join(SELECTOR_CACHE_KEY_SEPARATOR);
}

function normalizeSelectorRoots(roots: string | readonly string[]): string[] {
  const rawRoots = Array.isArray(roots) ? roots : [roots];
  const normalizedRoots: string[] = [];
  const seen = new Set<string>();

  for (const root of rawRoots) {
    if (typeof root !== "string") {
      continue;
    }

    const normalizedRoot = root.trim();
    if (!normalizedRoot || seen.has(normalizedRoot)) {
      continue;
    }

    seen.add(normalizedRoot);
    normalizedRoots.push(normalizedRoot);
  }

  return normalizedRoots;
}

function normalizeSelectorAttributeName(attributeName: string): string {
  const normalizedAttributeName = attributeName.trim();
  return VALID_SELECTOR_ATTRIBUTE_NAME_PATTERN.test(normalizedAttributeName)
    ? normalizedAttributeName
    : DEFAULT_SELECTOR_ATTRIBUTE_NAME;
}

function sanitizeSelectorPhrases(values: readonly unknown[] | undefined): string[] {
  return dedupePhrases(Array.isArray(values) ? values : EMPTY_SELECTOR_PHRASES);
}

/**
 * Selector locales with first-class phrase coverage.
 */
export const LINKEDIN_SELECTOR_LOCALES = ["en", "da"] as const;
export type LinkedInSelectorLocale =
  (typeof LINKEDIN_SELECTOR_LOCALES)[number];

/**
 * Default selector locale used when no explicit locale resolves successfully.
 */
export const DEFAULT_LINKEDIN_SELECTOR_LOCALE: LinkedInSelectorLocale = "en";

export type LinkedInSelectorPhraseKey =
  | "accept"
  | "add_comment"
  | "add_note"
  | "anyone"
  | "about"
  | "celebrate"
  | "close"
  | "comment"
  | "connect"
  | "connections"
  | "connections_only"
  | "decline"
  | "discard"
  | "dismiss"
  | "done"
  | "education"
  | "experience"
  | "follow"
  | "following"
  | "funny"
  | "ignore"
  | "insightful"
  | "invitation"
  | "invitation_sent"
  | "invite"
  | "leave"
  | "like"
  | "love"
  | "me"
  | "message"
  | "messaging"
  | "more"
  | "more_actions"
  | "notifications"
  | "open_to"
  | "pending"
  | "post"
  | "post_comment"
  | "post_settings"
  | "react"
  | "reaction"
  | "remove"
  | "remove_connection"
  | "repost"
  | "resources"
  | "respond"
  | "save"
  | "share"
  | "send"
  | "send_now"
  | "send_without_note"
  | "start_post"
  | "support"
  | "time_ago"
  | "unsave"
  | "unfollow"
  | "visibility"
  | "what_do_you_want_to_talk_about"
  | "who_can_see_your_post"
  | "withdraw"
  | "write_message";

type SelectorPhraseDictionary = Record<
  LinkedInSelectorPhraseKey,
  readonly unknown[]
>;

type SelectorPhraseOverrides = Partial<SelectorPhraseDictionary>;

const ENGLISH_SELECTOR_PHRASES: SelectorPhraseDictionary = {
  accept: ["Accept"],
  add_comment: ["Add a comment"],
  add_note: ["Add a note"],
  anyone: ["Anyone"],
  about: ["About"],
  celebrate: ["Celebrate"],
  close: ["Close"],
  comment: ["Comment"],
  connect: ["Connect"],
  connections: ["Connections"],
  connections_only: ["Connections only"],
  decline: ["Decline"],
  discard: ["Discard"],
  dismiss: ["Dismiss"],
  done: ["Done"],
  education: ["Education"],
  experience: ["Experience"],
  follow: ["Follow"],
  following: ["Following"],
  funny: ["Funny"],
  ignore: ["Ignore"],
  insightful: ["Insightful"],
  invitation: ["Invitation"],
  invitation_sent: ["Invitation sent"],
  invite: ["Invite"],
  leave: ["Leave"],
  like: ["Like"],
  love: ["Love"],
  me: ["Me"],
  message: ["Message"],
  messaging: ["Messaging", "Messages"],
  more: ["More"],
  more_actions: ["More actions"],
  notifications: ["Notifications"],
  open_to: ["Open to"],
  pending: ["Pending"],
  post: ["Post"],
  post_comment: ["Post comment"],
  post_settings: ["Post settings"],
  react: ["React"],
  reaction: ["Reaction", "Reactions"],
  remove: ["Remove"],
  remove_connection: ["Remove connection"],
  repost: ["Repost"],
  resources: ["Resources"],
  respond: ["Respond"],
  save: ["Save"],
  share: ["Share"],
  send: ["Send"],
  send_now: ["Send now"],
  send_without_note: ["Send without a note"],
  start_post: ["Start a post"],
  support: ["Support"],
  time_ago: ["ago"],
  unsave: ["Unsave"],
  unfollow: ["Unfollow"],
  visibility: ["Visibility"],
  what_do_you_want_to_talk_about: ["What do you want to talk about?"],
  who_can_see_your_post: ["Who can see your post?"],
  withdraw: ["Withdraw"],
  write_message: ["Write a message"]
};

const DANISH_SELECTOR_PHRASE_OVERRIDES: SelectorPhraseOverrides = {
  accept: ["Accepter"],
  add_comment: ["Tilføj en kommentar", "Skriv en kommentar"],
  add_note: ["Tilføj en note", "Tilføj en bemærkning"],
  anyone: ["Alle"],
  about: ["Om"],
  celebrate: ["Fejr"],
  close: ["Luk"],
  comment: ["Kommenter", "Kommentar"],
  connect: ["Opret forbindelse", "Forbind"],
  connections: ["Forbindelser"],
  connections_only: ["Kun forbindelser"],
  decline: ["Afvis"],
  discard: ["Kassér", "Fjern"],
  dismiss: ["Luk"],
  done: ["Færdig", "Udført"],
  education: ["Uddannelse"],
  experience: ["Erfaring"],
  follow: ["Følg"],
  following: ["Følger"],
  funny: ["Sjov"],
  ignore: ["Ignorer"],
  insightful: ["Indsigtsfuld", "Indsigt"],
  invitation: ["Invitation", "Invitering"],
  invitation_sent: ["Invitation sendt"],
  invite: ["Inviter"],
  leave: ["Forlad"],
  like: ["Synes godt om"],
  love: ["Elsker"],
  me: ["Mig"],
  message: ["Besked", "Meddelelse"],
  messaging: ["Beskeder"],
  more: ["Mere"],
  more_actions: ["Flere handlinger", "Mere"],
  notifications: ["Notifikationer", "Meddelelser"],
  open_to: ["Åben for", "Åben over for"],
  pending: ["Afventer"],
  post: ["Slå op", "Opslag"],
  post_comment: ["Slå kommentar op", "Send kommentar"],
  post_settings: ["Opslagsindstillinger", "Indstillinger for opslag"],
  react: ["Reager"],
  reaction: ["Reaktion", "Reaktioner"],
  remove: ["Fjern"],
  remove_connection: ["Fjern forbindelse", "Fjern kontakt"],
  resources: ["Ressourcer"],
  respond: ["Svar"],
  save: ["Gem"],
  send_now: ["Send nu"],
  send_without_note: ["Send uden note", "Send uden en note"],
  start_post: ["Start et opslag", "Start et indlæg"],
  support: ["Støt", "Støtter"],
  time_ago: ["siden"],
  unfollow: ["Følg ikke længere", "Stop med at følge"],
  visibility: ["Synlighed"],
  what_do_you_want_to_talk_about: [
    "Hvad vil du tale om?",
    "Hvad vil du skrive om?"
  ],
  who_can_see_your_post: ["Hvem kan se dit opslag?"],
  withdraw: ["Træk tilbage", "Tilbagetræk"],
  write_message: ["Skriv en besked", "Skriv en meddelelse"]
};

const LINKEDIN_SELECTOR_PHRASE_OVERRIDES: Record<
  LinkedInSelectorLocale,
  SelectorPhraseOverrides
> = {
  en: {},
  da: DANISH_SELECTOR_PHRASE_OVERRIDES
};

const LINKEDIN_SELECTOR_LOCALE_SET = new Set<LinkedInSelectorLocale>(
  LINKEDIN_SELECTOR_LOCALES
);

const LINKEDIN_SELECTOR_PHRASE_KEY_SET = new Set<LinkedInSelectorPhraseKey>(
  Object.keys(ENGLISH_SELECTOR_PHRASES) as LinkedInSelectorPhraseKey[]
);

export type LinkedInSelectorLocaleFallbackReason =
  | "blank"
  | "invalid_format"
  | "unsupported_locale"
  | "too_long";

/**
 * Diagnostics for resolving arbitrary locale input onto a supported selector
 * locale.
 */
export interface LinkedInSelectorLocaleResolution {
  locale: LinkedInSelectorLocale;
  inputProvided: boolean;
  normalizedInput?: string;
  inputLength?: number;
  fallbackUsed: boolean;
  fallbackReason?: LinkedInSelectorLocaleFallbackReason;
}

function isLinkedInSelectorLocale(
  value: string
): value is LinkedInSelectorLocale {
  return LINKEDIN_SELECTOR_LOCALE_SET.has(value as LinkedInSelectorLocale);
}

function isLinkedInSelectorPhraseKey(
  value: unknown
): value is LinkedInSelectorPhraseKey {
  return (
    typeof value === "string" &&
    LINKEDIN_SELECTOR_PHRASE_KEY_SET.has(value as LinkedInSelectorPhraseKey)
  );
}

function getEnglishSelectorPhrases(
  key: LinkedInSelectorPhraseKey
): readonly string[] {
  return sanitizeSelectorPhrases(ENGLISH_SELECTOR_PHRASES[key]);
}

function getLocaleOverrideSelectorPhrases(
  key: LinkedInSelectorPhraseKey,
  locale: LinkedInSelectorLocale
): readonly string[] {
  return sanitizeSelectorPhrases(
    locale === "en"
      ? undefined
      : LINKEDIN_SELECTOR_PHRASE_OVERRIDES[locale]?.[key]
  );
}

function getPrimaryLinkedInSelectorPhrases(
  key: LinkedInSelectorPhraseKey,
  locale: LinkedInSelectorLocale
): readonly string[] {
  if (locale === "en") {
    return getEnglishSelectorPhrases(key);
  }

  const localePhrases = getLocaleOverrideSelectorPhrases(key, locale);
  return localePhrases.length > 0 ? localePhrases : getEnglishSelectorPhrases(key);
}

function buildLinkedInSelectorLocaleResolution(
  locale: LinkedInSelectorLocale,
  options: Omit<LinkedInSelectorLocaleResolution, "locale">
): LinkedInSelectorLocaleResolution {
  return {
    locale,
    ...options
  };
}

/**
 * Resolves arbitrary locale input to the nearest supported selector locale.
 *
 * @remarks
 * Region tags such as `da-DK` normalize to their supported base locale.
 * Unsupported, malformed, blank, or overly long values fall back to the
 * provided fallback locale.
 */
export function resolveLinkedInSelectorLocaleResolution(
  value: string | LinkedInSelectorLocale | undefined,
  fallback: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE
): LinkedInSelectorLocaleResolution {
  if (typeof value !== "string") {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: false,
      fallbackUsed: false
    });
  }

  const normalized = normalizeLocaleInput(value);
  const normalizedInput = normalized.slice(0, MAX_SELECTOR_LOCALE_INPUT_LENGTH);
  const inputLength = normalized.length;

  if (!normalized) {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: true,
      normalizedInput,
      inputLength,
      fallbackUsed: true,
      fallbackReason: "blank"
    });
  }

  if (inputLength > MAX_SELECTOR_LOCALE_INPUT_LENGTH) {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: true,
      normalizedInput,
      inputLength,
      fallbackUsed: true,
      fallbackReason: "too_long"
    });
  }

  if (!VALID_SELECTOR_LOCALE_INPUT_PATTERN.test(normalized)) {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: true,
      normalizedInput,
      inputLength,
      fallbackUsed: true,
      fallbackReason: "invalid_format"
    });
  }

  const [baseLocale = ""] = normalized.split(/[-_]/u);
  if (!/^[a-z]{2,3}$/u.test(baseLocale)) {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: true,
      normalizedInput,
      inputLength,
      fallbackUsed: true,
      fallbackReason: "invalid_format"
    });
  }

  if (!isLinkedInSelectorLocale(baseLocale)) {
    return buildLinkedInSelectorLocaleResolution(fallback, {
      inputProvided: true,
      normalizedInput,
      inputLength,
      fallbackUsed: true,
      fallbackReason: "unsupported_locale"
    });
  }

  return buildLinkedInSelectorLocaleResolution(baseLocale, {
    inputProvided: true,
    normalizedInput,
    inputLength,
    fallbackUsed: false
  });
}

/**
 * Convenience wrapper that returns only the resolved selector locale.
 */
export function resolveLinkedInSelectorLocale(
  value: string | LinkedInSelectorLocale | undefined,
  fallback: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE
): LinkedInSelectorLocale {
  return resolveLinkedInSelectorLocaleResolution(value, fallback).locale;
}

interface SelectorPhraseOptions {
  includeEnglishFallback?: boolean;
}

interface SelectorRegexOptions extends SelectorPhraseOptions {
  exact?: boolean;
}

interface ResolvedSelectorPhrasePattern {
  phrases: readonly string[];
  body: string;
}

function createSelectorPhraseOptionsKey(
  options: SelectorPhraseOptions | SelectorRegexOptions
): readonly string[] {
  const includeEnglishFallback = options.includeEnglishFallback ?? true;
  const optionParts = [includeEnglishFallback ? "with-en" : "no-en"];

  if ("exact" in options) {
    optionParts.push(options.exact ? "exact" : "contains");
  }

  return optionParts;
}

function createSelectorPhraseCombinationCacheKey(
  cachePrefix: string,
  locale: LinkedInSelectorLocale,
  normalizedKeys: readonly LinkedInSelectorPhraseKey[],
  options: SelectorPhraseOptions | SelectorRegexOptions = {}
): string {
  return createSelectorPhraseCacheKey([
    cachePrefix,
    locale,
    ...createSelectorPhraseOptionsKey(options),
    ...normalizedKeys
  ]);
}

function normalizePhraseKeys(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[]
): LinkedInSelectorPhraseKey[] {
  const rawKeys = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [];
  const normalizedKeys: LinkedInSelectorPhraseKey[] = [];
  const seen = new Set<LinkedInSelectorPhraseKey>();

  for (const key of rawKeys) {
    if (!isLinkedInSelectorPhraseKey(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedKeys.push(key);
  }

  return normalizedKeys;
}

function getLinkedInSelectorPhrasesFromNormalizedKeys(
  normalizedKeys: readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): readonly string[] {
  if (normalizedKeys.length === 0) {
    return EMPTY_SELECTOR_PHRASES;
  }

  const cacheKey = createSelectorPhraseCombinationCacheKey(
    "phrases",
    locale,
    normalizedKeys,
    options
  );
  const cachedPhrases = selectorPhraseCache.get(cacheKey);
  if (cachedPhrases) {
    return cachedPhrases;
  }

  const includeEnglishFallback = options.includeEnglishFallback ?? true;
  const primaryValues = normalizedKeys.flatMap((key) =>
    getPrimaryLinkedInSelectorPhrases(key, locale)
  );

  const phrases =
    !includeEnglishFallback || locale === "en"
      ? dedupePhrases(primaryValues)
      : dedupePhrases([
          ...primaryValues,
          ...normalizedKeys.flatMap((key) => getEnglishSelectorPhrases(key))
        ]);

  const frozenPhrases = Object.freeze(phrases);
  selectorPhraseCache.set(cacheKey, frozenPhrases);
  return frozenPhrases;
}

function resolveLinkedInSelectorPhrasePattern(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): ResolvedSelectorPhrasePattern {
  const normalizedKeys = normalizePhraseKeys(keys);
  const cacheKey = createSelectorPhraseCombinationCacheKey(
    "pattern",
    locale,
    normalizedKeys,
    options
  );
  const cachedPattern = selectorPhrasePatternCache.get(cacheKey);
  if (cachedPattern) {
    return cachedPattern;
  }

  const phrases = getLinkedInSelectorPhrasesFromNormalizedKeys(
    normalizedKeys,
    locale,
    options
  );
  const pattern = {
    phrases,
    body: phrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$"
  };
  selectorPhrasePatternCache.set(cacheKey, pattern);
  return pattern;
}

/**
 * Returns localized selector phrases in locale-first order with optional
 * English fallback phrases appended afterward.
 */
export function getLinkedInSelectorPhrases(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): string[] {
  const normalizedKeys = normalizePhraseKeys(keys);
  return [...getLinkedInSelectorPhrasesFromNormalizedKeys(normalizedKeys, locale, options)];
}

/**
 * Builds a Unicode-aware regular expression that matches the localized selector
 * phrases for the requested semantic key or keys.
 */
export function buildLinkedInSelectorPhraseRegex(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorRegexOptions = {}
): RegExp {
  const normalizedKeys = normalizePhraseKeys(keys);
  const cacheKey = createSelectorPhraseCombinationCacheKey(
    "regex",
    locale,
    normalizedKeys,
    options
  );
  const cachedRegex = selectorPhraseRegexCache.get(cacheKey);
  if (cachedRegex) {
    return cachedRegex;
  }

  const { body } = resolveLinkedInSelectorPhrasePattern(
    normalizedKeys,
    locale,
    options
  );
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  const regex = new RegExp(pattern, "iu");
  selectorPhraseRegexCache.set(cacheKey, regex);
  return regex;
}

/**
 * Formats the phrase regex that would be used for a selector key in diagnostic
 * output such as selector audit hints.
 */
export function formatLinkedInSelectorRegexHint(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorRegexOptions = {}
): string {
  const { body } = resolveLinkedInSelectorPhrasePattern(keys, locale, options);
  return options.exact ? `/^(?:${body})$/iu` : `/${body}/iu`;
}

/**
 * Builds a comma-joined CSS selector that matches localized attribute values on
 * one or more selector roots.
 */
export function buildLinkedInAriaLabelContainsSelector(
  roots: string | readonly string[],
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  attributeName: string = DEFAULT_SELECTOR_ATTRIBUTE_NAME,
  options: SelectorPhraseOptions = {}
): string {
  const selectors = normalizeSelectorRoots(roots);
  const normalizedAttributeName = normalizeSelectorAttributeName(attributeName);
  const normalizedKeys = normalizePhraseKeys(keys);
  if (selectors.length === 0 || normalizedKeys.length === 0) {
    return "";
  }

  const phrases = getLinkedInSelectorPhrasesFromNormalizedKeys(
    normalizedKeys,
    locale,
    options
  );

  return selectors
    .flatMap((root) =>
      phrases.map(
        (phrase) =>
          `${root}[${normalizedAttributeName}*="${escapeCssAttributeValue(phrase)}" i]`
      )
    )
    .join(", ");
}

/**
 * Checks whether a text value contains any localized selector phrase for the
 * requested semantic key or keys.
 */
export function valueContainsLinkedInSelectorPhrase(
  value: string | null | undefined,
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): boolean {
  const normalizedValue = normalizePhraseForComparison(value ?? "");
  if (!normalizedValue) {
    return false;
  }

  const normalizedKeys = normalizePhraseKeys(keys);
  if (normalizedKeys.length === 0) {
    return false;
  }

  return getLinkedInSelectorPhrasesFromNormalizedKeys(
    normalizedKeys,
    locale,
    options
  ).some((phrase) => normalizedValue.includes(normalizePhraseForComparison(phrase)));
}
