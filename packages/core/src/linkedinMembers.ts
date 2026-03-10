import { type BrowserContext, type Locator, type Page } from "playwright-core";
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
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";
import type { LinkedInSelectorLocale } from "./selectorLocale.js";
import {
  buildLinkedInAriaLabelContainsSelector,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint
} from "./selectorLocale.js";
import type {
  ActionExecutor,
  ActionExecutorInput,
  ActionExecutorResult,
  TwoPhaseCommitService
} from "./twoPhaseCommit.js";

export const LINKEDIN_MEMBER_REPORT_REASONS = [
  "fake_profile",
  "impersonation",
  "harassment",
  "spam",
  "scam",
  "misinformation",
  "inappropriate_content",
  "something_else"
] as const;

export type LinkedInMemberReportReason =
  (typeof LINKEDIN_MEMBER_REPORT_REASONS)[number];

export interface PrepareBlockMemberInput {
  profileName?: string;
  targetProfile: string;
  operatorNote?: string;
}

export interface PrepareUnblockMemberInput {
  profileName?: string;
  targetProfile: string;
  operatorNote?: string;
}

export interface PrepareReportMemberInput {
  profileName?: string;
  targetProfile: string;
  reason: LinkedInMemberReportReason | string;
  details?: string;
  operatorNote?: string;
}

export interface LinkedInMembersExecutorRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
}

export interface LinkedInMembersRuntime extends LinkedInMembersExecutorRuntime {
  twoPhaseCommit: Pick<TwoPhaseCommitService<LinkedInMembersExecutorRuntime>, "prepare">;
}

export const BLOCK_MEMBER_ACTION_TYPE = "members.block_member";
export const UNBLOCK_MEMBER_ACTION_TYPE = "members.unblock_member";
export const REPORT_MEMBER_ACTION_TYPE = "members.report_member";

const BLOCKED_MEMBERS_URLS = [
  "https://www.linkedin.com/mypreferences/d/blocking",
  "https://www.linkedin.com/mypreferences/d/visibility/blocking"
] as const;

interface VisibleLocatorCandidate {
  key: string;
  selectorHint: string;
  locatorFactory: (root: Page | Locator) => Locator;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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

function buildLocalizedPhraseList(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[] = english
): string[] {
  return selectorLocale === "da"
    ? dedupePhrases([...danish, ...english])
    : dedupePhrases(english);
}

function buildLocalizedRegex(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[] = english,
  options: { exact?: boolean } = {}
): RegExp {
  const phrases = buildLocalizedPhraseList(selectorLocale, english, danish);
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

async function findVisibleLocator(
  root: Page | Locator,
  candidates: readonly VisibleLocatorCandidate[]
): Promise<{ locator: Locator; key: string } | null> {
  for (const candidate of candidates) {
    const locator = candidate.locatorFactory(root).first();
    if (await locator.isVisible().catch(() => false)) {
      return {
        locator,
        key: candidate.key
      };
    }
  }

  return null;
}

async function isDialogVisible(page: Page): Promise<boolean> {
  return page
    .locator("div[role='dialog'], aside[role='dialog']")
    .first()
    .isVisible()
    .catch(() => false);
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

function createMenuActionCandidates(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[],
  keyPrefix: string
): VisibleLocatorCandidate[] {
  const exactRegex = buildLocalizedRegex(
    selectorLocale,
    english,
    danish,
    { exact: true }
  );
  const textRegex = buildLocalizedRegex(selectorLocale, english, danish);

  return [
    {
      key: `${keyPrefix}-menu-roleitem`,
      selectorHint: `[role='menuitem'] hasText ${textRegex}`,
      locatorFactory: (root) =>
        root.locator("[role='menuitem']").filter({
          hasText: exactRegex
        })
    },
    {
      key: `${keyPrefix}-menu-button`,
      selectorHint: `.artdeco-dropdown__content-inner button hasText ${textRegex}`,
      locatorFactory: (root) =>
        root.locator(".artdeco-dropdown__content-inner button").filter({
          hasText: textRegex
        })
    },
    {
      key: `${keyPrefix}-menu-li`,
      selectorHint: `.artdeco-dropdown__content-inner li hasText ${textRegex}`,
      locatorFactory: (root) =>
        root.locator(".artdeco-dropdown__content-inner li").filter({
          hasText: textRegex
        })
    }
  ];
}

function createDialogActionCandidates(
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[],
  keyPrefix: string,
  options: { includePrimaryFallback?: boolean } = {}
): VisibleLocatorCandidate[] {
  const exactRegex = buildLocalizedRegex(
    selectorLocale,
    english,
    danish,
    { exact: true }
  );
  const textRegex = buildLocalizedRegex(selectorLocale, english, danish);

  return [
    {
      key: `${keyPrefix}-dialog-role-button`,
      selectorHint: `dialog.getByRole(button, ${textRegex})`,
      locatorFactory: (root) =>
        root.locator("div[role='dialog'], aside[role='dialog']").getByRole(
          "button",
          {
            name: exactRegex
          }
        )
    },
    {
      key: `${keyPrefix}-dialog-role-radio`,
      selectorHint: `dialog.getByRole(radio, ${textRegex})`,
      locatorFactory: (root) =>
        root.locator("div[role='dialog'], aside[role='dialog']").getByRole(
          "radio",
          {
            name: exactRegex
          }
        )
    },
    {
      key: `${keyPrefix}-dialog-label`,
      selectorHint: `dialog label hasText ${textRegex}`,
      locatorFactory: (root) =>
        root
          .locator("div[role='dialog'], aside[role='dialog']")
          .locator("label")
          .filter({
            hasText: textRegex
          })
    },
    {
      key: `${keyPrefix}-dialog-button-text`,
      selectorHint: `dialog button hasText ${textRegex}`,
      locatorFactory: (root) =>
        root
          .locator("div[role='dialog'], aside[role='dialog']")
          .locator("button")
          .filter({
            hasText: textRegex
          })
    },
    {
      key: `${keyPrefix}-dialog-generic`,
      selectorHint: `dialog [role='radio'], button, label, li hasText ${textRegex}`,
      locatorFactory: (root) =>
        root
          .locator("div[role='dialog'], aside[role='dialog']")
          .locator("[role='radio'], button, label, li")
          .filter({
            hasText: textRegex
          })
    },
    ...(options.includePrimaryFallback
      ? [
          {
            key: `${keyPrefix}-dialog-primary`,
            selectorHint: "dialog button.artdeco-button--primary",
            locatorFactory: (root: Page | Locator) =>
              root
                .locator("div[role='dialog'], aside[role='dialog']")
                .locator("button.artdeco-button--primary")
          },
          {
            key: `${keyPrefix}-dialog-primary-data`,
            selectorHint: "dialog button[data-test-dialog-primary-btn]",
            locatorFactory: (root: Page | Locator) =>
              root
                .locator("div[role='dialog'], aside[role='dialog']")
                .locator("button[data-test-dialog-primary-btn]")
          }
        ]
      : [])
  ];
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
  return vanityName
    ? `/in/${vanityName}`
    : normalizeLinkedInProfileUrl(resolvedProfileUrl);
}

async function openProfileActionsMenu(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  targetProfile: string
): Promise<string> {
  const topCardRoot = buildProfileTopCardRoot(page);
  const moreCandidates = buildProfileMoreButtonCandidates(
    topCardRoot,
    selectorLocale
  );
  const moreButton = await findVisibleLocator(page, moreCandidates);
  if (!moreButton) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not find the LinkedIn profile actions menu.",
      {
        target_profile: targetProfile,
        attempted_selectors: moreCandidates.map((candidate) => candidate.selectorHint)
      }
    );
  }

  await moreButton.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
  return moreButton.key;
}

async function clickMemberSafetyEntry(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  targetProfile: string
): Promise<string> {
  const moreButtonKey = await openProfileActionsMenu(
    page,
    selectorLocale,
    targetProfile
  );
  const entryCandidates = createMenuActionCandidates(
    selectorLocale,
    ["Report / Block", "Report or block", "Block or report", "Report", "Block"],
    ["Rapportér/bloker", "Rapporter/bloker", "Bloker eller rapporter", "Rapportér", "Bloker"],
    "member-safety-entry"
  );
  const entry = await findVisibleLocator(page, entryCandidates);
  if (!entry) {
    throw new LinkedInAssistantError(
      "UI_CHANGED_SELECTOR_FAILED",
      "Could not find LinkedIn member safety actions in the profile menu.",
      {
        target_profile: targetProfile,
        attempted_selectors: entryCandidates.map((candidate) => candidate.selectorHint)
      }
    );
  }

  await entry.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
  return `${moreButtonKey}:${entry.key}`;
}

async function clickDialogAction(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  english: readonly string[],
  danish: readonly string[],
  keyPrefix: string,
  options: { includePrimaryFallback?: boolean } = {}
): Promise<string | null> {
  const candidates = createDialogActionCandidates(
    selectorLocale,
    english,
    danish,
    keyPrefix,
    options
  );
  const action = await findVisibleLocator(page, candidates);
  if (!action) {
    return null;
  }

  await action.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(600);
  return action.key;
}

function getReportReasonPhrases(
  reason: LinkedInMemberReportReason
): { english: readonly string[]; danish: readonly string[] } {
  switch (reason) {
    case "fake_profile":
      return {
        english: ["Fake profile", "Fake account", "Fake"],
        danish: ["Falsk profil", "Falsk konto", "Falsk"]
      };
    case "impersonation":
      return {
        english: [
          "Pretending to be someone else",
          "Impersonation",
          "Someone is impersonating"
        ],
        danish: [
          "Udgiver sig for at være en anden",
          "Imitation",
          "Nogen udgiver sig for at være en anden"
        ]
      };
    case "harassment":
      return {
        english: ["Harassment", "Bullying", "Harassment or hateful speech"],
        danish: ["Chikane", "Mobning", "Chikane eller hadefuld tale"]
      };
    case "spam":
      return {
        english: ["Spam"],
        danish: ["Spam"]
      };
    case "scam":
      return {
        english: ["Scam", "Fraud", "Fraud or scam"],
        danish: ["Svindel", "Bedrageri"]
      };
    case "misinformation":
      return {
        english: ["Misinformation", "False information"],
        danish: ["Misinformation", "Falsk information"]
      };
    case "inappropriate_content":
      return {
        english: [
          "Inappropriate or offensive",
          "Offensive",
          "Violence",
          "Sexual content"
        ],
        danish: ["Upassende eller stødende", "Stødende", "Vold", "Seksuelt indhold"]
      };
    case "something_else":
      return {
        english: ["Something else", "Other"],
        danish: ["Noget andet", "Andet"]
      };
  }
}

async function selectReportReason(
  page: Page,
  selectorLocale: LinkedInSelectorLocale,
  reason: LinkedInMemberReportReason
): Promise<string> {
  const phrases = getReportReasonPhrases(reason);
  const reasonKey = await clickDialogAction(
    page,
    selectorLocale,
    phrases.english,
    phrases.danish,
    `report-reason-${reason}`
  );

  if (reasonKey) {
    return reasonKey;
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not find the LinkedIn report reason for ${reason}.`,
    {
      report_reason: reason,
      attempted_english_phrases: phrases.english,
      attempted_danish_phrases: phrases.danish
    }
  );
}

async function fillReportDetailsIfVisible(
  page: Page,
  details: string
): Promise<string | null> {
  const dialog = page.locator("div[role='dialog'], aside[role='dialog']").first();
  const field = dialog.locator("textarea, input[type='text']").first();
  if (!(await field.isVisible().catch(() => false))) {
    return null;
  }

  await field.fill(details, { timeout: 5_000 });
  return "report-details-field";
}

async function finishDialogFlow(
  page: Page,
  selectorLocale: LinkedInSelectorLocale
): Promise<string[]> {
  const clickedKeys: string[] = [];

  for (let step = 0; step < 4; step += 1) {
    if (!(await isDialogVisible(page))) {
      return clickedKeys;
    }

    const actionKey = await clickDialogAction(
      page,
      selectorLocale,
      ["Next", "Continue", "Submit", "Done", "Report"],
      ["Næste", "Fortsæt", "Send", "Færdig", "Rapportér"],
      `dialog-step-${step}`,
      { includePrimaryFallback: true }
    );

    if (!actionKey) {
      return clickedKeys;
    }

    clickedKeys.push(actionKey);
  }

  return clickedKeys;
}

async function withBlockedMembersPage<T>(
  page: Page,
  action: (page: Page, sourceUrl: string) => Promise<T>
): Promise<T> {
  const errors: Array<Record<string, string>> = [];

  for (const url of BLOCKED_MEMBERS_URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);
      return await action(page, url);
    } catch (error) {
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  throw new LinkedInAssistantError(
    "UI_CHANGED_SELECTOR_FAILED",
    "Could not open the LinkedIn blocked members settings page.",
    {
      attempted_urls: BLOCKED_MEMBERS_URLS,
      errors
    }
  );
}

async function findBlockedMemberCard(
  page: Page,
  targetProfile: string
): Promise<{ locator: Locator; key: string } | null> {
  const hrefFragment = escapeCssAttributeValue(
    resolveProfileHrefFragment(targetProfile)
  );
  const profileUrl = resolveProfileUrl(targetProfile);
  const vanityName = extractVanityName(profileUrl);
  const textRegex = vanityName ? new RegExp(escapeRegExp(vanityName), "iu") : null;
  const candidates: VisibleLocatorCandidate[] = [
    {
      key: "blocked-member-link-card",
      selectorHint: `li, div, article has a[href*="${hrefFragment}"]`,
      locatorFactory: (root) =>
        root.locator(
          [
            `li:has(a[href*="${hrefFragment}"])`,
            `div[role='listitem']:has(a[href*="${hrefFragment}"])`,
            `article:has(a[href*="${hrefFragment}"])`
          ].join(", ")
        )
    }
  ];

  if (textRegex) {
    candidates.push({
      key: "blocked-member-text-card",
      selectorHint: `li, div[role='listitem'], article hasText ${textRegex}`,
      locatorFactory: (root) =>
        root
          .locator("li, div[role='listitem'], article")
          .filter({ hasText: textRegex })
    });
  }

  return findVisibleLocator(page, candidates);
}

export function normalizeLinkedInMemberReportReason(
  value: string
): LinkedInMemberReportReason {
  const normalizedValue = normalizeText(value).toLowerCase();
  const matchedReason = LINKEDIN_MEMBER_REPORT_REASONS.find((candidate) => {
    return candidate.toLowerCase() === normalizedValue;
  });

  if (matchedReason) {
    return matchedReason;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `reason must be one of: ${LINKEDIN_MEMBER_REPORT_REASONS.join(", ")}.`
  );
}

async function executeBlockMember(
  runtime: LinkedInMembersExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfile = String(target.target_profile ?? "");
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
        actionType: BLOCK_MEMBER_ACTION_TYPE,
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
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn block_member action."
          ),
        execute: async () => {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const entryKey = await clickMemberSafetyEntry(
            page,
            runtime.selectorLocale,
            targetProfile
          );
          const blockDialogKey = await clickDialogAction(
            page,
            runtime.selectorLocale,
            ["Block"],
            ["Bloker"],
            "block-member",
            { includePrimaryFallback: true }
          );

          const confirmKey =
            (await clickDialogAction(
              page,
              runtime.selectorLocale,
              ["Block"],
              ["Bloker"],
              "confirm-block-member",
              { includePrimaryFallback: true }
            )) ?? null;

          const closed = await waitForCondition(
            async () => !(await isDialogVisible(page)),
            5_000
          );
          if (!closed) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "LinkedIn block flow did not finish after confirmation.",
              {
                target_profile: targetProfile,
                entry_selector_key: entryKey,
                block_selector_key: blockDialogKey,
                confirm_selector_key: confirmKey
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "member_blocked",
              target_profile: targetProfile,
              entry_selector_key: entryKey,
              block_selector_key: blockDialogKey,
              confirm_selector_key: confirmKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeUnblockMember(
  runtime: LinkedInMembersExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfile = String(target.target_profile ?? "");

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
        actionType: UNBLOCK_MEMBER_ACTION_TYPE,
        profileName,
        targetUrl: BLOCKED_MEMBERS_URLS[0],
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
            "Failed to execute LinkedIn unblock_member action."
          ),
        execute: async () => {
          const result = await withBlockedMembersPage(page, async (currentPage, sourceUrl) => {
            const card = await findBlockedMemberCard(currentPage, targetProfile);
            if (!card) {
              throw new LinkedInAssistantError(
                "TARGET_NOT_FOUND",
                `Could not find a blocked LinkedIn member matching "${targetProfile}".`,
                {
                  target_profile: targetProfile
                }
              );
            }

            const unblockButtonCandidates = [
              {
                key: "blocked-member-unblock-role",
                selectorHint: "card.getByRole(button, /^(?:Unblock)$/iu)",
                locatorFactory: (root: Page | Locator) =>
                  root.getByRole("button", {
                    name: buildLocalizedRegex(
                      runtime.selectorLocale,
                      ["Unblock"],
                      ["Fjern blokering", "Ophæv blokering"],
                      { exact: true }
                    )
                  })
              },
              {
                key: "blocked-member-unblock-text",
                selectorHint: "card button hasText /(?:Unblock)/iu",
                locatorFactory: (root: Page | Locator) =>
                  root.locator("button").filter({
                    hasText: buildLocalizedRegex(
                      runtime.selectorLocale,
                      ["Unblock"],
                      ["Fjern blokering", "Ophæv blokering"]
                    )
                  })
              }
            ] satisfies VisibleLocatorCandidate[];
            const unblockButton = await findVisibleLocator(
              card.locator,
              unblockButtonCandidates
            );
            if (!unblockButton) {
              throw new LinkedInAssistantError(
                "UI_CHANGED_SELECTOR_FAILED",
                "Could not find the Unblock button for the blocked LinkedIn member.",
                {
                  target_profile: targetProfile,
                  attempted_selectors: unblockButtonCandidates.map(
                    (candidate) => candidate.selectorHint
                  )
                }
              );
            }

            await unblockButton.locator.click({ timeout: 5_000 });
            await currentPage.waitForTimeout(600);

            const confirmKey =
              (await clickDialogAction(
                currentPage,
                runtime.selectorLocale,
                ["Unblock"],
                ["Fjern blokering", "Ophæv blokering"],
                "confirm-unblock-member",
                { includePrimaryFallback: true }
              )) ?? null;

            const removed = await waitForCondition(async () => {
              const existingCard = await findBlockedMemberCard(
                currentPage,
                targetProfile
              );
              return existingCard === null;
            }, 5_000);

            if (!removed) {
              throw new LinkedInAssistantError(
                "UNKNOWN",
                "LinkedIn unblock flow could not be verified after confirmation.",
                {
                  target_profile: targetProfile,
                  unblock_selector_key: unblockButton.key,
                  confirm_selector_key: confirmKey
                }
              );
            }

            return {
              sourceUrl,
              unblockButtonKey: unblockButton.key,
              confirmKey
            };
          });

          return {
            ok: true,
            result: {
              status: "member_unblocked",
              target_profile: targetProfile,
              source_url: result.sourceUrl,
              unblock_selector_key: result.unblockButtonKey,
              confirm_selector_key: result.confirmKey
            },
            artifacts: []
          };
        }
      });
    }
  );
}

async function executeReportMember(
  runtime: LinkedInMembersExecutorRuntime,
  actionId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; artifacts: string[] }> {
  const profileName = String(target.profile_name ?? "default");
  const targetProfile = String(target.target_profile ?? "");
  const profileUrl = resolveProfileUrl(targetProfile);
  const reason = normalizeLinkedInMemberReportReason(String(payload.reason ?? ""));
  const details = normalizeText(String(payload.details ?? ""));

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
        actionType: REPORT_MEMBER_ACTION_TYPE,
        profileName,
        targetUrl: profileUrl,
        metadata: {
          target_profile: targetProfile,
          report_reason: reason,
          profile_url: profileUrl
        },
        errorDetails: {
          target_profile: targetProfile,
          report_reason: reason,
          profile_url: profileUrl
        },
        mapError: (error) =>
          asLinkedInAssistantError(
            error,
            "UNKNOWN",
            "Failed to execute LinkedIn report_member action."
          ),
        execute: async () => {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await waitForNetworkIdleBestEffort(page);

          const entryKey = await clickMemberSafetyEntry(
            page,
            runtime.selectorLocale,
            targetProfile
          );

          const reportActionKey =
            (await clickDialogAction(
              page,
              runtime.selectorLocale,
              ["Report"],
              ["Rapportér"],
              "report-member",
              { includePrimaryFallback: false }
            )) ?? null;

          const reasonKey = await selectReportReason(
            page,
            runtime.selectorLocale,
            reason
          );
          const detailsKey = details
            ? await fillReportDetailsIfVisible(page, details)
            : null;
          const completionKeys = await finishDialogFlow(
            page,
            runtime.selectorLocale
          );

          const closed = await waitForCondition(
            async () => !(await isDialogVisible(page)),
            8_000
          );
          if (!closed) {
            throw new LinkedInAssistantError(
              "UNKNOWN",
              "LinkedIn report flow did not finish after the selected reason was submitted.",
              {
                target_profile: targetProfile,
                report_reason: reason,
                entry_selector_key: entryKey,
                report_selector_key: reportActionKey,
                reason_selector_key: reasonKey,
                completion_selector_keys: completionKeys
              }
            );
          }

          return {
            ok: true,
            result: {
              status: "member_reported",
              target_profile: targetProfile,
              report_reason: reason,
              entry_selector_key: entryKey,
              report_selector_key: reportActionKey,
              reason_selector_key: reasonKey,
              details_selector_key: detailsKey,
              completion_selector_keys: completionKeys
            },
            artifacts: []
          };
        }
      });
    }
  );
}

export class BlockMemberActionExecutor
  implements ActionExecutor<LinkedInMembersExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInMembersExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeBlockMember(
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

export class UnblockMemberActionExecutor
  implements ActionExecutor<LinkedInMembersExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInMembersExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeUnblockMember(
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

export class ReportMemberActionExecutor
  implements ActionExecutor<LinkedInMembersExecutorRuntime>
{
  async execute(
    input: ActionExecutorInput<LinkedInMembersExecutorRuntime>
  ): Promise<ActionExecutorResult> {
    const { result, artifacts } = await executeReportMember(
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

export function createMemberActionExecutors(): Record<
  string,
  ActionExecutor<LinkedInMembersExecutorRuntime>
> {
  return {
    [BLOCK_MEMBER_ACTION_TYPE]: new BlockMemberActionExecutor(),
    [UNBLOCK_MEMBER_ACTION_TYPE]: new UnblockMemberActionExecutor(),
    [REPORT_MEMBER_ACTION_TYPE]: new ReportMemberActionExecutor()
  };
}

export class LinkedInMembersService {
  constructor(private readonly runtime: LinkedInMembersRuntime) {}

  private prepareTargetedMemberAction(input: {
    actionType: string;
    profileName?: string;
    targetProfile: string;
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
    const targetProfile = normalizeText(input.targetProfile);
    if (!targetProfile) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "targetProfile is required."
      );
    }

    const target = {
      profile_name: profileName,
      target_profile: targetProfile
    };

    return this.runtime.twoPhaseCommit.prepare({
      actionType: input.actionType,
      target,
      payload: input.payload ?? {},
      preview: {
        summary: input.summary,
        target,
        ...(input.payload ? { payload: input.payload } : {})
      },
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareBlockMember(
    input: PrepareBlockMemberInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedMemberAction({
      actionType: BLOCK_MEMBER_ACTION_TYPE,
      targetProfile: input.targetProfile,
      summary: `Block LinkedIn member ${normalizeText(input.targetProfile)}`,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareUnblockMember(
    input: PrepareUnblockMemberInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    return this.prepareTargetedMemberAction({
      actionType: UNBLOCK_MEMBER_ACTION_TYPE,
      targetProfile: input.targetProfile,
      summary: `Unblock LinkedIn member ${normalizeText(input.targetProfile)}`,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }

  prepareReportMember(
    input: PrepareReportMemberInput
  ): {
    preparedActionId: string;
    confirmToken: string;
    expiresAtMs: number;
    preview: Record<string, unknown>;
  } {
    const reason = normalizeLinkedInMemberReportReason(input.reason);
    const details = normalizeText(input.details);

    return this.prepareTargetedMemberAction({
      actionType: REPORT_MEMBER_ACTION_TYPE,
      targetProfile: input.targetProfile,
      summary: `Report LinkedIn member ${normalizeText(input.targetProfile)} for ${reason}`,
      payload: {
        reason,
        ...(details ? { details } : {})
      },
      ...(input.profileName ? { profileName: input.profileName } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {})
    });
  }
}
