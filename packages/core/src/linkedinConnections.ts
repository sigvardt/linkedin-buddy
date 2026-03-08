import { type BrowserContext, type Locator, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { executeConfirmActionWithArtifacts } from "./confirmArtifacts.js";
import type { ConfirmFailureArtifactConfig } from "./config.js";
import type { AssistantDatabase } from "./db/database.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";
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

export interface PrepareAcceptInvitationInput {
  profileName?: string;
  targetProfile: string;
  operatorNote?: string;
}

export interface PrepareWithdrawInvitationInput {
  profileName?: string;
  targetProfile: string;
  operatorNote?: string;
}

/**
 * Minimal runtime needed by connection action executors (no twoPhaseCommit).
 */
export interface LinkedInConnectionsExecutorRuntime {
  db: AssistantDatabase;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
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

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const INVITATIONS_RECEIVED_URL = "https://www.linkedin.com/mynetwork/invitation-manager/";
const INVITATIONS_SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

async function findVisibleLocator(
  page: Page,
  candidates: VisibleLocatorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
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

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
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
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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
  sentOrReceived: "sent" | "received"
): Promise<LinkedInPendingInvitation[]> {
  // Wait for invitation cards
  await page
    .locator("li.invitation-card, li[class*='invitation-card'], div[role='listitem']")
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);

  const invitations = await page.evaluate((direction: string) => {
    const normalize = (v: string | null | undefined): string =>
      (v ?? "").replace(/\s+/g, " ").trim();

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
        return /withdraw|sent/.test(text);
      }

      return /accept|ignore|decline|respond/.test(text);
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
      let headline = normalize(headlineEl?.textContent)
        .replace(/\b(sent|withdraw|accept|ignore)\b/gi, "")
        .trim();

      if (!headline) {
        const fallbackLine = Array.from(card.querySelectorAll("p, span"))
          .map((el) => normalize(el.textContent))
          .find((line) => {
            if (!line) return false;
            if (line === fullName) return false;
            if (/sent|withdraw|accept|ignore|invitation/i.test(line)) return false;
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
  }, sentOrReceived);

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
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn send_invitation action."
          ),
        execute: async () => {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      const topCardRoot = page.locator("main .pv-top-card, main").first();

      const connectCandidates: VisibleLocatorCandidate[] = [
        {
          key: "topcard-connect-role",
          selectorHint: "topCard.getByRole(button, /^connect$/i)",
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: /^connect$/i
            })
        },
        {
          key: "topcard-connect-aria-invite",
          selectorHint: "topCard button[aria-label*='Invite'][aria-label*='connect']",
          locatorFactory: () =>
            topCardRoot.locator(
              "button[aria-label*='Invite' i][aria-label*='connect' i]"
            )
        },
        {
          key: "page-connect-role",
          selectorHint: "page.getByRole(button, /^connect$/i)",
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: /^connect$/i
            })
        },
        {
          key: "page-connect-aria",
          selectorHint: "button[aria-label*='connect']",
          locatorFactory: (targetPage) =>
            targetPage.locator("button[aria-label*='connect' i]")
        }
      ];

      const moreCandidates: VisibleLocatorCandidate[] = [
        {
          key: "topcard-more-role",
          selectorHint: "topCard.getByRole(button, /^more$/i)",
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: /^more$/i
            })
        },
        {
          key: "topcard-more-actions-aria",
          selectorHint: "topCard button[aria-label='More actions']",
          locatorFactory: () =>
            topCardRoot.locator("button[aria-label='More actions']")
        },
        {
          key: "page-more-role",
          selectorHint: "page.getByRole(button, /^more$/i)",
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: /^more$/i
            })
        }
      ];

      const menuConnectCandidates: VisibleLocatorCandidate[] = [
        {
          key: "menu-connect-roleitem",
          selectorHint: "[role='menuitem'] hasText /^connect$/i",
          locatorFactory: (targetPage) =>
            targetPage.locator("[role='menuitem']").filter({
              hasText: /^connect$/i
            })
        },
        {
          key: "menu-connect-dropdown-item",
          selectorHint: ".artdeco-dropdown__content-inner [role='button'] hasText /^connect$/i",
          locatorFactory: (targetPage) =>
            targetPage.locator(".artdeco-dropdown__content-inner [role='button']").filter({
              hasText: /^connect$/i
            })
        },
        {
          key: "menu-connect-li-text",
          selectorHint: ".artdeco-dropdown__content-inner li:has-text('Connect')",
          locatorFactory: (targetPage) =>
            targetPage.locator(".artdeco-dropdown__content-inner li").filter({
              hasText: /^connect$/i
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
        throw new LinkedInAssistantError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Could not find Connect button on profile page.",
          {
            target_profile: targetProfile,
            url: page.url(),
            attempted_connect_selectors: connectCandidates.map((c) => c.selectorHint),
            attempted_more_selectors: moreCandidates.map((c) => c.selectorHint),
            attempted_menu_selectors: menuConnectCandidates.map((c) => c.selectorHint)
          }
        );
      }

      await page.waitForTimeout(900);

      const addNoteCandidates: VisibleLocatorCandidate[] = [
        {
          key: "add-note-text",
          selectorHint: "button:has-text('Add a note')",
          locatorFactory: (targetPage) => targetPage.locator("button:has-text('Add a note')")
        },
        {
          key: "add-note-aria",
          selectorHint: "button[aria-label*='Add a note']",
          locatorFactory: (targetPage) => targetPage.locator("button[aria-label*='Add a note']")
        }
      ];

      const noteFieldCandidates: VisibleLocatorCandidate[] = [
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
          selectorHint: "textarea[aria-label*='invitation']",
          locatorFactory: (targetPage) =>
            targetPage.locator("textarea[aria-label*='invitation' i]")
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
          throw new LinkedInAssistantError(
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
          key: "send-text",
          selectorHint: "button:has-text('Send')",
          locatorFactory: (targetPage) => targetPage.locator("button:has-text('Send')")
        },
        {
          key: "send-role",
          selectorHint: "getByRole(button, /^send$/i)",
          locatorFactory: (targetPage) =>
            targetPage.getByRole("button", {
              name: /^send$/i
            })
        },
        {
          key: "send-aria",
          selectorHint: "button[aria-label*='Send']",
          locatorFactory: (targetPage) => targetPage.locator("button[aria-label*='Send' i]")
        },
        {
          key: "send-without-note",
          selectorHint: "button:has-text('Send without a note')",
          locatorFactory: (targetPage) =>
            targetPage.locator("button:has-text('Send without a note')")
        }
      ];

      const sendButton = await findVisibleLocator(page, sendCandidates);
      if (!sendButton) {
        throw new LinkedInAssistantError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Could not find Send button in invitation dialog.",
          {
            target_profile: targetProfile,
            attempted_send_selectors: sendCandidates.map((candidate) => candidate.selectorHint)
          }
        );
      }

      await sendButton.locator.click({ timeout: 5_000 });

      const pendingCandidates: VisibleLocatorCandidate[] = [
        {
          key: "pending-text",
          selectorHint: "topCard.getByRole(button, /pending|withdraw/i)",
          locatorFactory: () =>
            topCardRoot.getByRole("button", {
              name: /pending|withdraw/i
            })
        },
        {
          key: "pending-aria",
          selectorHint: "topCard button[aria-label*='Withdraw']",
          locatorFactory: () =>
            topCardRoot.locator("button[aria-label*='Withdraw' i]")
        },
        {
          key: "pending-invitations-sent-text",
          selectorHint: "page text=/invitation sent/i",
          locatorFactory: (targetPage) =>
            targetPage.locator(":text-matches('invitation sent', 'i')")
        }
      ];

      const invitationLanded = await waitForCondition(async () => {
        const pendingIndicator = await findVisibleLocator(page, pendingCandidates);
        return pendingIndicator !== null;
      }, 8_000);

      if (!invitationLanded) {
        throw new LinkedInAssistantError(
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
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn accept_invitation action."
          ),
        execute: async () => {
      await page.goto(INVITATIONS_RECEIVED_URL, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      // Find the invitation card for the target
      const acceptBtn = page.locator(
        `li:has(a[href*="${targetProfile}"]) button:has-text("Accept")`
      ).first();

      if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await acceptBtn.click();
        await page.waitForTimeout(2000);
      } else {
        throw new LinkedInAssistantError(
          "TARGET_NOT_FOUND",
          `No pending invitation found from "${targetProfile}".`,
          { target_profile: targetProfile }
        );
      }

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
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn withdraw_invitation action."
          ),
        execute: async () => {
      await page.goto(INVITATIONS_SENT_URL, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);

      const withdrawBtn = page.locator(
        `li:has(a[href*="${targetProfile}"]) button:has-text("Withdraw")`
      ).first();

      if (await withdrawBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await withdrawBtn.click();
        await page.waitForTimeout(1000);
        // Confirm withdrawal dialog
        const confirmBtn = page.locator(
          "button:has-text('Withdraw')"
        ).last();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.click();
          await page.waitForTimeout(2000);
        }

        const closedAtMs = Date.now();
        runtime.db.markSentInvitationClosed({
          profileName,
          profileUrlKey: normalizeLinkedInProfileUrl(resolveProfileUrl(targetProfile)),
          closedAtMs,
          closedReason: "withdrawn",
          updatedAtMs: closedAtMs
        });
      } else {
        throw new LinkedInAssistantError(
          "TARGET_NOT_FOUND",
          `No sent invitation found to "${targetProfile}".`,
          { target_profile: targetProfile }
        );
      }

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

export function createConnectionActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInConnectionsExecutorRuntime>
> {
  return {
    [SEND_INVITATION_ACTION_TYPE]: new SendInvitationActionExecutor(),
    [ACCEPT_INVITATION_ACTION_TYPE]: new AcceptInvitationActionExecutor(),
    [WITHDRAW_INVITATION_ACTION_TYPE]: new WithdrawInvitationActionExecutor()
  };
}

/* ------------------------------------------------------------------ */
/*  Service                                                           */
/* ------------------------------------------------------------------ */

export class LinkedInConnectionsService {
  constructor(private readonly runtime: LinkedInConnectionsRuntime) {}

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
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
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
            return scrapePendingInvitations(page, "received");
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
            return scrapePendingInvitations(page, "sent");
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
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
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
      throw new LinkedInAssistantError(
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
      }
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
    const profileName = input.profileName ?? "default";
    const targetProfile = normalizeText(input.targetProfile);

    if (!targetProfile) {
      throw new LinkedInAssistantError(
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
      summary: `Accept connection invitation from ${targetProfile}`,
      target
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: ACCEPT_INVITATION_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareWithdrawInvitation(input: PrepareWithdrawInvitationInput): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const profileName = input.profileName ?? "default";
    const targetProfile = normalizeText(input.targetProfile);

    if (!targetProfile) {
      throw new LinkedInAssistantError(
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
      summary: `Withdraw sent invitation to ${targetProfile}`,
      target
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: WITHDRAW_INVITATION_ACTION_TYPE,
      target,
      payload: {},
      preview,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
