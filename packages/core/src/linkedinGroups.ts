import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type {
  LinkedInGroupSearchResult,
  LinkedInSearchService
} from "./linkedinSearch.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";

export interface SearchGroupsInput {
  profileName?: string;
  query: string;
  limit?: number;
}

export interface SearchGroupsOutput {
  query: string;
  results: LinkedInGroupSearchResult[];
  count: number;
}

export interface ViewGroupInput {
  profileName?: string;
  target: string;
}

export type LinkedInGroupJoinState =
  | "joined"
  | "not_joined"
  | "requested"
  | "unknown";

export interface LinkedInGroup {
  group_url: string;
  group_id: string | null;
  name: string;
  description: string;
  member_count: string;
  group_type: string;
  visibility_description: string;
  join_state: LinkedInGroupJoinState;
}

interface LinkedInGroupsSnapshot {
  current_url: string;
  name: string;
  header_text: string;
  header_actions: string[];
  about_text: string;
}

export interface LinkedInGroupsRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  search: Pick<LinkedInSearchService, "search">;
}

const GROUP_TYPE_PATTERN =
  /\b(Public group|Private(?:\s+Listed|\s+Unlisted)?|Private group)\b/i;
const GROUP_MEMBER_COUNT_PATTERN =
  /(\d[\d,.]*\s*(?:[KMB])?\s+members?)/i;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPhrase(text: string, phrase: string): string {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) {
    return text;
  }

  return text.replace(new RegExp(escapeRegex(normalizedPhrase), "gi"), " ");
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function decodeGroupPathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Group URL contains an invalid encoded path segment.",
      {},
      error instanceof Error ? { cause: error } : undefined
    );
  }
}

function toInvalidGroupUrlError(error: unknown): LinkedInAssistantError {
  if (
    error instanceof URIError ||
    (error instanceof Error && /uri malformed/i.test(error.message))
  ) {
    return new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Group URL contains an invalid encoded path segment."
    );
  }

  return new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Group URL must be a valid URL.",
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

async function waitForGroupSurface(page: Page): Promise<void> {
  const selectors = [
    "main h1",
    ".groups-entity",
    ".groups-guest-view",
    ".groups-details",
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
    "Could not locate LinkedIn group detail content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

export function resolveGroupUrl(target: string): string {
  const normalizedTarget = normalizeText(target);
  if (!normalizedTarget) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Group target is required."
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
      throw toInvalidGroupUrlError(error);
    }

    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");

    if (!isLinkedInDomain || segments[0] !== "groups" || !segments[1]) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Group URL must point to linkedin.com/groups/.",
        { target: normalizedTarget }
      );
    }

    return `https://www.linkedin.com/groups/${encodeURIComponent(
      decodeGroupPathSegment(segments[1])
    )}/`;
  }

  if (normalizedTarget.startsWith("/groups/")) {
    const [, , groupId = ""] = normalizedTarget.split("/");
    const normalizedGroupId = normalizeText(groupId);
    if (!normalizedGroupId) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Group target is required."
      );
    }

    return `https://www.linkedin.com/groups/${encodeURIComponent(
      normalizedGroupId
    )}/`;
  }

  return `https://www.linkedin.com/groups/${encodeURIComponent(normalizedTarget)}/`;
}

export function normalizeLinkedInGroupUrl(target: string): string {
  const resolved = resolveGroupUrl(target);

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

export function extractGroupId(url: string): string | null {
  const match = /\/groups\/([^/?#]+)/i.exec(url);
  const groupId = match?.[1];
  if (!groupId) {
    return null;
  }

  try {
    return decodeURIComponent(groupId);
  } catch {
    return groupId;
  }
}

export function cleanLinkedInGroupAboutText(value: string): string {
  let text = normalizeText(value);
  text = text.replace(/^Dialog content start\.?\s*/i, "");
  text = text.replace(/^About this group\s*/i, "");
  text = text.replace(/^Description\s*/i, "");

  const detailsSectionMatch =
    /\sDetails\s+(?=(?:Private|Public|Only members|Listed|Created\b|Group appears|Anyone, on or off LinkedIn))/i.exec(
      text
    );
  const detailsIndex = detailsSectionMatch?.index ?? -1;
  if (detailsIndex >= 0) {
    text = text.slice(0, detailsIndex);
  }

  text = text.replace(
    /\s*Show all(?: the details about the group.*)?$/i,
    ""
  );
  text = text.replace(/\s*Done\s*Dialog content end\.?$/i, "");
  return normalizeText(text);
}

function extractGroupType(
  headerText: string,
  actions: readonly string[]
): string {
  const actionMatch = actions
    .map((value) => normalizeText(value))
    .find((value) => GROUP_TYPE_PATTERN.test(value));

  if (actionMatch) {
    const match = GROUP_TYPE_PATTERN.exec(actionMatch);
    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  const headerMatch = GROUP_TYPE_PATTERN.exec(headerText);
  return normalizeText(headerMatch?.[1]);
}

function extractGroupMemberCount(
  headerText: string,
  aboutText: string
): string {
  const headerMatch = GROUP_MEMBER_COUNT_PATTERN.exec(headerText);
  if (headerMatch?.[1]) {
    return normalizeText(headerMatch[1]);
  }

  const aboutMatch = GROUP_MEMBER_COUNT_PATTERN.exec(aboutText);
  return normalizeText(aboutMatch?.[1]);
}

export function parseLinkedInGroupJoinState(input: {
  headerText: string;
  actions: readonly string[];
}): LinkedInGroupJoinState {
  const haystacks = [input.headerText, ...input.actions]
    .map((value) => normalizeText(value).toLowerCase())
    .filter((value) => value.length > 0);

  if (haystacks.some((value) => value.includes("requested"))) {
    return "requested";
  }

  if (
    haystacks.some(
      (value) =>
        value.includes("leave this group") ||
        value.includes("manage notifications") ||
        value.includes("update your settings")
    )
  ) {
    return "joined";
  }

  if (
    haystacks.some(
      (value) =>
        value === "join" ||
        value.startsWith("join ") ||
        value.includes(" group join")
    )
  ) {
    return "not_joined";
  }

  return "unknown";
}

function buildGroupVisibilityDescription(input: {
  name: string;
  headerText: string;
  actions: readonly string[];
  groupType: string;
  memberCount: string;
}): string {
  let value = normalizeText(input.headerText);
  if (!value) {
    return "";
  }

  if (input.name) {
    value = value.replace(new RegExp(`^${escapeRegex(input.name)}\\s*`, "i"), "");
  }

  value = stripPhrase(value, input.groupType);
  value = stripPhrase(value, input.memberCount);
  value = stripPhrase(value, `Join ${input.name} group Join`);
  value = stripPhrase(value, `Join ${input.name} group`);

  for (const action of input.actions) {
    value = stripPhrase(value, action);
  }

  return normalizeText(value);
}

async function extractGroupSnapshot(page: Page): Promise<LinkedInGroupsSnapshot> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const heading = globalThis.document.querySelector("main h1");
    const headerRoot = heading?.closest("section,div,article");
    const aboutRoot = Array.from(
      globalThis.document.querySelectorAll("section,div,article,aside")
    ).find((element) => {
      const text = normalize(element.textContent);
      return (
        /^About this group\b/i.test(text) ||
        /^Dialog content start\.?\s*About this group\b/i.test(text)
      );
    });

    const headerActions =
      !headerRoot
        ? []
        : Array.from(
            headerRoot.querySelectorAll("button,a,[role='button']")
          )
            .map((element) => {
              const buttonText = normalize(element.textContent);
              const ariaLabel = normalize(element.getAttribute("aria-label"));
              return buttonText || ariaLabel;
            })
            .filter((value) => value.length > 0)
            .slice(0, 24);

    return {
      current_url: globalThis.window.location.href,
      name: normalize(heading?.textContent),
      header_text: normalize(headerRoot?.textContent),
      header_actions: headerActions,
      about_text: normalize(aboutRoot?.textContent)
    };
  });
}

export class LinkedInGroupsService {
  constructor(private readonly runtime: LinkedInGroupsRuntime) {}

  async searchGroups(input: SearchGroupsInput): Promise<SearchGroupsOutput> {
    const query = normalizeText(input.query);
    if (!query) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "query is required."
      );
    }

    const result = await this.runtime.search.search({
      query,
      category: "groups",
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {})
    });

    if (result.category !== "groups") {
      throw new LinkedInAssistantError(
        "UNKNOWN",
        "LinkedIn search returned an unexpected category for groups search."
      );
    }

    return {
      query: result.query,
      results: result.results,
      count: result.count
    };
  }

  async viewGroup(input: ViewGroupInput): Promise<LinkedInGroup> {
    const profileName = input.profileName ?? "default";
    const targetUrl = normalizeLinkedInGroupUrl(input.target);

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      let snapshot = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupSurface(page);

          let extracted = await extractGroupSnapshot(page);
          if (!extracted.about_text) {
            const aboutButton = page
              .getByRole("button", { name: /open about group/i })
              .first();
            if (await aboutButton.isVisible().catch(() => false)) {
              await aboutButton.click().catch(() => undefined);
              await page.waitForTimeout(1_000);
              extracted = await extractGroupSnapshot(page);
            }
          }

          return extracted;
        }
      );

      snapshot = {
        ...snapshot,
        current_url: normalizeLinkedInGroupUrl(snapshot.current_url || targetUrl),
        name: normalizeText(snapshot.name),
        header_text: normalizeText(snapshot.header_text),
        header_actions: snapshot.header_actions.map((value) => normalizeText(value)),
        about_text: cleanLinkedInGroupAboutText(snapshot.about_text)
      };

      const groupType = extractGroupType(
        snapshot.header_text,
        snapshot.header_actions
      );
      const memberCount = extractGroupMemberCount(
        snapshot.header_text,
        snapshot.about_text
      );
      const visibilityDescription = buildGroupVisibilityDescription({
        name: snapshot.name,
        headerText: snapshot.header_text,
        actions: snapshot.header_actions,
        groupType,
        memberCount
      });

      return {
        group_url: snapshot.current_url,
        group_id: extractGroupId(snapshot.current_url),
        name: snapshot.name,
        description: snapshot.about_text || visibilityDescription,
        member_count: memberCount,
        group_type: groupType,
        visibility_description: visibilityDescription,
        join_state: parseLinkedInGroupJoinState({
          headerText: snapshot.header_text,
          actions: snapshot.header_actions
        })
      };
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }

      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn group."
      );
    }
  }
}
