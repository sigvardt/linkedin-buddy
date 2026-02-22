import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ProfileManager } from "./profileManager.js";

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

export interface LinkedInNotificationsRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
}

interface NotificationSnapshot {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  link: string;
  is_read: boolean;
}

const LINKEDIN_NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function readNotificationsLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }

  return Math.max(1, Math.floor(value));
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

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractNotifications(
  page: Page,
  limit: number
): Promise<LinkedInNotification[]> {
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

    const extractNotificationId = (
      root: Element,
      link: string,
      index: number
    ): string => {
      const idCandidates = [
        normalize(root.getAttribute("data-urn")),
        normalize(root.getAttribute("data-id")),
        normalize(root.getAttribute("data-notification-id")),
        normalize(root.getAttribute("id")),
        normalize(root.querySelector("[data-urn]")?.getAttribute("data-urn")),
        normalize(root.querySelector("[data-id]")?.getAttribute("data-id"))
      ];

      for (const candidate of idCandidates) {
        if (candidate) {
          return candidate;
        }
      }

      const linkMatch =
        /\/notifications\/([^/?#]+)/i.exec(link) ??
        /[\?&]notificationId=([^&#]+)/i.exec(link);
      if (linkMatch?.[1]) {
        try {
          return decodeURIComponent(linkMatch[1]);
        } catch {
          return linkMatch[1];
        }
      }

      return `notification-${index + 1}`;
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
      if (/\bunread\b|\bnew\b|is-new/.test(classSignal)) {
        return false;
      }
      if (/\bread\b/.test(classSignal)) {
        return true;
      }

      const unreadIndicator = root.querySelector(
        ".notification-status--unread, .notification-card__unread, .notification-card__unread-dot, .nt-card__unread, [data-test-notification-unread], [aria-label*='Unread'], [aria-label*='unread']"
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
    for (let i = 0; i < uniqueCards.length; i++) {
      const card = uniqueCards[i];
      if (!card) {
        continue;
      }

      const link = pickHref(card, [
        "a[href*='/notifications/']",
        "a[href*='/feed/update/']",
        "a[href*='/jobs/view/']",
        "a[href*='/in/']",
        "a"
      ]);
      const id = extractNotificationId(card, link, i);
      const message =
        pickText(card, [
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
      link: normalizeText(snapshot.link),
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

async function loadNotifications(
  page: Page,
  limit: number
): Promise<LinkedInNotification[]> {
  let notifications = await extractNotifications(page, limit);

  for (let i = 0; i < 6 && notifications.length < limit; i++) {
    await page.evaluate(() => {
      globalThis.window.scrollTo(0, globalThis.document.body.scrollHeight);
    });
    await page.waitForTimeout(800);
    notifications = await extractNotifications(page, limit);
  }

  return notifications.slice(0, Math.max(1, limit));
}

export class LinkedInNotificationsService {
  constructor(private readonly runtime: LinkedInNotificationsRuntime) {}

  async listNotifications(
    input: ListNotificationsInput = {}
  ): Promise<LinkedInNotification[]> {
    const profileName = input.profileName ?? "default";
    const limit = readNotificationsLimit(input.limit);

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      return await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(LINKEDIN_NOTIFICATIONS_URL, {
            waitUntil: "domcontentloaded"
          });
          await page.waitForLoadState("networkidle");
          await waitForNotificationsSurface(page);
          const notifications = await loadNotifications(page, limit);
          return notifications.slice(0, limit);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to list LinkedIn notifications."
      );
    }
  }
}
