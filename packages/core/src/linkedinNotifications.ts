import { type BrowserContext, type Locator, type Page, errors as playwrightErrors } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import type {
  ConsumeRateLimitInput,
  RateLimiter,
  RateLimiterState
} from "./rateLimiter.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

export interface LinkedInNotification {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  link: string;
  is_read: boolean;
}

export interface ListNotificationsInput {
  profileName?: string;
  limit?: number;
}

export interface NotificationActionInput {
  profileName?: string;
  notification: string;
  operatorNote?: string;
}

export interface GetNotificationPreferencesInput {
  profileName?: string;
  notification: string;
}

export interface LinkedInNotificationPreference {
  key: string;
  label: string;
  enabled: boolean;
}

export interface LinkedInNotificationPreferences {
  notification: LinkedInNotification;
  heading: string;
  settings_url: string | null;
  preferences: LinkedInNotificationPreference[];
}

export interface LinkedInNotificationPreferenceChangeInput {
  preference: string;
  enabled: boolean;
}

export interface PrepareUpdateNotificationPreferencesInput {
  profileName?: string;
  notification: string;
  changes: LinkedInNotificationPreferenceChangeInput[];
  operatorNote?: string;
}

export interface MarkReadNotificationResult {
  notification: LinkedInNotification;
  status: "marked_read" | "already_read";
  artifacts: string[];
  rate_limit: Record<string, boolean | number | string>;
}

export interface LinkedInNotificationsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  rateLimiter: RateLimiter;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInNotificationsRuntime
  extends LinkedInNotificationsExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInNotificationsExecutorRuntime>,
    "prepare"
  >;
}

type NotificationSnapshot = LinkedInNotification;

interface ResolvedNotificationTarget {
  snapshot: NotificationSnapshot;
  locator: Locator;
}

interface NotificationPreferencesDialogState {
  heading: string;
  settingsUrl: string | null;
  preferences: LinkedInNotificationPreference[];
}

interface PreparedNotificationPreferenceChange {
  key: string;
  label: string;
  previous_enabled: boolean;
  enabled: boolean;
}

type NotificationUiPhraseKey =
  | "change_preferences"
  | "delete_notification"
  | "show_less_like_this";

const NOTIFICATION_UI_PHRASES: Record<
  LinkedInSelectorLocale,
  Record<NotificationUiPhraseKey, readonly string[]>
> = {
  en: {
    change_preferences: ["Change notification preferences"],
    delete_notification: ["Delete notification"],
    show_less_like_this: ["Show less like this"]
  },
  da: {
    change_preferences: ["Skift notifikationspræferencer"],
    delete_notification: ["Slet notifikation"],
    show_less_like_this: ["Vis færre som dette"]
  }
};

const LINKEDIN_NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";
const MARK_READ_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.notifications.mark_read",
  windowSizeMs: 60 * 60 * 1000,
  limit: 40
} satisfies ConsumeRateLimitInput;
const DISMISS_NOTIFICATION_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.notifications.dismiss",
  windowSizeMs: 60 * 60 * 1000,
  limit: 25
} satisfies ConsumeRateLimitInput;
const UPDATE_NOTIFICATION_PREFERENCES_RATE_LIMIT_CONFIG = {
  counterKey: "linkedin.notifications.update_preferences",
  windowSizeMs: 60 * 60 * 1000,
  limit: 20
} satisfies ConsumeRateLimitInput;

export const DISMISS_NOTIFICATION_ACTION_TYPE = "notifications.dismiss";
export const UPDATE_NOTIFICATION_PREFERENCES_ACTION_TYPE =
  "notifications.update_preferences";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPhraseRegex(
  phrases: readonly string[],
  options: { exact?: boolean } = {}
): RegExp {
  const body = phrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$";
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "iu");
}

function buildNotificationPhraseRegex(
  key: NotificationUiPhraseKey,
  selectorLocale: LinkedInSelectorLocale,
  options: { exact?: boolean } = {}
): RegExp {
  return buildPhraseRegex(
    NOTIFICATION_UI_PHRASES[selectorLocale]?.[key] ??
      NOTIFICATION_UI_PHRASES.en[key],
    options
  );
}

function buildNotificationPhraseHint(
  key: NotificationUiPhraseKey,
  selectorLocale: LinkedInSelectorLocale
): string {
  const phrases =
    NOTIFICATION_UI_PHRASES[selectorLocale]?.[key] ??
    NOTIFICATION_UI_PHRASES.en[key];
  return phrases.map((phrase) => JSON.stringify(phrase)).join(" | ");
}

function readNotificationsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(1, Math.floor(value));
}

function toAbsoluteUrl(value: string): string {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return "";
  }

  try {
    return new URL(normalizedValue, LINKEDIN_NOTIFICATIONS_URL).toString();
  } catch {
    return normalizedValue;
  }
}

function canonicalizeComparableUrl(value: string): string {
  const absoluteValue = toAbsoluteUrl(value);
  if (!absoluteValue) {
    return "";
  }

  try {
    const url = new URL(absoluteValue);
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return absoluteValue.replace(/\/$/u, "");
  }
}

function slugifyNotificationPreference(label: string, fallbackIndex: number): string {
  const normalizedLabel = normalizeText(label).toLowerCase();
  const slug = normalizedLabel
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || `preference-${fallbackIndex + 1}`;
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

function getRequiredPreparedPreferenceChanges(
  payload: Record<string, unknown>,
  actionId: string
): PreparedNotificationPreferenceChange[] {
  const value = payload.changes;
  if (!Array.isArray(value) || value.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Prepared action ${actionId} is missing payload.changes.`,
      {
        action_id: actionId,
        key: "changes",
        location: "payload"
      }
    );
  }

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action ${actionId} has invalid payload.changes[${index}].`,
        {
          action_id: actionId,
          key: "changes",
          index,
          location: "payload"
        }
      );
    }

    const record = item as Record<string, unknown>;
    const key = record.key;
    const label = record.label;
    const enabled = record.enabled;
    const previousEnabled = record.previous_enabled;

    if (
      typeof key !== "string" ||
      key.trim().length === 0 ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      typeof enabled !== "boolean" ||
      typeof previousEnabled !== "boolean"
    ) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action ${actionId} has invalid payload.changes[${index}].`,
        {
          action_id: actionId,
          key: "changes",
          index,
          location: "payload"
        }
      );
    }

    return {
      key: key.trim(),
      label: label.trim(),
      enabled,
      previous_enabled: previousEnabled
    };
  });
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
    return new LinkedInAssistantError("TIMEOUT", message, details, {
      cause: error
    });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/iu.test(error.message)
  ) {
    return new LinkedInAssistantError("NETWORK_ERROR", message, details, {
      cause: error
    });
  }

  return asLinkedInAssistantError(error, "UNKNOWN", message);
}

function formatRateLimitState(
  state: RateLimiterState
): Record<string, boolean | number | string> {
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

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 250
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return condition();
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function waitForNotificationsSurface(page: Page): Promise<void> {
  const selectors = [
    ".nt-card",
    ".notification-card",
    "div[data-urn]",
    "article",
    "main"
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn notification content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function openNotificationsPage(page: Page): Promise<void> {
  await page.goto(LINKEDIN_NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded"
  });
  await waitForNetworkIdleBestEffort(page);
  await waitForNotificationsSurface(page);
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function indexNotificationCards(
  page: Page,
  limit: number
): Promise<NotificationSnapshot[]> {
  const snapshots = await page.evaluate((maxNotifications: number) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const toAbsoluteHref = (value: string | null | undefined): string => {
      const href = normalize(value);
      if (!href) {
        return "";
      }

      try {
        return new URL(href, globalThis.window.location.origin).toString();
      } catch {
        return href;
      }
    };

    const hashText = (value: string): string => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return `notif_${(hash >>> 0).toString(16).padStart(8, "0")}`;
    };

    const pickText = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const text = normalize(root.querySelector(selector)?.textContent);
        if (text) {
          return text;
        }
      }
      return "";
    };

    const pickHref = (root: ParentNode, selectors: string[]): string => {
      for (const selector of selectors) {
        const linkElement = root.querySelector(
          selector
        ) as HTMLAnchorElement | null;
        const href = toAbsoluteHref(
          normalize(linkElement?.getAttribute("href")) || normalize(linkElement?.href)
        );
        if (href) {
          return href;
        }
      }
      return "";
    };

    const readClassName = (node: Element | null | undefined): string => {
      if (!node) {
        return "";
      }
      return normalize(node.getAttribute("class"));
    };

    const inferType = (root: Element): string => {
      const explicitType =
        normalize(root.getAttribute("data-notification-type")) ||
        normalize(root.getAttribute("data-type"));
      if (explicitType) {
        return explicitType;
      }

      const iconElement = root.querySelector(
        "[class*='icon'], [class*='badge'], [data-test-icon], svg"
      );
      const signal = `${readClassName(iconElement)} ${readClassName(root)}`.toLowerCase();
      if (signal.includes("message")) {
        return "message";
      }
      if (signal.includes("job")) {
        return "job";
      }
      if (signal.includes("comment")) {
        return "comment";
      }
      if (signal.includes("reaction") || signal.includes("like")) {
        return "reaction";
      }
      if (signal.includes("mention")) {
        return "mention";
      }
      if (signal.includes("connection") || signal.includes("invite")) {
        return "connection";
      }
      if (signal.includes("follow")) {
        return "follow";
      }
      return "notification";
    };

    const inferReadState = (root: Element): boolean => {
      const classSignal = readClassName(root).toLowerCase();
      if (/\bunread\b|\bnew\b|is-new/u.test(classSignal)) {
        return false;
      }
      if (/\bread\b/u.test(classSignal)) {
        return true;
      }

      const unreadIndicator = root.querySelector(
        ".notification-status--unread, .notification-card__unread, .notification-card__unread-dot, .nt-card__unread, .nt-card__blue-dot, [data-test-notification-unread], [aria-label*='Unread'], [aria-label*='unread']"
      );
      if (unreadIndicator) {
        return false;
      }

      const unreadData = normalize(
        root.getAttribute("data-unread") ?? root.getAttribute("data-is-unread")
      ).toLowerCase();
      if (unreadData === "true" || unreadData === "1") {
        return false;
      }
      if (unreadData === "false" || unreadData === "0") {
        return true;
      }

      const ariaSignal = normalize(
        [
          root.getAttribute("aria-label"),
          root.getAttribute("aria-description"),
          root.querySelector("[aria-label]")?.getAttribute("aria-label")
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
      ).toLowerCase();

      if (ariaSignal.includes("unread") || ariaSignal.includes("new")) {
        return false;
      }
      if (ariaSignal.includes("read")) {
        return true;
      }

      return true;
    };

    const cardCandidates = [
      ...Array.from(globalThis.document.querySelectorAll(".nt-card")),
      ...Array.from(globalThis.document.querySelectorAll(".notification-card")),
      ...Array.from(globalThis.document.querySelectorAll("div[data-urn]")),
      ...Array.from(globalThis.document.querySelectorAll("article"))
    ];

    const uniqueCards: Element[] = [];
    const seenCards = new Set<Element>();
    for (const candidate of cardCandidates) {
      const root =
        candidate.closest(".nt-card, .notification-card, div[data-urn], article, li") ??
        candidate;
      if (seenCards.has(root)) {
        continue;
      }
      seenCards.add(root);
      uniqueCards.push(root);
      if (uniqueCards.length >= maxNotifications * 4) {
        break;
      }
    }

    const notifications: NotificationSnapshot[] = [];
    for (let index = 0; index < uniqueCards.length; index += 1) {
      const card = uniqueCards[index];
      if (!card) {
        continue;
      }

      const link = pickHref(card, [
        "a.nt-card__headline",
        "a[href*='/notifications/']",
        "a[href*='/feed/update/']",
        "a[href*='/jobs/view/']",
        "a[href*='/analytics/']",
        "a[href*='/in/']",
        "a"
      ]);
      const message =
        pickText(card, [
          ".nt-card__headline",
          ".nt-card__content p",
          ".nt-card__content",
          ".notification-card__message",
          ".notification-card__body",
          ".notification-card__content",
          "p",
          "span[dir='ltr']"
        ]) || normalize(card.textContent);
      const timestamp =
        pickText(card, [
          "time",
          ".nt-card__time-ago",
          ".notification-card__timestamp",
          ".notification-card__time",
          "[data-test-time-ago]"
        ]) ||
        normalize(card.querySelector("time")?.getAttribute("datetime"));

      const rawIdentifierSeed =
        normalize(card.getAttribute("data-urn")) ||
        normalize(card.getAttribute("data-id")) ||
        normalize(card.getAttribute("data-notification-id")) ||
        normalize(card.getAttribute("id")) ||
        normalize(card.querySelector("[data-urn]")?.getAttribute("data-urn")) ||
        normalize(card.querySelector("[data-id]")?.getAttribute("data-id")) ||
        link ||
        `${message}|${timestamp}|${index}`;
      const id = hashText(rawIdentifierSeed.toLowerCase());
      card.setAttribute("data-linkedin-assistant-notification-key", id);

      notifications.push({
        id,
        type: inferType(card),
        message,
        timestamp,
        link,
        is_read: inferReadState(card)
      });

      if (notifications.length >= maxNotifications) {
        break;
      }
    }

    return notifications;
  }, Math.max(1, limit));

  return snapshots
    .map((snapshot) => ({
      id: normalizeText(snapshot.id),
      type: normalizeText(snapshot.type) || "notification",
      message: normalizeText(snapshot.message),
      timestamp: normalizeText(snapshot.timestamp),
      link: toAbsoluteUrl(snapshot.link),
      is_read: Boolean(snapshot.is_read)
    }))
    .filter(
      (notification) =>
        notification.id.length > 0 ||
        notification.message.length > 0 ||
        notification.link.length > 0
    )
    .slice(0, limit);
}
/* eslint-enable no-undef */

async function collectNotifications(
  page: Page,
  limit: number
): Promise<NotificationSnapshot[]> {
  let notifications = await indexNotificationCards(page, limit);

  for (let attempt = 0; attempt < 6 && notifications.length < limit; attempt += 1) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    notifications = await indexNotificationCards(page, limit);
  }

  return notifications.slice(0, Math.max(1, limit));
}

function getNotificationPreview(notification: LinkedInNotification): Record<string, unknown> {
  return {
    id: notification.id,
    type: notification.type,
    message: notification.message,
    timestamp: notification.timestamp,
    link: notification.link,
    is_read: notification.is_read
  };
}

function selectNotificationMatch(
  notifications: readonly NotificationSnapshot[],
  query: string
): NotificationSnapshot | null {
  const normalizedQuery = normalizeText(query);
  const lowerQuery = normalizedQuery.toLowerCase();
  const comparableQueryUrl = canonicalizeComparableUrl(normalizedQuery);

  if (!normalizedQuery) {
    return null;
  }

  const exactIdMatches = notifications.filter((notification) => {
    return notification.id.toLowerCase() === lowerQuery;
  });
  if (exactIdMatches.length === 1) {
    return exactIdMatches[0] ?? null;
  }
  if (exactIdMatches.length > 1) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Notification query "${query}" matched multiple notification ids.`,
      {
        notification: query,
        matches: exactIdMatches.map(getNotificationPreview)
      }
    );
  }

  if (comparableQueryUrl) {
    const exactUrlMatches = notifications.filter((notification) => {
      return canonicalizeComparableUrl(notification.link) === comparableQueryUrl;
    });
    if (exactUrlMatches.length === 1) {
      return exactUrlMatches[0] ?? null;
    }
    if (exactUrlMatches.length > 1) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Notification query "${query}" matched multiple notification links.`,
        {
          notification: query,
          matches: exactUrlMatches.map(getNotificationPreview)
        }
      );
    }
  }

  const exactMessageMatches = notifications.filter((notification) => {
    return notification.message.toLowerCase() === lowerQuery;
  });
  if (exactMessageMatches.length === 1) {
    return exactMessageMatches[0] ?? null;
  }
  if (exactMessageMatches.length > 1) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Notification query "${query}" matched multiple notification messages.`,
      {
        notification: query,
        matches: exactMessageMatches.map(getNotificationPreview)
      }
    );
  }

  const partialMatches = notifications.filter((notification) => {
    return (
      notification.message.toLowerCase().includes(lowerQuery) ||
      notification.id.toLowerCase().includes(lowerQuery) ||
      notification.link.toLowerCase().includes(lowerQuery)
    );
  });
  if (partialMatches.length === 1) {
    return partialMatches[0] ?? null;
  }
  if (partialMatches.length > 1) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Notification query "${query}" was ambiguous. Use the notification id or full link instead.`,
      {
        notification: query,
        matches: partialMatches.slice(0, 5).map(getNotificationPreview)
      }
    );
  }

  return null;
}

async function resolveNotificationTarget(
  page: Page,
  query: string
): Promise<ResolvedNotificationTarget> {
  let notifications = await indexNotificationCards(page, 40);
  let match = selectNotificationMatch(notifications, query);

  for (let attempt = 0; !match && attempt < 8; attempt += 1) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    notifications = await indexNotificationCards(page, 120);
    match = selectNotificationMatch(notifications, query);
  }

  if (!match) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Could not find a LinkedIn notification matching "${query}".`,
      {
        notification: query,
        candidates: notifications.slice(0, 10).map(getNotificationPreview)
      }
    );
  }

  const locator = page
    .locator(`[data-linkedin-assistant-notification-key="${match.id}"]`)
    .first();

  if (!(await locator.isVisible().catch(() => false))) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Matched LinkedIn notification "${query}" is no longer visible.`,
      {
        notification: query,
        notification_id: match.id
      }
    );
  }

  return {
    snapshot: match,
    locator
  };
}

async function openNotificationMenu(
  page: Page,
  card: Locator
): Promise<Locator> {
  const trigger = card.locator("button[data-nt-card-settings-dropdown-trigger]").first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  await trigger.click({ timeout: 10_000 });

  const menu = page.locator(".nt-card-settings-dropdown__content[aria-hidden='false']").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  return menu;
}

async function openNotificationPreferencesDialog(
  page: Page,
  card: Locator,
  selectorLocale: LinkedInSelectorLocale
): Promise<Locator> {
  const changePreferencesRegex = buildNotificationPhraseRegex(
    "change_preferences",
    selectorLocale
  );
  const changePreferencesRegexHint = buildNotificationPhraseHint(
    "change_preferences",
    selectorLocale
  );
  const menu = await openNotificationMenu(page, card);
  const changePreferencesButton = menu.locator("button").filter({
    hasText: changePreferencesRegex
  }).first();

  if (!(await changePreferencesButton.isVisible().catch(() => false))) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn notification preferences action.",
      {
        selector_hint: `.nt-card-settings-dropdown__content button hasText ${changePreferencesRegexHint}`
      }
    );
  }

  await changePreferencesButton.click({ timeout: 10_000 });

  const dialog = page.locator("[role='dialog']").filter({
    has: page.locator(".props-s-multi-setting-toggle")
  }).first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  return dialog;
}

async function readNotificationPreferencesDialog(
  page: Page,
  dialog: Locator
): Promise<NotificationPreferencesDialogState> {
  const heading = normalizeText(await dialog.locator("h1, h2").first().innerText());
  const rows = dialog.locator(".props-s-multi-setting-toggle");
  const count = await rows.count();

  if (count === 0) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "LinkedIn notification preferences dialog did not contain any toggle rows.",
      {
        selector_hint: ".props-s-multi-setting-toggle"
      }
    );
  }

  const preferences: LinkedInNotificationPreference[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const label = normalizeText(
      await row.locator(".props-s-multi-setting-toggle__display-text").innerText()
    );
    const input = row.locator("input[type='checkbox']").first();
    const enabled = await input.isChecked();
    let key = slugifyNotificationPreference(label, index);
    if (seenKeys.has(key)) {
      key = `${key}-${index + 1}`;
    }
    seenKeys.add(key);

    preferences.push({
      key,
      label,
      enabled
    });
  }

  const settingsUrlLocator = page
    .locator("a[href*='/mypreferences/d/categories/notifications']")
    .first();
  const settingsUrl = await settingsUrlLocator
    .getAttribute("href")
    .then((value) => (typeof value === "string" ? toAbsoluteUrl(value) : null))
    .catch(() => null);

  return {
    heading,
    settingsUrl,
    preferences
  };
}

async function closeNotificationPreferencesDialog(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<void> {
  const dismissRegex = buildLinkedInSelectorPhraseRegex("dismiss", selectorLocale, {
    exact: true
  });
  const dismissRegexHint = formatLinkedInSelectorRegexHint("dismiss", selectorLocale, {
    exact: true
  });
  const dismissButton = page.locator(".artdeco-modal__dismiss").first();

  if (!(await dismissButton.isVisible().catch(() => false))) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not locate the LinkedIn notification preferences close button.",
      {
        selector_hint: `button.artdeco-modal__dismiss or getByRole(button, ${dismissRegexHint})`
      }
    );
  }

  const ariaLabel = normalizeText(await dismissButton.getAttribute("aria-label"));
  if (ariaLabel && !dismissRegex.test(ariaLabel)) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "LinkedIn notification preferences close button no longer matches the expected label.",
      {
        expected: dismissRegex.source,
        observed: ariaLabel
      }
    );
  }

  await dismissButton.click({ timeout: 10_000 });
  await waitForCondition(
    async () => !(await page.locator("[role='dialog']").first().isVisible().catch(() => false)),
    10_000
  );
}

function resolvePreferenceChanges(
  preferences: readonly LinkedInNotificationPreference[],
  changes: readonly LinkedInNotificationPreferenceChangeInput[]
): PreparedNotificationPreferenceChange[] {
  if (changes.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "changes must include at least one notification preference update."
    );
  }

  const resolved: PreparedNotificationPreferenceChange[] = [];
  const seenKeys = new Set<string>();

  for (const change of changes) {
    const query = normalizeText(change.preference);
    const slugQuery = slugifyNotificationPreference(query, 0);
    const match = preferences.find((preference) => {
      return (
        preference.key === query ||
        preference.key === slugQuery ||
        preference.label.toLowerCase() === query.toLowerCase()
      );
    });

    if (!match) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Unknown notification preference "${change.preference}".`,
        {
          preference: change.preference,
          available_preferences: preferences.map((preference) => ({
            key: preference.key,
            label: preference.label,
            enabled: preference.enabled
          }))
        }
      );
    }

    if (seenKeys.has(match.key)) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Duplicate notification preference change for "${match.label}".`,
        {
          preference: change.preference,
          key: match.key
        }
      );
    }

    seenKeys.add(match.key);
    resolved.push({
      key: match.key,
      label: match.label,
      previous_enabled: match.enabled,
      enabled: change.enabled
    });
  }

  return resolved;
}

async function applyNotificationPreferenceChanges(
  dialog: Locator,
  changes: readonly PreparedNotificationPreferenceChange[]
): Promise<void> {
  const rows = dialog.locator(".props-s-multi-setting-toggle");
  const rowCount = await rows.count();
  const seenKeys = new Set<string>();

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const label = normalizeText(
      await row.locator(".props-s-multi-setting-toggle__display-text").innerText()
    );
    let key = slugifyNotificationPreference(label, index);
    if (seenKeys.has(key)) {
      key = `${key}-${index + 1}`;
    }
    seenKeys.add(key);
    const change = changes.find((candidate) => candidate.key === key);

    if (!change) {
      continue;
    }

    const input = row.locator("input[type='checkbox']").first();
    const currentState = await input.isChecked();
    if (currentState === change.enabled) {
      continue;
    }

    const toggle = row.locator(".artdeco-toggle").first();
    await toggle.click({ timeout: 10_000 });
    const updated = await waitForCondition(
      async () => (await input.isChecked()) === change.enabled,
      10_000
    );

    if (!updated) {
      throw new LinkedInAssistantError(
        "UI_CHANGED_SELECTOR_FAILED",
        `LinkedIn notification preference "${change.label}" did not update to the requested state.`,
        {
          preference_key: change.key,
          preference_label: change.label,
          requested_enabled: change.enabled
        }
      );
    }

    await pageWait();
  }
}

async function pageWait(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 300);
  });
}

async function captureNotificationScreenshot(
  runtime: Pick<LinkedInNotificationsExecutorRuntime, "artifacts">,
  page: Page,
  actionType: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const relativePath = `linkedin/screenshot-${actionType}-${Date.now()}.png`;
  await page.screenshot({
    path: runtime.artifacts.resolve(relativePath),
    fullPage: true
  });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function executeDismissNotification(
  runtime: LinkedInNotificationsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = getProfileName(target);
  const notificationQuery = getRequiredStringField(
    target,
    "notification_query",
    actionId,
    "target"
  );

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
        actionId,
        actionType: DISMISS_NOTIFICATION_ACTION_TYPE,
        profileName,
        targetUrl: LINKEDIN_NOTIFICATIONS_URL,
        metadata: {
          notification: notificationQuery
        },
        errorDetails: {
          notification: notificationQuery
        },
        mapError: (error) =>
          toAutomationError(error, "Failed to dismiss the LinkedIn notification.", {
            action_id: actionId,
            notification: notificationQuery
          }),
        execute: async () => {
          await openNotificationsPage(page);
          const rateLimitState = runtime.rateLimiter.consume(
            DISMISS_NOTIFICATION_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn notification dismiss is rate limited for the current window.",
              {
                action_id: actionId,
                profile_name: profileName,
                notification: notificationQuery,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          const targetNotification = await resolveNotificationTarget(
            page,
            notificationQuery
          );
          const menu = await openNotificationMenu(page, targetNotification.locator);
          const deleteRegex = buildNotificationPhraseRegex(
            "delete_notification",
            runtime.selectorLocale
          );
          const deleteNotificationRegexHint = buildNotificationPhraseHint(
            "delete_notification",
            runtime.selectorLocale
          );
          const deleteButton = menu.locator("button").filter({
            hasText: deleteRegex
          }).first();

          if (!(await deleteButton.isVisible().catch(() => false))) {
            throw new LinkedInAssistantError(
              "UI_CHANGED_SELECTOR_FAILED",
              "Could not locate the LinkedIn dismiss notification action.",
              {
                selector_hint: `.nt-card-settings-dropdown__content button hasText ${deleteNotificationRegexHint}`
              }
            );
          }

          await deleteButton.click({ timeout: 10_000 });
          await page.waitForTimeout(1_000);
          await openNotificationsPage(page);
          const remainingNotifications = await collectNotifications(page, 40);
          const stillPresent = selectNotificationMatch(
            remainingNotifications,
            targetNotification.snapshot.id
          );
          if (stillPresent) {
            throw new LinkedInAssistantError(
              "ACTION_PRECONDITION_FAILED",
              "LinkedIn still showed the notification after dismiss.",
              {
                action_id: actionId,
                notification_id: targetNotification.snapshot.id
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "notification_dismissed",
              dismissed: true,
              notification: getNotificationPreview(targetNotification.snapshot),
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUpdateNotificationPreferences(
  runtime: LinkedInNotificationsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = getProfileName(target);
  const notificationQuery = getRequiredStringField(
    target,
    "notification_query",
    actionId,
    "target"
  );
  const requestedChanges = getRequiredPreparedPreferenceChanges(payload, actionId);

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
        actionId,
        actionType: UPDATE_NOTIFICATION_PREFERENCES_ACTION_TYPE,
        profileName,
        targetUrl: LINKEDIN_NOTIFICATIONS_URL,
        metadata: {
          notification: notificationQuery,
          changes: requestedChanges
        },
        errorDetails: {
          notification: notificationQuery
        },
        mapError: (error) =>
          toAutomationError(
            error,
            "Failed to update LinkedIn notification preferences.",
            {
              action_id: actionId,
              notification: notificationQuery
            }
          ),
        execute: async () => {
          await openNotificationsPage(page);
          const rateLimitState = runtime.rateLimiter.consume(
            UPDATE_NOTIFICATION_PREFERENCES_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn notification preference updates are rate limited for the current window.",
              {
                action_id: actionId,
                profile_name: profileName,
                notification: notificationQuery,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          const targetNotification = await resolveNotificationTarget(
            page,
            notificationQuery
          );
          const dialog = await openNotificationPreferencesDialog(
            page,
            targetNotification.locator,
            runtime.selectorLocale
          );
          const beforeState = await readNotificationPreferencesDialog(page, dialog);
          const applicableChanges = resolvePreferenceChanges(
            beforeState.preferences,
            requestedChanges.map((change) => ({
              preference: change.key,
              enabled: change.enabled
            }))
          );

          await applyNotificationPreferenceChanges(dialog, applicableChanges);
          const afterState = await readNotificationPreferencesDialog(page, dialog);
          await closeNotificationPreferencesDialog(page, runtime.selectorLocale);

          const verifiedChanges = applicableChanges.map((change) => {
            const updatedPreference = afterState.preferences.find(
              (preference) => preference.key === change.key
            );

            if (!updatedPreference || updatedPreference.enabled !== change.enabled) {
              throw new LinkedInAssistantError(
                "ACTION_PRECONDITION_FAILED",
                `LinkedIn notification preference "${change.label}" did not end in the requested state.`,
                {
                  action_id: actionId,
                  preference_key: change.key,
                  preference_label: change.label,
                  requested_enabled: change.enabled
                }
              );
            }

            return {
              ...change,
              enabled: updatedPreference.enabled
            };
          });

          return {
            ok: true,
            result: {
              status: "notification_preferences_updated",
              notification: getNotificationPreview(targetNotification.snapshot),
              heading: afterState.heading,
              settings_url: afterState.settingsUrl,
              changes: verifiedChanges,
              rate_limit: formatRateLimitState(rateLimitState)
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class DismissNotificationActionExecutor
  implements ActionExecutor<LinkedInNotificationsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInNotificationsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeDismissNotification(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return {
      ok: true,
      result,
      artifacts
    };
  }
}

export class UpdateNotificationPreferencesActionExecutor
  implements ActionExecutor<LinkedInNotificationsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInNotificationsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdateNotificationPreferences(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return {
      ok: true,
      result,
      artifacts
    };
  }
}

export function createNotificationActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInNotificationsExecutorRuntime>
> {
  return {
    [DISMISS_NOTIFICATION_ACTION_TYPE]: new DismissNotificationActionExecutor(),
    [UPDATE_NOTIFICATION_PREFERENCES_ACTION_TYPE]:
      new UpdateNotificationPreferencesActionExecutor()
  };
}

export class LinkedInNotificationsService {
  constructor(private readonly runtime: LinkedInNotificationsRuntime) {}

  async listNotifications(
    input: ListNotificationsInput = {}
  ): Promise<LinkedInNotification[]> {
    const profileName = input.profileName ?? "default";
    const limit = readNotificationsLimit(input.limit);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationsPage(page);
          const notifications = await collectNotifications(page, limit);
          return notifications.slice(0, limit);
        }
      );
    } catch (error) {
      throw toAutomationError(error, "Failed to list LinkedIn notifications.", {
        profile_name: profileName,
        limit
      });
    }
  }

  async markRead(
    input: NotificationActionInput
  ): Promise<MarkReadNotificationResult> {
    const profileName = input.profileName ?? "default";
    const notificationQuery = normalizeText(input.notification);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationsPage(page);
          const targetNotification = await resolveNotificationTarget(
            page,
            notificationQuery
          );

          if (targetNotification.snapshot.is_read) {
            const artifact = await captureNotificationScreenshot(
              this.runtime,
              page,
              "notifications-mark-read-already-read",
              {
                profile_name: profileName,
                notification_id: targetNotification.snapshot.id
              }
            );
            return {
              notification: {
                ...targetNotification.snapshot,
                is_read: true
              },
              status: "already_read",
              artifacts: [artifact],
              rate_limit: formatRateLimitState(
                this.runtime.rateLimiter.peek(MARK_READ_RATE_LIMIT_CONFIG)
              )
            };
          }

          const rateLimitState = this.runtime.rateLimiter.consume(
            MARK_READ_RATE_LIMIT_CONFIG
          );
          if (!rateLimitState.allowed) {
            throw new LinkedInAssistantError(
              "RATE_LIMITED",
              "LinkedIn notification mark_read is rate limited for the current window.",
              {
                profile_name: profileName,
                notification: notificationQuery,
                rate_limit: formatRateLimitState(rateLimitState)
              }
            );
          }

          const headlineLink = targetNotification.locator.locator("a.nt-card__headline").first();
          if (!(await headlineLink.isVisible().catch(() => false))) {
            throw new LinkedInAssistantError(
              "UI_CHANGED_SELECTOR_FAILED",
              "Could not locate the clickable LinkedIn notification headline.",
              {
                notification: notificationQuery,
                notification_id: targetNotification.snapshot.id
              }
            );
          }

          const beforeUrl = page.url();
          await headlineLink.click({ timeout: 10_000 });
          await Promise.race([
            page.waitForURL((url) => url.toString() !== beforeUrl, {
              timeout: 7_500
            }),
            page.waitForTimeout(1_500)
          ]).catch(() => undefined);

          if (canonicalizeComparableUrl(page.url()) !== canonicalizeComparableUrl(beforeUrl)) {
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(
              () => openNotificationsPage(page)
            );
          }

          await openNotificationsPage(page);
          const updatedNotification = await resolveNotificationTarget(
            page,
            targetNotification.snapshot.id
          );
          if (!updatedNotification.snapshot.is_read) {
            throw new LinkedInAssistantError(
              "ACTION_PRECONDITION_FAILED",
              "LinkedIn still showed the notification as unread after mark_read.",
              {
                notification: notificationQuery,
                notification_id: targetNotification.snapshot.id
              }
            );
          }

          const artifact = await captureNotificationScreenshot(
            this.runtime,
            page,
            "notifications-mark-read",
            {
              profile_name: profileName,
              notification_id: updatedNotification.snapshot.id
            }
          );

          return {
            notification: updatedNotification.snapshot,
            status: "marked_read",
            artifacts: [artifact],
            rate_limit: formatRateLimitState(rateLimitState)
          };
        }
      );
    } catch (error) {
      throw toAutomationError(error, "Failed to mark the LinkedIn notification as read.", {
        profile_name: profileName,
        notification: notificationQuery
      });
    }
  }

  async getPreferences(
    input: GetNotificationPreferencesInput
  ): Promise<LinkedInNotificationPreferences> {
    const profileName = input.profileName ?? "default";
    const notificationQuery = normalizeText(input.notification);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationsPage(page);
          const targetNotification = await resolveNotificationTarget(
            page,
            notificationQuery
          );
          const dialog = await openNotificationPreferencesDialog(
            page,
            targetNotification.locator,
            this.runtime.selectorLocale
          );
          const preferences = await readNotificationPreferencesDialog(page, dialog);
          await closeNotificationPreferencesDialog(page, this.runtime.selectorLocale);

          return {
            notification: targetNotification.snapshot,
            heading: preferences.heading,
            settings_url: preferences.settingsUrl,
            preferences: preferences.preferences
          };
        }
      );
    } catch (error) {
      throw toAutomationError(
        error,
        "Failed to read LinkedIn notification preferences.",
        {
          profile_name: profileName,
          notification: notificationQuery
        }
      );
    }
  }

  async prepareDismiss(
    input: NotificationActionInput
  ): Promise<{
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  }> {
    const profileName = input.profileName ?? "default";
    const notificationQuery = normalizeText(input.notification);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    const notification = await this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        await openNotificationsPage(page);
        const targetNotification = await resolveNotificationTarget(page, notificationQuery);
        return targetNotification.snapshot;
      }
    );

    const target = {
      profile_name: profileName,
      notification_query: notificationQuery,
      notification_id: notification.id,
      notification_link: notification.link,
      notification_message: notification.message
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: DISMISS_NOTIFICATION_ACTION_TYPE,
      target,
      payload: {},
      preview: {
        summary: `Dismiss LinkedIn notification: ${notification.message}`,
        notification: getNotificationPreview(notification),
        target
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async prepareUpdatePreferences(
    input: PrepareUpdateNotificationPreferencesInput
  ): Promise<{
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  }> {
    const profileName = input.profileName ?? "default";
    const notificationQuery = normalizeText(input.notification);
    const normalizedChanges = input.changes.map((change) => ({
      preference: normalizeText(change.preference),
      enabled: change.enabled
    }));

    const currentPreferences = await this.getPreferences({
      profileName,
      notification: notificationQuery
    });
    const resolvedChanges = resolvePreferenceChanges(
      currentPreferences.preferences,
      normalizedChanges
    );

    const target = {
      profile_name: profileName,
      notification_query: notificationQuery,
      notification_id: currentPreferences.notification.id,
      notification_link: currentPreferences.notification.link,
      notification_message: currentPreferences.notification.message
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_NOTIFICATION_PREFERENCES_ACTION_TYPE,
      target,
      payload: {
        changes: resolvedChanges
      },
      preview: {
        summary: `Update LinkedIn notification preferences for ${currentPreferences.notification.message}`,
        notification: getNotificationPreview(currentPreferences.notification),
        heading: currentPreferences.heading,
        settings_url: currentPreferences.settings_url,
        changes: resolvedChanges,
        target
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
