import { type Page } from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import {
  LinkedInBuddyError,
  asLinkedInBuddyError
} from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  createPrepareRateLimitMessage,
  peekRateLimitPreviewOrThrow,
  type ConsumeRateLimitInput,
  type RateLimiter
} from "./rateLimiter.js";
import {
  buildLinkedInSelectorPhraseRegex,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorRegistry,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";
import { normalizeText, getOrCreatePage, escapeRegExp } from "./shared.js";

export const GROUP_CREATE_ACTION_TYPE = "groups.create";
export const GROUP_JOIN_ACTION_TYPE = "groups.join";
export const GROUP_LEAVE_ACTION_TYPE = "groups.leave";
export const GROUP_POST_ACTION_TYPE = "groups.post";

const GROUP_RATE_LIMIT_CONFIGS = {
  
  [GROUP_CREATE_ACTION_TYPE]: {
    counterKey: "linkedin.groups.create",
    limit: 10,
    windowSizeMs: 24 * 60 * 60 * 1000,
  },
  [GROUP_JOIN_ACTION_TYPE]: {
    counterKey: "linkedin.groups.join",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [GROUP_LEAVE_ACTION_TYPE]: {
    counterKey: "linkedin.groups.leave",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 10
  },
  [GROUP_POST_ACTION_TYPE]: {
    counterKey: "linkedin.groups.post",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 1
  }
} as const satisfies Record<string, ConsumeRateLimitInput>;

export type LinkedInGroupMembershipState =
  | "member"
  | "joinable"
  | "pending"
  | "unknown";

export interface LinkedInGroupsSearchResult {
  group_id: string;
  name: string;
  group_url: string;
  visibility: string;
  member_count: string;
  description: string;
  membership_state: LinkedInGroupMembershipState;
}

export interface LinkedInGroupDetail {
  group_id: string;
  name: string;
  group_url: string;
  visibility: string;
  member_count: string;
  description: string;
  about: string;
  joined_at: string | null;
  membership_state: LinkedInGroupMembershipState;
}


export interface CreateGroupInput {
  profileName?: string;
  name: string;
  description: string;
  rules?: string;
  industry?: string;
  location?: string;
  isUnlisted?: boolean;
  operatorNote?: string;
}

export interface SearchGroupsInput {
  profileName?: string;
  query: string;
  limit?: number;
}

export interface ViewGroupInput {
  profileName?: string;
  group: string;
}

export interface SearchGroupsOutput {
  query: string;
  results: LinkedInGroupsSearchResult[];
  count: number;
}

export interface PrepareJoinGroupInput {
  profileName?: string;
  group: string;
  operatorNote?: string;
}

export interface PrepareLeaveGroupInput {
  profileName?: string;
  group: string;
  operatorNote?: string;
}

export interface PreparePostToGroupInput {
  profileName?: string;
  group: string;
  text: string;
  operatorNote?: string;
}

export interface LinkedInGroupsExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInGroupsRuntime extends LinkedInGroupsExecutorRuntime {
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInGroupsExecutorRuntime>, "prepare">;
}

interface GroupSearchSnapshot {
  group_id: string;
  name: string;
  group_url: string;
  visibility: string;
  member_count: string;
  description: string;
  membership_state: LinkedInGroupMembershipState;
}

interface GroupDetailSnapshot {
  group_id: string;
  name: string;
  group_url: string;
  visibility: string;
  member_count: string;
  description: string;
  about: string;
  joined_at: string | null;
  membership_state: LinkedInGroupMembershipState;
}

function getGroupRateLimitConfig(actionType: string): ConsumeRateLimitInput {
  const config = (
    GROUP_RATE_LIMIT_CONFIGS as Record<string, ConsumeRateLimitInput>
  )[actionType];

  if (!config) {
    throw new LinkedInBuddyError("UNKNOWN", "Missing rate limit policy.", {
      action_type: actionType
    });
  }

  return config;
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

function extractGroupId(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  const urlMatch = /\/groups\/(\d+)/iu.exec(normalized);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const idMatch = /^\d+$/u.exec(normalized);
  return idMatch?.[0] ?? "";
}

export function buildGroupSearchUrl(query: string): string {
  return `https://www.linkedin.com/search/results/groups/?keywords=${encodeURIComponent(query)}`;
}

export function buildGroupViewUrl(groupId: string): string {
  return `https://www.linkedin.com/groups/${encodeURIComponent(groupId)}/`;
}

function resolveGroupReference(group: string): {
  groupId: string;
  groupUrl: string;
} {
  const groupId = extractGroupId(group);
  if (!groupId) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "group must be a LinkedIn group URL or numeric ID."
    );
  }

  return {
    groupId,
    groupUrl: buildGroupViewUrl(groupId)
  };
}

async function waitForGroupSearchSurface(page: Page): Promise<void> {
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

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn group search content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function waitForGroupDetailSurface(page: Page): Promise<void> {
  const selectors = [
    ".groups-details-view",
    ".groups-guest-view",
    ".groups-header",
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

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not locate LinkedIn group detail content.",
    {
      current_url: page.url(),
      attempted_selectors: selectors
    }
  );
}

async function scrollSearchResultsIfNeeded(
  page: Page,
  extractor: (currentPage: Page, limit: number) => Promise<GroupSearchSnapshot[]>,
  limit: number
): Promise<GroupSearchSnapshot[]> {
  let snapshots = await extractor(page, limit);

  for (let pass = 0; pass < 6 && snapshots.length < limit; pass += 1) {
    await page.mouse.wheel(0, 1_800);
    await page.waitForTimeout(500);
    snapshots = await extractor(page, limit);
  }

  return snapshots;
}

/* eslint-disable no-undef */
async function extractGroupSearchResults(
  page: Page,
  limit: number
): Promise<GroupSearchSnapshot[]> {
  return page.evaluate((maxGroups: number) => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const extractGroupIdFromUrl = (value: string): string => {
      const match = /\/groups\/(\d+)/iu.exec(value);
      return match?.[1] ?? "";
    };

    const origin = globalThis.window.location.origin;
    const links = Array.from(
      globalThis.document.querySelectorAll("main a[href*='/groups/'], ul a[href*='/groups/'], .search-results-container a[href*='/groups/']")
    ).filter((link): link is HTMLAnchorElement => {
      const href = normalize(link.getAttribute("href"));
      return /\/groups\/[A-Za-z0-9-]+/.test(href);
    });

    const seen = new Set<string>();
    const uniqueLinks = links.filter((link) => {
      const href = normalize(link.getAttribute("href")) || normalize(link.href);
      const idMatch = /\/groups\/([^/?#]+)/.exec(href);
      const groupKey = normalize(idMatch?.[1]);
      if (!groupKey || seen.has(groupKey)) {
        return false;
      }
      seen.add(groupKey);
      return true;
    });

    return uniqueLinks.slice(0, maxGroups).map((link) => {
      const card = link.closest("li") ?? link.closest("div[data-view-tracking-scope]") ?? link.closest("div.search-result__wrapper") ?? link.parentElement;
      
      const rawText = normalize((card as HTMLElement)?.innerText ?? link.innerText ?? "");
      const lines = rawText
        .split("\n")
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);
        
      const visibility =
        lines.find((line) =>
          /(?:public|private)(?: listed)? group/iu.test(line)
        ) ?? "";
      const memberCount =
        lines.find((line) => /\b(?:members|medlemmer)\b/iu.test(line)) ?? "";
      const actionLabel =
        lines.find((line) => /^(?:join|requested to join)$/iu.test(line)) ?? "";
        
      const nameMatch = link.querySelector("span[dir='ltr'] span[aria-hidden='true']") ?? link.querySelector("span[aria-hidden='true']");
      const nameFromSpan = normalize(nameMatch?.textContent);
      const name = nameFromSpan || lines[0] || "";
      
      const description = normalize(
        lines
          .filter(
            (line) =>
              line !== name &&
              line !== visibility &&
              line !== memberCount &&
              line !== actionLabel
          )
          .join(" ")
      );
      const membershipState =
        /^requested to join$/iu.test(actionLabel)
          ? "pending"
          : /^join$/iu.test(actionLabel)
            ? "joinable"
            : "unknown";

      const href = normalize(link.getAttribute("href")) || normalize(link.href);
      const groupUrl = href.startsWith("/") ? `${origin}${href}` : href;

      return {
        group_id: extractGroupIdFromUrl(groupUrl),
        name,
        group_url: groupUrl,
        visibility,
        member_count: memberCount,
        description,
        membership_state: membershipState
      } satisfies GroupSearchSnapshot;
    });
  }, limit);
}
/* eslint-enable no-undef */

async function extractGroupDetailSnapshot(page: Page): Promise<GroupDetailSnapshot> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const title =
      normalize(
        globalThis.document.querySelector("main h1")?.textContent
      ) ||
      normalize(
        globalThis.document.querySelector(".groups-header h1")?.textContent
      );
    const url = normalize(globalThis.window.location.href);
    const groupId = /\/groups\/(\d+)/iu.exec(url)?.[1] ?? "";
    const lines = globalThis.document.body.innerText
      .split("\n")
      .map((line) => normalize(line))
      .filter((line) => line.length > 0);
    const visibility =
      lines.find((line) =>
        /^(?:public|private)(?: listed)?(?: group)?$/iu.test(line)
      ) ?? "";
    const memberCount =
      lines.find((line) => /^\d[\d.,\s]*(?:members|medlemmer)\b$/iu.test(line)) ?? "";

    const extractSection = (
      headingPattern: RegExp,
      stopPatterns: RegExp[]
    ): string => {
      const startIndex = lines.findIndex((line) => headingPattern.test(line));
      if (startIndex < 0) {
        return "";
      }

      const values: string[] = [];
      for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (stopPatterns.some((pattern) => pattern.test(line))) {
          break;
        }
        values.push(line);
      }

      return normalize(values.join(" "));
    };

    const about = extractSection(/^(?:About this group|About)$/iu, [
      /^(?:Show all|Member highlights|Admins|Members|About|Accessibility|Help Center)$/iu,
      /^\d+\s+(?:connections|members)\b/iu
    ]);
    const joinedRaw =
      lines.find((line) => /^Joined group:/iu.test(line)) ?? null;
    const membershipState = lines.some((line) => /^Start a post in this group$/iu.test(line))
      ? "member"
      : lines.some((line) => /^Requested to join$/iu.test(line))
        ? "pending"
        : lines.some((line) => /^Join$/iu.test(line))
          ? "joinable"
          : "unknown";

    return {
      group_id: groupId,
      name: title,
      group_url: url,
      visibility,
      member_count: memberCount,
      description: about,
      about,
      joined_at: joinedRaw ? normalize(joinedRaw.replace(/^Joined group:\s*/iu, "")) : null,
      membership_state: membershipState
    } satisfies GroupDetailSnapshot;
  });
}
async function isDialogVisible(page: Page): Promise<boolean> {
  return page
    .locator("div[role='dialog'], aside[role='dialog']")
    .first()
    .isVisible()
    .catch(() => false);
}

async function executeJoinGroup(
  runtime: LinkedInGroupsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const groupId = String(target.group_id ?? "");
  const groupUrl =
    normalizeText(String(target.group_url ?? "")) || buildGroupViewUrl(groupId);

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
        actionType: GROUP_JOIN_ACTION_TYPE,
        profileName,
        targetUrl: groupUrl,
        metadata: {
          group_id: groupId,
          group_url: groupUrl
        },
        errorDetails: {
          group_id: groupId,
          group_url: groupUrl
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getGroupRateLimitConfig(GROUP_JOIN_ACTION_TYPE),
            message: createConfirmRateLimitMessage(GROUP_JOIN_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              group_id: groupId,
              group_url: groupUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn group join action."
          ),
        execute: async () => {
          await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupDetailSurface(page);

          const joinRegex = buildLocalizedRegex(
            runtime.selectorLocale,
            ["Join"],
            ["Deltag", "Bliv medlem"],
            { exact: true }
          );
          const joinButton = page.getByRole("button", {
            name: joinRegex
          }).first();
          await joinButton.click({ timeout: 5_000 });

          await waitForCondition(async () => {
            const joinVisible = await page
              .getByRole("button", {
                name: joinRegex
              })
              .first()
              .isVisible()
              .catch(() => false);
            if (!joinVisible) {
              return true;
            }

            const bodyText = await page.locator("body").innerText().catch(() => "");
            return /requested to join|joined group:/iu.test(bodyText);
          }, 8_000);

          const bodyText = await page.locator("body").innerText().catch(() => "");
          const status = /requested to join/iu.test(bodyText)
            ? "group_join_requested"
            : /joined group:/iu.test(bodyText) ||
                (await page
                  .getByRole("button", {
                    name: buildLinkedInSelectorPhraseRegex(
                      "start_post",
                      runtime.selectorLocale
                    )
                  })
                  .first()
                  .isVisible()
                  .catch(() => false))
              ? "group_joined"
              : "group_join_submitted";

          return {
            ok: true,
            result: {
              status,
              group_id: groupId,
              group_url: groupUrl
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeLeaveGroup(
  runtime: LinkedInGroupsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const groupId = String(target.group_id ?? "");
  const groupUrl =
    normalizeText(String(target.group_url ?? "")) || buildGroupViewUrl(groupId);

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
        actionType: GROUP_LEAVE_ACTION_TYPE,
        profileName,
        targetUrl: groupUrl,
        metadata: {
          group_id: groupId,
          group_url: groupUrl
        },
        errorDetails: {
          group_id: groupId,
          group_url: groupUrl
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getGroupRateLimitConfig(GROUP_LEAVE_ACTION_TYPE),
            message: createConfirmRateLimitMessage(GROUP_LEAVE_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              group_id: groupId,
              group_url: groupUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn group leave action."
          ),
        execute: async () => {
          await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupDetailSurface(page);

          await page.locator(".groups-action-dropdown__trigger").first().click({
            timeout: 5_000
          });
          await page.waitForTimeout(500);

          await page.getByText(
            buildLocalizedRegex(
              runtime.selectorLocale,
              ["Leave this group"],
              ["Forlad denne gruppe"],
              { exact: true }
            )
          ).first().click({ timeout: 5_000 });

          await page.getByRole("button", {
            name: buildLinkedInSelectorPhraseRegex("leave", runtime.selectorLocale, {
              exact: true
            })
          }).last().click({ timeout: 5_000 });

          const joinRegex = buildLocalizedRegex(
            runtime.selectorLocale,
            ["Join"],
            ["Deltag", "Bliv medlem"],
            { exact: true }
          );
          const finished = await waitForCondition(
            async () =>
              await page
                .getByRole("button", {
                  name: joinRegex
                })
                .first()
                .isVisible()
                .catch(() => false),
            8_000
          );

          if (!finished) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "LinkedIn leave group flow could not be verified after confirmation.",
              {
                group_id: groupId,
                group_url: groupUrl
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "group_left",
              group_id: groupId,
              group_url: groupUrl
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executePostToGroup(
  runtime: LinkedInGroupsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const groupId = String(target.group_id ?? "");
  const groupUrl =
    normalizeText(String(target.group_url ?? "")) || buildGroupViewUrl(groupId);
  const text = normalizeText(String(payload.text ?? ""));

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
        actionType: GROUP_POST_ACTION_TYPE,
        profileName,
        targetUrl: groupUrl,
        metadata: {
          group_id: groupId,
          group_url: groupUrl
        },
        errorDetails: {
          group_id: groupId,
          group_url: groupUrl
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getGroupRateLimitConfig(GROUP_POST_ACTION_TYPE),
            message: createConfirmRateLimitMessage(GROUP_POST_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              group_id: groupId,
              group_url: groupUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn group post action."
          ),
        execute: async () => {
          await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupDetailSurface(page);

          await page.getByRole("button", {
            name: buildLinkedInSelectorPhraseRegex("start_post", runtime.selectorLocale)
          }).first().click({ timeout: 5_000 });

          const editor = page
            .locator("div[role='textbox'][contenteditable='true']")
            .first();
          await editor.waitFor({ state: "visible", timeout: 5_000 });
          await editor.fill(text);

          await page.getByRole("button", {
            name: buildLinkedInSelectorPhraseRegex("post", runtime.selectorLocale, {
              exact: true
            })
          }).first().click({ timeout: 5_000 });

          const closed = await waitForCondition(
            async () => !(await isDialogVisible(page)),
            8_000
          );
          if (!closed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "LinkedIn group post composer stayed open after submitting the post.",
              {
                group_id: groupId,
                group_url: groupUrl
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "group_post_published",
              group_id: groupId,
              group_url: groupUrl
            },
            artifacts: []
          };
        }
      });
    }
  );
}


 
export class CreateGroupActionExecutor
  implements ActionExecutor<LinkedInGroupsExecutorRuntime>
{
  async execute({
    runtime,
    action,
  }: ActionExecutorInput<LinkedInGroupsExecutorRuntime>): Promise<ActionExecutorResult> {
    const data = action.payload as unknown as CreateGroupInput;
    
    // Check rate limit before executing
    await consumeRateLimitOrThrow(runtime.rateLimiter, {
      config: getGroupRateLimitConfig(GROUP_CREATE_ACTION_TYPE),
      message: createConfirmRateLimitMessage(GROUP_CREATE_ACTION_TYPE)
    });

    const group = await runtime.profileManager.runWithPersistentContext(
      data.profileName ?? "default",
      { headless: false },
      async (context) => {
        const page = await context.newPage();
        try {
          await page.goto("https://www.linkedin.com/groups/create/", {
            waitUntil: "domcontentloaded",
          });
          
          const nameLocator = page.locator("input[name='groupName']").or(page.getByLabel(/Group name/i)).or(page.getByRole("textbox", { name: /Group name/i })).first();
          await nameLocator.waitFor({ state: "visible", timeout: 10000 });
          await nameLocator.fill(data.name);
          
          if (data.description) {
            await page.locator("textarea[name='groupDescription']").fill(data.description);
          }
          
          if (data.rules) {
            await page.locator("textarea[name='groupRules']").fill(data.rules);
          }
          
          if (data.isUnlisted) {
            await page.locator("label[for='unlisted-group']").click();
          }
          
          await page.locator("button[type='submit']").click();
          
          // Wait for redirect to new group page
          await page.waitForURL(/\/groups\/\d+/i, { timeout: 15000 });
          
          const url = page.url();
          const groupId = /\/groups\/(\d+)/iu.exec(url)?.[1] ?? "";
          
          return {
            group_id: groupId,
            name: data.name,
            group_url: url
          };
        } finally {
          await page.close().catch(() => {});
        }
      },
    );

    return {
      ok: true,
      result: {
        message: `Successfully created LinkedIn group: "${data.name}"`,
        data: group,
      },
      artifacts: [],
    };
  }
}

export class JoinGroupActionExecutor
  implements ActionExecutor<LinkedInGroupsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInGroupsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeJoinGroup(
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

export class LeaveGroupActionExecutor
  implements ActionExecutor<LinkedInGroupsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInGroupsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeLeaveGroup(
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

export class PostToGroupActionExecutor
  implements ActionExecutor<LinkedInGroupsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInGroupsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executePostToGroup(
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

export function createGroupActionExecutors(): ActionExecutorRegistry<LinkedInGroupsExecutorRuntime> {
  return {
    [GROUP_JOIN_ACTION_TYPE]: new JoinGroupActionExecutor(),
    [GROUP_LEAVE_ACTION_TYPE]: new LeaveGroupActionExecutor(),
    [GROUP_POST_ACTION_TYPE]: new PostToGroupActionExecutor(),
    [GROUP_CREATE_ACTION_TYPE]: new CreateGroupActionExecutor()
  };
}

export class LinkedInGroupsService {
  constructor(private readonly runtime: LinkedInGroupsRuntime) {}


  prepareCreateGroup(
    input: CreateGroupInput,
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const target = {
      profile_name: profileName
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: GROUP_CREATE_ACTION_TYPE,
      target,
      payload: {
        profileName,
        name: input.name,
        description: input.description,
        rules: input.rules,
        industry: input.industry,
        location: input.location,
        isUnlisted: input.isUnlisted,
      },
      preview: {
        summary: `Create LinkedIn group "${input.name}"`,
        action: "Create Group",
        group_name: input.name,
        description: input.description,
        rate_limit: peekRateLimitPreviewOrThrow(
          this.runtime.rateLimiter,
          getGroupRateLimitConfig(GROUP_CREATE_ACTION_TYPE),
          createPrepareRateLimitMessage(GROUP_CREATE_ACTION_TYPE)
        )
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async searchGroups(input: SearchGroupsInput): Promise<SearchGroupsOutput> {
    const profileName = input.profileName ?? "default";
    const query = normalizeText(input.query);
    const limit = readSearchLimit(input.limit);
    if (!query) {
      throw new LinkedInBuddyError(
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
          await page.goto(buildGroupSearchUrl(query), {
            waitUntil: "domcontentloaded"
          });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupSearchSurface(page);
          await page
            .locator(
              ".reusable-search__result-container, li.reusable-search__result-container"
            )
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => page.waitForTimeout(2_000));
          return scrollSearchResultsIfNeeded(page, extractGroupSearchResults, limit);
        }
      );

      const results = snapshots
        .map((snapshot) => ({
          group_id: normalizeText(snapshot.group_id),
          name: normalizeText(snapshot.name),
          group_url: normalizeText(snapshot.group_url),
          visibility: normalizeText(snapshot.visibility),
          member_count: normalizeText(snapshot.member_count),
          description: normalizeText(snapshot.description),
          membership_state: snapshot.membership_state
        }))
        .filter((result) => result.name.length > 0 || result.group_url.length > 0)
        .slice(0, limit);

      return {
        query,
        results,
        count: results.length
      };
    } catch (error) {
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to search LinkedIn groups."
      );
    }
  }

  async viewGroup(input: ViewGroupInput): Promise<LinkedInGroupDetail> {
    const profileName = input.profileName ?? "default";
    const { groupUrl } = resolveGroupReference(input.group);

    await this.runtime.auth.ensureAuthenticated({
      profileName
    });

    try {
      const snapshot = await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          await waitForGroupDetailSurface(page);
          return extractGroupDetailSnapshot(page);
        }
      );

      return {
        group_id: normalizeText(snapshot.group_id),
        name: normalizeText(snapshot.name),
        group_url: normalizeText(snapshot.group_url),
        visibility: normalizeText(snapshot.visibility),
        member_count: normalizeText(snapshot.member_count),
        description: normalizeText(snapshot.description),
        about: normalizeText(snapshot.about),
        joined_at: snapshot.joined_at ? normalizeText(snapshot.joined_at) : null,
        membership_state: snapshot.membership_state
      };
    } catch (error) {
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn group details."
      );
    }
  }

  private prepareTargetedGroupAction(input: {
    actionType: string;
    profileName?: string;
    group: string;
    summary: string;
    payload?: Record<string, unknown>;
    operatorNote?: string;
  }): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const { groupId, groupUrl } = resolveGroupReference(input.group);
    const target = {
      profile_name: profileName,
      group_id: groupId,
      group_url: groupUrl
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target,
      payload: input.payload ?? {},
      preview: {
        summary: input.summary,
        target,
        ...(input.payload ? { payload: input.payload } : {}),
        rate_limit: peekRateLimitPreviewOrThrow(
          this.runtime.rateLimiter,
          getGroupRateLimitConfig(input.actionType),
          createPrepareRateLimitMessage(input.actionType)
        )
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareJoinGroup(
    input: PrepareJoinGroupInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const { groupId } = resolveGroupReference(input.group);
    return this.prepareTargetedGroupAction({
      actionType: GROUP_JOIN_ACTION_TYPE,
      group: input.group,
      summary: `Join LinkedIn group ${groupId}`,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareLeaveGroup(
    input: PrepareLeaveGroupInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const { groupId } = resolveGroupReference(input.group);
    return this.prepareTargetedGroupAction({
      actionType: GROUP_LEAVE_ACTION_TYPE,
      group: input.group,
      summary: `Leave LinkedIn group ${groupId}`,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  preparePostToGroup(
    input: PreparePostToGroupInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const text = normalizeText(input.text);
    if (!text) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "text is required."
      );
    }

    const { groupId } = resolveGroupReference(input.group);
    return this.prepareTargetedGroupAction({
      actionType: GROUP_POST_ACTION_TYPE,
      group: input.group,
      summary: `Post in LinkedIn group ${groupId}`,
      payload: {
        text
      },
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
