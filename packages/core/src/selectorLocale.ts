function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupePhrases(values: readonly string[]): string[] {
  const normalizedValues: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizePhrase(value);
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedValues.push(normalized);
  }

  return normalizedValues;
}

export const LINKEDIN_SELECTOR_LOCALES = ["en", "da"] as const;
export type LinkedInSelectorLocale =
  (typeof LINKEDIN_SELECTOR_LOCALES)[number];

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
  | "remove_connection"
  | "resources"
  | "respond"
  | "save"
  | "send"
  | "send_without_note"
  | "start_post"
  | "support"
  | "time_ago"
  | "visibility"
  | "what_do_you_want_to_talk_about"
  | "who_can_see_your_post"
  | "withdraw"
  | "write_message";

type SelectorPhraseDictionary = Record<
  LinkedInSelectorPhraseKey,
  readonly string[]
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
  remove_connection: ["Remove connection"],
  resources: ["Resources"],
  respond: ["Respond"],
  save: ["Save"],
  send: ["Send"],
  send_without_note: ["Send without a note"],
  start_post: ["Start a post"],
  support: ["Support"],
  time_ago: ["ago"],
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
  remove_connection: ["Fjern forbindelse", "Fjern kontakt"],
  resources: ["Ressourcer"],
  respond: ["Svar"],
  save: ["Gem"],
  send_without_note: ["Send uden note", "Send uden en note"],
  start_post: ["Start et opslag", "Start et indlæg"],
  support: ["Støt", "Støtter"],
  time_ago: ["siden"],
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

function isLinkedInSelectorLocale(
  value: string
): value is LinkedInSelectorLocale {
  return LINKEDIN_SELECTOR_LOCALE_SET.has(value as LinkedInSelectorLocale);
}

function getPrimaryLinkedInSelectorPhrases(
  key: LinkedInSelectorPhraseKey,
  locale: LinkedInSelectorLocale
): readonly string[] {
  if (locale === "en") {
    return ENGLISH_SELECTOR_PHRASES[key];
  }

  return (
    LINKEDIN_SELECTOR_PHRASE_OVERRIDES[locale][key] ??
    ENGLISH_SELECTOR_PHRASES[key]
  );
}

export function resolveLinkedInSelectorLocale(
  value: string | LinkedInSelectorLocale | undefined,
  fallback: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE
): LinkedInSelectorLocale {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const [baseLocale = ""] = normalized.split(/[-_]/u);
  return isLinkedInSelectorLocale(baseLocale) ? baseLocale : fallback;
}

interface SelectorPhraseOptions {
  includeEnglishFallback?: boolean;
}

interface SelectorRegexOptions extends SelectorPhraseOptions {
  exact?: boolean;
}

interface ResolvedSelectorPhrasePattern {
  phrases: string[];
  body: string;
}

function normalizePhraseKeys(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[]
): LinkedInSelectorPhraseKey[] {
  return typeof keys === "string" ? [keys] : [...keys];
}

function resolveLinkedInSelectorPhrasePattern(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): ResolvedSelectorPhrasePattern {
  const phrases = getLinkedInSelectorPhrases(keys, locale, options);
  return {
    phrases,
    body: phrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$"
  };
}

export function getLinkedInSelectorPhrases(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): string[] {
  const includeEnglishFallback = options.includeEnglishFallback ?? true;
  const normalizedKeys = normalizePhraseKeys(keys);

  const primaryValues = normalizedKeys.flatMap((key) =>
    getPrimaryLinkedInSelectorPhrases(key, locale)
  );

  if (!includeEnglishFallback || locale === "en") {
    return dedupePhrases(primaryValues);
  }

  const englishValues = normalizedKeys.flatMap((key) => ENGLISH_SELECTOR_PHRASES[key]);
  return dedupePhrases([...primaryValues, ...englishValues]);
}

export function buildLinkedInSelectorPhraseRegex(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorRegexOptions = {}
): RegExp {
  const { body } = resolveLinkedInSelectorPhrasePattern(keys, locale, options);
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "i");
}

export function formatLinkedInSelectorRegexHint(
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorRegexOptions = {}
): string {
  const { body } = resolveLinkedInSelectorPhrasePattern(keys, locale, options);
  return options.exact ? `/^(?:${body})$/i` : `/${body}/i`;
}

export function buildLinkedInAriaLabelContainsSelector(
  roots: string | readonly string[],
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  attributeName: string = "aria-label",
  options: SelectorPhraseOptions = {}
): string {
  const selectors = Array.isArray(roots) ? roots : [roots];
  const { phrases } = resolveLinkedInSelectorPhrasePattern(keys, locale, options);

  return selectors
    .flatMap((root) =>
      phrases.map(
        (phrase) => `${root}[${attributeName}*="${escapeCssAttributeValue(phrase)}" i]`
      )
    )
    .join(", ");
}

export function valueContainsLinkedInSelectorPhrase(
  value: string | null | undefined,
  keys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[],
  locale: LinkedInSelectorLocale,
  options: SelectorPhraseOptions = {}
): boolean {
  const normalizedValue = normalizePhrase(value ?? "").toLowerCase();
  if (!normalizedValue) {
    return false;
  }

  return getLinkedInSelectorPhrases(keys, locale, options).some((phrase) =>
    normalizedValue.includes(phrase.toLowerCase())
  );
}
