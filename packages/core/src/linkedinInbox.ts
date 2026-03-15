import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  errors as playwrightErrors,
  type Locator,
  type Page,
  type Response
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import type { AssistantDatabase } from "./db/database.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import {
  normalizeText,
  getOrCreatePage,
  escapeRegExp,
  isAbsoluteUrl
} from "./shared.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl,
  type LinkedInProfile,
  type LinkedInProfileService
} from "./linkedinProfile.js";
import {
  LINKEDIN_FEED_REACTION_TYPES,
  normalizeLinkedInFeedReaction,
  type LinkedInFeedReaction
} from "./linkedinFeed.js";
import type { LinkedInSearchResult, LinkedInSearchService } from "./linkedinSearch.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  createPrepareRateLimitMessage,
  peekRateLimitOrThrow,
  formatRateLimitState
} from "./rateLimiter.js";
import type {
  ConsumeRateLimitInput,
  RateLimiter
} from "./rateLimiter.js";
import type {
  LinkedInSelectorLocale,
  LinkedInSelectorPhraseKey
} from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  valueContainsLinkedInSelectorPhrase
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorRegistry,
  ActionExecutorResult,
  PreparedAction,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const MAX_RECIPIENTS_PER_ACTION = 10;
export const SEND_MESSAGE_ACTION_TYPE = "send_message";
export const SEND_NEW_THREAD_ACTION_TYPE = "inbox.send_new_thread";
export const ADD_RECIPIENTS_ACTION_TYPE = "inbox.add_recipients";
export const REACT_MESSAGE_ACTION_TYPE = "inbox.react";
export const ARCHIVE_THREAD_ACTION_TYPE = "inbox.archive_thread";
export const UNARCHIVE_THREAD_ACTION_TYPE = "inbox.unarchive_thread";
export const MARK_UNREAD_ACTION_TYPE = "inbox.mark_unread";
export const MUTE_THREAD_ACTION_TYPE = "inbox.mute_thread";
export const SEND_MESSAGE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.send_message",
  windowSizeMs: 60 * 60 * 1000,
  limit: 10
} as const;
export const ADD_RECIPIENTS_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.add_recipients",
  windowSizeMs: 60 * 60 * 1000,
  limit: 10
} as const;
export const REACT_MESSAGE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.react",
  windowSizeMs: 60 * 60 * 1000,
  limit: 60
} as const;
export const ARCHIVE_THREAD_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.archive_thread",
  windowSizeMs: 60 * 60 * 1000,
  limit: 60
} as const;
export const UNARCHIVE_THREAD_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.unarchive_thread",
  windowSizeMs: 60 * 60 * 1000,
  limit: 60
} as const;
export const MARK_UNREAD_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.mark_unread",
  windowSizeMs: 60 * 60 * 1000,
  limit: 60
} as const;
export const MUTE_THREAD_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.mute_thread",
  windowSizeMs: 60 * 60 * 1000,
  limit: 60
} as const;

export const LINKEDIN_INBOX_REACTION_TYPES = LINKEDIN_FEED_REACTION_TYPES;
export type LinkedInInboxReaction = LinkedInFeedReaction;

interface ThreadSnapshot {
  thread_id: string;
  title: string;
  unread_count: number;
  snippet: string;
  thread_url: string;
}

interface ThreadMessageSnapshot {
  author: string;
  sent_at: string | null;
  text: string;
}

interface ThreadDetailSnapshot extends ThreadSnapshot {
  messages: ThreadMessageSnapshot[];
}

interface MessengerConversationsPayload {
  data?: {
    messengerConversationsBySyncToken?: {
      elements?: unknown[];
    };
  };
}

interface MessengerMessagesPayload {
  data?: {
    messengerMessagesBySyncToken?: {
      elements?: unknown[];
    };
  };
}

interface SelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

type LocalizedInboxPhraseKey =
  | "add_reaction"
  | "add_people"
  | "archive_thread"
  | "finalize_recipients"
  | "mark_read"
  | "mark_unread"
  | "mute_conversation"
  | "new_message"
  | "type_a_name"
  | "unarchive_thread"
  | "unmute_conversation";

const LOCALIZED_INBOX_PHRASES: Record<
  LinkedInSelectorLocale,
  Record<LocalizedInboxPhraseKey, readonly string[]>
> = {
  en: {
    add_reaction: ["Add a reaction", "React", "Reaction"],
    add_people: [
      "Add people",
      "Add participants",
      "Add recipients",
      "Create group",
      "Create group conversation"
    ],
    archive_thread: ["Archive", "Move to archive"],
    finalize_recipients: ["Done", "Create", "Add", "Next"],
    mark_read: ["Mark as read", "Read"],
    mark_unread: ["Mark as unread", "Unread"],
    mute_conversation: ["Mute", "Mute conversation", "Mute thread"],
    new_message: ["New message", "Compose message", "Compose"],
    type_a_name: [
      "Type a name",
      "Type a name or names",
      "Type a name or multiple names"
    ],
    unarchive_thread: ["Unarchive", "Move to inbox", "Return to inbox"],
    unmute_conversation: [
      "Unmute",
      "Unmute conversation",
      "Unmute thread"
    ]
  },
  da: {
    add_reaction: ["Tilføj en reaktion", "Reager", "Reaktion"],
    add_people: [
      "Tilføj personer",
      "Tilføj deltagere",
      "Tilføj modtagere",
      "Opret gruppe",
      "Opret gruppesamtale"
    ],
    archive_thread: ["Arkiver", "Arkivér", "Flyt til arkiv"],
    finalize_recipients: ["Færdig", "Opret", "Tilføj", "Næste"],
    mark_read: ["Markér som læst", "Læst"],
    mark_unread: ["Markér som ulæst", "Ulæst"],
    mute_conversation: [
      "Slå samtale fra",
      "Slå lyd fra",
      "Dæmp samtale"
    ],
    new_message: ["Ny besked", "Ny meddelelse", "Skriv besked"],
    type_a_name: [
      "Skriv et navn",
      "Skriv et navn eller flere navne",
      "Indtast et navn"
    ],
    unarchive_thread: ["Flyt til indbakke", "Fjern fra arkiv"],
    unmute_conversation: [
      "Slå lyd til",
      "Slå samtale til",
      "Fjern dæmpning"
    ]
  }
};

export interface LinkedInThreadSummary {
  thread_id: string;
  title: string;
  unread_count: number;
  snippet: string;
  thread_url: string;
}

export interface LinkedInThreadMessage {
  author: string;
  sent_at: string | null;
  text: string;
}

export interface LinkedInThreadDetail {
  thread_id: string;
  title: string;
  unread_count: number;
  snippet: string;
  thread_url: string;
  messages: LinkedInThreadMessage[];
}

export interface LinkedInInboxRecipient {
  full_name: string;
  headline: string;
  location: string;
  profile_url: string;
  vanity_name: string | null;
  connection_degree: string;
  mutual_connections: string;
}

export interface ListThreadsInput {
  profileName?: string;
  limit?: number;
  unreadOnly?: boolean;
}

export interface GetThreadInput {
  profileName?: string;
  thread: string;
  limit?: number;
}

export interface PrepareReplyInput {
  profileName?: string;
  thread: string;
  text: string;
  operatorNote?: string;
}

export interface SearchRecipientsInput {
  profileName?: string;
  query: string;
  limit?: number;
}

export interface SearchRecipientsResult {
  query: string;
  count: number;
  recipients: LinkedInInboxRecipient[];
}

export interface PrepareNewThreadInput {
  profileName?: string;
  recipients: string[];
  text: string;
  operatorNote?: string;
}

export interface PrepareAddRecipientsInput {
  profileName?: string;
  thread: string;
  recipients: string[];
  operatorNote?: string;
}

export interface PrepareReactInput {
  profileName?: string;
  thread: string;
  reaction?: LinkedInInboxReaction | string;
  messageIndex?: number;
  operatorNote?: string;
}

export interface ThreadActionInput {
  profileName?: string;
  thread: string;
}

export interface PrepareReplyResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
}

export type PrepareNewThreadResult = PrepareReplyResult;
export type PrepareAddRecipientsResult = PrepareReplyResult;
export type PrepareReactResult = PrepareReplyResult;

export interface LinkedInThreadMessageTarget {
  index: number;
  author: string;
  sent_at: string | null;
  text: string;
}

export interface ArchiveThreadResult {
  archived: true;
  thread_id: string;
  thread_url: string;
  artifacts: string[];
  rate_limit: Record<string, number | boolean | string>;
}

export interface UnarchiveThreadResult {
  unarchived: true;
  thread_id: string;
  thread_url: string;
  artifacts: string[];
  rate_limit: Record<string, number | boolean | string>;
}

export interface MarkUnreadResult {
  marked_unread: true;
  thread_id: string;
  thread_url: string;
  artifacts: string[];
  rate_limit: Record<string, number | boolean | string>;
}

export interface MuteThreadResult {
  muted: true;
  thread_id: string;
  thread_url: string;
  artifacts: string[];
  rate_limit: Record<string, number | boolean | string>;
}

export interface LinkedInMessagingRuntime {
  runId: string;
  db: AssistantDatabase;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
}

export interface LinkedInInboxRuntime extends LinkedInMessagingRuntime {
  profile: Pick<LinkedInProfileService, "viewProfile">;
  search: Pick<LinkedInSearchService, "search">;
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInMessagingRuntime>, "prepare">;
}

function parseThreadIdFromUrl(url: string): string | null {
  const match = /\/messaging\/thread\/([^/?#]+)/.exec(url);
  const encodedThreadId = match?.[1];
  return encodedThreadId ? decodeURIComponent(encodedThreadId) : null;
}

function parseThreadIdFromConversationUrn(conversationUrn: string): string | null {
  const match = /urn:li:msg_conversation:\(urn:li:[^,]+,([^)]+)\)/.exec(
    conversationUrn
  );
  const encodedThreadId = match?.[1];
  if (!encodedThreadId) {
    return null;
  }

  try {
    return decodeURIComponent(encodedThreadId);
  } catch {
    return encodedThreadId;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStringValue(value: unknown): string {
  return typeof value === "string" ? normalizeText(value) : "";
}

function getAttributedText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const text = record.text;
  return typeof text === "string" ? normalizeText(text) : "";
}

function extractThreadTitleFromConversation(
  conversation: Record<string, unknown>
): string {
  const participantsValue = conversation.conversationParticipants;
  if (!Array.isArray(participantsValue)) {
    return "";
  }

  const participantNames: string[] = [];
  for (const participantValue of participantsValue) {
    const participant = asRecord(participantValue);
    const participantType = asRecord(participant?.participantType);
    const member = asRecord(participantType?.member);
    const firstName = getAttributedText(member?.firstName);
    const lastName = getAttributedText(member?.lastName);
    const fullName = normalizeText([firstName, lastName].filter(Boolean).join(" "));
    if (!fullName) {
      continue;
    }

    const distance = getStringValue(member?.distance).toUpperCase();
    if (distance === "SELF") {
      continue;
    }

    participantNames.push(fullName);
  }

  if (participantNames.length > 0) {
    return participantNames.join(", ");
  }

  return "";
}

function extractThreadSnippetFromConversation(
  conversation: Record<string, unknown>
): string {
  const messages = asRecord(conversation.messages);
  const messageElements = messages?.elements;
  if (Array.isArray(messageElements)) {
    for (const messageValue of messageElements) {
      const message = asRecord(messageValue);
      if (!message) {
        continue;
      }

      const snippetCandidates = [
        getAttributedText(message.body),
        getAttributedText(message.subject),
        getStringValue(message.renderContentFallbackText),
        getAttributedText(message.footer)
      ];

      for (const candidate of snippetCandidates) {
        if (candidate) {
          return candidate;
        }
      }
    }
  }

  return "";
}

function parseThreadSummariesFromMessengerConversationsPayload(
  payload: MessengerConversationsPayload
): ThreadSnapshot[] {
  const elements = payload.data?.messengerConversationsBySyncToken?.elements;
  if (!Array.isArray(elements)) {
    return [];
  }

  const byUrl = new Map<string, ThreadSnapshot>();
  for (const elementValue of elements) {
    const conversation = asRecord(elementValue);
    if (!conversation) {
      continue;
    }

    const conversationUrl = getStringValue(conversation.conversationUrl);
    const conversationUrn =
      getStringValue(conversation.entityUrn) ||
      getStringValue(conversation.backendUrn);
    const threadId =
      (conversationUrl ? parseThreadIdFromUrl(conversationUrl) : null) ??
      (conversationUrn
        ? parseThreadIdFromConversationUrn(conversationUrn)
        : null);

    if (!threadId && !conversationUrl) {
      continue;
    }

    const threadUrl =
      conversationUrl ||
      `https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId!)}/`;

    const unreadRaw = conversation.unreadCount;
    const unreadCount =
      typeof unreadRaw === "number" && Number.isFinite(unreadRaw) && unreadRaw >= 0
        ? Math.trunc(unreadRaw)
        : 0;

    const title =
      getAttributedText(conversation.title) ||
      getAttributedText(conversation.headlineText) ||
      getAttributedText(conversation.shortHeadlineText) ||
      extractThreadTitleFromConversation(conversation);

    const snippet =
      getAttributedText(conversation.descriptionText) ||
      extractThreadSnippetFromConversation(conversation);

    if (byUrl.has(threadUrl)) {
      continue;
    }

    byUrl.set(threadUrl, {
      thread_id: threadId ?? threadUrl,
      title,
      unread_count: unreadCount,
      snippet,
      thread_url: threadUrl
    });
  }

  return Array.from(byUrl.values());
}

function getNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractAuthorFromMessage(
  message: Record<string, unknown>
): string {
  const actor = asRecord(message.actor);
  const actorType = asRecord(actor?.participantType);
  const actorMember = asRecord(actorType?.member);
  const actorFirst = getAttributedText(actorMember?.firstName);
  const actorLast = getAttributedText(actorMember?.lastName);
  const actorName = normalizeText([actorFirst, actorLast].filter(Boolean).join(" "));
  if (actorName) {
    return actorName;
  }

  const sender = asRecord(message.sender);
  const senderType = asRecord(sender?.participantType);
  const senderMember = asRecord(senderType?.member);
  const senderFirst = getAttributedText(senderMember?.firstName);
  const senderLast = getAttributedText(senderMember?.lastName);
  const senderName = normalizeText(
    [senderFirst, senderLast].filter(Boolean).join(" ")
  );
  if (senderName) {
    return senderName;
  }

  return "Unknown";
}

function extractTextFromMessage(message: Record<string, unknown>): string {
  const textCandidates = [
    getAttributedText(message.body),
    getAttributedText(message.subject),
    getStringValue(message.renderContentFallbackText),
    getAttributedText(message.footer)
  ];

  for (const candidate of textCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function parseThreadMessagesFromMessengerMessagesPayload(
  payload: MessengerMessagesPayload,
  messageLimit: number
): ThreadMessageSnapshot[] {
  const elements = payload.data?.messengerMessagesBySyncToken?.elements;
  if (!Array.isArray(elements)) {
    return [];
  }

  const normalizedLimit = Math.max(1, messageLimit);
  const parsedMessages = elements
    .map((elementValue, index) => {
      const message = asRecord(elementValue);
      if (!message) {
        return null;
      }

      const text = extractTextFromMessage(message);
      if (!text) {
        return null;
      }

      const deliveredAtMs = getNumberValue(message.deliveredAt);
      const sentAt = deliveredAtMs
        ? new Date(deliveredAtMs).toISOString()
        : null;

      return {
        author: extractAuthorFromMessage(message),
        sent_at: sentAt,
        text,
        sort_ms: deliveredAtMs,
        index
      };
    })
    .filter((message): message is {
      author: string;
      sent_at: string | null;
      text: string;
      sort_ms: number | null;
      index: number;
    } => Boolean(message));

  parsedMessages.sort((left, right) => {
    if (left.sort_ms !== null && right.sort_ms !== null) {
      if (left.sort_ms !== right.sort_ms) {
        return left.sort_ms - right.sort_ms;
      }
      return left.index - right.index;
    }

    if (left.sort_ms !== null) {
      return -1;
    }
    if (right.sort_ms !== null) {
      return 1;
    }

    return left.index - right.index;
  });

  return parsedMessages.slice(-normalizedLimit).map((message) => ({
    author: message.author,
    sent_at: message.sent_at,
    text: message.text
  }));
}

function normalizeThreadUrl(threadUrl: string): string {
  return threadUrl.replace(/\/+$/, "/");
}

function findThreadSummary(
  threads: ThreadSnapshot[],
  expectedThreadId: string | null,
  expectedThreadUrl: string
): ThreadSnapshot | null {
  const normalizedExpectedUrl = normalizeThreadUrl(expectedThreadUrl);

  if (expectedThreadId) {
    const byId = threads.find((thread) => thread.thread_id === expectedThreadId);
    if (byId) {
      return byId;
    }
  }

  const byUrl = threads.find(
    (thread) => normalizeThreadUrl(thread.thread_url) === normalizedExpectedUrl
  );
  if (byUrl) {
    return byUrl;
  }

  if (expectedThreadId) {
    const byParsedId = threads.find(
      (thread) => parseThreadIdFromUrl(thread.thread_url) === expectedThreadId
    );
    if (byParsedId) {
      return byParsedId;
    }
  }

  return null;
}

function resolveThreadUrl(thread: string): string {
  const trimmedThread = thread.trim();
  if (!trimmedThread) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Thread identifier is required."
    );
  }

  if (isAbsoluteUrl(trimmedThread)) {
    const parsedUrl = new URL(trimmedThread);
    const threadId = parseThreadIdFromUrl(parsedUrl.toString());
    if (!threadId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Thread URL must point to /messaging/thread/.",
        { thread: trimmedThread }
      );
    }
    return `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`.replace(
      /\/$/,
      "/"
    );
  }

  if (trimmedThread.startsWith("/messaging/thread/")) {
    return `https://www.linkedin.com${trimmedThread}`;
  }

  const encodedThreadId = encodeURIComponent(trimmedThread);
  return `https://www.linkedin.com/messaging/thread/${encodedThreadId}/`;
}

function toThreadSummary(snapshot: ThreadSnapshot): LinkedInThreadSummary {
  return {
    thread_id: snapshot.thread_id,
    title: snapshot.title,
    unread_count: snapshot.unread_count,
    snippet: snapshot.snippet,
    thread_url: snapshot.thread_url
  };
}

function toThreadDetail(snapshot: ThreadDetailSnapshot): LinkedInThreadDetail {
  return {
    thread_id: snapshot.thread_id,
    title: snapshot.title,
    unread_count: snapshot.unread_count,
    snippet: snapshot.snippet,
    thread_url: snapshot.thread_url,
    messages: snapshot.messages.map((message) => ({
      author: message.author,
      sent_at: message.sent_at,
      text: message.text
    }))
  };
}

function getLocalizedInboxPhrases(
  key: LocalizedInboxPhraseKey,
  locale: LinkedInSelectorLocale
): readonly string[] {
  return LOCALIZED_INBOX_PHRASES[locale][key];
}

function buildLocalizedInboxPhraseRegex(
  key: LocalizedInboxPhraseKey,
  locale: LinkedInSelectorLocale,
  options: { exact?: boolean } = {}
): RegExp {
  const phrases = getLocalizedInboxPhrases(key, locale)
    .map((phrase) => normalizeText(phrase))
    .filter((phrase) => phrase.length > 0);
  const body = phrases.map((phrase) => escapeRegExp(phrase)).join("|");
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "i");
}

function formatLocalizedInboxPhraseRegexHint(
  key: LocalizedInboxPhraseKey,
  locale: LinkedInSelectorLocale,
  options: { exact?: boolean } = {}
): string {
  const phrases = getLocalizedInboxPhrases(key, locale).map((phrase) =>
    JSON.stringify(normalizeText(phrase))
  );
  return options.exact ? `exact ${phrases.join(" | ")}` : phrases.join(" | ");
}

function isLikelyProfileTarget(value: string): boolean {
  return isAbsoluteUrl(value) || value.startsWith("/in/") || !/\s/u.test(value);
}

function normalizeRecipientTargets(values: string[]): string[] {
  const normalizedTargets: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) {
      continue;
    }

    if (!isLikelyProfileTarget(normalizedValue)) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Recipients must be LinkedIn profile URLs, /in/ paths, or vanity names. Use linkedin.inbox.search_recipients to resolve free-text names.",
        {
          recipient: normalizedValue
        }
      );
    }

    const dedupeKey = isAbsoluteUrl(normalizedValue) || normalizedValue.startsWith("/in/")
      ? normalizeLinkedInProfileUrl(resolveProfileUrl(normalizedValue))
      : normalizedValue.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedTargets.push(normalizedValue);
  }

  if (normalizedTargets.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "At least one recipient is required."
    );
  }

  if (normalizedTargets.length > MAX_RECIPIENTS_PER_ACTION) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Recipients must contain no more than ${MAX_RECIPIENTS_PER_ACTION} entries.`,
      {
        recipient_count: normalizedTargets.length,
        max_recipient_count: MAX_RECIPIENTS_PER_ACTION
      }
    );
  }

  return normalizedTargets;
}

function parseParticipantNames(title: string): string[] {
  return title
    .split(",")
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
}

export function normalizeLinkedInInboxReaction(
  value: string | undefined,
  fallback: LinkedInInboxReaction = "like"
): LinkedInInboxReaction {
  return normalizeLinkedInFeedReaction(value, fallback);
}

function resolveMessageIndex(
  messages: readonly LinkedInThreadMessage[],
  requestedIndex: number | undefined
): number {
  if (messages.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Thread reactions require at least one message in the thread."
    );
  }

  if (requestedIndex === undefined) {
    return messages.length - 1;
  }

  if (!Number.isInteger(requestedIndex) || requestedIndex < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "messageIndex must be a non-negative integer.",
      {
        message_index: requestedIndex
      }
    );
  }

  if (requestedIndex >= messages.length) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `messageIndex must be between 0 and ${messages.length - 1}.`,
      {
        message_index: requestedIndex,
        message_count: messages.length
      }
    );
  }

  return requestedIndex;
}

function toThreadMessageTarget(
  thread: LinkedInThreadDetail,
  messageIndex: number | undefined
): LinkedInThreadMessageTarget {
  const resolvedIndex = resolveMessageIndex(thread.messages, messageIndex);
  const message = thread.messages[resolvedIndex]!;

  return {
    index: resolvedIndex,
    author: message.author,
    sent_at: message.sent_at,
    text: message.text
  };
}

function toThreadMessageTargetRecord(
  target: LinkedInThreadMessageTarget
): Record<string, unknown> {
  return {
    index: target.index,
    author: target.author,
    sent_at: target.sent_at,
    text: target.text
  };
}

function parsePreparedThreadMessageTarget(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): LinkedInThreadMessageTarget {
  const value = source[key];
  const record = asRecord(value);
  if (!record) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} is missing ${location}.${key}.`,
      {
        action_id: actionId,
        key,
        location
      }
    );
  }

  const indexValue = record.index;
  if (typeof indexValue !== "number" || !Number.isInteger(indexValue) || indexValue < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} has invalid ${location}.${key}.index.`,
      {
        action_id: actionId,
        key,
        location,
        message_index: indexValue
      }
    );
  }

  return {
    index: indexValue,
    author: getRequiredRecordStringField(record, "author", actionId, `${location}.${key}`),
    sent_at: getOptionalRecordStringField(record, "sent_at"),
    text: getRequiredRecordStringField(record, "text", actionId, `${location}.${key}`)
  };
}

function createVerificationSnippet(text: string): string {
  return normalizeText(text).slice(0, 120);
}

const INBOX_REACTION_SELECTOR_KEYS: Record<
  LinkedInInboxReaction,
  LinkedInSelectorPhraseKey
> = {
  like: "like",
  celebrate: "celebrate",
  support: "support",
  love: "love",
  insightful: "insightful",
  funny: "funny"
};

function inferInboxReactionFromText(
  value: string,
  selectorLocale: LinkedInSelectorLocale
): LinkedInInboxReaction | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const reaction of LINKEDIN_INBOX_REACTION_TYPES) {
    if (
      valueContainsLinkedInSelectorPhrase(
        normalized,
        INBOX_REACTION_SELECTOR_KEYS[reaction],
        selectorLocale
      )
    ) {
      return reaction;
    }
  }

  return null;
}

function toInboxRecipientFromSearchResult(
  result: LinkedInSearchResult
): LinkedInInboxRecipient {
  return {
    full_name: normalizeText(result.name),
    headline: normalizeText(result.headline),
    location: normalizeText(result.location),
    profile_url: normalizeText(result.profile_url),
    vanity_name: result.vanity_name,
    connection_degree: normalizeText(result.connection_degree),
    mutual_connections: normalizeText(result.mutual_connections)
  };
}

function toInboxRecipientFromProfile(
  profile: LinkedInProfile
): LinkedInInboxRecipient {
  return {
    full_name: normalizeText(profile.full_name),
    headline: normalizeText(profile.headline),
    location: normalizeText(profile.location),
    profile_url: normalizeText(profile.profile_url),
    vanity_name: profile.vanity_name,
    connection_degree: normalizeText(profile.connection_degree),
    mutual_connections: ""
  };
}

function toRecipientPreviewRecord(
  recipient: LinkedInInboxRecipient
): Record<string, unknown> {
  return {
    full_name: recipient.full_name,
    headline: recipient.headline,
    location: recipient.location,
    profile_url: recipient.profile_url,
    vanity_name: recipient.vanity_name,
    connection_degree: recipient.connection_degree,
    mutual_connections: recipient.mutual_connections
  };
}

function getRequiredRecordStringField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: string
): string {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      key,
      location
    }
  );
}

function getOptionalRecordStringField(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key];
  return typeof value === "string" ? normalizeText(value) || null : null;
}

function parsePreparedRecipient(
  value: unknown,
  actionId: string,
  location: string
): LinkedInInboxRecipient {
  const record = asRecord(value);
  if (!record) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} has invalid ${location}.`,
      {
        action_id: actionId,
        location
      }
    );
  }

  return {
    full_name: getRequiredRecordStringField(record, "full_name", actionId, location),
    headline: getOptionalRecordStringField(record, "headline") ?? "",
    location: getOptionalRecordStringField(record, "location") ?? "",
    profile_url: getRequiredRecordStringField(record, "profile_url", actionId, location),
    vanity_name: getOptionalRecordStringField(record, "vanity_name"),
    connection_degree: getOptionalRecordStringField(record, "connection_degree") ?? "",
    mutual_connections: getOptionalRecordStringField(record, "mutual_connections") ?? ""
  };
}

function getRequiredPreparedRecipients(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): LinkedInInboxRecipient[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} is missing ${location}.${key}.`,
      {
        action_id: actionId,
        key,
        location
      }
    );
  }

  return value.map((item, index) =>
    parsePreparedRecipient(item, actionId, `${location}.${key}[${index}]`)
  );
}

function inferParticipantName(title: string): string {
  const normalized = normalizeText(title);
  if (!normalized) {
    return "";
  }

  const firstChunk = normalized.split(",")[0] ?? normalized;
  return normalizeText(firstChunk);
}

function getProfileName(target: Record<string, unknown>): string {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return "default";
}

function getRequiredStringField(
  source: Record<string, unknown>,
  key: string,
  actionId: string,
  location: "target" | "payload"
): string {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key
    }
  );
}

function getOptionalStringField(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function toAutomationError(
  error: unknown,
  message: string,
  details: Record<string, unknown>
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInBuddyError("TIMEOUT", message, details, { cause: error });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i.test(error.message)
  ) {
    return new LinkedInBuddyError("NETWORK_ERROR", message, details, {
      cause: error
    });
  }

  return asLinkedInBuddyError(error, "UNKNOWN", message);
}

async function waitForThreadSurface(page: Page): Promise<void> {
  const candidates: Locator[] = [
    page.locator(".msg-s-message-list-content").first(),
    page.locator(".msg-s-message-list").first(),
    page.locator("main").first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 5_000 });
      return;
    } catch {
      // Try the next candidate.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn thread surface.",
    {
      selector_key: "thread_surface",
      current_url: page.url(),
      attempted_selectors: [
        ".msg-s-message-list-content",
        ".msg-s-message-list",
        "main"
      ]
    }
  );
}

async function waitForInboxListSurface(page: Page): Promise<void> {
  const candidates: Locator[] = [
    page.locator("a[href*='/messaging/thread/']").first(),
    page.locator("li.msg-conversation-listitem").first(),
    page.locator(".msg-conversation-card").first(),
    page.locator(".msg-conversations-container").first(),
    page.locator("main").first()
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout: 6_000 });
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

function isMessengerConversationsResponse(response: Response): boolean {
  if (response.status() !== 200) {
    return false;
  }

  const url = response.url();
  return (
    url.includes("/voyagerMessagingGraphQL/graphql") &&
    /[?&]queryId=messengerConversations\./.test(url)
  );
}

function isMessengerMessagesResponse(
  response: Response,
  expectedThreadId: string | null = null
): boolean {
  if (response.status() !== 200) {
    return false;
  }

  const url = response.url();
  if (
    !url.includes("/voyagerMessagingGraphQL/graphql") ||
    !/[?&]queryId=messengerMessages\./.test(url)
  ) {
    return false;
  }

  if (!expectedThreadId) {
    return true;
  }

  try {
    const parsedUrl = new URL(url);
    const variables = parsedUrl.searchParams.get("variables") ?? "";
    if (variables.includes(expectedThreadId)) {
      return true;
    }

    const decodedVariables = decodeURIComponent(variables);
    return decodedVariables.includes(expectedThreadId);
  } catch {
    return url.includes(expectedThreadId);
  }
}

async function waitForMessengerConversationsResponse(
  page: Page
): Promise<Response | null> {
  try {
    return await page.waitForResponse(isMessengerConversationsResponse, {
      timeout: 12_000
    });
  } catch {
    return null;
  }
}

async function waitForMessengerMessagesResponse(
  page: Page,
  expectedThreadId: string | null
): Promise<Response | null> {
  try {
    return await page.waitForResponse(
      (response) => isMessengerMessagesResponse(response, expectedThreadId),
      {
        timeout: 12_000
      }
    );
  } catch {
    return null;
  }
}

async function extractThreadSummariesFromNetwork(
  response: Response
): Promise<ThreadSnapshot[]> {
  try {
    const payload = JSON.parse(
      await response.text()
    ) as MessengerConversationsPayload;
    return parseThreadSummariesFromMessengerConversationsPayload(payload);
  } catch {
    return [];
  }
}

async function extractThreadMessagesFromNetwork(
  response: Response,
  messageLimit: number
): Promise<ThreadMessageSnapshot[]> {
  try {
    const payload = JSON.parse(await response.text()) as MessengerMessagesPayload;
    return parseThreadMessagesFromMessengerMessagesPayload(payload, messageLimit);
  } catch {
    return [];
  }
}

async function extractThreadSummaries(page: Page): Promise<ThreadSnapshot[]> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const anchors = Array.from(
      globalThis.document.querySelectorAll("a[href*='/messaging/thread/']")
    );
    const byUrl = new Map<string, ThreadSnapshot>();

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      if (!href) {
        continue;
      }

      const absoluteUrl = new URL(href, globalThis.window.location.origin).toString();
      if (byUrl.has(absoluteUrl)) {
        continue;
      }

      const threadIdMatch = /\/messaging\/thread\/([^/?#]+)/.exec(absoluteUrl);
      const encodedThreadId = threadIdMatch?.[1];
      const threadId = encodedThreadId
        ? decodeURIComponent(encodedThreadId)
        : absoluteUrl;
      const title = normalize(
        anchor.querySelector(
          ".msg-conversation-card__participant-names, .msg-conversation-listitem__participant-names, .msg-conversation-card__title"
        )?.textContent ?? anchor.getAttribute("aria-label")
      );
      const snippet = normalize(
        anchor.querySelector(
          ".msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet, .msg-conversation-listitem__subject"
        )?.textContent
      );
      const unreadText = normalize(
        anchor.querySelector(
          ".msg-conversation-card__unread-count, .msg-conversation-listitem__unread-count, .notification-badge"
        )?.textContent
      );
      const unreadMatch = /\d+/.exec(unreadText);
      const unreadCount = unreadMatch ? Number.parseInt(unreadMatch[0], 10) : 0;

      byUrl.set(absoluteUrl, {
        thread_id: threadId,
        title,
        unread_count: unreadCount,
        snippet,
        thread_url: absoluteUrl
      });
    }

    return Array.from(byUrl.values());
  });
}

async function extractThreadDetail(
  page: Page,
  messageLimit: number
): Promise<ThreadDetailSnapshot> {
  const snapshot = await page.evaluate(
    (limit) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const threadUrl = globalThis.window.location.href;
      const threadIdMatch = /\/messaging\/thread\/([^/?#]+)/.exec(threadUrl);
      const encodedThreadId = threadIdMatch?.[1];
      const threadId = encodedThreadId ? decodeURIComponent(encodedThreadId) : threadUrl;
      const titleCandidates = [
        ".msg-entity-lockup__entity-title",
        ".msg-thread__participant-names",
        ".msg-thread__name",
        ".msg-thread__link-to-profile .t-16",
        ".msg-overlay-bubble-header__title",
        ".msg-thread__link-to-profile",
        "h2"
      ];
      let title = "";
      for (const selector of titleCandidates) {
        const text = normalize(globalThis.document.querySelector(selector)?.textContent);
        if (text) {
          title = text;
          break;
        }
      }

      const snippet = normalize(
        globalThis.document.querySelector(
          ".msg-s-message-list__event:last-child .msg-s-event-listitem__body"
        )?.textContent
      );
      const unreadText = normalize(
        globalThis.document.querySelector(
          ".msg-thread__unread-count, .msg-conversation-card__unread-count, .notification-badge"
        )?.textContent
      );
      const unreadMatch = /\d+/.exec(unreadText);
      const unreadCount = unreadMatch ? Number.parseInt(unreadMatch[0], 10) : 0;

      const messageNodes = Array.from(
        globalThis.document.querySelectorAll(
          ".msg-s-message-list__event, .msg-s-event-listitem"
        )
      );
      const messages = messageNodes
        .map((node) => {
          const group = node.closest(".msg-s-message-group");
          const author = normalize(
            group?.querySelector(".msg-s-message-group__name, .msg-s-message-group__profile-link")
              ?.textContent ??
              node.querySelector("[data-anonymize='person-name']")?.textContent
          );
          const timeElement = node.querySelector("time");
          const sentAt = normalize(
            timeElement?.getAttribute("datetime") ?? timeElement?.textContent
          );
          const text = normalize(
            node.querySelector(
              ".msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble, .msg-s-message-group__message-body"
            )?.textContent ?? node.textContent
          );

          return {
            author: author || "Unknown",
            sent_at: sentAt || null,
            text
          };
        })
        .filter((message) => message.text.length > 0);

      const limitedMessages = messages.slice(-Math.max(limit, 1));

      return {
        thread_id: threadId,
        title,
        unread_count: unreadCount,
        snippet,
        thread_url: threadUrl,
        messages: limitedMessages
      };
    },
    messageLimit
  );

  if (!snapshot.thread_id || !snapshot.thread_url) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      "Could not resolve thread details from the current LinkedIn page.",
      { current_url: page.url() }
    );
  }

  return snapshot;
}

function mergeThreadDetailSnapshot(input: {
  domDetail: ThreadDetailSnapshot;
  expectedThreadUrl: string;
  expectedThreadId: string | null;
  networkThreadSummary: ThreadSnapshot | null;
  networkMessages: ThreadMessageSnapshot[];
}): ThreadDetailSnapshot {
  const {
    domDetail,
    expectedThreadUrl,
    expectedThreadId,
    networkThreadSummary,
    networkMessages
  } = input;

  const resolvedThreadUrl =
    networkThreadSummary?.thread_url ||
    domDetail.thread_url ||
    expectedThreadUrl;

  const resolvedThreadId =
    networkThreadSummary?.thread_id ||
    domDetail.thread_id ||
    expectedThreadId ||
    resolvedThreadUrl;

  return {
    thread_id: resolvedThreadId,
    title: networkThreadSummary?.title || domDetail.title,
    unread_count: networkThreadSummary?.unread_count ?? domDetail.unread_count,
    snippet: networkThreadSummary?.snippet || domDetail.snippet,
    thread_url: resolvedThreadUrl,
    messages: networkMessages.length > 0 ? networkMessages : domDetail.messages
  };
}

async function extractThreadDetailWithNetwork(
  page: Page,
  threadUrl: string,
  messageLimit: number
): Promise<ThreadDetailSnapshot> {
  const expectedThreadId = parseThreadIdFromUrl(threadUrl);
  const conversationsResponsePromise = waitForMessengerConversationsResponse(page);
  const messagesResponsePromise = waitForMessengerMessagesResponse(
    page,
    expectedThreadId
  );

  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await waitForThreadSurface(page);

  const domDetail = await extractThreadDetail(page, messageLimit);
  const conversationsResponse = await conversationsResponsePromise;
  const messagesResponse = await messagesResponsePromise;

  let networkThreadSummary: ThreadSnapshot | null = null;
  if (conversationsResponse) {
    const networkThreads = await extractThreadSummariesFromNetwork(
      conversationsResponse
    );
    networkThreadSummary = findThreadSummary(
      networkThreads,
      expectedThreadId,
      threadUrl
    );
  }

  const networkMessages = messagesResponse
    ? await extractThreadMessagesFromNetwork(messagesResponse, messageLimit)
    : [];

  return mergeThreadDetailSnapshot({
    domDetail,
    expectedThreadUrl: threadUrl,
    expectedThreadId,
    networkThreadSummary,
    networkMessages
  });
}

async function captureScreenshotArtifact(
  runtime: LinkedInMessagingRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForMessageEcho(page: Page, messageText: string): Promise<void> {
  const snippet = messageText.trim().slice(0, 140);
  if (!snippet) {
    return;
  }

  await page
    .locator(".msg-s-message-list__event, .msg-s-event-listitem")
    .filter({ hasText: snippet })
    .last()
    .waitFor({ state: "visible", timeout: 7_000 })
    .catch(() => undefined);
}

async function findVisibleLocator(
  page: Page,
  candidates: SelectorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_000 });
      return { locator, key: candidate.key };
    } catch {
      // Try the next selector candidate.
    }
  }

  return null;
}

async function findVisibleLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  const visibleLocator = await findVisibleLocator(page, candidates);
  if (visibleLocator) {
    return visibleLocator;
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: page.url(),
      attempted_selectors: candidates.map((candidate) => candidate.selectorHint),
      artifact_paths: artifactPaths
    }
  );
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) {
        return true;
      }
    } catch {
      // Keep polling until the timeout window closes.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  try {
    return await predicate();
  } catch {
    return false;
  }
}

function createThreadMoreButtonSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const moreRegex = buildLinkedInSelectorPhraseRegex(
    ["more", "more_actions"],
    runtime.selectorLocale,
    { exact: true }
  );
  const moreRegexHint = formatLinkedInSelectorRegexHint(
    ["more", "more_actions"],
    runtime.selectorLocale,
    { exact: true }
  );
  const moreAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    ["more", "more_actions"],
    runtime.selectorLocale
  );

  return [
    {
      key: "role-button-more",
      selectorHint: `getByRole(button, ${moreRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", { name: moreRegex })
    },
    {
      key: "button-text-more",
      selectorHint: `button hasText ${moreRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("button").filter({ hasText: moreRegex })
    },
    {
      key: "button-aria-more",
      selectorHint: moreAriaSelector,
      locatorFactory: (targetPage) => targetPage.locator(moreAriaSelector)
    }
  ];
}

function createThreadMenuItemSelectors(
  runtime: LinkedInMessagingRuntime,
  phraseKey: LocalizedInboxPhraseKey
): SelectorCandidate[] {
  const itemRegex = buildLocalizedInboxPhraseRegex(phraseKey, runtime.selectorLocale);
  const itemRegexHint = formatLocalizedInboxPhraseRegexHint(
    phraseKey,
    runtime.selectorLocale
  );

  return [
    {
      key: "role-menuitem-thread-action",
      selectorHint: `getByRole(menuitem, ${itemRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("menuitem", { name: itemRegex })
    },
    {
      key: "role-button-thread-action",
      selectorHint: `.artdeco-dropdown__content-inner [role='button'] hasText ${itemRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage
          .locator(".artdeco-dropdown__content-inner [role='button']")
          .filter({ hasText: itemRegex })
    },
    {
      key: "menuitem-text-thread-action",
      selectorHint: `[role='menuitem'] hasText ${itemRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("[role='menuitem']").filter({ hasText: itemRegex })
    },
    {
      key: "dropdown-item-thread-action",
      selectorHint: `.artdeco-dropdown__content-inner li hasText ${itemRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage
          .locator(".artdeco-dropdown__content-inner li")
          .filter({ hasText: itemRegex })
    },
    {
      key: "generic-button-thread-action",
      selectorHint: `button hasText ${itemRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("button").filter({ hasText: itemRegex })
    }
  ];
}

async function openThreadMoreMenu(input: {
  artifactPaths: string[];
  page: Page;
  runtime: LinkedInMessagingRuntime;
}): Promise<{ locator: Locator; key: string }> {
  const moreButton = await findVisibleLocatorOrThrow(
    input.page,
    createThreadMoreButtonSelectors(input.runtime),
    "thread_more_button",
    input.artifactPaths
  );
  await moreButton.locator.click({ timeout: 5_000 });
  await input.page.waitForTimeout(500);
  return moreButton;
}

async function clickThreadMenuAction(input: {
  actionType: string;
  artifactPaths: string[];
  page: Page;
  runtime: LinkedInMessagingRuntime;
  phraseKey: LocalizedInboxPhraseKey;
}): Promise<string> {
  await openThreadMoreMenu(input);
  const actionMenuItem = await findVisibleLocatorOrThrow(
    input.page,
    createThreadMenuItemSelectors(input.runtime, input.phraseKey),
    `${input.actionType}_menu_item`,
    input.artifactPaths
  );
  await actionMenuItem.locator.click({ timeout: 5_000 });
  await input.page.waitForTimeout(600);
  return actionMenuItem.key;
}

async function findThreadMessageLocator(
  page: Page,
  target: LinkedInThreadMessageTarget,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  const markerAttribute = "data-linkedin-buddy-target-message";
  const targetMetadata = await page.evaluate(
    ({ attributeName, author, index, textSnippet }) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      for (const node of globalThis.document.querySelectorAll(`[${attributeName}]`)) {
        node.removeAttribute(attributeName);
      }

      const messageNodes = Array.from(
        globalThis.document.querySelectorAll(
          ".msg-s-message-list__event, .msg-s-event-listitem"
        )
      );
      const filteredMessages = messageNodes
        .map((node) => {
          const group = node.closest(".msg-s-message-group");
          const resolvedAuthor = normalize(
            group?.querySelector(
              ".msg-s-message-group__name, .msg-s-message-group__profile-link"
            )?.textContent ??
              node.querySelector("[data-anonymize='person-name']")?.textContent
          );
          const resolvedText = normalize(
            node.querySelector(
              ".msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble, .msg-s-message-group__message-body"
            )?.textContent ?? node.textContent
          );

          return {
            node,
            author: resolvedAuthor || "Unknown",
            text: resolvedText
          };
        })
        .filter((message) => message.text.length > 0);

      if (index < 0 || index >= filteredMessages.length) {
        return {
          ok: false,
          reason: "index_out_of_range",
          messageCount: filteredMessages.length
        };
      }

      const targetMessage = filteredMessages[index]!;
      targetMessage.node.setAttribute(attributeName, "true");

      const normalizedExpectedAuthor = normalize(author).toLowerCase();
      const normalizedActualAuthor = normalize(targetMessage.author).toLowerCase();
      const normalizedExpectedSnippet = normalize(textSnippet).toLowerCase();
      const normalizedActualText = normalize(targetMessage.text).toLowerCase();

      return {
        ok: true,
        actualAuthor: targetMessage.author,
        actualText: targetMessage.text,
        authorMatches:
          normalizedExpectedAuthor.length === 0 ||
          normalizedActualAuthor === normalizedExpectedAuthor,
        textMatches:
          normalizedExpectedSnippet.length === 0 ||
          normalizedActualText.includes(normalizedExpectedSnippet)
      };
    },
    {
      attributeName: markerAttribute,
      author: target.author,
      index: target.index,
      textSnippet: createVerificationSnippet(target.text)
    }
  );

  if (!targetMetadata.ok) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Prepared reaction target no longer matches the current thread message list.",
      {
        message_index: target.index,
        message_count: targetMetadata.messageCount
      }
    );
  }

  if (!targetMetadata.authorMatches || !targetMetadata.textMatches) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Prepared reaction target no longer matches the selected thread message.",
      {
        message_index: target.index,
        expected_author: target.author,
        actual_author: targetMetadata.actualAuthor,
        expected_message_preview: createVerificationSnippet(target.text),
        actual_message_preview: createVerificationSnippet(
          targetMetadata.actualText ?? ""
        )
      }
    );
  }

  const locator = page.locator(`[${markerAttribute}='true']`).first();
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      'Could not resolve the prepared thread message in the current LinkedIn thread.',
      {
        selector_key: "thread_message",
        message_index: target.index,
        current_url: page.url(),
        artifact_paths: artifactPaths
      }
    );
  }

  return {
    locator,
    key: "thread-message-index"
  };
}

function createMessageReactionButtonSelectors(
  messageRoot: Locator,
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const reactRegex = buildLocalizedInboxPhraseRegex(
    "add_reaction",
    runtime.selectorLocale
  );
  const reactRegexHint = formatLocalizedInboxPhraseRegexHint(
    "add_reaction",
    runtime.selectorLocale
  );
  const reactAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    ["react", "reaction"],
    runtime.selectorLocale
  );

  return [
    {
      key: "message-aria-reaction-button",
      selectorHint: reactAriaSelector,
      locatorFactory: () => messageRoot.locator(reactAriaSelector)
    },
    {
      key: "message-role-button-reaction",
      selectorHint: `messageRoot.getByRole(button, ${reactRegexHint})`,
      locatorFactory: () => messageRoot.getByRole("button", { name: reactRegex })
    },
    {
      key: "message-button-text-reaction",
      selectorHint: `messageRoot button hasText ${reactRegexHint}`,
      locatorFactory: () => messageRoot.locator("button").filter({ hasText: reactRegex })
    },
    {
      key: "message-data-control-reaction",
      selectorHint: "button[data-control-name*='reaction']",
      locatorFactory: () =>
        messageRoot.locator(
          "button[data-control-name*='reaction'], [data-control-name*='reaction'] button"
        )
    }
  ];
}

function createMessageReactionMenuSelectors(
  runtime: LinkedInMessagingRuntime,
  reaction: LinkedInInboxReaction
): SelectorCandidate[] {
  const reactionKey = INBOX_REACTION_SELECTOR_KEYS[reaction];
  const reactionRegex = buildLinkedInSelectorPhraseRegex(
    reactionKey,
    runtime.selectorLocale,
    { exact: true }
  );
  const reactionRegexHint = formatLinkedInSelectorRegexHint(
    reactionKey,
    runtime.selectorLocale,
    { exact: true }
  );
  const reactionAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    reactionKey,
    runtime.selectorLocale
  );

  return [
    {
      key: "message-reaction-menu-text",
      selectorHint: `[role='menuitem'], button hasText ${reactionRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage
          .locator("[role='menuitem'], .artdeco-dropdown__content-inner button, button")
          .filter({ hasText: reactionRegex })
    },
    {
      key: "message-reaction-menu-aria",
      selectorHint: reactionAriaSelector,
      locatorFactory: (targetPage) => targetPage.locator(reactionAriaSelector)
    },
    {
      key: "message-reaction-menu-data-control",
      selectorHint: `[data-control-name*='${reaction}']`,
      locatorFactory: (targetPage) =>
        targetPage.locator(
          `[data-control-name*='${reaction}'], [data-test-reaction='${reaction}']`
        )
    }
  ];
}

interface MessageReactionButtonState {
  reacted: boolean;
  reaction: LinkedInInboxReaction | null;
  ariaLabel: string;
  className: string;
  buttonText: string;
}

async function getMessageReactionButtonState(
  reactionButton: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<MessageReactionButtonState> {
  const ariaPressed = normalizeText(
    await reactionButton.getAttribute("aria-pressed")
  ).toLowerCase();
  const className = normalizeText(await reactionButton.getAttribute("class"));
  const ariaLabel = normalizeText(await reactionButton.getAttribute("aria-label"));
  const buttonText = normalizeText(await reactionButton.innerText().catch(() => ""));

  const reactionFromLabel = inferInboxReactionFromText(ariaLabel, selectorLocale);
  const reactionFromText = inferInboxReactionFromText(buttonText, selectorLocale);
  const reacted =
    ariaPressed === "true" ||
    className.toLowerCase().includes("active") ||
    reactionFromLabel !== null ||
    reactionFromText !== null ||
    /reacted|remove|undo|change your reaction/i.test(ariaLabel);

  return {
    reacted,
    reaction: reactionFromLabel ?? reactionFromText,
    ariaLabel,
    className,
    buttonText
  };
}

async function isDesiredMessageReactionActive(
  reactionButton: Locator,
  reaction: LinkedInInboxReaction,
  selectorLocale: LinkedInSelectorLocale
): Promise<boolean> {
  const state = await getMessageReactionButtonState(reactionButton, selectorLocale);
  if (!state.reacted) {
    return false;
  }

  if (state.reaction === reaction) {
    return true;
  }

  return reaction === "like" && state.reaction === null;
}

async function verifyReverseThreadMenuActionVisible(input: {
  artifactPaths: string[];
  page: Page;
  runtime: LinkedInMessagingRuntime;
  threadUrl: string;
  phraseKey: LocalizedInboxPhraseKey;
}): Promise<boolean> {
  try {
    await input.page.goto(input.threadUrl, { waitUntil: "domcontentloaded" });
    await waitForNetworkIdleBestEffort(input.page);
    await waitForThreadSurface(input.page);
    await openThreadMoreMenu(input);
    const reverseItem = await findVisibleLocator(
      input.page,
      createThreadMenuItemSelectors(input.runtime, input.phraseKey)
    );
    return reverseItem !== null;
  } catch {
    return false;
  }
}

function createMessageComposerSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const composerNameRegex = buildLinkedInSelectorPhraseRegex(
    ["write_message", "message"],
    runtime.selectorLocale
  );
  const composerNameRegexHint = formatLinkedInSelectorRegexHint(
    ["write_message", "message"],
    runtime.selectorLocale
  );
  const writeMessagePlaceholderRegex = buildLinkedInSelectorPhraseRegex(
    "write_message",
    runtime.selectorLocale
  );
  const writeMessagePlaceholderRegexHint = formatLinkedInSelectorRegexHint(
    "write_message",
    runtime.selectorLocale
  );

  return [
    {
      key: "role-textbox-write-message",
      selectorHint: `getByRole(textbox, ${composerNameRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("textbox", {
          name: composerNameRegex
        })
    },
    {
      key: "placeholder-write-message",
      selectorHint: `getByPlaceholder(${writeMessagePlaceholderRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByPlaceholder(writeMessagePlaceholderRegex)
    },
    {
      key: "msg-contenteditable",
      selectorHint: ".msg-form__contenteditable[contenteditable='true']",
      locatorFactory: (targetPage) =>
        targetPage.locator(".msg-form__contenteditable[contenteditable='true']")
    },
    {
      key: "msg-form-contenteditable-fallback",
      selectorHint: ".msg-form [contenteditable='true']",
      locatorFactory: (targetPage) =>
        targetPage.locator(".msg-form [contenteditable='true']")
    },
    {
      key: "msg-form-texteditor-contenteditable",
      selectorHint:
        ".msg-form__message-texteditor [contenteditable='true'], .msg-form__message-texteditor p[role='textbox']",
      locatorFactory: (targetPage) =>
        targetPage.locator(
          ".msg-form__message-texteditor [contenteditable='true'], .msg-form__message-texteditor p[role='textbox']"
        )
    },
    {
      key: "dialog-contenteditable",
      selectorHint: "[role='dialog'] [contenteditable='true']",
      locatorFactory: (targetPage) =>
        targetPage.locator("[role='dialog'] [contenteditable='true']")
    }
  ];
}

function createSendButtonSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const sendButtonRegex = buildLinkedInSelectorPhraseRegex(
    "send",
    runtime.selectorLocale,
    { exact: true }
  );
  const sendButtonRegexHint = formatLinkedInSelectorRegexHint(
    "send",
    runtime.selectorLocale,
    { exact: true }
  );
  const sendAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    "send",
    runtime.selectorLocale
  );

  return [
    {
      key: "role-button-send",
      selectorHint: `getByRole(button, ${sendButtonRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", { name: sendButtonRegex })
    },
    {
      key: "msg-form-send-button",
      selectorHint: "button.msg-form__send-button",
      locatorFactory: (targetPage) => targetPage.locator("button.msg-form__send-button")
    },
    {
      key: "msg-form-send-button-fallback",
      selectorHint: ".msg-form__send-button",
      locatorFactory: (targetPage) => targetPage.locator(".msg-form__send-button")
    },
    {
      key: "msg-form-submit",
      selectorHint: ".msg-form button[type='submit']",
      locatorFactory: (targetPage) =>
        targetPage.locator(".msg-form button[type='submit']")
    },
    {
      key: "msg-send-aria-label",
      selectorHint: sendAriaSelector,
      locatorFactory: (targetPage) => targetPage.locator(sendAriaSelector)
    }
  ];
}

function createNewMessageButtonSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const newMessageRegex = buildLocalizedInboxPhraseRegex(
    "new_message",
    runtime.selectorLocale
  );
  const newMessageRegexHint = formatLocalizedInboxPhraseRegexHint(
    "new_message",
    runtime.selectorLocale
  );

  return [
    {
      key: "role-button-new-message",
      selectorHint: `getByRole(button, ${newMessageRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", { name: newMessageRegex })
    },
    {
      key: "button-text-new-message",
      selectorHint: `button hasText ${newMessageRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("button").filter({ hasText: newMessageRegex })
    },
    {
      key: "compose-data-control-name",
      selectorHint: "button[data-control-name*='compose']",
      locatorFactory: (targetPage) =>
        targetPage.locator("button[data-control-name*='compose']")
    }
  ];
}

function createRecipientInputSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const typeANameRegex = buildLocalizedInboxPhraseRegex(
    "type_a_name",
    runtime.selectorLocale
  );
  const typeANameRegexHint = formatLocalizedInboxPhraseRegexHint(
    "type_a_name",
    runtime.selectorLocale
  );

  return [
    {
      key: "role-combobox-type-a-name",
      selectorHint: `getByRole(combobox, ${typeANameRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("combobox", { name: typeANameRegex })
    },
    {
      key: "role-textbox-type-a-name",
      selectorHint: `getByRole(textbox, ${typeANameRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("textbox", { name: typeANameRegex })
    },
    {
      key: "placeholder-type-a-name",
      selectorHint: `getByPlaceholder(${typeANameRegexHint})`,
      locatorFactory: (targetPage) => targetPage.getByPlaceholder(typeANameRegex)
    },
    {
      key: "msg-connections-typeahead-input",
      selectorHint: ".msg-connections-typeahead__search-field input",
      locatorFactory: (targetPage) =>
        targetPage.locator(".msg-connections-typeahead__search-field input")
    },
    {
      key: "artdeco-typeahead-input",
      selectorHint: ".artdeco-typeahead input",
      locatorFactory: (targetPage) => targetPage.locator(".artdeco-typeahead input")
    },
    {
      key: "input-role-combobox",
      selectorHint: "input[role='combobox'], input[aria-autocomplete='list']",
      locatorFactory: (targetPage) =>
        targetPage.locator("input[role='combobox'], input[aria-autocomplete='list']")
    }
  ];
}

function createRecipientSuggestionSelectors(
  recipient: LinkedInInboxRecipient
): SelectorCandidate[] {
  const recipientNameRegex = new RegExp(escapeRegExp(recipient.full_name), "i");
  const recipientHeadlineRegex = recipient.headline
    ? new RegExp(escapeRegExp(recipient.headline), "i")
    : null;
  const baseCandidates = [
    {
      key: "role-option",
      selectorHint: `[role='option'] hasText ${JSON.stringify(recipient.full_name)}`,
      locatorFactory: (targetPage: Page) => targetPage.locator("[role='option']")
    },
    {
      key: "typeahead-hit",
      selectorHint: `.msg-connections-typeahead__hit hasText ${JSON.stringify(recipient.full_name)}`,
      locatorFactory: (targetPage: Page) =>
        targetPage.locator(".msg-connections-typeahead__hit")
    },
    {
      key: "typeahead-result",
      selectorHint: `.artdeco-typeahead__result hasText ${JSON.stringify(recipient.full_name)}`,
      locatorFactory: (targetPage: Page) =>
        targetPage.locator(".artdeco-typeahead__result")
    },
    {
      key: "listitem",
      selectorHint: `li hasText ${JSON.stringify(recipient.full_name)}`,
      locatorFactory: (targetPage: Page) => targetPage.locator("li")
    }
  ] as const;

  const candidates: SelectorCandidate[] = [];
  if (recipientHeadlineRegex) {
    for (const candidate of baseCandidates) {
      candidates.push({
        key: `${candidate.key}-name-headline`,
        selectorHint: `${candidate.selectorHint} + headline ${JSON.stringify(recipient.headline)}`,
        locatorFactory: (targetPage) =>
          candidate
            .locatorFactory(targetPage)
            .filter({ hasText: recipientNameRegex })
            .filter({ hasText: recipientHeadlineRegex })
      });
    }
  }

  for (const candidate of baseCandidates) {
    candidates.push({
      key: `${candidate.key}-name`,
      selectorHint: candidate.selectorHint,
      locatorFactory: (targetPage) =>
        candidate.locatorFactory(targetPage).filter({ hasText: recipientNameRegex })
    });
  }

  return candidates;
}

function createAddRecipientsButtonSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const addPeopleRegex = buildLocalizedInboxPhraseRegex(
    "add_people",
    runtime.selectorLocale
  );
  const addPeopleRegexHint = formatLocalizedInboxPhraseRegexHint(
    "add_people",
    runtime.selectorLocale
  );

  return [
    {
      key: "role-button-add-people",
      selectorHint: `getByRole(button, ${addPeopleRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", { name: addPeopleRegex })
    },
    {
      key: "button-text-add-people",
      selectorHint: `button hasText ${addPeopleRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("button").filter({ hasText: addPeopleRegex })
    }
  ];
}

function createFinalizeRecipientsSelectors(
  runtime: LinkedInMessagingRuntime
): SelectorCandidate[] {
  const finalizeRegex = buildLocalizedInboxPhraseRegex(
    "finalize_recipients",
    runtime.selectorLocale,
    { exact: true }
  );
  const finalizeRegexHint = formatLocalizedInboxPhraseRegexHint(
    "finalize_recipients",
    runtime.selectorLocale,
    { exact: true }
  );

  return [
    {
      key: "role-button-finalize-recipients",
      selectorHint: `getByRole(button, ${finalizeRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", { name: finalizeRegex })
    },
    {
      key: "button-text-finalize-recipients",
      selectorHint: `button hasText ${finalizeRegexHint}`,
      locatorFactory: (targetPage) =>
        targetPage.locator("button").filter({ hasText: finalizeRegex })
    }
  ];
}

async function readEditableValue(locator: Locator): Promise<string> {
  try {
    return await locator.evaluate((node) => {
      const editableNode = node as {
        textContent?: string | null;
        value?: unknown;
      };
      return typeof editableNode.value === "string"
        ? editableNode.value
        : editableNode.textContent ?? "";
    });
  } catch {
    return "";
  }
}

async function fillAndSendMessage(input: {
  actionId: string;
  actionType: string;
  artifactMetadata?: Record<string, unknown>;
  artifactPaths: string[];
  page: Page;
  profileName: string;
  runtime: LinkedInMessagingRuntime;
  text: string;
}): Promise<void> {
  const composer = await findVisibleLocatorOrThrow(
    input.page,
    createMessageComposerSelectors(input.runtime),
    "message_composer",
    input.artifactPaths
  );
  await composer.locator.click({ timeout: 3_000 });
  await composer.locator.fill(input.text, { timeout: 5_000 });

  const sendButton = await findVisibleLocatorOrThrow(
    input.page,
    createSendButtonSelectors(input.runtime),
    "send_button",
    input.artifactPaths
  );
  await sendButton.locator.click({ timeout: 5_000 });
  await waitForMessageEcho(input.page, input.text);

  const postSendScreenshot = `linkedin/screenshot-confirm-${Date.now()}.png`;
  await captureScreenshotArtifact(input.runtime, input.page, postSendScreenshot, {
    action: input.actionType,
    action_id: input.actionId,
    profile_name: input.profileName,
    ...input.artifactMetadata
  });
  input.artifactPaths.push(postSendScreenshot);
}

async function openNewMessageComposer(
  page: Page,
  runtime: LinkedInMessagingRuntime,
  artifactPaths: string[]
): Promise<void> {
  const newMessageButton = await findVisibleLocatorOrThrow(
    page,
    createNewMessageButtonSelectors(runtime),
    "new_message_button",
    artifactPaths
  );
  await newMessageButton.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  await findVisibleLocatorOrThrow(
    page,
    createRecipientInputSelectors(runtime),
    "recipient_input",
    artifactPaths
  );
}

async function selectRecipientsInComposer(input: {
  artifactPaths: string[];
  page: Page;
  recipients: LinkedInInboxRecipient[];
  runtime: LinkedInMessagingRuntime;
}): Promise<void> {
  for (const recipient of input.recipients) {
    const recipientInput = await findVisibleLocatorOrThrow(
      input.page,
      createRecipientInputSelectors(input.runtime),
      "recipient_input",
      input.artifactPaths
    );
    await recipientInput.locator.click({ timeout: 3_000 });
    await recipientInput.locator.fill(recipient.full_name, { timeout: 5_000 });
    await input.page.waitForTimeout(600);

    const suggestion = await findVisibleLocator(
      input.page,
      createRecipientSuggestionSelectors(recipient)
    );

    if (suggestion) {
      await suggestion.locator.click({ timeout: 5_000 });
    } else {
      await recipientInput.locator.press("ArrowDown", { timeout: 2_000 }).catch(
        () => undefined
      );
      await recipientInput.locator.press("Enter", { timeout: 2_000 }).catch(
        () => undefined
      );
    }

    await input.page.waitForTimeout(500);

    const selectedChip = input.page
      .locator(
        ".msg-connections-typeahead__recipient, .artdeco-pill, .msg-compose__recipient, .msg-s-message-recipient-list__recipient"
      )
      .filter({ hasText: new RegExp(escapeRegExp(recipient.full_name), "i") })
      .first();
    const chipVisible = await selectedChip.isVisible().catch(() => false);
    const remainingValue = normalizeText(await readEditableValue(recipientInput.locator));

    if (!chipVisible && remainingValue.toLowerCase() === recipient.full_name.toLowerCase()) {
      throw new LinkedInBuddyError(
        "TARGET_NOT_FOUND",
        `Could not resolve recipient "${recipient.full_name}" in the LinkedIn composer.`,
        {
          recipient_name: recipient.full_name,
          recipient_profile_url: recipient.profile_url
        }
      );
    }
  }
}

async function openProfileMessageComposer(input: {
  artifactPaths: string[];
  page: Page;
  recipient: LinkedInInboxRecipient;
  runtime: LinkedInMessagingRuntime;
}): Promise<void> {
  await input.page.goto(input.recipient.profile_url, {
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(input.page);

  const messageRegex = buildLinkedInSelectorPhraseRegex(
    "message",
    input.runtime.selectorLocale,
    { exact: true }
  );
  const messageRegexHint = formatLinkedInSelectorRegexHint(
    "message",
    input.runtime.selectorLocale,
    { exact: true }
  );
  const topCardRoot = input.page.locator("main .pv-top-card, .pv-top-card, main").first();
  const messageButton = await findVisibleLocatorOrThrow(
    input.page,
    [
      {
        key: "topcard-role-button-message",
        selectorHint: `topCard.getByRole(button, ${messageRegexHint})`,
        locatorFactory: () => topCardRoot.getByRole("button", { name: messageRegex })
      },
      {
        key: "topcard-button-text-message",
        selectorHint: `topCard button hasText ${messageRegexHint}`,
        locatorFactory: () => topCardRoot.locator("button").filter({ hasText: messageRegex })
      },
      {
        key: "page-role-button-message",
        selectorHint: `page.getByRole(button, ${messageRegexHint})`,
        locatorFactory: (targetPage) =>
          targetPage.getByRole("button", { name: messageRegex })
      },
      {
        key: "profile-message-data-control",
        selectorHint: "button[data-control-name*='message']",
        locatorFactory: (targetPage) =>
          targetPage.locator("button[data-control-name*='message']")
      },
      {
        key: "profile-message-main-button-text",
        selectorHint: "main button hasText message",
        locatorFactory: (targetPage) =>
          targetPage
            .locator("main button, .pv-top-card button")
            .filter({ hasText: messageRegex })
      }
    ],
    "profile_message_button",
    input.artifactPaths
  );
  await messageButton.locator.click({ timeout: 5_000 });
  await input.page.waitForTimeout(600);
  await waitForNetworkIdleBestEffort(input.page);
  await findVisibleLocatorOrThrow(
    input.page,
    createMessageComposerSelectors(input.runtime),
    "message_composer",
    input.artifactPaths
  );
}

async function openAddRecipientsFlow(input: {
  artifactPaths: string[];
  page: Page;
  runtime: LinkedInMessagingRuntime;
}): Promise<void> {
  const directAddRecipients = await findVisibleLocator(
    input.page,
    createAddRecipientsButtonSelectors(input.runtime)
  );
  if (directAddRecipients) {
    await directAddRecipients.locator.click({ timeout: 5_000 });
    await input.page.waitForTimeout(500);
    return;
  }

  await clickThreadMenuAction({
    actionType: ADD_RECIPIENTS_ACTION_TYPE,
    artifactPaths: input.artifactPaths,
    page: input.page,
    runtime: input.runtime,
    phraseKey: "add_people"
  });
}

async function maybeFinalizeAddRecipients(input: {
  artifactPaths: string[];
  page: Page;
  runtime: LinkedInMessagingRuntime;
}): Promise<void> {
  const finalizeButton = await findVisibleLocator(
    input.page,
    createFinalizeRecipientsSelectors(input.runtime)
  );
  if (!finalizeButton) {
    return;
  }

  await finalizeButton.locator.click({ timeout: 5_000 });
  await input.page.waitForTimeout(500);
}

function validateThreadTarget(
  action: PreparedAction,
  threadDetail: ThreadDetailSnapshot,
  currentUrl: string
): void {
  const expectedThreadId = getOptionalStringField(action.target, "thread_id");
  if (expectedThreadId && expectedThreadId !== threadDetail.thread_id) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Thread ID mismatch while confirming prepared send_message action.",
      {
        action_id: action.id,
        expected_thread_id: expectedThreadId,
        actual_thread_id: threadDetail.thread_id,
        current_url: currentUrl
      }
    );
  }

  const expectedParticipantName = getOptionalStringField(
    action.target,
    "participant_name"
  );

  if (
    expectedParticipantName &&
    !threadDetail.title.toLowerCase().includes(expectedParticipantName.toLowerCase())
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Thread participant validation failed before sending message.",
      {
        action_id: action.id,
        expected_participant_name: expectedParticipantName,
        actual_title: threadDetail.title,
        current_url: currentUrl
      }
    );
  }
}

async function executeThreadReaction(input: {
  actionId: string;
  artifactPaths: string[];
  page: Page;
  profileName: string;
  reaction: LinkedInInboxReaction;
  runtime: LinkedInMessagingRuntime;
  threadUrl: string;
  messageTarget: LinkedInThreadMessageTarget;
}): Promise<{
  alreadyReacted: boolean;
  messageSelectorKey: string;
  reactionButtonKey: string;
  reactionMenuKey: string | null;
}> {
  const detail = await extractThreadDetailWithNetwork(input.page, input.threadUrl, 20);
  const messageLocator = await findThreadMessageLocator(
    input.page,
    input.messageTarget,
    input.artifactPaths
  );

  await messageLocator.locator.hover({ timeout: 5_000 }).catch(() => undefined);

  let reactionButton = await findVisibleLocatorOrThrow(
    input.page,
    createMessageReactionButtonSelectors(messageLocator.locator, input.runtime),
    "message_reaction_button",
    input.artifactPaths
  );

  const alreadyReacted = await isDesiredMessageReactionActive(
    reactionButton.locator,
    input.reaction,
    input.runtime.selectorLocale
  );

  let reactionMenuKey: string | null = null;
  let verifiedReaction = alreadyReacted;

  if (!alreadyReacted) {
    await reactionButton.locator.click({ timeout: 5_000 });
    await input.page.waitForTimeout(400);

    const reactionMenuButton = await findVisibleLocatorOrThrow(
      input.page,
      createMessageReactionMenuSelectors(input.runtime, input.reaction),
      "message_reaction_menu_button",
      input.artifactPaths
    );
    reactionMenuKey = reactionMenuButton.key;
    await reactionMenuButton.locator.click({ timeout: 5_000 });

    verifiedReaction = await waitForCondition(
      async () =>
        isDesiredMessageReactionActive(
          reactionButton.locator,
          input.reaction,
          input.runtime.selectorLocale
        ),
      6_000
    );
  }

  if (!verifiedReaction) {
    const refreshedDetail = await extractThreadDetailWithNetwork(
      input.page,
      detail.thread_url,
      20
    );
    const refreshedMessageLocator = await findThreadMessageLocator(
      input.page,
      {
        ...input.messageTarget,
        ...(refreshedDetail.messages[input.messageTarget.index]
          ? {
              text: refreshedDetail.messages[input.messageTarget.index]!.text
            }
          : {})
      },
      input.artifactPaths
    );
    await refreshedMessageLocator.locator.hover({ timeout: 5_000 }).catch(
      () => undefined
    );
    reactionButton = await findVisibleLocatorOrThrow(
      input.page,
      createMessageReactionButtonSelectors(
        refreshedMessageLocator.locator,
        input.runtime
      ),
      "message_reaction_button",
      input.artifactPaths
    );
    verifiedReaction = await isDesiredMessageReactionActive(
      reactionButton.locator,
      input.reaction,
      input.runtime.selectorLocale
    );
  }

  if (!verifiedReaction) {
    const reactionState = await getMessageReactionButtonState(
      reactionButton.locator,
      input.runtime.selectorLocale
    );
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Message reaction action could not be verified on the target thread.",
      {
        action_id: input.actionId,
        profile_name: input.profileName,
        thread_url: detail.thread_url,
        thread_id: detail.thread_id,
        requested_reaction: input.reaction,
        current_reaction: reactionState.reaction,
        current_reacted: reactionState.reacted,
        current_aria_label: reactionState.ariaLabel,
        message_index: input.messageTarget.index,
        message_author: input.messageTarget.author,
        message_preview: createVerificationSnippet(input.messageTarget.text)
      }
    );
  }

  return {
    alreadyReacted,
    messageSelectorKey: messageLocator.key,
    reactionButtonKey: reactionButton.key,
    reactionMenuKey
  };
}

type ThreadVerificationMode = "reverse_menu_action_visible";

async function executeThreadMenuMutation(input: {
  actionId?: string;
  actionType: string;
  artifactPaths: string[];
  page: Page;
  profileName: string;
  runtime: LinkedInMessagingRuntime;
  threadUrl: string;
  menuPhraseKey: LocalizedInboxPhraseKey;
  verification: ThreadVerificationMode;
  reverseMenuPhraseKey?: LocalizedInboxPhraseKey;
}): Promise<{
  selectorKey: string;
  threadDetail: ThreadDetailSnapshot;
}> {
  const threadDetail = await extractThreadDetailWithNetwork(input.page, input.threadUrl, 5);
  const selectorKey = await clickThreadMenuAction({
    actionType: input.actionType,
    artifactPaths: input.artifactPaths,
    page: input.page,
    runtime: input.runtime,
    phraseKey: input.menuPhraseKey
  });

  let verified = false;
  if (input.reverseMenuPhraseKey) {
    const reverseMenuPhraseKey = input.reverseMenuPhraseKey;
    verified = await waitForCondition(
      async () =>
        verifyReverseThreadMenuActionVisible({
          artifactPaths: input.artifactPaths,
          page: input.page,
          runtime: input.runtime,
          threadUrl: input.threadUrl,
          phraseKey: reverseMenuPhraseKey
        }),
      10_000
    );
  }

  if (!verified) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      `Thread action ${input.actionType} could not be verified.`,
      {
        action_id: input.actionId,
        profile_name: input.profileName,
        thread_url: input.threadUrl,
        verification: input.verification
      }
    );
  }

  return {
    selectorKey,
    threadDetail
  };
}

export class LinkedInInboxService {
  constructor(private readonly runtime: LinkedInInboxRuntime) {}

  private async resolveRecipients(
    profileName: string,
    recipients: string[]
  ): Promise<LinkedInInboxRecipient[]> {
    const normalizedTargets = normalizeRecipientTargets(recipients);
    const resolvedRecipients: LinkedInInboxRecipient[] = [];
    const seen = new Set<string>();

    for (const recipientTarget of normalizedTargets) {
      const profile = await this.runtime.profile.viewProfile({
        profileName,
        target: recipientTarget
      });
      const resolvedRecipient = toInboxRecipientFromProfile(profile);
      if (!resolvedRecipient.full_name || !resolvedRecipient.profile_url) {
        throw new LinkedInBuddyError(
          "TARGET_NOT_FOUND",
          `Could not resolve LinkedIn recipient "${recipientTarget}".`,
          {
            profile_name: profileName,
            recipient: recipientTarget
          }
        );
      }

      const dedupeKey = normalizeLinkedInProfileUrl(resolvedRecipient.profile_url);
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      resolvedRecipients.push(resolvedRecipient);
    }

    if (resolvedRecipients.length === 0) {
      throw new LinkedInBuddyError(
        "TARGET_NOT_FOUND",
        "Could not resolve any LinkedIn recipients.",
        {
          profile_name: profileName,
          recipient_count: recipients.length
        }
      );
    }

    return resolvedRecipients;
  }

  async searchRecipients(
    input: SearchRecipientsInput
  ): Promise<SearchRecipientsResult> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = input.limit ?? 10;

    if (!query) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    try {
      const search = await this.runtime.search.search({
        profileName,
        query,
        category: "people",
        limit
      });

      if (search.category !== "people") {
        throw new LinkedInBuddyError(
          "UNKNOWN",
          "Expected LinkedIn people search results for recipient search.",
          {
            profile_name: profileName,
            query
          }
        );
      }

      const recipients = search.results
        .map((result) => toInboxRecipientFromSearchResult(result))
        .filter(
          (recipient) =>
            recipient.full_name.length > 0 || recipient.profile_url.length > 0
        )
        .slice(0, Math.max(1, limit));

      return {
        query,
        count: recipients.length,
        recipients
      };
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to search LinkedIn messaging recipients.",
        {
          profile_name: profileName,
          query
        }
      );
    }
  }

  async listThreads(input: ListThreadsInput): Promise<LinkedInThreadSummary[]> {
    const profileName = input.profileName ?? "default";
    const limit = input.limit ?? 20;
    const unreadOnly = input.unreadOnly ?? false;

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const threads = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          const conversationsResponsePromise =
            waitForMessengerConversationsResponse(page);
          await page.goto(LINKEDIN_MESSAGING_URL, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForInboxListSurface(page);
          const conversationsResponse = await conversationsResponsePromise;
          if (conversationsResponse) {
            const networkThreads =
              await extractThreadSummariesFromNetwork(conversationsResponse);
            if (networkThreads.length > 0) {
              return networkThreads;
            }
          }

          return extractThreadSummaries(page);
        }
      );

      const filteredThreads = unreadOnly
        ? threads.filter((thread) => thread.unread_count > 0)
        : threads;

      return filteredThreads.slice(0, Math.max(1, limit)).map(toThreadSummary);
    } catch (error) {
      throw toAutomationError(error, "Failed to list LinkedIn inbox threads.", {
        profile_name: profileName
      });
    }
  }

  async getThread(input: GetThreadInput): Promise<LinkedInThreadDetail> {
    const profileName = input.profileName ?? "default";
    const threadUrl = resolveThreadUrl(input.thread);
    const messageLimit = input.limit ?? 20;

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const detail = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          return extractThreadDetailWithNetwork(page, threadUrl, messageLimit);
        }
      );

      return toThreadDetail(detail);
    } catch (error) {
      throw toAutomationError(error, "Failed to load LinkedIn thread.", {
        profile_name: profileName,
        thread: input.thread
      });
    }
  }

  async prepareReply(input: PrepareReplyInput): Promise<PrepareReplyResult> {
    const profileName = input.profileName ?? "default";
    const threadUrl = resolveThreadUrl(input.thread);
    const text = normalizeText(input.text);

    if (!text) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Reply text must not be empty."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
      config: SEND_MESSAGE_RATE_LIMIT_CONFIG,
      message: createPrepareRateLimitMessage(SEND_MESSAGE_ACTION_TYPE)
    });

    try {
      const prepared = await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          const threadDetail = await extractThreadDetailWithNetwork(
            page,
            threadUrl,
            12
          );
          const screenshotPath = `linkedin/screenshot-prepare-${Date.now()}.png`;
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: "prepare_reply",
            profile_name: profileName,
            thread_url: threadDetail.thread_url
          });

          const target = {
            profile_name: profileName,
            thread_id: threadDetail.thread_id,
            thread_url: threadDetail.thread_url,
            title: threadDetail.title,
            participant_name: inferParticipantName(threadDetail.title)
          };

          const preview = {
            summary: `Send message to "${threadDetail.title}"`,
            target,
            outbound: {
              text
            },
            artifacts: [
              {
                type: "screenshot",
                path: screenshotPath
              }
            ],
            rate_limit: formatRateLimitState(rateLimitState)
          } satisfies Record<string, unknown>;

          const prepareInput = {
            actionType: SEND_MESSAGE_ACTION_TYPE,
            target,
            payload: {
              text
            },
            preview,
            ...(input.operatorNote
              ? {
                  operatorNote: input.operatorNote
                }
              : {})
          };

          return this.runtime.twoPhaseCommit.prepare(prepareInput);
        }
      );

      return {
        preparedActionId: prepared.preparedActionId,
        confirmToken: prepared.confirmToken,
        expiresAtMs: prepared.expiresAtMs,
        preview: prepared.preview
      };
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn reply.", {
        profile_name: profileName,
        thread: input.thread
      });
    }
  }

  async prepareNewThread(
    input: PrepareNewThreadInput
  ): Promise<PrepareNewThreadResult> {
    const profileName = input.profileName ?? "default";
    const text = normalizeText(input.text);

    if (!text) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Message text must not be empty."
      );
    }

    try {
      const recipients = await this.resolveRecipients(profileName, input.recipients);
      const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
        config: SEND_MESSAGE_RATE_LIMIT_CONFIG,
        message: createPrepareRateLimitMessage(SEND_NEW_THREAD_ACTION_TYPE)
      });
      const target = {
        message_mode: "new_thread",
        profile_name: profileName,
        primary_recipient_name: recipients[0]?.full_name ?? "",
        primary_recipient_profile_url: recipients[0]?.profile_url ?? "",
        recipient_count: recipients.length,
        recipients: recipients.map((recipient) => toRecipientPreviewRecord(recipient))
      };
      const preview = {
        summary:
          recipients.length === 1
            ? `Start a new message thread with "${recipients[0]!.full_name}"`
            : `Start a new message thread with ${recipients.length} recipients`,
        target,
        outbound: {
          text
        },
        rate_limit: formatRateLimitState(rateLimitState)
      } satisfies Record<string, unknown>;
      const prepared = this.runtime.twoPhaseCommit.prepare({
        actionType: SEND_NEW_THREAD_ACTION_TYPE,
        target,
        payload: {
          text
        },
        preview,
        ...(input.operatorNote
          ? {
              operatorNote: input.operatorNote
            }
          : {})
      });

      return {
        preparedActionId: prepared.preparedActionId,
        confirmToken: prepared.confirmToken,
        expiresAtMs: prepared.expiresAtMs,
        preview: prepared.preview
      };
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare a new LinkedIn message thread.",
        {
          profile_name: profileName,
          recipient_count: input.recipients.length
        }
      );
    }
  }

  async prepareAddRecipients(
    input: PrepareAddRecipientsInput
  ): Promise<PrepareAddRecipientsResult> {
    const profileName = input.profileName ?? "default";

    try {
      const recipients = await this.resolveRecipients(profileName, input.recipients);
      const threadDetail = await this.getThread({
        profileName,
        thread: input.thread,
        limit: 5
      });
      const existingParticipants = new Set(
        parseParticipantNames(threadDetail.title).map((name) => name.toLowerCase())
      );
      const recipientsToAdd = recipients.filter(
        (recipient) => !existingParticipants.has(recipient.full_name.toLowerCase())
      );

      if (recipientsToAdd.length === 0) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "All requested recipients are already present in the thread.",
          {
            profile_name: profileName,
            thread_id: threadDetail.thread_id,
            thread_title: threadDetail.title
          }
        );
      }

      const target = {
        profile_name: profileName,
        thread_id: threadDetail.thread_id,
        thread_url: threadDetail.thread_url,
        title: threadDetail.title
      };
      const previewRecipients = recipientsToAdd.map((recipient) =>
        toRecipientPreviewRecord(recipient)
      );
      const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
        config: ADD_RECIPIENTS_RATE_LIMIT_CONFIG,
        message: createPrepareRateLimitMessage(ADD_RECIPIENTS_ACTION_TYPE)
      });
      const preview = {
        summary:
          recipientsToAdd.length === 1
            ? `Add "${recipientsToAdd[0]!.full_name}" to "${threadDetail.title}"`
            : `Add ${recipientsToAdd.length} recipients to "${threadDetail.title}"`,
        target: {
          ...target,
          recipient_count: recipientsToAdd.length,
          recipients: previewRecipients
        },
        rate_limit: formatRateLimitState(rateLimitState)
      } satisfies Record<string, unknown>;
      const prepared = this.runtime.twoPhaseCommit.prepare({
        actionType: ADD_RECIPIENTS_ACTION_TYPE,
        target,
        payload: {
          recipients: previewRecipients
        },
        preview,
        ...(input.operatorNote
          ? {
              operatorNote: input.operatorNote
            }
          : {})
      });

      return {
        preparedActionId: prepared.preparedActionId,
        confirmToken: prepared.confirmToken,
        expiresAtMs: prepared.expiresAtMs,
        preview: prepared.preview
      };
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to prepare LinkedIn recipient updates for the thread.",
        {
          profile_name: profileName,
          thread: input.thread,
          recipient_count: input.recipients.length
        }
      );
    }
  }

  async prepareReact(input: PrepareReactInput): Promise<PrepareReactResult> {
    const profileName = input.profileName ?? "default";
    const reaction = normalizeLinkedInInboxReaction(input.reaction, "like");

    try {
      const threadDetail = await this.getThread({
        profileName,
        thread: input.thread,
        limit: 20
      });
      const messageTarget = toThreadMessageTarget(threadDetail, input.messageIndex);
      const target = {
        profile_name: profileName,
        thread_id: threadDetail.thread_id,
        thread_url: threadDetail.thread_url,
        title: threadDetail.title,
        participant_name: inferParticipantName(threadDetail.title),
        message: toThreadMessageTargetRecord(messageTarget)
      };
      const rateLimitState = peekRateLimitOrThrow(this.runtime.rateLimiter, {
        config: REACT_MESSAGE_RATE_LIMIT_CONFIG,
        message: createPrepareRateLimitMessage(REACT_MESSAGE_ACTION_TYPE)
      });
      const preview = {
        summary: `React (${reaction}) to message ${messageTarget.index} in "${threadDetail.title}"`,
        target,
        outbound: {
          action: "react",
          reaction
        },
        supported_reactions: LINKEDIN_INBOX_REACTION_TYPES,
        rate_limit: formatRateLimitState(rateLimitState)
      } satisfies Record<string, unknown>;

      const prepared = this.runtime.twoPhaseCommit.prepare({
        actionType: REACT_MESSAGE_ACTION_TYPE,
        target,
        payload: {
          reaction
        },
        preview,
        ...(input.operatorNote
          ? {
              operatorNote: input.operatorNote
            }
          : {})
      });

      return {
        preparedActionId: prepared.preparedActionId,
        confirmToken: prepared.confirmToken,
        expiresAtMs: prepared.expiresAtMs,
        preview: prepared.preview
      };
    } catch (error) {
      throw toAutomationError(error, "Failed to prepare LinkedIn message reaction.", {
        profile_name: profileName,
        thread: input.thread,
        reaction,
        message_index: input.messageIndex
      });
    }
  }

  private async executeDirectThreadAction(input: {
    actionType: string;
    menuPhraseKey: LocalizedInboxPhraseKey;
    profileName: string;
    rateLimitConfig: ConsumeRateLimitInput;
    resultKey: "archived" | "unarchived" | "marked_unread" | "muted";
    thread: string;
    verification: ThreadVerificationMode;
    reverseMenuPhraseKey?: LocalizedInboxPhraseKey;
  }): Promise<
    ArchiveThreadResult | UnarchiveThreadResult | MarkUnreadResult | MuteThreadResult
  > {
    const threadUrl = resolveThreadUrl(input.thread);

    await this.runtime.auth.ensureAuthenticated({
      profileName: input.profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName: input.profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          const artifactPaths: string[] = [];
          const rateLimitState = consumeRateLimitOrThrow(this.runtime.rateLimiter, {
            config: input.rateLimitConfig,
            message: createConfirmRateLimitMessage(input.actionType),
            details: {
              profile_name: input.profileName,
              thread_url: threadUrl
            }
          });

          const mutation = await executeThreadMenuMutation({
            actionType: input.actionType,
            artifactPaths,
            page,
            profileName: input.profileName,
            runtime: this.runtime,
            threadUrl,
            menuPhraseKey: input.menuPhraseKey,
            verification: input.verification,
            ...(input.reverseMenuPhraseKey
              ? {
                  reverseMenuPhraseKey: input.reverseMenuPhraseKey
                }
              : {})
          });

          const screenshotPath = `linkedin/screenshot-${input.actionType}-${Date.now()}.png`;
          await captureScreenshotArtifact(this.runtime, page, screenshotPath, {
            action: input.actionType,
            profile_name: input.profileName,
            thread_url: mutation.threadDetail.thread_url,
            thread_id: mutation.threadDetail.thread_id,
            selector_key: mutation.selectorKey
          });
          artifactPaths.push(screenshotPath);

          const commonResult = {
            thread_id: mutation.threadDetail.thread_id,
            thread_url: mutation.threadDetail.thread_url,
            artifacts: artifactPaths,
            rate_limit: formatRateLimitState(rateLimitState)
          };

          switch (input.resultKey) {
            case "archived":
              return {
                archived: true,
                ...commonResult
              };
            case "unarchived":
              return {
                unarchived: true,
                ...commonResult
              };
            case "marked_unread":
              return {
                marked_unread: true,
                ...commonResult
              };
            case "muted":
              return {
                muted: true,
                ...commonResult
              };
          }
        }
      );
    } catch (error) {
      throw toAutomationError(
        error,
        `Failed to execute LinkedIn ${input.actionType} action.`,
        {
          profile_name: input.profileName,
          thread: input.thread
        }
      );
    }
  }

  async archiveThread(input: ThreadActionInput): Promise<ArchiveThreadResult> {
    const profileName = input.profileName ?? "default";
    const result = await this.executeDirectThreadAction({
      actionType: ARCHIVE_THREAD_ACTION_TYPE,
      menuPhraseKey: "archive_thread",
      profileName,
      rateLimitConfig: ARCHIVE_THREAD_RATE_LIMIT_CONFIG,
      resultKey: "archived",
      thread: input.thread,
      verification: "reverse_menu_action_visible",
      reverseMenuPhraseKey: "unarchive_thread"
    });

    return result as ArchiveThreadResult;
  }

  async unarchiveThread(input: ThreadActionInput): Promise<UnarchiveThreadResult> {
    const profileName = input.profileName ?? "default";
    const result = await this.executeDirectThreadAction({
      actionType: UNARCHIVE_THREAD_ACTION_TYPE,
      menuPhraseKey: "unarchive_thread",
      profileName,
      rateLimitConfig: UNARCHIVE_THREAD_RATE_LIMIT_CONFIG,
      resultKey: "unarchived",
      thread: input.thread,
      verification: "reverse_menu_action_visible",
      reverseMenuPhraseKey: "archive_thread"
    });

    return result as UnarchiveThreadResult;
  }

  async markUnread(input: ThreadActionInput): Promise<MarkUnreadResult> {
    const profileName = input.profileName ?? "default";
    const result = await this.executeDirectThreadAction({
      actionType: MARK_UNREAD_ACTION_TYPE,
      menuPhraseKey: "mark_unread",
      profileName,
      rateLimitConfig: MARK_UNREAD_RATE_LIMIT_CONFIG,
      resultKey: "marked_unread",
      thread: input.thread,
      verification: "reverse_menu_action_visible",
      reverseMenuPhraseKey: "mark_read"
    });

    return result as MarkUnreadResult;
  }

  async muteThread(input: ThreadActionInput): Promise<MuteThreadResult> {
    const profileName = input.profileName ?? "default";
    const result = await this.executeDirectThreadAction({
      actionType: MUTE_THREAD_ACTION_TYPE,
      menuPhraseKey: "mute_conversation",
      profileName,
      rateLimitConfig: MUTE_THREAD_RATE_LIMIT_CONFIG,
      resultKey: "muted",
      thread: input.thread,
      verification: "reverse_menu_action_visible",
      reverseMenuPhraseKey: "unmute_conversation"
    });

    return result as MuteThreadResult;
  }
}

class SendMessageActionExecutor
  implements ActionExecutor<LinkedInMessagingRuntime>
{
  async execute(input: {
    runtime: LinkedInMessagingRuntime;
    action: PreparedAction;
  }): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const threadUrl = getRequiredStringField(
      action.target,
      "thread_url",
      action.id,
      "target"
    );
    const text = getRequiredStringField(action.payload, "text", action.id, "payload");

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: SEND_MESSAGE_ACTION_TYPE,
          profileName,
          targetUrl: threadUrl,
          persistTraceOnSuccess: true,
          dismissOverlays: {
            selectorLocale: runtime.selectorLocale,
            logger: runtime.logger
          },
          metadata: {
            thread_url: threadUrl,
            selector_context: SEND_MESSAGE_ACTION_TYPE
          },
          errorDetails: {
            selector_context: SEND_MESSAGE_ACTION_TYPE,
            thread_url: threadUrl
          },
          mapError: (error) =>
            toAutomationError(error, "Failed to execute LinkedIn send_message action.", {
              selector_context: SEND_MESSAGE_ACTION_TYPE,
              thread_url: threadUrl
            }),
          execute: async () => {
            const artifactPaths: string[] = [];

            const detail = await extractThreadDetailWithNetwork(page, threadUrl, 20);
            validateThreadTarget(action, detail, page.url());

            consumeRateLimitOrThrow(runtime.rateLimiter, {
              config: SEND_MESSAGE_RATE_LIMIT_CONFIG,
              message: createConfirmRateLimitMessage(SEND_MESSAGE_ACTION_TYPE),
              details: {
                action_id: action.id,
                profile_name: profileName,
                thread_url: threadUrl
              }
            });

            await fillAndSendMessage({
              actionId: action.id,
              actionType: SEND_MESSAGE_ACTION_TYPE,
              artifactMetadata: {
                thread_url: threadUrl
              },
              artifactPaths,
              page,
              profileName,
              runtime,
              text
            });

            return {
              ok: true,
              result: {
                sent: true,
                thread_url: threadUrl
              },
              artifacts: artifactPaths
            };
          }
        });
      }
    );
  }
}

class SendNewThreadActionExecutor
  implements ActionExecutor<LinkedInMessagingRuntime>
{
  async execute(input: {
    runtime: LinkedInMessagingRuntime;
    action: PreparedAction;
  }): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const recipients = getRequiredPreparedRecipients(
      action.target,
      "recipients",
      action.id,
      "target"
    );
    const text = getRequiredStringField(action.payload, "text", action.id, "payload");
    const primaryRecipientUrl =
      getOptionalStringField(action.target, "primary_recipient_profile_url") ??
      recipients[0]?.profile_url ??
      LINKEDIN_MESSAGING_URL;

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: SEND_NEW_THREAD_ACTION_TYPE,
          profileName,
          targetUrl: primaryRecipientUrl,
          persistTraceOnSuccess: true,
          dismissOverlays: {
            selectorLocale: runtime.selectorLocale,
            logger: runtime.logger
          },
          metadata: {
            primary_recipient_profile_url: primaryRecipientUrl,
            recipient_count: recipients.length,
            selector_context: SEND_NEW_THREAD_ACTION_TYPE
          },
          errorDetails: {
            primary_recipient_profile_url: primaryRecipientUrl,
            recipient_count: recipients.length,
            selector_context: SEND_NEW_THREAD_ACTION_TYPE
          },
          mapError: (error) =>
            toAutomationError(
              error,
              "Failed to execute LinkedIn new-thread send action.",
              {
                primary_recipient_profile_url: primaryRecipientUrl,
                recipient_count: recipients.length,
                selector_context: SEND_NEW_THREAD_ACTION_TYPE
              }
            ),
          execute: async () => {
            const artifactPaths: string[] = [];
            consumeRateLimitOrThrow(runtime.rateLimiter, {
              config: SEND_MESSAGE_RATE_LIMIT_CONFIG,
              message: createConfirmRateLimitMessage(SEND_NEW_THREAD_ACTION_TYPE),
              details: {
                action_id: action.id,
                profile_name: profileName,
                recipient_count: recipients.length
              }
            });

            if (recipients.length === 1 && recipients[0]) {
              await openProfileMessageComposer({
                artifactPaths,
                page,
                recipient: recipients[0],
                runtime
              });
            } else {
              await page.goto(LINKEDIN_MESSAGING_URL, {
                waitUntil: "domcontentloaded"
              });
              await waitForNetworkIdleBestEffort(page);
              await waitForInboxListSurface(page);
              await openNewMessageComposer(page, runtime, artifactPaths);
              await selectRecipientsInComposer({
                artifactPaths,
                page,
                recipients,
                runtime
              });
            }

            await fillAndSendMessage({
              actionId: action.id,
              actionType: SEND_NEW_THREAD_ACTION_TYPE,
              artifactMetadata: {
                primary_recipient_profile_url: primaryRecipientUrl,
                recipient_count: recipients.length
              },
              artifactPaths,
              page,
              profileName,
              runtime,
              text
            });

            return {
              ok: true,
              result: {
                sent: true,
                recipient_count: recipients.length,
                thread_url: page.url().includes("/messaging/thread/") ? page.url() : null
              },
              artifacts: artifactPaths
            };
          }
        });
      }
    );
  }
}

class AddRecipientsActionExecutor
  implements ActionExecutor<LinkedInMessagingRuntime>
{
  async execute(input: {
    runtime: LinkedInMessagingRuntime;
    action: PreparedAction;
  }): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const threadUrl = getRequiredStringField(
      action.target,
      "thread_url",
      action.id,
      "target"
    );
    const recipients = getRequiredPreparedRecipients(
      action.payload,
      "recipients",
      action.id,
      "payload"
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: ADD_RECIPIENTS_ACTION_TYPE,
          profileName,
          targetUrl: threadUrl,
          persistTraceOnSuccess: true,
          dismissOverlays: {
            selectorLocale: runtime.selectorLocale,
            logger: runtime.logger
          },
          metadata: {
            recipient_count: recipients.length,
            selector_context: ADD_RECIPIENTS_ACTION_TYPE,
            thread_url: threadUrl
          },
          errorDetails: {
            recipient_count: recipients.length,
            selector_context: ADD_RECIPIENTS_ACTION_TYPE,
            thread_url: threadUrl
          },
          mapError: (error) =>
            toAutomationError(error, "Failed to execute LinkedIn add_recipients action.", {
              recipient_count: recipients.length,
              selector_context: ADD_RECIPIENTS_ACTION_TYPE,
              thread_url: threadUrl
            }),
          execute: async () => {
            const artifactPaths: string[] = [];
            const detail = await extractThreadDetailWithNetwork(page, threadUrl, 20);
            validateThreadTarget(action, detail, page.url());

            consumeRateLimitOrThrow(runtime.rateLimiter, {
              config: ADD_RECIPIENTS_RATE_LIMIT_CONFIG,
              message: createConfirmRateLimitMessage(ADD_RECIPIENTS_ACTION_TYPE),
              details: {
                action_id: action.id,
                profile_name: profileName,
                recipient_count: recipients.length,
                thread_url: threadUrl
              }
            });

            await openAddRecipientsFlow({
              artifactPaths,
              page,
              runtime
            });
            await selectRecipientsInComposer({
              artifactPaths,
              page,
              recipients,
              runtime
            });
            await maybeFinalizeAddRecipients({
              artifactPaths,
              page,
              runtime
            });

            const postUpdateScreenshot = `linkedin/screenshot-confirm-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, postUpdateScreenshot, {
              action: ADD_RECIPIENTS_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              recipient_count: recipients.length,
              thread_url: threadUrl
            });
            artifactPaths.push(postUpdateScreenshot);

            return {
              ok: true,
              result: {
                recipients_added: recipients.length,
                thread_url: threadUrl
              },
              artifacts: artifactPaths
            };
          }
        });
      }
    );
  }
}

class ReactMessageActionExecutor
  implements ActionExecutor<LinkedInMessagingRuntime>
{
  async execute(input: {
    runtime: LinkedInMessagingRuntime;
    action: PreparedAction;
  }): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const threadUrl = getRequiredStringField(
      action.target,
      "thread_url",
      action.id,
      "target"
    );
    const requestedReaction =
      typeof action.payload.reaction === "string"
        ? action.payload.reaction
        : undefined;
    const reaction = normalizeLinkedInInboxReaction(requestedReaction, "like");
    const messageTarget = parsePreparedThreadMessageTarget(
      action.target,
      "message",
      action.id,
      "target"
    );

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        return executeConfirmActionWithArtifacts({
          runtime,
          context,
          page,
          actionId: action.id,
          actionType: REACT_MESSAGE_ACTION_TYPE,
          profileName,
          targetUrl: threadUrl,
          persistTraceOnSuccess: true,
          dismissOverlays: {
            selectorLocale: runtime.selectorLocale,
            logger: runtime.logger
          },
          metadata: {
            thread_url: threadUrl,
            requested_reaction: reaction,
            message_index: messageTarget.index,
            message_author: messageTarget.author
          },
          errorDetails: {
            thread_url: threadUrl,
            requested_reaction: reaction,
            message_index: messageTarget.index,
            message_author: messageTarget.author
          },
          mapError: (error) =>
            toAutomationError(error, "Failed to execute LinkedIn inbox reaction.", {
              thread_url: threadUrl,
              requested_reaction: reaction,
              message_index: messageTarget.index,
              message_author: messageTarget.author
            }),
          execute: async () => {
            const detail = await extractThreadDetailWithNetwork(page, threadUrl, 20);
            validateThreadTarget(action, detail, page.url());

            const rateLimitState = consumeRateLimitOrThrow(runtime.rateLimiter, {
              config: REACT_MESSAGE_RATE_LIMIT_CONFIG,
              message: createConfirmRateLimitMessage(REACT_MESSAGE_ACTION_TYPE),
              details: {
                action_id: action.id,
                profile_name: profileName,
                thread_url: threadUrl
              }
            });

            const artifactPaths: string[] = [];
            const reactionResult = await executeThreadReaction({
              actionId: action.id,
              artifactPaths,
              page,
              profileName,
              reaction,
              runtime,
              threadUrl,
              messageTarget
            });

            const screenshotPath = `linkedin/screenshot-confirm-${Date.now()}.png`;
            await captureScreenshotArtifact(runtime, page, screenshotPath, {
              action: REACT_MESSAGE_ACTION_TYPE,
              action_id: action.id,
              profile_name: profileName,
              thread_url: threadUrl,
              reaction,
              message_index: messageTarget.index,
              message_author: messageTarget.author,
              message_selector_key: reactionResult.messageSelectorKey,
              reaction_button_selector_key: reactionResult.reactionButtonKey,
              reaction_menu_selector_key: reactionResult.reactionMenuKey ?? undefined
            });
            artifactPaths.push(screenshotPath);

            return {
              ok: true,
              result: {
                reacted: true,
                reaction,
                already_reacted: reactionResult.alreadyReacted,
                message_index: messageTarget.index,
                message_author: messageTarget.author,
                thread_url: threadUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              },
              artifacts: artifactPaths
            };
          }
        });
      }
    );
  }
}

export function createLinkedInActionExecutors(): ActionExecutorRegistry<LinkedInMessagingRuntime> {
  return {
    [SEND_MESSAGE_ACTION_TYPE]: new SendMessageActionExecutor(),
    [SEND_NEW_THREAD_ACTION_TYPE]: new SendNewThreadActionExecutor(),
    [ADD_RECIPIENTS_ACTION_TYPE]: new AddRecipientsActionExecutor(),
    [REACT_MESSAGE_ACTION_TYPE]: new ReactMessageActionExecutor()
  };
}
