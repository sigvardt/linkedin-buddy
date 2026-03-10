import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type {
  LinkedInEventSearchResult,
  LinkedInSearchService
} from "./linkedinSearch.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */

export interface SearchEventsInput {
  profileName?: string;
  query: string;
  limit?: number;
}

export interface SearchEventsOutput {
  query: string;
  results: LinkedInEventSearchResult[];
  count: number;
}

export interface ViewEventInput {
  profileName?: string;
  target: string;
}

export type LinkedInEventRsvpState =
  | "attending"
  | "interested"
  | "declined"
  | "not_responded"
  | "unknown";

export interface LinkedInEvent {
  event_url: string;
  event_id: string | null;
  title: string;
  status: string;
  date: string;
  location: string;
  venue: string;
  organizer: string;
  organizer_url: string;
  description: string;
  attendee_count: string;
  event_link: string;
  rsvp_state: LinkedInEventRsvpState;
}

interface LinkedInEventSnapshot {
  current_url: string;
  title: string;
  top_card_text: string;
  status: string;
  date: string;
  location: string;
  venue: string;
  organizer: string;
  organizer_url: string;
  description: string;
  attendee_count: string;
  event_link: string;
  action_texts: string[];
}

export interface LinkedInEventsRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  search: Pick<LinkedInSearchService, "search">;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function decodeEventPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Event URL contains an invalid encoded path segment.",
      {},
      error instanceof Error ? { cause: error } : undefined
    );
  }
}

function toInvalidEventUrlError(error: unknown): LinkedInAssistantError {
  if (
    error instanceof URIError ||
    (error instanceof Error && /uri malformed/i.test(error.message))
  ) {
    return new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Event URL contains an invalid encoded path segment."
    );
  }

  return new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Event URL must be a valid URL.",
    {},
    error instanceof Error ? { cause: error } : undefined
  );
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

async function waitForEventSurface(page: Page): Promise<void> {
  const selectors = [
    "main h1",
    ".events-live-top-card__content",
    ".events-live-top-card__main-content",
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
      // Try the next selector.
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn event detail content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

export function resolveEventUrl(target: string): string {
  const normalizedTarget = normalizeText(target);
  if (!normalizedTarget) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Event target is required."
    );
  }

  if (isAbsoluteUrl(normalizedTarget)) {
    let parsedUrl: URL;
    let hostname = "";
    let segments: string[] = [];
    try {
      parsedUrl = new URL(normalizedTarget);
      hostname = parsedUrl.hostname.toLowerCase();
      segments = parsedUrl.pathname
        .split("/")
        .filter((segment) => segment.length > 0);
    } catch (error) {
      throw toInvalidEventUrlError(error);
    }

    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");

    if (!isLinkedInDomain || segments[0] !== "events" || !segments[1]) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Event URL must point to linkedin.com/events/.",
        { target: normalizedTarget }
      );
    }

    return `https://www.linkedin.com/events/${encodeURIComponent(
      decodeEventPathSegment(segments[1])
    )}/`;
  }

  if (normalizedTarget.startsWith("/events/")) {
    const [, , eventId = ""] = normalizedTarget.split("/");
    const normalizedEventId = normalizeText(eventId);
    if (!normalizedEventId) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Event target is required."
      );
    }

    return `https://www.linkedin.com/events/${encodeURIComponent(
      normalizedEventId
    )}/`;
  }

  return `https://www.linkedin.com/events/${encodeURIComponent(normalizedTarget)}/`;
}

export function normalizeLinkedInEventUrl(target: string): string {
  const resolved = resolveEventUrl(target);

  try {
    const parsedUrl = new URL(resolved);
    parsedUrl.search = "";
    parsedUrl.hash = "";

    const pathname = parsedUrl.pathname.endsWith("/")
      ? parsedUrl.pathname
      : `${parsedUrl.pathname}/`;

    return `${parsedUrl.origin}${pathname}`;
  } catch {
    return resolved;
  }
}

export function extractEventId(url: string): string | null {
  const match = /\/events\/([^/?#]+)/i.exec(url);
  const eventId = match?.[1];
  if (!eventId) {
    return null;
  }

  try {
    return decodeURIComponent(eventId);
  } catch {
    return eventId;
  }
}

export function cleanLinkedInEventDescription(value: string): string {
  return normalizeText(value).replace(/\s*…more$/i, "");
}

function extractEventDate(snapshot: LinkedInEventSnapshot): string {
  if (snapshot.date) {
    return snapshot.date;
  }

  const organizer = snapshot.organizer
    ? `Event by ${snapshot.organizer}`
    : "Event by";
  const pattern = new RegExp(
    `${organizer}\\s+(.*?)\\s+(?:Event link|\\d[\\d,.]*\\s*(?:attendees|attendee)|Attend|Share|Report this event)`,
    "i"
  );
  const match = pattern.exec(snapshot.top_card_text);
  return normalizeText(match?.[1]);
}

export function parseLinkedInEventRsvpState(
  actions: readonly string[]
): LinkedInEventRsvpState {
  const normalizedActions = actions
    .map((value) => normalizeText(value).toLowerCase())
    .filter((value) => value.length > 0);

  if (
    normalizedActions.some(
      (value) =>
        value.includes("not attending") || value.includes("declined")
    )
  ) {
    return "declined";
  }

  if (normalizedActions.some((value) => value.includes("attending"))) {
    return "attending";
  }

  if (
    normalizedActions.some(
      (value) => value.includes("interested") || value === "maybe"
    )
  ) {
    return "interested";
  }

  if (normalizedActions.some((value) => value.includes("attend"))) {
    return "not_responded";
  }

  return "unknown";
}

async function extractEventSnapshot(page: Page): Promise<LinkedInEventSnapshot> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const topCard = globalThis.document.querySelector(
      ".events-live-top-card__content, .events-live-top-card__main-content"
    );
    const actionRoot = globalThis.document.querySelector(
      ".events-live__top-card-content"
    );
    const organizerLink = topCard?.querySelector(
      "a[aria-label*='Event by']"
    ) as HTMLAnchorElement | null;
    const eventLink = topCard?.querySelector(
      ".events-live-top-card__external-url"
    ) as HTMLAnchorElement | null;
    const descriptionRoot = globalThis.document.querySelector(
      ".update-components-update-v2__commentary, .feed-shared-update-v2__description"
    );

    return {
      current_url: globalThis.window.location.href,
      title: normalize(
        globalThis.document.querySelector("main h1, .events-live-top-card__title")
          ?.textContent
      ),
      top_card_text: normalize(topCard?.textContent),
      status: normalize(
        globalThis.document.querySelector(
          ".events-live-top-card__status-feedback--bold, .events-live-top-card__status-feedback"
        )?.textContent
      ),
      date: normalize(
        topCard?.querySelector(
          ".display-flex.t-14.t-black.t-normal.pt2"
        )?.textContent
      ),
      location: normalize(topCard?.querySelector("p.t-14.t-black")?.textContent),
      venue: normalize(
        topCard?.querySelector("p.t-14.t-black--light.t-normal")?.textContent
      ),
      organizer: normalize(organizerLink?.textContent),
      organizer_url: normalize(organizerLink?.href),
      description: normalize(descriptionRoot?.textContent),
      attendee_count: normalize(
        globalThis.document.querySelector(
          ".events-components-shared-social-proof__copy-text"
        )?.textContent
      ),
      event_link: normalize(eventLink?.href),
      action_texts: Array.from(
        (actionRoot ?? topCard ?? globalThis.document).querySelectorAll(
          "button,a,[role='button']"
        )
      )
        .map((element) => {
          const text = normalize(element.textContent);
          const ariaLabel = normalize(element.getAttribute("aria-label"));
          return text || ariaLabel;
        })
        .filter((value) => value.length > 0)
        .slice(0, 24)
    };
  });
}

export class LinkedInEventsService {
  constructor(private readonly runtime: LinkedInEventsRuntime) {}

  async searchEvents(input: SearchEventsInput): Promise<SearchEventsOutput> {
    const query = normalizeText(input.query);
    if (!query) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    const result = await this.runtime.search.search({
      query,
      category: "events",
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {})
    });

    if (result.category !== "events") {
      throw new LinkedInAssistantError(
        "UNKNOWN",
        "LinkedIn search returned an unexpected category for events search."
      );
    }

    return {
      query: result.query,
      results: result.results,
      count: result.count
    };
  }

  async viewEvent(input: ViewEventInput): Promise<LinkedInEvent> {
    const profileName = input.profileName ?? "default";
    const targetUrl = normalizeLinkedInEventUrl(input.target);

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshot = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForEventSurface(page);

          const seeMoreButton = page
            .locator("button[aria-label*='see more'], button:has-text('…more')")
            .first();
          if (await seeMoreButton.isVisible().catch(() => false)) {
            await seeMoreButton.click().catch(() => undefined);
            await page.waitForTimeout(500);
          }

          return extractEventSnapshot(page);
        }
      );

      const normalizedSnapshot: LinkedInEventSnapshot = {
        ...snapshot,
        current_url: normalizeLinkedInEventUrl(snapshot.current_url || targetUrl),
        title: normalizeText(snapshot.title),
        top_card_text: normalizeText(snapshot.top_card_text),
        status: normalizeText(snapshot.status),
        date: normalizeText(snapshot.date),
        location: normalizeText(snapshot.location),
        venue: normalizeText(snapshot.venue),
        organizer: normalizeText(snapshot.organizer),
        organizer_url: normalizeText(snapshot.organizer_url),
        description: cleanLinkedInEventDescription(snapshot.description),
        attendee_count: normalizeText(snapshot.attendee_count),
        event_link: normalizeText(snapshot.event_link),
        action_texts: snapshot.action_texts.map((value) => normalizeText(value))
      };

      return {
        event_url: normalizedSnapshot.current_url,
        event_id: extractEventId(normalizedSnapshot.current_url),
        title: normalizedSnapshot.title,
        status: normalizedSnapshot.status,
        date: extractEventDate(normalizedSnapshot),
        location: normalizedSnapshot.location,
        venue: normalizedSnapshot.venue,
        organizer: normalizedSnapshot.organizer,
        organizer_url: normalizedSnapshot.organizer_url,
        description: normalizedSnapshot.description,
        attendee_count: normalizedSnapshot.attendee_count,
        event_link: normalizedSnapshot.event_link,
        rsvp_state: parseLinkedInEventRsvpState(
          normalizedSnapshot.action_texts
        )
      };
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }

      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn event."
      );
    }
  }
}

/* eslint-enable no-undef */
