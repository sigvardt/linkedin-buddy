import { type BrowserContext, type Page } from "playwright-core";
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
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorRegistry,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

export const EVENT_RSVP_ACTION_TYPE = "events.rsvp";

export type LinkedInEventRsvpState = "not_responded" | "attending" | "unknown";

export interface LinkedInEventsSearchResult {
  event_id: string;
  title: string;
  date_time: string;
  location: string;
  organizer: string;
  attendee_count: string;
  description: string;
  event_url: string;
  is_online: boolean;
}

export interface LinkedInEventDetail {
  event_id: string;
  title: string;
  event_url: string;
  organizer: string;
  date_time: string;
  location: string;
  attendee_count: string;
  description: string;
  is_online: boolean;
  rsvp_state: LinkedInEventRsvpState;
}

export interface SearchEventsInput {
  profileName?: string;
  query: string;
  limit?: number;
}

export interface ViewEventInput {
  profileName?: string;
  event: string;
}

export interface SearchEventsOutput {
  query: string;
  results: LinkedInEventsSearchResult[];
  count: number;
}

export interface PrepareEventRsvpInput {
  profileName?: string;
  event: string;
  operatorNote?: string;
}

export interface LinkedInEventsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInEventsRuntime extends LinkedInEventsExecutorRuntime {
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInEventsExecutorRuntime>, "prepare">;
}

interface EventSearchSnapshot {
  event_id: string;
  title: string;
  date_time: string;
  location: string;
  organizer: string;
  attendee_count: string;
  description: string;
  event_url: string;
  is_online: boolean;
}

interface EventDetailSnapshot {
  event_id: string;
  title: string;
  event_url: string;
  organizer: string;
  date_time: string;
  location: string;
  attendee_count: string;
  description: string;
  is_online: boolean;
  rsvp_state: LinkedInEventRsvpState;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSearchLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.floor(value));
}

function buildLocalizedRegex(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[] = english,
  options: { exact?: boolean } = {}
): RegExp {
  const phrases =
    selectorLocale === "da" ? [...danish, ...english] : [...english, ...danish];
  const body = phrases.map((phrase) => escapeRegExp(phrase)).join("|") || "^$";
  const pattern = options.exact ? `^(?:${body})$` : `(?:${body})`;
  return new RegExp(pattern, "iu");
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250
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

function extractEventId(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const urlMatch = /\/events\/(\d+)/iu.exec(normalized);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const idMatch = /^\d+$/u.exec(normalized);
  return idMatch?.[0] ?? "";
}

export function buildEventSearchUrl(query: string): string {
  return `https://www.linkedin.com/search/results/events/?keywords=${encodeURIComponent(query)}`;
}

export function buildEventViewUrl(eventId: string): string {
  return `https://www.linkedin.com/events/${encodeURIComponent(eventId)}/`;
}

function resolveEventReference(event: string): {
  eventId: string;
  eventUrl: string;
} {
  const eventId = extractEventId(event);
  if (!eventId) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "event must be a LinkedIn event URL or numeric ID."
    );
  }

  return {
    eventId,
    eventUrl: buildEventViewUrl(eventId)
  };
}

async function waitForEventSearchSurface(page: Page): Promise<void> {
  const selectors = [
    ".reusable-search__result-container",
    "li.reusable-search__result-container",
    ".scaffold-layout__main",
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
    "Could not locate LinkedIn event search content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForEventDetailSurface(page: Page): Promise<void> {
  const selectors = [
    ".events-top-card",
    ".events-details",
    ".scaffold-layout__main",
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

async function scrollSearchResultsIfNeeded(
  page: Page,
  extractor: (currentPage: Page, limit: number) => Promise<EventSearchSnapshot[]>,
  limit: number
): Promise<EventSearchSnapshot[]> {
  let snapshots = await extractor(page, limit);

  for (let pass = 0; pass < 6 && snapshots.length < limit; pass += 1) {
    await page.mouse.wheel(0, 1_800);
    await page.waitForTimeout(500);
    snapshots = await extractor(page, limit);
  }

  return snapshots;
}

async function extractEventSearchResults(
  page: Page,
  limit: number
): Promise<EventSearchSnapshot[]> {
  return page.evaluate((maxEvents: number) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const extractEventIdFromUrl = (value: string): string => {
      const match = /\/events\/(\d+)/iu.exec(value);
      return match?.[1] ?? "";
    };

    const cards = new Map<string, string>();
    for (const link of Array.from(globalThis.document.links)) {
      const href = normalize(link.href);
      if (!href.includes("/events/") || !extractEventIdFromUrl(href)) {
        continue;
      }

      const text = link.innerText ?? "";
      if (!normalize(text) || /^view$/iu.test(normalize(text))) {
        continue;
      }

      const existing = cards.get(href);
      if (!existing || text.length > existing.length) {
        cards.set(href, text);
      }
    }

    return Array.from(cards.entries())
      .slice(0, maxEvents)
      .map(([eventUrl, rawText]) => {
        const lines = rawText
          .split("\n")
          .map((line) => normalize(line))
          .filter((line) => line.length > 0);
        const title = lines[0] ?? "";
        const dateTime =
          lines.find((line) =>
            /\b(?:AM|PM|Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/iu.test(line)
          ) ?? "";
        const locationAndOrganizer =
          lines.find(
            (line) =>
              line !== title &&
              line !== dateTime &&
              !/^\d[\d.,\s]*(?:attendee|attendees)\b$/iu.test(line)
          ) ?? "";
        const [locationPart, organizerPart] = locationAndOrganizer.split(/\s+•\s+By\s+/iu);
        const attendeeCount =
          lines.find((line) =>
            /^\d[\d.,\s]*(?:attendee|attendees)\b$/iu.test(line)
          ) ?? "";
        const description = normalize(
          lines
            .filter(
              (line) =>
                line !== title &&
                line !== dateTime &&
                line !== locationAndOrganizer &&
                line !== attendeeCount
            )
            .join(" ")
        );
        const location = normalize(locationPart);

        return {
          event_id: extractEventIdFromUrl(eventUrl),
          title,
          date_time: dateTime,
          location,
          organizer: normalize(organizerPart),
          attendee_count: attendeeCount,
          description,
          event_url: eventUrl,
          is_online: /^online$/iu.test(location)
        } satisfies EventSearchSnapshot;
      });
  }, limit);
}

async function extractEventDetailSnapshot(page: Page): Promise<EventDetailSnapshot> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const isDateTimeLine = (value: string): boolean =>
      /\b(?:AM|PM|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/iu.test(
        value
      );

    const title =
      normalize(globalThis.document.querySelector("main h1")?.textContent) || "";
    const url = normalize(globalThis.window.location.href);
    const eventId = /\/events\/(\d+)/iu.exec(url)?.[1] ?? "";
    const lines = globalThis.document.body.innerText
      .split("\n")
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    const organizerRaw =
      lines.find((line) => /^Event by /iu.test(line)) ?? "";
    const dateTimeCandidates = lines.filter(
      (line) => line !== title && line !== organizerRaw && isDateTimeLine(line)
    );
    const dateTime = dateTimeCandidates.reduce<string>(
      (longest, candidate) =>
        candidate.length > longest.length ? candidate : longest,
      ""
    );
    const attendeeCount =
      lines.find((line) =>
        /^\d[\d.,\s]*(?:attendee|attendees)\b$/iu.test(line)
      ) ?? "";
    const description = (() => {
      const about = (() => {
        const startIndex = lines.findIndex((line) => /^About$/iu.test(line));
        if (startIndex < 0) {
          return "";
        }

        const values: string[] = [];
        for (let index = startIndex + 1; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (
            /^(?:Speakers|Exclusive events to grow your career|Other events for you|About|Accessibility)$/iu.test(
              line
            )
          ) {
            break;
          }
          values.push(line);
        }

        return normalize(values.join(" "));
      })();

      return about;
    })();
    const dateTimeIndex = lines.findIndex((line) => line === dateTime);
    const attendeeIndex = lines.findIndex((line) => line === attendeeCount);
    const locationCandidate =
      lines.find((line, index) => {
        const isAfterDateTime = dateTimeIndex < 0 || index > dateTimeIndex;
        const isBeforeAttendees = attendeeIndex < 0 || index < attendeeIndex;

        return (
          isAfterDateTime &&
          isBeforeAttendees &&
          line !== title &&
          line !== organizerRaw &&
          line !== dateTime &&
          line !== attendeeCount &&
          !/^Attend$/iu.test(line) &&
          !/^Share$/iu.test(line) &&
          !/^Details$/iu.test(line) &&
          !/^Comments$/iu.test(line) &&
          !/^About$/iu.test(line) &&
          !/^Speakers$/iu.test(line) &&
          !/^Event by /iu.test(line) &&
          !/^\d+(?:,\d+)*\s+attendees$/iu.test(line) &&
          !isDateTimeLine(line)
        );
      }) ?? "";
    const liveBadgeVisible = lines.some((line) => /^Live\b/iu.test(line));
    const attendButtonVisible = Array.from(
      globalThis.document.querySelectorAll("button")
    ).some((button) => /^Attend$/iu.test(normalize(button.textContent)));
    const attendingButtonVisible = Array.from(
      globalThis.document.querySelectorAll("button")
    ).some((button) =>
      /^(?:Attending|Going|Manage attendance)$/iu.test(
        normalize(button.textContent)
      )
    );
    const isOnline =
      /^Online$/iu.test(locationCandidate) ||
      /LinkedIn Live/iu.test(description) ||
      liveBadgeVisible;

    return {
      event_id: eventId,
      title,
      event_url: url,
      organizer: normalize(organizerRaw.replace(/^Event by /iu, "")),
      date_time: dateTime,
      location: locationCandidate || (isOnline ? "Online" : ""),
      attendee_count: attendeeCount,
      description,
      is_online: isOnline,
      rsvp_state: attendButtonVisible
        ? "not_responded"
        : attendingButtonVisible
          ? "attending"
          : "unknown"
    } satisfies EventDetailSnapshot;
  });
}
async function executeEventRsvp(
  runtime: LinkedInEventsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const eventId = String(target.event_id ?? "");
  const eventUrl =
    normalizeText(String(target.event_url ?? "")) || buildEventViewUrl(eventId);

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
        actionType: EVENT_RSVP_ACTION_TYPE,
        profileName,
        targetUrl: eventUrl,
        metadata: {
          event_id: eventId,
          event_url: eventUrl,
          response: "attend"
        },
        errorDetails: {
          event_id: eventId,
          event_url: eventUrl,
          response: "attend"
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn event RSVP action."
          ),
        execute: async () => {
          await page.goto(eventUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForEventDetailSurface(page);

          const attendRegex = buildLocalizedRegex(
            runtime.selectorLocale,
            ["Attend"],
            ["Deltag"],
            { exact: true }
          );
          await page.getByRole("button", {
            name: attendRegex
          }).first().click({ timeout: 5_000 });

          const finished = await waitForCondition(async () => {
            const attendVisible = await page
              .getByRole("button", {
                name: attendRegex
              })
              .first()
              .isVisible()
              .catch(() => false);
            return !attendVisible;
          }, 8_000);

          if (!finished) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "LinkedIn RSVP flow could not be verified after clicking Attend.",
              {
                event_id: eventId,
                event_url: eventUrl
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "event_rsvp_submitted",
              response: "attend",
              event_id: eventId,
              event_url: eventUrl
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class EventRsvpActionExecutor
  implements ActionExecutor<LinkedInEventsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInEventsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeEventRsvp(
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

export function createEventActionExecutors(): ActionExecutorRegistry<LinkedInEventsExecutorRuntime> {
  return {
    [EVENT_RSVP_ACTION_TYPE]: new EventRsvpActionExecutor()
  };
}

export class LinkedInEventsService {
  constructor(private readonly runtime: LinkedInEventsRuntime) {}

  async searchEvents(input: SearchEventsInput): Promise<SearchEventsOutput> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshots = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(buildEventSearchUrl(query), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForEventSearchSurface(page);
          await page
            .locator(
              ".reusable-search__result-container, li.reusable-search__result-container"
            )
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => page.waitForTimeout(2_000));
          return scrollSearchResultsIfNeeded(page, extractEventSearchResults, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          event_id: normalizeText(snapshot.event_id),
          title: normalizeText(snapshot.title),
          date_time: normalizeText(snapshot.date_time),
          location: normalizeText(snapshot.location),
          organizer: normalizeText(snapshot.organizer),
          attendee_count: normalizeText(snapshot.attendee_count),
          description: normalizeText(snapshot.description),
          event_url: normalizeText(snapshot.event_url),
          is_online: snapshot.is_online
        }))
        .filter((result) => result.title.length > 0 || result.event_url.length > 0)
        .slice(0, limit);

      return {
        query,
        results,
        count: results.length
      };
    } catch (error) {
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to search LinkedIn events."
      );
    }
  }

  async viewEvent(input: ViewEventInput): Promise<LinkedInEventDetail> {
    const profileName = input.profileName ?? "default";
    const { eventUrl } = resolveEventReference(input.event);

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshot = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(eventUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForEventDetailSurface(page);
          return extractEventDetailSnapshot(page);
        }
      );

      return {
        event_id: normalizeText(snapshot.event_id),
        title: normalizeText(snapshot.title),
        event_url: normalizeText(snapshot.event_url),
        organizer: normalizeText(snapshot.organizer),
        date_time: normalizeText(snapshot.date_time),
        location: normalizeText(snapshot.location),
        attendee_count: normalizeText(snapshot.attendee_count),
        description: normalizeText(snapshot.description),
        is_online: snapshot.is_online,
        rsvp_state: snapshot.rsvp_state
      };
    } catch (error) {
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn event details."
      );
    }
  }

  prepareRsvp(
    input: PrepareEventRsvpInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const { eventId, eventUrl } = resolveEventReference(input.event);
    const target = {
      profile_name: profileName,
      event_id: eventId,
      event_url: eventUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: EVENT_RSVP_ACTION_TYPE,
      target,
      payload: {
        response: "attend"
      },
      preview: {
        summary: `RSVP attend for LinkedIn event ${eventId}`,
        target,
        payload: {
          response: "attend"
        }
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
