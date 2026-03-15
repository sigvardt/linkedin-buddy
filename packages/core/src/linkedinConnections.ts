import { type Locator, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import type { AssistantDatabase } from "./db/database.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  normalizeText,
  getOrCreatePage,
  escapeCssAttributeValue
} from "./shared.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  createPrepareRateLimitMessage,
  peekRateLimitPreviewOrThrow,
  type ConsumeRateLimitInput,
  type RateLimiter
} from "./rateLimiter.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";
import { scrollLinkedInPageToBottom } from "./linkedinPage.js";
import type {
  LinkedInSelectorLocale,
  LinkedInSelectorPhraseKey
} from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  getLinkedInSelectorPhrases
} from "./selectorLocale.js";
import type { TwoPhaseCommitService } from "./twoPhaseCommit.js";
import type { ArtifactHelpers } from "./artifacts.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface LinkedInConnection {
  vanity_name: string | null;
  full_name: string;
  headline: string;
  profile_url: string;
  connected_since: string;
}

export interface LinkedInPendingInvitation {
  vanity_name: string | null;
  full_name: string;
  headline: string;
  profile_url: string;
  sent_or_received: "sent" | "received";
}

export interface ListConnectionsInput {
  profileName?: string;
  limit?: number;
}

export interface ListPendingInvitationsInput {
  profileName?: string;
  filter?: "sent" | "received" | "all";
}

export interface PrepareSendInvitationInput {
  profileName?: string;
  targetProfile: string;
  note?: string;
  operatorNote?: string;
}

interface PrepareRelationshipActionInput {
  profileName?: string;
  targetProfile: string;
  operatorNote?: string;
}

export type PrepareAcceptInvitationInput = PrepareRelationshipActionInput;

export type PrepareWithdrawInvitationInput = PrepareRelationshipActionInput;

export type PrepareIgnoreInvitationInput = PrepareRelationshipActionInput;

export type PrepareRemoveConnectionInput = PrepareRelationshipActionInput;

export type PrepareFollowMemberInput = PrepareRelationshipActionInput;

export type PrepareUnfollowMemberInput = PrepareRelationshipActionInput;

/**
 * Minimal runtime needed by connection action executors (no twoPhaseCommit).
 */
export interface LinkedInConnectionsExecutorRuntime {
  db: AssistantDatabase;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

/**
 * Full runtime for the connections service (includes twoPhaseCommit for prepare calls).
 */
export interface LinkedInConnectionsRuntime extends LinkedInConnectionsExecutorRuntime {
  twoPhaseCommit: Pick<TwoPhaseCommitService, "prepare">;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const SEND_INVITATION_ACTION_TYPE = "connections.send_invitation";
export const ACCEPT_INVITATION_ACTION_TYPE = "connections.accept_invitation";
export const WITHDRAW_INVITATION_ACTION_TYPE = "connections.withdraw_invitation";
export const IGNORE_INVITATION_ACTION_TYPE = "connections.ignore_invitation";
export const REMOVE_CONNECTION_ACTION_TYPE = "connections.remove_connection";
export const FOLLOW_MEMBER_ACTION_TYPE = "connections.follow_member";
export const UNFOLLOW_MEMBER_ACTION_TYPE = "connections.unfollow_member";

const CONNECTION_RATE_LIMIT_CONFIGS = {
  [SEND_INVITATION_ACTION_TYPE]: {
    counterKey: "linkedin.connections.send_invitation",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 15
  },
  [ACCEPT_INVITATION_ACTION_TYPE]: {
    counterKey: "linkedin.connections.accept_invitation",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 30
  },
  [WITHDRAW_INVITATION_ACTION_TYPE]: {
    counterKey: "linkedin.connections.withdraw_invitation",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 20
  },
  [IGNORE_INVITATION_ACTION_TYPE]: {
    counterKey: "linkedin.connections.ignore_invitation",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 30
  },
  [REMOVE_CONNECTION_ACTION_TYPE]: {
    counterKey: "linkedin.connections.remove_connection",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 20
  },
  [FOLLOW_MEMBER_ACTION_TYPE]: {
    counterKey: "linkedin.connections.follow_member",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 30
  },
  [UNFOLLOW_MEMBER_ACTION_TYPE]: {
    counterKey: "linkedin.connections.unfollow_member",
    windowSizeMs: 24 * 60 * 60 * 1000,
    limit: 30
  }
} as const satisfies Record<string, ConsumeRateLimitInput>;

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const INVITATIONS_RECEIVED_URL = "https://www.linkedin.com/mynetwork/invitation-manager/";
const INVITATIONS_SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function getConnectionRateLimitConfig(
  actionType: string
): ConsumeRateLimitInput {
  const config = (
    CONNECTION_RATE_LIMIT_CONFIGS as Record<string, ConsumeRateLimitInput>
  )[actionType];

  if (!config) {
    throw new LinkedInBuddyError("UNKNOWN", "Missing rate limit policy.", {
      action_type: actionType
    });
  }

  return config;
}

type LocatorRoot = Page | Locator;

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: LocatorRoot) => Locator;
}

async function findVisibleLocator(
  root: LocatorRoot,
  candidates: VisibleLocatorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await locator.isVisible().catch(() => false)) {
      return { locator, key: candidate.key };
    }
  }

  return null;
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

function extractVanityName(url: string): string | null {
  const match = /\/in\/([^/?#]+)/.exec(url);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function resolveProfileHrefFragment(targetProfile: string): string {
  const resolvedProfileUrl = resolveProfileUrl(targetProfile);
  const vanityName = extractVanityName(resolvedProfileUrl);
  return vanityName ? `/in/${vanityName}` : normalizeLinkedInProfileUrl(resolvedProfileUrl);
}

function buildPendingInvitationCardLocator(
  page: Page,
  targetProfile: string
): Locator {
  const escapedHrefFragment = escapeCssAttributeValue(
    resolveProfileHrefFragment(targetProfile)
  );

  return page.locator(
    [
      `li.invitation-card:has(a[href*="${escapedHrefFragment}"])`,
      `li[class*='invitation-card']:has(a[href*="${escapedHrefFragment}"])`,
      `div.invitation-card:has(a[href*="${escapedHrefFragment}"])`,
      `div[role='listitem']:has(a[href*="${escapedHrefFragment}"])`,
      `li[role='listitem']:has(a[href*="${escapedHrefFragment}"])`
    ].join(", ")
  ).first();
}

function buildProfileTopCardRoot(page: Page): Locator {
  return page.locator("main .pv-top-card, main").first();
}

function buildProfileMoreButtonCandidates(
  topCardRoot: Locator,
  selectorLocale: LinkedInSelectorLocale
): VisibleLocatorCandidate[] {
  const moreExactRegex = buildLinkedInSelectorPhraseRegex(
    "more",
    selectorLocale,
    { exact: true }
  );
  const moreExactRegexHint = formatLinkedInSelectorRegexHint(
    "more",
    selectorLocale,
    { exact: true }
  );
  const moreActionsAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    "more_actions",
    selectorLocale
  );

  return [
    {
      key: "topcard-more-role",
      selectorHint: `topCard.getByRole(button, ${moreExactRegexHint})`,
      locatorFactory: () =>
        topCardRoot.getByRole("button", {
          name: moreExactRegex
        })
    },
    {
      key: "topcard-more-actions-aria",
      selectorHint: `topCard ${moreActionsAriaSelector}`,
      locatorFactory: () => topCardRoot.locator(moreActionsAriaSelector)
    },
    {
      key: "page-more-role",
      selectorHint: `page.getByRole(button, ${moreExactRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", {
          name: moreExactRegex
        })
    }
  ];
}

function buildProfileActionButtonCandidates(input: {
  topCardRoot: Locator;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
}): VisibleLocatorCandidate[] {
  const exactRegex = buildLinkedInSelectorPhraseRegex(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const exactRegexHint = formatLinkedInSelectorRegexHint(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const ariaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    input.selectorKeys,
    input.selectorLocale
  );

  return [
    {
      key: `${input.candidateKeyPrefix}-topcard-role`,
      selectorHint: `topCard.getByRole(button, ${exactRegexHint})`,
      locatorFactory: () =>
        input.topCardRoot.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-topcard-aria`,
      selectorHint: `topCard ${ariaSelector}`,
      locatorFactory: () => input.topCardRoot.locator(ariaSelector)
    },
    {
      key: `${input.candidateKeyPrefix}-page-role`,
      selectorHint: `page.getByRole(button, ${exactRegexHint})`,
      locatorFactory: (targetPage) =>
        targetPage.getByRole("button", {
          name: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-page-aria`,
      selectorHint: ariaSelector,
      locatorFactory: (targetPage) => targetPage.locator(ariaSelector)
    }
  ];
}

function buildProfileMenuActionCandidates(input: {
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  candidateKeyPrefix: string;
}): VisibleLocatorCandidate[] {
  const exactRegex = buildLinkedInSelectorPhraseRegex(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const exactRegexHint = formatLinkedInSelectorRegexHint(
    input.selectorKeys,
    input.selectorLocale,
    { exact: true }
  );
  const textRegex = buildLinkedInSelectorPhraseRegex(
    input.selectorKeys,
    input.selectorLocale
  );
  const textRegexHint = formatLinkedInSelectorRegexHint(
    input.selectorKeys,
    input.selectorLocale
  );

  return [
    {
      key: `${input.candidateKeyPrefix}-menu-roleitem`,
      selectorHint: `[role='menuitem'] hasText ${exactRegexHint}`,
      locatorFactory: (page) =>
        page.locator("[role='menuitem']").filter({
          hasText: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-menu-dropdown-item`,
      selectorHint: `.artdeco-dropdown__content-inner [role='button'] hasText ${exactRegexHint}`,
      locatorFactory: (page) =>
        page.locator(".artdeco-dropdown__content-inner [role='button']").filter({
          hasText: exactRegex
        })
    },
    {
      key: `${input.candidateKeyPrefix}-menu-li-text`,
      selectorHint: `.artdeco-dropdown__content-inner li hasText ${textRegexHint}`,
      locatorFactory: (page) =>
        page.locator(".artdeco-dropdown__content-inner li").filter({
          hasText: textRegex
        })
    }
  ];
}

async function clickProfileAction(input: {
  page: Page;
  selectorLocale: LinkedInSelectorLocale;
  selectorKeys: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  menuSelectorKeys?: LinkedInSelectorPhraseKey | readonly LinkedInSelectorPhraseKey[];
  targetProfile: string;
  actionLabel: string;
  candidateKeyPrefix: string;
  allowMoreMenu?: boolean;
}): Promise<string> {
  const topCardRoot = buildProfileTopCardRoot(input.page);
  const directCandidates = buildProfileActionButtonCandidates({
    topCardRoot,
    selectorLocale: input.selectorLocale,
    selectorKeys: input.selectorKeys,
    candidateKeyPrefix: input.candidateKeyPrefix
  });
  const directAction = await findVisibleLocator(input.page, directCandidates);
  if (directAction) {
    await directAction.locator.click({ timeout: 5_000 });
    return directAction.key;
  }

  if (input.allowMoreMenu === false) {
    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not find ${input.actionLabel} button on profile page.`,
      {
        target_profile: input.targetProfile,
        url: input.page.url(),
        attempted_direct_selectors: directCandidates.map((candidate) => candidate.selectorHint)
      }
    );
  }

  const moreCandidates = buildProfileMoreButtonCandidates(
    topCardRoot,
    input.selectorLocale
  );
  const moreButton = await findVisibleLocator(input.page, moreCandidates);
  if (moreButton) {
    await moreButton.locator.click({ timeout: 5_000 });
    await input.page.waitForTimeout(600);

    const menuCandidates = buildProfileMenuActionCandidates({
      selectorLocale: input.selectorLocale,
      selectorKeys: input.menuSelectorKeys ?? input.selectorKeys,
      candidateKeyPrefix: input.candidateKeyPrefix
    });
    const menuAction = await findVisibleLocator(input.page, menuCandidates);
    if (menuAction) {
      await menuAction.locator.click({ timeout: 5_000 });
      return `${moreButton.key}:${menuAction.key}`;
    }

    throw new LinkedInBuddyError(
      "UI_CHANGED_SELECTOR_FAILED",
      `Could not find ${input.actionLabel} in the profile actions menu.`,
      {
        target_profile: input.targetProfile,
        url: input.page.url(),
        attempted_direct_selectors: directCandidates.map((candidate) => candidate.selectorHint),
        attempted_more_selectors: moreCandidates.map((candidate) => candidate.selectorHint),
        attempted_menu_selectors: menuCandidates.map((candidate) => candidate.selectorHint)
      }
    );
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not find ${input.actionLabel} control on profile page.`,
    {
      target_profile: input.targetProfile,
      url: input.page.url(),
      attempted_direct_selectors: directCandidates.map((candidate) => candidate.selectorHint),
      attempted_more_selectors: moreCandidates.map((candidate) => candidate.selectorHint)
    }
  );
}

function trackSentInvitationState(
  db: AssistantDatabase,
  profileName: string,
  invitation: Pick<
    LinkedInPendingInvitation,
    "profile_url" | "vanity_name" | "full_name" | "headline"
  >,
  nowMs: number
): void {
  const profileUrl = normalizeText(invitation.profile_url);
  if (!profileUrl) {
    return;
  }

  const profileUrlKey = normalizeLinkedInProfileUrl(profileUrl);
  db.upsertSentInvitationState({
    profileName,
    profileUrlKey,
    vanityName: invitation.vanity_name,
    fullName: normalizeText(invitation.full_name),
    headline: normalizeText(invitation.headline),
    profileUrl,
    firstSeenSentAtMs: nowMs,
    lastSeenSentAtMs: nowMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs
  });
}

/* ------------------------------------------------------------------ */
/*  Scraping helpers (run inside page.evaluate)                       */
/* ------------------------------------------------------------------ */

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */

async function scrapeConnections(
  page: Page,
  limit: number
): Promise<LinkedInConnection[]> {
  // Scroll to load more connections (lazy-loaded list)
  let lastHeight = 0;
  for (let i = 0; i < 10; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === lastHeight) break;
    lastHeight = currentHeight;
    await scrollLinkedInPageToBottom(page);
    await page.waitForTimeout(1000);
    const count = await page.evaluate(
      () =>
        document.querySelectorAll(
          "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card"
        ).length
    );
    if (count >= limit) break;
  }

  const connections = await page.evaluate((lim: number) => {
    const normalize = (v: string | null | undefined): string =>
      (v ?? "").replace(/\s+/g, " ").trim();

    const cards = Array.from(
      document.querySelectorAll(
        "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']"
      )
    ).slice(0, lim);

    return cards.map((card) => {
      const linkEl = card.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
      const profileUrl = linkEl?.href ?? "";
      const nameEl =
        card.querySelector(".mn-connection-card__name") ??
        card.querySelector(".entity-result__title-text a span[aria-hidden='true']") ??
        card.querySelector("span.mn-connection-card__name") ??
        card.querySelector("a[href*='/in/'] span[aria-hidden='true']");
      const fullName = normalize(nameEl?.textContent);

      const headlineEl =
        card.querySelector(".mn-connection-card__occupation") ??
        card.querySelector(".entity-result__primary-subtitle") ??
        card.querySelector("span.mn-connection-card__occupation");
      const headline = normalize(headlineEl?.textContent);

      const timeEl =
        card.querySelector("time") ??
        card.querySelector(".time-badge") ??
        card.querySelector("span.mn-connection-card__connected-time");
      const connectedSince = normalize(timeEl?.textContent);

      return {
        profile_url: profileUrl,
        full_name: fullName,
        headline,
        connected_since: connectedSince
      };
    });
  }, limit);

  return connections.map((c) => ({
    vanity_name: extractVanityName(c.profile_url),
    full_name: normalizeText(c.full_name),
    headline: normalizeText(c.headline),
    profile_url: normalizeText(c.profile_url),
    connected_since: normalizeText(c.connected_since)
  }));
}

async function scrapePendingInvitations(
  page: Page,
  sentOrReceived: "sent" | "received",
  selectorLocale: LinkedInSelectorLocale
): Promise<LinkedInPendingInvitation[]> {
  // Wait for invitation cards
  await page
    .locator("li.invitation-card, li[class*='invitation-card'], div[role='listitem']")
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);

  const sentSignals = getLinkedInSelectorPhrases(
    ["withdraw", "invitation_sent"],
    selectorLocale
  );
  const receivedSignals = getLinkedInSelectorPhrases(
    ["accept", "ignore", "decline", "respond"],
    selectorLocale
  );
  const headlineNoiseSignals = getLinkedInSelectorPhrases(
    [
      "accept",
      "decline",
      "ignore",
      "invitation",
      "invitation_sent",
      "respond",
      "withdraw"
    ],
    selectorLocale
  );

  const invitations = await page.evaluate(
    ({ direction, sentSignals, receivedSignals, headlineNoiseSignals }) => {
    const normalize = (v: string | null | undefined): string =>
      (v ?? "").replace(/\s+/g, " ").trim();

      const containsAny = (value: string, phrases: string[]): boolean => {
        const normalizedValue = normalize(value).toLowerCase();
        return phrases.some((phrase) =>
          normalizedValue.includes(normalize(phrase).toLowerCase())
        );
      };

      const escapeRegExp = (value: string): string =>
        value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const stripPhrases = (value: string, phrases: string[]): string => {
        return phrases.reduce((stripped, phrase) => {
          const normalizedPhrase = normalize(phrase);
          if (!normalizedPhrase) {
            return stripped;
          }

          return stripped.replace(
            new RegExp(escapeRegExp(normalizedPhrase), "giu"),
            " "
          );
        }, normalize(value));
      };

    const legacyCards = Array.from(
      document.querySelectorAll(
        "li.invitation-card, li[class*='invitation-card'], div.invitation-card"
      )
    );

    const modernCards = Array.from(
      document.querySelectorAll("div[role='listitem'], li[role='listitem']")
    ).filter((card) => {
      const text = normalize(card.textContent).toLowerCase();
      if (!card.querySelector("a[href*='/in/']")) {
        return false;
      }

      if (direction === "sent") {
        return containsAny(text, sentSignals);
      }

      return containsAny(text, receivedSignals);
    });

    const cards = legacyCards.length > 0 ? legacyCards : modernCards;

    return cards.map((card) => {
      const linkEl = card.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
      const profileUrl = linkEl?.href ?? "";
      const linkTextCandidates = Array.from(
        card.querySelectorAll("a[href*='/in/']")
      )
        .map((anchor) => normalize(anchor.textContent))
        .filter((value) => value.length > 0);

      const nameEl =
        card.querySelector(".invitation-card__title") ??
        card.querySelector("span[dir='ltr'] strong") ??
        card.querySelector("a[href*='/in/'] span[aria-hidden='true']") ??
        card.querySelector("a[href*='/in/']");
      const fullName = normalize(nameEl?.textContent) || linkTextCandidates[0] || "";

      const headlineEl =
        card.querySelector(".invitation-card__subtitle") ??
        card.querySelector(".entity-result__primary-subtitle");
      let headline = stripPhrases(
        normalize(headlineEl?.textContent),
        headlineNoiseSignals
      ).trim();

      if (!headline) {
        const fallbackLine = Array.from(card.querySelectorAll("p, span"))
          .map((el) => normalize(el.textContent))
          .find((line) => {
            if (!line) return false;
            if (line === fullName) return false;
            if (containsAny(line, headlineNoiseSignals)) return false;
            return true;
          });
        headline = fallbackLine ?? "";
      }

      return {
        profile_url: profileUrl,
        full_name: fullName,
        headline,
        sent_or_received: direction as "sent" | "received"
      };
    });
    },
    {
      direction: sentOrReceived,
      sentSignals,
      receivedSignals,
      headlineNoiseSignals
    }
  );

  return invitations.map((inv) => ({
    vanity_name: extractVanityName(inv.profile_url),
    full_name: normalizeText(inv.full_name),
    headline: normalizeText(inv.headline),
    profile_url: normalizeText(inv.profile_url),
    sent_or_received: inv.sent_or_received
  }));
}

/* eslint-enable no-undef */

/* ------------------------------------------------------------------ */
/*  Action Executors                                                  */
/* ------------------------------------------------------------------ */

async function executeSendInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const note = typeof payload.note === "string" ? payload.note : "";
  const profileName = String(target.profile_name ?? "default");
  const profileUrl = resolveProfileUrl(targetProfile);

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
        actionType: SEND_INVITATION_ACTION_TYPE,
        profileName,
        targetUrl: profileUrl,
        metadata: {
          target_profile: targetProfile,
          profile_url: profileUrl,
          note_included: note.length > 0
        },
        errorDetails: {
          target_profile: targetProfile,
          profile_url: profileUrl,
          note_included: note.length > 0
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(SEND_INVITATION_ACTION_TYPE),
            message: createConfirmRateLimitMessage(SEND_INVITATION_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile,
              profile_url: profileUrl,
              note_included: note.length > 0
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn send_invitation action."
          ),
        execute: async () => {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      const connectExactRegex = buildLinkedInSelectorPhraseRegex(
        "connect",
        runtime.selectorLocale,
        { exact: true }
      );
      const connectExactRegexHint = formatLinkedInSelectorRegexHint(
        "connect",
        runtime.selectorLocale,
        { exact: true }
      );
      const connectTextRegex = buildLinkedInSelectorPhraseRegex(
        "connect",
        runtime.selectorLocale
      );
      const connectTextRegexHint = formatLinkedInSelectorRegexHint(
        "connect",
        runtime.selectorLocale
      );
      const connectAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "connect",
        runtime.selectorLocale
      );
      const moreExactRegex = buildLinkedInSelectorPhraseRegex(
        "more",
        runtime.selectorLocale,
        { exact: true }
      );
      const moreExactRegexHint = formatLinkedInSelectorRegexHint(
        "more",
        runtime.selectorLocale,
        { exact: true }
      );
      const moreActionsAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "more_actions",
        runtime.selectorLocale
      );
      const addNoteRegex = buildLinkedInSelectorPhraseRegex(
        "add_note",
        runtime.selectorLocale
      );
      const addNoteRegexHint = formatLinkedInSelectorRegexHint(
        "add_note",
        runtime.selectorLocale
      );
      const addNoteAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "add_note",
        runtime.selectorLocale
      );
      const invitationAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "textarea",
        "invitation",
        runtime.selectorLocale
      );
      const sendExactRegex = buildLinkedInSelectorPhraseRegex(
        "send",
        runtime.selectorLocale,
        { exact: true }
      );
      const sendExactRegexHint = formatLinkedInSelectorRegexHint(
        "send",
        runtime.selectorLocale,
        { exact: true }
      );
      const sendTextRegex = buildLinkedInSelectorPhraseRegex(
        "send",
        runtime.selectorLocale
      );
      const sendTextRegexHint = formatLinkedInSelectorRegexHint(
        "send",
        runtime.selectorLocale
      );
      const sendWithoutNoteRegex = buildLinkedInSelectorPhraseRegex(
        "send_without_note",
        runtime.selectorLocale
      );
      const sendWithoutNoteRegexHint = formatLinkedInSelectorRegexHint(
        "send_without_note",
        runtime.selectorLocale
      );
      const sendAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "send",
        runtime.selectorLocale
      );
      const sendNowRegex = buildLinkedInSelectorPhraseRegex(
        "send_now",
        runtime.selectorLocale
      );
      const sendNowRegexHint = formatLinkedInSelectorRegexHint(
        "send_now",
        runtime.selectorLocale
      );
      const sendNowAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "send_now",
        runtime.selectorLocale
      );
      const pendingRegex = buildLinkedInSelectorPhraseRegex(
        ["pending", "withdraw"],
        runtime.selectorLocale
      );
      const pendingRegexHint = formatLinkedInSelectorRegexHint(
        ["pending", "withdraw"],
        runtime.selectorLocale
      );
      const withdrawAriaSelector = buildLinkedInAriaLabelContainsSelector(
        "button",
        "withdraw",
        runtime.selectorLocale
      );
      const invitationSentRegex = buildLinkedInSelectorPhraseRegex(
        "invitation_sent",
        runtime.selectorLocale
      );
      const invitationSentRegexHint = formatLinkedInSelectorRegexHint(
        "invitation_sent",
        runtime.selectorLocale
      );

      const topCardRoot = page.locator("main .pv-top-card, main").first();

      // Pre-flight: detect if invitation is already pending
      const alreadyPendingCandidates = buildProfileActionButtonCandidates({
        topCardRoot,
        selectorLocale: runtime.selectorLocale,
        selectorKeys: ["pending", "withdraw"],
        candidateKeyPrefix: "already-pending"
      });
      const alreadyPending = await findVisibleLocator(page, alreadyPendingCandidates);
      if (alreadyPending) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Connection invitation is already pending for "${targetProfile}". ` +
            "Withdraw the existing invitation before sending a new one.",
          {
            target_profile: targetProfile,
            url: page.url(),
            detected_state: "pending",
            detected_selector_key: alreadyPending.key
          }
        );
      }

      // Pre-flight: detect if already connected (Message button = connected)
      const alreadyConnectedCandidates = buildProfileActionButtonCandidates({
        topCardRoot,
        selectorLocale: runtime.selectorLocale,
        selectorKeys: "message",
        candidateKeyPrefix: "already-connected"
      });
      const alreadyConnected = await findVisibleLocator(page, alreadyConnectedCandidates);
      if (alreadyConnected) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Already connected with "${targetProfile}".`,
          {
            target_profile: targetProfile,
            url: page.url(),
            detected_state: "connected",
            detected_selector_key: alreadyConnected.key
          }
        );
      }

      const connectCandidates: VisibleLocatorCandidate[] = [
        {
          key: "topcard-connect-role",
          selectorHint: `topCard.getByRole(button, ${connectExactRegexHint})`,
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: connectExactRegex
            })
        },
        {
          key: "topcard-connect-aria",
          selectorHint: `topCard ${connectAriaSelector}`,
          locatorFactory: () => topCardRoot.locator(connectAriaSelector)
        },
        {
          key: "page-connect-role",
          selectorHint: `page.getByRole(button, ${connectExactRegexHint})`,
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: connectExactRegex
            })
        },
        {
          key: "page-connect-aria",
          selectorHint: connectAriaSelector,
          locatorFactory: (targetPage) => targetPage.locator(connectAriaSelector)
        },
        {
          key: "topcard-connect-text-filter",
          selectorHint: "main button hasText connect",
          locatorFactory: (targetPage) =>
            targetPage.locator("main button").filter({ hasText: connectTextRegex })
        },
        {
          key: "page-connect-data-control",
          selectorHint: "button[data-control-name*='connect']",
          locatorFactory: (targetPage) =>
            targetPage.locator("button[data-control-name*='connect']")
        }
      ];

      const moreCandidates: VisibleLocatorCandidate[] = [
        {
          key: "topcard-more-role",
          selectorHint: `topCard.getByRole(button, ${moreExactRegexHint})`,
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: moreExactRegex
            })
        },
        {
          key: "topcard-more-actions-aria",
          selectorHint: `topCard ${moreActionsAriaSelector}`,
          locatorFactory: () => topCardRoot.locator(moreActionsAriaSelector)
        },
        {
          key: "page-more-role",
          selectorHint: `page.getByRole(button, ${moreExactRegexHint})`,
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: moreExactRegex
            })
        }
      ];

      const menuConnectCandidates: VisibleLocatorCandidate[] = [
        {
          key: "menu-connect-roleitem",
          selectorHint: `[role='menuitem'] hasText ${connectExactRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("[role='menuitem']").filter({
              hasText: connectExactRegex
            })
        },
        {
          key: "menu-connect-dropdown-item",
          selectorHint: `.artdeco-dropdown__content-inner [role='button'] hasText ${connectExactRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator(".artdeco-dropdown__content-inner [role='button']").filter({
              hasText: connectExactRegex
            })
        },
        {
          key: "menu-connect-li-text",
          selectorHint: `.artdeco-dropdown__content-inner li hasText ${connectTextRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator(".artdeco-dropdown__content-inner li").filter({
              hasText: connectTextRegex
            })
        }
      ];

      let connectSelectorKey: string | null = null;
      const directConnect = await findVisibleLocator(page, connectCandidates);
      if (directConnect) {
        await directConnect.locator.click({ timeout: 5_000 });
        connectSelectorKey = directConnect.key;
      } else {
        const moreButton = await findVisibleLocator(page, moreCandidates);
        if (moreButton) {
          await moreButton.locator.click({ timeout: 5_000 });
          await page.waitForTimeout(600);
          const menuConnect = await findVisibleLocator(page, menuConnectCandidates);
          if (menuConnect) {
            await menuConnect.locator.click({ timeout: 5_000 });
            connectSelectorKey = `${moreButton.key}:${menuConnect.key}`;
          }
        }
      }

      if (!connectSelectorKey) {
        // Detect follow-only profiles — some profiles only offer Follow
        const followOnlyCandidates = buildProfileActionButtonCandidates({
          topCardRoot,
          selectorLocale: runtime.selectorLocale,
          selectorKeys: "follow",
          candidateKeyPrefix: "follow-detect"
        });
        const followButton = await findVisibleLocator(page, followOnlyCandidates);
        if (followButton) {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            `Cannot send connection invitation — profile "${targetProfile}" only shows Follow. ` +
            "This may be because they restrict invitations or are outside your direct network.",
            {
              target_profile: targetProfile,
              url: page.url(),
              follow_button_key: followButton.key,
              attempted_connect_selectors: connectCandidates.map((c) => c.selectorHint),
              attempted_more_selectors: moreCandidates.map((c) => c.selectorHint),
              attempted_menu_selectors: menuConnectCandidates.map((c) => c.selectorHint)
            }
          );
        }

        throw new LinkedInBuddyError(
          "UI_CHANGED_SELECTOR_FAILED",
          `Could not find Connect button on profile page for "${targetProfile}". ` +
            "The profile may have an unexpected layout or the Connect option may be unavailable.",
          {
            target_profile: targetProfile,
            url: page.url(),
            attempted_connect_selectors: connectCandidates.map((c) => c.selectorHint),
            attempted_more_selectors: moreCandidates.map((c) => c.selectorHint),
            attempted_menu_selectors: menuConnectCandidates.map((c) => c.selectorHint)
          }
        );
      }

      const pendingCandidates: VisibleLocatorCandidate[] = [
        {
          key: "pending-text",
          selectorHint: `topCard.getByRole(button, ${pendingRegexHint})`,
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: pendingRegex
            })
        },
        {
          key: "pending-aria",
          selectorHint: `topCard ${withdrawAriaSelector}`,
          locatorFactory: () => topCardRoot.locator(withdrawAriaSelector)
        },
        {
          key: "pending-invitations-sent-text",
          selectorHint: `page hasText ${invitationSentRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("body").filter({ hasText: invitationSentRegex })
        }
      ];

      const dialogLocator = page
        .locator(
          ".artdeco-modal.send-invite, " +
            ".artdeco-modal:has(button[aria-label*='note' i]), " +
            ".artdeco-modal:has(button[aria-label*='Send' i]), " +
            "[role='dialog']:has(button[aria-label*='Send' i]), " +
            "[role='dialog']:has(textarea), " +
            "[role='dialog']:not(.vjs-modal-dialog):not(.vjs-hidden)"
        )
        .first();
      const dialogAppeared = await dialogLocator
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);

      if (!dialogAppeared) {
        const directSendConfirmed = await waitForCondition(async () => {
          const pendingIndicator = await findVisibleLocator(page, pendingCandidates);
          return pendingIndicator !== null;
        }, 3_000);

        if (directSendConfirmed) {
          if (note) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "Connection invitation was sent directly without a dialog — the requested " +
              "note could not be included. The invitation has already been sent without a note.",
              {
                target_profile: targetProfile,
                url: page.url(),
                connect_selector_key: connectSelectorKey,
                note_requested: true
              }
            );
          }

          const trackedProfileUrl = normalizeLinkedInProfileUrl(page.url() || profileUrl);
          trackSentInvitationState(
            runtime.db,
            profileName,
            {
              profile_url: trackedProfileUrl,
              vanity_name: extractVanityName(trackedProfileUrl),
              full_name: "",
              headline: ""
            },
            Date.now()
          );

          return {
            ok: true,
            result: {
              status: "invitation_sent",
              target_profile: targetProfile,
              note_included: false,
              connect_selector_key: connectSelectorKey,
              note_field_selector_key: null,
              send_selector_key: "direct_send_no_dialog"
            },
            artifacts: []
          };
        }

        throw new LinkedInBuddyError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Connect dialog did not appear after clicking Connect button.",
          {
            target_profile: targetProfile,
            url: page.url(),
            connect_selector_key: connectSelectorKey
          }
        );
      }

      const addNoteCandidates: VisibleLocatorCandidate[] = [
        {
          key: "add-note-dialog-aria-label",
          selectorHint: "dialog button[aria-label*='Add a note' i]",
          locatorFactory: () =>
            dialogLocator.locator("button[aria-label*='note' i]").filter({
              hasText: addNoteRegex
            })
        },
        {
          key: "add-note-dialog-role",
          selectorHint: `dialog.getByRole(button, ${addNoteRegexHint})`,
          locatorFactory: () =>
            dialogLocator.getByRole("button", {
              name: addNoteRegex
            })
        },
        {
          key: "add-note-dialog-text",
          selectorHint: `dialog button hasText ${addNoteRegexHint}`,
          locatorFactory: () =>
            dialogLocator.locator("button").filter({ hasText: addNoteRegex })
        },
        {
          key: "add-note-dialog-aria",
          selectorHint: `dialog ${addNoteAriaSelector}`,
          locatorFactory: () => dialogLocator.locator(addNoteAriaSelector)
        },
        {
          key: "add-note-text",
          selectorHint: `button hasText ${addNoteRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("button").filter({ hasText: addNoteRegex })
        },
        {
          key: "add-note-aria",
          selectorHint: addNoteAriaSelector,
          locatorFactory: (targetPage) => targetPage.locator(addNoteAriaSelector)
        }
      ];

      const noteFieldCandidates: VisibleLocatorCandidate[] = [
        {
          key: "note-dialog-textarea-role",
          selectorHint: "dialog.getByRole(textbox)",
          locatorFactory: () => dialogLocator.getByRole("textbox")
        },
        {
          key: "note-dialog-textarea-name",
          selectorHint: "dialog textarea[name='message']",
          locatorFactory: () => dialogLocator.locator("textarea[name='message']")
        },
        {
          key: "note-dialog-textarea-custom-id",
          selectorHint: "dialog textarea#custom-message",
          locatorFactory: () => dialogLocator.locator("textarea#custom-message")
        },
        {
          key: "note-dialog-textarea-aria",
          selectorHint: `dialog ${invitationAriaSelector}`,
          locatorFactory: () => dialogLocator.locator(invitationAriaSelector)
        },
        {
          key: "note-dialog-textarea-generic",
          selectorHint: "dialog textarea",
          locatorFactory: () => dialogLocator.locator("textarea")
        },
        {
          key: "note-textarea-message-name",
          selectorHint: "textarea[name='message']",
          locatorFactory: (targetPage) => targetPage.locator("textarea[name='message']")
        },
        {
          key: "note-textarea-custom-id",
          selectorHint: "textarea#custom-message",
          locatorFactory: (targetPage) => targetPage.locator("textarea#custom-message")
        },
        {
          key: "note-textarea-aria",
          selectorHint: invitationAriaSelector,
          locatorFactory: (targetPage) => targetPage.locator(invitationAriaSelector)
        },
        {
          key: "note-textarea-fallback",
          selectorHint: "textarea",
          locatorFactory: (targetPage) => targetPage.locator("textarea")
        }
      ];

      let noteFieldSelectorKey: string | null = null;
      if (note) {
        const addNoteButton = await findVisibleLocator(page, addNoteCandidates);
        if (addNoteButton) {
          await addNoteButton.locator.click({ timeout: 5_000 });
          await page.waitForTimeout(500);
        }

        const noteField = await findVisibleLocator(page, noteFieldCandidates);
        if (!noteField) {
          throw new LinkedInBuddyError(
            "UI_CHANGED_SELECTOR_FAILED",
            "Could not find invitation note field in connect dialog.",
            {
              target_profile: targetProfile,
              attempted_note_field_selectors: noteFieldCandidates.map(
                (candidate) => candidate.selectorHint
              )
            }
          );
        }

        await noteField.locator.fill(note, { timeout: 5_000 });
        noteFieldSelectorKey = noteField.key;
      }

      const sendCandidates: VisibleLocatorCandidate[] = [
        {
          key: "send-dialog-artdeco-primary",
          selectorHint: "dialog button.artdeco-button--primary",
          locatorFactory: () =>
            dialogLocator.locator("button.artdeco-button--primary")
        },
        {
          key: "send-dialog-send-now-text",
          selectorHint: `dialog button hasText ${sendNowRegexHint}`,
          locatorFactory: () =>
            dialogLocator.locator("button").filter({ hasText: sendNowRegex })
        },
        {
          key: "send-dialog-send-now-aria",
          selectorHint: `dialog ${sendNowAriaSelector}`,
          locatorFactory: () => dialogLocator.locator(sendNowAriaSelector)
        },
        {
          key: "send-dialog-role",
          selectorHint: `dialog.getByRole(button, ${sendExactRegexHint})`,
          locatorFactory: () =>
            dialogLocator.getByRole("button", {
              name: sendExactRegex
            })
        },
        {
          key: "send-dialog-text",
          selectorHint: `dialog button hasText ${sendTextRegexHint}`,
          locatorFactory: () =>
            dialogLocator.locator("button").filter({ hasText: sendTextRegex })
        },
        {
          key: "send-dialog-aria",
          selectorHint: `dialog ${sendAriaSelector}`,
          locatorFactory: () => dialogLocator.locator(sendAriaSelector)
        },
        {
          key: "send-dialog-primary",
          selectorHint: "dialog button.artdeco-button--primary",
          locatorFactory: () =>
            dialogLocator.locator("button.artdeco-button--primary")
        },
        {
          key: "send-dialog-without-note",
          selectorHint: `dialog button hasText ${sendWithoutNoteRegexHint}`,
          locatorFactory: () =>
            dialogLocator.locator("button").filter({ hasText: sendWithoutNoteRegex })
        },
        {
          key: "send-text",
          selectorHint: `button hasText ${sendTextRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("button").filter({ hasText: sendTextRegex })
        },
        {
          key: "send-role",
          selectorHint: `getByRole(button, ${sendExactRegexHint})`,
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: sendExactRegex
            })
        },
        {
          key: "send-aria",
          selectorHint: sendAriaSelector,
          locatorFactory: (targetPage) => targetPage.locator(sendAriaSelector)
        },
        {
          key: "send-without-note",
          selectorHint: `button hasText ${sendWithoutNoteRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("button").filter({ hasText: sendWithoutNoteRegex })
        },
        {
          key: "send-now-text",
          selectorHint: `button hasText ${sendNowRegexHint}`,
          locatorFactory: (targetPage) =>
            targetPage.locator("button").filter({ hasText: sendNowRegex })
        },
        {
          key: "send-now-aria",
          selectorHint: sendNowAriaSelector,
          locatorFactory: (targetPage) => targetPage.locator(sendNowAriaSelector)
        },
        {
          key: "send-artdeco-primary",
          selectorHint: "div.send-invite button.artdeco-button--primary",
          locatorFactory: (targetPage) =>
            targetPage.locator("div.send-invite button.artdeco-button--primary")
        },
        {
          key: "send-dialog-primary-button",
          selectorHint: "dialog button.artdeco-button--primary",
          locatorFactory: () =>
            dialogLocator.locator("button.artdeco-button--primary")
        }
      ];

      const sendButton = await findVisibleLocator(page, sendCandidates);
      if (!sendButton) {
        throw new LinkedInBuddyError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Could not find Send button in invitation dialog.",
          {
            target_profile: targetProfile,
            attempted_send_selectors: sendCandidates.map((candidate) => candidate.selectorHint)
          }
        );
      }

      await sendButton.locator.click({ timeout: 5_000 });

      const invitationLanded = await waitForCondition(async () => {
        const pendingIndicator = await findVisibleLocator(page, pendingCandidates);
        return pendingIndicator !== null;
      }, 8_000);

      if (!invitationLanded) {
        throw new LinkedInBuddyError(
          "UNKNOWN",
          "Connection invitation could not be verified after clicking send.",
          {
            target_profile: targetProfile,
            connect_selector_key: connectSelectorKey,
            note_field_selector_key: noteFieldSelectorKey,
            send_selector_key: sendButton.key
          }
        );
      }

      const trackedProfileUrl = normalizeLinkedInProfileUrl(page.url() || profileUrl);
      trackSentInvitationState(
        runtime.db,
        profileName,
        {
          profile_url: trackedProfileUrl,
          vanity_name: extractVanityName(trackedProfileUrl),
          full_name: "",
          headline: ""
        },
        Date.now()
      );

      return {
        ok: true,
        result: {
          status: "invitation_sent",
          target_profile: targetProfile,
          note_included: note.length > 0,
          connect_selector_key: connectSelectorKey,
          note_field_selector_key: noteFieldSelectorKey,
          send_selector_key: sendButton.key
        },
        artifacts: []
      };
        }
      });
    }
  );
}

async function executeAcceptInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");

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
        actionType: ACCEPT_INVITATION_ACTION_TYPE,
        profileName,
        targetUrl: INVITATIONS_RECEIVED_URL,
        metadata: {
          target_profile: targetProfile
        },
        errorDetails: {
          target_profile: targetProfile
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(ACCEPT_INVITATION_ACTION_TYPE),
            message: createConfirmRateLimitMessage(ACCEPT_INVITATION_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn accept_invitation action."
          ),
        execute: async () => {
      await page.goto(INVITATIONS_RECEIVED_URL, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      const invitationCard = buildPendingInvitationCardLocator(page, targetProfile);
      const acceptRegex = buildLinkedInSelectorPhraseRegex(
        "accept",
        runtime.selectorLocale,
        { exact: true }
      );
      const acceptRegexHint = formatLinkedInSelectorRegexHint(
        "accept",
        runtime.selectorLocale,
        { exact: true }
      );
      const acceptCandidates: VisibleLocatorCandidate[] = [
        {
          key: "card-accept-role",
          selectorHint: `invitationCard.getByRole(button, ${acceptRegexHint})`,
          locatorFactory: () =>
            invitationCard.getByRole("button", {
              name: acceptRegex
            })
        },
        {
          key: "card-accept-text",
          selectorHint: `invitationCard button hasText ${acceptRegexHint}`,
          locatorFactory: () =>
            invitationCard.locator("button").filter({
              hasText: acceptRegex
            })
        }
      ];
      const acceptButton = await findVisibleLocator(page, acceptCandidates);

      if (!acceptButton) {
        throw new LinkedInBuddyError(
          "TARGET_NOT_FOUND",
          `No pending invitation found from "${targetProfile}".`,
          { target_profile: targetProfile }
        );
      }

      await acceptButton.locator.click({ timeout: 5_000 });
      await waitForCondition(
        async () => !(await invitationCard.isVisible().catch(() => false)),
        5_000
      );

      return {
        ok: true,
        result: {
          status: "invitation_accepted",
          target_profile: targetProfile
        },
        artifacts: []
      };
        }
      });
    }
  );
}

async function executeWithdrawInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");

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
        actionType: WITHDRAW_INVITATION_ACTION_TYPE,
        profileName,
        targetUrl: INVITATIONS_SENT_URL,
        metadata: {
          target_profile: targetProfile
        },
        errorDetails: {
          target_profile: targetProfile
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(WITHDRAW_INVITATION_ACTION_TYPE),
            message: createConfirmRateLimitMessage(WITHDRAW_INVITATION_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn withdraw_invitation action."
          ),
        execute: async () => {
      await page.goto(INVITATIONS_SENT_URL, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      const invitationCard = buildPendingInvitationCardLocator(page, targetProfile);
      const withdrawRegex = buildLinkedInSelectorPhraseRegex(
        "withdraw",
        runtime.selectorLocale,
        { exact: true }
      );

      const withdrawRegexHint = formatLinkedInSelectorRegexHint(
        "withdraw",
        runtime.selectorLocale,
        { exact: true }
      );
      const withdrawCandidates: VisibleLocatorCandidate[] = [
        {
          key: "card-withdraw-role",
          selectorHint: `invitationCard.getByRole(button, ${withdrawRegexHint})`,
          locatorFactory: () =>
            invitationCard.getByRole("button", {
              name: withdrawRegex
            })
        },
        {
          key: "card-withdraw-text",
          selectorHint: `invitationCard button hasText ${withdrawRegexHint}`,
          locatorFactory: () =>
            invitationCard.locator("button").filter({
              hasText: withdrawRegex
            })
        }
      ];
      const withdrawButton = await findVisibleLocator(page, withdrawCandidates);

      if (!withdrawButton) {
        throw new LinkedInBuddyError(
          "TARGET_NOT_FOUND",
          `No sent invitation found to "${targetProfile}".`,
          { target_profile: targetProfile }
        );
      }

      await withdrawButton.locator.click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);

      const confirmButton = page
        .locator("button")
        .filter({ hasText: withdrawRegex })
        .last();
      if (await confirmButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirmButton.click({ timeout: 5_000 });
      }

      await waitForCondition(
        async () => !(await invitationCard.isVisible().catch(() => false)),
        5_000
      );

      const closedAtMs = Date.now();
      runtime.db.markSentInvitationClosed({
        profileName,
        profileUrlKey: normalizeLinkedInProfileUrl(resolveProfileUrl(targetProfile)),
        closedAtMs,
        closedReason: "withdrawn",
        updatedAtMs: closedAtMs
      });

      return {
        ok: true,
        result: {
          status: "invitation_withdrawn",
          target_profile: targetProfile
        },
        artifacts: []
      };
        }
      });
    }
  );
}

async function executeIgnoreInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");

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
        actionType: IGNORE_INVITATION_ACTION_TYPE,
        profileName,
        targetUrl: INVITATIONS_RECEIVED_URL,
        metadata: {
          target_profile: targetProfile
        },
        errorDetails: {
          target_profile: targetProfile
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(IGNORE_INVITATION_ACTION_TYPE),
            message: createConfirmRateLimitMessage(IGNORE_INVITATION_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn ignore_invitation action."
          ),
        execute: async () => {
          await page.goto(INVITATIONS_RECEIVED_URL, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const invitationCard = buildPendingInvitationCardLocator(page, targetProfile);
          const ignoreRegex = buildLinkedInSelectorPhraseRegex(
            ["ignore", "decline", "dismiss"],
            runtime.selectorLocale,
            { exact: true }
          );
          const ignoreRegexHint = formatLinkedInSelectorRegexHint(
            ["ignore", "decline", "dismiss"],
            runtime.selectorLocale,
            { exact: true }
          );
          const ignoreCandidates: VisibleLocatorCandidate[] = [
            {
              key: "card-ignore-role",
              selectorHint: `invitationCard.getByRole(button, ${ignoreRegexHint})`,
              locatorFactory: () =>
                invitationCard.getByRole("button", {
                  name: ignoreRegex
                })
            },
            {
              key: "card-ignore-text",
              selectorHint: `invitationCard button hasText ${ignoreRegexHint}`,
              locatorFactory: () =>
                invitationCard.locator("button").filter({
                  hasText: ignoreRegex
                })
            }
          ];
          const ignoreButton = await findVisibleLocator(page, ignoreCandidates);

          if (!ignoreButton) {
            throw new LinkedInBuddyError(
              "TARGET_NOT_FOUND",
              `No pending invitation found from "${targetProfile}".`,
              { target_profile: targetProfile }
            );
          }

          await ignoreButton.locator.click({ timeout: 5_000 });
          await waitForCondition(
            async () => !(await invitationCard.isVisible().catch(() => false)),
            5_000
          );

          return {
            ok: true,
            result: {
              status: "invitation_ignored",
              target_profile: targetProfile,
              ignore_selector_key: ignoreButton.key
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeRemoveConnection(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");
  const profileUrl = resolveProfileUrl(targetProfile);

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
        actionType: REMOVE_CONNECTION_ACTION_TYPE,
        profileName,
        targetUrl: profileUrl,
        metadata: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        errorDetails: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(REMOVE_CONNECTION_ACTION_TYPE),
            message: createConfirmRateLimitMessage(REMOVE_CONNECTION_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile,
              profile_url: profileUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn remove_connection action."
          ),
        execute: async () => {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const removeSelectorKey = await clickProfileAction({
            page,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "remove_connection",
            targetProfile,
            actionLabel: "Remove connection",
            candidateKeyPrefix: "remove-connection"
          });

          const removeConfirmRegex = buildLinkedInSelectorPhraseRegex(
            ["remove", "remove_connection"],
            runtime.selectorLocale,
            { exact: true }
          );
          const removeConfirmRegexHint = formatLinkedInSelectorRegexHint(
            ["remove", "remove_connection"],
            runtime.selectorLocale,
            { exact: true }
          );
          const removeConfirmCandidates: VisibleLocatorCandidate[] = [
            {
              key: "remove-confirm-dialog-role",
              selectorHint: `dialog.getByRole(button, ${removeConfirmRegexHint})`,
              locatorFactory: (targetPage) =>
                targetPage.locator("div[role='dialog']").getByRole("button", {
                  name: removeConfirmRegex
                })
            },
            {
              key: "remove-confirm-dialog-text",
              selectorHint: `div[role='dialog'] button hasText ${removeConfirmRegexHint}`,
              locatorFactory: (targetPage) =>
                targetPage.locator("div[role='dialog'] button").filter({
                  hasText: removeConfirmRegex
                })
            },
            {
              key: "remove-confirm-dialog-data-primary",
              selectorHint: "div[role='dialog'] button[data-test-dialog-primary-btn]",
              locatorFactory: (targetPage) =>
                targetPage.locator("div[role='dialog'] button[data-test-dialog-primary-btn]")
            },
            {
              key: "remove-confirm-dialog-primary",
              selectorHint: "div[role='dialog'] button.artdeco-button--primary",
              locatorFactory: (targetPage) =>
                targetPage.locator("div[role='dialog'] button.artdeco-button--primary")
            }
          ];
          const removeConfirmButton = await findVisibleLocator(page, removeConfirmCandidates);
          if (!removeConfirmButton) {
            throw new LinkedInBuddyError(
              "UI_CHANGED_SELECTOR_FAILED",
              "Could not find Remove confirmation button after opening the connection removal dialog.",
              {
                target_profile: targetProfile,
                remove_selector_key: removeSelectorKey,
                attempted_remove_confirm_selectors: removeConfirmCandidates.map(
                  (candidate) => candidate.selectorHint
                )
              }
            );
          }

          await removeConfirmButton.locator.click({ timeout: 5_000 });
          await waitForCondition(
            async () => !(await page.locator("div[role='dialog']").first().isVisible().catch(() => false)),
            5_000
          );

          return {
            ok: true,
            result: {
              status: "connection_removed",
              target_profile: targetProfile,
              remove_selector_key: removeSelectorKey,
              remove_confirm_selector_key: removeConfirmButton.key
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeFollowMember(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");
  const profileUrl = resolveProfileUrl(targetProfile);

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
        actionType: FOLLOW_MEMBER_ACTION_TYPE,
        profileName,
        targetUrl: profileUrl,
        metadata: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        errorDetails: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(FOLLOW_MEMBER_ACTION_TYPE),
            message: createConfirmRateLimitMessage(FOLLOW_MEMBER_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile,
              profile_url: profileUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn follow_member action."
          ),
        execute: async () => {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const topCardRoot = buildProfileTopCardRoot(page);
          const alreadyFollowingCandidates = buildProfileActionButtonCandidates({
            topCardRoot,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: ["following", "unfollow"],
            candidateKeyPrefix: "already-following"
          });
          if (await findVisibleLocator(page, alreadyFollowingCandidates)) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              `Already following "${targetProfile}".`,
              { target_profile: targetProfile }
            );
          }

          const followSelectorKey = await clickProfileAction({
            page,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "follow",
            targetProfile,
            actionLabel: "Follow",
            candidateKeyPrefix: "follow-member"
          });

          const followCandidates = buildProfileActionButtonCandidates({
            topCardRoot,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "follow",
            candidateKeyPrefix: "follow-check"
          });
          const followingCandidates = buildProfileActionButtonCandidates({
            topCardRoot,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: ["following", "unfollow"],
            candidateKeyPrefix: "following-check"
          });
          const followed = await waitForCondition(async () => {
            if (await findVisibleLocator(page, followingCandidates)) {
              return true;
            }

            return (await findVisibleLocator(page, followCandidates)) === null;
          }, 5_000);

          if (!followed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "Follow action could not be verified after clicking the control.",
              {
                target_profile: targetProfile,
                follow_selector_key: followSelectorKey
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "member_followed",
              target_profile: targetProfile,
              follow_selector_key: followSelectorKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUnfollowMember(
  runtime: LinkedInConnectionsExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");
  const profileUrl = resolveProfileUrl(targetProfile);

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
        actionType: UNFOLLOW_MEMBER_ACTION_TYPE,
        profileName,
        targetUrl: profileUrl,
        metadata: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        errorDetails: {
          target_profile: targetProfile,
          profile_url: profileUrl
        },
        dismissOverlays: {
          selectorLocale: runtime.selectorLocale,
          logger: runtime.logger
        },
        beforeExecute: () =>
          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: getConnectionRateLimitConfig(UNFOLLOW_MEMBER_ACTION_TYPE),
            message: createConfirmRateLimitMessage(UNFOLLOW_MEMBER_ACTION_TYPE),
            details: {
              action_id: actionId,
              profile_name: profileName,
              target_profile: targetProfile,
              profile_url: profileUrl
            }
          }),
        mapError: (error) =>
          asLinkedInBuddyError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn unfollow_member action."
          ),
        execute: async () => {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const topCardRoot = buildProfileTopCardRoot(page);
          const followCandidates = buildProfileActionButtonCandidates({
            topCardRoot,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "follow",
            candidateKeyPrefix: "follow-check"
          });
          if (await findVisibleLocator(page, followCandidates)) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              `Not currently following "${targetProfile}".`,
              { target_profile: targetProfile }
            );
          }

          let unfollowSelectorKey = await clickProfileAction({
            page,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: ["unfollow", "following"],
            targetProfile,
            actionLabel: "Unfollow",
            candidateKeyPrefix: "unfollow-member"
          });

          const menuUnfollowCandidates = buildProfileMenuActionCandidates({
            selectorLocale: runtime.selectorLocale,
            selectorKeys: "unfollow",
            candidateKeyPrefix: "unfollow-confirm"
          });
          const menuUnfollowAction = await findVisibleLocator(page, menuUnfollowCandidates);
          if (menuUnfollowAction) {
            await menuUnfollowAction.locator.click({ timeout: 5_000 });
            unfollowSelectorKey = `${unfollowSelectorKey}:${menuUnfollowAction.key}`;
          }

          const stillFollowingCandidates = buildProfileActionButtonCandidates({
            topCardRoot,
            selectorLocale: runtime.selectorLocale,
            selectorKeys: ["following", "unfollow"],
            candidateKeyPrefix: "still-following-check"
          });
          const unfollowed = await waitForCondition(async () => {
            if (await findVisibleLocator(page, followCandidates)) {
              return true;
            }

            return (await findVisibleLocator(page, stillFollowingCandidates)) === null;
          }, 5_000);

          if (!unfollowed) {
            throw new LinkedInBuddyError(
              "UNKNOWN",
              "Unfollow action could not be verified after clicking the control.",
              {
                target_profile: targetProfile,
                unfollow_selector_key: unfollowSelectorKey
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "member_unfollowed",
              target_profile: targetProfile,
              unfollow_selector_key: unfollowSelectorKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Action executor classes for TwoPhaseCommitService                 */
/* ------------------------------------------------------------------ */

import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult
} from "./twoPhaseCommit.js";

export class SendInvitationActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeSendInvitation(
      input.runtime,
      input.action.id,
      input.action.target,
      input.action.payload
    );
    return { ok: true, result, artifacts };
  }
}

export class AcceptInvitationActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeAcceptInvitation(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class WithdrawInvitationActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeWithdrawInvitation(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class IgnoreInvitationActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeIgnoreInvitation(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class RemoveConnectionActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeRemoveConnection(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class FollowMemberActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeFollowMember(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export class UnfollowMemberActionExecutor
  implements ActionExecutor<LinkedInConnectionsExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInConnectionsExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUnfollowMember(
      input.runtime,
      input.action.id,
      input.action.target
    );
    return { ok: true, result, artifacts };
  }
}

export function createConnectionActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInConnectionsExecutorRuntime>
> {
  return {
    [SEND_INVITATION_ACTION_TYPE]: new SendInvitationActionExecutor(),
    [ACCEPT_INVITATION_ACTION_TYPE]: new AcceptInvitationActionExecutor(),
    [WITHDRAW_INVITATION_ACTION_TYPE]: new WithdrawInvitationActionExecutor(),
    [IGNORE_INVITATION_ACTION_TYPE]: new IgnoreInvitationActionExecutor(),
    [REMOVE_CONNECTION_ACTION_TYPE]: new RemoveConnectionActionExecutor(),
    [FOLLOW_MEMBER_ACTION_TYPE]: new FollowMemberActionExecutor(),
    [UNFOLLOW_MEMBER_ACTION_TYPE]: new UnfollowMemberActionExecutor()
  };
}

/* ------------------------------------------------------------------ */
/*  Service                                                           */
/* ------------------------------------------------------------------ */

export class LinkedInConnectionsService {
  constructor(private readonly runtime: LinkedInConnectionsRuntime) {}

  private prepareTargetedRelationshipAction(input: {
    actionType: string;
    operatorNote?: string | undefined;
    profileName?: string | undefined;
    summary: string;
    targetProfile: string;
  }): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const targetProfile = normalizeText(input.targetProfile);

    if (!targetProfile) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "targetProfile is required.",
        {}
      );
    }

    const target = {
      target_profile: targetProfile,
      profile_name: profileName
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target,
      payload: {},
      preview: {
        summary: input.summary,
        target,
        rate_limit: peekRateLimitPreviewOrThrow(
          this.runtime.rateLimiter,
          getConnectionRateLimitConfig(input.actionType),
          createPrepareRateLimitMessage(input.actionType)
        )
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  async listConnections(
    input: ListConnectionsInput = {}
  ): Promise<LinkedInConnection[]> {
    const profileName = input.profileName ?? "default";
    const limit = input.limit ?? 40;

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
          await page.goto(CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);
          return scrapeConnections(page, limit);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to list LinkedIn connections."
      );
    }
  }

  async listPendingInvitations(
    input: ListPendingInvitationsInput = {}
  ): Promise<LinkedInPendingInvitation[]> {
    const profileName = input.profileName ?? "default";
    const filter = input.filter ?? "all";

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl
    });

    try {
      const results: LinkedInPendingInvitation[] = [];

      if (filter === "all" || filter === "received") {
        const received = await this.runtime.profileManager.runWithContext(
          {
            cdpUrl: this.runtime.cdpUrl,
            profileName,
            headless: true
          },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(INVITATIONS_RECEIVED_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            return scrapePendingInvitations(
              page,
              "received",
              this.runtime.selectorLocale
            );
          }
        );
        results.push(...received);
      }

      if (filter === "all" || filter === "sent") {
        const sent = await this.runtime.profileManager.runWithContext(
          {
            cdpUrl: this.runtime.cdpUrl,
            profileName,
            headless: true
          },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(INVITATIONS_SENT_URL, {
              waitUntil: "domcontentloaded"
            });
            await waitForNetworkIdleBestEffort(page);
            return scrapePendingInvitations(
              page,
              "sent",
              this.runtime.selectorLocale
            );
          }
        );

        const syncedAtMs = Date.now();
        for (const invitation of sent) {
          trackSentInvitationState(
            this.runtime.db,
            profileName,
            invitation,
            syncedAtMs
          );
        }

        results.push(...sent);
      }

      return results;
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }
      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        "Failed to list pending LinkedIn invitations."
      );
    }
  }

  prepareSendInvitation(input: PrepareSendInvitationInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const targetProfile = normalizeText(input.targetProfile);

    if (!targetProfile) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "targetProfile is required.",
        {}
      );
    }

    const target = {
      target_profile: targetProfile,
      profile_name: profileName
    };

    const preview = {
      summary: `Send connection invitation to ${targetProfile}`,
      target,
      outbound: {
        note: input.note ?? ""
      },
      rate_limit: peekRateLimitPreviewOrThrow(
        this.runtime.rateLimiter,
        getConnectionRateLimitConfig(SEND_INVITATION_ACTION_TYPE),
        createPrepareRateLimitMessage(SEND_INVITATION_ACTION_TYPE)
      )
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: SEND_INVITATION_ACTION_TYPE,
      target,
      payload: { note: input.note ?? "" },
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareAcceptInvitation(input: PrepareAcceptInvitationInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: ACCEPT_INVITATION_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Accept connection invitation from ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }

  prepareWithdrawInvitation(input: PrepareWithdrawInvitationInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: WITHDRAW_INVITATION_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Withdraw sent invitation to ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }

  prepareIgnoreInvitation(input: PrepareIgnoreInvitationInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: IGNORE_INVITATION_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Ignore connection invitation from ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }

  prepareRemoveConnection(input: PrepareRemoveConnectionInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: REMOVE_CONNECTION_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Remove existing connection with ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }

  prepareFollowMember(input: PrepareFollowMemberInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: FOLLOW_MEMBER_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Follow ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }

  prepareUnfollowMember(input: PrepareUnfollowMemberInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedRelationshipAction({
      actionType: UNFOLLOW_MEMBER_ACTION_TYPE,
      operatorNote: input.operatorNote,
      profileName: input.profileName,
      summary: `Unfollow ${normalizeText(input.targetProfile)}`,
      targetProfile: input.targetProfile
    });
  }
}
