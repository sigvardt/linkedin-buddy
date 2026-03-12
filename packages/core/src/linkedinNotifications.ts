import { createHash } from "node:crypto";
import { type Locator, type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import { scrollLinkedInPageToBottom } from "./linkedinPage.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import { escapeRegExp, getOrCreatePage, normalizeText } from "./shared.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService,
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

export interface MarkNotificationReadInput {
  profileName?: string;
  notificationId: string;
}

export interface MarkNotificationReadResult {
  marked_read: true;
  was_already_read: boolean;
  notification_id: string;
  link: string;
  selector_key: string | null;
}

export interface PrepareDismissLinkedInNotificationInput {
  profileName?: string;
  notificationId: string;
  operatorNote?: string;
}

export interface NotificationPreferenceCategorySummary {
  title: string;
  slug: string;
  preference_url: string;
}

export interface NotificationPreferenceSubcategorySummary {
  title: string;
  slug: string;
  summary: string | null;
  preference_url: string;
}

export interface NotificationPreferenceToggleState {
  label: string;
  enabled: boolean;
  selector_key: string | null;
}

export interface NotificationPreferenceChannelState extends NotificationPreferenceToggleState {
  channel_key: LinkedInNotificationPreferenceChannel | null;
}

export interface LinkedInNotificationPreferencesOverview {
  view_type: "overview";
  title: string;
  preference_url: string;
  categories: NotificationPreferenceCategorySummary[];
}

export interface LinkedInNotificationPreferenceCategoryPage {
  view_type: "category";
  title: string;
  preference_url: string;
  description: string | null;
  master_toggle: NotificationPreferenceToggleState | null;
  subcategories: NotificationPreferenceSubcategorySummary[];
}

export interface LinkedInNotificationPreferenceSubcategoryPage {
  view_type: "subcategory";
  title: string;
  preference_url: string;
  description: string | null;
  channels: NotificationPreferenceChannelState[];
}

export type LinkedInNotificationPreferencePage =
  | LinkedInNotificationPreferencesOverview
  | LinkedInNotificationPreferenceCategoryPage
  | LinkedInNotificationPreferenceSubcategoryPage;

export interface GetLinkedInNotificationPreferencesInput {
  profileName?: string;
  preferenceUrl?: string;
}

export const LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS = [
  "in_app",
  "push",
  "email",
] as const;

export type LinkedInNotificationPreferenceChannel =
  (typeof LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS)[number];

export interface PrepareUpdateLinkedInNotificationPreferenceInput {
  profileName?: string;
  preferenceUrl: string;
  enabled: boolean;
  channel?: LinkedInNotificationPreferenceChannel | string;
  operatorNote?: string;
}

export interface LinkedInNotificationsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInNotificationsRuntime extends LinkedInNotificationsExecutorRuntime {
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInNotificationsExecutorRuntime>,
    "prepare"
  >;
}

interface NotificationSnapshot {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  link: string;
  is_read: boolean;
  card_index: number;
}

interface NotificationSnapshotCandidate {
  raw_id: string;
  type: string;
  message: string;
  timestamp: string;
  link: string;
  is_read: boolean;
  card_index: number;
}

interface NotificationCardMatch {
  snapshot: NotificationSnapshot;
  locator: Locator;
}

interface NotificationPreferenceSwitchSnapshot {
  label: string;
  enabled: boolean;
  selector_key: string | null;
  channel_key: LinkedInNotificationPreferenceChannel | null;
}

interface NotificationPreferencePageState {
  page: LinkedInNotificationPreferencePage;
  switches: NotificationPreferenceSwitchSnapshot[];
}

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: Page | Locator) => Locator;
}

interface PreferenceSwitchLocatorMatch {
  locator: Locator;
  toggleLocator: Locator;
  label: string;
  enabled: boolean;
  selectorKey: string | null;
  channelKey: LinkedInNotificationPreferenceChannel | null;
}

const LINKEDIN_BASE_URL = "https://www.linkedin.com";
const LINKEDIN_NOTIFICATIONS_URL = `${LINKEDIN_BASE_URL}/notifications/`;
const LINKEDIN_NOTIFICATIONS_PREFERENCES_URL = `${LINKEDIN_BASE_URL}/mypreferences/d/categories/notifications`;
const NOTIFICATION_CARD_SELECTOR =
  "article.nt-card, .notification-card, div[data-view-name='notification-card-container'], div[data-urn], article";
const NOTIFICATION_CARD_ROOT_SELECTOR = `${NOTIFICATION_CARD_SELECTOR}, li`;

const SETTINGS_MENU_LABELS = {
  en: ["Settings menu", "More actions"],
  da: ["Indstillingsmenu", "Flere handlinger"],
} as const;

const DELETE_NOTIFICATION_LABELS = {
  en: ["Delete notification"],
  da: ["Slet notifikation", "Slet meddelelse"],
} as const;

export const DISMISS_NOTIFICATION_ACTION_TYPE = "notifications.dismiss";
export const UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE =
  "notifications.update_preference";

/** Maximum number of notifications returned by {@link LinkedInNotificationsService.listNotifications}. */
export const NOTIFICATION_LIST_MAX_LIMIT = 100;

/** Maximum number of notification cards to scan when locating a specific notification by ID. */
export const NOTIFICATION_SCAN_MAX_LIMIT = 200;

function dedupePhrases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(normalized);
  }

  return deduped;
}

function buildPhraseRegex(
  phrases: readonly string[],
  options: { exact?: boolean } = {},
): RegExp {
  const normalizedPhrases = dedupePhrases(phrases);
  const body =
    normalizedPhrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$";
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "iu");
}

function buildLocalizedRegex(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[],
  options: { exact?: boolean } = {},
): RegExp {
  return buildPhraseRegex(
    selectorLocale === "da" ? [...danish, ...english] : [...english, ...danish],
    options,
  );
}

function hashNotificationFingerprint(input: {
  link: string;
  message: string;
  timestamp: string;
}): string {
  const fingerprint = [input.link, input.message, input.timestamp]
    .map((segment) => normalizeText(segment))
    .join("\u001f");
  return `notif_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`;
}

function readNotificationsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }

  return Math.min(NOTIFICATION_LIST_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function readNotificationScanLimit(value: number = 50): number {
  return Math.min(NOTIFICATION_SCAN_MAX_LIMIT, Math.max(10, Math.floor(value)));
}

function splitPreferenceSummaryText(text: string): {
  title: string;
  summary: string | null;
} {
  const normalized = normalizeText(text);
  const match = /^(.*?)(?:\s+(On|Off|In-app|Push|Email))$/iu.exec(normalized);
  if (!match?.[1]) {
    return {
      title: normalized,
      summary: null,
    };
  }

  return {
    title: normalizeText(match[1]),
    summary: normalizeText(match[2]),
  };
}

function inferNotificationPreferenceChannel(
  value: string,
): LinkedInNotificationPreferenceChannel | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("in-app") ||
    normalized.includes("in app") ||
    normalized.includes("inapp") ||
    normalized.includes("viainapp")
  ) {
    return "in_app";
  }
  if (normalized.includes("push") || normalized.includes("viapush")) {
    return "push";
  }
  if (normalized.includes("email") || normalized.includes("e-mail")) {
    return "email";
  }

  return null;
}

export function normalizeLinkedInNotificationPreferenceChannel(
  value: string,
): LinkedInNotificationPreferenceChannel {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (
    normalized === "in_app" ||
    normalized === "push" ||
    normalized === "email"
  ) {
    return normalized;
  }

  const inferred = inferNotificationPreferenceChannel(value);
  if (inferred) {
    return inferred;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `channel must be one of: ${LINKEDIN_NOTIFICATION_PREFERENCE_CHANNELS.join(", ")}.`,
  );
}

function resolveLinkedInNotificationPreferenceUrl(
  value: string | undefined,
): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return LINKEDIN_NOTIFICATIONS_PREFERENCES_URL;
  }

  if (/^https?:\/\//iu.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("/")) {
    return new URL(normalized, LINKEDIN_BASE_URL).toString();
  }

  if (
    normalized.includes("/notification-categories/") ||
    normalized.includes("/notification-subcategories/") ||
    normalized.includes("/categories/notifications")
  ) {
    const path = normalized.startsWith("mypreferences/")
      ? `/${normalized}`
      : normalized;
    return new URL(path, LINKEDIN_BASE_URL).toString();
  }

  return new URL(
    `/mypreferences/d/notification-categories/${encodeURIComponent(normalized)}`,
    LINKEDIN_BASE_URL,
  ).toString();
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 250,
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

async function findVisibleLocator(
  root: Page | Locator,
  candidates: readonly VisibleLocatorCandidate[],
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await locator.isVisible().catch(() => false)) {
      return {
        locator,
        key: candidate.key,
      };
    }
  }

  return null;
}

async function waitForNotificationsSurface(page: Page): Promise<void> {
  const selectors = [
    ".nt-card",
    ".notification-card",
    "div[data-view-name='notification-card-container']",
    "div[data-urn]",
    "article",
    "main",
  ];

  for (const selector of selectors) {
    try {
      await page.locator(selector).first().waitFor({
        state: "visible",
        timeout: 5_000,
      });
      return;
    } catch {
      // Try next selector.
    }
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn notification content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors,
    },
  );
}

async function openNotificationsPage(page: Page): Promise<void> {
  await page.goto(LINKEDIN_NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
  });
  await waitForNetworkIdleBestEffort(page);
  await waitForNotificationsSurface(page);
}

async function openNotificationPreferencesPage(
  page: Page,
  preferenceUrl: string,
): Promise<void> {
  const expectedPath = new URL(preferenceUrl).pathname;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(preferenceUrl, {
      waitUntil: "domcontentloaded",
    });
    await waitForNetworkIdleBestEffort(page);

    const resolved = await waitForCondition(async () => {
      const currentPath = new URL(page.url()).pathname;
      if (currentPath === expectedPath) {
        return true;
      }

      if (expectedPath.includes("/notification-subcategories/")) {
        return (await page.locator("input[role='switch']").count()) >= 2;
      }

      if (expectedPath.includes("/notification-categories/")) {
        return (await page.locator("input[role='switch']").count()) >= 1;
      }

      return false;
    }, 5_000);

    if (resolved) {
      return;
    }
  }
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractNotificationSnapshots(
  page: Page,
  limit: number,
): Promise<NotificationSnapshot[]> {
  const candidates = await page.evaluate(
    ({
      maxNotifications,
      cardSelector,
      cardRootSelector,
    }: {
      maxNotifications: number;
      cardSelector: string;
      cardRootSelector: string;
    }) => {
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
            selector,
          ) as HTMLAnchorElement | null;
          const href = toAbsoluteHref(
            normalize(linkElement?.getAttribute("href")) ||
              normalize(linkElement?.href),
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

      const readRawNotificationId = (root: Element): string => {
        const idCandidates = [
          normalize(root.getAttribute("data-urn")),
          normalize(root.getAttribute("data-id")),
          normalize(root.getAttribute("data-notification-id")),
          normalize(root.getAttribute("id")),
          normalize(root.querySelector("[data-urn]")?.getAttribute("data-urn")),
          normalize(root.querySelector("[data-id]")?.getAttribute("data-id")),
          normalize(
            root
              .querySelector("[data-notification-id]")
              ?.getAttribute("data-notification-id"),
          ),
        ];

        for (const candidate of idCandidates) {
          if (candidate) {
            return candidate;
          }
        }

        return "";
      };

      const inferType = (root: Element): string => {
        const explicitType =
          normalize(root.getAttribute("data-notification-type")) ||
          normalize(root.getAttribute("data-type"));
        if (explicitType) {
          return explicitType;
        }

        const iconElement = root.querySelector(
          "[class*='icon'], [class*='badge'], [data-test-icon], svg",
        );
        const signal =
          `${readClassName(iconElement)} ${readClassName(root)}`.toLowerCase();
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
        if (/\bunread\b|\bnew\b|is-new/.test(classSignal)) {
          return false;
        }
        if (/\bread\b/.test(classSignal)) {
          return true;
        }

        const unreadIndicator = root.querySelector(
          ".notification-status--unread, .notification-card__unread, .notification-card__unread-dot, .nt-card__unread, [data-test-notification-unread], [aria-label*='Unread'], [aria-label*='unread']",
        );
        if (unreadIndicator) {
          return false;
        }

        const unreadData = normalize(
          root.getAttribute("data-unread") ??
            root.getAttribute("data-is-unread"),
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
            root.querySelector("[aria-label]")?.getAttribute("aria-label"),
          ]
            .filter((value): value is string => typeof value === "string")
            .join(" "),
        ).toLowerCase();

        if (ariaSignal.includes("unread") || ariaSignal.includes("new")) {
          return false;
        }
        if (ariaSignal.includes("read")) {
          return true;
        }

        return true;
      };

      const cardCandidates = Array.from(
        globalThis.document.querySelectorAll(cardSelector),
      );
      const uniqueCards: Element[] = [];
      const seenCards = new Set<Element>();
      for (const candidate of cardCandidates) {
        const root = candidate.closest(cardRootSelector) ?? candidate;
        if (seenCards.has(root)) {
          continue;
        }
        seenCards.add(root);
        uniqueCards.push(root);
        if (uniqueCards.length >= maxNotifications * 4) {
          break;
        }
      }

      const notifications: NotificationSnapshotCandidate[] = [];
      for (let i = 0; i < uniqueCards.length; i += 1) {
        const card = uniqueCards[i];
        if (!card) {
          continue;
        }

        const link = pickHref(card, [
          "a.nt-card__headline",
          "a[href*='/notifications/']",
          "a[href*='/feed/update/']",
          "a[href*='/analytics/']",
          "a[href*='/jobs/view/']",
          "a[href*='/in/']",
          "a",
        ]);
        const message =
          pickText(card, [
            ".nt-card__headline .nt-card__text--3-line",
            ".nt-card__headline",
            ".nt-card-content__body-text",
            ".nt-card__content p",
            ".nt-card__content",
            ".notification-card__message",
            ".notification-card__body",
            ".notification-card__content",
            "p",
            "span[dir='ltr']",
          ]) || normalize(card.textContent);

        const timestamp =
          pickText(card, [
            "time",
            ".nt-card__time-ago",
            ".notification-card__timestamp",
            ".notification-card__time",
            "[data-test-time-ago]",
          ]) || normalize(card.querySelector("time")?.getAttribute("datetime"));

        notifications.push({
          raw_id: readRawNotificationId(card),
          type: inferType(card),
          message,
          timestamp,
          link,
          is_read: inferReadState(card),
          card_index: i,
        });

        if (notifications.length >= maxNotifications) {
          break;
        }
      }

      return notifications;
    },
    {
      maxNotifications: Math.max(1, limit),
      cardSelector: NOTIFICATION_CARD_SELECTOR,
      cardRootSelector: NOTIFICATION_CARD_ROOT_SELECTOR,
    },
  );

  return candidates
    .map((candidate) => {
      const link = normalizeText(candidate.link);
      const message = normalizeText(candidate.message);
      const timestamp = normalizeText(candidate.timestamp);
      return {
        id:
          normalizeText(candidate.raw_id) ||
          hashNotificationFingerprint({
            link,
            message,
            timestamp,
          }),
        type: normalizeText(candidate.type) || "notification",
        message,
        timestamp,
        link,
        is_read: Boolean(candidate.is_read),
        card_index: Math.max(0, Math.floor(candidate.card_index)),
      } satisfies NotificationSnapshot;
    })
    .filter(
      (notification) =>
        notification.id.length > 0 ||
        notification.message.length > 0 ||
        notification.link.length > 0,
    )
    .slice(0, limit);
}
/* eslint-enable no-undef */

async function loadNotificationSnapshots(
  page: Page,
  limit: number,
): Promise<NotificationSnapshot[]> {
  let notifications = await extractNotificationSnapshots(page, limit);

  for (let i = 0; i < 6 && notifications.length < limit; i += 1) {
    await scrollLinkedInPageToBottom(page);
    await page.waitForTimeout(800);
    notifications = await extractNotificationSnapshots(page, limit);
  }

  return notifications.slice(0, Math.max(1, limit));
}

async function findNotificationCard(
  page: Page,
  notificationId: string,
  searchLimit: number = 50,
): Promise<NotificationCardMatch | null> {
  const normalizedId = normalizeText(notificationId);
  const snapshots = await loadNotificationSnapshots(
    page,
    readNotificationScanLimit(searchLimit),
  );
  const snapshot = snapshots.find((candidate) => candidate.id === normalizedId);
  if (!snapshot) {
    return null;
  }

  const locator = page
    .locator(NOTIFICATION_CARD_SELECTOR)
    .nth(snapshot.card_index);
  return {
    snapshot,
    locator,
  };
}

async function waitForNotificationState(
  page: Page,
  notificationId: string,
  matcher: (notification: NotificationSnapshot | null) => boolean,
  searchLimit: number = 50,
): Promise<boolean> {
  return waitForCondition(async () => {
    await openNotificationsPage(page);
    const match = await findNotificationCard(page, notificationId, searchLimit);
    return matcher(match?.snapshot ?? null);
  }, 10_000);
}

async function clickNotificationPrimaryAction(
  card: Locator,
): Promise<string | null> {
  const candidates = [
    {
      key: "headline-link",
      selectorHint: "card.locator('a.nt-card__headline')",
      locatorFactory: (root: Page | Locator) =>
        root.locator("a.nt-card__headline"),
    },
    {
      key: "body-link-button",
      selectorHint: "card.locator(\"button[role='link']\")",
      locatorFactory: (root: Page | Locator) =>
        root.locator("button[role='link']"),
    },
    {
      key: "feed-link",
      selectorHint: "card.locator(\"a[href*='/feed/update/']\")",
      locatorFactory: (root: Page | Locator) =>
        root.locator("a[href*='/feed/update/']"),
    },
    {
      key: "analytics-link",
      selectorHint: "card.locator(\"a[href*='/analytics/']\")",
      locatorFactory: (root: Page | Locator) =>
        root.locator("a[href*='/analytics/']"),
    },
    {
      key: "profile-link",
      selectorHint: "card.locator(\"a[href*='/in/']\")",
      locatorFactory: (root: Page | Locator) => root.locator("a[href*='/in/']"),
    },
    {
      key: "fallback-link",
      selectorHint: "card.locator('a[href]')",
      locatorFactory: (root: Page | Locator) => root.locator("a[href]"),
    },
  ] satisfies VisibleLocatorCandidate[];

  const match = await findVisibleLocator(card, candidates);
  if (!match) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not find a clickable LinkedIn notification target to mark as read.",
      {
        attempted_selectors: candidates.map(
          (candidate) => candidate.selectorHint,
        ),
      },
    );
  }

  await match.locator.click({ timeout: 5_000 });
  return match.key;
}

async function openNotificationSettingsMenu(
  card: Locator,
  selectorLocale: LinkedInSelectorLocale,
): Promise<string> {
  const regex = buildLocalizedRegex(
    selectorLocale,
    SETTINGS_MENU_LABELS.en,
    SETTINGS_MENU_LABELS.da,
  );
  const candidates = [
    {
      key: "settings-trigger-data-attr",
      selectorHint: "card.locator('[data-nt-card-settings-dropdown-trigger]')",
      locatorFactory: (root: Page | Locator) =>
        root.locator("[data-nt-card-settings-dropdown-trigger]"),
    },
    {
      key: "settings-trigger-role",
      selectorHint: "card.getByRole(button, /settings menu/iu)",
      locatorFactory: (root: Page | Locator) =>
        root.getByRole("button", {
          name: regex,
        }),
    },
    {
      key: "settings-trigger-aria-label",
      selectorHint: "card.locator('button[aria-label]')",
      locatorFactory: (root: Page | Locator) =>
        root.locator("button[aria-label]").filter({
          hasText: /^$/u,
        }),
    },
  ] satisfies VisibleLocatorCandidate[];

  const match = await findVisibleLocator(card, candidates);
  if (!match) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not find the LinkedIn notification settings menu trigger.",
      {
        attempted_selectors: candidates.map(
          (candidate) => candidate.selectorHint,
        ),
      },
    );
  }

  await match.locator.click({ timeout: 5_000 });
  await card.page().waitForTimeout(300);
  return match.key;
}

async function clickNotificationDismissAction(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
): Promise<string> {
  const deleteRegex = buildLocalizedRegex(
    selectorLocale,
    DELETE_NOTIFICATION_LABELS.en,
    DELETE_NOTIFICATION_LABELS.da,
  );
  const candidates = [
    {
      key: "dismiss-role-button",
      selectorHint: "page.getByRole(button, /Delete notification/iu)",
      locatorFactory: (root: Page | Locator) =>
        root.getByRole("button", {
          name: deleteRegex,
        }),
    },
    {
      key: "dismiss-dropdown-button",
      selectorHint:
        "page.locator('.nt-card-settings-dropdown__content button')",
      locatorFactory: (root: Page | Locator) =>
        root.locator(".nt-card-settings-dropdown__content button").filter({
          hasText: deleteRegex,
        }),
    },
    {
      key: "dismiss-button-text",
      selectorHint:
        "page.locator('button').filter({hasText: /Delete notification/iu})",
      locatorFactory: (root: Page | Locator) =>
        root.locator("button").filter({
          hasText: deleteRegex,
        }),
    },
  ] satisfies VisibleLocatorCandidate[];

  const match = await findVisibleLocator(page, candidates);
  if (!match) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not find the dismiss action for the LinkedIn notification.",
      {
        attempted_selectors: candidates.map(
          (candidate) => candidate.selectorHint,
        ),
      },
    );
  }

  await match.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  return match.key;
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function readNotificationPreferencePageState(
  page: Page,
): Promise<NotificationPreferencePageState> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const readSwitchLabel = (input: HTMLInputElement): string => {
      const labelledBy = normalize(input.getAttribute("aria-labelledby"));
      if (labelledBy) {
        const ids = labelledBy.split(/\s+/u).filter(Boolean);
        const labels = ids
          .map((id) =>
            normalize(globalThis.document.getElementById(id)?.textContent),
          )
          .filter((value) => value.length > 0);
        if (labels.length > 0) {
          return labels.join(" ");
        }
      }

      const labelledText =
        normalize(input.getAttribute("aria-label")) ||
        normalize(input.closest("label")?.textContent) ||
        normalize(input.parentElement?.textContent);
      return labelledText;
    };

    const inferChannel = (
      value: string,
    ): LinkedInNotificationPreferenceChannel | null => {
      const normalized = normalize(value).toLowerCase();
      if (!normalized) {
        return null;
      }

      if (
        normalized.includes("in-app") ||
        normalized.includes("in app") ||
        normalized.includes("inapp") ||
        normalized.includes("viainapp")
      ) {
        return "in_app";
      }
      if (normalized.includes("push") || normalized.includes("viapush")) {
        return "push";
      }
      if (normalized.includes("email") || normalized.includes("e-mail")) {
        return "email";
      }

      return null;
    };

    const getDescription = (): string | null => {
      const paragraphs = Array.from(
        globalThis.document.querySelectorAll("main p, [role='main'] p"),
      )
        .map((element) => normalize(element.textContent))
        .filter((value) => value.length > 0);
      return paragraphs[0] ?? null;
    };

    const readSwitches = (): NotificationPreferenceSwitchSnapshot[] => {
      return Array.from(
        globalThis.document.querySelectorAll("input[role='switch']"),
      ).map((element) => {
        const input = element as HTMLInputElement;
        const selectorKey =
          normalize(input.getAttribute("aria-labelledby")) ||
          normalize(input.id) ||
          null;
        const label = readSwitchLabel(input);
        return {
          label,
          enabled: Boolean(input.checked),
          selector_key: selectorKey,
          channel_key: inferChannel(`${selectorKey ?? ""} ${label}`),
        };
      });
    };

    const title =
      normalize(globalThis.document.querySelector("h1")?.textContent) ||
      "Notifications";
    const preferenceUrl = globalThis.window.location.href;
    const pathName = globalThis.window.location.pathname;
    const description = getDescription();

    if (pathName.includes("/notification-subcategories/")) {
      const switches = readSwitches();
      return {
        page: {
          view_type: "subcategory",
          title,
          preference_url: preferenceUrl,
          description,
          channels: switches,
        },
        switches,
      } satisfies NotificationPreferencePageState;
    }

    if (pathName.includes("/notification-categories/")) {
      const switches = readSwitches();
      const subcategories = Array.from(
        globalThis.document.querySelectorAll(
          "a[href*='/mypreferences/d/notification-subcategories/']",
        ),
      )
        .map((element) => {
          const anchor = element as HTMLAnchorElement;
          const href = normalize(anchor.href || anchor.getAttribute("href"));
          const text = normalize(anchor.textContent);
          const match = /^(.*?)(?:\s+(On|Off|In-app|Push|Email))$/iu.exec(text);
          return {
            title: normalize(match?.[1] ?? text),
            slug: href.replace(/\/+$/u, "").split("/").pop() ?? "",
            summary: normalize(match?.[2] ?? "") || null,
            preference_url: href,
          };
        })
        .filter(
          (subcategory) =>
            subcategory.title.length > 0 && subcategory.preference_url,
        );

      return {
        page: {
          view_type: "category",
          title,
          preference_url: preferenceUrl,
          description,
          master_toggle: switches[0]
            ? {
                label: switches[0].label,
                enabled: switches[0].enabled,
                selector_key: switches[0].selector_key,
              }
            : null,
          subcategories,
        },
        switches,
      } satisfies NotificationPreferencePageState;
    }

    const categories = Array.from(
      globalThis.document.querySelectorAll(
        "a[href*='/mypreferences/d/notification-categories/']",
      ),
    )
      .map((element) => {
        const anchor = element as HTMLAnchorElement;
        const href = normalize(anchor.href || anchor.getAttribute("href"));
        return {
          title: normalize(anchor.textContent),
          slug: href.replace(/\/+$/u, "").split("/").pop() ?? "",
          preference_url: href,
        };
      })
      .filter(
        (category) => category.title.length > 0 && category.preference_url,
      );

    return {
      page: {
        view_type: "overview",
        title,
        preference_url: preferenceUrl,
        categories,
      },
      switches: [],
    } satisfies NotificationPreferencePageState;
  });
}
/* eslint-enable no-undef */

async function findPreferenceSwitchLocator(
  page: Page,
  channel: LinkedInNotificationPreferenceChannel | undefined,
): Promise<PreferenceSwitchLocatorMatch> {
  const switches = page.locator("input[role='switch']");
  const toggles = page.locator(".setting-toggle__toggle");
  const switchCount = await switches.count();

  for (let index = 0; index < switchCount; index += 1) {
    const locator = switches.nth(index);
    const selectorKey =
      normalizeText(await locator.getAttribute("aria-labelledby")) ||
      normalizeText(await locator.getAttribute("id")) ||
      null;
    const label = selectorKey
      ? await page.evaluate((id: string) => {
          const ids = id.split(/\s+/u).filter(Boolean);
          return ids
            .map((part) => {
              return (
                globalThis.document.getElementById(part)?.textContent ?? ""
              )
                .replace(/\s+/g, " ")
                .trim();
            })
            .filter((value) => value.length > 0)
            .join(" ");
        }, selectorKey)
      : "";
    const inferredChannel = inferNotificationPreferenceChannel(
      `${selectorKey ?? ""} ${label}`,
    );

    if (channel && inferredChannel !== channel) {
      continue;
    }

    return {
      locator,
      toggleLocator:
        (await toggles.count()) > index ? toggles.nth(index) : locator,
      label: normalizeText(label),
      enabled: await locator.isChecked().catch(() => false),
      selectorKey,
      channelKey: inferredChannel,
    };
  }

  if (channel) {
    throw new LinkedInBuddyError(
      "TARGET_NOT_FOUND",
      `Could not find the ${channel} notification preference switch on the page.`,
    );
  }

  throw new LinkedInBuddyError(
    "TARGET_NOT_FOUND",
    "Could not find a notification preference switch on the page.",
  );
}

async function executeDismissNotification(
  runtime: LinkedInNotificationsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const notificationId = String(target.notification_id ?? "");

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true,
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
          notification_id: notificationId,
        },
        errorDetails: {
          notification_id: notificationId,
        },
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn notification dismiss action.",
          ),
        execute: async () => {
          await openNotificationsPage(page);
          const match = await findNotificationCard(page, notificationId, 75);
          if (!match) {
            throw new LinkedInBuddyError(
              "TARGET_NOT_FOUND",
              `Could not find LinkedIn notification ${notificationId}.`,
              {
                notification_id: notificationId,
              },
            );
          }

          const settingsMenuKey = await openNotificationSettingsMenu(
            match.locator,
            runtime.selectorLocale,
          );
          const dismissSelectorKey = await clickNotificationDismissAction(
            page,
            runtime.selectorLocale,
          );

          const removed = await waitForNotificationState(
            page,
            notificationId,
            (notification) => notification === null,
            75,
          );
          if (!removed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "LinkedIn notification dismiss action could not be verified after clicking the control.",
              {
                notification_id: notificationId,
                settings_menu_key: settingsMenuKey,
                dismiss_selector_key: dismissSelectorKey,
              },
            );
          }

          return {
            ok: true,
            result: {
              status: "notification_dismissed",
              notification_id: notificationId,
              settings_menu_key: settingsMenuKey,
              dismiss_selector_key: dismissSelectorKey,
            },
            artifacts: [],
          };
        },
      });
    },
  );
}

async function executeUpdateNotificationPreference(
  runtime: LinkedInNotificationsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const preferenceUrl = resolveLinkedInNotificationPreferenceUrl(
    String(target.preference_url ?? payload.preference_url ?? ""),
  );
  const enabled = Boolean(payload.enabled);
  const channelRaw = normalizeText(String(payload.channel ?? ""));
  const channel = channelRaw
    ? normalizeLinkedInNotificationPreferenceChannel(channelRaw)
    : undefined;

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true,
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      return executeConfirmActionWithArtifacts({
        runtime,
        context,
        page,
        actionId,
        actionType: UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
        profileName,
        targetUrl: preferenceUrl,
        metadata: {
          preference_url: preferenceUrl,
          channel: channel ?? null,
          enabled,
        },
        errorDetails: {
          preference_url: preferenceUrl,
          channel: channel ?? null,
          enabled,
        },
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn notification preference update.",
          ),
        execute: async () => {
          await openNotificationPreferencesPage(page, preferenceUrl);
          const initialState = await readNotificationPreferencePageState(page);

          if (initialState.page.view_type === "overview") {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "Notification preference updates require a category or subcategory page, not the overview.",
            );
          }

          if (initialState.page.view_type === "subcategory" && !channel) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "channel is required when updating a notification preference subcategory.",
            );
          }

          const targetSwitch = await findPreferenceSwitchLocator(page, channel);
          if (targetSwitch.enabled === enabled) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              `${targetSwitch.label || "The selected notification preference"} is already ${enabled ? "enabled" : "disabled"}.`,
              {
                preference_url: preferenceUrl,
                channel: targetSwitch.channelKey ?? null,
              },
            );
          }

          await targetSwitch.toggleLocator.click({
            timeout: 5_000,
          });
          await page.waitForTimeout(750);
          await openNotificationPreferencesPage(page, preferenceUrl);

          const refreshedSwitch = await findPreferenceSwitchLocator(
            page,
            channel,
          );
          if (refreshedSwitch.enabled !== enabled) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "LinkedIn notification preference update could not be verified after toggling the switch.",
              {
                preference_url: preferenceUrl,
                channel: refreshedSwitch.channelKey ?? channel ?? null,
                selector_key: refreshedSwitch.selectorKey,
              },
            );
          }

          return {
            ok: true,
            result: {
              status: "notification_preference_updated",
              preference_url: preferenceUrl,
              preference_title: initialState.page.title,
              view_type: initialState.page.view_type,
              channel: refreshedSwitch.channelKey ?? null,
              previous_enabled: targetSwitch.enabled,
              enabled,
              selector_key: refreshedSwitch.selectorKey,
            },
            artifacts: [],
          };
        },
      });
    },
  );
}

export class DismissNotificationActionExecutor implements ActionExecutor<LinkedInNotificationsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInNotificationsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeDismissNotification(
      input.runtime,
      input.action.id,
      input.action.target,
    );
    return {
      ok: true,
      result,
      artifacts,
    };
  }
}

export class UpdateNotificationPreferenceActionExecutor implements ActionExecutor<LinkedInNotificationsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInNotificationsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUpdateNotificationPreference(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload,
    );
    return {
      ok: true,
      result,
      artifacts,
    };
  }
}

export function createNotificationActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInNotificationsExecutorRuntime>
> {
  return {
    [DISMISS_NOTIFICATION_ACTION_TYPE]: new DismissNotificationActionExecutor(),
    [UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE]:
      new UpdateNotificationPreferenceActionExecutor(),
  };
}

export class LinkedInNotificationsService {
  constructor(private readonly runtime: LinkedInNotificationsRuntime) {}

  async listNotifications(
    input: ListNotificationsInput = {},
  ): Promise<LinkedInNotification[]> {
    const profileName = input.profileName ?? "default";
    const limit = readNotificationsLimit(input.limit);

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationsPage(page);
          const notifications = await loadNotificationSnapshots(page, limit);
          return notifications.map((notification) => {
            return {
              id: notification.id,
              type: notification.type,
              message: notification.message,
              timestamp: notification.timestamp,
              link: notification.link,
              is_read: notification.is_read,
            };
          });
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to list LinkedIn notifications.",
      );
    }
  }

  async markRead(
    input: MarkNotificationReadInput,
  ): Promise<MarkNotificationReadResult> {
    const profileName = input.profileName ?? "default";
    const notificationId = normalizeText(input.notificationId);
    if (!notificationId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "notificationId is required.",
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationsPage(page);
          const match = await findNotificationCard(page, notificationId, 75);
          if (!match) {
            throw new LinkedInBuddyError(
              "TARGET_NOT_FOUND",
              `Could not find LinkedIn notification ${notificationId}.`,
              {
                notification_id: notificationId,
              },
            );
          }

          if (match.snapshot.is_read) {
            return {
              marked_read: true,
              was_already_read: true,
              notification_id: notificationId,
              link: match.snapshot.link,
              selector_key: null,
            };
          }

          const selectorKey = await clickNotificationPrimaryAction(
            match.locator,
          );
          const verified = await waitForNotificationState(
            page,
            notificationId,
            (notification) => notification?.is_read === true,
            75,
          );
          if (!verified) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "LinkedIn notification mark_read action could not be verified after opening the notification.",
              {
                notification_id: notificationId,
                selector_key: selectorKey,
              },
            );
          }

          return {
            marked_read: true,
            was_already_read: false,
            notification_id: notificationId,
            link: match.snapshot.link,
            selector_key: selectorKey,
          };
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to mark the LinkedIn notification as read.",
      );
    }
  }

  async prepareDismissNotification(
    input: PrepareDismissLinkedInNotificationInput,
  ): Promise<
    ReturnType<LinkedInNotificationsRuntime["twoPhaseCommit"]["prepare"]>
  > {
    const profileName = input.profileName ?? "default";
    const notificationId = normalizeText(input.notificationId);
    if (!notificationId) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "notificationId is required.",
      );
    }

    const notification = await this.listNotifications({
      profileName,
      limit: 75,
    }).then((notifications) =>
      notifications.find((candidate) => candidate.id === notificationId),
    );

    if (!notification) {
      throw new LinkedInBuddyError(
        "TARGET_NOT_FOUND",
        `Could not find LinkedIn notification ${notificationId}.`,
        {
          notification_id: notificationId,
        },
      );
    }

    const target = {
      profile_name: profileName,
      notification_id: notification.id,
      notification_link: notification.link,
      notification_type: notification.type,
    } satisfies Record<string, unknown>;
    const preview = {
      summary: `Dismiss LinkedIn notification "${notification.message || notification.id}"`,
      target,
      notification,
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: DISMISS_NOTIFICATION_ACTION_TYPE,
      target,
      payload: {
        notification_id: notification.id,
      },
      preview,
      ...(input.operatorNote
        ? {
            operatorNote: input.operatorNote,
          }
        : {}),
    });
  }

  async getPreferences(
    input: GetLinkedInNotificationPreferencesInput = {},
  ): Promise<LinkedInNotificationPreferencePage> {
    const profileName = input.profileName ?? "default";
    const preferenceUrl = resolveLinkedInNotificationPreferenceUrl(
      input.preferenceUrl,
    );

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    try {
      return await this.runtime.profileManager.runWithContext(
        {
          cdpUrl: this.runtime.cdpUrl,
          profileName,
          headless: true,
        },
        async (context) => {
          const page = await getOrCreatePage(context);
          await openNotificationPreferencesPage(page, preferenceUrl);
          const state = await readNotificationPreferencePageState(page);

          if (state.page.view_type === "overview") {
            return {
              ...state.page,
              categories: state.page.categories.map((category) => ({
                ...category,
                title: normalizeText(category.title),
                slug: normalizeText(category.slug),
                preference_url: normalizeText(category.preference_url),
              })),
            };
          }

          if (state.page.view_type === "category") {
            return {
              ...state.page,
              subcategories: state.page.subcategories.map((subcategory) => {
                const split = splitPreferenceSummaryText(subcategory.title);
                return {
                  title: split.title || normalizeText(subcategory.title),
                  slug: normalizeText(subcategory.slug),
                  summary: subcategory.summary ?? split.summary,
                  preference_url: normalizeText(subcategory.preference_url),
                };
              }),
            };
          }

          return {
            ...state.page,
            channels: state.page.channels.map((channel) => ({
              ...channel,
              label: normalizeText(channel.label),
            })),
          };
        },
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to read LinkedIn notification preferences.",
      );
    }
  }

  async prepareUpdatePreference(
    input: PrepareUpdateLinkedInNotificationPreferenceInput,
  ): Promise<
    ReturnType<LinkedInNotificationsRuntime["twoPhaseCommit"]["prepare"]>
  > {
    const profileName = input.profileName ?? "default";
    const preferenceUrl = resolveLinkedInNotificationPreferenceUrl(
      input.preferenceUrl,
    );
    const channel = input.channel
      ? normalizeLinkedInNotificationPreferenceChannel(String(input.channel))
      : undefined;
    const page = await this.getPreferences({
      profileName,
      preferenceUrl,
    });

    if (page.view_type === "overview") {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Notification preference updates require a category or subcategory page, not the overview.",
      );
    }

    const targetState =
      page.view_type === "category"
        ? {
            currentEnabled: page.master_toggle?.enabled ?? null,
            label: page.master_toggle?.label ?? page.title,
          }
        : (() => {
            if (!channel) {
              throw new LinkedInBuddyError(
                "ACTION_PRECONDITION_FAILED",
                "channel is required when updating a notification preference subcategory.",
              );
            }

            const targetChannel = page.channels.find(
              (candidate) => candidate.channel_key === channel,
            );
            if (!targetChannel) {
              throw new LinkedInBuddyError(
                "TARGET_NOT_FOUND",
                `Could not find the ${channel} notification preference switch on ${page.title}.`,
                {
                  preference_url: preferenceUrl,
                  channel,
                },
              );
            }

            return {
              currentEnabled: targetChannel.enabled,
              label: targetChannel.label || page.title,
            };
          })();

    if (targetState.currentEnabled === input.enabled) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `${targetState.label} is already ${input.enabled ? "enabled" : "disabled"}.`,
        {
          preference_url: preferenceUrl,
          channel: channel ?? null,
        },
      );
    }

    const target = {
      profile_name: profileName,
      preference_url: preferenceUrl,
      view_type: page.view_type,
      preference_title: page.title,
      channel: channel ?? null,
    } satisfies Record<string, unknown>;
    const preview = {
      summary:
        page.view_type === "category"
          ? `Set LinkedIn notification preference "${page.title}" to ${input.enabled ? "on" : "off"}`
          : `Set LinkedIn notification preference "${page.title}" (${channel}) to ${input.enabled ? "on" : "off"}`,
      target,
      current_enabled: targetState.currentEnabled,
      enabled: input.enabled,
    } satisfies Record<string, unknown>;

    return this.runtime.twoPhaseCommit.prepare({
      actionType: UPDATE_NOTIFICATION_PREFERENCE_ACTION_TYPE,
      target,
      payload: {
        preference_url: preferenceUrl,
        enabled: input.enabled,
        ...(channel ? { channel } : {}),
      },
      preview,
      ...(input.operatorNote
        ? {
            operatorNote: input.operatorNote,
          }
        : {}),
    });
  }
}
