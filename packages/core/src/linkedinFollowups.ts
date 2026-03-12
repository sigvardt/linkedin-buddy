import {
  errors as playwrightErrors,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import type {
  AssistantDatabase,
  PreparedActionRow,
  SentInvitationStateRow,
} from "./db/database.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import {
  SEND_MESSAGE_RATE_LIMIT_CONFIG,
  type LinkedInMessagingRuntime,
} from "./linkedinInbox.js";
import { normalizeLinkedInProfileUrl } from "./linkedinProfile.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  consumeRateLimitOrThrow,
  createConfirmRateLimitMessage,
  formatRateLimitState,
  type RateLimiter,
  type RateLimiterState,
} from "./rateLimiter.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  PreparedAction,
  TwoPhaseCommitService,
} from "./twoPhaseCommit.js";

export const FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE =
  "network.followup_after_accept";
export const DEFAULT_FOLLOWUP_SINCE = "7d";
export const DEFAULT_FOLLOWUP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type FollowupPreparationStatus =
  | "not_prepared"
  | "prepared"
  | "executed"
  | "failed"
  | "expired";

interface SelectorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

interface AcceptanceProbeResult {
  profileUrl: string;
  vanityName: string | null;
  fullName: string;
  headline: string;
  acceptedDetection: string;
}

/**
 * Accepted sent invitation enriched with follow-up preparation status.
 */
export interface LinkedInAcceptedConnection {
  profile_url_key: string;
  profile_url: string;
  vanity_name: string | null;
  full_name: string;
  headline: string;
  first_seen_sent_at_ms: number;
  last_seen_sent_at_ms: number;
  accepted_at_ms: number;
  accepted_detection: string;
  followup_status: FollowupPreparationStatus;
  followup_prepared_action_id: string | null;
  followup_prepared_at_ms: number | null;
  followup_confirmed_at_ms: number | null;
  followup_expires_at_ms: number | null;
}

/**
 * Input for listing accepted connections that may need follow-up work.
 */
export interface ListAcceptedConnectionsInput {
  profileName?: string;
  since?: string;
  sinceMs?: number;
}

/**
 * Input for the manual batch prepare workflow after acceptance detection.
 */
export interface PrepareFollowupsAfterAcceptInput {
  profileName?: string;
  since?: string;
  sinceMs?: number;
  operatorNote?: string;
}

/**
 * Input for preparing a follow-up for one accepted connection by stable
 * profile identity.
 */
export interface PrepareAcceptedConnectionFollowupInput {
  profileName?: string;
  profileUrlKey: string;
  operatorNote?: string;
  refreshState?: boolean;
}

/**
 * Prepared follow-up action details returned from the accepted-connection
 * follow-up flow.
 */
export interface PreparedAcceptedConnectionFollowup {
  connection: LinkedInAcceptedConnection;
  preparedActionId: string;
  confirmToken: string;
  expiresAtMs: number;
  preview: Record<string, unknown>;
}

/**
 * Result returned from the manual batch follow-up prepare command.
 */
export interface PrepareFollowupsAfterAcceptResult {
  since: string;
  acceptedConnections: LinkedInAcceptedConnection[];
  preparedFollowups: PreparedAcceptedConnectionFollowup[];
}

/**
 * Runtime dependencies used by the confirm-time follow-up executor.
 */
export interface LinkedInFollowupsExecutorRuntime {
  db: AssistantDatabase;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  artifacts: ArtifactHelpers;
  rateLimiter: RateLimiter;
  logger: JsonEventLogger;
}

/**
 * Runtime dependencies used by the accepted-connection follow-up service.
 */
export interface LinkedInFollowupsRuntime extends LinkedInFollowupsExecutorRuntime {
  connections: {
    listPendingInvitations(input: {
      profileName?: string;
      filter?: "sent" | "received" | "all";
    }): Promise<unknown[]>;
  };
  twoPhaseCommit: Pick<
    TwoPhaseCommitService<LinkedInMessagingRuntime>,
    "prepare"
  >;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
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

function extractFirstName(fullName: string): string {
  return normalizeText(fullName).split(" ")[0] ?? "";
}

/**
 * Builds the default accepted-connection follow-up message.
 */
export function buildDefaultFollowupText(fullName: string): string {
  const firstName = extractFirstName(fullName);
  if (firstName) {
    return `Hi ${firstName}, thanks for accepting my invitation. Great to connect.`;
  }

  return "Hi, thanks for accepting my invitation. Great to connect.";
}

/**
 * Resolves the accepted-connection follow-up lookback window from a relative
 * duration or absolute timestamp.
 */
export function resolveFollowupSinceWindow(
  since: string | undefined,
  nowMs = Date.now(),
): { since: string; sinceMs: number } {
  const normalized = normalizeText(since) || DEFAULT_FOLLOWUP_SINCE;
  const relativeMatch = /^(\d+)\s*(m|h|d|w)$/i.exec(normalized);

  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1] ?? "", 10);
    const unit = (relativeMatch[2] ?? "d").toLowerCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "since must be a positive relative duration like 7d or 24h.",
      );
    }

    const multiplier =
      unit === "m"
        ? 60 * 1000
        : unit === "h"
          ? 60 * 60 * 1000
          : unit === "w"
            ? 7 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;

    return {
      since: `${amount}${unit}`,
      sinceMs: nowMs - amount * multiplier,
    };
  }

  const absoluteMs = Date.parse(normalized);
  if (Number.isFinite(absoluteMs)) {
    if (absoluteMs > nowMs) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "since must not be in the future.",
      );
    }

    return {
      since: normalized,
      sinceMs: absoluteMs,
    };
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    "since must be a relative duration like 7d, 24h, 30m, or an ISO date.",
  );
}

function formatLookbackWindowMs(value: number): string {
  const units = [
    { label: "w", sizeMs: 7 * 24 * 60 * 60 * 1000 },
    { label: "d", sizeMs: 24 * 60 * 60 * 1000 },
    { label: "h", sizeMs: 60 * 60 * 1000 },
    { label: "m", sizeMs: 60 * 1000 },
  ] as const;

  for (const unit of units) {
    if (value % unit.sizeMs === 0) {
      return `${value / unit.sizeMs}${unit.label}`;
    }
  }

  return `${value}ms`;
}

function resolveFollowupLookbackWindow(input: {
  since?: string;
  sinceMs?: number;
  nowMs?: number;
}): { since: string; cutoffMs: number } {
  const nowMs = input.nowMs ?? Date.now();

  if (typeof input.sinceMs === "number") {
    if (!Number.isFinite(input.sinceMs) || input.sinceMs <= 0) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "sinceMs must be a positive number of milliseconds.",
      );
    }

    return {
      since:
        normalizeText(input.since) || formatLookbackWindowMs(input.sinceMs),
      cutoffMs: nowMs - input.sinceMs,
    };
  }

  const resolved = resolveFollowupSinceWindow(input.since, nowMs);
  return {
    since: resolved.since,
    cutoffMs: resolved.sinceMs,
  };
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
  location: "target" | "payload",
): string {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Prepared action ${actionId} is missing ${location}.${key}.`,
    {
      action_id: actionId,
      location,
      key,
    },
  );
}

function getOptionalStringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return undefined;
}

function toAutomationError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInBuddyError("TIMEOUT", message, details, {
      cause: error,
    });
  }

  if (
    error instanceof Error &&
    /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i.test(error.message)
  ) {
    return new LinkedInBuddyError("NETWORK_ERROR", message, details, {
      cause: error,
    });
  }

  return asLinkedInBuddyError(error, "UNKNOWN", message);
}

function deriveFollowupStatus(input: {
  state: SentInvitationStateRow;
  nowMs: number;
  preparedActionStatus?: string | undefined;
  preparedActionExpiresAtMs?: number | null;
}): FollowupPreparationStatus {
  const {
    state,
    nowMs,
    preparedActionStatus,
    preparedActionExpiresAtMs = null,
  } = input;

  if (state.followup_confirmed_at !== null) {
    return "executed";
  }

  if (!state.followup_prepared_action_id) {
    return "not_prepared";
  }

  if (preparedActionStatus === "executed") {
    return "executed";
  }

  if (preparedActionStatus === "failed") {
    return "failed";
  }

  if (preparedActionStatus === "prepared") {
    if (
      preparedActionExpiresAtMs !== null &&
      preparedActionExpiresAtMs <= nowMs
    ) {
      return "expired";
    }

    return "prepared";
  }

  return "not_prepared";
}

function shouldPrepareAcceptedConnectionFollowup(
  status: FollowupPreparationStatus,
): boolean {
  return (
    status === "not_prepared" || status === "failed" || status === "expired"
  );
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

async function captureScreenshotArtifact(
  runtime: Pick<LinkedInFollowupsExecutorRuntime, "artifacts">,
  page: Page,
  relativePath: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const absolutePath = runtime.artifacts.resolve(relativePath);
  await page.screenshot({ path: absolutePath, fullPage: true });
  runtime.artifacts.registerArtifact(relativePath, "image/png", metadata);
  return relativePath;
}

async function waitForMessageEcho(
  page: Page,
  messageText: string,
): Promise<void> {
  const snippet = messageText.trim().slice(0, 140);
  if (!snippet) {
    return;
  }

  const candidates = [
    page
      .locator(".msg-s-message-list__event, .msg-s-event-listitem")
      .filter({ hasText: snippet })
      .last(),
    page.locator("[role='dialog'], .msg-overlay-conversation-bubble").filter({
      hasText: snippet,
    }),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: "visible", timeout: 6_000 });
      return;
    } catch {
      // Try the next surface.
    }
  }
}

async function findVisibleLocator(
  page: Page,
  candidates: SelectorCandidate[],
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(page).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 2_000 });
      return { locator, key: candidate.key };
    } catch {
      // Try the next selector candidate.
    }
  }

  return null;
}

async function findVisibleLocatorOrThrow(
  page: Page,
  candidates: SelectorCandidate[],
  selectorKey: string,
  artifactPaths: string[],
): Promise<{ locator: Locator; key: string }> {
  const result = await findVisibleLocator(page, candidates);
  if (result) {
    return result;
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn selector group "${selectorKey}".`,
    {
      selector_key: selectorKey,
      current_url: page.url(),
      attempted_selectors: candidates.map(
        (candidate) => candidate.selectorHint,
      ),
      artifact_paths: artifactPaths,
    },
  );
}

function profileMessageButtonCandidates(
  root: Locator,
  selectorLocale: LinkedInSelectorLocale,
): SelectorCandidate[] {
  const messageExactRegex = buildLinkedInSelectorPhraseRegex(
    "message",
    selectorLocale,
    { exact: true },
  );
  const messageExactRegexHint = formatLinkedInSelectorRegexHint(
    "message",
    selectorLocale,
    { exact: true },
  );
  const messageTextRegex = buildLinkedInSelectorPhraseRegex(
    "message",
    selectorLocale,
  );
  const messageTextRegexHint = formatLinkedInSelectorRegexHint(
    "message",
    selectorLocale,
  );
  const messageAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    "message",
    selectorLocale,
  );

  return [
    {
      key: "topcard-message-role",
      selectorHint: `topCard.getByRole(button, ${messageExactRegexHint})`,
      locatorFactory: () =>
        root.getByRole("button", {
          name: messageExactRegex,
        }),
    },
    {
      key: "topcard-message-text",
      selectorHint: `topCard button hasText ${messageTextRegexHint}`,
      locatorFactory: () =>
        root.locator("button").filter({ hasText: messageTextRegex }),
    },
    {
      key: "topcard-message-aria",
      selectorHint: `topCard ${messageAriaSelector}`,
      locatorFactory: () => root.locator(messageAriaSelector),
    },
    {
      key: "page-message-role",
      selectorHint: `page.getByRole(button, ${messageExactRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("button", {
          name: messageExactRegex,
        }),
    },
  ];
}

async function findProfileMessageTrigger(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
): Promise<{ locator: Locator; key: string } | null> {
  const topCardRoot = page.locator("main .pv-top-card, main").first();
  const direct = await findVisibleLocator(
    page,
    profileMessageButtonCandidates(topCardRoot, selectorLocale),
  );
  if (direct) {
    return direct;
  }

  const moreExactRegex = buildLinkedInSelectorPhraseRegex(
    "more",
    selectorLocale,
    { exact: true },
  );
  const moreExactRegexHint = formatLinkedInSelectorRegexHint(
    "more",
    selectorLocale,
    { exact: true },
  );
  const moreActionsAriaSelector = buildLinkedInAriaLabelContainsSelector(
    "button",
    "more_actions",
    selectorLocale,
  );
  const messageMenuExactRegex = buildLinkedInSelectorPhraseRegex(
    "message",
    selectorLocale,
    { exact: true },
  );
  const messageMenuExactRegexHint = formatLinkedInSelectorRegexHint(
    "message",
    selectorLocale,
    { exact: true },
  );
  const messageMenuTextRegex = buildLinkedInSelectorPhraseRegex(
    "message",
    selectorLocale,
  );
  const messageMenuTextRegexHint = formatLinkedInSelectorRegexHint(
    "message",
    selectorLocale,
  );

  const moreCandidates: SelectorCandidate[] = [
    {
      key: "topcard-more-role",
      selectorHint: `topCard.getByRole(button, ${moreExactRegexHint})`,
      locatorFactory: () =>
        topCardRoot.getByRole("button", {
          name: moreExactRegex,
        }),
    },
    {
      key: "topcard-more-aria",
      selectorHint: `topCard ${moreActionsAriaSelector}`,
      locatorFactory: () => topCardRoot.locator(moreActionsAriaSelector),
    },
    {
      key: "page-more-aria",
      selectorHint: `page ${moreActionsAriaSelector}`,
      locatorFactory: (page) => page.locator(moreActionsAriaSelector),
    },
  ];

  const more = await findVisibleLocator(page, moreCandidates);
  if (!more) {
    return null;
  }

  await more.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(400);

  const menuCandidates: SelectorCandidate[] = [
    {
      key: "menuitem-message-role",
      selectorHint: `page.getByRole(menuitem, ${messageMenuExactRegexHint})`,
      locatorFactory: (page) =>
        page.getByRole("menuitem", {
          name: messageMenuExactRegex,
        }),
    },
    {
      key: "menu-message-text",
      selectorHint: `[role='menu'] hasText ${messageMenuTextRegexHint}`,
      locatorFactory: (page) =>
        page.locator("[role='menu']").filter({ hasText: messageMenuTextRegex }),
    },
    {
      key: "menu-message-button-fallback",
      selectorHint: `div[role='button'] hasText ${messageMenuTextRegexHint}`,
      locatorFactory: (page) =>
        page
          .locator("div[role='button']")
          .filter({ hasText: messageMenuTextRegex }),
    },
  ];

  const message = await findVisibleLocator(page, menuCandidates);
  if (!message) {
    return null;
  }

  return {
    locator: message.locator,
    key: `${more.key}:${message.key}`,
  };
}

async function extractProfileSummary(page: Page): Promise<{
  profileUrl: string;
  vanityName: string | null;
  fullName: string;
  headline: string;
}> {
  const summary = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const fullName = normalize(
      globalThis.document.querySelector("h1.text-heading-xlarge")
        ?.textContent ??
        globalThis.document.querySelector("h1[class*='text-heading']")
          ?.textContent ??
        globalThis.document.querySelector("h1")?.textContent,
    );

    const headline = normalize(
      globalThis.document.querySelector(".text-body-medium.break-words")
        ?.textContent ??
        globalThis.document.querySelector(
          ".pv-text-details__left-panel .text-body-medium",
        )?.textContent ??
        globalThis.document.querySelector("main .text-body-medium")
          ?.textContent,
    );

    return {
      fullName,
      headline,
    };
  });

  const profileUrl = normalizeLinkedInProfileUrl(page.url());

  return {
    profileUrl,
    vanityName: extractVanityName(profileUrl),
    fullName: normalizeText(summary.fullName),
    headline: normalizeText(summary.headline),
  };
}

async function probeAcceptedConnection(
  page: Page,
  profileUrl: string,
  selectorLocale: LinkedInSelectorLocale,
): Promise<AcceptanceProbeResult | null> {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await waitForNetworkIdleBestEffort(page);
  await page.waitForTimeout(500);

  const summary = await extractProfileSummary(page);
  const messageTrigger = await findProfileMessageTrigger(page, selectorLocale);
  if (!messageTrigger) {
    return null;
  }

  return {
    profileUrl: summary.profileUrl,
    vanityName: summary.vanityName,
    fullName: summary.fullName,
    headline: summary.headline,
    acceptedDetection: messageTrigger.key,
  };
}

async function validateMessageSurfaceTarget(
  page: Page,
  action: PreparedAction,
  expectedFullName?: string,
): Promise<void> {
  const normalizedExpected = normalizeText(expectedFullName).toLowerCase();
  if (!normalizedExpected) {
    return;
  }

  const headerCandidates = [
    page.locator(".msg-overlay-bubble-header__title").first(),
    page.locator("[role='dialog'] h2, [role='dialog'] h3").first(),
    page.locator(".msg-thread__link-to-profile").first(),
  ];

  for (const candidate of headerCandidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const actual = normalizeText(await candidate.textContent());
    if (!actual) {
      continue;
    }

    const actualLower = actual.toLowerCase();
    const expectedFirstName = extractFirstName(normalizedExpected);
    if (
      actualLower.includes(normalizedExpected) ||
      (expectedFirstName && actualLower.includes(expectedFirstName))
    ) {
      return;
    }

    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Message surface validation failed before sending the accepted-connection follow-up.",
      {
        action_id: action.id,
        expected_full_name: expectedFullName,
        actual_header: actual,
        current_url: page.url(),
      },
    );
  }
}

function mapAcceptedConnection(
  state: SentInvitationStateRow,
  nowMs: number,
  preparedAction?: Pick<PreparedActionRow, "status" | "expires_at">,
): LinkedInAcceptedConnection {
  return {
    profile_url_key: state.profile_url_key,
    profile_url: state.profile_url,
    vanity_name: state.vanity_name,
    full_name: state.full_name,
    headline: state.headline,
    first_seen_sent_at_ms: state.first_seen_sent_at,
    last_seen_sent_at_ms: state.last_seen_sent_at,
    accepted_at_ms: state.accepted_at ?? state.updated_at,
    accepted_detection: state.accepted_detection ?? "unknown",
    followup_status: deriveFollowupStatus({
      state,
      nowMs,
      preparedActionStatus: preparedAction?.status,
      preparedActionExpiresAtMs: preparedAction?.expires_at ?? null,
    }),
    followup_prepared_action_id: state.followup_prepared_action_id,
    followup_prepared_at_ms: state.followup_prepared_at,
    followup_confirmed_at_ms: state.followup_confirmed_at,
    followup_expires_at_ms: preparedAction?.expires_at ?? null,
  };
}

function mapAcceptedConnections(
  db: Pick<AssistantDatabase, "listPreparedActionsByIds">,
  states: SentInvitationStateRow[],
  nowMs: number,
): LinkedInAcceptedConnection[] {
  const preparedActionIds = [
    ...new Set(
      states
        .map((state) => state.followup_prepared_action_id)
        .filter(
          (preparedActionId): preparedActionId is string =>
            typeof preparedActionId === "string" && preparedActionId.length > 0,
        ),
    ),
  ];
  const preparedActionsById = new Map(
    db
      .listPreparedActionsByIds(preparedActionIds)
      .map((preparedAction) => [preparedAction.id, preparedAction]),
  );

  return states.map((state) =>
    mapAcceptedConnection(
      state,
      nowMs,
      state.followup_prepared_action_id
        ? preparedActionsById.get(state.followup_prepared_action_id)
        : undefined,
    ),
  );
}

/**
 * Confirm-time executor for accepted-connection follow-up actions.
 */
export class FollowupAfterAcceptActionExecutor implements ActionExecutor<LinkedInFollowupsExecutorRuntime> {
  async execute(
    input: ActionExecutorInput<LinkedInFollowupsExecutorRuntime>,
  ): Promise<ActionExecutorResult> {
    const runtime = input.runtime;
    const action = input.action;
    const profileName = getProfileName(action.target);
    const profileUrl = getRequiredStringField(
      action.target,
      "target_profile_url",
      action.id,
      "target",
    );
    const profileUrlKey = getRequiredStringField(
      action.target,
      "profile_url_key",
      action.id,
      "target",
    );
    const fullName = getOptionalStringField(action.target, "full_name");
    const text = getRequiredStringField(
      action.payload,
      "text",
      action.id,
      "payload",
    );
    const tracePath = `linkedin/trace-followup-confirm-${Date.now()}.zip`;
    const artifactPaths: string[] = [tracePath];

    await runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: runtime.cdpUrl,
    });

    return runtime.profileManager.runWithContext(
      {
        cdpUrl: runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        let tracingStarted = false;

        try {
          await context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true,
          });
          tracingStarted = true;

          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const messageTrigger = await findProfileMessageTrigger(
            page,
            runtime.selectorLocale,
          );
          if (!messageTrigger) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "Accepted-connection follow-up requires a visible Message action on the target profile.",
              {
                action_id: action.id,
                profile_url: profileUrl,
                current_url: page.url(),
              },
            );
          }

          await messageTrigger.locator.click({ timeout: 5_000 });
          await page.waitForTimeout(600);
          await validateMessageSurfaceTarget(page, action, fullName);

          consumeRateLimitOrThrow(runtime.rateLimiter, {
            config: SEND_MESSAGE_RATE_LIMIT_CONFIG,
            message: createConfirmRateLimitMessage("followup.send_message"),
            details: {
              action_id: action.id,
              profile_name: profileName,
              profile_url: profileUrl,
            },
          });

          const composerNameRegex = buildLinkedInSelectorPhraseRegex(
            ["write_message", "message"],
            runtime.selectorLocale,
          );
          const composerNameRegexHint = formatLinkedInSelectorRegexHint(
            ["write_message", "message"],
            runtime.selectorLocale,
          );
          const placeholderRegex = buildLinkedInSelectorPhraseRegex(
            "write_message",
            runtime.selectorLocale,
          );
          const placeholderRegexHint = formatLinkedInSelectorRegexHint(
            "write_message",
            runtime.selectorLocale,
          );
          const sendButtonRegex = buildLinkedInSelectorPhraseRegex(
            "send",
            runtime.selectorLocale,
            { exact: true },
          );
          const sendButtonRegexHint = formatLinkedInSelectorRegexHint(
            "send",
            runtime.selectorLocale,
            { exact: true },
          );
          const dialogSendRegex = buildLinkedInSelectorPhraseRegex(
            "send",
            runtime.selectorLocale,
          );
          const dialogSendRegexHint = formatLinkedInSelectorRegexHint(
            "send",
            runtime.selectorLocale,
          );

          const composerSelectors: SelectorCandidate[] = [
            {
              key: "role-textbox-write-message",
              selectorHint: `getByRole(textbox, ${composerNameRegexHint})`,
              locatorFactory: (page) =>
                page.getByRole("textbox", {
                  name: composerNameRegex,
                }),
            },
            {
              key: "placeholder-write-message",
              selectorHint: `getByPlaceholder(${placeholderRegexHint})`,
              locatorFactory: (page) => page.getByPlaceholder(placeholderRegex),
            },
            {
              key: "msg-contenteditable",
              selectorHint:
                ".msg-form__contenteditable[contenteditable='true']",
              locatorFactory: (page) =>
                page.locator(
                  ".msg-form__contenteditable[contenteditable='true']",
                ),
            },
            {
              key: "dialog-contenteditable",
              selectorHint: "[role='dialog'] [contenteditable='true']",
              locatorFactory: (page) =>
                page.locator("[role='dialog'] [contenteditable='true']"),
            },
          ];

          const composer = await findVisibleLocatorOrThrow(
            page,
            composerSelectors,
            "followup_message_composer",
            artifactPaths,
          );
          await composer.locator.click({ timeout: 3_000 });
          await composer.locator.fill(text, { timeout: 5_000 });

          const sendButtonSelectors: SelectorCandidate[] = [
            {
              key: "role-button-send",
              selectorHint: `getByRole(button, ${sendButtonRegexHint})`,
              locatorFactory: (page) =>
                page.getByRole("button", { name: sendButtonRegex }),
            },
            {
              key: "msg-form-send-button",
              selectorHint: "button.msg-form__send-button",
              locatorFactory: (page) =>
                page.locator("button.msg-form__send-button"),
            },
            {
              key: "dialog-send-button",
              selectorHint: `[role='dialog'] button hasText ${dialogSendRegexHint}`,
              locatorFactory: (page) =>
                page.locator("[role='dialog'] button").filter({
                  hasText: dialogSendRegex,
                }),
            },
          ];

          const sendButton = await findVisibleLocatorOrThrow(
            page,
            sendButtonSelectors,
            "followup_send_button",
            artifactPaths,
          );
          await sendButton.locator.click({ timeout: 5_000 });

          await waitForMessageEcho(page, text);
          const postSendScreenshot = `linkedin/screenshot-followup-confirm-${Date.now()}.png`;
          await captureScreenshotArtifact(runtime, page, postSendScreenshot, {
            action: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
            profile_name: profileName,
            profile_url: profileUrl,
          });
          artifactPaths.push(postSendScreenshot);

          const confirmedAtMs = Date.now();
          const updated = runtime.db.markSentInvitationFollowupConfirmed({
            profileName,
            profileUrlKey,
            confirmedAtMs,
            preparedActionId: action.id,
            updatedAtMs: confirmedAtMs,
          });
          if (!updated) {
            runtime.logger.log(
              "warn",
              "linkedin.followups.confirm.state_update_failed",
              {
                action_id: action.id,
                profile_name: profileName,
                profile_url_key: profileUrlKey,
              },
            );
          }

          return {
            ok: true,
            result: {
              sent: true,
              status: "followup_sent",
              profile_url: profileUrl,
            },
            artifacts: artifactPaths,
          };
        } catch (error) {
          const failureScreenshot = `linkedin/screenshot-followup-confirm-error-${Date.now()}.png`;
          try {
            await captureScreenshotArtifact(runtime, page, failureScreenshot, {
              action: `${FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE}_error`,
              profile_name: profileName,
              profile_url: profileUrl,
            });
            artifactPaths.push(failureScreenshot);
          } catch {
            // Best-effort error screenshot.
          }

          throw toAutomationError(
            error,
            "Failed to execute LinkedIn accepted-connection follow-up.",
            {
              action_id: action.id,
              current_url: page.url(),
              selector_context: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
              artifact_paths: artifactPaths,
            },
          );
        } finally {
          if (tracingStarted) {
            try {
              const absoluteTracePath = runtime.artifacts.resolve(tracePath);
              await context.tracing.stop({ path: absoluteTracePath });
              runtime.artifacts.registerArtifact(tracePath, "application/zip", {
                action: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
                profile_name: profileName,
              });
            } catch (error) {
              runtime.logger.log(
                "warn",
                "linkedin.followups.confirm.trace.stop_failed",
                {
                  action_id: action.id,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              );
            }
          }
        }
      },
    );
  }
}

/**
 * Builds the follow-up action executor registry used by the shared two-phase
 * commit runtime.
 */
export function createFollowupActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInFollowupsExecutorRuntime>
> {
  return {
    [FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE]:
      new FollowupAfterAcceptActionExecutor(),
  };
}

/**
 * Lists accepted sent invitations and prepares follow-up actions on demand.
 *
 * @remarks
 * This service never auto-confirms prepared actions. It produces prepared
 * actions that must still be confirmed through the shared two-phase commit
 * flow.
 */
export class LinkedInFollowupsService {
  constructor(private readonly runtime: LinkedInFollowupsRuntime) {}

  private loadAcceptedConnections(input: {
    profileName: string;
    cutoffMs: number;
    nowMs?: number;
  }): {
    acceptedStates: SentInvitationStateRow[];
    acceptedConnections: LinkedInAcceptedConnection[];
  } {
    const acceptedStates = this.runtime.db.listAcceptedSentInvitations({
      profileName: input.profileName,
      sinceMs: input.cutoffMs,
    });
    const acceptedConnections = mapAcceptedConnections(
      this.runtime.db,
      acceptedStates,
      input.nowMs ?? Date.now(),
    );

    return {
      acceptedStates,
      acceptedConnections,
    };
  }

  /**
   * Refreshes accepted invitation state and returns accepted connections within
   * the requested lookback window.
   */
  async listAcceptedConnections(
    input: ListAcceptedConnectionsInput = {},
  ): Promise<LinkedInAcceptedConnection[]> {
    const profileName = input.profileName ?? "default";
    const { cutoffMs } = resolveFollowupLookbackWindow(input);

    await this.refreshAcceptanceState(profileName);

    return this.loadAcceptedConnections({
      profileName,
      cutoffMs,
    }).acceptedConnections;
  }

  /**
   * Refreshes accepted invitation state and prepares follow-ups for every
   * accepted connection that still needs one.
   */
  async prepareFollowupsAfterAccept(
    input: PrepareFollowupsAfterAcceptInput = {},
  ): Promise<PrepareFollowupsAfterAcceptResult> {
    const profileName = input.profileName ?? "default";
    const { since, cutoffMs } = resolveFollowupLookbackWindow(input);

    await this.refreshAcceptanceState(profileName);

    const { acceptedStates, acceptedConnections } =
      this.loadAcceptedConnections({
        profileName,
        cutoffMs,
      });

    const stateByKey = new Map(
      acceptedStates.map((state) => [state.profile_url_key, state]),
    );
    const candidates = acceptedConnections.filter((connection) =>
      shouldPrepareAcceptedConnectionFollowup(connection.followup_status),
    );

    const preparedFollowups =
      candidates.length > 0
        ? await this.prepareAcceptedConnections(
            profileName,
            candidates,
            stateByKey,
            input.operatorNote,
          )
        : [];

    const preparedByKey = new Map(
      preparedFollowups.map((prepared) => [
        prepared.connection.profile_url_key,
        prepared.connection,
      ]),
    );

    return {
      since,
      acceptedConnections: acceptedConnections.map(
        (connection) =>
          preparedByKey.get(connection.profile_url_key) ?? connection,
      ),
      preparedFollowups,
    };
  }

  /**
   * Prepares a follow-up for one accepted connection identified by
   * `profileUrlKey`.
   *
   * @returns The prepared action when the connection still needs a follow-up;
   * otherwise `null`.
   */
  async prepareFollowupForAcceptedConnection(
    input: PrepareAcceptedConnectionFollowupInput,
  ): Promise<PreparedAcceptedConnectionFollowup | null> {
    const profileName = input.profileName ?? "default";
    if (input.refreshState) {
      await this.refreshAcceptanceState(profileName);
    }

    const state = this.runtime.db.getSentInvitationState({
      profileName,
      profileUrlKey: input.profileUrlKey,
    });
    if (!state || state.closed_at !== null || state.accepted_at === null) {
      return null;
    }

    const connection = mapAcceptedConnections(
      this.runtime.db,
      [state],
      Date.now(),
    )[0];
    if (!connection) {
      return null;
    }

    if (!shouldPrepareAcceptedConnectionFollowup(connection.followup_status)) {
      return null;
    }

    const prepared = await this.prepareAcceptedConnections(
      profileName,
      [connection],
      new Map([[state.profile_url_key, state]]),
      input.operatorNote,
    );

    return prepared[0] ?? null;
  }

  private async refreshAcceptanceState(profileName: string): Promise<void> {
    const lastSeenBeforeMs = Date.now();

    await this.runtime.connections.listPendingInvitations({
      profileName,
      filter: "sent",
    });

    const candidates = this.runtime.db.listSentInvitationAcceptanceCandidates({
      profileName,
      lastSeenBeforeMs,
    });

    if (candidates.length === 0) {
      return;
    }

    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    const acceptedResults = await this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        const results: Array<{
          state: SentInvitationStateRow;
          probe: AcceptanceProbeResult;
        }> = [];

        for (const state of candidates) {
          try {
            const probe = await probeAcceptedConnection(
              page,
              state.profile_url,
              this.runtime.selectorLocale,
            );
            if (!probe) {
              continue;
            }

            results.push({ state, probe });
          } catch (error) {
            this.runtime.logger.log(
              "warn",
              "linkedin.followups.acceptance_probe_failed",
              {
                profile_name: profileName,
                profile_url: state.profile_url,
                message: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        return results;
      },
    );

    const acceptedAtMs = Date.now();
    for (const accepted of acceptedResults) {
      this.runtime.db.markSentInvitationAccepted({
        profileName,
        profileUrlKey: accepted.state.profile_url_key,
        vanityName: accepted.probe.vanityName,
        fullName: accepted.probe.fullName,
        headline: accepted.probe.headline,
        profileUrl: accepted.probe.profileUrl,
        acceptedAtMs,
        acceptedDetection: accepted.probe.acceptedDetection,
        updatedAtMs: acceptedAtMs,
      });
    }
  }

  private async prepareAcceptedConnections(
    profileName: string,
    connections: LinkedInAcceptedConnection[],
    stateByKey: Map<string, SentInvitationStateRow>,
    operatorNote?: string,
  ): Promise<PreparedAcceptedConnectionFollowup[]> {
    await this.runtime.auth.ensureAuthenticated({
      profileName,
      cdpUrl: this.runtime.cdpUrl,
    });

    return this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true,
      },
      async (context) => {
        const page = await getOrCreatePage(context);
        const preparedResults: PreparedAcceptedConnectionFollowup[] = [];

        for (const connection of connections) {
          const state = stateByKey.get(connection.profile_url_key);
          if (!state) {
            continue;
          }

          try {
            const probe = await probeAcceptedConnection(
              page,
              state.profile_url,
              this.runtime.selectorLocale,
            );
            if (!probe) {
              this.runtime.logger.log(
                "warn",
                "linkedin.followups.prepare.skipped_no_message_surface",
                {
                  profile_name: profileName,
                  profile_url: state.profile_url,
                  profile_url_key: state.profile_url_key,
                },
              );
              continue;
            }

            const relativeProfileUrl = normalizeLinkedInProfileUrl(
              probe.profileUrl || state.profile_url,
            );
            const text = buildDefaultFollowupText(
              probe.fullName || state.full_name,
            );
            const screenshotPath = `linkedin/screenshot-followup-prepare-${Date.now()}-${preparedResults.length + 1}.png`;
            await captureScreenshotArtifact(
              this.runtime,
              page,
              screenshotPath,
              {
                action: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
                profile_name: profileName,
                profile_url: relativeProfileUrl,
              },
            );

            const rateLimitState: RateLimiterState =
              this.runtime.rateLimiter.peek(SEND_MESSAGE_RATE_LIMIT_CONFIG);

            const target = {
              profile_name: profileName,
              profile_url_key: state.profile_url_key,
              target_profile_url: relativeProfileUrl,
              vanity_name: probe.vanityName,
              full_name: probe.fullName || state.full_name,
              headline: probe.headline || state.headline,
            };

            const preview = {
              summary: `Send accepted-connection follow-up to ${
                target.full_name || target.target_profile_url
              }`,
              target,
              acceptance: {
                accepted_at_ms: connection.accepted_at_ms,
                detected_via: connection.accepted_detection,
                first_seen_sent_at_ms: connection.first_seen_sent_at_ms,
                last_seen_sent_at_ms: connection.last_seen_sent_at_ms,
              },
              outbound: {
                text,
              },
              artifacts: [
                {
                  type: "screenshot",
                  path: screenshotPath,
                },
              ],
              rate_limit: formatRateLimitState(rateLimitState),
            } satisfies Record<string, unknown>;

            const prepared = this.runtime.twoPhaseCommit.prepare({
              actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
              target,
              payload: {
                text,
              },
              preview,
              ...(operatorNote
                ? {
                    operatorNote,
                  }
                : {}),
            });

            const preparedAtMs = Date.now();
            const updated = this.runtime.db.markSentInvitationFollowupPrepared({
              profileName,
              profileUrlKey: state.profile_url_key,
              preparedAtMs,
              preparedActionId: prepared.preparedActionId,
              updatedAtMs: preparedAtMs,
            });
            if (!updated) {
              throw new LinkedInBuddyError(
                "ACTION_PRECONDITION_FAILED",
                `Could not persist follow-up preparation state for ${state.profile_url}.`,
                {
                  profile_name: profileName,
                  profile_url_key: state.profile_url_key,
                },
              );
            }

            preparedResults.push({
              connection: {
                ...connection,
                profile_url: relativeProfileUrl,
                vanity_name: probe.vanityName,
                full_name: target.full_name,
                headline: target.headline,
                followup_status: "prepared",
                followup_prepared_action_id: prepared.preparedActionId,
                followup_prepared_at_ms: preparedAtMs,
                followup_expires_at_ms: prepared.expiresAtMs,
              },
              preparedActionId: prepared.preparedActionId,
              confirmToken: prepared.confirmToken,
              expiresAtMs: prepared.expiresAtMs,
              preview: prepared.preview,
            });
          } catch (error) {
            this.runtime.logger.log(
              "warn",
              "linkedin.followups.prepare.failed",
              {
                profile_name: profileName,
                profile_url: state.profile_url,
                message: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        return preparedResults;
      },
    );
  }
}
