import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  errors as playwrightErrors,
  type Locator,
  type Page
} from "playwright-core";
import type { ArtifactHelpers } from "./artifacts.js";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  buildLinkedInSelectorPhraseRegex,
  formatLinkedInSelectorRegexHint,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";
import { createFeedPostComposerTriggerCandidates } from "./feedPostComposerTriggerSelectors.js";
import { getOrCreatePage } from "./shared.js";

/**
 * Canonical LinkedIn page identifiers covered by the built-in selector audit.
 */
export const LINKEDIN_SELECTOR_AUDIT_PAGES = [
  "feed",
  "inbox",
  "profile",
  "connections",
  "notifications",
  "company"
] as const;

/**
 * One supported page identifier in the selector audit registry.
 */
export type LinkedInSelectorAuditPage =
  (typeof LINKEDIN_SELECTOR_AUDIT_PAGES)[number];

/**
 * Ordered selector fallback tiers checked for every selector group.
 *
 * `primary` is the preferred stable selector. `secondary` and `tertiary` are
 * tolerated fallbacks that keep the audit actionable while still surfacing UI
 * drift in the final report.
 */
export const LINKEDIN_SELECTOR_AUDIT_STRATEGIES = [
  "primary",
  "secondary",
  "tertiary"
] as const;

/**
 * One selector fallback tier supported by the audit.
 */
export type LinkedInSelectorAuditStrategy =
  (typeof LINKEDIN_SELECTOR_AUDIT_STRATEGIES)[number];

export const LINKEDIN_SELECTOR_AUDIT_CATEGORIES = ["read", "write"] as const;
export type LinkedInSelectorAuditCategory =
  (typeof LINKEDIN_SELECTOR_AUDIT_CATEGORIES)[number];

export const LINKEDIN_SELECTOR_AUDIT_SCOPES = ["read", "write", "all"] as const;
export type LinkedInSelectorAuditScope = (typeof LINKEDIN_SELECTOR_AUDIT_SCOPES)[number];

/**
 * One concrete Playwright locator candidate inside a selector group.
 */
export interface SelectorAuditCandidate {
  strategy: LinkedInSelectorAuditStrategy;
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

/**
 * A logical selector group that should resolve on a page.
 */
export interface SelectorAuditSelectorDefinition {
  key: string;
  description: string;
  category: LinkedInSelectorAuditCategory;
  candidates: SelectorAuditCandidate[];
}

/**
 * Selector audit definition for one LinkedIn page.
 */
export interface SelectorAuditPageDefinition {
  page: LinkedInSelectorAuditPage;
  url: string;
  selectors: SelectorAuditSelectorDefinition[];
  readyCandidates?: SelectorAuditCandidate[];
}

/**
 * Input accepted by {@link LinkedInSelectorAuditService.auditSelectors}.
 */
export interface SelectorAuditInput {
  profileName?: string;
  scope?: LinkedInSelectorAuditScope;
}

/**
 * Per-candidate outcome captured for reporting and troubleshooting.
 */
export interface SelectorAuditStrategyResult {
  strategy: LinkedInSelectorAuditStrategy;
  status: "pass" | "fail";
  selector_key: string;
  selector_hint: string;
  error?: string;
}

/**
 * Failure artifact paths captured when a selector group cannot be matched.
 */
export interface SelectorAuditFailureArtifacts {
  screenshot_path?: string;
  dom_snapshot_path?: string;
  accessibility_snapshot_path?: string;
  capture_warnings?: string[];
}

/**
 * Full audit outcome for one selector group on one page.
 */
export interface SelectorAuditResult {
  page: LinkedInSelectorAuditPage;
  page_url: string;
  selector_key: string;
  description: string;
  category: LinkedInSelectorAuditCategory;
  status: "pass" | "fail";
  matched_strategy: LinkedInSelectorAuditStrategy | null;
  matched_selector_key: string | null;
  fallback_used: string | null;
  fallback_strategy: LinkedInSelectorAuditStrategy | null;
  strategies: Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>;
  failure_artifacts: SelectorAuditFailureArtifacts;
  warnings?: string[];
  error?: string;
}

/**
 * Per-page aggregate counts included in the top-level report.
 */
export interface SelectorAuditPageSummary {
  page: LinkedInSelectorAuditPage;
  total_count: number;
  pass_count: number;
  fail_count: number;
  fallback_count: number;
  read_total_count: number;
  read_pass_count: number;
  read_fail_count: number;
  write_total_count: number;
  write_pass_count: number;
  write_fail_count: number;
}

/**
 * Top-level outcome for a selector audit run.
 */
export type SelectorAuditOutcome = "pass" | "pass_with_fallbacks" | "fail";

/**
 * Page-level warnings that applied to every selector evaluated on that page.
 */
export interface SelectorAuditPageWarningSummary {
  page: LinkedInSelectorAuditPage;
  warnings: string[];
}

/**
 * Failure summary promoted to the top-level report for quick triage.
 */
export interface SelectorAuditFailureSummary {
  page: LinkedInSelectorAuditPage;
  page_url: string;
  selector_key: string;
  description: string;
  error: string;
  warnings?: string[];
  failure_artifacts: SelectorAuditFailureArtifacts;
  recommended_action: string;
}

/**
 * Fallback summary promoted to the top-level report when only non-primary
 * selectors matched.
 */
export interface SelectorAuditFallbackSummary {
  page: LinkedInSelectorAuditPage;
  page_url: string;
  selector_key: string;
  description: string;
  fallback_strategy: Exclude<LinkedInSelectorAuditStrategy, "primary">;
  fallback_used: string;
  warnings?: string[];
  recommended_action: string;
}

/**
 * Structured result returned by the selector audit CLI and core API.
 */
export interface SelectorAuditReport {
  run_id: string;
  profile_name: string;
  checked_at: string;
  scope: LinkedInSelectorAuditScope;
  outcome: SelectorAuditOutcome;
  summary: string;
  total_count: number;
  pass_count: number;
  fail_count: number;
  fallback_count: number;
  read_total_count: number;
  read_pass_count: number;
  read_fail_count: number;
  write_total_count: number;
  write_pass_count: number;
  write_fail_count: number;
  artifact_dir: string;
  report_path: string;
  page_summaries: SelectorAuditPageSummary[];
  page_warnings: SelectorAuditPageWarningSummary[];
  failed_selectors: SelectorAuditFailureSummary[];
  fallback_selectors: SelectorAuditFallbackSummary[];
  recommended_actions: string[];
  results: SelectorAuditResult[];
}

/**
 * Runtime dependencies required by {@link LinkedInSelectorAuditService}.
 *
 * This shape is exported so tests and alternate runtimes can provide a narrow
 * selector-audit-compatible runtime without constructing the full app graph.
 */
export interface LinkedInSelectorAuditRuntime {
  runId: string;
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  selectorLocale?: LinkedInSelectorLocale;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
}

/**
 * Optional overrides for the selector audit registry and timeouts.
 */
export interface LinkedInSelectorAuditServiceOptions {
  registry?: SelectorAuditPageDefinition[];
  candidateTimeoutMs?: number;
  pageReadyTimeoutMs?: number;
  pageNavigationTimeoutMs?: number;
}

interface SelectorAuditCandidateDefinition {
  key: string;
  selectorHint: string;
  locatorFactory: (page: Page) => Locator;
}

type SelectorAuditCandidateDefinitions = Record<
  LinkedInSelectorAuditStrategy,
  SelectorAuditCandidateDefinition
>;

interface SelectorAuditSummaryCounts {
  totalCount: number;
  passCount: number;
  failCount: number;
  fallbackCount: number;
  readTotalCount: number;
  readPassCount: number;
  readFailCount: number;
  writeTotalCount: number;
  writePassCount: number;
  writeFailCount: number;
}

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const LINKEDIN_PROFILE_URL = "https://www.linkedin.com/in/me/";
const LINKEDIN_CONNECTIONS_URL =
  "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const LINKEDIN_NOTIFICATIONS_URL = "https://www.linkedin.com/notifications/";
const LINKEDIN_COMPANY_URL = "https://www.linkedin.com/company/linkedin/";

const DEFAULT_SELECTOR_AUDIT_CANDIDATE_TIMEOUT_MS = 2_000;
const DEFAULT_SELECTOR_AUDIT_PAGE_READY_TIMEOUT_MS = 8_000;
const DEFAULT_SELECTOR_AUDIT_PAGE_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_SELECTOR_AUDIT_NETWORK_IDLE_TIMEOUT_MS = 5_000;
const SELECTOR_AUDIT_MAX_ERROR_MESSAGE_LENGTH = 500;
const SELECTOR_AUDIT_ARTIFACT_DIR = "selector-audit";

function createSelectorAuditCandidates(
  candidates: SelectorAuditCandidateDefinitions
): SelectorAuditCandidate[] {
  return LINKEDIN_SELECTOR_AUDIT_STRATEGIES.map((strategy) => ({
    strategy,
    ...candidates[strategy]
  }));
}

function createSelectorAuditSelectorDefinition(
  key: string,
  description: string,
  category: LinkedInSelectorAuditCategory,
  candidates: SelectorAuditCandidateDefinitions
): SelectorAuditSelectorDefinition {
  return {
    key,
    description,
    category,
    candidates: createSelectorAuditCandidates(candidates)
  };
}

function createDefaultSelectorAuditRegistry(
  selectorLocale: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE
): SelectorAuditPageDefinition[] {
  const postComposerTriggerCandidates = createFeedPostComposerTriggerCandidates(selectorLocale);
  const postComposerTriggerPrimary = postComposerTriggerCandidates[0]!;
  const postComposerTriggerSecondary = postComposerTriggerCandidates[1]!;
  const postComposerTriggerTertiary = postComposerTriggerCandidates[2]!;
  const inboxSurfaceRegex = buildLinkedInSelectorPhraseRegex(
    ["messaging", "write_message"],
    selectorLocale
  );
  const inboxSurfaceRegexHint = formatLinkedInSelectorRegexHint(
    ["messaging", "write_message"],
    selectorLocale
  );
  const profileSurfaceRegex = buildLinkedInSelectorPhraseRegex(
    ["about", "experience", "education", "resources", "open_to"],
    selectorLocale
  );
  const profileSurfaceRegexHint = formatLinkedInSelectorRegexHint(
    ["about", "experience", "education", "resources", "open_to"],
    selectorLocale
  );
  const connectionsHeadingRegex = buildLinkedInSelectorPhraseRegex(
    "connections",
    selectorLocale
  );
  const connectionsHeadingRegexHint = formatLinkedInSelectorRegexHint(
    "connections",
    selectorLocale
  );
  const connectionsSurfaceRegex = buildLinkedInSelectorPhraseRegex(
    ["connections", "message", "remove_connection"],
    selectorLocale
  );
  const connectionsSurfaceRegexHint = formatLinkedInSelectorRegexHint(
    ["connections", "message", "remove_connection"],
    selectorLocale
  );
  const notificationsHeadingRegex = buildLinkedInSelectorPhraseRegex(
    "notifications",
    selectorLocale
  );
  const notificationsHeadingRegexHint = formatLinkedInSelectorRegexHint(
    "notifications",
    selectorLocale
  );
  const notificationsSurfaceRegex = buildLinkedInSelectorPhraseRegex(
    ["notifications", "time_ago"],
    selectorLocale
  );
  const notificationsSurfaceRegexHint = formatLinkedInSelectorRegexHint(
    ["notifications", "time_ago"],
    selectorLocale
  );
  const likeRegex = buildLinkedInSelectorPhraseRegex("like", selectorLocale);
  const likeRegexHint = formatLinkedInSelectorRegexHint("like", selectorLocale);
  const commentRegex = buildLinkedInSelectorPhraseRegex("comment", selectorLocale);
  const commentRegexHint = formatLinkedInSelectorRegexHint("comment", selectorLocale);
  const repostRegex = buildLinkedInSelectorPhraseRegex("repost", selectorLocale);
  const repostRegexHint = formatLinkedInSelectorRegexHint("repost", selectorLocale);
  const writeMessageRegex = buildLinkedInSelectorPhraseRegex(
    ["message", "write_message"],
    selectorLocale
  );
  const writeMessageRegexHint = formatLinkedInSelectorRegexHint(
    ["message", "write_message"],
    selectorLocale
  );
  const sendRegex = buildLinkedInSelectorPhraseRegex("send", selectorLocale);
  const sendRegexHint = formatLinkedInSelectorRegexHint("send", selectorLocale);
  const messageRegex = buildLinkedInSelectorPhraseRegex("message", selectorLocale);
  const messageRegexHint = formatLinkedInSelectorRegexHint("message", selectorLocale);
  const followRegex = buildLinkedInSelectorPhraseRegex("follow", selectorLocale);
  const followRegexHint = formatLinkedInSelectorRegexHint("follow", selectorLocale);

  return [
    {
      page: "feed",
      url: LINKEDIN_FEED_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "post_composer_trigger",
          "Feed post composer trigger",
          "read",
          {
            primary: postComposerTriggerPrimary,
            secondary: postComposerTriggerSecondary,
            tertiary: postComposerTriggerTertiary
          }
        ),
        createSelectorAuditSelectorDefinition(
          "feed_like_button",
          "Feed post like/react button",
          "write",
          {
            primary: {
              key: "social-action-react-trigger",
              selectorHint: "button.react-button__trigger",
              locatorFactory: (page) =>
                page.locator(
                  "button.react-button__trigger, button.social-actions-button.react-button__trigger"
                )
            },
            secondary: {
              key: "role-button-like",
              selectorHint: `getByRole(button, ${likeRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: likeRegex })
            },
            tertiary: {
              key: "button-text-like",
              selectorHint: `button hasText ${likeRegexHint}`,
              locatorFactory: (page) =>
                page.locator("button, [role='button']").filter({ hasText: likeRegex })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "feed_comment_button",
          "Feed post comment button",
          "write",
          {
            primary: {
              key: "social-action-comment",
              selectorHint: "button.comment-button, button.social-actions-button.comment-button",
              locatorFactory: (page) =>
                page.locator(
                  "button.comment-button, button.social-actions-button.comment-button"
                )
            },
            secondary: {
              key: "role-button-comment",
              selectorHint: `getByRole(button, ${commentRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: commentRegex })
            },
            tertiary: {
              key: "button-text-comment",
              selectorHint: `button hasText ${commentRegexHint}`,
              locatorFactory: (page) =>
                page.locator("button, [role='button']").filter({ hasText: commentRegex })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "feed_repost_button",
          "Feed post repost button",
          "write",
          {
            primary: {
              key: "social-action-repost",
              selectorHint: "button.repost-button, button.social-actions-button.repost-button",
              locatorFactory: (page) =>
                page.locator("button.repost-button, button.social-actions-button.repost-button")
            },
            secondary: {
              key: "role-button-repost",
              selectorHint: `getByRole(button, ${repostRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: repostRegex })
            },
            tertiary: {
              key: "button-text-repost",
              selectorHint: `button hasText ${repostRegexHint}`,
              locatorFactory: (page) =>
                page.locator("button, [role='button']").filter({ hasText: repostRegex })
            }
          }
        )
      ]
    },
    {
      page: "inbox",
      url: LINKEDIN_MESSAGING_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "conversation_list_surface",
          "Inbox conversation list surface",
          "read",
          {
            primary: {
              key: "role-main-with-thread-link",
              selectorHint: "getByRole(main) has a[href*='/messaging/thread/']",
              locatorFactory: (page) =>
                page
                  .getByRole("main")
                  .filter({ has: page.locator("a[href*='/messaging/thread/']") })
            },
            secondary: {
              key: "thread-link-or-conversation-card",
              selectorHint:
                "a[href*='/messaging/thread/'], li.msg-conversation-listitem, .msg-conversation-card, .msg-conversations-container",
              locatorFactory: (page) =>
                page.locator(
                  "a[href*='/messaging/thread/'], li.msg-conversation-listitem, .msg-conversation-card, .msg-conversations-container"
                )
            },
            tertiary: {
              key: "main-text-messaging",
              selectorHint: `main hasText ${inboxSurfaceRegexHint}`,
              locatorFactory: (page) =>
                page.locator("main").filter({
                  hasText: inboxSurfaceRegex
                })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "inbox_compose_button",
          "Inbox new message compose button",
          "write",
          {
            primary: {
              key: "role-button-compose",
              selectorHint: `getByRole(button, ${writeMessageRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: writeMessageRegex })
            },
            secondary: {
              key: "compose-link-or-button",
              selectorHint:
                "a[href*='/messaging/new'], button[data-control-name*='compose'], .msg-overlay-bubble-header__button",
              locatorFactory: (page) =>
                page.locator(
                  "a[href*='/messaging/new'], button[data-control-name*='compose'], .msg-overlay-bubble-header__button"
                )
            },
            tertiary: {
              key: "button-text-compose",
              selectorHint: `button, a hasText ${writeMessageRegexHint}`,
              locatorFactory: (page) =>
                page.locator("button, a").filter({ hasText: writeMessageRegex })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "inbox_message_input",
          "Inbox message compose input",
          "write",
          {
            primary: {
              key: "msg-form-contenteditable",
              selectorHint:
                ".msg-form__contenteditable[contenteditable='true'], .msg-form [contenteditable='true']",
              locatorFactory: (page) =>
                page.locator(
                  ".msg-form__contenteditable[contenteditable='true'], .msg-form [contenteditable='true']"
                )
            },
            secondary: {
              key: "role-textbox-message",
              selectorHint: "getByRole(textbox) scoped to messaging",
              locatorFactory: (page) => page.locator(".msg-form").getByRole("textbox")
            },
            tertiary: {
              key: "contenteditable-fallback",
              selectorHint: "div[contenteditable='true'][role='textbox'], [role='textbox']",
              locatorFactory: (page) =>
                page.locator("div[contenteditable='true'][role='textbox'], .msg-form [role='textbox']")
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "inbox_send_button",
          "Inbox message send button",
          "write",
          {
            primary: {
              key: "msg-form-send-button",
              selectorHint: "button.msg-form__send-button",
              locatorFactory: (page) =>
                page.locator("button.msg-form__send-button, button[type='submit'].msg-form__send-button")
            },
            secondary: {
              key: "role-button-send",
              selectorHint: `getByRole(button, ${sendRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: sendRegex })
            },
            tertiary: {
              key: "button-text-send",
              selectorHint: `button hasText ${sendRegexHint}`,
              locatorFactory: (page) => page.locator("button").filter({ hasText: sendRegex })
            }
          }
        )
      ]
    },
    {
      page: "profile",
      url: LINKEDIN_PROFILE_URL,
      selectors: [
        createSelectorAuditSelectorDefinition("profile_header", "Profile header", "read", {
          primary: {
            key: "role-heading-h1",
            selectorHint: "getByRole(heading, level: 1)",
            locatorFactory: (page) => page.getByRole("heading", { level: 1 })
          },
          secondary: {
            key: "profile-h1",
            selectorHint: "h1.text-heading-xlarge, h1[class*='text-heading'], h1",
            locatorFactory: (page) =>
              page.locator("h1.text-heading-xlarge, h1[class*='text-heading'], h1")
          },
          tertiary: {
            key: "main-text-profile-sections",
            selectorHint: `main hasText ${profileSurfaceRegexHint}`,
            locatorFactory: (page) =>
              page.locator("main").filter({
                hasText: profileSurfaceRegex
              })
          }
        }),
        createSelectorAuditSelectorDefinition(
          "profile_edit_intro_button",
          "Profile edit intro button",
          "write",
          {
            primary: {
              key: "intro-edit-link",
              selectorHint: "a[href*='edit/forms/intro'], button[aria-label*='Edit intro']",
              locatorFactory: (page) =>
                page.locator("a[href*='edit/forms/intro'], button[aria-label*='Edit intro' i]")
            },
            secondary: {
              key: "edit-pencil-button",
              selectorHint: "section button[aria-label*='edit' i], a[href*='profileEdit']",
              locatorFactory: (page) =>
                page.locator(
                  "section.artdeco-card button[aria-label*='edit' i], section.artdeco-card a[aria-label*='edit' i], a[href*='profileEdit']"
                )
            },
            tertiary: {
              key: "top-card-edit-action",
              selectorHint: ".pv-top-card button svg, .pv-top-card a svg parent button",
              locatorFactory: (page) =>
                page.locator(
                  ".pv-top-card--edit-name-handle-action, .pv-top-card .edit-public-profile-section button, .pv-top-card a[href*='edit']"
                )
            }
          }
        )
      ]
    },
    {
      page: "connections",
      url: LINKEDIN_CONNECTIONS_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "connections_action_buttons",
          "Connection action buttons (Message, Remove)",
          "write",
          {
            primary: {
              key: "connection-message-button",
              selectorHint: "button[aria-label*='Message' i], button[aria-label*='message' i]",
              locatorFactory: (page) =>
                page.locator("button[aria-label*='Message' i], button[aria-label*='message' i]").first()
            },
            secondary: {
              key: "connection-action-link",
              selectorHint: "a[href*='/messaging/thread/']",
              locatorFactory: (page) =>
                page.locator("a[href*='/messaging/thread/']").first()
            },
            tertiary: {
              key: "connection-card-with-actions",
              selectorHint: "li:has(button)",
              locatorFactory: (page) =>
                page.locator("li.mn-connection-card:has(button), li:has(button[aria-label])").first()
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "connections_surface",
          "Connections page surface",
          "read",
          {
            primary: {
              key: "role-heading-connections",
              selectorHint: `getByRole(heading, ${connectionsHeadingRegexHint})`,
              locatorFactory: (page) =>
                page.getByRole("heading", { name: connectionsHeadingRegex })
            },
            secondary: {
              key: "connection-card",
              selectorHint:
                "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']",
              locatorFactory: (page) =>
                page.locator(
                  "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']"
                )
            },
            tertiary: {
              key: "main-text-connections",
              selectorHint: `main hasText ${connectionsSurfaceRegexHint}`,
              locatorFactory: (page) =>
                page.locator("main").filter({
                  hasText: connectionsSurfaceRegex
                })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "connections_message_button",
          "Connections card message button",
          "write",
          {
            primary: {
              key: "role-button-message",
              selectorHint: `getByRole(button, ${messageRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: messageRegex })
            },
            secondary: {
              key: "connection-card-message-btn",
              selectorHint:
                "button.mn-connection-card__message-btn, button[data-control-name='message']",
              locatorFactory: (page) =>
                page.locator(
                  "button.mn-connection-card__message-btn, button[data-control-name='message']"
                )
            },
            tertiary: {
              key: "button-text-message",
              selectorHint: `button hasText ${messageRegexHint}`,
              locatorFactory: (page) => page.locator("button").filter({ hasText: messageRegex })
            }
          }
        )
      ]
    },
    {
      page: "notifications",
      url: LINKEDIN_NOTIFICATIONS_URL,
      selectors: [
        createSelectorAuditSelectorDefinition(
          "notifications_surface",
          "Notifications list surface",
          "read",
          {
            primary: {
              key: "role-heading-notifications",
              selectorHint: `getByRole(heading, ${notificationsHeadingRegexHint})`,
              locatorFactory: (page) =>
                page.getByRole("heading", { name: notificationsHeadingRegex })
            },
            secondary: {
              key: "notification-card",
              selectorHint: ".nt-card, .notification-card, div[data-urn], article",
              locatorFactory: (page) =>
                page.locator(".nt-card, .notification-card, div[data-urn], article")
            },
            tertiary: {
              key: "main-text-notifications",
              selectorHint: `main hasText ${notificationsSurfaceRegexHint}`,
              locatorFactory: (page) =>
                page.locator("main").filter({ hasText: notificationsSurfaceRegex })
            }
          }
        )
      ]
    },
    {
      page: "company",
      url: LINKEDIN_COMPANY_URL,
      selectors: [
        createSelectorAuditSelectorDefinition("company_heading", "Company page heading", "read", {
          primary: {
            key: "role-heading-h1",
            selectorHint: "getByRole(heading, level: 1)",
            locatorFactory: (page) => page.getByRole("heading", { level: 1 })
          },
          secondary: {
            key: "company-h1",
            selectorHint: "h1.org-top-card-summary__title, h1[class*='org-top-card'], h1",
            locatorFactory: (page) =>
              page.locator("h1.org-top-card-summary__title, h1[class*='org-top-card'], h1")
          },
          tertiary: {
            key: "main-h1",
            selectorHint: "main h1",
            locatorFactory: (page) => page.locator("main h1")
          }
        }),
        createSelectorAuditSelectorDefinition(
          "company_follow_button",
          "Company page follow button",
          "write",
          {
            primary: {
              key: "role-button-follow",
              selectorHint: `getByRole(button, ${followRegexHint})`,
              locatorFactory: (page) => page.getByRole("button", { name: followRegex })
            },
            secondary: {
              key: "follow-control-button",
              selectorHint: "button.follow, button[data-control-name*='follow']",
              locatorFactory: (page) =>
                page.locator("button.follow, button[data-control-name*='follow']")
            },
            tertiary: {
              key: "button-text-follow",
              selectorHint: `button hasText ${followRegexHint}`,
              locatorFactory: (page) => page.locator("button").filter({ hasText: followRegex })
            }
          }
        ),
        createSelectorAuditSelectorDefinition(
          "company_overlay_modal",
          "Company page overlay modal detection",
          "write",
          {
            primary: {
              key: "org-page-viewing-setting-modal",
              selectorHint: "[data-test-modal-id='org-page-viewing-setting-modal']",
              locatorFactory: (page) =>
                page.locator("[data-test-modal-id='org-page-viewing-setting-modal']")
            },
            secondary: {
              key: "artdeco-modal-overlay-org",
              selectorHint:
                ".artdeco-modal-overlay:has([data-test-modal-id='org-page-viewing-setting-modal'])",
              locatorFactory: (page) =>
                page.locator(
                  ".artdeco-modal-overlay:has([data-test-modal-id='org-page-viewing-setting-modal'])"
                )
            },
            tertiary: {
              key: "dialog-org-setting",
              selectorHint: "[role='dialog'] has .org-page-viewing-setting",
              locatorFactory: (page) =>
                page.locator("[role='dialog']").filter({
                  has: page.locator(".org-page-viewing-setting, [class*='org-page-viewing']")
                })
            }
          }
        )
      ]
    }
  ];
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeUserFacingText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= SELECTOR_AUDIT_MAX_ERROR_MESSAGE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, SELECTOR_AUDIT_MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeUserFacingText(error.message);
  }

  return sanitizeUserFacingText(String(error));
}

function createErrorOptions(error: unknown): ErrorOptions | undefined {
  if (error instanceof Error) {
    return { cause: error };
  }

  return undefined;
}

function isNetworkError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i.test(message);
}

function validateNonEmptyText(value: string, label: string): string {
  const normalized = sanitizeUserFacingText(value);
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`
    );
  }

  return normalized;
}

function validateProfileName(profileName?: string): string {
  const normalizedProfileName = validateNonEmptyText(profileName ?? "default", "profile");
  if (
    normalizedProfileName === "." ||
    normalizedProfileName === ".." ||
    /[\\/]/.test(normalizedProfileName)
  ) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "profile must not contain path separators or relative path segments.",
      {
        profile_name: normalizedProfileName
      }
    );
  }

  return normalizedProfileName;
}

function validateTimeoutOption(
  value: number | undefined,
  label: string,
  fallback: number
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer number of milliseconds.`,
      {
        label,
        value: normalized
      }
    );
  }

  return normalized;
}

function validateSelectorAuditInput(input: SelectorAuditInput = {}): SelectorAuditInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "selector audit input must be an object.",
      {
        received_type: Array.isArray(input) ? "array" : typeof input
      }
    );
  }

  return input;
}

function validateSelectorAuditScope(
  scope: LinkedInSelectorAuditScope | undefined
): LinkedInSelectorAuditScope {
  if (scope === undefined) {
    return "all";
  }

  const validScopes: readonly string[] = LINKEDIN_SELECTOR_AUDIT_SCOPES;
  if (!validScopes.includes(scope)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Invalid selector audit scope: ${sanitizeUserFacingText(String(scope))}. Valid scopes: ${LINKEDIN_SELECTOR_AUDIT_SCOPES.join(", ")}.`
    );
  }

  return scope;
}

function filterRegistryByScope(
  registry: SelectorAuditPageDefinition[],
  scope: LinkedInSelectorAuditScope
): SelectorAuditPageDefinition[] {
  if (scope === "all") {
    return registry;
  }

  return registry
    .map((pageDefinition) => ({
      ...pageDefinition,
      selectors: pageDefinition.selectors.filter((selector) => selector.category === scope)
    }))
    .filter((pageDefinition) => pageDefinition.selectors.length > 0);
}

function validateAuditPageUrl(page: LinkedInSelectorAuditPage, value: string): void {
  const normalizedUrl = validateNonEmptyText(value, `Selector audit page ${page} URL`);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Selector audit page ${page} has an invalid URL.`
    );
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Selector audit page ${page} must use http or https.`
    );
  }
}

function createMissingStrategyResult(
  strategy: LinkedInSelectorAuditStrategy
): SelectorAuditStrategyResult {
  const titleCaseStrategy = `${strategy[0]?.toUpperCase() ?? ""}${strategy.slice(1)}`;

  return {
    strategy,
    status: "fail",
    selector_key: `missing-${strategy}`,
    selector_hint: `${strategy} selector missing from registry`,
    error: `${titleCaseStrategy} selector missing from registry.`
  };
}

function createEmptyPageSummary(page: LinkedInSelectorAuditPage): SelectorAuditPageSummary {
  return {
    page,
    total_count: 0,
    pass_count: 0,
    fail_count: 0,
    fallback_count: 0,
    read_total_count: 0,
    read_pass_count: 0,
    read_fail_count: 0,
    write_total_count: 0,
    write_pass_count: 0,
    write_fail_count: 0
  };
}

function countSelectorAuditResults(
  results: SelectorAuditResult[]
): SelectorAuditSummaryCounts {
  return results.reduce<SelectorAuditSummaryCounts>(
    (counts, result) => {
      const isRead = result.category === "read";
      const isPass = result.status === "pass";
      const isFail = result.status === "fail";

      return {
        totalCount: counts.totalCount + 1,
        passCount: counts.passCount + (isPass ? 1 : 0),
        failCount: counts.failCount + (isFail ? 1 : 0),
        fallbackCount: counts.fallbackCount + (result.fallback_used !== null ? 1 : 0),
        readTotalCount: counts.readTotalCount + (isRead ? 1 : 0),
        readPassCount: counts.readPassCount + (isRead && isPass ? 1 : 0),
        readFailCount: counts.readFailCount + (isRead && isFail ? 1 : 0),
        writeTotalCount: counts.writeTotalCount + (!isRead ? 1 : 0),
        writePassCount: counts.writePassCount + (!isRead && isPass ? 1 : 0),
        writeFailCount: counts.writeFailCount + (!isRead && isFail ? 1 : 0)
      };
    },
    {
      totalCount: 0,
      passCount: 0,
      failCount: 0,
      fallbackCount: 0,
      readTotalCount: 0,
      readPassCount: 0,
      readFailCount: 0,
      writeTotalCount: 0,
      writePassCount: 0,
      writeFailCount: 0
    }
  );
}

function formatCountLabel(
  count: number,
  singular: string,
  plural: string = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function createSelectorAuditOutcome(
  counts: SelectorAuditSummaryCounts
): SelectorAuditOutcome {
  if (counts.failCount > 0) {
    return "fail";
  }

  if (counts.fallbackCount > 0) {
    return "pass_with_fallbacks";
  }

  return "pass";
}

function createSelectorAuditSummary(
  counts: SelectorAuditSummaryCounts,
  pageCount: number
): string {
  const parts = [
    `Checked ${formatCountLabel(counts.totalCount, "selector group")} across ${formatCountLabel(pageCount, "page")}.`,
    `${counts.passCount} passed.`,
    `${counts.failCount} failed.`,
    `${counts.fallbackCount} used fallback selectors.`
  ];

  if (counts.readTotalCount > 0 && counts.writeTotalCount > 0) {
    parts.push(
      `Read: ${counts.readPassCount}/${counts.readTotalCount} passed. Write: ${counts.writePassCount}/${counts.writeTotalCount} passed.`
    );
  }

  return parts.join(" ");
}

function createFailureRecommendedAction(result: SelectorAuditResult): string {
  return `Open the captured failure artifacts for ${result.selector_key} on ${result.page}, update that selector group in the registry, and rerun the selector audit.`;
}

function createFallbackRecommendedAction(result: SelectorAuditResult): string {
  return `Primary selectors did not match for ${result.selector_key} on ${result.page}. Review the primary selector and keep ${result.fallback_used} (${result.fallback_strategy}) only if it reflects the stable LinkedIn UI.`;
}

function buildPageWarningSummaries(
  pageOrder: readonly LinkedInSelectorAuditPage[],
  results: SelectorAuditResult[]
): SelectorAuditPageWarningSummary[] {
  const warningsByPage = new Map<LinkedInSelectorAuditPage, string[]>();

  for (const result of results) {
    if (!result.warnings || result.warnings.length === 0) {
      continue;
    }

    const warnings = warningsByPage.get(result.page) ?? [];
    for (const warning of result.warnings) {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }
    warningsByPage.set(result.page, warnings);
  }

  return pageOrder.flatMap((page) => {
    const warnings = warningsByPage.get(page);
    return warnings && warnings.length > 0 ? [{ page, warnings }] : [];
  });
}

function buildFailureSummaries(
  results: SelectorAuditResult[]
): SelectorAuditFailureSummary[] {
  return results.flatMap((result) => {
    if (result.status !== "fail") {
      return [];
    }

    return [
      {
        page: result.page,
        page_url: result.page_url,
        selector_key: result.selector_key,
        description: result.description,
        error:
          result.error ??
          createSelectorDefinitionFailureMessage(
            {
              page: result.page,
              url: result.page_url,
              selectors: [],
              ...(result.warnings ? { readyCandidates: [] } : {})
            },
            {
              key: result.selector_key,
              description: result.description,
              category: result.category,
              candidates: []
            }
          ),
        ...(result.warnings ? { warnings: [...result.warnings] } : {}),
        failure_artifacts: result.failure_artifacts,
        recommended_action: createFailureRecommendedAction(result)
      }
    ];
  });
}

function buildFallbackSummaries(
  results: SelectorAuditResult[]
): SelectorAuditFallbackSummary[] {
  return results.flatMap((result) => {
    if (
      result.status !== "pass" ||
      result.fallback_strategy === null ||
      result.fallback_strategy === "primary" ||
      result.fallback_used === null
    ) {
      return [];
    }

    return [
      {
        page: result.page,
        page_url: result.page_url,
        selector_key: result.selector_key,
        description: result.description,
        fallback_strategy: result.fallback_strategy,
        fallback_used: result.fallback_used,
        ...(result.warnings ? { warnings: [...result.warnings] } : {}),
        recommended_action: createFallbackRecommendedAction(result)
      }
    ];
  });
}

function buildRecommendedActions(options: {
  profileName: string;
  reportPath: string;
  failedSelectors: SelectorAuditFailureSummary[];
  fallbackSelectors: SelectorAuditFallbackSummary[];
  pageWarnings: SelectorAuditPageWarningSummary[];
}): string[] {
  const actions: string[] = [];

  if (options.failedSelectors.length > 0) {
    actions.push(
      `Open ${options.reportPath} and the captured artifacts for failed selector groups before changing the registry.`
    );
    actions.push(
      `Update the selector registry entries for the failed selector groups, then rerun linkedin audit selectors --profile ${options.profileName}.`
    );
  }

  if (options.fallbackSelectors.length > 0) {
    actions.push(
      "Review selector groups that only matched via fallback and refresh their primary selectors before they fail completely."
    );
  }

  if (options.pageWarnings.length > 0) {
    actions.push(
      "Some pages were not fully stable during the audit. Refresh the LinkedIn session or attached browser and rerun before treating warnings as definitive UI drift."
    );
  }

  if (actions.length === 0) {
    actions.push(
      "No follow-up is required right now. Keep the selector audit in regular maintenance or CI to catch future UI drift."
    );
  }

  return actions;
}

function validateSelectorAuditRegistry(
  registry: SelectorAuditPageDefinition[]
): SelectorAuditPageDefinition[] {
  if (registry.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Selector audit registry must contain at least one page definition."
    );
  }

  const pageKeys = new Set<LinkedInSelectorAuditPage>();

  for (const pageDefinition of registry) {
    validateAuditPageUrl(pageDefinition.page, pageDefinition.url);

    if (pageKeys.has(pageDefinition.page)) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Duplicate selector audit page definition: ${pageDefinition.page}`
      );
    }

    pageKeys.add(pageDefinition.page);

    if (pageDefinition.selectors.length === 0) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Selector audit page ${pageDefinition.page} has no selectors.`
      );
    }

    const selectorKeys = new Set<string>();
    for (const selectorDefinition of pageDefinition.selectors) {
      validateNonEmptyText(selectorDefinition.key, `Selector audit key on ${pageDefinition.page}`);
      validateNonEmptyText(
        selectorDefinition.description,
        `Selector audit description on ${pageDefinition.page}:${selectorDefinition.key}`
      );

      if (selectorKeys.has(selectorDefinition.key)) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Duplicate selector audit key ${selectorDefinition.key} on ${pageDefinition.page}.`
        );
      }

      selectorKeys.add(selectorDefinition.key);

      if (selectorDefinition.candidates.length === 0) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Selector audit key ${selectorDefinition.key} on ${pageDefinition.page} has no candidates.`
        );
      }

      const candidateKeys = new Set<string>();
      const strategies = new Set<LinkedInSelectorAuditStrategy>();
      for (const candidate of selectorDefinition.candidates) {
        validateNonEmptyText(
          candidate.key,
          `Selector audit candidate key on ${pageDefinition.page}:${selectorDefinition.key}`
        );
        validateNonEmptyText(
          candidate.selectorHint,
          `Selector audit selector hint on ${pageDefinition.page}:${selectorDefinition.key}:${candidate.strategy}`
        );

        if (typeof candidate.locatorFactory !== "function") {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            `Selector audit candidate ${candidate.key} on ${pageDefinition.page}:${selectorDefinition.key} is missing a locator factory.`
          );
        }

        if (candidateKeys.has(candidate.key)) {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            `Duplicate selector audit candidate key ${candidate.key} on ${pageDefinition.page}:${selectorDefinition.key}.`
          );
        }
        candidateKeys.add(candidate.key);

        if (strategies.has(candidate.strategy)) {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            `Duplicate selector audit strategy ${candidate.strategy} on ${pageDefinition.page}:${selectorDefinition.key}.`
          );
        }
        strategies.add(candidate.strategy);
      }
    }

    if (pageDefinition.readyCandidates !== undefined) {
      if (pageDefinition.readyCandidates.length === 0) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          `Selector audit page ${pageDefinition.page} has an empty readyCandidates list.`
        );
      }

      for (const readyCandidate of pageDefinition.readyCandidates) {
        validateNonEmptyText(
          readyCandidate.key,
          `Selector audit ready candidate key on ${pageDefinition.page}`
        );
        validateNonEmptyText(
          readyCandidate.selectorHint,
          `Selector audit ready selector hint on ${pageDefinition.page}:${readyCandidate.strategy}`
        );

        if (typeof readyCandidate.locatorFactory !== "function") {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            `Selector audit ready candidate ${readyCandidate.key} on ${pageDefinition.page} is missing a locator factory.`
          );
        }
      }
    }
  }

  return registry;
}

async function getAccessibilitySnapshot(page: Page): Promise<unknown> {
  const accessiblePage = page as unknown as {
    accessibility?: {
      snapshot: (options?: { interestingOnly?: boolean }) => Promise<unknown>;
    };
  };

  if (!accessiblePage.accessibility) {
    return null;
  }

  return accessiblePage.accessibility.snapshot({ interestingOnly: false });
}

function createStrategyResults(
  strategyResults: SelectorAuditStrategyResult[]
): Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult> {
  const indexed = new Map<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>();
  for (const result of strategyResults) {
    indexed.set(result.strategy, result);
  }

  return Object.fromEntries(
    LINKEDIN_SELECTOR_AUDIT_STRATEGIES.map((strategy) => [
      strategy,
      indexed.get(strategy) ?? createMissingStrategyResult(strategy)
    ])
  ) as Record<LinkedInSelectorAuditStrategy, SelectorAuditStrategyResult>;
}

function createPageOpenError(profileName: string, error: unknown): LinkedInBuddyError {
  return new LinkedInBuddyError(
    isNetworkError(error) ? "NETWORK_ERROR" : "UNKNOWN",
    `Could not open a browser page for selector audit on profile ${profileName}: ${getErrorMessage(error)}. Make sure the profile is available and retry.`,
    {
      profile_name: profileName
    },
    createErrorOptions(error)
  );
}

function createPageLoadError(
  pageDefinition: SelectorAuditPageDefinition,
  navigationTimeoutMs: number,
  error: unknown
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  const details = {
    page: pageDefinition.page,
    page_url: pageDefinition.url
  };

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInBuddyError(
      "TIMEOUT",
      `Timed out after ${navigationTimeoutMs}ms loading the ${pageDefinition.page} page. Confirm the LinkedIn session can open ${pageDefinition.url} and rerun the selector audit.`,
      details,
      createErrorOptions(error)
    );
  }

  if (isNetworkError(error)) {
    return new LinkedInBuddyError(
      "NETWORK_ERROR",
      `Could not load the ${pageDefinition.page} page because the browser or network connection failed: ${getErrorMessage(error)}. Check connectivity or the attached browser session and rerun the selector audit.`,
      details,
      createErrorOptions(error)
    );
  }

  return new LinkedInBuddyError(
    "UNKNOWN",
    `Could not load the ${pageDefinition.page} page: ${getErrorMessage(error)}. Refresh the LinkedIn session or attached browser and rerun the selector audit.`,
    details,
    createErrorOptions(error)
  );
}

function createPageReadinessWarning(
  pageDefinition: SelectorAuditPageDefinition,
  timeoutMs: number,
  strategyResults: SelectorAuditStrategyResult[]
): string {
  const firstFailure = strategyResults.find((result) => result.status === "fail")?.error;
  const firstFailureSuffix = firstFailure ? ` Last check: ${firstFailure}.` : "";

  return `Could not confirm that the ${pageDefinition.page} page was ready within ${timeoutMs}ms.${firstFailureSuffix} Selector checks continued with the current DOM state; if failures persist, reload the page or update the ready selectors and rerun the selector audit.`;
}

function createNetworkIdleWarning(pageDefinition: SelectorAuditPageDefinition): string {
  return `The ${pageDefinition.page} page did not reach network idle within ${DEFAULT_SELECTOR_AUDIT_NETWORK_IDLE_TIMEOUT_MS}ms. Selector checks continued with the current DOM state.`;
}

function createSelectorDefinitionFailureMessage(
  pageDefinition: SelectorAuditPageDefinition,
  selectorDefinition: SelectorAuditSelectorDefinition
): string {
  return `No selector strategy matched for ${selectorDefinition.key} on ${pageDefinition.page}. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit.`;
}

function createSelectorEvaluationError(
  pageDefinition: SelectorAuditPageDefinition,
  selectorDefinition: SelectorAuditSelectorDefinition,
  error: unknown
): LinkedInBuddyError {
  if (error instanceof LinkedInBuddyError) {
    return error;
  }

  const details = {
    page: pageDefinition.page,
    page_url: pageDefinition.url,
    selector_key: selectorDefinition.key
  };

  if (error instanceof playwrightErrors.TimeoutError) {
    return new LinkedInBuddyError(
      "TIMEOUT",
      `Timed out while checking ${selectorDefinition.key} on ${pageDefinition.page}. Review the selector registry and rerun the selector audit after the page is stable.`,
      details,
      createErrorOptions(error)
    );
  }

  return new LinkedInBuddyError(
    "UNKNOWN",
    `Selector audit failed while checking ${selectorDefinition.key} on ${pageDefinition.page}: ${getErrorMessage(error)}. Review the selector registry and rerun the selector audit.`,
    details,
    createErrorOptions(error)
  );
}

function createCandidateErrorMessage(
  candidate: SelectorAuditCandidate,
  timeoutMs: number,
  error: unknown
): string {
  if (error instanceof playwrightErrors.TimeoutError) {
    return `Timed out after ${timeoutMs}ms waiting for ${candidate.strategy} selector ${candidate.key} (${candidate.selectorHint}) to become visible. Confirm the page is loaded and authenticated, then rerun the selector audit.`;
  }

  return `Selector check failed for ${candidate.strategy} selector ${candidate.key} (${candidate.selectorHint}): ${getErrorMessage(error)}. Verify the page is fully loaded, or update the selector registry before rerunning the selector audit.`;
}

function createArtifactCaptureWarning(
  artifactKind: "screenshot" | "DOM snapshot" | "accessibility snapshot",
  pageDefinition: SelectorAuditPageDefinition,
  selectorDefinition: SelectorAuditSelectorDefinition,
  error: unknown
): string {
  return `Could not capture the ${artifactKind} for ${selectorDefinition.key} on ${pageDefinition.page}: ${getErrorMessage(error)}.`;
}

/**
 * Audits selector groups across core LinkedIn pages and emits a structured
 * report with pass/fail/fallback summaries plus failure artifacts.
 */
export class LinkedInSelectorAuditService {
  private readonly registry: SelectorAuditPageDefinition[];
  private readonly candidateTimeoutMs: number;
  private readonly pageReadyTimeoutMs: number;
  private readonly pageNavigationTimeoutMs: number;

  constructor(
    private readonly runtime: LinkedInSelectorAuditRuntime,
    options: LinkedInSelectorAuditServiceOptions = {}
  ) {
    this.registry = validateSelectorAuditRegistry(
      options.registry ??
        createDefaultSelectorAuditRegistry(
          this.runtime.selectorLocale ?? DEFAULT_LINKEDIN_SELECTOR_LOCALE
        )
    );
    this.candidateTimeoutMs = validateTimeoutOption(
      options.candidateTimeoutMs,
      "candidateTimeoutMs",
      DEFAULT_SELECTOR_AUDIT_CANDIDATE_TIMEOUT_MS
    );
    this.pageReadyTimeoutMs = validateTimeoutOption(
      options.pageReadyTimeoutMs,
      "pageReadyTimeoutMs",
      DEFAULT_SELECTOR_AUDIT_PAGE_READY_TIMEOUT_MS
    );
    this.pageNavigationTimeoutMs = validateTimeoutOption(
      options.pageNavigationTimeoutMs,
      "pageNavigationTimeoutMs",
      DEFAULT_SELECTOR_AUDIT_PAGE_NAVIGATION_TIMEOUT_MS
    );
  }

  /**
   * Runs the selector audit for one authenticated profile.
   *
   * The audit is read-only: it navigates across the configured pages, checks
   * each selector group in primary-to-tertiary order, captures artifacts only
   * for failures, writes a JSON report into the run artifact directory, and
   * returns the same report to the caller.
   */
  async auditSelectors(input: SelectorAuditInput = {}): Promise<SelectorAuditReport> {
    const normalizedInput = validateSelectorAuditInput(input);
    const profileName = validateProfileName(normalizedInput.profileName);
    const scope = validateSelectorAuditScope(normalizedInput.scope);
    const scopedRegistry = filterRegistryByScope(this.registry, scope);

    this.runtime.logger.log("info", "selector.audit.start", {
      profileName,
      pageCount: scopedRegistry.length,
      scope
    });

    await this.runtime.auth.ensureAuthenticated({ profileName });

    const results = await this.runtime.profileManager.runWithContext(
      {
        cdpUrl: this.runtime.cdpUrl,
        profileName,
        headless: true
      },
      async (context) => {
        let page: Page;
        try {
          page = await getOrCreatePage(context);
        } catch (error) {
          throw createPageOpenError(profileName, error);
        }

        const pageResults: SelectorAuditResult[] = [];

        for (const pageDefinition of scopedRegistry) {
          this.runtime.logger.log("info", "selector.audit.page.start", {
            profileName,
            page: pageDefinition.page,
            url: pageDefinition.url,
            selectorCount: pageDefinition.selectors.length
          });

          const currentPageResults = await this.auditPage(page, pageDefinition);
          pageResults.push(...currentPageResults);
          const counts = countSelectorAuditResults(currentPageResults);

          this.runtime.logger.log("info", "selector.audit.page.done", {
            profileName,
            page: pageDefinition.page,
            passCount: counts.passCount,
            failCount: counts.failCount,
            fallbackCount: counts.fallbackCount
          });
        }

        return pageResults;
      }
    );

    const artifactDir = this.runtime.artifacts.resolve(SELECTOR_AUDIT_ARTIFACT_DIR);
    const reportPath = this.runtime.artifacts.resolve(
      `${SELECTOR_AUDIT_ARTIFACT_DIR}/report.json`
    );
    const checkedAt = new Date().toISOString();
    const pageSummaries = this.buildPageSummaries(results, scopedRegistry);
    const counts = countSelectorAuditResults(results);
    const pageWarnings = buildPageWarningSummaries(
      scopedRegistry.map((pageDefinition) => pageDefinition.page),
      results
    );
    const failedSelectors = buildFailureSummaries(results);
    const fallbackSelectors = buildFallbackSummaries(results);
    const recommendedActions = buildRecommendedActions({
      profileName,
      reportPath,
      failedSelectors,
      fallbackSelectors,
      pageWarnings
    });
    const report: SelectorAuditReport = {
      run_id: this.runtime.runId,
      profile_name: profileName,
      checked_at: checkedAt,
      scope,
      outcome: createSelectorAuditOutcome(counts),
      summary: createSelectorAuditSummary(counts, scopedRegistry.length),
      total_count: counts.totalCount,
      pass_count: counts.passCount,
      fail_count: counts.failCount,
      fallback_count: counts.fallbackCount,
      read_total_count: counts.readTotalCount,
      read_pass_count: counts.readPassCount,
      read_fail_count: counts.readFailCount,
      write_total_count: counts.writeTotalCount,
      write_pass_count: counts.writePassCount,
      write_fail_count: counts.writeFailCount,
      artifact_dir: artifactDir,
      report_path: reportPath,
      page_summaries: pageSummaries,
      page_warnings: pageWarnings,
      failed_selectors: failedSelectors,
      fallback_selectors: fallbackSelectors,
      recommended_actions: recommendedActions,
      results
    };

    this.runtime.artifacts.writeJson(
      `${SELECTOR_AUDIT_ARTIFACT_DIR}/report.json`,
      report,
      {
        profile_name: profileName,
        checked_at: checkedAt,
        pass_count: report.pass_count,
        fail_count: report.fail_count,
        fallback_count: report.fallback_count
      }
    );

    this.runtime.logger.log("info", "selector.audit.done", {
      profileName,
      totalCount: report.total_count,
      passCount: report.pass_count,
      failCount: report.fail_count,
      fallbackCount: report.fallback_count,
      reportPath
    });

    return report;
  }

  private async auditPage(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition
  ): Promise<SelectorAuditResult[]> {
    const pageWarnings: string[] = [];

    try {
      await page.goto(pageDefinition.url, {
        waitUntil: "domcontentloaded",
        timeout: this.pageNavigationTimeoutMs
      });

      const networkIdleReached = await waitForNetworkIdleBestEffort(
        page,
        DEFAULT_SELECTOR_AUDIT_NETWORK_IDLE_TIMEOUT_MS
      );
      if (!networkIdleReached) {
        const warning = createNetworkIdleWarning(pageDefinition);
        pageWarnings.push(warning);
        this.runtime.logger.log("warn", "selector.audit.page.network_idle_timeout", {
          page: pageDefinition.page,
          url: pageDefinition.url,
          timeout_ms: DEFAULT_SELECTOR_AUDIT_NETWORK_IDLE_TIMEOUT_MS,
          warning
        });
      }

      const pageReadyFailures = await this.waitForPageReady(page, pageDefinition);
      if (pageReadyFailures !== null) {
        // Page-readiness is advisory instead of fatal so the audit can still
        // collect selector drift evidence from the current DOM state.
        const warning = createPageReadinessWarning(
          pageDefinition,
          this.pageReadyTimeoutMs,
          pageReadyFailures
        );
        pageWarnings.push(warning);
        this.runtime.logger.log("warn", "selector.audit.page.not_ready", {
          page: pageDefinition.page,
          url: pageDefinition.url,
          timeout_ms: this.pageReadyTimeoutMs,
          warning,
          ready_checks: createStrategyResults(pageReadyFailures)
        });
      }
    } catch (error) {
      const pageLoadError = createPageLoadError(
        pageDefinition,
        this.pageNavigationTimeoutMs,
        error
      );
      this.runtime.logger.log("warn", "selector.audit.page.failed", {
        page: pageDefinition.page,
        url: pageDefinition.url,
        code: pageLoadError.code,
        error: pageLoadError.message
      });

      const failedResults: SelectorAuditResult[] = [];
      for (const selectorDefinition of pageDefinition.selectors) {
        failedResults.push(
          await this.createFailedResult(
            page,
            pageDefinition,
            selectorDefinition,
            pageLoadError,
            pageWarnings
          )
        );
      }

      return failedResults;
    }

    const results: SelectorAuditResult[] = [];
    for (const selectorDefinition of pageDefinition.selectors) {
      try {
        results.push(
          await this.evaluateSelectorDefinition(
            page,
            pageDefinition,
            selectorDefinition,
            pageWarnings
          )
        );
      } catch (error) {
        const selectorError = createSelectorEvaluationError(
          pageDefinition,
          selectorDefinition,
          error
        );
        this.runtime.logger.log("warn", "selector.audit.selector.failed", {
          page: pageDefinition.page,
          selector_key: selectorDefinition.key,
          code: selectorError.code,
          error: selectorError.message
        });
        results.push(
          await this.createFailedResult(
            page,
            pageDefinition,
            selectorDefinition,
            selectorError,
            pageWarnings
          )
        );
      }
    }

    return results;
  }

  private async waitForPageReady(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition
  ): Promise<SelectorAuditStrategyResult[] | null> {
    const readyCandidates =
      pageDefinition.readyCandidates ?? pageDefinition.selectors[0]?.candidates ?? [];
    const readinessResults: SelectorAuditStrategyResult[] = [];

    for (const candidate of readyCandidates) {
      const result = await this.evaluateCandidate(
        page,
        candidate,
        this.pageReadyTimeoutMs
      );
      readinessResults.push(result);
      if (result.status === "pass") {
        return null;
      }
    }

    return readinessResults;
  }

  private async evaluateSelectorDefinition(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition,
    pageWarnings: readonly string[] = []
  ): Promise<SelectorAuditResult> {
    const strategyResults: SelectorAuditStrategyResult[] = [];

    for (const candidate of selectorDefinition.candidates) {
      strategyResults.push(await this.evaluateCandidate(page, candidate));
    }

    const matchedResult = strategyResults.find((result) => result.status === "pass") ?? null;
    const failureArtifacts =
      // Failure artifacts are intentionally captured only when every candidate
      // misses so successful audits stay lightweight and focused.
      matchedResult === null
        ? await this.captureFailureArtifacts(page, pageDefinition, selectorDefinition)
        : {};
    const warnings = pageWarnings.length > 0 ? [...pageWarnings] : undefined;

    return {
      page: pageDefinition.page,
      page_url: page.url(),
      selector_key: selectorDefinition.key,
      description: selectorDefinition.description,
      category: selectorDefinition.category,
      status: matchedResult ? "pass" : "fail",
      matched_strategy: matchedResult?.strategy ?? null,
      matched_selector_key: matchedResult?.selector_key ?? null,
      fallback_used:
        matchedResult && matchedResult.strategy !== "primary"
          ? matchedResult.selector_key
          : null,
      fallback_strategy:
        matchedResult && matchedResult.strategy !== "primary"
          ? matchedResult.strategy
          : null,
      strategies: createStrategyResults(strategyResults),
      failure_artifacts: failureArtifacts,
      ...(warnings ? { warnings } : {}),
      ...(matchedResult
        ? {}
        : {
            error: createSelectorDefinitionFailureMessage(pageDefinition, selectorDefinition)
          })
    };
  }

  private async evaluateCandidate(
    page: Page,
    candidate: SelectorAuditCandidate,
    timeoutMs: number = this.candidateTimeoutMs
  ): Promise<SelectorAuditStrategyResult> {
    try {
      const locator = candidate.locatorFactory(page);
      if (typeof locator.first !== "function") {
        throw new Error("Locator factory did not return a Playwright locator.");
      }

      const firstLocator = locator.first();
      if (typeof firstLocator.waitFor !== "function") {
        throw new Error("Locator factory did not return a Playwright locator.");
      }

      await firstLocator.waitFor({
        state: "visible",
        timeout: timeoutMs
      });

      return {
        strategy: candidate.strategy,
        status: "pass",
        selector_key: candidate.key,
        selector_hint: candidate.selectorHint
      };
    } catch (error) {
      return {
        strategy: candidate.strategy,
        status: "fail",
        selector_key: candidate.key,
        selector_hint: candidate.selectorHint,
        error: createCandidateErrorMessage(candidate, timeoutMs, error)
      };
    }
  }

  private async createFailedResult(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition,
    error: unknown,
    pageWarnings: readonly string[] = []
  ): Promise<SelectorAuditResult> {
    const errorMessage = getErrorMessage(error);
    const strategyResults = selectorDefinition.candidates.map((candidate) => ({
      strategy: candidate.strategy,
      status: "fail" as const,
      selector_key: candidate.key,
      selector_hint: candidate.selectorHint,
      error: errorMessage
    }));
    const warnings = pageWarnings.length > 0 ? [...pageWarnings] : undefined;

    const failureArtifacts = await this.captureFailureArtifacts(
      page,
      pageDefinition,
      selectorDefinition
    );

    return {
      page: pageDefinition.page,
      page_url: page.url(),
      selector_key: selectorDefinition.key,
      description: selectorDefinition.description,
      category: selectorDefinition.category,
      status: "fail",
      matched_strategy: null,
      matched_selector_key: null,
      fallback_used: null,
      fallback_strategy: null,
      strategies: createStrategyResults(strategyResults),
      failure_artifacts: failureArtifacts,
      ...(warnings ? { warnings } : {}),
      error: errorMessage
    };
  }

  private async captureFailureArtifacts(
    page: Page,
    pageDefinition: SelectorAuditPageDefinition,
    selectorDefinition: SelectorAuditSelectorDefinition
  ): Promise<SelectorAuditFailureArtifacts> {
    // Timestamped file names avoid collisions when the same selector key fails
    // multiple times during one run or across quick successive reruns.
    const prefix = path.join(
      SELECTOR_AUDIT_ARTIFACT_DIR,
      sanitizePathSegment(pageDefinition.page),
      `${sanitizePathSegment(selectorDefinition.key)}-${Date.now()}`
    );

    const screenshotPath = `${prefix}.png`;
    const domSnapshotPath = `${prefix}.html`;
    const accessibilitySnapshotPath = `${prefix}.a11y.json`;

    const failureArtifacts: SelectorAuditFailureArtifacts = {};
    const captureWarnings: string[] = [];

    try {
      const absoluteScreenshotPath = this.runtime.artifacts.resolve(screenshotPath);
      mkdirSync(path.dirname(absoluteScreenshotPath), { recursive: true });
      await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
      this.runtime.artifacts.registerArtifact(screenshotPath, "image/png", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_failure_screenshot"
      });
      failureArtifacts.screenshot_path = absoluteScreenshotPath;
    } catch (error) {
      const warning = createArtifactCaptureWarning(
        "screenshot",
        pageDefinition,
        selectorDefinition,
        error
      );
      captureWarnings.push(warning);
      this.runtime.logger.log("warn", "selector.audit.artifact.capture_failed", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "screenshot",
        warning
      });
    }

    try {
      const html = await page.content();
      this.runtime.artifacts.writeText(domSnapshotPath, html, "text/html", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_dom_snapshot"
      });
      failureArtifacts.dom_snapshot_path = this.runtime.artifacts.resolve(domSnapshotPath);
    } catch (error) {
      const warning = createArtifactCaptureWarning(
        "DOM snapshot",
        pageDefinition,
        selectorDefinition,
        error
      );
      captureWarnings.push(warning);
      this.runtime.logger.log("warn", "selector.audit.artifact.capture_failed", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "dom_snapshot",
        warning
      });
    }

    try {
      const accessibilitySnapshot = await getAccessibilitySnapshot(page);
      this.runtime.artifacts.writeJson(accessibilitySnapshotPath, accessibilitySnapshot, {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "selector_audit_accessibility_snapshot"
      });
      failureArtifacts.accessibility_snapshot_path = this.runtime.artifacts.resolve(
        accessibilitySnapshotPath
      );
    } catch (error) {
      const warning = createArtifactCaptureWarning(
        "accessibility snapshot",
        pageDefinition,
        selectorDefinition,
        error
      );
      captureWarnings.push(warning);
      this.runtime.logger.log("warn", "selector.audit.artifact.capture_failed", {
        page: pageDefinition.page,
        selector_key: selectorDefinition.key,
        artifact_kind: "accessibility_snapshot",
        warning
      });
    }

    if (captureWarnings.length > 0) {
      failureArtifacts.capture_warnings = captureWarnings;
    }

    return failureArtifacts;
  }

  private buildPageSummaries(
    results: SelectorAuditResult[],
    registry: SelectorAuditPageDefinition[]
  ): SelectorAuditPageSummary[] {
    const pageSummaries = new Map<LinkedInSelectorAuditPage, SelectorAuditPageSummary>(
      registry.map((pageDefinition) => [
        pageDefinition.page,
        createEmptyPageSummary(pageDefinition.page)
      ])
    );

    for (const result of results) {
      const summary = pageSummaries.get(result.page) ?? createEmptyPageSummary(result.page);
      summary.total_count += 1;
      summary.pass_count += result.status === "pass" ? 1 : 0;
      summary.fail_count += result.status === "fail" ? 1 : 0;
      summary.fallback_count += result.fallback_used !== null ? 1 : 0;
      if (result.category === "read") {
        summary.read_total_count += 1;
        summary.read_pass_count += result.status === "pass" ? 1 : 0;
        summary.read_fail_count += result.status === "fail" ? 1 : 0;
      } else {
        summary.write_total_count += 1;
        summary.write_pass_count += result.status === "pass" ? 1 : 0;
        summary.write_fail_count += result.status === "fail" ? 1 : 0;
      }
      pageSummaries.set(result.page, summary);
    }

    return [...pageSummaries.values()];
  }
}

/**
 * Returns a fresh copy of the built-in selector audit registry.
 *
 * Callers can inspect or clone this registry before passing a customized copy
 * to {@link LinkedInSelectorAuditServiceOptions.registry}.
 */
export function createLinkedInSelectorAuditRegistry(
  selectorLocale: LinkedInSelectorLocale = DEFAULT_LINKEDIN_SELECTOR_LOCALE
): SelectorAuditPageDefinition[] {
  return createDefaultSelectorAuditRegistry(selectorLocale);
}
