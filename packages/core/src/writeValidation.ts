import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page
} from "playwright-core";
import { ensureConfigPaths, resolveConfigPaths } from "./config.js";
import {
  LinkedInAssistantError,
  asLinkedInAssistantError,
  type LinkedInAssistantErrorCode
} from "./errors.js";
import {
  LIKE_POST_ACTION_TYPE,
  normalizeLinkedInFeedReaction,
  type LinkedInFeedReaction
} from "./linkedinFeed.js";
import {
  SEND_INVITATION_ACTION_TYPE,
  type LinkedInPendingInvitation
} from "./linkedinConnections.js";
import { FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE } from "./linkedinFollowups.js";
import {
  normalizeLinkedInProfileUrl,
  resolveProfileUrl
} from "./linkedinProfile.js";
import {
  CREATE_POST_ACTION_TYPE,
  normalizeLinkedInPostVisibility
} from "./linkedinPosts.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import { LinkedInAuthService, type SessionStatus } from "./auth/session.js";
import {
  inspectLinkedInSession,
  type LinkedInSessionInspection
} from "./auth/sessionInspection.js";
import {
  LinkedInSessionStore,
  type LinkedInBrowserStorageState
} from "./auth/sessionStore.js";
import {
  ProfileManager,
  type PersistentContextOptions
} from "./profileManager.js";
import { createCoreRuntime, type CoreRuntime } from "./runtime.js";
import type {
  ConfirmByTokenResult,
  PreparedActionResult
} from "./twoPhaseCommit.js";
import {
  resolveWriteValidationAccount,
  type WriteValidationAccount,
  type WriteValidationAccountTargets
} from "./writeValidationAccounts.js";

const SEND_MESSAGE_ACTION_TYPE = "send_message";
const WRITE_VALIDATION_WARNING = "This will perform REAL actions on LinkedIn.";
const WRITE_VALIDATION_REPORT_DIR = "live-write-validation";
const WRITE_VALIDATION_LATEST_REPORT_NAME = "latest-report.json";
const DEFAULT_WRITE_VALIDATION_COOLDOWN_MS = 10_000;
const DEFAULT_WRITE_VALIDATION_TIMEOUT_MS = 30_000;
const WRITE_VALIDATION_FEED_URL = "https://www.linkedin.com/feed/";

type WriteValidationRiskClass = "private" | "network" | "public";
export type LinkedInWriteValidationActionType =
  | typeof CREATE_POST_ACTION_TYPE
  | typeof SEND_INVITATION_ACTION_TYPE
  | typeof SEND_MESSAGE_ACTION_TYPE
  | typeof FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE
  | typeof LIKE_POST_ACTION_TYPE;

export type WriteValidationResultStatus = "pass" | "fail" | "cancelled";
export type WriteValidationOutcome = WriteValidationResultStatus;

export interface LinkedInWriteValidationActionDefinition {
  actionType: LinkedInWriteValidationActionType;
  expectedOutcome: string;
  riskClass: WriteValidationRiskClass;
  summary: string;
}

export const LINKEDIN_WRITE_VALIDATION_ACTIONS: readonly LinkedInWriteValidationActionDefinition[] = [
  {
    actionType: CREATE_POST_ACTION_TYPE,
    summary: "Create a connections-only post and verify it appears in the feed.",
    expectedOutcome: "A new post is published successfully and visible in the feed.",
    riskClass: "public"
  },
  {
    actionType: SEND_INVITATION_ACTION_TYPE,
    summary: "Send a connection invitation to the approved profile and verify it appears in sent invitations.",
    expectedOutcome:
      "The approved profile shows a pending invitation or sent-invitation confirmation.",
    riskClass: "network"
  },
  {
    actionType: SEND_MESSAGE_ACTION_TYPE,
    summary: "Send a message in the approved thread and verify the outbound message appears.",
    expectedOutcome:
      "The outbound message is echoed in the approved conversation thread.",
    riskClass: "private"
  },
  {
    actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    summary: "Send the approved follow-up after an accepted connection and verify it records as sent.",
    expectedOutcome:
      "The follow-up send succeeds and local follow-up state records the confirmation.",
    riskClass: "network"
  },
  {
    actionType: LIKE_POST_ACTION_TYPE,
    summary: "React to the approved post and verify the reaction is registered.",
    expectedOutcome: "The approved reaction is active on the approved post.",
    riskClass: "public"
  }
] as const;

export interface WriteValidationActionPreview {
  action_type: LinkedInWriteValidationActionType;
  expected_outcome: string;
  outbound: Record<string, unknown>;
  risk_class: WriteValidationRiskClass;
  summary: string;
  target: Record<string, unknown>;
}

export interface WriteValidationVerificationResult {
  details: Record<string, unknown>;
  message: string;
  source: string;
  state_synced: boolean | null;
  verified: boolean;
}

export interface WriteValidationActionResult {
  action_type: LinkedInWriteValidationActionType;
  after_screenshot_paths: string[];
  artifact_paths: string[];
  before_screenshot_paths: string[];
  cleanup_guidance: string[];
  completed_at: string;
  confirm_artifacts: string[];
  error_code?: LinkedInAssistantErrorCode;
  error_message?: string;
  expected_outcome: string;
  linkedin_response?: Record<string, unknown>;
  prepared_action_id?: string;
  preview?: WriteValidationActionPreview;
  risk_class: WriteValidationRiskClass;
  started_at: string;
  status: WriteValidationResultStatus;
  state_synced: boolean | null;
  summary: string;
  verification?: {
    details: Record<string, unknown>;
    message: string;
    source: string;
    verified: boolean;
  };
}

export interface WriteValidationReport {
  account: {
    designation: WriteValidationAccount["designation"];
    id: string;
    label: string;
    profile_name: string;
    session_name: string;
  };
  action_count: number;
  actions: WriteValidationActionResult[];
  audit_log_path: string;
  checked_at: string;
  cooldown_ms: number;
  fail_count: number;
  latest_report_path: string;
  outcome: WriteValidationOutcome;
  pass_count: number;
  cancelled_count: number;
  recommended_actions: string[];
  report_path: string;
  run_id: string;
  summary: string;
  warning: string;
}

export interface RunLinkedInWriteValidationOptions {
  accountId: string;
  baseDir?: string;
  cooldownMs?: number;
  interactive?: boolean;
  onBeforeAction?: (
    preview: WriteValidationActionPreview
  ) => Promise<boolean> | boolean;
  timeoutMs?: number;
}

interface ScenarioPrepareResult {
  beforeScreenshotUrl?: string;
  cleanupGuidance: string[];
  prepared: PreparedActionResult;
  verificationContext: Record<string, unknown>;
}

interface WriteValidationScenarioDefinition {
  actionType: LinkedInWriteValidationActionType;
  expectedOutcome: string;
  riskClass: WriteValidationRiskClass;
  summary: string;
  prepare: (
    runtime: CoreRuntime,
    account: WriteValidationAccount
  ) => Promise<ScenarioPrepareResult>;
  resolveAfterScreenshotUrl: (
    account: WriteValidationAccount,
    prepared: ScenarioPrepareResult,
    confirmed: ConfirmByTokenResult
  ) => string | null;
  verify: (
    runtime: CoreRuntime,
    account: WriteValidationAccount,
    prepared: ScenarioPrepareResult,
    confirmed: ConfirmByTokenResult
  ) => Promise<WriteValidationVerificationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function isTruthyCiValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

function createWriteValidationTag(): string {
  return new Date().toISOString();
}

function buildWriteValidationPostText(): string {
  return `Quick validation update • ${createWriteValidationTag()}`;
}

function buildWriteValidationMessageText(): string {
  return `Quick validation ping • ${createWriteValidationTag()}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isScreenshotPath(value: string): boolean {
  return /\.png$/iu.test(value.trim());
}

function readPreviewArtifacts(preview: Record<string, unknown>): string[] {
  const artifacts = preview.artifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts
    .map((artifact) => {
      if (!isRecord(artifact)) {
        return null;
      }

      const pathValue = artifact.path;
      return typeof pathValue === "string" ? pathValue : null;
    })
    .filter((artifactPath): artifactPath is string => typeof artifactPath === "string");
}

function assertInteractiveWriteValidation(options: RunLinkedInWriteValidationOptions): void {
  if (options.interactive === false) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Write validation requires an interactive terminal and a visible browser window."
    );
  }

  if (isTruthyCiValue(process.env.CI)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Write validation cannot run in CI. Run it manually from an interactive terminal."
    );
  }
}

export function validateWriteValidationOptions(
  options: RunLinkedInWriteValidationOptions
): Required<Pick<RunLinkedInWriteValidationOptions, "accountId">> & {
  cooldownMs: number;
  timeoutMs: number;
} {
  const accountId = normalizeText(options.accountId);
  if (!accountId) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "accountId is required for write validation."
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_WRITE_VALIDATION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "timeoutMs must be a positive integer."
    );
  }

  const cooldownMs =
    options.cooldownMs ?? DEFAULT_WRITE_VALIDATION_COOLDOWN_MS;
  if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "cooldownMs must be a non-negative integer."
    );
  }

  return {
    accountId,
    cooldownMs,
    timeoutMs
  };
}

function resolveThreadUrl(thread: string): string {
  const trimmedThread = thread.trim();
  if (!trimmedThread) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Thread identifier is required."
    );
  }

  if (/^https?:\/\//iu.test(trimmedThread)) {
    const parsedUrl = new URL(trimmedThread);
    return `${parsedUrl.origin}${parsedUrl.pathname}${parsedUrl.search}`.replace(
      /\/$/u,
      "/"
    );
  }

  if (trimmedThread.startsWith("/messaging/thread/")) {
    return `https://www.linkedin.com${trimmedThread}`;
  }

  return `https://www.linkedin.com/messaging/thread/${encodeURIComponent(trimmedThread)}/`;
}

function getRequiredTarget<T>(
  targets: WriteValidationAccountTargets,
  actionType: keyof WriteValidationAccountTargets,
  accountId: string
): T {
  const target = targets[actionType];
  if (target !== undefined) {
    return target as T;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `Write-validation account "${accountId}" is missing targets.${String(actionType)} in config.json.`,
    {
      account_id: accountId,
      missing_target_key: actionType
    }
  );
}

function matchPendingInvitation(
  invitations: LinkedInPendingInvitation[],
  targetProfile: string
): LinkedInPendingInvitation | null {
  const normalizedTargetProfile = normalizeLinkedInProfileUrl(
    resolveProfileUrl(targetProfile)
  );
  const targetSlug = /\/in\/([^/?#]+)/u.exec(normalizedTargetProfile)?.[1] ?? null;

  for (const invitation of invitations) {
    const normalizedInvitationProfile = normalizeLinkedInProfileUrl(
      resolveProfileUrl(invitation.profile_url)
    );

    if (normalizedInvitationProfile === normalizedTargetProfile) {
      return invitation;
    }

    if (
      targetSlug !== null &&
      typeof invitation.vanity_name === "string" &&
      invitation.vanity_name.trim().toLowerCase() === targetSlug.toLowerCase()
    ) {
      return invitation;
    }
  }

  return null;
}

function extractRecentMessageText(messages: readonly { text: string }[]): string | null {
  const lastMessage = [...messages]
    .reverse()
    .find((message) => normalizeText(message.text).length > 0);
  return lastMessage ? normalizeText(lastMessage.text) : null;
}

function buildWriteValidationSummary(report: Pick<WriteValidationReport, "action_count" | "pass_count" | "fail_count" | "cancelled_count" | "outcome">): string {
  const parts = [
    `Checked ${report.action_count} write-validation actions.`,
    `${report.pass_count} passed.`,
    `${report.fail_count} failed.`,
    `${report.cancelled_count} cancelled.`
  ];
  return `${parts.join(" ")} Overall outcome: ${report.outcome}.`;
}

function buildRecommendedActions(report: Pick<WriteValidationReport, "actions" | "report_path" | "audit_log_path">): string[] {
  const actions: string[] = [
    `Review ${report.report_path} for the full per-action report and screenshots.`,
    `Open ${report.audit_log_path} to inspect the structured audit log for this run.`
  ];

  for (const action of report.actions) {
    actions.push(...action.cleanup_guidance);
    if (action.status === "fail") {
      actions.push(
        `Re-check ${action.action_type} after reviewing ${report.report_path} and the attached screenshots.`
      );
    }
  }

  return dedupeStrings(actions);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }

  return context.newPage();
}

class StoredSessionProfileManager extends ProfileManager {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    paths: ReturnType<typeof resolveConfigPaths>,
    private readonly storageState: LinkedInBrowserStorageState,
    private readonly timeoutMs: number,
    private readonly runtime: CoreRuntime
  ) {
    super(paths);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    if (this.browserPromise) {
      return this.browserPromise;
    }

    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    this.browserPromise = chromium
      .launch({
        headless: false,
        ...(executablePath ? { executablePath } : {})
      })
      .then((browser) => {
        this.browser = browser;
        return browser;
      });

    return this.browserPromise;
  }

  override async runWithPersistentContext<T>(
    profileName: string,
    options: PersistentContextOptions,
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    void profileName;
    void options;
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      storageState: this.storageState
    });

    context.setDefaultNavigationTimeout(this.timeoutMs);
    context.setDefaultTimeout(this.timeoutMs);

    try {
      return await callback(context);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  override async runWithCDP<T>(
    cdpUrl: string,
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    void cdpUrl;
    void callback;
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Stored-session write validation does not support CDP or external browser attachment."
    );
  }

  override async runWithCDPResilient<T>(
    cdpUrl: string,
    callback: (context: BrowserContext) => Promise<T>,
    options?: { maxRetries?: number; retryDelayMs?: number }
  ): Promise<T> {
    void cdpUrl;
    void callback;
    void options;
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Stored-session write validation does not support CDP or external browser attachment."
    );
  }

  override async runWithContext<T>(
    options: { cdpUrl?: string | undefined; profileName: string; headless?: boolean },
    callback: (context: BrowserContext) => Promise<T>
  ): Promise<T> {
    if (options.cdpUrl) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Stored-session write validation does not support CDP or external browser attachment."
      );
    }

    return this.runWithPersistentContext(options.profileName, { headless: false }, callback);
  }

  async inspectSession(): Promise<LinkedInSessionInspection> {
    return this.runWithPersistentContext(
      "session-inspection",
      { headless: false },
      async (context) => {
        const page = await getOrCreatePage(context);
        await page.goto(WRITE_VALIDATION_FEED_URL, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page, this.timeoutMs);
        return inspectLinkedInSession(page, {
          selectorLocale: this.runtime.selectorLocale
        });
      }
    );
  }

  async capturePageScreenshot(input: {
    actionType: LinkedInWriteValidationActionType;
    stage: "before" | "after";
    url: string;
  }): Promise<string> {
    const relativePath = `${WRITE_VALIDATION_REPORT_DIR}/${slugifyActionType(input.actionType)}-${input.stage}-${Date.now()}.png`;

    await this.runWithPersistentContext(
      `screenshot-${input.stage}`,
      { headless: false },
      async (context) => {
        const page = await getOrCreatePage(context);
        await page.goto(input.url, {
          waitUntil: "domcontentloaded"
        });
        await waitForNetworkIdleBestEffort(page, this.timeoutMs);
        const absolutePath = this.runtime.artifacts.resolve(relativePath);
        await page.screenshot({ fullPage: true, path: absolutePath });
      }
    );

    this.runtime.artifacts.registerArtifact(relativePath, "image/png", {
      action: input.actionType,
      capture_stage: input.stage,
      capture_url: input.url
    });

    return relativePath;
  }

  async dispose(): Promise<void> {
    this.browserPromise = null;
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

class StoredSessionAuthService extends LinkedInAuthService {
  constructor(
    profileManager: ProfileManager,
    private readonly sessionStatus: SessionStatus
  ) {
    super(profileManager, undefined);
  }

  override async status(): Promise<SessionStatus> {
    return {
      ...this.sessionStatus,
      checkedAt: new Date().toISOString()
    };
  }

  override async ensureAuthenticated(): Promise<SessionStatus> {
    if (!this.sessionStatus.authenticated) {
      throw new LinkedInAssistantError(
        this.sessionStatus.currentUrl.includes("/checkpoint")
          ? "CAPTCHA_OR_CHALLENGE"
          : "AUTH_REQUIRED",
        this.sessionStatus.reason,
        {
          checked_at: this.sessionStatus.checkedAt,
          current_url: this.sessionStatus.currentUrl
        }
      );
    }

    return {
      ...this.sessionStatus,
      checkedAt: new Date().toISOString()
    };
  }
}

function slugifyActionType(actionType: string): string {
  return actionType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "action";
}

const WRITE_VALIDATION_SCENARIOS: Record<
  LinkedInWriteValidationActionType,
  WriteValidationScenarioDefinition
> = {
  [CREATE_POST_ACTION_TYPE]: {
    actionType: CREATE_POST_ACTION_TYPE,
    summary:
      "Create a connections-only post and verify it appears in the feed.",
    expectedOutcome:
      "A new post is published successfully and visible in the feed.",
    riskClass: "public",
    async prepare(runtime, account) {
      const visibility = normalizeLinkedInPostVisibility(
        account.targets["post.create"]?.visibility,
        "connections"
      );
      const text = buildWriteValidationPostText();
      const prepared = await runtime.posts.prepareCreate({
        profileName: account.profileName,
        text,
        visibility,
        operatorNote: "Tier 3 write-validation harness"
      });

      return {
        prepared,
        beforeScreenshotUrl: WRITE_VALIDATION_FEED_URL,
        cleanupGuidance: [
          "Delete the validation post manually after review if you do not want it to remain in the feed."
        ],
        verificationContext: {
          post_text: text,
          visibility
        }
      };
    },
    resolveAfterScreenshotUrl(_account, _prepared, confirmed) {
      const publishedPostUrl = confirmed.result.published_post_url;
      return typeof publishedPostUrl === "string" ? publishedPostUrl : WRITE_VALIDATION_FEED_URL;
    },
    async verify(runtime, account, prepared, confirmed) {
      const publishedPostUrl = confirmed.result.published_post_url;
      const expectedText =
        typeof prepared.verificationContext.post_text === "string"
          ? prepared.verificationContext.post_text
          : "";

      if (typeof publishedPostUrl !== "string") {
        return {
          verified: false,
          state_synced: null,
          source: "post_publish_result",
          message: "Post publish result did not include a published_post_url.",
          details: {
            result: confirmed.result
          }
        };
      }

      const post = await runtime.feed.viewPost({
        profileName: account.profileName,
        postUrl: publishedPostUrl
      });

      const verified = normalizeText(post.text).includes(normalizeText(expectedText));

      return {
        verified,
        state_synced: null,
        source: "feed.viewPost",
        message: verified
          ? "Published post was re-observed in LinkedIn feed content."
          : "Published post could not be matched by text in the feed after confirmation.",
        details: {
          post_url: publishedPostUrl,
          observed_text: post.text
        }
      };
    }
  },
  [SEND_INVITATION_ACTION_TYPE]: {
    actionType: SEND_INVITATION_ACTION_TYPE,
    summary:
      "Send a connection invitation to the approved profile and verify it appears in sent invitations.",
    expectedOutcome:
      "The approved profile shows a pending invitation or sent-invitation confirmation.",
    riskClass: "network",
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        note?: string;
        targetProfile: string;
      }>(
        account.targets,
        "connections.send_invitation",
        account.id
      );

      const prepared = runtime.connections.prepareSendInvitation({
        profileName: account.profileName,
        targetProfile: target.targetProfile,
        ...(target.note ? { note: target.note } : {}),
        operatorNote: "Tier 3 write-validation harness"
      });

      return {
        prepared,
        beforeScreenshotUrl: resolveProfileUrl(target.targetProfile),
        cleanupGuidance: [
          "Withdraw the validation invitation manually after review if the recipient should not keep it pending."
        ],
        verificationContext: {
          target_profile: target.targetProfile
        }
      };
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const targetProfile = prepared.verificationContext.target_profile;
      return typeof targetProfile === "string"
        ? resolveProfileUrl(targetProfile)
        : null;
    },
    async verify(runtime, account, prepared) {
      const targetProfile = prepared.verificationContext.target_profile;
      if (typeof targetProfile !== "string") {
        return {
          verified: false,
          state_synced: false,
          source: "connections.listPendingInvitations",
          message: "Connection target profile was missing from the verification context.",
          details: {}
        };
      }

      const invitations = await runtime.connections.listPendingInvitations({
        profileName: account.profileName,
        filter: "sent"
      });
      const matchedInvitation = matchPendingInvitation(invitations, targetProfile);
      const stateRow = runtime.db.getSentInvitationState({
        profileName: account.profileName,
        profileUrlKey: normalizeLinkedInProfileUrl(resolveProfileUrl(targetProfile))
      });

      return {
        verified: matchedInvitation !== null,
        state_synced: stateRow !== undefined,
        source: "connections.listPendingInvitations",
        message:
          matchedInvitation !== null
            ? "Sent invitation was re-observed in the pending sent-invitations list."
            : "Sent invitation could not be re-observed in the pending sent-invitations list.",
        details: {
          target_profile: targetProfile,
          matched_invitation: matchedInvitation,
          state_synced: stateRow !== undefined
        }
      };
    }
  },
  [SEND_MESSAGE_ACTION_TYPE]: {
    actionType: SEND_MESSAGE_ACTION_TYPE,
    summary:
      "Send a message in the approved thread and verify the outbound message appears.",
    expectedOutcome:
      "The outbound message is echoed in the approved conversation thread.",
    riskClass: "private",
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        participantPattern?: string;
        thread: string;
      }>(account.targets, "send_message", account.id);
      const text = buildWriteValidationMessageText();

      const prepared = await runtime.inbox.prepareReply({
        profileName: account.profileName,
        thread: target.thread,
        text,
        operatorNote: "Tier 3 write-validation harness"
      });

      return {
        prepared,
        beforeScreenshotUrl: resolveThreadUrl(target.thread),
        cleanupGuidance: [],
        verificationContext: {
          message_text: text,
          participant_pattern: target.participantPattern,
          thread: target.thread
        }
      };
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const thread = prepared.verificationContext.thread;
      return typeof thread === "string" ? resolveThreadUrl(thread) : null;
    },
    async verify(runtime, account, prepared) {
      const expectedText = prepared.verificationContext.message_text;
      const thread = prepared.verificationContext.thread;

      if (typeof expectedText !== "string" || typeof thread !== "string") {
        return {
          verified: false,
          state_synced: null,
          source: "inbox.getThread",
          message: "Message verification context was incomplete.",
          details: {}
        };
      }

      const detail = await runtime.inbox.getThread({
        profileName: account.profileName,
        thread,
        limit: 8
      });
      const recentMessageText = extractRecentMessageText(detail.messages);
      const verified = recentMessageText === normalizeText(expectedText);

      return {
        verified,
        state_synced: null,
        source: "inbox.getThread",
        message: verified
          ? "Sent message was re-observed in the approved conversation thread."
          : "Sent message was not found as the most recent thread message after confirmation.",
        details: {
          thread_id: detail.thread_id,
          recent_message_text: recentMessageText,
          expected_text: expectedText
        }
      };
    }
  },
  [FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE]: {
    actionType: FOLLOWUP_AFTER_ACCEPT_ACTION_TYPE,
    summary:
      "Send the approved follow-up after an accepted connection and verify it records as sent.",
    expectedOutcome:
      "The follow-up send succeeds and local follow-up state records the confirmation.",
    riskClass: "network",
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        profileUrlKey: string;
      }>(account.targets, "network.followup_after_accept", account.id);

      const preparedFollowup = await runtime.followups.prepareFollowupForAcceptedConnection({
        profileName: account.profileName,
        profileUrlKey: target.profileUrlKey,
        refreshState: true,
        operatorNote: "Tier 3 write-validation harness"
      });

      if (!preparedFollowup) {
        throw new LinkedInAssistantError(
          "ACTION_PRECONDITION_FAILED",
          `No accepted connection follow-up could be prepared for ${target.profileUrlKey}.`,
          {
            account_id: account.id,
            profile_name: account.profileName,
            profile_url_key: target.profileUrlKey
          }
        );
      }

      return {
        prepared: {
          preparedActionId: preparedFollowup.preparedActionId,
          confirmToken: preparedFollowup.confirmToken,
          expiresAtMs: preparedFollowup.expiresAtMs,
          preview: preparedFollowup.preview
        },
        beforeScreenshotUrl: resolveProfileUrl(target.profileUrlKey),
        cleanupGuidance: [],
        verificationContext: {
          profile_url_key: target.profileUrlKey
        }
      };
    },
    resolveAfterScreenshotUrl(_account, prepared, confirmed) {
      const profileUrl = confirmed.result.profile_url;
      if (typeof profileUrl === "string") {
        return resolveProfileUrl(profileUrl);
      }

      const profileUrlKey = prepared.verificationContext.profile_url_key;
      return typeof profileUrlKey === "string"
        ? resolveProfileUrl(profileUrlKey)
        : null;
    },
    async verify(runtime, account, prepared, confirmed) {
      const profileUrlKey = prepared.verificationContext.profile_url_key;
      if (typeof profileUrlKey !== "string") {
        return {
          verified: false,
          state_synced: false,
          source: "followups.confirm_result",
          message: "Follow-up verification context was incomplete.",
          details: {}
        };
      }

      const stateRow = runtime.db.getSentInvitationState({
        profileName: account.profileName,
        profileUrlKey
      });

      return {
        verified: confirmed.result.sent === true,
        state_synced: stateRow?.followup_confirmed_at !== null,
        source: "followups.confirm_result",
        message:
          confirmed.result.sent === true
            ? "Follow-up send returned a positive message-echo confirmation."
            : "Follow-up send did not report a positive message-echo confirmation.",
        details: {
          profile_url_key: profileUrlKey,
          followup_confirmed_at: stateRow?.followup_confirmed_at ?? null,
          confirm_result: confirmed.result
        }
      };
    }
  },
  [LIKE_POST_ACTION_TYPE]: {
    actionType: LIKE_POST_ACTION_TYPE,
    summary:
      "React to the approved post and verify the reaction is registered.",
    expectedOutcome: "The approved reaction is active on the approved post.",
    riskClass: "public",
    async prepare(runtime, account) {
      const target = getRequiredTarget<{
        postUrl: string;
        reaction?: LinkedInFeedReaction;
      }>(account.targets, "feed.like_post", account.id);
      const reaction = normalizeLinkedInFeedReaction(target.reaction, "like");

      const prepared = runtime.feed.prepareLikePost({
        profileName: account.profileName,
        postUrl: target.postUrl,
        reaction,
        operatorNote: "Tier 3 write-validation harness"
      });

      return {
        prepared,
        beforeScreenshotUrl: target.postUrl,
        cleanupGuidance: [
          "Remove the validation reaction manually after review if you do not want it to remain on the post."
        ],
        verificationContext: {
          post_url: target.postUrl,
          reaction
        }
      };
    },
    resolveAfterScreenshotUrl(_account, prepared) {
      const postUrl = prepared.verificationContext.post_url;
      return typeof postUrl === "string" ? postUrl : null;
    },
    async verify(_runtime, _account, _prepared, confirmed) {
      const reaction = confirmed.result.reaction;
      const verified = confirmed.result.reacted === true;

      return {
        verified,
        state_synced: null,
        source: "feed.like_post.confirm_result",
        message: verified
          ? "Reaction executor reported the target reaction as active after confirmation."
          : "Reaction executor did not report the target reaction as active after confirmation.",
        details: {
          confirm_result: confirmed.result,
          reaction
        }
      };
    }
  }
};

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toSessionStatus(inspection: LinkedInSessionInspection): SessionStatus {
  return {
    authenticated: inspection.authenticated,
    checkedAt: inspection.checkedAt,
    currentUrl: inspection.currentUrl,
    reason: inspection.reason
  };
}

function buildPreview(
  scenario: WriteValidationScenarioDefinition,
  prepared: PreparedActionResult
): WriteValidationActionPreview {
  const target = isRecord(prepared.preview.target) ? prepared.preview.target : {};
  const outbound = isRecord(prepared.preview.outbound)
    ? prepared.preview.outbound
    : {};

  return {
    action_type: scenario.actionType,
    expected_outcome: scenario.expectedOutcome,
    outbound,
    risk_class: scenario.riskClass,
    summary: scenario.summary,
    target
  };
}

function determineActionStatus(verification: WriteValidationVerificationResult): WriteValidationResultStatus {
  if (!verification.verified) {
    return "fail";
  }

  if (verification.state_synced === false) {
    return "fail";
  }

  return "pass";
}

async function createWriteValidationRuntime(input: {
  account: WriteValidationAccount;
  baseDir?: string;
  timeoutMs: number;
}): Promise<{
  profileManager: StoredSessionProfileManager;
  runtime: CoreRuntime;
}> {
  const runtime = createCoreRuntime(
    input.baseDir
      ? {
          baseDir: input.baseDir
        }
      : {}
  );
  const store = new LinkedInSessionStore(input.baseDir);
  const loadedSession = await store.load(input.account.sessionName);
  const profileManager = new StoredSessionProfileManager(
    runtime.paths,
    loadedSession.storageState,
    input.timeoutMs,
    runtime
  );
  const inspection = await profileManager.inspectSession();

  if (!inspection.authenticated) {
    throw new LinkedInAssistantError(
      inspection.currentUrl.includes("/checkpoint")
        ? "CAPTCHA_OR_CHALLENGE"
        : "AUTH_REQUIRED",
      inspection.reason,
      {
        checked_at: inspection.checkedAt,
        current_url: inspection.currentUrl,
        session_name: input.account.sessionName
      }
    );
  }

  runtime.profileManager = profileManager;
  runtime.auth = new StoredSessionAuthService(
    profileManager,
    toSessionStatus(inspection)
  );

  return {
    runtime,
    profileManager
  };
}

function countActionStatuses(actions: readonly WriteValidationActionResult[]): {
  cancelledCount: number;
  failCount: number;
  passCount: number;
} {
  return actions.reduce(
    (counts, action) => {
      if (action.status === "pass") {
        counts.passCount += 1;
      } else if (action.status === "fail") {
        counts.failCount += 1;
      } else {
        counts.cancelledCount += 1;
      }
      return counts;
    },
    {
      cancelledCount: 0,
      failCount: 0,
      passCount: 0
    }
  );
}

function determineOutcome(actions: readonly WriteValidationActionResult[]): WriteValidationOutcome {
  if (actions.some((action) => action.status === "fail")) {
    return "fail";
  }

  if (actions.some((action) => action.status === "cancelled")) {
    return "cancelled";
  }

  return "pass";
}

export async function runLinkedInWriteValidation(
  options: RunLinkedInWriteValidationOptions
): Promise<WriteValidationReport> {
  assertInteractiveWriteValidation(options);
  const validatedOptions = validateWriteValidationOptions(options);
  const account = resolveWriteValidationAccount(
    validatedOptions.accountId,
    options.baseDir
  );

  if (account.designation !== "secondary") {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Write validation can run only against a registered secondary account. Account "${account.id}" is marked as ${account.designation}.`,
      {
        account_id: account.id,
        designation: account.designation
      }
    );
  }

  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);

  const { runtime, profileManager } = await createWriteValidationRuntime({
    account,
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    timeoutMs: validatedOptions.timeoutMs
  });

  const latestReportPath = path.join(
    paths.baseDir,
    WRITE_VALIDATION_REPORT_DIR,
    account.id,
    WRITE_VALIDATION_LATEST_REPORT_NAME
  );

  runtime.logger.log("info", "write_validation.start", {
    account_id: account.id,
    cooldown_ms: validatedOptions.cooldownMs,
    profile_name: account.profileName,
    session_name: account.sessionName,
    warning: WRITE_VALIDATION_WARNING
  });

  const actions: WriteValidationActionResult[] = [];

  try {
    for (const scenario of LINKEDIN_WRITE_VALIDATION_ACTIONS) {
      const startedAt = new Date().toISOString();

      runtime.logger.log("info", "write_validation.action.start", {
        account_id: account.id,
        action_type: scenario.actionType
      });

      try {
        const scenarioDefinition = WRITE_VALIDATION_SCENARIOS[scenario.actionType];
        const prepared = await scenarioDefinition.prepare(runtime, account);
        const preview = buildPreview(scenarioDefinition, prepared.prepared);

        runtime.logger.log("info", "write_validation.action.prepared", {
          account_id: account.id,
          action_type: scenario.actionType,
          prepared_action_id: prepared.prepared.preparedActionId,
          preview
        });

        const proceed = options.onBeforeAction
          ? await options.onBeforeAction(preview)
          : true;

        if (!proceed) {
          runtime.logger.log("warn", "write_validation.action.cancelled", {
            account_id: account.id,
            action_type: scenario.actionType,
            prepared_action_id: prepared.prepared.preparedActionId
          });

          actions.push({
            action_type: scenario.actionType,
            after_screenshot_paths: [],
            artifact_paths: dedupeStrings(readPreviewArtifacts(prepared.prepared.preview)),
            before_screenshot_paths: readPreviewArtifacts(prepared.prepared.preview).filter(
              isScreenshotPath
            ),
            cleanup_guidance: prepared.cleanupGuidance,
            completed_at: new Date().toISOString(),
            confirm_artifacts: [],
            expected_outcome: scenario.expectedOutcome,
            prepared_action_id: prepared.prepared.preparedActionId,
            preview,
            risk_class: scenario.riskClass,
            started_at: startedAt,
            state_synced: null,
            status: "cancelled",
            summary: scenario.summary
          });
          continue;
        }

        const previewArtifacts = readPreviewArtifacts(prepared.prepared.preview);
        const beforeScreenshotPaths = previewArtifacts.filter(isScreenshotPath);

        if (
          beforeScreenshotPaths.length === 0 &&
          typeof prepared.beforeScreenshotUrl === "string"
        ) {
          beforeScreenshotPaths.push(
            await profileManager.capturePageScreenshot({
              actionType: scenario.actionType,
              stage: "before",
              url: prepared.beforeScreenshotUrl
            })
          );
        }

        const confirmed = await runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.prepared.confirmToken
        });

        const confirmArtifacts = [...confirmed.artifacts];
        const afterScreenshotPaths = confirmArtifacts.filter(isScreenshotPath);
        const afterScreenshotUrl = scenarioDefinition.resolveAfterScreenshotUrl(
          account,
          prepared,
          confirmed
        );

        if (afterScreenshotPaths.length === 0 && typeof afterScreenshotUrl === "string") {
          afterScreenshotPaths.push(
            await profileManager.capturePageScreenshot({
              actionType: scenario.actionType,
              stage: "after",
              url: afterScreenshotUrl
            })
          );
        }

        const verification = await scenarioDefinition.verify(
          runtime,
          account,
          prepared,
          confirmed
        );
        const status = determineActionStatus(verification);
        const artifactPaths = dedupeStrings([
          ...previewArtifacts,
          ...beforeScreenshotPaths,
          ...confirmArtifacts,
          ...afterScreenshotPaths
        ]);

        runtime.logger.log(
          status === "pass" ? "info" : "warn",
          "write_validation.action.completed",
          {
            account_id: account.id,
            action_type: scenario.actionType,
            prepared_action_id: prepared.prepared.preparedActionId,
            verified: verification.verified,
            state_synced: verification.state_synced,
            status
          }
        );

        actions.push({
          action_type: scenario.actionType,
          after_screenshot_paths: dedupeStrings(afterScreenshotPaths),
          artifact_paths: artifactPaths,
          before_screenshot_paths: dedupeStrings(beforeScreenshotPaths),
          cleanup_guidance: prepared.cleanupGuidance,
          completed_at: new Date().toISOString(),
          confirm_artifacts: dedupeStrings(confirmArtifacts),
          expected_outcome: scenario.expectedOutcome,
          linkedin_response: confirmed.result,
          prepared_action_id: prepared.prepared.preparedActionId,
          preview,
          risk_class: scenario.riskClass,
          started_at: startedAt,
          state_synced: verification.state_synced,
          status,
          summary: scenario.summary,
          verification: {
            details: verification.details,
            message: verification.message,
            source: verification.source,
            verified: verification.verified
          }
        });
      } catch (error) {
        const normalizedError = asLinkedInAssistantError(
          error,
          error instanceof LinkedInAssistantError ? error.code : "UNKNOWN",
          `Write validation failed while executing ${scenario.actionType}.`
        );

        runtime.logger.log("error", "write_validation.action.failed", {
          account_id: account.id,
          action_type: scenario.actionType,
          code: normalizedError.code,
          error_message: normalizedError.message,
          error_details: normalizedError.details
        });

        actions.push({
          action_type: scenario.actionType,
          after_screenshot_paths: [],
          artifact_paths: [],
          before_screenshot_paths: [],
          cleanup_guidance: [],
          completed_at: new Date().toISOString(),
          confirm_artifacts: [],
          error_code: normalizedError.code,
          error_message: normalizedError.message,
          expected_outcome: scenario.expectedOutcome,
          risk_class: scenario.riskClass,
          started_at: startedAt,
          state_synced: null,
          status: "fail",
          summary: scenario.summary
        });
      }

      if (validatedOptions.cooldownMs > 0 && scenario !== LINKEDIN_WRITE_VALIDATION_ACTIONS.at(-1)) {
        runtime.logger.log("info", "write_validation.cooldown.start", {
          account_id: account.id,
          cooldown_ms: validatedOptions.cooldownMs
        });
        await sleep(validatedOptions.cooldownMs);
      }
    }

    const counts = countActionStatuses(actions);
    const outcome = determineOutcome(actions);
    const reportPath = runtime.artifacts.writeJson(
      `${WRITE_VALIDATION_REPORT_DIR}/report.json`,
      {
        account: {
          designation: account.designation,
          id: account.id,
          label: account.label,
          profile_name: account.profileName,
          session_name: account.sessionName
        },
        action_count: actions.length,
        actions,
        audit_log_path: runtime.logger.getEventsPath(),
        checked_at: new Date().toISOString(),
        cooldown_ms: validatedOptions.cooldownMs,
        fail_count: counts.failCount,
        latest_report_path: latestReportPath,
        outcome,
        pass_count: counts.passCount,
        cancelled_count: counts.cancelledCount,
        report_path: runtime.artifacts.resolve(`${WRITE_VALIDATION_REPORT_DIR}/report.json`),
        run_id: runtime.runId,
        summary: buildWriteValidationSummary({
          action_count: actions.length,
          cancelled_count: counts.cancelledCount,
          fail_count: counts.failCount,
          outcome,
          pass_count: counts.passCount
        }),
        warning: WRITE_VALIDATION_WARNING
      },
      {
        account_id: account.id,
        action_count: actions.length,
        outcome
      }
    );

    const report: WriteValidationReport = {
      account: {
        designation: account.designation,
        id: account.id,
        label: account.label,
        profile_name: account.profileName,
        session_name: account.sessionName
      },
      action_count: actions.length,
      actions,
      audit_log_path: runtime.logger.getEventsPath(),
      checked_at: new Date().toISOString(),
      cooldown_ms: validatedOptions.cooldownMs,
      fail_count: counts.failCount,
      latest_report_path: latestReportPath,
      outcome,
      pass_count: counts.passCount,
      cancelled_count: counts.cancelledCount,
      recommended_actions: [],
      report_path: reportPath,
      run_id: runtime.runId,
      summary: buildWriteValidationSummary({
        action_count: actions.length,
        cancelled_count: counts.cancelledCount,
        fail_count: counts.failCount,
        outcome,
        pass_count: counts.passCount
      }),
      warning: WRITE_VALIDATION_WARNING
    };

    report.recommended_actions = buildRecommendedActions(report);

    await writeJsonFile(latestReportPath, report);

    runtime.logger.log("info", "write_validation.completed", {
      account_id: account.id,
      action_count: actions.length,
      fail_count: counts.failCount,
      outcome,
      pass_count: counts.passCount,
      cancelled_count: counts.cancelledCount,
      report_path: report.report_path
    });

    return report;
  } finally {
    await profileManager.dispose();
    runtime.close();
  }
}

export function getWriteValidationActionDefinitions(): readonly LinkedInWriteValidationActionDefinition[] {
  return LINKEDIN_WRITE_VALIDATION_ACTIONS;
}
