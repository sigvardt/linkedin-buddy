import {
  errors as playwrightErrors,
  type BrowserContext,
  type Locator,
  type Page
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ProfileManager } from "./profileManager.js";
import type { RateLimiter, RateLimitState } from "./rateLimiter.js";
import type {
  ActionExecutor,
  ActionExecutorRegistry,
  ActionExecutorResult,
  PreparedAction,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const SEND_MESSAGE_ACTION_TYPE = "send_message";
const SEND_MESSAGE_RATE_LIMIT_CONFIG = {
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
  auth: LinkedInAuthService;
  profileManager: ProfileManager;
  artifacts: ArtifactHelpers;
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

function formatRateLimitState(state: RateLimitState): Record<string, number | boolean | string> {
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
        ".msg-thread__link-to-profile .t-16",
        ".msg-thread__link-to-profile",
        ".msg-overlay-bubble-header__title",
        ".msg-entity-lockup__entity-title",
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

async function captureScreenshotArtifact(
  runtime: LinkedInMessagingRuntime,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
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

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      const threads = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(LINKEDIN_MESSAGING_URL, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle");
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

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      const detail = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
          await waitForThreadSurface(page);
          return extractThreadDetail(page, messageLimit);
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

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      const prepared = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
          await waitForThreadSurface(page);

          const threadDetail = await extractThreadDetail(page, 12);
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
    const tracePath = `linkedin/trace-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await runtime.auth.ensureAuthenticated({ profileName });

    return runtime.profileManager.runWithPersistentContext(
      profileName,
      { headless: true },
      async (context) => {
        const page = await getOrCreatePage(context);
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true
          });
          tracingStarted = true;

          await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
          await waitForThreadSurface(page);

          const detail = await extractThreadDetail(page, 20);
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

          const composerSelectors: SelectorCandidate[] = [
            {
              key: "role-textbox-write-message",
              selectorHint: "getByRole(textbox, /write a message|message/i)",
              locatorFactory: (targetPage) =>
                targetPage.getByRole("textbox", {
                  name: /write a message|message/i
                })
            },
            {
              key: "placeholder-write-message",
              selectorHint: "getByPlaceholder(/write a message/i)",
              locatorFactory: (targetPage) =>
                targetPage.getByPlaceholder(/write a message/i)
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
              selectorHint: "getByRole(button, /send/i)",
              locatorFactory: (targetPage) =>
                targetPage.getByRole("button", { name: /send/i })
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
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${SEND_MESSAGE_ACTION_TYPE}_error`,
              profile_name: profileName,
              thread_url: threadUrl
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best-effort error screenshot.
          }

          throw toAutomationError(
            error,
            "Failed to execute LinkedIn send_message action.",
            {
              action_id: action.id,
              current_url: page.url(),
              selector_context: SEND_MESSAGE_ACTION_TYPE,
              artifact_paths: artifactPaths
            }
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              runtime.artifacts.registerArtifact(tracePath, "application/zip", {
                action: SEND_MESSAGE_ACTION_TYPE,
                profile_name: profileName
              });
            } catch (error) {
              runtime.logger.log("warn", "linkedin.send_message.trace.stop_failed", {
                action_id: action.id,
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      }
    );
  }
}

export function createLinkedInActionExecutors(): ActionExecutorRegistry<LinkedInMessagingRuntime> {
  return {
    [SEND_MESSAGE_ACTION_TYPE]: new SendMessageActionExecutor()
  };
}
