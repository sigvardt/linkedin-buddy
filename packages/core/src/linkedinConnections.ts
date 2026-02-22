import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ProfileManager } from "./profileManager.js";
import { resolveProfileUrl } from "./linkedinProfile.js";
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
  auth: LinkedInAuthService;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
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
    .locator("li.invitation-card, li[class*='invitation-card']")
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);

  const invitations = await page.evaluate((direction: string) => {
    const normalize = (v: string | null | undefined): string =>
      (v ?? "").replace(/\s+/g, " ").trim();

    const cards = Array.from(
      document.querySelectorAll(
        "li.invitation-card, li[class*='invitation-card'], div.invitation-card"
      )
    );

    return cards.map((card) => {
      const linkEl = card.querySelector("a[href*='/in/']") as HTMLAnchorElement | null;
      const profileUrl = linkEl?.href ?? "";

      const nameEl =
        card.querySelector(".invitation-card__title") ??
        card.querySelector("span[dir='ltr'] strong") ??
        card.querySelector("a[href*='/in/'] span[aria-hidden='true']");
      const fullName = normalize(nameEl?.textContent);

      const headlineEl =
        card.querySelector(".invitation-card__subtitle") ??
        card.querySelector(".entity-result__primary-subtitle");
      const headline = normalize(headlineEl?.textContent);

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
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const note = typeof payload.note === "string" ? payload.note : "";
  const profileName = String(target.profile_name ?? "default");
  const profileUrl = resolveProfileUrl(targetProfile);

  return runtime.profileManager.runWithPersistentContext(
    profileName,
    { headless: true },
    async (context) => {
      const page = await getOrCreatePage(context);
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      // Look for "Connect" button
      const connectBtn = page.locator(
        "button:has-text('Connect'), button[aria-label*='connect' i], button[aria-label*='Connect']"
      ).first();

      const moreBtn = page.locator(
        "button:has-text('More'), button[aria-label='More actions']"
      ).first();

      let clicked = false;
      if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await connectBtn.click();
        clicked = true;
      } else if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await moreBtn.click();
        await page.waitForTimeout(500);
        const menuConnect = page.locator(
          "[role='menuitem']:has-text('Connect'), li:has-text('Connect')"
        ).first();
        if (await menuConnect.isVisible({ timeout: 2000 }).catch(() => false)) {
          await menuConnect.click();
          clicked = true;
        }
      }

      if (!clicked) {
        throw new LinkedInAssistantError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Could not find Connect button on profile page.",
          { target_profile: targetProfile, url: page.url() }
        );
      }

      // Wait for the invitation modal
      await page.waitForTimeout(1000);

      // Add note if provided
      if (note) {
        const addNoteBtn = page.locator("button:has-text('Add a note')").first();
        if (await addNoteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await addNoteBtn.click();
          await page.waitForTimeout(500);
          const noteField = page.locator(
            "textarea[name='message'], textarea#custom-message"
          ).first();
          if (await noteField.isVisible({ timeout: 2000 }).catch(() => false)) {
            await noteField.fill(note);
          }
        }
      }

      // Click Send
      const sendBtn = page.locator(
        "button:has-text('Send'), button[aria-label*='Send']"
      ).first();
      if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sendBtn.click();
        await page.waitForTimeout(2000);
      } else {
        throw new LinkedInAssistantError(
          "UI_CHANGED_SELECTOR_FAILED",
          "Could not find Send button in invitation dialog.",
          { target_profile: targetProfile }
        );
      }

      return {
        result: {
          status: "invitation_sent",
          target_profile: targetProfile,
          note_included: note.length > 0
        },
        artifacts: []
      };
    }
  );
}

async function executeAcceptInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");

  return runtime.profileManager.runWithPersistentContext(
    profileName,
    { headless: true },
    async (context) => {
      const page = await getOrCreatePage(context);
      await page.goto(INVITATIONS_RECEIVED_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

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
        result: {
          status: "invitation_accepted",
          target_profile: targetProfile
        },
        artifacts: []
      };
    }
  );
}

async function executeWithdrawInvitation(
  runtime: LinkedInConnectionsExecutorRuntime,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const targetProfile = String(target.target_profile ?? "");
  const profileName = String(target.profile_name ?? "default");

  return runtime.profileManager.runWithPersistentContext(
    profileName,
    { headless: true },
    async (context) => {
      const page = await getOrCreatePage(context);
      await page.goto(INVITATIONS_SENT_URL, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

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
      } else {
        throw new LinkedInAssistantError(
          "TARGET_NOT_FOUND",
          `No sent invitation found to "${targetProfile}".`,
          { target_profile: targetProfile }
        );
      }

      return {
        result: {
          status: "invitation_withdrawn",
          target_profile: targetProfile
        },
        artifacts: []
      };
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

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      return await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle");
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

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      const results: LinkedInPendingInvitation[] = [];

      if (filter === "all" || filter === "received") {
        const received = await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(INVITATIONS_RECEIVED_URL, {
              waitUntil: "domcontentloaded"
            });
            await page.waitForLoadState("networkidle");
            return scrapePendingInvitations(page, "received");
          }
        );
        results.push(...received);
      }

      if (filter === "all" || filter === "sent") {
        const sent = await this.runtime.profileManager.runWithPersistentContext(
          profileName,
          { headless: true },
          async (context) => {
            const page = await getOrCreatePage(context);
            await page.goto(INVITATIONS_SENT_URL, {
              waitUntil: "domcontentloaded"
            });
            await page.waitForLoadState("networkidle");
            return scrapePendingInvitations(page, "sent");
          }
        );
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
