import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  errors as playwrightErrors,
  type BrowserContext,
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
  LinkedInAssistantError,
  asLinkedInAssistantError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import type { RateLimiter, RateLimiterState } from "./rateLimiter.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorRegistry,
  ActionExecutorResult,
  PreparedAction,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const SEND_MESSAGE_ACTION_TYPE = "send_message";
export const SEND_MESSAGE_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.messaging.send_message",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} as const;

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

export interface PrepareReplyResult {
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
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
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInMessagingRuntime>, "prepare">;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveThreadUrl(thread: string): string {
  const trimmedThread = thread.trim();
  if (!trimmedThread) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Thread identifier is required."
    );
  }

  if (isAbsoluteUrl(trimmedThread)) {
    const parsedUrl = new URL(trimmedThread);
    const threadId = parseThreadIdFromUrl(parsedUrl.toString());
    if (!threadId) {
      throw new LinkedInAssistantError(
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

  throw new LinkedInAssistantError(
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
): LinkedInAssistantError {
  if (error instanceof LinkedInAssistantError) {
    return error;
  }

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInAssistantError("TIMEOUT", message, details, { cause: error });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i.test(error.message)
  ) {
    return new LinkedInAssistantError("NETWORK_ERROR", message, details, {
      cause: error
    });
  }

  return asLinkedInAssistantError(error, "UNKNOWN", message);
}

function formatRateLimitState(
  state: RateLimiterState
): Record<string, number | boolean | string> {
  return {
    counter_key: state.counterKey,
    window_start_ms: state.windowStartMs,
    window_size_ms: state.windowSizeMs,
    count: state.count,
    limit: state.limit,
    remaining: state.remaining,
    allowed: state.allowed
  };
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
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

  throw new LinkedInAssistantError(
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
    throw new LinkedInAssistantError(
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

async function findVisibleLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[]
): Promise<{ locator: Locator; key: string }> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_000 });
      return { locator, key: candidate.key };
    } catch {
      // Try the next selector candidate.
    }
  }

  throw new LinkedInAssistantError(
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

function validateThreadTarget(
  action: PreparedAction,
  threadDetail: ThreadDetailSnapshot,
  currentUrl: string
): void {
  const expectedThreadId = getOptionalStringField(action.target, "thread_id");
  if (expectedThreadId && expectedThreadId !== threadDetail.thread_id) {
    throw new LinkedInAssistantError(
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
    throw new LinkedInAssistantError(
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

export class LinkedInInboxService {
  constructor(private readonly runtime: LinkedInInboxRuntime) {}

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
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Reply text must not be empty."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
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

          const rateLimitState = this.runtime.rateLimiter.peek(
            SEND_MESSAGE_RATE_LIMIT_CONFIG
          );

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

          const rateLimitState = runtime.rateLimiter.consume(
            SEND_MESSAGE_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn send_message confirm is rate limited for the current window.",
              {
                action_id: action.id,
                profile_name: profileName,
                thread_url: threadUrl,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

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

          const composerSelectors: SelectorCandidate[] = [
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
                targetPage.locator(
                  ".msg-form__contenteditable[contenteditable='true']"
                )
            },
            {
              key: "msg-form-contenteditable-fallback",
              selectorHint: ".msg-form [contenteditable='true']",
              locatorFactory: (targetPage) =>
                targetPage.locator(".msg-form [contenteditable='true']")
            }
          ];

          const composer = await findVisibleLocatorOrThrow(
            page,
            composerSelectors,
            "message_composer",
            artifactPaths
          );
          await composer.locator.click({ timeout: 3_000 });
          await composer.locator.fill(text, { timeout: 5_000 });

          const sendButtonSelectors: SelectorCandidate[] = [
            {
              key: "role-button-send",
              selectorHint: `getByRole(button, ${sendButtonRegexHint})`,
              locatorFactory: (targetPage) =>
                targetPage.getByRole("button", { name: sendButtonRegex })
            },
            {
              key: "msg-form-send-button",
              selectorHint: "button.msg-form__send-button",
              locatorFactory: (targetPage) =>
                targetPage.locator("button.msg-form__send-button")
            },
            {
              key: "msg-form-send-button-fallback",
              selectorHint: ".msg-form__send-button",
              locatorFactory: (targetPage) =>
                targetPage.locator(".msg-form__send-button")
            }
          ];

          const sendButton = await findVisibleLocatorOrThrow(
            page,
            sendButtonSelectors,
            "send_button",
            artifactPaths
          );
          await sendButton.locator.click({ timeout: 5_000 });

          await waitForMessageEcho(page, text);
          const postSendScreenshot = `linkedin/screenshot-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postSendScreenshot, {
            action: SEND_MESSAGE_ACTION_TYPE,
            action_id: action.id,
            profile_name: profileName,
            thread_url: threadUrl
          });
          artifactPaths.push(postSendScreenshot);

          return {
            ok: true,
            result: {
              sent: true
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
    [SEND_MESSAGE_ACTION_TYPE]: new SendMessageActionExecutor()
  };
}
