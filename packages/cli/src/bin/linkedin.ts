#!/usr/bin/env node
import type { Dirent } from "node:fs";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import {
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_WATCH_KINDS,
  ACTIVITY_WATCH_STATUSES,
  DEFAULT_FOLLOWUP_SINCE,
  DEFAULT_FEEDBACK_HINT_EVERY_N,
  LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV,
  LINKEDIN_BUDDY_EVASION_LEVEL_ENV,
  LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV,
  AssistantDatabase,
  alignToBusinessHours,
  asLinkedInBuddyError,
  computeEffectiveStatus,
  exportSessionState,
  hasLinkedInSessionToken,
  importSessionState,
  buildFeedbackHintMessage,
  clearRateLimitState,
  createLocalDataDeletionPlan,
  createEmptyFixtureManifest,
  createFeedbackTechnicalContext,
  buildFixtureRouteKey,
  buildLinkedInImagePersonaFromProfileSeed,
  evaluateDraftQuality,
  FEEDBACK_TYPES,
  formatFeedbackDisplayPath,
  getAuthWhoami,
  getLinkedInSelectorLocaleConfigWarning,
  isPreparedActionEffectiveStatus,
  isSearchCategory,
  isInRateLimitCooldown,
  isLinkedInFixtureReplayUrl,
  LINKEDIN_REPLAY_PAGE_TYPES,
  FIXTURE_REPLAY_ENV_KEYS,
  LINKEDIN_FEED_REACTION_TYPES,
  LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION,
  LINKEDIN_MEMBER_REPORT_REASONS,
  LINKEDIN_POST_VISIBILITY_TYPES,
  LINKEDIN_PRIVACY_SETTING_KEYS,
  LINKEDIN_SELECTOR_LOCALES,
  LINKEDIN_WRITE_VALIDATION_ACTIONS,
  PREPARED_ACTION_EFFECTIVE_STATUSES,
  SEARCH_CATEGORIES,
  LinkedInBuddyError,
  LinkedInSchedulerService,
  DEFAULT_FIXTURE_STALENESS_DAYS,
  createCoreRuntime,
  checkLinkedInFixtureStaleness,
  captureLinkedInSession,
  checkStoredSessionHealth,
  deleteLocalData,
  loadLinkedInFixtureSet,
  normalizeLinkedInFeedReaction,
  normalizeFixtureRouteHeaders,
  normalizeLinkedInPostVisibility,
  normalizeLinkedInMemberReportReason,
  normalizeFeedbackInputType,
  normalizeLinkedInPrivacySettingKey,
  normalizeLinkedInPrivacySettingValue,
  parseDraftQualityCandidateSet,
  parseDraftQualityDataset,
  ProfileManager,
  readLinkedInFixtureManifest,
  resolveFixtureManifestPath,
  resolveActivityWebhookConfig,
  resolveConfigPaths,
  resolveFollowupSinceWindow,
  resolveEvasionConfig,
  resolveLinkedInSelectorLocaleConfigResolution,
  redactStructuredValue,
  recordFeedbackInvocation,
  readFeedbackStateSnapshot,
  resolveKeepAliveDir,
  resolveLegacyRateLimitStateFilePath,
  resolvePrivacyConfig,
  resolveSchedulerConfig,
  runLinkedInWriteValidation,
  runReadOnlyLinkedInLiveValidation,
  submitFeedback,
  submitPendingFeedback,
  upsertWriteValidationAccount,
  toLinkedInBuddyErrorPayload,
  WEBHOOK_DELIVERY_ATTEMPT_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  writeLinkedInFixtureManifest,
  type ActivityEventType,
  type ActivityPollTickResult,
  type ActivityWatchKind,
  type ActivityWatchStatus,
  type DraftQualityReport,
  type JsonEventLogger,
  type JsonLogEntry,
  type LinkedInFixtureManifest,
  type LinkedInFixturePageEntry,
  type LinkedInFixtureRoute,
  type LinkedInFixtureSetSummary,
  type LinkedInReadOnlyValidationOperation,
  type LinkedInReplayPageType,
  type LocalDataDeletionFailure,
  type PreparedActionEffectiveStatus,
  type ReadOnlyValidationReport,
  type SchedulerConfig,
  type SchedulerJobRow,
  type SchedulerTickResult,
  type SearchCategory,
  type SelectorAuditReport,
  type WebhookDeliveryAttemptStatus,
  type WebhookSubscriptionStatus,
  type FeedbackType,
  type WriteValidationAccountTargets,
  type WriteValidationActionPreview,
  type WriteValidationReport,
} from "@linkedin-buddy/core";
import {
  DraftQualityProgressReporter,
  formatDraftQualityError,
  formatDraftQualityReport,
  resolveDraftQualityOutputMode,
} from "../draftQualityOutput.js";
import {
  ReadOnlyValidationProgressReporter,
  formatReadOnlyValidationError,
  formatReadOnlyValidationReport,
  resolveReadOnlyValidationOutputMode,
  type ReadOnlyValidationOutputMode,
} from "../liveValidationOutput.js";
import { HeadlessLoginProgressReporter } from "../headlessLoginOutput.js";
import {
  formatSelectorAuditError,
  formatSelectorAuditReport,
  resolveSelectorAuditOutputMode,
  SelectorAuditProgressReporter,
} from "../selectorAuditOutput.js";
import {
  formatWriteValidationError,
  formatWriteValidationReport,
  resolveWriteValidationOutputMode,
  WriteValidationProgressReporter,
  type WriteValidationOutputMode,
} from "../writeValidationOutput.js";
import {
  formatSchedulerError,
  formatSchedulerRunOnceReport,
  formatSchedulerStartReport,
  formatSchedulerStatusReport,
  formatSchedulerStopReport,
  resolveSchedulerOutputMode,
  type SchedulerJobCounts,
  type SchedulerJobPreview,
  type SchedulerOutputMode,
  type SchedulerRunOnceReport,
  type SchedulerStartReport,
  type SchedulerStatusReport,
  type SchedulerStopReport,
} from "../schedulerOutput.js";
import {
  formatActivityDeliveryListReport,
  formatActivityError,
  formatActivityEventListReport,
  formatActivityRunOnceReport,
  formatActivityStartReport,
  formatActivityStatusReport,
  formatActivityStopReport,
  formatActivityWatchAddReport,
  formatActivityWatchListReport,
  formatActivityWatchMutationReport,
  formatActivityWatchRemovalReport,
  formatActivityWebhookAddReport,
  formatActivityWebhookListReport,
  formatActivityWebhookMutationReport,
  formatActivityWebhookRemovalReport,
  resolveActivityOutputMode,
  type ActivityDaemonState,
  type ActivityDaemonStateSummary,
  type ActivityDeliveryListReport,
  type ActivityEventListReport,
  type ActivityOutputMode,
  type ActivityRunOnceReport,
  type ActivityStartReport,
  type ActivityStatusReport,
  type ActivityStopReport,
  type ActivityWatchAddReport,
  type ActivityWatchListReport,
  type ActivityWatchMutationReport,
  type ActivityWatchRemovalReport,
  type ActivityWebhookAddReport,
  type ActivityWebhookListReport,
  type ActivityWebhookMutationReport,
  type ActivityWebhookRemovalReport,
} from "../activityOutput.js";
import {
  formatKeepAliveError,
  formatKeepAliveStartReport,
  formatKeepAliveStatusReport,
  formatKeepAliveStopReport,
  resolveKeepAliveOutputMode,
  type KeepAliveOutputMode,
  type KeepAliveRecentEvent,
  type KeepAliveStartReport,
  type KeepAliveStatusReport,
  type KeepAliveStopReport,
} from "../keepAliveOutput.js";
import {
  parseActivitySeedGeneratedImageManifest,
  parseActivitySeedSpec,
  type ActivitySeedGeneratedPostImage,
  type ActivitySeedSpec,
  type ActivitySeedPostSpec,
  type ActivitySeedJobSearchSpec,
} from "../activitySeed.js";
import {
  createProfileSeedPlan,
  parseProfileSeedSpec,
  type ProfileSeedPlanAction,
  type ProfileSeedUnsupportedField,
} from "../profileSeed.js";

const cliPrivacyConfig = resolvePrivacyConfig();
const SELECTOR_AUDIT_DOC_PATH = "docs/selector-audit.md";
const SELECTOR_AUDIT_DOC_REFERENCE = `See ${SELECTOR_AUDIT_DOC_PATH} for sample output, configuration, and troubleshooting.`;
const MAX_JSON_INPUT_BYTES = 10 * 1024 * 1024;
const LIVE_VALIDATION_HELP_COMMAND = "linkedin test live --help";
const LIVE_VALIDATION_FAIL_EXIT_CODE = 1;
const LIVE_VALIDATION_ERROR_EXIT_CODE = 2;
const WRITE_VALIDATION_DOC_PATH = "docs/write-validation.md";
const WRITE_VALIDATION_WARNING = "This will perform REAL actions on LinkedIn";
const TOTAL_WRITE_VALIDATION_ACTIONS = LINKEDIN_WRITE_VALIDATION_ACTIONS.length;
let cliEvasionEnabled = true;
let cliEvasionLevel: string | undefined;
let cliSelectorLocale: string | undefined;
let activeCliInvocation:
  | {
      commandName: string;
      profileName?: string;
    }
  | undefined;

function writeCliWarning(message: string): void {
  process.stderr.write(`[linkedin] Warning: ${message}\n`);
}

function writeCliNotice(message: string): void {
  process.stderr.write(`[linkedin] ${message}\n`);
}

function maybeWarnAboutSelectorLocaleConfig(selectorLocale?: string): void {
  const warning = getLinkedInSelectorLocaleConfigWarning(
    resolveLinkedInSelectorLocaleConfigResolution(selectorLocale),
    "cli",
  );

  if (!warning) {
    return;
  }

  writeCliWarning(warning.message);
  writeCliNotice(warning.actionTaken);
  writeCliNotice(warning.guidance);
}

/** Human-readable preview row for a single local-data target. */
interface LocalDataPreviewItem {
  exists: boolean;
  label: string;
  note?: string;
  path: string;
}

/**
 * Aggregated inventory reused by the dry-run output, confirmation prompts, and
 * final JSON payloads for `linkedin data delete`.
 */
interface LocalDataDeletionPreview {
  baseDir: string;
  deleteItems: LocalDataPreviewItem[];
  existingDeletePaths: string[];
  includeProfileRequested: boolean;
  missingDeletePaths: string[];
  preserveItems: LocalDataPreviewItem[];
}

function coercePositiveInt(value: string, label: string): number {
  const normalized = value.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!/^\d+$/u.test(normalized) || !Number.isFinite(parsed) || parsed <= 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a positive integer.`,
    );
  }
  return parsed;
}

function coerceNonNegativeInt(value: string, label: string): number {
  const normalized = value.trim();
  const parsed = Number.parseInt(normalized, 10);
  if (!/^\d+$/u.test(normalized) || !Number.isFinite(parsed) || parsed < 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-negative integer.`,
    );
  }
  return parsed;
}

function coerceSearchCategory(value: string): SearchCategory {
  if (isSearchCategory(value)) {
    return value;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `category must be one of: ${SEARCH_CATEGORIES.join(", ")}.`,
  );
}

function coerceProfileName(value: string, label: string = "profile"): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`,
    );
  }

  if (normalized === "." || normalized === ".." || /[\\/]/.test(normalized)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not contain path separators or relative path segments.`,
    );
  }

  return normalized;
}

function coerceActionStatus(value: string): PreparedActionEffectiveStatus {
  if (isPreparedActionEffectiveStatus(value)) {
    return value;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `status must be one of: ${PREPARED_ACTION_EFFECTIVE_STATUSES.join(", ")}.`,
  );
}

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(
      redactStructuredValue(value, cliPrivacyConfig, "cli"),
      null,
      2,
    ),
  );
}

function createRuntime(cdpUrl?: string) {
  maybeWarnAboutSelectorLocaleConfig(cliSelectorLocale);
  const evasionLevel = resolveCliEvasionLevelOverride();

  if (cdpUrl) {
    process.stderr.write(
      [
        "[linkedin] Warning: --cdp-url attaches to an existing browser session.",
        "This can share cookies/state with other Chrome sessions.",
        "For an isolated tool-only profile, omit --cdp-url.",
      ].join(" "),
    );
    process.stderr.write("\n");
  }
  return createCoreRuntime(
    cdpUrl
      ? {
          cdpUrl,
          ...(evasionLevel ? { evasionLevel } : {}),
          privacy: cliPrivacyConfig,
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {}),
        }
      : {
          ...(evasionLevel ? { evasionLevel } : {}),
          privacy: cliPrivacyConfig,
          ...(cliSelectorLocale ? { selectorLocale: cliSelectorLocale } : {}),
        },
  );
}

function resolveCliEvasionLevelOverride(): string | undefined {
  if (cliEvasionEnabled === false) {
    return "minimal";
  }

  return cliEvasionLevel;
}

function resolveCliEvasionRuntimeConfig() {
  const evasionLevel = resolveCliEvasionLevelOverride();
  return resolveEvasionConfig(
    evasionLevel
      ? {
          level: evasionLevel,
        }
      : {},
  );
}

const DEFAULT_FIXTURE_RECORD_PROFILE = "fixtures";
const DEFAULT_FIXTURE_RECORD_SET = "manual";
const DEFAULT_FIXTURE_VIEWPORT = {
  width: 1440,
  height: 900,
} as const;
const FIXTURE_ROUTE_FILE_NAME = "routes.json";
const FIXTURE_RESPONSE_DIR_NAME = "responses";
const FIXTURE_PAGES_DIR_NAME = "pages";
const FIXTURE_CAPTURE_URLS: Record<LinkedInReplayPageType, string> = {
  company: "https://www.linkedin.com/company/microsoft/about/",
  composer: "https://www.linkedin.com/feed/",
  connections: "https://www.linkedin.com/mynetwork/invite-connect/connections/",
  feed: "https://www.linkedin.com/feed/",
  jobs: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer",
  messaging: "https://www.linkedin.com/messaging/",
  notifications: "https://www.linkedin.com/notifications/",
  profile: "https://www.linkedin.com/in/me/",
  search:
    "https://www.linkedin.com/search/results/people/?keywords=Simon%20Miller",
};

interface FixtureRecordInput {
  har: boolean;
  height: number;
  manifestPath?: string;
  pageTypes: LinkedInReplayPageType[];
  profileName: string;
  setName: string;
  width: number;
}

function isFixtureReplayPageType(
  value: string,
): value is LinkedInReplayPageType {
  return (LINKEDIN_REPLAY_PAGE_TYPES as readonly string[]).includes(value);
}

function coerceFixtureReplayPageType(value: string): LinkedInReplayPageType {
  const normalized = value.trim().toLowerCase();
  if (isFixtureReplayPageType(normalized)) {
    return normalized;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `page must be one of: ${LINKEDIN_REPLAY_PAGE_TYPES.join(", ")}.`,
  );
}

function collectFixtureReplayPageTypes(
  value: string,
  previous: LinkedInReplayPageType[],
): LinkedInReplayPageType[] {
  const nextValues = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => coerceFixtureReplayPageType(item));

  if (nextValues.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "page must include at least one page type when --page is provided.",
    );
  }

  return [...previous, ...nextValues];
}

function collectNonEmptyStrings(value: string, previous: string[]): string[] {
  const nextValues = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (nextValues.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Option must include at least one value when provided.",
    );
  }

  return [...previous, ...nextValues];
}

function uniqueFixtureReplayPageTypes(
  pageTypes: LinkedInReplayPageType[],
): LinkedInReplayPageType[] {
  return Array.from(new Set(pageTypes));
}

function sanitizeFixtureFileStem(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "-").replace(/-{2,}/gu, "-");
}

function guessFixtureResponseExtension(
  contentType: string | undefined,
  url: string,
): string {
  const normalizedType = (contentType ?? "").toLowerCase();
  if (normalizedType.includes("text/html")) {
    return ".html";
  }
  if (normalizedType.includes("application/json")) {
    return ".json";
  }
  if (normalizedType.includes("javascript")) {
    return ".js";
  }
  if (normalizedType.includes("text/css")) {
    return ".css";
  }
  if (normalizedType.includes("image/png")) {
    return ".png";
  }
  if (normalizedType.includes("image/jpeg")) {
    return ".jpg";
  }
  if (normalizedType.includes("image/svg")) {
    return ".svg";
  }

  try {
    const parsed = new URL(url);
    const extension = path.extname(parsed.pathname);
    return extension || ".bin";
  } catch {
    return ".bin";
  }
}

async function loadFixtureManifestOrCreate(
  manifestPath: string,
): Promise<LinkedInFixtureManifest> {
  if (!existsSync(manifestPath)) {
    return createEmptyFixtureManifest();
  }

  return await readLinkedInFixtureManifest(manifestPath);
}

async function loadExistingFixtureRoutes(
  manifestPath: string,
  setName: string,
  setSummary: LinkedInFixtureSetSummary | undefined,
): Promise<LinkedInFixtureRoute[]> {
  if (!setSummary) {
    return [];
  }

  const routesPath = path.resolve(
    path.dirname(manifestPath),
    setSummary.rootDir,
    setSummary.routesPath,
  );
  if (!existsSync(routesPath)) {
    return [];
  }

  return (await loadLinkedInFixtureSet(manifestPath, setName)).routes;
}

function mergeFixtureRoutes(
  existingRoutes: LinkedInFixtureRoute[],
  nextRoutes: LinkedInFixtureRoute[],
): LinkedInFixtureRoute[] {
  const merged = new Map<string, LinkedInFixtureRoute>();
  for (const route of existingRoutes) {
    merged.set(buildFixtureRouteKey(route), route);
  }
  // Let freshly captured routes replace older normalized keys so partial
  // re-records only touch the requested pages and keep the rest intact.
  for (const route of nextRoutes) {
    merged.set(buildFixtureRouteKey(route), route);
  }

  return Array.from(merged.values()).sort((left, right) =>
    buildFixtureRouteKey(left).localeCompare(buildFixtureRouteKey(right)),
  );
}

interface FixtureCaptureResponse {
  body(): Promise<Buffer>;
  headers(): Record<string, string>;
  request(): {
    method(): string;
  };
  status(): number;
  url(): string;
}

async function withFixtureReplayDisabled<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  // Recording must always talk to live LinkedIn, even if the caller currently
  // has replay mode enabled in the shell.
  for (const key of FIXTURE_REPLAY_ENV_KEYS) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureFixtureResponse(
  response: FixtureCaptureResponse,
  setDir: string,
  index: number,
): Promise<LinkedInFixtureRoute | null> {
  const url = response.url();
  if (!isLinkedInFixtureReplayUrl(url)) {
    return null;
  }

  const method = response.request().method().toUpperCase();
  const headers = normalizeFixtureRouteHeaders(response.headers());
  const extension = guessFixtureResponseExtension(headers["content-type"], url);

  // The sequence number is allocated when the response event fires so file
  // names stay stable even if body reads resolve out of order.
  let fileStem = `${String(index).padStart(4, "0")}`;
  try {
    const parsed = new URL(url);
    const pathStem = sanitizeFixtureFileStem(
      `${parsed.hostname}${parsed.pathname === "/" ? "/root" : parsed.pathname}`,
    );
    fileStem = `${fileStem}-${pathStem}`;
  } catch {
    // Use the fallback sequence number stem.
  }

  const relativeBodyPath = path.join(
    FIXTURE_RESPONSE_DIR_NAME,
    `${fileStem}${extension}`,
  );
  const absoluteBodyPath = path.join(setDir, relativeBodyPath);
  const bodyBuffer = await response.body().catch(() => Buffer.from(""));
  await mkdir(path.dirname(absoluteBodyPath), { recursive: true });
  await writeFile(absoluteBodyPath, bodyBuffer);

  return {
    method,
    url,
    status: response.status(),
    headers,
    bodyPath: relativeBodyPath,
  };
}

async function runFixturesCheck(input: {
  manifestPath?: string;
  maxAgeDays?: number;
  setName?: string;
}): Promise<void> {
  const manifestPath = resolveFixtureManifestPath(input.manifestPath);
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_FIXTURE_STALENESS_DAYS;
  const warnings = await checkLinkedInFixtureStaleness(manifestPath, {
    maxAgeDays,
    ...(input.setName ? { setName: input.setName } : {}),
  });

  for (const warning of warnings) {
    writeCliWarning(warning.message);
  }

  printJson({
    manifest_path: manifestPath,
    max_age_days: maxAgeDays,
    set_name: input.setName ?? null,
    stale: warnings.length > 0,
    warning_count: warnings.length,
    warnings,
  });
}

async function runFixturesRecord(input: FixtureRecordInput): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "fixtures:record requires an interactive terminal because it pauses for manual navigation.",
    );
  }

  const manifestPath = resolveFixtureManifestPath(input.manifestPath);
  const manifest = await loadFixtureManifestOrCreate(manifestPath);
  const setName = input.setName;
  const previousSetSummary = manifest.sets[setName];
  const setRootDir = path.resolve(
    path.dirname(manifestPath),
    previousSetSummary?.rootDir ?? setName,
  );
  const pagesDir = path.join(setRootDir, FIXTURE_PAGES_DIR_NAME);
  const harRelativePath = input.har ? "session.har" : undefined;
  const harAbsolutePath = harRelativePath
    ? path.join(setRootDir, harRelativePath)
    : undefined;
  const existingRoutes = await loadExistingFixtureRoutes(
    manifestPath,
    setName,
    previousSetSummary,
  );
  const capturedRoutes = new Map<string, LinkedInFixtureRoute>();
  const captureJobs: Array<Promise<void>> = [];
  const pageEntries: Partial<
    Record<LinkedInReplayPageType, LinkedInFixturePageEntry>
  > = {
    ...(previousSetSummary?.pages ?? {}),
  };

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await mkdir(setRootDir, { recursive: true });
  await mkdir(pagesDir, { recursive: true });

  const profileManager = new ProfileManager(resolveConfigPaths(), {
    evasion: resolveCliEvasionRuntimeConfig(),
  });
  let captureLocale = previousSetSummary?.locale ?? "en-US";
  let captureViewport: { width: number; height: number } = {
    width: input.width,
    height: input.height,
  };

  await withFixtureReplayDisabled(async () => {
    await profileManager.runWithPersistentContext(
      input.profileName,
      {
        headless: false,
        launchOptions: {
          viewport: {
            width: input.width,
            height: input.height,
          },
          ...(harAbsolutePath
            ? {
                recordHar: {
                  path: harAbsolutePath,
                },
              }
            : {}),
        },
      },
      async (context) => {
        let responseIndex = existingRoutes.length;
        context.on("response", (response) => {
          // Increment synchronously before the async body write starts so the
          // route file and response filenames stay deterministic.
          responseIndex += 1;
          const captureJob = captureFixtureResponse(
            response,
            setRootDir,
            responseIndex,
          )
            .then((capturedRoute) => {
              if (!capturedRoute) {
                return;
              }

              capturedRoutes.set(
                buildFixtureRouteKey(capturedRoute),
                capturedRoute,
              );
            })
            .catch(() => undefined);
          captureJobs.push(captureJob);
        });

        const page = context.pages()[0] ?? (await context.newPage());
        const prompt = createInterface({
          input: stdin,
          output: stdout,
        });

        try {
          for (const pageType of input.pageTypes) {
            const suggestedUrl = FIXTURE_CAPTURE_URLS[pageType];
            if (suggestedUrl) {
              await page
                .goto(suggestedUrl, { waitUntil: "domcontentloaded" })
                .catch(() => undefined);
            }

            writeCliNotice(
              `Navigate the browser to the LinkedIn ${pageType} page you want to capture.`,
            );
            await prompt.question(
              `Press Enter to capture ${pageType} (current page: ${page.url() || suggestedUrl}). `,
            );

            const htmlRelativePath = path.join(
              FIXTURE_PAGES_DIR_NAME,
              `${pageType}.html`,
            );
            const htmlAbsolutePath = path.join(setRootDir, htmlRelativePath);
            await writeFile(
              htmlAbsolutePath,
              `${await page.content()}\n`,
              "utf8",
            );

            const currentUrl = page.url();
            const pageTitle = await page.title().catch(() => undefined);
            const pageLocale = await page
              .evaluate(() => navigator.language)
              .catch(() => undefined);
            const viewport = page.viewportSize();
            captureLocale =
              typeof pageLocale === "string" && pageLocale.trim().length > 0
                ? pageLocale.trim()
                : captureLocale;
            if (viewport) {
              captureViewport = viewport;
            }

            pageEntries[pageType] = {
              pageType,
              url: currentUrl || suggestedUrl,
              htmlPath: htmlRelativePath,
              recordedAt: new Date().toISOString(),
              ...(typeof pageTitle === "string" && pageTitle.trim().length > 0
                ? { title: pageTitle.trim() }
                : {}),
            };
          }

          await page.waitForTimeout(750);
        } finally {
          prompt.close();
        }
      },
    );
  });

  // Finish any in-flight response writes before rewriting the route index.
  await Promise.allSettled(captureJobs);

  const mergedRoutes = mergeFixtureRoutes(existingRoutes, [
    ...capturedRoutes.values(),
  ]);
  await writeFile(
    path.join(setRootDir, FIXTURE_ROUTE_FILE_NAME),
    `${JSON.stringify(
      {
        format: LINKEDIN_FIXTURE_MANIFEST_FORMAT_VERSION,
        setName,
        routes: mergedRoutes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const capturedAt = new Date().toISOString();
  const setSummary: LinkedInFixtureSetSummary = {
    setName,
    rootDir: path.relative(path.dirname(manifestPath), setRootDir),
    locale: captureLocale,
    capturedAt,
    viewport: captureViewport,
    routesPath: FIXTURE_ROUTE_FILE_NAME,
    ...(harRelativePath ? { harPath: harRelativePath } : {}),
    description:
      previousSetSummary?.description ??
      "Recorded manually through the LinkedIn fixture replay workflow.",
    pages: pageEntries,
  };

  manifest.sets[setName] = setSummary;
  if (!manifest.defaultSetName) {
    manifest.defaultSetName = setName;
  }

  await writeLinkedInFixtureManifest(manifestPath, manifest);

  printJson({
    manifest_path: manifestPath,
    set_name: setName,
    captured_at: capturedAt,
    locale: captureLocale,
    viewport: captureViewport,
    pages: pageEntries,
    routes_path: path.join(setSummary.rootDir, FIXTURE_ROUTE_FILE_NAME),
    route_count: mergedRoutes.length,
    ...(harRelativePath
      ? { har_path: path.join(setSummary.rootDir, harRelativePath) }
      : {}),
  });
}

interface KeepAliveState {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "degraded" | "stopped";
  intervalMs: number;
  jitterMs: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  lastTickAt?: string;
  lastCheckStartedAt?: string;
  lastHealthyAt?: string;
  authenticated?: boolean;
  browserHealthy?: boolean;
  currentUrl?: string;
  reason?: string;
  lastError?: string;
  cdpUrl?: string;
  healthCheckInProgress?: boolean;
  stoppedAt?: string;
}

interface KeepAliveFiles {
  dir: string;
  pidPath: string;
  statePath: string;
  logPath: string;
}

type SchedulerStateSummary = Pick<
  SchedulerTickResult,
  | "skippedReason"
  | "discoveredAcceptedConnections"
  | "queuedJobs"
  | "updatedJobs"
  | "reopenedJobs"
  | "cancelledJobs"
  | "claimedJobs"
  | "preparedJobs"
  | "rescheduledJobs"
  | "failedJobs"
>;

interface SchedulerState {
  pid: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  status: "starting" | "running" | "idle" | "degraded" | "stopped";
  pollIntervalMs: number;
  businessHours: SchedulerConfig["businessHours"];
  maxJobsPerTick: number;
  maxActiveJobsPerProfile: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  lastTickAt?: string;
  lastSuccessfulTickAt?: string;
  lastPreparedAt?: string;
  nextWindowStartAt?: string | null;
  lastSummary?: SchedulerStateSummary;
  lastError?: string;
  cdpUrl?: string;
  stoppedAt?: string;
}

interface SchedulerFiles {
  dir: string;
  pidPath: string;
  statePath: string;
  logPath: string;
}

const SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_SCHEDULER_STATUS_JOB_LIMIT = 5;

function profileSlug(profileName: string): string {
  return profileName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getKeepAliveFiles(profileName: string): KeepAliveFiles {
  const slug = profileSlug(profileName);
  const dir = resolveKeepAliveDir();
  return {
    dir,
    pidPath: path.join(dir, `${slug}.pid`),
    statePath: path.join(dir, `${slug}.state.json`),
    logPath: path.join(dir, `${slug}.events.jsonl`),
  };
}

function getSchedulerFiles(profileName: string): SchedulerFiles {
  const slug = profileSlug(profileName);
  const dir = path.join(resolveConfigPaths().baseDir, "scheduler");
  return {
    dir,
    pidPath: path.join(dir, `${slug}.pid`),
    statePath: path.join(dir, `${slug}.state.json`),
    logPath: path.join(dir, `${slug}.events.jsonl`),
  };
}

async function ensureKeepAliveDir(files: KeepAliveFiles): Promise<void> {
  await mkdir(files.dir, { recursive: true });
}

async function ensureSchedulerDir(files: SchedulerFiles): Promise<void> {
  await mkdir(files.dir, { recursive: true });
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonInputFile(
  filePath: string,
  label: string,
): Promise<unknown> {
  const resolvedPath = path.resolve(filePath);
  let raw: string;

  try {
    const fileStats = await stat(resolvedPath);
    if (!fileStats.isFile()) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Expected ${label} path to point to a file.`,
        {
          path: resolvedPath,
        },
      );
    }

    if (fileStats.size > MAX_JSON_INPUT_BYTES) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `${label} exceeds the maximum supported size of ${MAX_JSON_INPUT_BYTES} bytes.`,
        {
          path: resolvedPath,
          size_bytes: fileStats.size,
          limit_bytes: MAX_JSON_INPUT_BYTES,
        },
      );
    }

    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error instanceof LinkedInBuddyError) {
      throw error;
    }

    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Could not read ${label}.`,
        {
          path: resolvedPath,
          cause: "ENOENT",
        },
        { cause: error },
      );
    }

    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Could not read ${label}.`,
      {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error),
      },
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Could not parse ${label} as JSON.`,
      {
        path: resolvedPath,
        cause: error instanceof Error ? error.message : String(error),
      },
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function writeOutputJsonFile(
  filePath: string,
  value: unknown,
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeJsonFile(resolvedPath, value);
  return resolvedPath;
}

function createDraftQualityProgressLogger(
  onLog: (entry: { event: string; payload: Record<string, unknown> }) => void,
): {
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    payload?: Record<string, unknown>,
  ): void;
} {
  return {
    log(_level, event, payload = {}) {
      onLog({ event, payload });
    },
  };
}

function attachHeadlessLoginLogObserver(
  logger: Pick<JsonEventLogger, "log">,
  onLog: (entry: JsonLogEntry) => void,
): void {
  const originalLog = logger.log.bind(logger) as (
    ...args: Parameters<JsonEventLogger["log"]>
  ) => ReturnType<JsonEventLogger["log"]>;

  logger.log = (...args: Parameters<JsonEventLogger["log"]>) => {
    const entry = originalLog(...args);
    onLog(entry);
    return entry;
  };
}

async function readKeepAlivePid(profileName: string): Promise<number | null> {
  const files = getKeepAliveFiles(profileName);
  try {
    const raw = await readFile(files.pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeKeepAlivePid(
  profileName: string,
  pid: number,
): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await writeFile(files.pidPath, `${pid}\n`, "utf8");
}

async function removeKeepAlivePid(profileName: string): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  try {
    await unlink(files.pidPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readKeepAliveState(
  profileName: string,
): Promise<KeepAliveState | null> {
  const files = getKeepAliveFiles(profileName);
  return readJsonFile<KeepAliveState>(files.statePath);
}

async function writeKeepAliveState(
  profileName: string,
  state: KeepAliveState,
): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await writeJsonFile(files.statePath, state);
}

async function appendKeepAliveEvent(
  profileName: string,
  event: Record<string, unknown>,
): Promise<void> {
  const files = getKeepAliveFiles(profileName);
  await ensureKeepAliveDir(files);
  await appendFile(files.logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asKeepAliveRecentEvent(value: unknown): KeepAliveRecentEvent | null {
  if (!isRecordValue(value)) {
    return null;
  }

  const ts = value.ts;
  const event = value.event;
  if (
    typeof ts !== "string" ||
    ts.trim().length === 0 ||
    typeof event !== "string" ||
    event.trim().length === 0
  ) {
    return null;
  }

  return {
    ...value,
    ts,
    event,
  } as KeepAliveRecentEvent;
}

async function readKeepAliveRecentEvents(
  profileName: string,
  limit: number = 5,
): Promise<KeepAliveRecentEvent[]> {
  const files = getKeepAliveFiles(profileName);

  try {
    const raw = await readFile(files.logPath, "utf8");
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-limit)
      .map((line) => {
        try {
          return asKeepAliveRecentEvent(JSON.parse(line) as unknown);
        } catch {
          return null;
        }
      })
      .filter((event): event is KeepAliveRecentEvent => event !== null);

    return events;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readSchedulerPid(profileName: string): Promise<number | null> {
  const files = getSchedulerFiles(profileName);
  try {
    const raw = await readFile(files.pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSchedulerPid(
  profileName: string,
  pid: number,
): Promise<void> {
  const files = getSchedulerFiles(profileName);
  await ensureSchedulerDir(files);
  await writeFile(files.pidPath, `${pid}\n`, "utf8");
}

async function removeSchedulerPid(profileName: string): Promise<void> {
  const files = getSchedulerFiles(profileName);
  try {
    await unlink(files.pidPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readSchedulerState(
  profileName: string,
): Promise<SchedulerState | null> {
  const files = getSchedulerFiles(profileName);
  return readJsonFile<SchedulerState>(files.statePath);
}

async function writeSchedulerState(
  profileName: string,
  state: SchedulerState,
): Promise<void> {
  const files = getSchedulerFiles(profileName);
  await ensureSchedulerDir(files);
  await writeJsonFile(files.statePath, state);
}

async function appendSchedulerEvent(
  profileName: string,
  event: Record<string, unknown>,
): Promise<void> {
  const files = getSchedulerFiles(profileName);
  await ensureSchedulerDir(files);
  await appendFile(files.logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "EPERM") {
        return true;
      }
      if (error.code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}

function isProfileLockHeldError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /lock file is already being held/i.test(error.message)
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function promptYesNo(
  question: string,
  output: typeof stdout | typeof process.stderr = stdout,
): Promise<boolean> {
  const readline = createInterface({
    input: stdin,
    output,
  });

  try {
    const response = await readline.question(
      `${question} Type "yes" to confirm: `,
    );
    return response.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

async function promptTextInput(
  question: string,
  output: typeof stdout | typeof process.stderr = process.stderr,
): Promise<string> {
  const readline = createInterface({
    input: stdin,
    output,
  });

  try {
    return (await readline.question(`${question}: `)).trim();
  } finally {
    readline.close();
  }
}

async function promptMultilineInput(
  question: string,
  output: typeof stdout | typeof process.stderr = process.stderr,
): Promise<string> {
  const readline = createInterface({
    input: stdin,
    output,
  });

  try {
    output.write(`${question} Finish with an empty line.\n`);
    const lines: string[] = [];

    while (true) {
      const line = await readline.question(lines.length === 0 ? "> " : "... ");
      if (line.trim().length === 0) {
        break;
      }

      lines.push(line);
    }

    return lines.join("\n").trim();
  } finally {
    readline.close();
  }
}

function shouldUseAnsiColor(stream: { isTTY?: boolean }): boolean {
  return (
    Boolean(stream.isTTY) &&
    typeof process.env.NO_COLOR === "undefined" &&
    process.env.NODE_DISABLE_COLORS !== "1" &&
    process.env.TERM !== "dumb"
  );
}

function assertInteractiveTerminal(operation: string): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `Refusing to ${operation} in non-interactive mode.`,
    );
  }
}

function trimOptionalCliText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readCommandProfileName(command: Command): string | undefined {
  const options = command.opts<Record<string, unknown>>();
  const profileValue =
    typeof options.profile === "string"
      ? options.profile
      : typeof options.profileName === "string"
        ? options.profileName
        : undefined;

  return trimOptionalCliText(profileValue);
}

function describeCliCommand(command: Command): string {
  const commandNames: string[] = [];
  let currentCommand: Command | undefined = command;

  while (currentCommand) {
    const commandName = currentCommand.name();
    if (commandName && commandName !== "linkedin") {
      commandNames.push(commandName);
    }
    currentCommand = currentCommand.parent ?? undefined;
  }

  return commandNames.reverse().join(" ").trim();
}

function shouldTrackCliFeedback(commandName: string): boolean {
  return commandName !== "feedback";
}

async function maybeEmitCliFeedbackHint(error?: unknown): Promise<void> {
  const invocation = activeCliInvocation;
  activeCliInvocation = undefined;

  if (!invocation || !shouldTrackCliFeedback(invocation.commandName)) {
    return;
  }

  try {
    const decision = await recordFeedbackInvocation({
      source: "cli",
      invocationName: invocation.commandName,
      ...(invocation.profileName
        ? { activeProfileName: invocation.profileName }
        : {}),
      ...(typeof error !== "undefined" ? { error } : {}),
    });

    if (decision.showHint) {
      writeCliNotice(buildFeedbackHintMessage(decision.reason));
    }
  } catch (trackingError) {
    writeCliWarning(
      `Could not update feedback hint state: ${asLinkedInBuddyError(trackingError).message}`,
    );
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}

function resolveLocalDataDeleteLabel(
  targetPath: string,
  paths: ReturnType<typeof resolveConfigPaths>,
  keepAliveDir: string,
  legacyRateLimitStatePath: string,
): string {
  if (targetPath === path.resolve(paths.dbPath)) {
    return "SQLite database";
  }

  if (targetPath === path.resolve(`${paths.dbPath}-journal`)) {
    return "SQLite rollback journal";
  }

  if (targetPath === path.resolve(`${paths.dbPath}-wal`)) {
    return "SQLite write-ahead log";
  }

  if (targetPath === path.resolve(`${paths.dbPath}-shm`)) {
    return "SQLite shared-memory file";
  }

  if (targetPath === path.resolve(paths.artifactsDir)) {
    return "Run artifacts";
  }

  if (targetPath === path.resolve(keepAliveDir)) {
    return "Keepalive daemon state";
  }

  if (targetPath === path.resolve(paths.profilesDir)) {
    return "Browser profiles";
  }

  if (targetPath === legacyRateLimitStatePath) {
    return "Legacy auth cooldown state";
  }

  if (targetPath.endsWith(`${path.sep}rate-limit-state.json`)) {
    return "Auth cooldown state";
  }

  return "Local data target";
}

async function createLocalDataDeletionPreview(
  includeProfile: boolean,
): Promise<LocalDataDeletionPreview> {
  const deletionPlan = createLocalDataDeletionPlan({ includeProfile });
  const resolvedPaths = resolveConfigPaths(deletionPlan.baseDir);
  const keepAliveDir = resolveKeepAliveDir(deletionPlan.baseDir);
  const legacyRateLimitStatePath = path.resolve(
    resolveLegacyRateLimitStateFilePath(),
  );

  const deleteItems = await Promise.all(
    deletionPlan.targets.map(async (targetPath) => ({
      exists: await pathExists(targetPath),
      label: resolveLocalDataDeleteLabel(
        targetPath,
        resolvedPaths,
        keepAliveDir,
        legacyRateLimitStatePath,
      ),
      ...(targetPath === path.resolve(resolvedPaths.profilesDir)
        ? {
            note: "Deletes tool-owned cookies, local storage, and saved browser sessions.",
          }
        : {}),
      path: targetPath,
    })),
  );

  const preserveItems = await Promise.all(
    [
      ...(!includeProfile
        ? [
            {
              label: "Browser profiles",
              note: "Preserved unless you rerun with --include-profile.",
              path: path.resolve(resolvedPaths.profilesDir),
            },
          ]
        : []),
      {
        label: "Config file",
        note: "Preserved by design. Delete manually only if you want a full local reset.",
        path: path.resolve(path.join(deletionPlan.baseDir, "config.json")),
      },
    ].map(async (item) => ({
      ...item,
      exists: await pathExists(item.path),
    })),
  );

  return {
    baseDir: deletionPlan.baseDir,
    deleteItems,
    existingDeletePaths: deleteItems
      .filter((item) => item.exists)
      .map((item) => item.path),
    includeProfileRequested: includeProfile,
    missingDeletePaths: deleteItems
      .filter((item) => !item.exists)
      .map((item) => item.path),
    preserveItems,
  };
}

function printLocalDataPreviewSection(
  title: string,
  items: LocalDataPreviewItem[],
): void {
  if (items.length === 0) {
    return;
  }

  console.log(title);
  for (const item of items) {
    const note = item.note ? ` — ${item.note}` : "";
    console.log(
      `- ${item.label}: ${item.path} (${item.exists ? "present" : "already absent"})${note}`,
    );
  }
}

function printLocalDataDeletionPreview(
  preview: LocalDataDeletionPreview,
  destructiveMode: boolean,
): void {
  if (destructiveMode) {
    console.log("Local data deletion requested.");
  } else {
    console.log(
      "Local data deletion preview (dry-run). No files were removed.",
    );
  }

  console.log(`Assistant home: ${preview.baseDir}`);
  printLocalDataPreviewSection("Delete targets:", preview.deleteItems);
  printLocalDataPreviewSection("Preserved paths:", preview.preserveItems);

  if (preview.existingDeletePaths.length === 0) {
    console.log(
      "Nothing to delete. Tool-owned runtime state is already absent.",
    );
    return;
  }

  if (!destructiveMode) {
    console.log(
      `Rerun with --confirm to permanently delete ${preview.existingDeletePaths.length} existing ${pluralize(preview.existingDeletePaths.length, "path")}.`,
    );
    if (preview.includeProfileRequested) {
      console.log(
        "Browser profiles are included in this preview and still require a second confirmation during deletion.",
      );
    }
    return;
  }

  console.log(
    `Ready to delete ${preview.existingDeletePaths.length} existing ${pluralize(preview.existingDeletePaths.length, "path")} after confirmation.`,
  );
  if (preview.includeProfileRequested) {
    console.log(
      "Deleting browser profiles requires a second confirmation because signed-in browser state will be lost.",
    );
  }
}

function isLocalDataDeletionFailure(
  value: unknown,
): value is LocalDataDeletionFailure {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<LocalDataDeletionFailure>;
  return (
    typeof candidate.path === "string" &&
    (typeof candidate.code === "string" || candidate.code === null) &&
    typeof candidate.message === "string" &&
    (typeof candidate.recoveryHint === "string" ||
      typeof candidate.recoveryHint === "undefined")
  );
}

function extractLocalDataDeletionFailures(
  value: unknown,
): LocalDataDeletionFailure[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isLocalDataDeletionFailure);
}

function formatLocalDataDeletionError(error: unknown): LinkedInBuddyError {
  const assistantError = asLinkedInBuddyError(
    error,
    "UNKNOWN",
    "Local data deletion failed.",
  );
  const failedPaths = extractLocalDataDeletionFailures(
    assistantError.details.failed_paths,
  );
  if (failedPaths.length === 0) {
    return assistantError;
  }

  const deletedCount = Array.isArray(assistantError.details.deleted_paths)
    ? assistantError.details.deleted_paths.length
    : 0;
  const firstFailure = failedPaths[0]!;
  const deletedSummary =
    deletedCount > 0
      ? `${deletedCount} ${pluralize(deletedCount, "path")} ${deletedCount === 1 ? "was" : "were"} removed before the failure.`
      : "No paths were removed before the failure.";

  return new LinkedInBuddyError(
    assistantError.code,
    `Local data deletion completed with ${failedPaths.length} ${pluralize(failedPaths.length, "failure")}. ${deletedSummary} First blocked path: ${firstFailure.path}. ${firstFailure.recoveryHint ?? "Review failed_paths for recovery guidance and retry."}`,
    assistantError.details,
    { cause: assistantError },
  );
}

function printLocalDataDeletionFailure(error: LinkedInBuddyError): void {
  const failedPaths = extractLocalDataDeletionFailures(
    error.details.failed_paths,
  );
  if (failedPaths.length === 0) {
    return;
  }

  console.error("Local data deletion could not finish cleanly.");
  for (const failure of failedPaths.slice(0, 3)) {
    console.error(
      `- ${failure.path}: ${failure.message}${failure.recoveryHint ? ` ${failure.recoveryHint}` : ""}`,
    );
  }

  if (failedPaths.length > 3) {
    const remainingFailures = failedPaths.length - 3;
    console.error(
      `- ${remainingFailures} more ${pluralize(remainingFailures, "failure")} not shown. Inspect failed_paths in the JSON error output for the full list.`,
    );
  }
}

function printLocalDataDeletionSummary(input: {
  deletedCount: number;
  includeProfileDeleted: boolean;
  includeProfileRequested: boolean;
  missingCount: number;
}): void {
  console.log("Local data deletion completed.");
  console.log(
    `- Removed ${input.deletedCount} ${pluralize(input.deletedCount, "path")}.`,
  );
  if (input.missingCount > 0) {
    console.log(
      `- Skipped ${input.missingCount} already-absent ${pluralize(input.missingCount, "path")}.`,
    );
  }
  if (input.includeProfileRequested && !input.includeProfileDeleted) {
    console.log("- Browser profiles were preserved.");
  }
  console.log("- config.json remains untouched.");
}

async function findRunningKeepAlivePids(): Promise<number[]> {
  const keepAliveDir = resolveKeepAliveDir();
  let entries: Dirent[];

  try {
    entries = await readdir(keepAliveDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const runningPids = new Set<number>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".pid")) {
      continue;
    }

    const pidFilePath = path.join(keepAliveDir, entry.name);
    let rawPid: string;

    try {
      rawPid = await readFile(pidFilePath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }

      throw error;
    }

    const pid = Number.parseInt(rawPid.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isProcessRunning(pid)) {
      runningPids.add(pid);
    }
  }

  return [...runningPids];
}

function assertCdpUrlUnsupportedForDataDelete(cdpUrl?: string): void {
  if (!cdpUrl) {
    return;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    "The data delete command only deletes tool-owned local filesystem state and does not support --cdp-url.",
  );
}

async function assertNoRunningKeepAliveDaemons(): Promise<void> {
  const runningKeepAlivePids = await findRunningKeepAlivePids();
  if (runningKeepAlivePids.length === 0) {
    return;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Stop running keepalive daemons before deleting local data. Active PID${runningKeepAlivePids.length === 1 ? "" : "s"}: ${runningKeepAlivePids.join(", ")}.`,
    {
      running_keepalive_pids: runningKeepAlivePids,
    },
  );
}

async function runDataDelete(input: {
  confirm: boolean;
  includeProfile: boolean;
  cdpUrl: string | undefined;
}): Promise<void> {
  assertCdpUrlUnsupportedForDataDelete(input.cdpUrl);
  const preview = await createLocalDataDeletionPreview(input.includeProfile);

  if (!input.confirm) {
    printLocalDataDeletionPreview(preview, false);
    printJson({
      base_dir: preview.baseDir,
      confirm_required: true,
      dry_run: true,
      existing_paths: preview.existingDeletePaths,
      include_profile_requested: input.includeProfile,
      missing_paths: preview.missingDeletePaths,
      nothing_to_delete: preview.existingDeletePaths.length === 0,
      preserved_paths: preview.preserveItems.map((item) => item.path),
      would_delete_paths: preview.deleteItems.map((item) => item.path),
    });
    return;
  }

  if (preview.existingDeletePaths.length === 0) {
    printLocalDataDeletionPreview(preview, true);
    printJson({
      deleted: false,
      dry_run: false,
      include_profile_deleted: false,
      include_profile_requested: input.includeProfile,
      missing_paths: preview.missingDeletePaths,
      nothing_to_delete: true,
      preserved_paths: preview.preserveItems.map((item) => item.path),
    });
    return;
  }

  assertInteractiveTerminal("delete local data with --confirm");
  await assertNoRunningKeepAliveDaemons();
  printLocalDataDeletionPreview(preview, true);

  const deleteAllConfirmed = await promptYesNo("Delete the listed local data?");
  if (!deleteAllConfirmed) {
    console.log("Deletion cancelled. No files were removed.");
    printJson({
      cancelled: true,
      deleted: false,
      dry_run: false,
      include_profile_deleted: false,
      include_profile_requested: input.includeProfile,
      preserved_paths: preview.preserveItems.map((item) => item.path),
      would_delete_paths: preview.existingDeletePaths,
    });
    return;
  }

  const profileItem = preview.deleteItems.find(
    (item) => item.label === "Browser profiles",
  );
  let includeProfile = false;
  if (input.includeProfile && profileItem?.exists) {
    includeProfile = await promptYesNo(
      `Delete browser profile data at ${profileItem.path}? This removes saved sessions and cookies.`,
    );

    if (!includeProfile) {
      console.log(
        "Browser profile deletion declined. Profiles will be preserved.",
      );
    }
  } else if (input.includeProfile) {
    console.log(
      "Browser profiles are already absent. Skipping the extra profile confirmation.",
    );
  }

  try {
    const deletionResult = await deleteLocalData({ includeProfile });
    printLocalDataDeletionSummary({
      deletedCount: deletionResult.deletedPaths.length,
      includeProfileDeleted: includeProfile,
      includeProfileRequested: input.includeProfile,
      missingCount: deletionResult.missingPaths.length,
    });

    printJson({
      deleted: true,
      dry_run: false,
      include_profile_requested: input.includeProfile,
      include_profile_deleted: includeProfile,
      missing_paths: deletionResult.missingPaths,
      preserved_paths: preview.preserveItems.map((item) => item.path),
      started_at: deletionResult.startedAt,
      completed_at: deletionResult.completedAt,
      deleted_paths: deletionResult.deletedPaths,
      failed_paths: deletionResult.failedPaths,
    });
  } catch (error) {
    const formattedError = formatLocalDataDeletionError(error);
    printLocalDataDeletionFailure(formattedError);
    throw formattedError;
  }
}

async function runStatus(profileName: string, cdpUrl?: string): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.status.start", { profileName });
    const status = await runtime.auth.status({ profileName });
    runtime.logger.log("info", "cli.status.done", {
      profileName,
      authenticated: status.authenticated,
      evasion_level: status.evasion?.level,
      evasion_diagnostics_enabled: status.evasion?.diagnosticsEnabled ?? false,
    });
    printJson({ run_id: runtime.runId, profile_name: profileName, ...status });
  } finally {
    runtime.close();
  }
}

function buildFeedbackJsonResult(
  result:
    | Awaited<ReturnType<typeof submitFeedback>>
    | Awaited<ReturnType<typeof submitPendingFeedback>>,
): Record<string, unknown> {
  if ("submittedCount" in result) {
    return {
      repository: result.repository,
      submitted_count: result.submittedCount,
      failure_count: result.failureCount,
      submitted: result.submitted.map((item) => ({
        file_path: formatFeedbackDisplayPath(item.filePath),
        title: item.title,
        type: item.type,
        url: item.url,
      })),
      failures: result.failures.map((item) => ({
        file_path: formatFeedbackDisplayPath(item.filePath),
        error: item.error,
      })),
    };
  }

  return {
    repository: result.repository,
    status: result.status,
    title: result.title,
    type: result.type,
    labels: result.labels,
    redaction_applied: result.redactionApplied,
    ...(result.url ? { url: result.url } : {}),
    ...(result.pendingFilePath
      ? {
          pending_file_path: formatFeedbackDisplayPath(result.pendingFilePath),
        }
      : {}),
  };
}

function printFeedbackResult(
  result:
    | Awaited<ReturnType<typeof submitFeedback>>
    | Awaited<ReturnType<typeof submitPendingFeedback>>,
  json: boolean,
): void {
  if (json) {
    printJson(buildFeedbackJsonResult(result));
    return;
  }

  if ("submittedCount" in result) {
    if (result.submittedCount === 0 && result.failureCount === 0) {
      console.log("No pending feedback files were found.");
      return;
    }

    const lines = [
      `Submitted ${result.submittedCount} pending feedback file(s) to ${result.repository}.`,
    ];

    for (const item of result.submitted) {
      lines.push(
        `- ${formatFeedbackDisplayPath(item.filePath)} -> ${item.url}`,
      );
    }

    if (result.failureCount > 0) {
      lines.push(
        `${result.failureCount} pending feedback file(s) could not be submitted.`,
      );
      for (const item of result.failures) {
        lines.push(
          `- ${formatFeedbackDisplayPath(item.filePath)}: ${item.error}`,
        );
      }
    }

    console.log(lines.join("\n"));
    return;
  }

  if (result.status === "submitted") {
    console.log(`Feedback filed: ${result.url ?? result.repository}`);
    return;
  }

  console.log(
    [
      `Feedback saved locally: ${formatFeedbackDisplayPath(result.pendingFilePath ?? "")}`,
      "To submit: run `gh auth login` then `linkedin-buddy feedback --submit-pending`",
    ].join("\n"),
  );
}

async function promptForFeedbackType(): Promise<FeedbackType> {
  assertInteractiveTerminal("collect feedback interactively");

  while (true) {
    const value = await promptTextInput(
      `Feedback type (${FEEDBACK_TYPES.join("/")})`,
      process.stderr,
    );

    try {
      return normalizeFeedbackInputType(value);
    } catch {
      writeCliWarning(`Please enter one of: ${FEEDBACK_TYPES.join(", ")}.`);
    }
  }
}

async function promptForRequiredFeedbackText(
  label: string,
  question: string,
  multiline: boolean = false,
): Promise<string> {
  assertInteractiveTerminal("collect feedback interactively");

  while (true) {
    const value = multiline
      ? await promptMultilineInput(question, process.stderr)
      : await promptTextInput(question, process.stderr);
    const normalized = trimOptionalCliText(value);

    if (normalized) {
      return normalized;
    }

    writeCliWarning(`${label} must not be empty.`);
  }
}

async function runFeedbackCommand(input: {
  description?: string;
  json: boolean;
  submitPending: boolean;
  title?: string;
  type?: string;
}): Promise<void> {
  if (input.submitPending) {
    const result = await submitPendingFeedback();
    printFeedbackResult(result, input.json);
    return;
  }

  const snapshot = await readFeedbackStateSnapshot();
  const type = input.type
    ? normalizeFeedbackInputType(input.type)
    : await promptForFeedbackType();
  const title =
    trimOptionalCliText(input.title) ??
    (await promptForRequiredFeedbackText("title", "Short summary"));
  const description =
    trimOptionalCliText(input.description) ??
    (await promptForRequiredFeedbackText(
      "description",
      "Detailed explanation.",
      true,
    ));

  const result = await submitFeedback({
    type,
    title,
    description,
    technicalContext: createFeedbackTechnicalContext({
      cliVersion: packageJson.version,
      snapshot,
      source: "cli",
    }),
  });

  printFeedbackResult(result, input.json);
}

function assertNoExternalSessionOverrideForStoredSession(
  cdpUrl?: string,
): void {
  if (!cdpUrl) {
    return;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    "Stored-session auth and read-only live validation do not support --cdp-url. Omit --cdp-url to use the encrypted stored session flow.",
  );
}

async function captureStoredSession(input: {
  sessionName: string;
  timeoutMinutes: number;
}): Promise<Awaited<ReturnType<typeof captureLinkedInSession>>> {
  writeCliNotice(
    `Opening a dedicated Chromium window to capture session "${input.sessionName}".`,
  );
  writeCliNotice(
    "Sign in manually. The browser closes automatically after the authenticated session is stored.",
  );
  writeCliNotice(
    "Leave the LinkedIn window open after sign-in until the CLI confirms the session was captured. Press Ctrl+C if you need to cancel.",
  );

  return captureLinkedInSession({
    sessionName: input.sessionName,
    timeoutMs: input.timeoutMinutes * 60_000,
  });
}

async function runAuthSessionCapture(
  input: {
    sessionName: string;
    timeoutMinutes: number;
  },
  cdpUrl?: string,
): Promise<void> {
  assertNoExternalSessionOverrideForStoredSession(cdpUrl);
  assertInteractiveTerminal("capture a stored LinkedIn session");

  const result = await captureStoredSession(input);
  printJson({
    authenticated: result.authenticated,
    captured_at: result.capturedAt,
    checked_at: result.checkedAt,
    current_url: result.currentUrl,
    li_at_expires_at: result.liAtCookieExpiresAt,
    session_file: result.filePath,
    session_name: result.sessionName,
  });
}

async function runManualLogin(
  input: {
    sessionName: string;
    timeoutMinutes: number;
    evasionLevel?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  assertNoExternalSessionOverrideForStoredSession(cdpUrl);
  assertInteractiveTerminal(
    "capture a stored LinkedIn session via manual login",
  );

  writeCliNotice(
    `Opening a stealth-hardened Chromium window to capture session "${input.sessionName}".`,
  );
  writeCliNotice(
    "Sign in manually. The browser closes automatically after the authenticated session is stored.",
  );
  writeCliNotice(
    "Leave the LinkedIn window open after sign-in until the CLI confirms the session was captured. Press Ctrl+C if you need to cancel.",
  );

  const result = await captureLinkedInSession({
    sessionName: input.sessionName,
    timeoutMs: input.timeoutMinutes * 60_000,
    stealth: true,
    ...(input.evasionLevel ? { evasionLevel: input.evasionLevel } : {}),
  });

  printJson({
    authenticated: result.authenticated,
    captured_at: result.capturedAt,
    checked_at: result.checkedAt,
    current_url: result.currentUrl,
    li_at_expires_at: result.liAtCookieExpiresAt,
    session_file: result.filePath,
    session_name: result.sessionName,
    ...(result.fingerprint ? { fingerprint_captured: true } : {}),
    ...(result.fingerprintPath
      ? { fingerprint_path: result.fingerprintPath }
      : {}),
  });
}

async function runAuthWhoami(sessionName: string): Promise<void> {
  const result = await getAuthWhoami(sessionName);
  printJson({
    authenticated: result.authenticated,
    profile_name: result.profileName,
    full_name: result.fullName,
    vanity_name: result.vanityName,
    session_age: result.sessionAge,
    session_valid: result.sessionValid,
    session_expires_at: result.sessionExpiresAt,
    session_expires_in_ms: result.sessionExpiresInMs,
    identity_cached_at: result.identityCachedAt,
    guidance: result.guidance,
  });

  if (!result.authenticated) {
    process.exitCode = 1;
  }
}

async function runSessionCheck(sessionName: string): Promise<void> {
  const result = await checkStoredSessionHealth(sessionName);
  printJson({
    healthy: result.healthy,
    session_name: result.sessionName,
    checked_at: result.checkedAt,
    reason: result.reason,
    session_exists: result.sessionExists,
    has_auth_cookie: result.hasAuthCookie,
    auth_cookie_expires_at: result.authCookieExpiresAt,
    auth_cookie_expires_in_ms: result.authCookieExpiresInMs,
    has_browser_fingerprint: result.hasBrowserFingerprint,
    cookie_count: result.cookieCount,
    guidance: result.guidance,
  });

  if (!result.healthy) {
    process.exitCode = 1;
  }
}

function isStoredSessionRefreshError(error: unknown): boolean {
  return (
    error instanceof LinkedInBuddyError &&
    (error.code === "AUTH_REQUIRED" || error.code === "CAPTCHA_OR_CHALLENGE")
  );
}

async function maybeRefreshStoredSession(
  input: {
    sessionName: string;
    timeoutMinutes: number;
    yes: boolean;
  },
  error: unknown,
  promptOutput: typeof stdout | typeof process.stderr,
): Promise<boolean> {
  if (
    input.yes ||
    !stdin.isTTY ||
    !stdout.isTTY ||
    !isStoredSessionRefreshError(error)
  ) {
    return false;
  }

  const errorPayload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);
  writeCliNotice(
    errorPayload.code === "CAPTCHA_OR_CHALLENGE"
      ? "LinkedIn requested extra verification before the validation could continue."
      : `Stored session "${input.sessionName}" needs to be refreshed before the validation can continue.`,
  );
  const confirmed = await promptYesNo(
    `Capture a fresh stored session named "${input.sessionName}" now?`,
    promptOutput,
  );
  if (!confirmed) {
    return false;
  }

  await captureStoredSession({
    sessionName: input.sessionName,
    timeoutMinutes: input.timeoutMinutes,
  });
  return true;
}

function createReadOnlyValidationPrompter(
  sessionName: string,
  promptOutput: typeof stdout | typeof process.stderr,
): (operation: LinkedInReadOnlyValidationOperation) => Promise<void> {
  return async (operation) => {
    promptOutput.write(`Read-only step: ${operation.summary}\n`);
    const confirmed = await promptYesNo(
      "Continue with this step?",
      promptOutput,
    );
    if (!confirmed) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "Read-only live validation was cancelled by the operator.",
        {
          operation: operation.id,
          session_name: sessionName,
        },
      );
    }
  };
}

function emitReadOnlyValidationResult(
  report: ReadOnlyValidationReport,
  outputMode: ReadOnlyValidationOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
  } else {
    const redactedReport = redactStructuredValue(
      report,
      cliPrivacyConfig,
      "cli",
    ) as typeof report;
    console.log(
      formatReadOnlyValidationReport(redactedReport, {
        color: shouldUseAnsiColor(stdout),
      }),
    );
  }

  if (report.outcome === "fail") {
    process.exitCode = LIVE_VALIDATION_FAIL_EXIT_CODE;
  }
}

function emitReadOnlyValidationFailure(
  error: unknown,
  outputMode: ReadOnlyValidationOutputMode,
): void {
  process.exitCode = LIVE_VALIDATION_ERROR_EXIT_CODE;

  if (outputMode === "json") {
    throw error;
  }

  const errorPayload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);
  process.stderr.write(
    `${formatReadOnlyValidationError(errorPayload, {
      color: shouldUseAnsiColor(process.stderr),
      helpCommand: LIVE_VALIDATION_HELP_COMMAND,
    })}\n`,
  );
}

function validateReadOnlyValidationCliInput(input: {
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): void {
  if (input.retryMaxDelayMs < input.retryBaseDelayMs) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "retry-max-delay-ms must be greater than or equal to retry-base-delay-ms.",
      {
        retry_base_delay_ms: input.retryBaseDelayMs,
        retry_max_delay_ms: input.retryMaxDelayMs,
      },
    );
  }
}

async function runLiveReadOnlyValidation(
  input: {
    json: boolean;
    maxRequests: number;
    maxRetries: number;
    minIntervalMs: number;
    progress: boolean;
    readOnly: boolean;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    sessionName: string;
    timeoutSeconds: number;
    yes: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const outputMode = resolveReadOnlyValidationOutputMode(
    { json: input.json },
    Boolean(stdout.isTTY),
  );
  const promptOutput = outputMode === "json" ? process.stderr : stdout;
  const progressEnabled =
    outputMode === "human" && input.progress && Boolean(process.stderr.isTTY);
  const progressReporter = new ReadOnlyValidationProgressReporter({
    enabled: progressEnabled,
  });

  try {
    assertNoExternalSessionOverrideForStoredSession(cdpUrl);
    validateReadOnlyValidationCliInput(input);

    if (!input.readOnly) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        'Live validation is currently restricted to read-only mode. Rerun the command with "--read-only".',
      );
    }

    if (!input.yes) {
      assertInteractiveTerminal(
        "run interactive live validation without --yes",
      );
    }

    const runValidation = async () => {
      const onBeforeOperation = input.yes
        ? undefined
        : createReadOnlyValidationPrompter(input.sessionName, promptOutput);

      return runReadOnlyLinkedInLiveValidation({
        maxRequests: input.maxRequests,
        maxRetries: input.maxRetries,
        minIntervalMs: input.minIntervalMs,
        ...(progressEnabled
          ? {
              onLog: (entry) => {
                progressReporter.handleLog(entry);
              },
            }
          : {}),
        sessionName: input.sessionName,
        ...(onBeforeOperation ? { onBeforeOperation } : {}),
        retryBaseDelayMs: input.retryBaseDelayMs,
        retryMaxDelayMs: input.retryMaxDelayMs,
        timeoutMs: input.timeoutSeconds * 1_000,
      });
    };

    try {
      const report = await runValidation();
      emitReadOnlyValidationResult(report, outputMode);
    } catch (error) {
      const refreshed = await maybeRefreshStoredSession(
        {
          sessionName: input.sessionName,
          timeoutMinutes: Math.max(1, Math.ceil(input.timeoutSeconds / 60)),
          yes: input.yes,
        },
        error,
        promptOutput,
      );

      if (refreshed) {
        try {
          const report = await runValidation();
          emitReadOnlyValidationResult(report, outputMode);
        } catch (retryError) {
          emitReadOnlyValidationFailure(retryError, outputMode);
        }
        return;
      }

      emitReadOnlyValidationFailure(error, outputMode);
    }
  } catch (error) {
    emitReadOnlyValidationFailure(error, outputMode);
  }
}

async function runRateLimitStatus(clear: boolean): Promise<void> {
  if (clear) {
    await clearRateLimitState();
    printJson({
      cleared: true,
    });
    return;
  }

  const status = await isInRateLimitCooldown();
  printJson(status);
}

interface KeepAliveCliOutputOptions {
  outputMode: KeepAliveOutputMode;
  quiet: boolean;
  verbose: boolean;
}

function emitKeepAliveStartReport(
  report: KeepAliveStartReport,
  options: KeepAliveCliOutputOptions,
): void {
  if (options.outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatKeepAliveStartReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as KeepAliveStartReport,
      {
        quiet: options.quiet,
        verbose: options.verbose,
      },
    ),
  );
}

function emitKeepAliveStatusReport(
  report: KeepAliveStatusReport,
  options: KeepAliveCliOutputOptions,
): void {
  if (options.outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatKeepAliveStatusReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as KeepAliveStatusReport,
      {
        quiet: options.quiet,
        verbose: options.verbose,
      },
    ),
  );
}

function emitKeepAliveStopReport(
  report: KeepAliveStopReport,
  options: KeepAliveCliOutputOptions,
): void {
  if (options.outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatKeepAliveStopReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as KeepAliveStopReport,
      {
        quiet: options.quiet,
        verbose: options.verbose,
      },
    ),
  );
}

function writeKeepAliveProgressNotice(
  outputMode: KeepAliveOutputMode,
  quiet: boolean,
  message: string,
): void {
  if (outputMode === "human" && !quiet) {
    writeCliNotice(message);
  }
}

function warnAboutExternalCdpDaemonSession(): void {
  writeCliWarning(
    "--cdp-url attaches this daemon to an existing browser session.",
  );
  writeCliNotice(
    "The daemon will share cookies and session state with that browser until you stop it.",
  );
  writeCliNotice("For an isolated tool-owned profile, omit --cdp-url.");
}

function assertKeepAliveVerbosityOptions(input: {
  quiet?: boolean;
  verbose?: boolean;
}): void {
  if (input.quiet && input.verbose) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      'Choose either "--quiet" or "--verbose", not both.',
    );
  }
}

async function runKeepAliveCliAction(
  input: { json?: boolean; quiet?: boolean; verbose?: boolean },
  action: (options: KeepAliveCliOutputOptions) => Promise<void>,
): Promise<void> {
  const options: KeepAliveCliOutputOptions = {
    outputMode: resolveKeepAliveOutputMode(input, Boolean(stdout.isTTY)),
    quiet: Boolean(input.quiet),
    verbose: Boolean(input.verbose),
  };

  try {
    assertKeepAliveVerbosityOptions(input);
    await action(options);
  } catch (error) {
    if (options.outputMode === "json") {
      throw error;
    }

    process.stderr.write(
      `${formatKeepAliveError(
        toLinkedInBuddyErrorPayload(error, cliPrivacyConfig),
        {
          quiet: options.quiet,
        },
      )}\n`,
    );
    process.exitCode = 1;
  }
}

async function buildKeepAliveStatusReport(
  profileName: string,
): Promise<KeepAliveStatusReport> {
  const normalizedProfileName = coerceProfileName(profileName);
  const pid = await readKeepAlivePid(normalizedProfileName);
  const state = await readKeepAliveState(normalizedProfileName);
  const running = typeof pid === "number" ? isProcessRunning(pid) : false;
  const files = getKeepAliveFiles(normalizedProfileName);

  return {
    profile_name: normalizedProfileName,
    running,
    pid: typeof pid === "number" ? pid : null,
    state,
    stale_pid_file: Boolean(pid && !running),
    state_path: files.statePath,
    log_path: files.logPath,
    recent_events: await readKeepAliveRecentEvents(normalizedProfileName),
  };
}

async function runKeepAliveStart(
  input: {
    profileName: string;
    intervalSeconds: number;
    jitterSeconds: number;
    maxConsecutiveFailures: number;
  },
  options: KeepAliveCliOutputOptions,
  cdpUrl?: string,
): Promise<void> {
  const profileName = coerceProfileName(input.profileName);
  const files = getKeepAliveFiles(profileName);
  const existingPid = await readKeepAlivePid(profileName);
  if (existingPid && isProcessRunning(existingPid)) {
    const currentState = await readKeepAliveState(profileName);
    emitKeepAliveStartReport(
      {
        started: false,
        reason: "Keepalive daemon is already running for this profile.",
        profile_name: profileName,
        pid: existingPid,
        state: currentState,
        state_path: files.statePath,
        log_path: files.logPath,
      },
      options,
    );
    return;
  }

  const recoveredStalePid = Boolean(
    existingPid && !isProcessRunning(existingPid),
  );
  if (existingPid && !isProcessRunning(existingPid)) {
    await removeKeepAlivePid(profileName);
  }

  maybeWarnAboutSelectorLocaleConfig(cliSelectorLocale);
  if (cdpUrl) {
    warnAboutExternalCdpDaemonSession();
  }
  writeKeepAliveProgressNotice(
    options.outputMode,
    options.quiet,
    `Starting keepalive daemon for profile ${profileName}.`,
  );

  const cliEntrypoint = resolveKeepAliveCliEntrypoint();
  if (!cliEntrypoint) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Could not resolve CLI entrypoint for keepalive daemon startup.",
    );
  }

  const daemonArgs = [cliEntrypoint];
  if (cdpUrl) {
    daemonArgs.push("--cdp-url", cdpUrl);
  }
  if (cliSelectorLocale) {
    daemonArgs.push("--selector-locale", cliSelectorLocale);
  }
  daemonArgs.push(
    "keepalive",
    "__run",
    "--profile",
    profileName,
    "--interval-seconds",
    String(input.intervalSeconds),
    "--jitter-seconds",
    String(input.jitterSeconds),
    "--max-consecutive-failures",
    String(input.maxConsecutiveFailures),
  );

  const daemon = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  daemon.unref();

  if (!daemon.pid) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Keepalive daemon did not return a process id.",
    );
  }

  const now = new Date().toISOString();
  const initialState: KeepAliveState = {
    pid: daemon.pid,
    profileName,
    startedAt: now,
    updatedAt: now,
    status: "starting",
    intervalMs: input.intervalSeconds * 1_000,
    jitterMs: input.jitterSeconds * 1_000,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
    consecutiveFailures: 0,
    healthCheckInProgress: false,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeKeepAlivePid(profileName, daemon.pid);
  await writeKeepAliveState(profileName, initialState);

  writeKeepAliveProgressNotice(
    options.outputMode,
    options.quiet,
    "The first session health check will continue in the background; use `linkedin keepalive status` to inspect it.",
  );

  emitKeepAliveStartReport(
    {
      started: true,
      profile_name: profileName,
      pid: daemon.pid,
      state: initialState,
      state_path: files.statePath,
      log_path: files.logPath,
      ...(recoveredStalePid ? { recovered_stale_pid: true } : {}),
    },
    options,
  );
}

function resolveKeepAliveCliEntrypoint(): string | undefined {
  const overrideEntrypoint = process.env.LINKEDIN_CLI_ENTRYPOINT;
  if (overrideEntrypoint && overrideEntrypoint.trim().length > 0) {
    return overrideEntrypoint.trim();
  }

  const compiledEntrypoint = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../dist/bin/linkedin.js",
  );
  if (existsSync(compiledEntrypoint)) {
    return compiledEntrypoint;
  }

  return process.argv[1];
}

async function runKeepAliveStatus(
  profileName: string,
  options: KeepAliveCliOutputOptions,
): Promise<void> {
  emitKeepAliveStatusReport(
    await buildKeepAliveStatusReport(profileName),
    options,
  );
}

async function runKeepAliveStop(
  profileName: string,
  options: KeepAliveCliOutputOptions,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const files = getKeepAliveFiles(normalizedProfileName);
  const pid = await readKeepAlivePid(normalizedProfileName);
  const previousState = await readKeepAliveState(normalizedProfileName);

  if (!pid) {
    emitKeepAliveStopReport(
      {
        stopped: false,
        profile_name: normalizedProfileName,
        reason: "No keepalive daemon is currently running for this profile.",
        state: previousState,
        state_path: files.statePath,
        log_path: files.logPath,
      },
      options,
    );
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeKeepAlivePid(normalizedProfileName);
    const now = new Date().toISOString();
    if (previousState) {
      await writeKeepAliveState(normalizedProfileName, {
        ...previousState,
        status: "stopped",
        updatedAt: now,
        stoppedAt: now,
        lastError: "Recovered from stale pid file.",
      });
    }
    emitKeepAliveStopReport(
      {
        stopped: true,
        profile_name: normalizedProfileName,
        pid,
        reason: "Removed a stale keepalive PID file for this profile.",
        state: await readKeepAliveState(normalizedProfileName),
        state_path: files.statePath,
        log_path: files.logPath,
      },
      options,
    );
    return;
  }

  writeKeepAliveProgressNotice(
    options.outputMode,
    options.quiet,
    `Stopping keepalive daemon for profile ${normalizedProfileName}.`,
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Failed to send SIGTERM to keepalive daemon.",
      {
        profile_name: normalizedProfileName,
        pid,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const deadline = Date.now() + 5_000;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(200);
    running = isProcessRunning(pid);
    if (!running) {
      break;
    }
  }

  if (running) {
    process.kill(pid, "SIGKILL");
  }

  await removeKeepAlivePid(normalizedProfileName);
  const now = new Date().toISOString();
  if (previousState) {
    await writeKeepAliveState(normalizedProfileName, {
      ...previousState,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
      ...(running
        ? { lastError: "Keepalive daemon required SIGKILL to stop." }
        : {}),
    });
  }

  const nextState = await readKeepAliveState(normalizedProfileName);
  emitKeepAliveStopReport(
    {
      stopped: true,
      profile_name: normalizedProfileName,
      pid,
      forced: running,
      reason: running
        ? "Keepalive daemon did not exit after SIGTERM, so it was force-stopped."
        : "Keepalive daemon exited cleanly.",
      state: nextState,
      state_path: files.statePath,
      log_path: files.logPath,
    },
    options,
  );
}

async function runKeepAliveDaemon(
  input: {
    profileName: string;
    intervalSeconds: number;
    jitterSeconds: number;
    maxConsecutiveFailures: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const profileName = coerceProfileName(input.profileName);
  let stopRequested = false;
  let consecutiveFailures = 0;

  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  const initialState: KeepAliveState = {
    pid: process.pid,
    profileName,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    intervalMs: input.intervalSeconds * 1_000,
    jitterMs: input.jitterSeconds * 1_000,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
    consecutiveFailures: 0,
    healthCheckInProgress: false,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeKeepAlivePid(profileName, process.pid);
  await writeKeepAliveState(profileName, initialState);
  await appendKeepAliveEvent(profileName, {
    ts: new Date().toISOString(),
    event: "keepalive.daemon.started",
    pid: process.pid,
    profile_name: profileName,
    cdp_url: cdpUrl ?? null,
    interval_ms: input.intervalSeconds * 1_000,
    jitter_ms: input.jitterSeconds * 1_000,
    max_consecutive_failures: input.maxConsecutiveFailures,
  });

  try {
    while (!stopRequested) {
      const tickAt = new Date().toISOString();
      const currentState =
        (await readKeepAliveState(profileName)) ?? initialState;
      const inProgressState: KeepAliveState = {
        ...currentState,
        pid: process.pid,
        profileName,
        updatedAt: tickAt,
        intervalMs: input.intervalSeconds * 1_000,
        jitterMs: input.jitterSeconds * 1_000,
        maxConsecutiveFailures: input.maxConsecutiveFailures,
        lastCheckStartedAt: tickAt,
        healthCheckInProgress: true,
      };

      await writeKeepAliveState(profileName, inProgressState);
      await appendKeepAliveEvent(profileName, {
        ts: tickAt,
        event: "keepalive.tick.started",
        profile_name: profileName,
        interval_ms: input.intervalSeconds * 1_000,
        jitter_ms: input.jitterSeconds * 1_000,
      });

      try {
        const health = await runtime.healthCheck({ profileName });
        const healthy = health.browser.healthy && health.session.authenticated;
        consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;

        const nextState: KeepAliveState = {
          ...inProgressState,
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= input.maxConsecutiveFailures
              ? "degraded"
              : "running",
          intervalMs: input.intervalSeconds * 1_000,
          jitterMs: input.jitterSeconds * 1_000,
          maxConsecutiveFailures: input.maxConsecutiveFailures,
          consecutiveFailures,
          lastTickAt: tickAt,
          authenticated: health.session.authenticated,
          browserHealthy: health.browser.healthy,
          currentUrl: health.session.currentUrl,
          reason: health.session.reason,
          healthCheckInProgress: false,
        };
        if (healthy) {
          nextState.lastHealthyAt = tickAt;
          delete nextState.lastError;
        }

        await writeKeepAliveState(profileName, nextState);
        await appendKeepAliveEvent(profileName, {
          ts: tickAt,
          event: "keepalive.tick",
          profile_name: profileName,
          healthy,
          consecutive_failures: consecutiveFailures,
          browser_healthy: health.browser.healthy,
          authenticated: health.session.authenticated,
          reason: health.session.reason,
          interval_ms: input.intervalSeconds * 1_000,
          jitter_ms: input.jitterSeconds * 1_000,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lockHeld = isProfileLockHeldError(error);
        if (!lockHeld) {
          consecutiveFailures += 1;
        }

        const nextState: KeepAliveState = {
          ...inProgressState,
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= input.maxConsecutiveFailures
              ? "degraded"
              : "running",
          intervalMs: input.intervalSeconds * 1_000,
          jitterMs: input.jitterSeconds * 1_000,
          maxConsecutiveFailures: input.maxConsecutiveFailures,
          consecutiveFailures,
          lastTickAt: tickAt,
          lastError: message,
          healthCheckInProgress: false,
        };
        await writeKeepAliveState(profileName, nextState);
        await appendKeepAliveEvent(profileName, {
          ts: tickAt,
          event: lockHeld ? "keepalive.tick.skipped" : "keepalive.tick.error",
          profile_name: profileName,
          consecutive_failures: consecutiveFailures,
          error: message,
          interval_ms: input.intervalSeconds * 1_000,
          jitter_ms: input.jitterSeconds * 1_000,
          ...(lockHeld ? { reason: "profile_lock_held" } : {}),
        });
      }

      if (stopRequested) {
        break;
      }

      const jitter = (Math.random() * 2 - 1) * (input.jitterSeconds * 1_000);
      let sleepRemainingMs = Math.max(
        1_000,
        input.intervalSeconds * 1_000 + jitter,
      );
      while (!stopRequested && sleepRemainingMs > 0) {
        const chunkMs = Math.min(500, sleepRemainingMs);
        await sleep(chunkMs);
        sleepRemainingMs -= chunkMs;
      }
    }
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);

    const now = new Date().toISOString();
    const lastState = (await readKeepAliveState(profileName)) ?? initialState;
    await writeKeepAliveState(profileName, {
      ...lastState,
      pid: process.pid,
      profileName,
      status: "stopped",
      updatedAt: now,
      healthCheckInProgress: false,
      stoppedAt: now,
    });
    await appendKeepAliveEvent(profileName, {
      ts: now,
      event: "keepalive.daemon.stopped",
      pid: process.pid,
      profile_name: profileName,
      final_consecutive_failures: consecutiveFailures,
    });

    await removeKeepAlivePid(profileName).catch(() => undefined);
    runtime.close();
  }
}

function summarizeSchedulerTick(
  result: SchedulerTickResult,
): SchedulerStateSummary {
  return {
    skippedReason: result.skippedReason,
    discoveredAcceptedConnections: result.discoveredAcceptedConnections,
    queuedJobs: result.queuedJobs,
    updatedJobs: result.updatedJobs,
    reopenedJobs: result.reopenedJobs,
    cancelledJobs: result.cancelledJobs,
    claimedJobs: result.claimedJobs,
    preparedJobs: result.preparedJobs,
    rescheduledJobs: result.rescheduledJobs,
    failedJobs: result.failedJobs,
  };
}

function writeSchedulerProgressNotice(
  outputMode: SchedulerOutputMode,
  message: string,
): void {
  if (outputMode === "human" && process.stderr.isTTY) {
    writeCliNotice(message);
  }
}

function tryParseSchedulerJobTargetLabel(
  job: SchedulerJobRow,
): string | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(job.target_json) as unknown;
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const profileUrlKey = record.profile_url_key;
  if (typeof profileUrlKey === "string" && profileUrlKey.trim().length > 0) {
    return profileUrlKey.trim();
  }

  const profileName = record.profile_name;
  if (typeof profileName === "string" && profileName.trim().length > 0) {
    return profileName.trim();
  }

  return undefined;
}

function createSchedulerJobPreview(job: SchedulerJobRow): SchedulerJobPreview {
  const targetLabel = tryParseSchedulerJobTargetLabel(job);

  return {
    id: job.id,
    lane: job.lane,
    status: job.status,
    ...(targetLabel ? { targetLabel } : {}),
    scheduledAt: new Date(job.scheduled_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    preparedActionId: job.prepared_action_id,
    lastErrorCode: job.last_error_code,
    lastErrorMessage: job.last_error_message,
  };
}

function createEmptySchedulerJobCounts(): SchedulerJobCounts {
  return {
    total: 0,
    pending: 0,
    pendingDueNow: 0,
    pendingLater: 0,
    leased: 0,
    prepared: 0,
    failed: 0,
    cancelled: 0,
  };
}

async function listSchedulerJobRows(
  profileName: string,
): Promise<SchedulerJobRow[]> {
  const { dbPath } = resolveConfigPaths();
  if (!(await pathExists(dbPath))) {
    return [];
  }

  const db = new AssistantDatabase(dbPath);
  try {
    return db.listSchedulerJobs({ profileName });
  } finally {
    db.close();
  }
}

function summarizeSchedulerJobRows(input: {
  jobs: SchedulerJobRow[];
  nowMs: number;
  jobLimit: number;
}): Pick<SchedulerStatusReport, "job_counts" | "next_jobs" | "recent_jobs"> {
  const jobCounts = createEmptySchedulerJobCounts();

  for (const job of input.jobs) {
    jobCounts.total += 1;
    if (job.status === "pending") {
      jobCounts.pending += 1;
      if (job.scheduled_at <= input.nowMs) {
        jobCounts.pendingDueNow += 1;
      } else {
        jobCounts.pendingLater += 1;
      }
      continue;
    }

    if (job.status === "leased") {
      jobCounts.leased += 1;
      continue;
    }

    if (job.status === "prepared") {
      jobCounts.prepared += 1;
      continue;
    }

    if (job.status === "failed") {
      jobCounts.failed += 1;
      continue;
    }

    if (job.status === "cancelled") {
      jobCounts.cancelled += 1;
    }
  }

  const next_jobs = input.jobs
    .filter((job) => job.status === "pending" || job.status === "leased")
    .sort((left, right) => left.scheduled_at - right.scheduled_at)
    .slice(0, input.jobLimit)
    .map((job) => createSchedulerJobPreview(job));
  const recent_jobs = input.jobs
    .filter(
      (job) =>
        job.status === "prepared" ||
        job.status === "failed" ||
        job.status === "cancelled",
    )
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, input.jobLimit)
    .map((job) => createSchedulerJobPreview(job));

  return {
    job_counts: jobCounts,
    next_jobs,
    recent_jobs,
  };
}

function resolveSchedulerStatusConfig(): Pick<
  SchedulerStatusReport,
  "scheduler_config" | "scheduler_config_error"
> {
  try {
    return {
      scheduler_config: resolveSchedulerConfig(),
    };
  } catch (error) {
    return {
      scheduler_config_error: toLinkedInBuddyErrorPayload(
        error,
        cliPrivacyConfig,
      ),
    };
  }
}

function inferSchedulerNextWindowStartAt(
  state: SchedulerState | null,
  schedulerConfig?: SchedulerConfig,
): string | undefined {
  if (!state) {
    return undefined;
  }

  if (
    typeof state.nextWindowStartAt === "string" ||
    state.nextWindowStartAt === null
  ) {
    return state.nextWindowStartAt ?? undefined;
  }

  const nowMs = Date.now();
  const alignedAtMs = alignToBusinessHours(
    nowMs,
    schedulerConfig?.businessHours ?? state.businessHours,
  );
  return alignedAtMs > nowMs ? new Date(alignedAtMs).toISOString() : undefined;
}

async function buildSchedulerStatusReport(
  profileName: string,
  jobLimit: number,
): Promise<SchedulerStatusReport> {
  const pid = await readSchedulerPid(profileName);
  const state = await readSchedulerState(profileName);
  const running = typeof pid === "number" ? isProcessRunning(pid) : false;
  const files = getSchedulerFiles(profileName);
  const configInfo = resolveSchedulerStatusConfig();
  const jobs = await listSchedulerJobRows(profileName);
  const jobSummary = summarizeSchedulerJobRows({
    jobs,
    nowMs: Date.now(),
    jobLimit,
  });

  const nextWindowStartAt = inferSchedulerNextWindowStartAt(
    state,
    configInfo.scheduler_config,
  );

  return {
    profile_name: profileName,
    running,
    pid: typeof pid === "number" ? pid : null,
    state:
      state === null
        ? null
        : {
            ...state,
            ...(nextWindowStartAt !== undefined ? { nextWindowStartAt } : {}),
          },
    stale_pid_file: Boolean(pid && !running),
    state_path: files.statePath,
    log_path: files.logPath,
    ...configInfo,
    ...jobSummary,
  };
}

function emitSchedulerStartReport(
  report: SchedulerStartReport,
  outputMode: SchedulerOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatSchedulerStartReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as SchedulerStartReport,
    ),
  );
}

function emitSchedulerStatusReport(
  report: SchedulerStatusReport,
  outputMode: SchedulerOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatSchedulerStatusReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as SchedulerStatusReport,
    ),
  );
}

function emitSchedulerStopReport(
  report: SchedulerStopReport,
  outputMode: SchedulerOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatSchedulerStopReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as SchedulerStopReport,
    ),
  );
}

function emitSchedulerRunOnceReport(
  report: SchedulerRunOnceReport,
  outputMode: SchedulerOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatSchedulerRunOnceReport(
      redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as SchedulerRunOnceReport,
    ),
  );
}

async function runSchedulerCliAction(
  input: { json?: boolean },
  action: (outputMode: SchedulerOutputMode) => Promise<void>,
): Promise<void> {
  const outputMode = resolveSchedulerOutputMode(input, Boolean(stdout.isTTY));

  try {
    await action(outputMode);
  } catch (error) {
    if (outputMode === "json") {
      throw error;
    }

    process.stderr.write(
      `${formatSchedulerError(
        toLinkedInBuddyErrorPayload(error, cliPrivacyConfig),
      )}\n`,
    );
    process.exitCode = 1;
  }
}

async function runSchedulerRunOnce(
  profileName: string,
  outputMode: SchedulerOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  writeSchedulerProgressNotice(
    outputMode,
    `Running one scheduler tick for profile ${normalizedProfileName}; this may take a moment.`,
  );
  const runtime = createRuntime(cdpUrl);
  const schedulerConfig = resolveSchedulerConfig();

  try {
    const scheduler = new LinkedInSchedulerService({
      db: runtime.db,
      logger: runtime.logger,
      followups: runtime.followups,
      schedulerConfig,
    });
    const result = await scheduler.runTick({
      profileName: normalizedProfileName,
      workerId: `cli:${runtime.runId}`,
    });

    if (result.failedJobs > 0) {
      process.exitCode = 1;
    }

    emitSchedulerRunOnceReport(
      {
        run_id: runtime.runId,
        scheduler_config: schedulerConfig,
        ...result,
      },
      outputMode,
    );
  } finally {
    runtime.close();
  }
}

async function runSchedulerStart(
  profileName: string,
  outputMode: SchedulerOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const files = getSchedulerFiles(normalizedProfileName);
  const existingPid = await readSchedulerPid(normalizedProfileName);
  if (existingPid && isProcessRunning(existingPid)) {
    const currentState = await readSchedulerState(normalizedProfileName);
    emitSchedulerStartReport(
      {
        started: false,
        reason: "Scheduler daemon is already running for this profile.",
        profile_name: normalizedProfileName,
        pid: existingPid,
        state: currentState,
        state_path: files.statePath,
        log_path: files.logPath,
        ...resolveSchedulerStatusConfig(),
      },
      outputMode,
    );
    return;
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await removeSchedulerPid(normalizedProfileName);
  }

  maybeWarnAboutSelectorLocaleConfig(cliSelectorLocale);

  writeSchedulerProgressNotice(
    outputMode,
    `Starting scheduler daemon for profile ${normalizedProfileName}.`,
  );
  const schedulerConfig = resolveSchedulerConfig();
  const cliEntrypoint = resolveKeepAliveCliEntrypoint();
  if (!cliEntrypoint) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Could not resolve CLI entrypoint for scheduler daemon startup.",
    );
  }

  const daemonArgs = [cliEntrypoint];
  if (cdpUrl) {
    daemonArgs.push("--cdp-url", cdpUrl);
  }
  if (cliSelectorLocale) {
    daemonArgs.push("--selector-locale", cliSelectorLocale);
  }
  daemonArgs.push("scheduler", "__run", "--profile", normalizedProfileName);

  const daemon = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  daemon.unref();

  if (!daemon.pid) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Scheduler daemon did not return a process id.",
    );
  }

  const now = new Date().toISOString();
  const initialState: SchedulerState = {
    pid: daemon.pid,
    profileName: normalizedProfileName,
    startedAt: now,
    updatedAt: now,
    status: "starting",
    pollIntervalMs: schedulerConfig.pollIntervalMs,
    businessHours: schedulerConfig.businessHours,
    maxJobsPerTick: schedulerConfig.maxJobsPerTick,
    maxActiveJobsPerProfile: schedulerConfig.maxActiveJobsPerProfile,
    consecutiveFailures: 0,
    maxConsecutiveFailures: SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeSchedulerPid(normalizedProfileName, daemon.pid);
  await writeSchedulerState(normalizedProfileName, initialState);

  emitSchedulerStartReport(
    {
      started: true,
      profile_name: normalizedProfileName,
      pid: daemon.pid,
      state_path: files.statePath,
      log_path: files.logPath,
      scheduler_config: schedulerConfig,
    },
    outputMode,
  );
}

async function runSchedulerStatus(
  profileName: string,
  outputMode: SchedulerOutputMode,
  jobLimit: number,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const report = await buildSchedulerStatusReport(
    normalizedProfileName,
    jobLimit,
  );
  emitSchedulerStatusReport(report, outputMode);
}

async function runSchedulerStop(
  profileName: string,
  outputMode: SchedulerOutputMode,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const files = getSchedulerFiles(normalizedProfileName);
  const pid = await readSchedulerPid(normalizedProfileName);
  const previousState = await readSchedulerState(normalizedProfileName);

  if (!pid) {
    emitSchedulerStopReport(
      {
        stopped: false,
        profile_name: normalizedProfileName,
        reason: "No scheduler daemon is currently running for this profile.",
        state_path: files.statePath,
        log_path: files.logPath,
      },
      outputMode,
    );
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeSchedulerPid(normalizedProfileName);
    const now = new Date().toISOString();
    if (previousState) {
      await writeSchedulerState(normalizedProfileName, {
        ...previousState,
        status: "stopped",
        updatedAt: now,
        stoppedAt: now,
        lastError: "Recovered from stale pid file.",
      });
    }
    emitSchedulerStopReport(
      {
        stopped: true,
        profile_name: normalizedProfileName,
        pid,
        reason: "Removed a stale scheduler PID file for this profile.",
        state_path: files.statePath,
        log_path: files.logPath,
      },
      outputMode,
    );
    return;
  }

  writeSchedulerProgressNotice(
    outputMode,
    `Stopping scheduler daemon for profile ${normalizedProfileName}.`,
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Failed to send SIGTERM to scheduler daemon.",
      {
        profile_name: normalizedProfileName,
        pid,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const deadline = Date.now() + 5_000;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(200);
    running = isProcessRunning(pid);
    if (!running) {
      break;
    }
  }

  if (running) {
    process.kill(pid, "SIGKILL");
  }

  await removeSchedulerPid(normalizedProfileName);
  const now = new Date().toISOString();
  if (previousState) {
    await writeSchedulerState(normalizedProfileName, {
      ...previousState,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
      ...(running
        ? { lastError: "Scheduler daemon required SIGKILL to stop." }
        : {}),
    });
  }

  emitSchedulerStopReport(
    {
      stopped: true,
      profile_name: normalizedProfileName,
      pid,
      forced: running,
      reason: running
        ? "Scheduler daemon did not exit after SIGTERM, so it was force-stopped."
        : "Scheduler daemon exited cleanly.",
      state_path: files.statePath,
      log_path: files.logPath,
    },
    outputMode,
  );
}

async function runSchedulerDaemon(
  profileName: string,
  cdpUrl?: string,
): Promise<void> {
  const schedulerConfig = resolveSchedulerConfig();
  let stopRequested = false;
  let consecutiveFailures = 0;

  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  const startedAt = new Date().toISOString();
  const initialState: SchedulerState = {
    pid: process.pid,
    profileName,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    pollIntervalMs: schedulerConfig.pollIntervalMs,
    businessHours: schedulerConfig.businessHours,
    maxJobsPerTick: schedulerConfig.maxJobsPerTick,
    maxActiveJobsPerProfile: schedulerConfig.maxActiveJobsPerProfile,
    consecutiveFailures: 0,
    maxConsecutiveFailures: SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeSchedulerPid(profileName, process.pid);
  await writeSchedulerState(profileName, initialState);
  await appendSchedulerEvent(profileName, {
    ts: startedAt,
    event: "scheduler.daemon.started",
    pid: process.pid,
    profile_name: profileName,
    cdp_url: cdpUrl ?? null,
    scheduler_config: schedulerConfig,
  });

  try {
    while (!stopRequested) {
      const tickAt = new Date().toISOString();

      try {
        const runtime = createRuntime(cdpUrl);

        try {
          const scheduler = new LinkedInSchedulerService({
            db: runtime.db,
            logger: runtime.logger,
            followups: runtime.followups,
            schedulerConfig,
          });
          const result = await scheduler.runTick({
            profileName,
            workerId: `scheduler-daemon:${process.pid}`,
          });

          consecutiveFailures = 0;
          const nextState: SchedulerState = {
            ...((await readSchedulerState(profileName)) ?? initialState),
            pid: process.pid,
            profileName,
            updatedAt: tickAt,
            status:
              result.skippedReason === "outside_business_hours" ||
              result.skippedReason === "profile_busy" ||
              result.skippedReason === "disabled" ||
              result.claimedJobs === 0
                ? "idle"
                : "running",
            pollIntervalMs: schedulerConfig.pollIntervalMs,
            businessHours: schedulerConfig.businessHours,
            maxJobsPerTick: schedulerConfig.maxJobsPerTick,
            maxActiveJobsPerProfile: schedulerConfig.maxActiveJobsPerProfile,
            consecutiveFailures,
            maxConsecutiveFailures: SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES,
            lastTickAt: tickAt,
            lastSuccessfulTickAt: tickAt,
            nextWindowStartAt: result.nextWindowStartAt,
            lastSummary: summarizeSchedulerTick(result),
          };
          if (result.preparedJobs > 0) {
            nextState.lastPreparedAt = tickAt;
          }
          delete nextState.lastError;

          await writeSchedulerState(profileName, nextState);
          await appendSchedulerEvent(profileName, {
            ts: tickAt,
            event:
              result.skippedReason === null
                ? "scheduler.tick"
                : "scheduler.tick.skipped",
            profile_name: profileName,
            summary: summarizeSchedulerTick(result),
            skipped_reason: result.skippedReason,
            next_window_start_at: result.nextWindowStartAt,
          });
        } finally {
          runtime.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lockHeld = isProfileLockHeldError(error);
        if (!lockHeld) {
          consecutiveFailures += 1;
        }

        const nextState: SchedulerState = {
          ...((await readSchedulerState(profileName)) ?? initialState),
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES
              ? "degraded"
              : "running",
          pollIntervalMs: schedulerConfig.pollIntervalMs,
          businessHours: schedulerConfig.businessHours,
          maxJobsPerTick: schedulerConfig.maxJobsPerTick,
          maxActiveJobsPerProfile: schedulerConfig.maxActiveJobsPerProfile,
          consecutiveFailures,
          maxConsecutiveFailures: SCHEDULER_DAEMON_MAX_CONSECUTIVE_FAILURES,
          lastTickAt: tickAt,
          lastError: message,
        };
        await writeSchedulerState(profileName, nextState);
        await appendSchedulerEvent(profileName, {
          ts: tickAt,
          event: lockHeld ? "scheduler.tick.skipped" : "scheduler.tick.error",
          profile_name: profileName,
          consecutive_failures: consecutiveFailures,
          error: message,
          ...(lockHeld ? { reason: "profile_lock_held" } : {}),
        });
      }

      if (stopRequested) {
        break;
      }

      let sleepRemainingMs = Math.max(1_000, schedulerConfig.pollIntervalMs);
      while (!stopRequested && sleepRemainingMs > 0) {
        const chunkMs = Math.min(500, sleepRemainingMs);
        await sleep(chunkMs);
        sleepRemainingMs -= chunkMs;
      }
    }
  } finally {
    const now = new Date().toISOString();
    const lastState = (await readSchedulerState(profileName)) ?? initialState;
    await writeSchedulerState(profileName, {
      ...lastState,
      pid: process.pid,
      profileName,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
    });
    await appendSchedulerEvent(profileName, {
      ts: now,
      event: "scheduler.daemon.stopped",
      pid: process.pid,
      profile_name: profileName,
    });

    await removeSchedulerPid(profileName).catch(() => undefined);
  }
}

interface ActivityFiles {
  dir: string;
  pidPath: string;
  statePath: string;
  logPath: string;
}

const ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES = 5;
const DIAGNOSTIC_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;

function normalizeDiagnosticKey(key: string | undefined): string {
  return (key ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function sanitizeDiagnosticText(value: string): string {
  return value.replace(DIAGNOSTIC_URL_PATTERN, (candidate) => {
    const trimmed = candidate.replace(/[),.;]+$/u, "");
    const trailing = candidate.slice(trimmed.length);
    return `${sanitizeDiagnosticUrl(trimmed)}${trailing}`;
  });
}

function sanitizeActivityPersistenceValue(
  value: unknown,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeActivityPersistenceValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeActivityPersistenceValue(entryValue, entryKey);
    }
    return output;
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalizedKey = normalizeDiagnosticKey(key);
  const sanitizedText = sanitizeDiagnosticText(value);

  if (
    normalizedKey === "cdp_url" ||
    normalizedKey === "cdpurl" ||
    normalizedKey === "error" ||
    normalizedKey === "last_error" ||
    normalizedKey.endsWith("_message")
  ) {
    return sanitizedText;
  }

  return sanitizedText;
}

function sanitizeActivityPersistenceRecord<T extends object>(
  value: T,
  surface: "log" | "storage",
): T {
  return redactStructuredValue(
    sanitizeActivityPersistenceValue(value) as T,
    cliPrivacyConfig,
    surface,
  );
}

function asCliObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Activity target must be a JSON object.",
    );
  }

  return value as Record<string, unknown>;
}

function parseJsonObjectString(
  value: string,
  label: string,
): Record<string, unknown> {
  try {
    return asCliObject(JSON.parse(value));
  } catch (error) {
    if (error instanceof LinkedInBuddyError) {
      throw error;
    }

    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be valid JSON object text.`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function readActivityTargetInput(input: {
  target?: string;
  targetFile?: string;
}): Promise<Record<string, unknown> | undefined> {
  const target = typeof input.target === "string" ? input.target.trim() : "";
  const targetFile =
    typeof input.targetFile === "string" ? input.targetFile.trim() : "";

  if (target && targetFile) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Specify either --target or --target-file, not both.",
    );
  }

  if (targetFile) {
    return asCliObject(await readJsonInputFile(targetFile, "activity target"));
  }

  if (target) {
    return parseJsonObjectString(target, "--target");
  }

  return undefined;
}

function coerceEnumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  const normalized = value.trim();
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `${label} must be one of: ${allowed.join(", ")}.`,
  );
}

function coerceActivityEventTypes(
  values: string[] | undefined,
): ActivityEventType[] {
  if (!values || values.length === 0) {
    return [];
  }

  return values.map((value) =>
    coerceEnumValue(value, ACTIVITY_EVENT_TYPES, "event"),
  );
}

function coerceActivityWatchKind(value: string): ActivityWatchKind {
  return coerceEnumValue(value, ACTIVITY_WATCH_KINDS, "kind");
}

function coerceActivityWatchStatusValue(value: string): ActivityWatchStatus {
  return coerceEnumValue(value, ACTIVITY_WATCH_STATUSES, "status");
}

function coerceWebhookSubscriptionStatusValue(
  value: string,
): WebhookSubscriptionStatus {
  return coerceEnumValue(value, WEBHOOK_SUBSCRIPTION_STATUSES, "status");
}

function coerceWebhookDeliveryStatusValue(
  value: string,
): WebhookDeliveryAttemptStatus {
  return coerceEnumValue(value, WEBHOOK_DELIVERY_ATTEMPT_STATUSES, "status");
}

function getActivityFiles(profileName: string): ActivityFiles {
  const slug = profileSlug(profileName);
  const dir = path.join(resolveConfigPaths().baseDir, "activity");
  return {
    dir,
    pidPath: path.join(dir, `${slug}.pid`),
    statePath: path.join(dir, `${slug}.state.json`),
    logPath: path.join(dir, `${slug}.events.jsonl`),
  };
}

async function ensureActivityDir(files: ActivityFiles): Promise<void> {
  await mkdir(files.dir, { recursive: true });
}

async function readActivityPid(profileName: string): Promise<number | null> {
  const files = getActivityFiles(profileName);
  try {
    const raw = await readFile(files.pidPath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeActivityPid(
  profileName: string,
  pid: number,
): Promise<void> {
  const files = getActivityFiles(profileName);
  await ensureActivityDir(files);
  await writeFile(files.pidPath, `${pid}\n`, "utf8");
}

async function removeActivityPid(profileName: string): Promise<void> {
  const files = getActivityFiles(profileName);
  try {
    await unlink(files.pidPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readActivityState(
  profileName: string,
): Promise<ActivityDaemonState | null> {
  const files = getActivityFiles(profileName);
  return readJsonFile<ActivityDaemonState>(files.statePath);
}

async function writeActivityState(
  profileName: string,
  state: ActivityDaemonState,
): Promise<void> {
  const files = getActivityFiles(profileName);
  await ensureActivityDir(files);
  await writeJsonFile(
    files.statePath,
    sanitizeActivityPersistenceRecord(state, "storage"),
  );
}

async function appendActivityEvent(
  profileName: string,
  event: Record<string, unknown>,
): Promise<void> {
  const files = getActivityFiles(profileName);
  await ensureActivityDir(files);
  await appendFile(
    files.logPath,
    `${JSON.stringify(sanitizeActivityPersistenceRecord(event, "log"))}\n`,
    "utf8",
  );
}

function summarizeActivityTick(
  result: ActivityPollTickResult,
): ActivityDaemonStateSummary {
  return {
    claimedWatches: result.claimedWatches,
    polledWatches: result.polledWatches,
    failedWatches: result.failedWatches,
    emittedEvents: result.emittedEvents,
    enqueuedDeliveries: result.enqueuedDeliveries,
    claimedDeliveries: result.claimedDeliveries,
    deliveredAttempts: result.deliveredAttempts,
    retriedDeliveries: result.retriedDeliveries,
    failedDeliveries: result.failedDeliveries,
    deadLetterDeliveries: result.deadLetterDeliveries,
    disabledSubscriptions: result.disabledSubscriptions,
  };
}

function resolveActivityStatusConfig(): Pick<
  ActivityStatusReport,
  "activity_config" | "activity_config_error"
> {
  try {
    return {
      activity_config: resolveActivityWebhookConfig(),
    };
  } catch (error) {
    return {
      activity_config_error: toLinkedInBuddyErrorPayload(
        error,
        cliPrivacyConfig,
      ),
    };
  }
}

function emitActivityReport<Report extends object>(
  report: Report,
  outputMode: ActivityOutputMode,
  formatter: (report: Report) => string,
): void {
  if (outputMode === "json") {
    printJson(report);
    return;
  }

  console.log(
    formatter(redactStructuredValue(report, cliPrivacyConfig, "cli") as Report),
  );
}

async function runActivityCliAction(
  input: { json?: boolean },
  action: (outputMode: ActivityOutputMode) => Promise<void>,
): Promise<void> {
  const outputMode = resolveActivityOutputMode(input, Boolean(stdout.isTTY));

  try {
    await action(outputMode);
  } catch (error) {
    if (outputMode === "json") {
      throw error;
    }

    process.stderr.write(
      `${formatActivityError(
        toLinkedInBuddyErrorPayload(error, cliPrivacyConfig),
      )}\n`,
    );
    process.exitCode = 1;
  }
}

async function runActivityWatchAdd(
  input: {
    profileName: string;
    kind: ActivityWatchKind;
    target?: Record<string, unknown>;
    intervalSeconds?: number;
    cron?: string;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.watch.add.start", {
      kind: input.kind,
      output_mode: outputMode,
      profile_name: input.profileName,
      schedule_kind: input.cron ? "cron" : "interval",
    });

    const watch = runtime.activityWatches.createWatch({
      profileName: input.profileName,
      kind: input.kind,
      ...(input.target ? { target: input.target } : {}),
      ...(typeof input.intervalSeconds === "number"
        ? { intervalSeconds: input.intervalSeconds }
        : {}),
      ...(input.cron ? { cron: input.cron } : {}),
    });

    runtime.logger.log("info", "cli.activity.watch.add.done", {
      kind: watch.kind,
      profile_name: input.profileName,
      watch_id: watch.id,
    });

    const report: ActivityWatchAddReport = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      watch,
    };
    emitActivityReport(report, outputMode, formatActivityWatchAddReport);
  } finally {
    runtime.close();
  }
}

async function runActivityWatchList(
  input: {
    profileName: string;
    status?: ActivityWatchStatus;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.watch.list.start", {
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
    });

    const watches = runtime.activityWatches.listWatches({
      profileName: input.profileName,
      ...(input.status ? { status: input.status } : {}),
    });

    runtime.logger.log("info", "cli.activity.watch.list.done", {
      count: watches.length,
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
    });

    const report: ActivityWatchListReport = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: watches.length,
      watches,
    };
    emitActivityReport(report, outputMode, formatActivityWatchListReport);
  } finally {
    runtime.close();
  }
}

async function runActivityWatchPause(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.watch.pause.start", {
      watch_id: id,
    });

    const watch = runtime.activityWatches.pauseWatch(id);

    runtime.logger.log("info", "cli.activity.watch.pause.done", {
      profile_name: watch.profileName,
      watch_id: watch.id,
    });

    const report: ActivityWatchMutationReport = {
      run_id: runtime.runId,
      watch,
    };
    emitActivityReport(report, outputMode, (value) =>
      formatActivityWatchMutationReport(value, "paused"),
    );
  } finally {
    runtime.close();
  }
}

async function runActivityWatchResume(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.watch.resume.start", {
      watch_id: id,
    });

    const watch = runtime.activityWatches.resumeWatch(id);

    runtime.logger.log("info", "cli.activity.watch.resume.done", {
      profile_name: watch.profileName,
      watch_id: watch.id,
    });

    const report: ActivityWatchMutationReport = {
      run_id: runtime.runId,
      watch,
    };
    emitActivityReport(report, outputMode, (value) =>
      formatActivityWatchMutationReport(value, "resumed"),
    );
  } finally {
    runtime.close();
  }
}

async function runActivityWatchRemove(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.watch.remove.start", {
      watch_id: id,
    });

    const removed = runtime.activityWatches.removeWatch(id);

    runtime.logger.log("info", "cli.activity.watch.remove.done", {
      removed,
      watch_id: id,
    });

    const report: ActivityWatchRemovalReport = {
      run_id: runtime.runId,
      watch_id: id,
      removed,
    };
    emitActivityReport(report, outputMode, formatActivityWatchRemovalReport);
  } finally {
    runtime.close();
  }
}

async function runActivityWebhookAdd(
  input: {
    watchId: string;
    deliveryUrl: string;
    eventTypes?: ActivityEventType[];
    signingSecret?: string;
    maxAttempts?: number;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.webhook.add.start", {
      delivery_url: input.deliveryUrl,
      output_mode: outputMode,
      watch_id: input.watchId,
    });

    const subscription = runtime.activityWatches.createWebhookSubscription({
      watchId: input.watchId,
      deliveryUrl: input.deliveryUrl,
      ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
      ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
      ...(typeof input.maxAttempts === "number"
        ? { maxAttempts: input.maxAttempts }
        : {}),
    });

    runtime.logger.log("info", "cli.activity.webhook.add.done", {
      webhook_subscription_id: subscription.id,
      watch_id: subscription.watchId,
    });

    const report: ActivityWebhookAddReport = {
      run_id: runtime.runId,
      subscription,
    };
    emitActivityReport(report, outputMode, formatActivityWebhookAddReport);
  } finally {
    runtime.close();
  }
}

async function runActivityWebhookList(
  input: {
    profileName: string;
    watchId?: string;
    status?: WebhookSubscriptionStatus;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.webhook.list.start", {
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const subscriptions = runtime.activityWatches.listWebhookSubscriptions({
      profileName: input.profileName,
      ...(input.watchId ? { watchId: input.watchId } : {}),
      ...(input.status ? { status: input.status } : {}),
    });

    runtime.logger.log("info", "cli.activity.webhook.list.done", {
      count: subscriptions.length,
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const report: ActivityWebhookListReport = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: subscriptions.length,
      subscriptions,
    };
    emitActivityReport(report, outputMode, formatActivityWebhookListReport);
  } finally {
    runtime.close();
  }
}

async function runActivityWebhookPause(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.webhook.pause.start", {
      webhook_subscription_id: id,
    });

    const subscription = runtime.activityWatches.pauseWebhookSubscription(id);

    runtime.logger.log("info", "cli.activity.webhook.pause.done", {
      webhook_subscription_id: subscription.id,
      watch_id: subscription.watchId,
    });

    const report: ActivityWebhookMutationReport = {
      run_id: runtime.runId,
      subscription,
    };
    emitActivityReport(report, outputMode, (value) =>
      formatActivityWebhookMutationReport(value, "paused"),
    );
  } finally {
    runtime.close();
  }
}

async function runActivityWebhookResume(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.webhook.resume.start", {
      webhook_subscription_id: id,
    });

    const subscription = runtime.activityWatches.resumeWebhookSubscription(id);

    runtime.logger.log("info", "cli.activity.webhook.resume.done", {
      webhook_subscription_id: subscription.id,
      watch_id: subscription.watchId,
    });

    const report: ActivityWebhookMutationReport = {
      run_id: runtime.runId,
      subscription,
    };
    emitActivityReport(report, outputMode, (value) =>
      formatActivityWebhookMutationReport(value, "resumed"),
    );
  } finally {
    runtime.close();
  }
}

async function runActivityWebhookRemove(
  id: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.webhook.remove.start", {
      webhook_subscription_id: id,
    });

    const removed = runtime.activityWatches.removeWebhookSubscription(id);

    runtime.logger.log("info", "cli.activity.webhook.remove.done", {
      removed,
      webhook_subscription_id: id,
    });

    const report: ActivityWebhookRemovalReport = {
      run_id: runtime.runId,
      subscription_id: id,
      removed,
    };
    emitActivityReport(report, outputMode, formatActivityWebhookRemovalReport);
  } finally {
    runtime.close();
  }
}

async function runActivityEventsList(
  input: {
    profileName: string;
    watchId?: string;
    limit: number;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.events.list.start", {
      limit: input.limit,
      profile_name: input.profileName,
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const events = runtime.activityWatches.listEvents({
      profileName: input.profileName,
      ...(input.watchId ? { watchId: input.watchId } : {}),
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.activity.events.list.done", {
      count: events.length,
      profile_name: input.profileName,
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const report: ActivityEventListReport = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: events.length,
      events,
    };
    emitActivityReport(report, outputMode, formatActivityEventListReport);
  } finally {
    runtime.close();
  }
}

async function runActivityDeliveriesList(
  input: {
    profileName: string;
    watchId?: string;
    subscriptionId?: string;
    status?: WebhookDeliveryAttemptStatus;
    limit: number;
  },
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.activity.deliveries.list.start", {
      limit: input.limit,
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
      ...(input.subscriptionId
        ? { subscription_id: input.subscriptionId }
        : {}),
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const deliveries = runtime.activityWatches.listDeliveries({
      profileName: input.profileName,
      ...(input.watchId ? { watchId: input.watchId } : {}),
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
      ...(input.status ? { status: input.status } : {}),
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.activity.deliveries.list.done", {
      count: deliveries.length,
      profile_name: input.profileName,
      ...(input.status ? { status: input.status } : {}),
      ...(input.subscriptionId
        ? { subscription_id: input.subscriptionId }
        : {}),
      ...(input.watchId ? { watch_id: input.watchId } : {}),
    });

    const report: ActivityDeliveryListReport = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: deliveries.length,
      deliveries,
    };
    emitActivityReport(report, outputMode, formatActivityDeliveryListReport);
  } finally {
    runtime.close();
  }
}

async function runActivityRunOnce(
  profileName: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const runtime = createRuntime(cdpUrl);
  const activityConfig = resolveActivityWebhookConfig();

  try {
    runtime.logger.log("info", "cli.activity.run_once.start", {
      profile_name: normalizedProfileName,
      worker_id: `cli:${runtime.runId}`,
    });

    if (outputMode === "human") {
      writeCliNotice(
        `Running one activity polling tick for profile "${normalizedProfileName}".`,
      );
    }

    const result = await runtime.activityPoller.runTick({
      profileName: normalizedProfileName,
      workerId: `cli:${runtime.runId}`,
    });

    if (
      result.failedWatches > 0 ||
      result.failedDeliveries > 0 ||
      result.deadLetterDeliveries > 0
    ) {
      process.exitCode = 1;
    }

    runtime.logger.log("info", "cli.activity.run_once.done", {
      dead_letter_deliveries: result.deadLetterDeliveries,
      failed_deliveries: result.failedDeliveries,
      failed_watches: result.failedWatches,
      profile_name: normalizedProfileName,
      worker_id: result.workerId,
    });

    const report: ActivityRunOnceReport = {
      run_id: runtime.runId,
      profile_name: normalizedProfileName,
      activity_config: activityConfig,
      ...result,
    };
    emitActivityReport(report, outputMode, formatActivityRunOnceReport);
  } finally {
    runtime.close();
  }
}

async function runActivityStart(
  profileName: string,
  outputMode: ActivityOutputMode,
  cdpUrl?: string,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const files = getActivityFiles(normalizedProfileName);
  const existingPid = await readActivityPid(normalizedProfileName);
  if (existingPid && isProcessRunning(existingPid)) {
    const report: ActivityStartReport = {
      started: false,
      reason: "Activity daemon is already running for this profile.",
      profile_name: normalizedProfileName,
      pid: existingPid,
      state: await readActivityState(normalizedProfileName),
      state_path: files.statePath,
      log_path: files.logPath,
      ...resolveActivityStatusConfig(),
    };
    emitActivityReport(report, outputMode, formatActivityStartReport);
    return;
  }

  if (existingPid && !isProcessRunning(existingPid)) {
    await removeActivityPid(normalizedProfileName);
  }

  if (cdpUrl) {
    warnAboutExternalCdpDaemonSession();
  }
  maybeWarnAboutSelectorLocaleConfig(cliSelectorLocale);

  if (outputMode === "human") {
    writeCliNotice(
      `Starting the activity daemon for profile "${normalizedProfileName}".`,
    );
  }

  const activityConfig = resolveActivityWebhookConfig();
  const cliEntrypoint = resolveKeepAliveCliEntrypoint();
  if (!cliEntrypoint) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Could not resolve CLI entrypoint for activity daemon startup.",
    );
  }

  const daemonArgs = [cliEntrypoint];
  if (cdpUrl) {
    daemonArgs.push("--cdp-url", cdpUrl);
  }
  if (cliSelectorLocale) {
    daemonArgs.push("--selector-locale", cliSelectorLocale);
  }
  daemonArgs.push("activity", "__run", "--profile", normalizedProfileName);

  const daemon = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  daemon.unref();

  if (!daemon.pid) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Activity daemon did not return a process id.",
    );
  }

  const now = new Date().toISOString();
  const initialState: ActivityDaemonState = {
    pid: daemon.pid,
    profileName: normalizedProfileName,
    startedAt: now,
    updatedAt: now,
    status: "starting",
    daemonPollIntervalMs: activityConfig.daemonPollIntervalMs,
    maxWatchesPerTick: activityConfig.maxWatchesPerTick,
    maxDeliveriesPerTick: activityConfig.maxDeliveriesPerTick,
    consecutiveFailures: 0,
    maxConsecutiveFailures: ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeActivityPid(normalizedProfileName, daemon.pid);
  await writeActivityState(normalizedProfileName, initialState);

  const report: ActivityStartReport = {
    started: true,
    profile_name: normalizedProfileName,
    pid: daemon.pid,
    state_path: files.statePath,
    log_path: files.logPath,
    activity_config: activityConfig,
  };
  emitActivityReport(report, outputMode, formatActivityStartReport);
}

async function runActivityStatus(
  profileName: string,
  outputMode: ActivityOutputMode,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const pid = await readActivityPid(normalizedProfileName);
  const state = await readActivityState(normalizedProfileName);
  const running = typeof pid === "number" ? isProcessRunning(pid) : false;
  const files = getActivityFiles(normalizedProfileName);
  const db = new AssistantDatabase(resolveConfigPaths().dbPath);

  try {
    const watches = db.listActivityWatches({
      profileName: normalizedProfileName,
    });
    const subscriptions = db.listWebhookSubscriptions({
      profileName: normalizedProfileName,
    });
    const recentEvents = db.listActivityEvents({
      profileName: normalizedProfileName,
      limit: 5,
    });
    const recentDeliveries = db.listWebhookDeliveryAttempts({
      profileName: normalizedProfileName,
      limit: 5,
    });

    const report: ActivityStatusReport = {
      profile_name: normalizedProfileName,
      running,
      pid: typeof pid === "number" ? pid : null,
      state,
      stale_pid_file: Boolean(pid && !running),
      state_path: files.statePath,
      log_path: files.logPath,
      watch_count: watches.length,
      active_watch_count: watches.filter((watch) => watch.status === "active")
        .length,
      subscription_count: subscriptions.length,
      active_subscription_count: subscriptions.filter(
        (subscription) => subscription.status === "active",
      ).length,
      recent_event_count: recentEvents.length,
      recent_delivery_count: recentDeliveries.length,
      ...resolveActivityStatusConfig(),
    };

    if (report.activity_config_error) {
      process.exitCode = 1;
    }

    emitActivityReport(report, outputMode, formatActivityStatusReport);
  } finally {
    db.close();
  }
}

async function runActivityStop(
  profileName: string,
  outputMode: ActivityOutputMode,
): Promise<void> {
  const normalizedProfileName = coerceProfileName(profileName);
  const files = getActivityFiles(normalizedProfileName);
  const pid = await readActivityPid(normalizedProfileName);
  const previousState = await readActivityState(normalizedProfileName);

  if (!pid) {
    const report: ActivityStopReport = {
      stopped: false,
      profile_name: normalizedProfileName,
      reason: "No activity daemon is currently running for this profile.",
      state_path: files.statePath,
      log_path: files.logPath,
    };
    emitActivityReport(report, outputMode, formatActivityStopReport);
    return;
  }

  if (!isProcessRunning(pid)) {
    await removeActivityPid(normalizedProfileName);
    const now = new Date().toISOString();
    if (previousState) {
      await writeActivityState(normalizedProfileName, {
        ...previousState,
        status: "stopped",
        updatedAt: now,
        stoppedAt: now,
        lastError: "Recovered from stale pid file.",
      });
    }
    const report: ActivityStopReport = {
      stopped: true,
      profile_name: normalizedProfileName,
      pid,
      reason: "Removed a stale activity PID file for this profile.",
      state_path: files.statePath,
      log_path: files.logPath,
    };
    emitActivityReport(report, outputMode, formatActivityStopReport);
    return;
  }

  if (outputMode === "human") {
    writeCliNotice(
      `Stopping the activity daemon for profile "${normalizedProfileName}".`,
    );
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    throw new LinkedInBuddyError(
      "UNKNOWN",
      "Failed to send SIGTERM to activity daemon.",
      {
        profile_name: normalizedProfileName,
        pid,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const deadline = Date.now() + 5_000;
  let running = true;
  while (Date.now() < deadline) {
    await sleep(200);
    running = isProcessRunning(pid);
    if (!running) {
      break;
    }
  }

  if (running) {
    process.kill(pid, "SIGKILL");
  }

  await removeActivityPid(normalizedProfileName);
  const now = new Date().toISOString();
  if (previousState) {
    await writeActivityState(normalizedProfileName, {
      ...previousState,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
      ...(running
        ? { lastError: "Activity daemon required SIGKILL to stop." }
        : {}),
    });
  }

  const report: ActivityStopReport = {
    stopped: true,
    profile_name: normalizedProfileName,
    pid,
    forced: running,
    reason: running
      ? "Activity daemon did not exit after SIGTERM, so it was force-stopped."
      : "Activity daemon exited cleanly.",
    state_path: files.statePath,
    log_path: files.logPath,
  };
  emitActivityReport(report, outputMode, formatActivityStopReport);
}

async function runActivityDaemon(
  profileName: string,
  cdpUrl?: string,
): Promise<void> {
  const activityConfig = resolveActivityWebhookConfig();
  let stopRequested = false;
  let consecutiveFailures = 0;

  const requestStop = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  const startedAt = new Date().toISOString();
  const initialState: ActivityDaemonState = {
    pid: process.pid,
    profileName,
    startedAt,
    updatedAt: startedAt,
    status: "running",
    daemonPollIntervalMs: activityConfig.daemonPollIntervalMs,
    maxWatchesPerTick: activityConfig.maxWatchesPerTick,
    maxDeliveriesPerTick: activityConfig.maxDeliveriesPerTick,
    consecutiveFailures: 0,
    maxConsecutiveFailures: ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES,
    ...(cdpUrl ? { cdpUrl } : {}),
  };

  await writeActivityPid(profileName, process.pid);
  await writeActivityState(profileName, initialState);
  await appendActivityEvent(profileName, {
    ts: startedAt,
    event: "activity.daemon.started",
    pid: process.pid,
    profile_name: profileName,
    cdp_url: cdpUrl ?? null,
    activity_config: activityConfig,
  });

  try {
    while (!stopRequested) {
      const tickAt = new Date().toISOString();

      try {
        const runtime = createRuntime(cdpUrl);

        try {
          const result = await runtime.activityPoller.runTick({
            profileName,
            workerId: `activity-daemon:${process.pid}`,
          });

          consecutiveFailures = 0;
          const nextState: ActivityDaemonState = {
            ...((await readActivityState(profileName)) ?? initialState),
            pid: process.pid,
            profileName,
            updatedAt: tickAt,
            status:
              result.failedWatches > 0 ||
              result.failedDeliveries > 0 ||
              result.deadLetterDeliveries > 0
                ? "degraded"
                : result.claimedWatches === 0 && result.claimedDeliveries === 0
                  ? "idle"
                  : "running",
            daemonPollIntervalMs: activityConfig.daemonPollIntervalMs,
            maxWatchesPerTick: activityConfig.maxWatchesPerTick,
            maxDeliveriesPerTick: activityConfig.maxDeliveriesPerTick,
            consecutiveFailures,
            maxConsecutiveFailures: ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES,
            lastTickAt: tickAt,
            lastSuccessfulTickAt: tickAt,
            lastSummary: summarizeActivityTick(result),
          };
          delete nextState.lastError;

          await writeActivityState(profileName, nextState);
          await appendActivityEvent(profileName, {
            ts: tickAt,
            event: "activity.tick",
            profile_name: profileName,
            summary: summarizeActivityTick(result),
          });
        } finally {
          runtime.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lockHeld = isProfileLockHeldError(error);
        if (!lockHeld) {
          consecutiveFailures += 1;
        }

        const nextState: ActivityDaemonState = {
          ...((await readActivityState(profileName)) ?? initialState),
          pid: process.pid,
          profileName,
          updatedAt: tickAt,
          status:
            consecutiveFailures >= ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES
              ? "degraded"
              : "running",
          daemonPollIntervalMs: activityConfig.daemonPollIntervalMs,
          maxWatchesPerTick: activityConfig.maxWatchesPerTick,
          maxDeliveriesPerTick: activityConfig.maxDeliveriesPerTick,
          consecutiveFailures,
          maxConsecutiveFailures: ACTIVITY_DAEMON_MAX_CONSECUTIVE_FAILURES,
          lastTickAt: tickAt,
          lastError: message,
        };
        await writeActivityState(profileName, nextState);
        await appendActivityEvent(profileName, {
          ts: tickAt,
          event: lockHeld ? "activity.tick.skipped" : "activity.tick.error",
          profile_name: profileName,
          consecutive_failures: consecutiveFailures,
          error: message,
          ...(lockHeld ? { reason: "profile_lock_held" } : {}),
        });
      }

      if (stopRequested) {
        break;
      }

      let sleepRemainingMs = Math.max(
        1_000,
        activityConfig.daemonPollIntervalMs,
      );
      while (!stopRequested && sleepRemainingMs > 0) {
        const chunkMs = Math.min(500, sleepRemainingMs);
        await sleep(chunkMs);
        sleepRemainingMs -= chunkMs;
      }
    }
  } finally {
    const now = new Date().toISOString();
    const lastState = (await readActivityState(profileName)) ?? initialState;
    await writeActivityState(profileName, {
      ...lastState,
      pid: process.pid,
      profileName,
      status: "stopped",
      updatedAt: now,
      stoppedAt: now,
    });
    await appendActivityEvent(profileName, {
      ts: now,
      event: "activity.daemon.stopped",
      pid: process.pid,
      profile_name: profileName,
    });

    await removeActivityPid(profileName).catch(() => undefined);
  }
}

async function runLogin(
  profileName: string,
  timeoutMinutes: number,
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.login.start", {
      profileName,
      timeoutMinutes,
    });

    const result = await runtime.auth.openLogin({
      profileName,
      timeoutMs: timeoutMinutes * 60_000,
    });

    runtime.logger.log("info", "cli.login.done", {
      profileName,
      authenticated: result.authenticated,
      timedOut: result.timedOut,
    });

    printJson({ run_id: runtime.runId, ...result });

    if (!result.authenticated) {
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

async function runHeadlessLogin(
  input: {
    profileName: string;
    email: string;
    password: string;
    mfaCode?: string;
    mfaCallback?: () => Promise<string | undefined>;
    timeoutMinutes: number;
    headed?: boolean;
    headedFallback?: boolean;
    warmProfile?: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const progressEnabled = Boolean(process.stderr.isTTY);
  const progressReporter = new HeadlessLoginProgressReporter({
    enabled: progressEnabled,
  });

  if (progressEnabled) {
    attachHeadlessLoginLogObserver(runtime.logger, (entry) => {
      progressReporter.handleLog(entry);
    });
  }

  try {
    runtime.logger.log("info", "cli.login.headless.start", {
      profileName: input.profileName,
      email: input.email,
    });

    const result = await runtime.auth.headlessLogin({
      profileName: input.profileName,
      email: input.email,
      password: input.password,
      ...(typeof input.mfaCode === "string" ? { mfaCode: input.mfaCode } : {}),
      ...(input.mfaCallback ? { mfaCallback: input.mfaCallback } : {}),
      timeoutMs: input.timeoutMinutes * 60_000,
      ...(input.headed != null ? { headed: input.headed } : {}),
      ...(input.headedFallback != null
        ? { headedFallback: input.headedFallback }
        : {}),
      ...(input.warmProfile != null ? { warmProfile: input.warmProfile } : {}),
    });

    runtime.logger.log("info", "cli.login.headless.done", {
      profileName: input.profileName,
      authenticated: result.authenticated,
      timedOut: result.timedOut,
      checkpoint: result.checkpoint,
      checkpointType: result.checkpointType,
      mfaRequired: result.mfaRequired,
      rateLimitActive: result.rateLimitActive,
      rateLimitUntil: result.rateLimitUntil,
    });

    printJson({ run_id: runtime.runId, ...result });

    if (!result.authenticated) {
      process.exitCode = 1;
    }
  } finally {
    runtime.close();
  }
}

async function runExportCookies(
  input: {
    profileName: string;
    outputPath: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.auth.exportCookies.start", {
      profileName: input.profileName,
      outputPath: input.outputPath,
    });

    const state = await runtime.profileManager.runWithContext(
      { cdpUrl, profileName: input.profileName },
      async (context) =>
        exportSessionState(context, input.outputPath, input.profileName),
    );

    const hasSession = hasLinkedInSessionToken(state);

    runtime.logger.log("info", "cli.auth.exportCookies.done", {
      profileName: input.profileName,
      outputPath: input.outputPath,
      cookieCount: state.cookies.length,
      hasSession,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      output_path: input.outputPath,
      cookie_count: state.cookies.length,
      has_session: hasSession,
      exported_at: state.exportedAt,
    });
  } finally {
    runtime.close();
  }
}

async function runImportCookies(
  input: {
    profileName: string;
    inputPath: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.auth.importCookies.start", {
      profileName: input.profileName,
      inputPath: input.inputPath,
    });

    const state = await runtime.profileManager.runWithContext(
      { cdpUrl, profileName: input.profileName },
      async (context) => importSessionState(context, input.inputPath),
    );

    const hasSession = hasLinkedInSessionToken(state);

    runtime.logger.log("info", "cli.auth.importCookies.done", {
      profileName: input.profileName,
      cookieCount: state.cookies.length,
      hasSession,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      input_path: input.inputPath,
      cookie_count: state.cookies.length,
      has_session: hasSession,
      imported_profile: state.profileName,
      exported_at: state.exportedAt,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxList(
  input: {
    profileName: string;
    limit: number;
    unreadOnly: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.list.start", {
      profileName: input.profileName,
      limit: input.limit,
      unreadOnly: input.unreadOnly,
    });

    const threads = await runtime.inbox.listThreads({
      profileName: input.profileName,
      limit: input.limit,
      unreadOnly: input.unreadOnly,
    });

    runtime.logger.log("info", "cli.inbox.list.done", {
      profileName: input.profileName,
      count: threads.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: threads.length,
      threads,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxShow(
  input: {
    profileName: string;
    thread: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.show.start", {
      profileName: input.profileName,
      thread: input.thread,
      limit: input.limit,
    });

    const thread = await runtime.inbox.getThread({
      profileName: input.profileName,
      thread: input.thread,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.inbox.show.done", {
      profileName: input.profileName,
      threadId: thread.thread_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      thread,
    });
  } finally {
    runtime.close();
  }
}

async function runPrepareReply(
  input: {
    profileName: string;
    thread: string;
    text: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.prepare_reply.start", {
      profileName: input.profileName,
      thread: input.thread,
    });

    const prepared = await runtime.inbox.prepareReply({
      profileName: input.profileName,
      thread: input.thread,
      text: input.text,
    });

    runtime.logger.log("info", "cli.inbox.prepare_reply.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxSearchRecipients(
  input: {
    profileName: string;
    query: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.search_recipients.start", {
      limit: input.limit,
      profileName: input.profileName,
      query: input.query,
    });

    const result = await runtime.inbox.searchRecipients({
      profileName: input.profileName,
      query: input.query,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.inbox.search_recipients.done", {
      count: result.count,
      profileName: input.profileName,
      query: input.query,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runPrepareNewThread(
  input: {
    profileName: string;
    recipients: string[];
    text: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.prepare_new_thread.start", {
      profileName: input.profileName,
      recipientCount: input.recipients.length,
    });

    const prepared = await runtime.inbox.prepareNewThread({
      profileName: input.profileName,
      recipients: input.recipients,
      text: input.text,
    });

    runtime.logger.log("info", "cli.inbox.prepare_new_thread.done", {
      preparedActionId: prepared.preparedActionId,
      profileName: input.profileName,
      recipientCount: input.recipients.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runPrepareAddRecipients(
  input: {
    profileName: string;
    recipients: string[];
    thread: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.prepare_add_recipients.start", {
      profileName: input.profileName,
      recipientCount: input.recipients.length,
      thread: input.thread,
    });

    const prepared = await runtime.inbox.prepareAddRecipients({
      profileName: input.profileName,
      recipients: input.recipients,
      thread: input.thread,
    });

    runtime.logger.log("info", "cli.inbox.prepare_add_recipients.done", {
      preparedActionId: prepared.preparedActionId,
      profileName: input.profileName,
      recipientCount: input.recipients.length,
      thread: input.thread,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxArchive(
  input: { profileName: string; thread: string },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.archive.start", {
      profileName: input.profileName,
      thread: input.thread,
    });

    const result = await runtime.inbox.archiveThread({
      profileName: input.profileName,
      thread: input.thread,
    });

    runtime.logger.log("info", "cli.inbox.archive.done", {
      profileName: input.profileName,
      threadId: result.thread_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxUnarchive(
  input: { profileName: string; thread: string },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.unarchive.start", {
      profileName: input.profileName,
      thread: input.thread,
    });

    const result = await runtime.inbox.unarchiveThread({
      profileName: input.profileName,
      thread: input.thread,
    });

    runtime.logger.log("info", "cli.inbox.unarchive.done", {
      profileName: input.profileName,
      threadId: result.thread_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxMarkUnread(
  input: { profileName: string; thread: string },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.mark_unread.start", {
      profileName: input.profileName,
      thread: input.thread,
    });

    const result = await runtime.inbox.markUnread({
      profileName: input.profileName,
      thread: input.thread,
    });

    runtime.logger.log("info", "cli.inbox.mark_unread.done", {
      profileName: input.profileName,
      threadId: result.thread_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runInboxMute(
  input: { profileName: string; thread: string },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.mute.start", {
      profileName: input.profileName,
      thread: input.thread,
    });

    const result = await runtime.inbox.muteThread({
      profileName: input.profileName,
      thread: input.thread,
    });

    runtime.logger.log("info", "cli.inbox.mute.done", {
      profileName: input.profileName,
      threadId: result.thread_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runPrepareReact(
  input: {
    profileName: string;
    thread: string;
    reaction?: string;
    messageIndex?: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.inbox.prepare_react.start", {
      profileName: input.profileName,
      thread: input.thread,
      reaction: input.reaction,
      messageIndex: input.messageIndex,
    });

    const prepared = await runtime.inbox.prepareReact({
      profileName: input.profileName,
      thread: input.thread,
      ...(input.reaction ? { reaction: input.reaction } : {}),
      ...(input.messageIndex !== undefined ? { messageIndex: input.messageIndex } : {}),
    });

    runtime.logger.log("info", "cli.inbox.prepare_react.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsList(
  input: {
    profileName: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.list.start", {
      profileName: input.profileName,
      limit: input.limit,
    });

    const connections = await runtime.connections.listConnections({
      profileName: input.profileName,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.connections.list.done", {
      profileName: input.profileName,
      count: connections.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: connections.length,
      connections,
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsPending(
  input: {
    profileName: string;
    filter: "sent" | "received" | "all";
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.pending.start", {
      profileName: input.profileName,
      filter: input.filter,
    });

    const invitations = await runtime.connections.listPendingInvitations({
      profileName: input.profileName,
      filter: input.filter,
    });

    runtime.logger.log("info", "cli.connections.pending.done", {
      profileName: input.profileName,
      count: invitations.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      filter: input.filter,
      count: invitations.length,
      invitations,
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsInvite(
  input: {
    profileName: string;
    targetProfile: string;
    note?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.invite.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    const prepared = runtime.connections.prepareSendInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
      ...(input.note ? { note: input.note } : {}),
    });

    runtime.logger.log("info", "cli.connections.invite.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsAccept(
  input: {
    profileName: string;
    targetProfile: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.accept.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    const prepared = runtime.connections.prepareAcceptInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    runtime.logger.log("info", "cli.connections.accept.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runConnectionsWithdraw(
  input: {
    profileName: string;
    targetProfile: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.connections.withdraw.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    const prepared = runtime.connections.prepareWithdrawInvitation({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    runtime.logger.log("info", "cli.connections.withdraw.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runMembersPrepareBlock(
  input: {
    profileName: string;
    targetProfile: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.members.prepare_block.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    const prepared = runtime.members.prepareBlockMember({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    runtime.logger.log("info", "cli.members.prepare_block.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runMembersPrepareUnblock(
  input: {
    profileName: string;
    targetProfile: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.members.prepare_unblock.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    const prepared = runtime.members.prepareUnblockMember({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
    });

    runtime.logger.log("info", "cli.members.prepare_unblock.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runMembersPrepareReport(
  input: {
    profileName: string;
    targetProfile: string;
    reason: string;
    details?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const reason = normalizeLinkedInMemberReportReason(input.reason);

  try {
    runtime.logger.log("info", "cli.members.prepare_report.start", {
      profileName: input.profileName,
      targetProfile: input.targetProfile,
      reason,
    });

    const prepared = runtime.members.prepareReportMember({
      profileName: input.profileName,
      targetProfile: input.targetProfile,
      reason,
      ...(input.details ? { details: input.details } : {}),
    });

    runtime.logger.log("info", "cli.members.prepare_report.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runPrivacyGetSettings(
  input: {
    profileName: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.privacy.get_settings.start", {
      profileName: input.profileName,
    });

    const settings = await runtime.privacySettings.getSettings({
      profileName: input.profileName,
    });

    runtime.logger.log("info", "cli.privacy.get_settings.done", {
      profileName: input.profileName,
      count: settings.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      settings,
    });
  } finally {
    runtime.close();
  }
}

async function runPrivacyPrepareUpdateSetting(
  input: {
    profileName: string;
    settingKey: string;
    value: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const settingKey = normalizeLinkedInPrivacySettingKey(input.settingKey);
  const value = normalizeLinkedInPrivacySettingValue(settingKey, input.value);

  try {
    runtime.logger.log("info", "cli.privacy.prepare_update_setting.start", {
      profileName: input.profileName,
      settingKey,
      value,
    });

    const prepared = runtime.privacySettings.prepareUpdateSetting({
      profileName: input.profileName,
      settingKey,
      value,
    });

    runtime.logger.log("info", "cli.privacy.prepare_update_setting.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFollowupsList(
  input: {
    profileName: string;
    since: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const { since, sinceMs } = resolveFollowupSinceWindow(input.since);

  try {
    runtime.logger.log("info", "cli.followups.list.start", {
      profileName: input.profileName,
      since,
    });

    const acceptedConnections = await runtime.followups.listAcceptedConnections(
      {
        profileName: input.profileName,
        since,
      },
    );

    runtime.logger.log("info", "cli.followups.list.done", {
      profileName: input.profileName,
      count: acceptedConnections.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      since,
      since_ms: sinceMs,
      since_at: new Date(sinceMs).toISOString(),
      count: acceptedConnections.length,
      accepted_connections: acceptedConnections,
    });
  } finally {
    runtime.close();
  }
}

async function runFollowupsPrepare(
  input: {
    profileName: string;
    since: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const { since, sinceMs } = resolveFollowupSinceWindow(input.since);

  try {
    runtime.logger.log("info", "cli.followups.prepare.start", {
      profileName: input.profileName,
      since,
    });

    const result = await runtime.followups.prepareFollowupsAfterAccept({
      profileName: input.profileName,
      since,
    });

    runtime.logger.log("info", "cli.followups.prepare.done", {
      profileName: input.profileName,
      acceptedConnectionCount: result.acceptedConnections.length,
      preparedCount: result.preparedFollowups.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      since,
      since_ms: sinceMs,
      since_at: new Date(sinceMs).toISOString(),
      accepted_connection_count: result.acceptedConnections.length,
      prepared_count: result.preparedFollowups.length,
      accepted_connections: result.acceptedConnections,
      prepared_followups: result.preparedFollowups,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedList(
  input: {
    profileName: string;
    limit: number;
    mine: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.list.start", {
      profileName: input.profileName,
      limit: input.limit,
      mine: input.mine,
    });

    const posts = await runtime.feed.viewFeed({
      profileName: input.profileName,
      limit: input.limit,
      mine: input.mine,
    });

    runtime.logger.log("info", "cli.feed.list.done", {
      profileName: input.profileName,
      count: posts.length,
      mine: input.mine,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: posts.length,
      mine: input.mine,
      posts,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedView(
  input: {
    profileName: string;
    postUrl: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.view.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const post = await runtime.feed.viewPost({
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    runtime.logger.log("info", "cli.feed.view.done", {
      profileName: input.profileName,
      postId: post.post_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      post,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedLike(
  input: {
    profileName: string;
    postUrl: string;
    reaction?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const reaction = normalizeLinkedInFeedReaction(input.reaction, "like");

  try {
    runtime.logger.log("info", "cli.feed.like.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
      reaction,
    });

    const prepared = runtime.feed.prepareLikePost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      reaction,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.like.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
      reaction,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedComment(
  input: {
    profileName: string;
    postUrl: string;
    text: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.comment.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareCommentOnPost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      text: input.text,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.comment.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedRepost(
  input: {
    profileName: string;
    postUrl: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.repost.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareRepostPost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.repost.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedShare(
  input: {
    profileName: string;
    postUrl: string;
    text: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.share.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareSharePost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      text: input.text,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.share.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedSave(
  input: {
    profileName: string;
    postUrl: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.save.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareSavePost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.save.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedUnsave(
  input: {
    profileName: string;
    postUrl: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.unsave.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareUnsavePost({
      profileName: input.profileName,
      postUrl: input.postUrl,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.unsave.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runFeedRemoveReaction(
  input: {
    profileName: string;
    postUrl: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.feed.remove_reaction.start", {
      profileName: input.profileName,
      postUrl: input.postUrl,
    });

    const prepared = runtime.feed.prepareRemoveReaction({
      profileName: input.profileName,
      postUrl: input.postUrl,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.feed.remove_reaction.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runPostPrepare(
  input: {
    profileName: string;
    text: string;
    visibility?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  const visibility = normalizeLinkedInPostVisibility(
    input.visibility,
    "public",
  );

  try {
    runtime.logger.log("info", "cli.post.prepare.start", {
      profileName: input.profileName,
      visibility,
    });

    const prepared = await runtime.posts.prepareCreate({
      profileName: input.profileName,
      text: input.text,
      visibility,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.post.prepare.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
      visibility,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runArticlePrepareCreate(
  input: {
    profileName: string;
    title: string;
    body: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  try {
    runtime.logger.log("info", "cli.article.prepare_create.start", {
      profileName: input.profileName,
    });
    const prepared = await runtime.articles.prepareCreate({
      profileName: input.profileName,
      title: input.title,
      body: input.body,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
    runtime.logger.log("info", "cli.article.prepare_create.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });
    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runArticlePreparePublish(
  input: {
    profileName: string;
    draftUrl: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  try {
    runtime.logger.log("info", "cli.article.prepare_publish.start", {
      profileName: input.profileName,
      draftUrl: input.draftUrl,
    });
    const prepared = await runtime.articles.preparePublish({
      profileName: input.profileName,
      draftUrl: input.draftUrl,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
    runtime.logger.log("info", "cli.article.prepare_publish.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });
    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runNewsletterPrepareCreate(
  input: {
    profileName: string;
    title: string;
    description: string;
    cadence: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  try {
    runtime.logger.log("info", "cli.newsletter.prepare_create.start", {
      profileName: input.profileName,
    });
    const prepared = await runtime.newsletters.prepareCreate({
      profileName: input.profileName,
      title: input.title,
      description: input.description,
      cadence: input.cadence,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
    runtime.logger.log("info", "cli.newsletter.prepare_create.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });
    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runNewsletterPreparePublishIssue(
  input: {
    profileName: string;
    newsletter: string;
    title: string;
    body: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  try {
    runtime.logger.log("info", "cli.newsletter.prepare_publish_issue.start", {
      profileName: input.profileName,
      newsletter: input.newsletter,
    });
    const prepared = await runtime.newsletters.preparePublishIssue({
      profileName: input.profileName,
      newsletter: input.newsletter,
      title: input.title,
      body: input.body,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });
    runtime.logger.log("info", "cli.newsletter.prepare_publish_issue.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });
    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runNewsletterList(
  input: {
    profileName: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);
  try {
    runtime.logger.log("info", "cli.newsletter.list.start", {
      profileName: input.profileName,
    });
    const result = await runtime.newsletters.list({
      profileName: input.profileName,
    });
    runtime.logger.log("info", "cli.newsletter.list.done", {
      profileName: input.profileName,
      count: result.count,
    });
    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runProfileView(
  input: {
    profileName: string;
    target: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.profile.view.start", {
      profileName: input.profileName,
      target: input.target,
    });

    const profile = await runtime.profile.viewProfile({
      profileName: input.profileName,
      target: input.target,
    });

    runtime.logger.log("info", "cli.profile.view.done", {
      profileName: input.profileName,
      fullName: profile.full_name,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      profile,
    });
  } finally {
    runtime.close();
  }
}

async function runCompanyPageView(
  input: {
    profileName: string;
    target: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.company.view.start", {
      profileName: input.profileName,
      target: input.target,
    });

    const company = await runtime.companyPages.viewCompanyPage({
      profileName: input.profileName,
      target: input.target,
    });

    runtime.logger.log("info", "cli.company.view.done", {
      profileName: input.profileName,
      companyName: company.name,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      company,
    });
  } finally {
    runtime.close();
  }
}

async function runCompanyPrepareFollow(
  input: {
    profileName: string;
    targetCompany: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.company.prepare_follow.start", {
      profileName: input.profileName,
      targetCompany: input.targetCompany,
    });

    const prepared = runtime.companyPages.prepareFollowCompanyPage({
      profileName: input.profileName,
      targetCompany: input.targetCompany,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.company.prepare_follow.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runCompanyPrepareUnfollow(
  input: {
    profileName: string;
    targetCompany: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.company.prepare_unfollow.start", {
      profileName: input.profileName,
      targetCompany: input.targetCompany,
    });

    const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName: input.profileName,
      targetCompany: input.targetCompany,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.company.prepare_unfollow.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runProfileViewEditable(
  input: {
    profileName: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.profile.view_editable.start", {
      profileName: input.profileName,
    });

    const profile = await runtime.profile.viewEditableProfile({
      profileName: input.profileName,
    });

    runtime.logger.log("info", "cli.profile.view_editable.done", {
      profileName: input.profileName,
      sectionCount: profile.sections.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      profile,
    });
  } finally {
    runtime.close();
  }
}

async function runProfilePrepareUpdateSettings(
  input: {
    profileName: string;
    industry: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.profile.prepare_update_settings.start", {
      profileName: input.profileName,
    });

    const prepared = runtime.profile.prepareUpdateSettings({
      profileName: input.profileName,
      industry: input.industry,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.profile.prepare_update_settings.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runProfilePrepareUpdatePublicProfile(
  input: {
    profileName: string;
    vanityName: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log(
      "info",
      "cli.profile.prepare_update_public_profile.start",
      {
        profileName: input.profileName,
      },
    );

    const prepared = runtime.profile.prepareUpdatePublicProfile({
      profileName: input.profileName,
      vanityName: input.vanityName,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log(
      "info",
      "cli.profile.prepare_update_public_profile.done",
      {
        profileName: input.profileName,
        preparedActionId: prepared.preparedActionId,
      },
    );

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

function summarizeProfileSeedUnsupportedFields(
  unsupportedFields: readonly ProfileSeedUnsupportedField[],
): string {
  return unsupportedFields
    .map((field) => `${field.path} (#${field.issueNumber})`)
    .join(", ");
}

function createProfileSeedUnsupportedFieldsError(
  unsupportedFields: readonly ProfileSeedUnsupportedField[],
): LinkedInBuddyError {
  return new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    `Profile seed spec includes unsupported fields: ${summarizeProfileSeedUnsupportedFields(unsupportedFields)}. Remove them or rerun with --allow-partial.`,
    {
      unsupported_fields: unsupportedFields.map((field) => ({
        path: field.path,
        issue_number: field.issueNumber,
        reason: field.reason,
      })),
    },
  );
}

type CliRuntime = ReturnType<typeof createRuntime>;

function sampleSeedDelay(baseDelayMs: number): number {
  if (baseDelayMs <= 0) {
    return 0;
  }

  const jitter = Math.max(250, Math.round(baseDelayMs * 0.35));
  const minimum = Math.max(0, baseDelayMs - jitter);
  const maximum = baseDelayMs + jitter;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function prepareProfileSeedAction(
  runtime: CliRuntime,
  action: ProfileSeedPlanAction,
) {
  switch (action.kind) {
    case "update_intro":
      return runtime.profile.prepareUpdateIntro(action.input);
    case "update_settings":
      return runtime.profile.prepareUpdateSettings(action.input);
    case "update_public_profile":
      return runtime.profile.prepareUpdatePublicProfile(action.input);
    case "upsert_section_item":
      return runtime.profile.prepareUpsertSectionItem(action.input);
    case "remove_section_item":
      return runtime.profile.prepareRemoveSectionItem(action.input);
  }
}

interface ActivitySeedPlanSummary {
  acceptPendingCount: number;
  commentCount: number;
  inviteCount: number;
  jobSearchCount: number;
  jobViewCount: number;
  likeCount: number;
  newThreadCount: number;
  notificationCheckCount: number;
  postCount: number;
  replyCount: number;
  totalReadSteps: number;
  totalWriteActions: number;
}

function createActivitySeedPlanSummary(
  spec: ActivitySeedSpec,
): ActivitySeedPlanSummary {
  const jobViewCount = spec.jobs.searches.reduce(
    (total, search) => total + (search.viewTop ?? 0),
    0,
  );
  const totalWriteActions =
    spec.connections.invites.length +
    (spec.connections.acceptPending
      ? spec.connections.acceptPending.limit
      : 0) +
    spec.posts.length +
    spec.feed.likes.length +
    spec.feed.comments.length +
    spec.messaging.newThreads.length +
    spec.messaging.replies.length;
  const totalReadSteps =
    spec.jobs.searches.length + (spec.notifications ? 1 : 0) + 3;

  return {
    acceptPendingCount: spec.connections.acceptPending?.limit ?? 0,
    commentCount: spec.feed.comments.length,
    inviteCount: spec.connections.invites.length,
    jobSearchCount: spec.jobs.searches.length,
    jobViewCount,
    likeCount: spec.feed.likes.length,
    newThreadCount: spec.messaging.newThreads.length,
    notificationCheckCount: spec.notifications ? 1 : 0,
    postCount: spec.posts.length,
    replyCount: spec.messaging.replies.length,
    totalReadSteps,
    totalWriteActions,
  };
}

async function resolveActivitySeedGeneratedPostImages(
  spec: ActivitySeedSpec,
  resolvedSpecPath: string,
): Promise<{
  manifestPath: string;
  postImages: ActivitySeedGeneratedPostImage[];
} | null> {
  const manifestPathInput = spec.assets?.generatedImageManifestPath;
  if (!manifestPathInput) {
    return null;
  }

  const resolvedManifestPath = path.resolve(
    path.dirname(resolvedSpecPath),
    manifestPathInput,
  );
  const rawManifest = await readJsonInputFile(
    resolvedManifestPath,
    "activity seed generated image manifest",
  );
  const manifest = parseActivitySeedGeneratedImageManifest(rawManifest);

  return {
    manifestPath: resolvedManifestPath,
    postImages: manifest.postImages,
  };
}

function resolveActivitySeedPostMediaPath(
  post: ActivitySeedPostSpec,
  resolvedSpecPath: string,
  generatedImages: readonly ActivitySeedGeneratedPostImage[],
): string | undefined {
  if (post.mediaPath) {
    return path.resolve(path.dirname(resolvedSpecPath), post.mediaPath);
  }

  if (post.generatedImageIndex === undefined) {
    return undefined;
  }

  if (generatedImages.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "posts.generatedImageIndex requires assets.generatedImageManifestPath to be configured.",
    );
  }

  const generatedImage = generatedImages[post.generatedImageIndex];
  if (!generatedImage) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `posts.generatedImageIndex ${post.generatedImageIndex} is out of range for the configured generated image manifest.`,
    );
  }

  return generatedImage.absolutePath;
}

function normalizeComparableLinkedInIdentity(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    const cleanPath = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return normalized.replace(/\/+$/u, "");
  }
}

function createActivitySeedOperatorNote(
  resolvedSpecPath: string,
  sectionLabel: string,
  explicitNote?: string,
): string {
  const baseNote = explicitNote?.trim();
  if (baseNote) {
    return baseNote;
  }

  return `activity seed: ${path.basename(resolvedSpecPath)} / ${sectionLabel}`;
}

function summarizeConfirmedAction(confirmed: {
  actionType: string;
  preparedActionId: string;
  status: string;
  result: Record<string, unknown>;
  artifacts: string[];
}): Record<string, unknown> {
  return {
    action_type: confirmed.actionType,
    prepared_action_id: confirmed.preparedActionId,
    status: confirmed.status,
    result: confirmed.result,
    artifacts: confirmed.artifacts,
  };
}

async function maybeSleepSeedDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await sleep(sampleSeedDelay(delayMs));
}

async function maybeWarnAboutKeepAliveForSeeding(): Promise<number[]> {
  const runningKeepAlivePids = await findRunningKeepAlivePids();
  if (runningKeepAlivePids.length === 0) {
    writeCliWarning(
      "No running keepalive daemon was detected. For long issue-212 seeding runs, start `linkedin keepalive start` in another terminal first.",
    );
  } else {
    writeCliNotice(
      `Detected keepalive daemon PID${runningKeepAlivePids.length === 1 ? "" : "s"}: ${runningKeepAlivePids.join(", ")}.`,
    );
  }

  return runningKeepAlivePids;
}

async function runProfileApplySpec(
  input: {
    profileName: string;
    specPath: string;
    replace: boolean;
    allowPartial: boolean;
    delayMs: number;
    yes: boolean;
    outputPath?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const resolvedSpecPath = path.resolve(input.specPath);
  const rawSpec = await readJsonInputFile(
    resolvedSpecPath,
    "profile seed spec",
  );
  const spec = parseProfileSeedSpec(rawSpec);
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.profile.apply_spec.start", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      replace: input.replace,
      allowPartial: input.allowPartial,
      delayMs: input.delayMs,
    });

    const editableProfile = await runtime.profile.viewEditableProfile({
      profileName: input.profileName,
    });
    const plan = createProfileSeedPlan(editableProfile, spec, {
      profileName: input.profileName,
      operatorNote: `profile seed: ${path.basename(resolvedSpecPath)}`,
      replace: input.replace,
    });

    if (plan.unsupportedFields.length > 0 && !input.allowPartial) {
      throw createProfileSeedUnsupportedFieldsError(plan.unsupportedFields);
    }

    if (plan.unsupportedFields.length > 0) {
      writeCliWarning(
        `Ignoring unsupported profile fields for this run: ${summarizeProfileSeedUnsupportedFields(plan.unsupportedFields)}.`,
      );
    }

    if (plan.actions.length > 0) {
      writeCliNotice(
        `Loaded ${resolvedSpecPath} with ${plan.actions.length} supported profile ${plan.actions.length === 1 ? "edit" : "edits"}.`,
      );
    } else {
      writeCliNotice(
        `Loaded ${resolvedSpecPath}; no supported profile edits are required.`,
      );
    }

    if (!input.yes && plan.actions.length > 0) {
      if (!stdin.isTTY || !stdout.isTTY) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Refusing to apply a profile seed spec in non-interactive mode. Add --yes to bypass interactive confirmation.",
        );
      }

      const confirmed = await promptYesNo(
        `Apply ${plan.actions.length} LinkedIn profile ${plan.actions.length === 1 ? "edit" : "edits"}?`,
        process.stderr,
      );
      if (!confirmed) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Operator declined profile seed execution.",
        );
      }
    }

    const actionResults: Array<Record<string, unknown>> = [];
    for (let index = 0; index < plan.actions.length; index += 1) {
      const action = plan.actions[index]!;
      const prepared = prepareProfileSeedAction(runtime, action);
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });

      actionResults.push({
        summary: action.summary,
        action_type: confirmed.actionType,
        prepared_action_id: confirmed.preparedActionId,
        status: confirmed.status,
        result: confirmed.result,
        artifacts: confirmed.artifacts,
      });

      if (index < plan.actions.length - 1 && input.delayMs > 0) {
        await sleep(sampleSeedDelay(input.delayMs));
      }
    }

    const finalProfile = await runtime.profile.viewProfile({
      profileName: input.profileName,
      target: "me",
    });

    const report: Record<string, unknown> = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      spec_path: resolvedSpecPath,
      replace: input.replace,
      allow_partial: input.allowPartial,
      delay_ms: input.delayMs,
      planned_action_count: plan.actions.length,
      executed_action_count: actionResults.length,
      unsupported_fields: plan.unsupportedFields,
      actions: actionResults,
      profile: finalProfile,
    };

    if (input.outputPath) {
      report.output_path = await writeOutputJsonFile(input.outputPath, report);
    }

    runtime.logger.log("info", "cli.profile.apply_spec.done", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      plannedActionCount: plan.actions.length,
      executedActionCount: actionResults.length,
      unsupportedFieldCount: plan.unsupportedFields.length,
    });

    printJson(report);
  } finally {
    runtime.close();
  }
}

async function runActivitySeedJobSearch(
  runtime: CliRuntime,
  profileName: string,
  search: ActivitySeedJobSearchSpec,
): Promise<Record<string, unknown>> {
  const searchResult = await runtime.jobs.searchJobs({
    profileName,
    query: search.query,
    ...(search.location ? { location: search.location } : {}),
    ...(search.limit ? { limit: search.limit } : {}),
  });
  const viewCount = Math.min(search.viewTop ?? 0, searchResult.results.length);
  const viewedJobs: Record<string, unknown>[] = [];

  for (const job of searchResult.results.slice(0, viewCount)) {
    const detail = await runtime.jobs.viewJob({
      profileName,
      jobId: job.job_id,
    });
    viewedJobs.push(detail as unknown as Record<string, unknown>);
  }

  return {
    query: searchResult.query,
    location: searchResult.location,
    count: searchResult.count,
    results: searchResult.results,
    viewed_jobs: viewedJobs,
  };
}

async function runSeedActivity(
  input: {
    profileName: string;
    specPath: string;
    delayMs: number;
    yes: boolean;
    outputPath?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const resolvedSpecPath = path.resolve(input.specPath);
  const rawSpec = await readJsonInputFile(
    resolvedSpecPath,
    "activity seed spec",
  );
  const spec = parseActivitySeedSpec(rawSpec);
  const planSummary = createActivitySeedPlanSummary(spec);
  const generatedImages = await resolveActivitySeedGeneratedPostImages(
    spec,
    resolvedSpecPath,
  );
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.seed.activity.start", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      delayMs: input.delayMs,
      totalWriteActions: planSummary.totalWriteActions,
      totalReadSteps: planSummary.totalReadSteps,
    });

    const keepAlivePids = await maybeWarnAboutKeepAliveForSeeding();

    if (planSummary.totalWriteActions > 0) {
      writeCliNotice(
        `Loaded ${resolvedSpecPath} with ${planSummary.totalWriteActions} write ${planSummary.totalWriteActions === 1 ? "action" : "actions"} and ${planSummary.totalReadSteps} read-only verification ${planSummary.totalReadSteps === 1 ? "step" : "steps"}.`,
      );
    } else {
      writeCliNotice(
        `Loaded ${resolvedSpecPath}; no write actions are configured, so this run will only perform read-only checks.`,
      );
    }

    if (!input.yes && planSummary.totalWriteActions > 0) {
      if (!stdin.isTTY || !stdout.isTTY) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Refusing to apply an activity seed spec in non-interactive mode. Add --yes to bypass interactive confirmation.",
        );
      }

      const confirmed = await promptYesNo(
        `Execute ${planSummary.totalWriteActions} LinkedIn write ${planSummary.totalWriteActions === 1 ? "action" : "actions"} from this activity seed spec?`,
        process.stderr,
      );
      if (!confirmed) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Operator declined activity seed execution.",
        );
      }
    }

    const report: Record<string, unknown> = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      spec_path: resolvedSpecPath,
      delay_ms: input.delayMs,
      keep_alive_pids: keepAlivePids,
      keep_alive_running: keepAlivePids.length > 0,
      plan: planSummary,
      evasion: runtime.evasion,
      ...(generatedImages
        ? { generated_image_manifest_path: generatedImages.manifestPath }
        : {}),
    };

    const connectionsSection: Record<string, unknown> = {
      accepted_pending: [] as Record<string, unknown>[],
      invites: [] as Record<string, unknown>[],
      skipped_invites: [] as Record<string, unknown>[],
    };

    if (spec.connections.acceptPending) {
      const pendingReceived = await runtime.connections.listPendingInvitations({
        profileName: input.profileName,
        filter: "received",
      });
      const pendingToAccept = pendingReceived.slice(
        0,
        spec.connections.acceptPending.limit,
      );
      connectionsSection.pending_received = pendingReceived;

      for (const [index, invitation] of pendingToAccept.entries()) {
        const prepared = runtime.connections.prepareAcceptInvitation({
          profileName: input.profileName,
          targetProfile: invitation.profile_url,
          operatorNote: createActivitySeedOperatorNote(
            resolvedSpecPath,
            `accept pending ${index + 1}`,
            undefined,
          ),
        });
        const confirmed = await runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.confirmToken,
        });
        (connectionsSection.accepted_pending as Record<string, unknown>[]).push(
          {
            target_profile: invitation.profile_url,
            full_name: invitation.full_name,
            ...summarizeConfirmedAction(confirmed),
          },
        );
        await maybeSleepSeedDelay(input.delayMs);
      }
    }

    if (spec.connections.invites.length > 0) {
      const [existingConnections, pendingSent] = await Promise.all([
        runtime.connections.listConnections({
          profileName: input.profileName,
          limit: Math.max(40, spec.connections.invites.length + 20),
        }),
        runtime.connections.listPendingInvitations({
          profileName: input.profileName,
          filter: "sent",
        }),
      ]);
      const existingTargets = new Set(
        existingConnections
          .map((connection) =>
            normalizeComparableLinkedInIdentity(connection.profile_url),
          )
          .filter((value) => value.length > 0),
      );
      const pendingTargets = new Set(
        pendingSent
          .map((invitation) =>
            normalizeComparableLinkedInIdentity(invitation.profile_url),
          )
          .filter((value) => value.length > 0),
      );

      connectionsSection.connections_before = existingConnections;
      connectionsSection.pending_sent = pendingSent;

      for (const [index, invite] of spec.connections.invites.entries()) {
        const normalizedTarget = normalizeComparableLinkedInIdentity(
          invite.targetProfile,
        );
        if (existingTargets.has(normalizedTarget)) {
          (
            connectionsSection.skipped_invites as Record<string, unknown>[]
          ).push({
            target_profile: invite.targetProfile,
            reason: "already_connected",
          });
          continue;
        }
        if (pendingTargets.has(normalizedTarget)) {
          (
            connectionsSection.skipped_invites as Record<string, unknown>[]
          ).push({
            target_profile: invite.targetProfile,
            reason: "invitation_already_pending",
          });
          continue;
        }

        const prepared = runtime.connections.prepareSendInvitation({
          profileName: input.profileName,
          targetProfile: invite.targetProfile,
          ...(invite.note ? { note: invite.note } : {}),
          operatorNote: createActivitySeedOperatorNote(
            resolvedSpecPath,
            `invite ${index + 1}`,
            invite.operatorNote,
          ),
        });
        const confirmed = await runtime.twoPhaseCommit.confirmByToken({
          confirmToken: prepared.confirmToken,
        });
        (connectionsSection.invites as Record<string, unknown>[]).push({
          target_profile: invite.targetProfile,
          ...(invite.note ? { note: invite.note } : {}),
          ...summarizeConfirmedAction(confirmed),
        });
        pendingTargets.add(normalizedTarget);
        await maybeSleepSeedDelay(input.delayMs);
      }
    }

    report.connections = connectionsSection;

    const postsSection: Record<string, unknown>[] = [];
    for (const [index, post] of spec.posts.entries()) {
      const mediaPath = resolveActivitySeedPostMediaPath(
        post,
        resolvedSpecPath,
        generatedImages?.postImages ?? [],
      );
      const visibility = post.visibility ?? "connections";
      const operatorNote = createActivitySeedOperatorNote(
        resolvedSpecPath,
        `post ${index + 1}`,
        post.operatorNote,
      );

      const prepared = mediaPath
        ? await runtime.posts.prepareCreateMedia({
            profileName: input.profileName,
            text: post.text,
            mediaPaths: [mediaPath],
            visibility,
            operatorNote,
          })
        : await runtime.posts.prepareCreate({
            profileName: input.profileName,
            text: post.text,
            visibility,
            operatorNote,
          });
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });
      const publishedPostUrl =
        typeof confirmed.result.published_post_url === "string" &&
        confirmed.result.published_post_url.trim().length > 0
          ? confirmed.result.published_post_url.trim()
          : undefined;
      const verification = publishedPostUrl
        ? await runtime.feed.viewPost({
            profileName: input.profileName,
            postUrl: publishedPostUrl,
          })
        : undefined;

      postsSection.push({
        text: post.text,
        visibility,
        ...(mediaPath ? { media_path: mediaPath } : {}),
        ...summarizeConfirmedAction(confirmed),
        ...(verification ? { verification } : {}),
      });
      await maybeSleepSeedDelay(input.delayMs);
    }
    report.posts = postsSection;

    const feedSection: Record<string, unknown> = {
      liked: [] as Record<string, unknown>[],
      commented: [] as Record<string, unknown>[],
    };
    if (
      spec.feed.discoveryLimit ||
      spec.feed.likes.length > 0 ||
      spec.feed.comments.length > 0
    ) {
      const discoveryLimit =
        spec.feed.discoveryLimit ??
        Math.max(10, spec.feed.likes.length + spec.feed.comments.length + 3);
      feedSection.feed_snapshot = await runtime.feed.viewFeed({
        profileName: input.profileName,
        limit: discoveryLimit,
      });
    }

    for (const [index, like] of spec.feed.likes.entries()) {
      const prepared = runtime.feed.prepareLikePost({
        profileName: input.profileName,
        postUrl: like.postUrl,
        ...(like.reaction ? { reaction: like.reaction } : {}),
        operatorNote: createActivitySeedOperatorNote(
          resolvedSpecPath,
          `feed like ${index + 1}`,
          like.operatorNote,
        ),
      });
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });
      (feedSection.liked as Record<string, unknown>[]).push({
        post_url: like.postUrl,
        ...(like.reaction ? { reaction: like.reaction } : {}),
        ...summarizeConfirmedAction(confirmed),
      });
      await maybeSleepSeedDelay(input.delayMs);
    }

    for (const [index, comment] of spec.feed.comments.entries()) {
      const prepared = runtime.feed.prepareCommentOnPost({
        profileName: input.profileName,
        postUrl: comment.postUrl,
        text: comment.text,
        operatorNote: createActivitySeedOperatorNote(
          resolvedSpecPath,
          `feed comment ${index + 1}`,
          comment.operatorNote,
        ),
      });
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });
      (feedSection.commented as Record<string, unknown>[]).push({
        post_url: comment.postUrl,
        text: comment.text,
        ...summarizeConfirmedAction(confirmed),
      });
      await maybeSleepSeedDelay(input.delayMs);
    }

    report.feed = feedSection;

    const jobsSection: Record<string, unknown>[] = [];
    for (const search of spec.jobs.searches) {
      jobsSection.push(
        await runActivitySeedJobSearch(runtime, input.profileName, search),
      );
    }
    report.jobs = jobsSection;

    const messagingSection: Record<string, unknown> = {
      new_threads: [] as Record<string, unknown>[],
      replies: [] as Record<string, unknown>[],
    };
    if (
      spec.messaging.newThreads.length > 0 ||
      spec.messaging.replies.length > 0
    ) {
      messagingSection.threads_before = await runtime.inbox.listThreads({
        profileName: input.profileName,
        limit: 10,
      });
    }

    for (const [index, thread] of spec.messaging.newThreads.entries()) {
      const prepared = await runtime.inbox.prepareNewThread({
        profileName: input.profileName,
        recipients: thread.recipients,
        text: thread.text,
        operatorNote: createActivitySeedOperatorNote(
          resolvedSpecPath,
          `new thread ${index + 1}`,
          thread.operatorNote,
        ),
      });
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });
      const threadUrl =
        typeof confirmed.result.thread_url === "string" &&
        confirmed.result.thread_url.trim().length > 0
          ? confirmed.result.thread_url.trim()
          : undefined;
      const verification = threadUrl
        ? await runtime.inbox.getThread({
            profileName: input.profileName,
            thread: threadUrl,
            limit: 10,
          })
        : undefined;
      (messagingSection.new_threads as Record<string, unknown>[]).push({
        recipients: thread.recipients,
        text: thread.text,
        ...summarizeConfirmedAction(confirmed),
        ...(verification ? { verification } : {}),
      });
      await maybeSleepSeedDelay(input.delayMs);
    }

    for (const [index, reply] of spec.messaging.replies.entries()) {
      const prepared = await runtime.inbox.prepareReply({
        profileName: input.profileName,
        thread: reply.thread,
        text: reply.text,
        operatorNote: createActivitySeedOperatorNote(
          resolvedSpecPath,
          `reply ${index + 1}`,
          reply.operatorNote,
        ),
      });
      const confirmed = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });
      const threadUrl =
        typeof confirmed.result.thread_url === "string" &&
        confirmed.result.thread_url.trim().length > 0
          ? confirmed.result.thread_url.trim()
          : reply.thread;
      const verification = await runtime.inbox.getThread({
        profileName: input.profileName,
        thread: threadUrl,
        limit: 10,
      });
      (messagingSection.replies as Record<string, unknown>[]).push({
        thread: reply.thread,
        text: reply.text,
        ...summarizeConfirmedAction(confirmed),
        verification,
      });
      await maybeSleepSeedDelay(input.delayMs);
    }

    report.messaging = messagingSection;

    if (spec.notifications) {
      report.notifications = await runtime.notifications.listNotifications({
        profileName: input.profileName,
        ...(typeof spec.notifications.limit === "number"
          ? { limit: spec.notifications.limit }
          : {}),
      });
    }

    report.verification = {
      connections: await runtime.connections.listConnections({
        profileName: input.profileName,
        limit: Math.max(20, spec.connections.invites.length + 10),
      }),
      feed: await runtime.feed.viewFeed({
        profileName: input.profileName,
        limit: Math.max(10, spec.posts.length + 5),
      }),
      inbox_threads: await runtime.inbox.listThreads({
        profileName: input.profileName,
        limit: 10,
      }),
    };

    if (input.outputPath) {
      report.output_path = await writeOutputJsonFile(input.outputPath, report);
    }

    runtime.logger.log("info", "cli.seed.activity.done", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      totalWriteActions: planSummary.totalWriteActions,
      totalReadSteps: planSummary.totalReadSteps,
    });

    printJson(report);
  } finally {
    runtime.close();
  }
}

async function runAssetsGenerateProfileImages(
  input: {
    profileName: string;
    specPath: string;
    postImageCount: number;
    uploadProfileMedia: boolean;
    uploadDelayMs: number;
    model?: string;
    outputPath?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const resolvedSpecPath = path.resolve(input.specPath);
  const rawSpec = await readJsonInputFile(
    resolvedSpecPath,
    "image persona spec",
  );
  const persona = buildLinkedInImagePersonaFromProfileSeed(rawSpec);
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.assets.generate_profile_images.start", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      postImageCount: input.postImageCount,
      uploadProfileMedia: input.uploadProfileMedia,
      model: input.model ?? null,
    });

    const report: Record<string, unknown> = {
      run_id: runtime.runId,
      profile_name: input.profileName,
      spec_path: resolvedSpecPath,
      ...(await runtime.imageAssets.generatePersonaImageSet({
        persona,
        postImageCount: input.postImageCount,
        uploadProfileMedia: input.uploadProfileMedia,
        profileName: input.profileName,
        uploadDelayMs: input.uploadDelayMs,
        operatorNote: `issue-211 persona images: ${path.basename(resolvedSpecPath)}`,
        ...(input.model ? { model: input.model } : {}),
      })),
    };

    if (input.outputPath) {
      report.output_path = await writeOutputJsonFile(input.outputPath, report);
    }

    runtime.logger.log("info", "cli.assets.generate_profile_images.done", {
      profileName: input.profileName,
      specPath: resolvedSpecPath,
      postImageCount: input.postImageCount,
      uploadProfileMedia: input.uploadProfileMedia,
    });

    printJson(report);
  } finally {
    runtime.close();
  }
}

async function runSearch(
  input: {
    profileName: string;
    query: string;
    category?: SearchCategory;
    limit?: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    const category = input.category ?? "people";
    const limit = input.limit ?? 10;

    runtime.logger.log("info", "cli.search.start", {
      profileName: input.profileName,
      query: input.query,
      category,
      limit,
    });

    const result = await runtime.search.search({
      profileName: input.profileName,
      query: input.query,
      ...(input.category ? { category: input.category } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    });

    runtime.logger.log("info", "cli.search.done", {
      profileName: input.profileName,
      category: result.category,
      count: result.count,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsList(
  input: {
    profileName: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.notifications.list.start", {
      profileName: input.profileName,
      limit: input.limit,
    });

    const notifications = await runtime.notifications.listNotifications({
      profileName: input.profileName,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.notifications.list.done", {
      profileName: input.profileName,
      count: notifications.length,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      count: notifications.length,
      notifications,
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsMarkRead(
  input: {
    profileName: string;
    notificationId: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.notifications.mark_read.start", {
      profileName: input.profileName,
      notificationId: input.notificationId,
    });

    const result = await runtime.notifications.markRead({
      profileName: input.profileName,
      notificationId: input.notificationId,
    });

    runtime.logger.log("info", "cli.notifications.mark_read.done", {
      profileName: input.profileName,
      notificationId: input.notificationId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsDismiss(
  input: {
    profileName: string;
    notificationId: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.notifications.dismiss.start", {
      profileName: input.profileName,
      notificationId: input.notificationId,
    });

    const prepared = await runtime.notifications.prepareDismissNotification({
      profileName: input.profileName,
      notificationId: input.notificationId,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.notifications.dismiss.done", {
      profileName: input.profileName,
      notificationId: input.notificationId,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsPreferencesGet(
  input: {
    profileName: string;
    preferenceUrl?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.notifications.preferences.get.start", {
      profileName: input.profileName,
      preferenceUrl: input.preferenceUrl ?? null,
    });

    const preferences = await runtime.notifications.getPreferences({
      profileName: input.profileName,
      ...(input.preferenceUrl ? { preferenceUrl: input.preferenceUrl } : {}),
    });

    runtime.logger.log("info", "cli.notifications.preferences.get.done", {
      profileName: input.profileName,
      viewType: preferences.view_type,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      preferences,
    });
  } finally {
    runtime.close();
  }
}

async function runNotificationsPreferencesPrepareUpdate(
  input: {
    profileName: string;
    preferenceUrl: string;
    enabled: boolean;
    channel?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log(
      "info",
      "cli.notifications.preferences.prepare_update.start",
      {
        profileName: input.profileName,
        preferenceUrl: input.preferenceUrl,
        enabled: input.enabled,
        channel: input.channel ?? null,
      },
    );

    const prepared = await runtime.notifications.prepareUpdatePreference({
      profileName: input.profileName,
      preferenceUrl: input.preferenceUrl,
      enabled: input.enabled,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log(
      "info",
      "cli.notifications.preferences.prepare_update.done",
      {
        profileName: input.profileName,
        preferenceUrl: input.preferenceUrl,
        preparedActionId: prepared.preparedActionId,
      },
    );

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runGroupsSearch(
  input: {
    profileName: string;
    query: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.groups.search.start", {
      profileName: input.profileName,
      query: input.query,
      limit: input.limit,
    });

    const result = await runtime.groups.searchGroups({
      profileName: input.profileName,
      query: input.query,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.groups.search.done", {
      profileName: input.profileName,
      count: result.count,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runGroupsView(
  input: {
    profileName: string;
    group: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.groups.view.start", {
      profileName: input.profileName,
      group: input.group,
    });

    const group = await runtime.groups.viewGroup({
      profileName: input.profileName,
      group: input.group,
    });

    runtime.logger.log("info", "cli.groups.view.done", {
      profileName: input.profileName,
      groupId: group.group_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      group,
    });
  } finally {
    runtime.close();
  }
}

async function runGroupsPrepareJoin(
  input: {
    profileName: string;
    group: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.groups.prepare_join.start", {
      profileName: input.profileName,
      group: input.group,
    });

    const prepared = runtime.groups.prepareJoinGroup({
      profileName: input.profileName,
      group: input.group,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.groups.prepare_join.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runGroupsPrepareLeave(
  input: {
    profileName: string;
    group: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.groups.prepare_leave.start", {
      profileName: input.profileName,
      group: input.group,
    });

    const prepared = runtime.groups.prepareLeaveGroup({
      profileName: input.profileName,
      group: input.group,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.groups.prepare_leave.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runGroupsPreparePost(
  input: {
    profileName: string;
    group: string;
    text: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.groups.prepare_post.start", {
      profileName: input.profileName,
      group: input.group,
    });

    const prepared = runtime.groups.preparePostToGroup({
      profileName: input.profileName,
      group: input.group,
      text: input.text,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.groups.prepare_post.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runEventsSearch(
  input: {
    profileName: string;
    query: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.events.search.start", {
      profileName: input.profileName,
      query: input.query,
      limit: input.limit,
    });

    const result = await runtime.events.searchEvents({
      profileName: input.profileName,
      query: input.query,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.events.search.done", {
      profileName: input.profileName,
      count: result.count,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runEventsView(
  input: {
    profileName: string;
    event: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.events.view.start", {
      profileName: input.profileName,
      event: input.event,
    });

    const eventDetails = await runtime.events.viewEvent({
      profileName: input.profileName,
      event: input.event,
    });

    runtime.logger.log("info", "cli.events.view.done", {
      profileName: input.profileName,
      eventId: eventDetails.event_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      event: eventDetails,
    });
  } finally {
    runtime.close();
  }
}

async function runEventsPrepareRsvp(
  input: {
    profileName: string;
    event: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.events.prepare_rsvp.start", {
      profileName: input.profileName,
      event: input.event,
    });

    const prepared = runtime.events.prepareRsvp({
      profileName: input.profileName,
      event: input.event,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.events.prepare_rsvp.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runJobsSearch(
  input: {
    profileName: string;
    query: string;
    location?: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.search.start", {
      profileName: input.profileName,
      query: input.query,
      location: input.location ?? "",
      limit: input.limit,
    });

    const result = await runtime.jobs.searchJobs({
      profileName: input.profileName,
      query: input.query,
      ...(input.location ? { location: input.location } : {}),
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.jobs.search.done", {
      profileName: input.profileName,
      count: result.count,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runJobsView(
  input: {
    profileName: string;
    jobId: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.view.start", {
      profileName: input.profileName,
      jobId: input.jobId,
    });

    const job = await runtime.jobs.viewJob({
      profileName: input.profileName,
      jobId: input.jobId,
    });

    runtime.logger.log("info", "cli.jobs.view.done", {
      profileName: input.profileName,
      jobId: job.job_id,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      job,
    });
  } finally {
    runtime.close();
  }
}

async function readEasyApplyAnswersFile(
  filePath: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!filePath) {
    return undefined;
  }

  const raw = await readJsonInputFile(filePath, "Easy Apply answers");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "Easy Apply answers file must contain a JSON object.",
    );
  }

  return raw as Record<string, unknown>;
}

async function runJobsSave(
  input: {
    profileName: string;
    jobId: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.save.start", {
      profileName: input.profileName,
      jobId: input.jobId,
    });

    const prepared = runtime.jobs.prepareSaveJob({
      profileName: input.profileName,
      jobId: input.jobId,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.jobs.save.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runJobsUnsave(
  input: {
    profileName: string;
    jobId: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.unsave.start", {
      profileName: input.profileName,
      jobId: input.jobId,
    });

    const prepared = runtime.jobs.prepareUnsaveJob({
      profileName: input.profileName,
      jobId: input.jobId,
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.jobs.unsave.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runJobAlertsList(
  input: {
    profileName: string;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.alerts.list.start", {
      profileName: input.profileName,
      limit: input.limit,
    });

    const result = await runtime.jobs.listJobAlerts({
      profileName: input.profileName,
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.jobs.alerts.list.done", {
      profileName: input.profileName,
      count: result.count,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

async function runJobAlertsCreate(
  input: {
    profileName: string;
    query: string;
    location?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.alerts.create.start", {
      profileName: input.profileName,
      query: input.query,
      location: input.location ?? "",
    });

    const prepared = runtime.jobs.prepareCreateJobAlert({
      profileName: input.profileName,
      query: input.query,
      ...(input.location ? { location: input.location } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.jobs.alerts.create.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runJobAlertsRemove(
  input: {
    profileName: string;
    alertId?: string;
    searchUrl?: string;
    query?: string;
    location?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.alerts.remove.start", {
      profileName: input.profileName,
      hasAlertId: Boolean(input.alertId),
      hasSearchUrl: Boolean(input.searchUrl),
      hasQuery: Boolean(input.query),
    });

    const prepared = await runtime.jobs.prepareRemoveJobAlert({
      profileName: input.profileName,
      ...(input.alertId ? { alertId: input.alertId } : {}),
      ...(input.searchUrl ? { searchUrl: input.searchUrl } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.jobs.alerts.remove.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runJobsEasyApplyPrepare(
  input: {
    profileName: string;
    jobId: string;
    phone?: string;
    email?: string;
    city?: string;
    resume?: string;
    coverLetter?: string;
    answersFile?: string;
    operatorNote?: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.jobs.easy_apply.start", {
      profileName: input.profileName,
      jobId: input.jobId,
      hasResumePath: Boolean(input.resume),
      hasAnswersFile: Boolean(input.answersFile),
    });

    const answers = await readEasyApplyAnswersFile(input.answersFile);
    const prepared = runtime.jobs.prepareEasyApply({
      profileName: input.profileName,
      jobId: input.jobId,
      ...(input.phone ? { phoneNumber: input.phone } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.resume ? { resumePath: input.resume } : {}),
      ...(input.coverLetter ? { coverLetter: input.coverLetter } : {}),
      ...(answers ? { answers } : {}),
      ...(input.operatorNote ? { operatorNote: input.operatorNote } : {}),
    });

    runtime.logger.log("info", "cli.jobs.easy_apply.done", {
      profileName: input.profileName,
      preparedActionId: prepared.preparedActionId,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...prepared,
    });
  } finally {
    runtime.close();
  }
}

async function runSelectorAudit(
  input: {
    profileName: string;
    json: boolean;
    progress: boolean;
    verbose: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const outputMode = resolveSelectorAuditOutputMode(
    { json: input.json },
    Boolean(stdout.isTTY),
  );
  const progressReporter = new SelectorAuditProgressReporter({
    enabled:
      outputMode === "human" && input.progress && Boolean(process.stderr.isTTY),
  });
  let profileName = input.profileName;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let restoreLogger = () => {};

  try {
    profileName = coerceProfileName(input.profileName);
    runtime = createRuntime(cdpUrl);
    const selectorAuditRuntime = runtime;

    const originalLog = selectorAuditRuntime.logger.log.bind(
      selectorAuditRuntime.logger,
    );
    // Mirror stable selector-audit lifecycle logs into the optional progress
    // reporter without changing the core service API surface.
    selectorAuditRuntime.logger.log = ((level, event, payload = {}) => {
      const entry = originalLog(level, event, payload);
      progressReporter.handleLog(entry);
      return entry;
    }) as typeof selectorAuditRuntime.logger.log;
    restoreLogger = () => {
      selectorAuditRuntime.logger.log = originalLog;
    };

    selectorAuditRuntime.logger.log("info", "cli.audit.selectors.start", {
      profileName,
      outputMode,
      verbose: input.verbose,
      progress: outputMode === "human" && input.progress,
    });

    const report = await selectorAuditRuntime.selectorAudit.auditSelectors({
      profileName,
    });

    selectorAuditRuntime.logger.log("info", "cli.audit.selectors.done", {
      profileName,
      totalCount: report.total_count,
      passCount: report.pass_count,
      failCount: report.fail_count,
      fallbackCount: report.fallback_count,
      reportPath: report.report_path,
    });

    if (outputMode === "json") {
      printJson(report);
    } else {
      const redactedReport = redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as SelectorAuditReport;

      console.log(
        formatSelectorAuditReport(redactedReport, {
          verbose: input.verbose,
        }),
      );
    }

    if (report.fail_count > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const errorPayload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);

    runtime?.logger.log("error", "cli.audit.selectors.failed", {
      profileName,
      error: errorPayload,
    });

    if (outputMode === "json") {
      throw error;
    }

    process.stderr.write(`${formatSelectorAuditError(errorPayload)}\n`);
    process.exitCode = 1;
  } finally {
    restoreLogger();
    runtime?.close();
  }
}

async function runDraftQualityAudit(input: {
  datasetPath: string;
  candidatesPath?: string;
  json: boolean;
  progress: boolean;
  verbose: boolean;
  outputPath?: string;
}): Promise<void> {
  const outputMode = resolveDraftQualityOutputMode(
    { json: input.json },
    Boolean(stdout.isTTY),
  );
  const progressEnabled =
    outputMode === "human" && input.progress && Boolean(process.stderr.isTTY);
  const progressReporter = new DraftQualityProgressReporter({
    enabled: progressEnabled,
  });
  const logger = progressEnabled
    ? createDraftQualityProgressLogger((entry) => {
        progressReporter.handleLog(entry);
      })
    : undefined;

  try {
    const datasetPath = path.resolve(input.datasetPath);
    const dataset = parseDraftQualityDataset(
      await readJsonInputFile(datasetPath, "draft-quality dataset"),
    );
    const candidatesPath = input.candidatesPath
      ? path.resolve(input.candidatesPath)
      : undefined;
    const candidates = candidatesPath
      ? parseDraftQualityCandidateSet(
          await readJsonInputFile(
            candidatesPath,
            "draft-quality candidates file",
          ),
        )
      : undefined;
    const report = await evaluateDraftQuality({
      dataset,
      ...(candidates ? { candidates } : {}),
      ...(logger ? { logger } : {}),
      dataset_path: datasetPath,
      ...(candidatesPath ? { candidates_path: candidatesPath } : {}),
    });
    const writtenReportPath = input.outputPath
      ? await writeOutputJsonFile(input.outputPath, report)
      : undefined;

    if (outputMode === "json") {
      printJson(report);
    } else {
      const redactedReport = redactStructuredValue(
        report,
        cliPrivacyConfig,
        "cli",
      ) as DraftQualityReport;
      const output = formatDraftQualityReport(redactedReport, {
        verbose: input.verbose,
        ...(writtenReportPath ? { reportPath: writtenReportPath } : {}),
      });

      console.log(output);
    }

    if (report.outcome === "fail") {
      process.exitCode = 1;
    }
  } catch (error) {
    if (outputMode === "json") {
      throw error;
    }

    const errorPayload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);
    process.stderr.write(`${formatDraftQualityError(errorPayload)}\n`);
    process.exitCode = 1;
  }
}

async function runActionsList(
  input: {
    status?: PreparedActionEffectiveStatus;
    limit: number;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.actions.list.start", {
      ...(input.status ? { status: input.status } : {}),
      limit: input.limit,
    });

    const actions = runtime.twoPhaseCommit.listPreparedActions({
      ...(input.status ? { status: input.status } : {}),
      limit: input.limit,
    });

    runtime.logger.log("info", "cli.actions.list.done", {
      count: actions.length,
      ...(input.status ? { status: input.status } : {}),
      limit: input.limit,
    });

    printJson({
      run_id: runtime.runId,
      count: actions.length,
      actions,
    });
  } finally {
    runtime.close();
  }
}

async function runActionsShow(
  input: {
    id: string;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.actions.show.start", {
      id: input.id,
    });

    const action = runtime.twoPhaseCommit.getPreparedAction(input.id);
    const effectiveStatus = computeEffectiveStatus(action.status, action.expiresAtMs);

    runtime.logger.log("info", "cli.actions.show.done", {
      id: action.id,
      effectiveStatus,
    });

    printJson({
      run_id: runtime.runId,
      action: {
        ...action,
        effectiveStatus,
      },
    });
  } finally {
    runtime.close();
  }
}

function readTargetProfileName(
  target: Record<string, unknown>,
): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

async function runConfirmAction(
  input: {
    profileName: string;
    token: string;
    yes: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const runtime = createRuntime(cdpUrl);

  try {
    runtime.logger.log("info", "cli.actions.confirm.start", {
      profileName: input.profileName,
    });

    const preview = runtime.twoPhaseCommit.getPreparedActionPreviewByToken({
      confirmToken: input.token,
    });

    const preparedProfileName = readTargetProfileName(preview.target);
    if (preparedProfileName && preparedProfileName !== input.profileName) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action belongs to profile "${preparedProfileName}", but "${input.profileName}" was requested.`,
        {
          expected_profile_name: preparedProfileName,
          provided_profile_name: input.profileName,
        },
      );
    }

    const summary =
      typeof preview.preview.summary === "string"
        ? preview.preview.summary
        : `Action ${preview.actionType}`;
    const summaryPayload = redactStructuredValue(
      { summary },
      cliPrivacyConfig,
      "cli",
    );

    console.log(`Preview summary: ${summaryPayload.summary}`);
    printJson({
      prepared_action_id: preview.preparedActionId,
      action_type: preview.actionType,
      status: preview.status,
      expires_at_ms: preview.expiresAtMs,
      preview: preview.preview,
    });

    if (!input.yes) {
      if (!stdin.isTTY || !stdout.isTTY) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Refusing to confirm action in non-interactive mode. Add --yes to bypass interactive confirmation.",
        );
      }

      const confirmed = await promptYesNo("Confirm this action?");
      if (!confirmed) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Operator declined action confirmation.",
        );
      }
    }

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: input.token,
    });

    runtime.logger.log("info", "cli.actions.confirm.done", {
      profileName: input.profileName,
      preparedActionId: result.preparedActionId,
      status: result.status,
    });

    printJson({
      run_id: runtime.runId,
      profile_name: input.profileName,
      ...result,
    });
  } finally {
    runtime.close();
  }
}

/** Creates the Commander program for the `linkedin` CLI. */
export function createCliProgram(): Command {
  const program = new Command();

  program
    .name("linkedin")
    .description("LinkedIn Buddy CLI")
    .version(packageJson.version)
    .option(
      "--cdp-url <url>",
      "Connect to existing browser via CDP endpoint (e.g., http://127.0.0.1:18800)",
    )
    .option(
      "--selector-locale <locale>",
      `Prefer localized LinkedIn UI text first (${LINKEDIN_SELECTOR_LOCALES.join(
        ", ",
      )}; region tags like da-DK normalize to da)`,
    )
    .option(
      "--evasion-level <level>",
      "Override anti-bot evasion level for this command (minimal, moderate, paranoid)",
    )
    .option("--no-evasion", "Disable anti-bot evasion for this command")
    .addHelpText(
      "after",
      [
        "",
        "Selector locale:",
        `  --selector-locale <locale> overrides ${LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV} for one command.`,
        `  ${LINKEDIN_BUDDY_SELECTOR_LOCALE_ENV}=da sets the default for the current shell.`,
        "  Unsupported locale values fall back to English with a warning on stderr.",
        "",
        "Diagnostics:",
        "  linkedin audit selectors --help",
        "  linkedin audit draft-quality --help",
        `  ${SELECTOR_AUDIT_DOC_REFERENCE}`,
      ].join("\n"),
    );

  const readCdpUrl = (): string | undefined => {
    const options = program.opts<{ cdpUrl?: string }>();
    return typeof options.cdpUrl === "string" &&
      options.cdpUrl.trim().length > 0
      ? options.cdpUrl.trim()
      : undefined;
  };

  const readSelectorLocale = (): string | undefined => {
    const options = program.opts<{ selectorLocale?: string }>();
    return typeof options.selectorLocale === "string" &&
      options.selectorLocale.trim().length > 0
      ? options.selectorLocale.trim()
      : undefined;
  };

  const readEvasionEnabled = (): boolean => {
    const options = program.opts<{ evasion?: boolean }>();
    return options.evasion !== false;
  };

  const readEvasionLevel = (): string | undefined => {
    const options = program.opts<{ evasionLevel?: string }>();
    return typeof options.evasionLevel === "string" &&
      options.evasionLevel.trim().length > 0
      ? options.evasionLevel.trim()
      : undefined;
  };

  program.hook("preAction", (_command, actionCommand) => {
    cliEvasionEnabled = readEvasionEnabled();
    cliEvasionLevel = readEvasionLevel();
    cliSelectorLocale = readSelectorLocale();
    const profileName = readCommandProfileName(actionCommand);
    activeCliInvocation = {
      commandName: describeCliCommand(actionCommand),
      ...(profileName ? { profileName } : {}),
    };
  });

  program.hook("postAction", async () => {
    await maybeEmitCliFeedbackHint();
  });

  program
    .command("status")
    .description(
      "Check whether the persistent LinkedIn profile is authenticated",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .addHelpText(
      "after",
      [
        "",
        "Diagnostics:",
        "  - output includes an evasion block with the resolved level, enabled features, and diagnostics flag",
        `  - ${LINKEDIN_BUDDY_EVASION_LEVEL_ENV}=minimal|moderate|paranoid sets the default anti-bot profile`,
        `  - ${LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV}=true records debug evasion events in the run log`,
      ].join("\n"),
    )
    .action(async (options: { profile: string }) => {
      await runStatus(options.profile, readCdpUrl());
    });

  program
    .command("rate-limit")
    .description("Show or clear persistent auth rate-limit cooldown state")
    .option("--clear", "Clear saved rate-limit cooldown state", false)
    .action(async (options: { clear: boolean }) => {
      await runRateLimitStatus(options.clear);
    });

  const authCommand = program
    .command("auth")
    .description("Capture and manage stored encrypted LinkedIn sessions");

  const configureAuthSessionCommand = (command: Command): void => {
    command
      .description(
        "Capture an encrypted LinkedIn session from a manual browser login",
      )
      .option("-s, --session <session>", "Stored session name", "default")
      .option(
        "-t, --timeout-minutes <minutes>",
        "How long to wait for the manual login to finish",
        "10",
      )
      .addHelpText(
        "after",
        [
          "",
          "Safety:",
          "  - opens a dedicated browser window for manual login only",
          "  - stores Playwright session state encrypted at rest",
          "  - never prints cookies or storage contents",
          "  - keep the LinkedIn window open until the CLI confirms capture",
          "",
          "Examples:",
          "  linkedin auth session",
          "  linkedin auth session --session smoke --timeout-minutes 15",
          "  linkedin auth session --session smoke",
        ].join("\n"),
      )
      .action(async (options: { session: string; timeoutMinutes: string }) => {
        await runAuthSessionCapture(
          {
            sessionName: coerceProfileName(options.session, "session"),
            timeoutMinutes: coercePositiveInt(
              options.timeoutMinutes,
              "timeout-minutes",
            ),
          },
          readCdpUrl(),
        );
      });
  };

  configureAuthSessionCommand(authCommand.command("session"));
  configureAuthSessionCommand(
    program.command("auth:session", { hidden: true }),
  );

  authCommand
    .command("export-cookies")
    .description(
      "Export the current browser profile session (cookies + localStorage) to a JSON file",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --output <path>", "Output file path", "linkedin-session.json")
    .action(async (options: { profile: string; output: string }) => {
      await runExportCookies(
        {
          profileName: coerceProfileName(options.profile, "profile"),
          outputPath: options.output,
        },
        readCdpUrl(),
      );
    });

  authCommand
    .command("import-cookies")
    .description(
      "Import session cookies from a JSON file into a browser profile",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .requiredOption("-f, --file <path>", "Session state JSON file to import")
    .action(async (options: { profile: string; file: string }) => {
      await runImportCookies(
        {
          profileName: coerceProfileName(options.profile, "profile"),
          inputPath: options.file,
        },
        readCdpUrl(),
      );
    });

  const configureAuthStatusCommand = (command: Command): void => {
    command
      .description(
        "Check authentication status for a stored session without launching a browser",
      )
      .option("-s, --session <session>", "Stored session name", "default")
      .addHelpText(
        "after",
        [
          "",
          "Returns authentication state, session age, and cached identity.",
          "Sub-second response — reads stored session files only, no browser launch.",
          "",
          "Identity is populated automatically when running browser-based commands",
          "(e.g. linkedin status). If identity fields are null, run linkedin status first.",
          "",
          "Examples:",
          "  linkedin auth status",
          "  linkedin auth status --session smoke",
          "  linkedin auth whoami",
        ].join("\n"),
      )
      .action(async (options: { session: string }) => {
        await runAuthWhoami(coerceProfileName(options.session, "session"));
      });
  };

  configureAuthStatusCommand(authCommand.command("status"));
  configureAuthStatusCommand(authCommand.command("whoami"));
  configureAuthStatusCommand(
    program.command("auth:status", { hidden: true }),
  );

  const accountsCommand = program
    .command("accounts")
    .description("Register write-validation accounts and approved targets");

  const configureAccountsAddCommand = (command: Command): void => {
    command
      .argument("<account>", "Account id")
      .description("Register or update a write-validation account")
      .requiredOption(
        "--designation <designation>",
        "Whether the account is primary or secondary",
      )
      .option("--label <label>", "Human-friendly account label")
      .option("--profile <profile>", "Profile name used for local DB state")
      .option(
        "--session <session>",
        "Stored session name captured with linkedin auth session",
      )
      .option(
        "--message-thread <thread>",
        "Approved thread id or URL for send_message",
      )
      .option(
        "--message-participant-pattern <pattern>",
        "Optional regex used to double-check the approved thread participant",
      )
      .option(
        "--invite-profile <profile>",
        "Approved profile URL or slug for connections.send_invitation",
      )
      .option(
        "--invite-note <note>",
        "Optional note for the approved invitation target",
      )
      .option(
        "--followup-profile <profile>",
        "Accepted connection profile URL or slug for network.followup_after_accept",
      )
      .option("--reaction-post <post>", "Approved post URL for feed.like_post")
      .option(
        "--reaction <reaction>",
        `Reaction to use for feed.like_post (${LINKEDIN_FEED_REACTION_TYPES.join(", ")})`,
      )
      .option(
        "--post-visibility <visibility>",
        `Visibility for post.create (${LINKEDIN_POST_VISIBILITY_TYPES.join(", ")})`,
      )
      .option(
        "--force",
        "Overwrite an existing account with the same id",
        false,
      )
      .addHelpText(
        "after",
        [
          "",
          "Examples:",
          "  linkedin-buddy accounts add secondary --designation secondary --session secondary-session --profile secondary",
          "  linkedin accounts add secondary --designation secondary --session secondary-session --message-thread /messaging/thread/abc/ --invite-profile https://www.linkedin.com/in/test-user/",
          "",
          "Notes:",
          "  - write validation refuses to run against accounts marked primary",
          "  - approved targets are stored in config.json under writeValidation.accounts",
          "  - you can rerun with --force to replace an existing account definition",
        ].join("\n"),
      )
      .action(
        async (
          accountId: string,
          options: {
            designation: string;
            followupProfile?: string;
            force: boolean;
            inviteNote?: string;
            inviteProfile?: string;
            label?: string;
            messageParticipantPattern?: string;
            messageThread?: string;
            postVisibility?: string;
            profile?: string;
            reaction?: string;
            reactionPost?: string;
            session?: string;
          },
        ) => {
          await runAccountsAdd({
            accountId,
            designation: options.designation,
            followupProfile: options.followupProfile,
            force: options.force,
            inviteNote: options.inviteNote,
            inviteProfile: options.inviteProfile,
            label: options.label,
            messageParticipantPattern: options.messageParticipantPattern,
            messageThread: options.messageThread,
            postVisibility: options.postVisibility,
            profileName: options.profile,
            reaction: options.reaction,
            reactionPost: options.reactionPost,
            sessionName: options.session,
          });
        },
      );
  };

  configureAccountsAddCommand(accountsCommand.command("add"));
  configureAccountsAddCommand(
    program.command("accounts:add", { hidden: true }),
  );

  const testCommand = program
    .command("test")
    .description("Run LinkedIn live validation workflows");

  const configureLiveValidationCommand = (command: Command): void => {
    command
      .description("Run live validation against LinkedIn using stored sessions")
      .option(
        "--read-only",
        "Confirm that the live validation should run in strictly read-only mode",
        false,
      )
      .option(
        "--write-validation",
        "Run the Tier 3 real-action validation harness against a registered secondary account",
        false,
      )
      .option(
        "--account <account>",
        "Registered write-validation account id (required with --write-validation)",
      )
      .option(
        "--cooldown-seconds <seconds>",
        "Cooldown between write-validation actions in seconds",
        "10",
      )
      .option(
        "-s, --session <session>",
        "Stored session name captured by linkedin auth session",
        "default",
      )
      .option(
        "--timeout-seconds <seconds>",
        "Navigation and selector timeout per validation step",
        "30",
      )
      .option(
        "--max-requests <count>",
        "Maximum live page requests allowed before the run stops (retries included)",
        "20",
      )
      .option(
        "--min-interval-ms <ms>",
        "Minimum delay between live page requests in milliseconds",
        "5000",
      )
      .option(
        "--max-retries <count>",
        "Retry transient timeout or network failures this many times per step",
        "2",
      )
      .option(
        "--retry-base-delay-ms <ms>",
        "Initial exponential backoff delay for transient retries",
        "1000",
      )
      .option(
        "--retry-max-delay-ms <ms>",
        "Maximum exponential backoff delay for transient retries",
        "10000",
      )
      .option(
        "--no-progress",
        "Hide per-step progress updates in human-readable output (stderr)",
      )
      .option(
        "-y, --yes",
        "Skip per-step confirmation prompts; read-only guardrails still apply",
        false,
      )
      .option(
        "--json",
        "Print the structured report JSON to stdout (recommended for CI/scripts)",
        false,
      )
      .addHelpText(
        "after",
        [
          "",
          "Read-only workflow:",
          "  - capture or refresh a stored session first with linkedin auth session --session <name>",
          "  - the validator always runs this fixed suite in order: feed, profile, notifications, inbox, connections",
          "",
          "Output:",
          "  - interactive terminals default to a human-readable summary with per-step progress",
          "  - non-interactive terminals default to JSON",
          "  - --json prints the structured report to stdout; progress stays on stderr",
          "  - there is no separate --verbose flag; human mode is already the most detailed built-in view",
          "  - --no-progress hides the live progress stream for either validation mode",
          "",
          "Configuration:",
          "  - LINKEDIN_BUDDY_HOME stores the encrypted session, reports, and latest-report.json",
          "  - PLAYWRIGHT_EXECUTABLE_PATH overrides Chromium if Playwright cannot find one",
          "",
          "Write validation workflow:",
          "  - requires --write-validation --account <id> and a registered secondary account",
          "  - validates approved targets before the browser starts sending real actions",
          "  - prompts before every action; --yes is rejected on purpose",
          "  - human mode shows live progress on stderr while prompts stay interactive",
          "  - --json keeps the structured report on stdout while prompts stay on stderr",
          "",
          "Exit codes:",
          "  - 0 all validation steps passed",
          "  - 1 one or more validation steps failed (including partial reports)",
          "  - 2 the run could not complete because of a preflight, session, or runtime error",
          "",
          "Safety guardrails:",
          "  - requires --read-only",
          "  - blocks non-GET requests and non-LinkedIn domains",
          "  - retries transient timeouts and network failures with exponential backoff",
          "  - prompts before every step unless --yes is set",
          "  - returns partial results if a later step hits a blocking failure",
          "",
          "Write validation guardrails:",
          "  - runs only against registered secondary accounts and approved targets",
          "  - rejects --session overrides, --yes, and --cdp-url",
          "  - requires an interactive terminal and a visible browser window",
          "",
          "Read-only examples:",
          "  linkedin auth session --session smoke",
          "  linkedin test live --read-only --session smoke",
          "  linkedin test live --read-only --session smoke --yes",
          "  linkedin test live --read-only --session smoke --yes --json",
          "  linkedin test live --read-only --session smoke --yes --json | jq '.operations[] | select(.operation == \"notifications\")'",
          "",
          "Write validation examples:",
          "  linkedin accounts add secondary --designation secondary --session secondary-session --profile secondary --message-thread /messaging/thread/abc123/",
          "  linkedin test live --write-validation --account secondary",
          "  linkedin test live --write-validation --account secondary --cooldown-seconds 20",
          "  linkedin test live --write-validation --account secondary --json",
          "",
          "Docs:",
          "  - docs/live-validation.md",
          "  - docs/live-validation-architecture.md",
          `  - ${WRITE_VALIDATION_DOC_PATH}`,
        ].join("\n"),
      )
      .action(
        async (options: {
          account?: string;
          cooldownSeconds: string;
          json: boolean;
          maxRequests: string;
          maxRetries: string;
          minIntervalMs: string;
          progress: boolean;
          readOnly: boolean;
          retryBaseDelayMs: string;
          retryMaxDelayMs: string;
          session: string;
          timeoutSeconds: string;
          writeValidation: boolean;
          yes: boolean;
        }) => {
          if (options.writeValidation) {
            await runLiveWriteValidation(
              {
                accountId: options.account,
                cooldownSeconds: coerceNonNegativeInt(
                  options.cooldownSeconds,
                  "cooldown-seconds",
                ),
                json: options.json,
                progress: options.progress,
                readOnly: options.readOnly,
                session: options.session,
                timeoutSeconds: coercePositiveInt(
                  options.timeoutSeconds,
                  "timeout-seconds",
                ),
                yes: options.yes,
              },
              readCdpUrl(),
            );
            return;
          }

          await runLiveReadOnlyValidation(
            {
              json: options.json,
              maxRequests: coercePositiveInt(
                options.maxRequests,
                "max-requests",
              ),
              maxRetries: coerceNonNegativeInt(
                options.maxRetries,
                "max-retries",
              ),
              minIntervalMs: coercePositiveInt(
                options.minIntervalMs,
                "min-interval-ms",
              ),
              progress: options.progress,
              readOnly: options.readOnly,
              retryBaseDelayMs: coercePositiveInt(
                options.retryBaseDelayMs,
                "retry-base-delay-ms",
              ),
              retryMaxDelayMs: coercePositiveInt(
                options.retryMaxDelayMs,
                "retry-max-delay-ms",
              ),
              sessionName: coerceProfileName(options.session, "session"),
              timeoutSeconds: coercePositiveInt(
                options.timeoutSeconds,
                "timeout-seconds",
              ),
              yes: options.yes,
            },
            readCdpUrl(),
          );
        },
      );
  };

  configureLiveValidationCommand(testCommand.command("live"));
  configureLiveValidationCommand(
    program.command("test:live", { hidden: true }),
  );

  const dataCommand = program
    .command("data")
    .description("Preview and delete tool-owned local LinkedIn Buddy data");

  dataCommand
    .command("delete")
    .description(
      [
        "Preview local runtime data deletion; rerun with --confirm in an interactive terminal to delete.",
        "Default behavior is a dry-run preview of the shared local database, artifacts, keepalive state, and auth cooldown files. --include-profile expands the scope to all tool-owned browser profiles and adds a second confirmation before removing saved sessions and cookies.",
        'Answering anything other than "yes" cancels safely. If some paths fail, the command reports failed_paths with recovery guidance after deleting what it can.',
        "config.json is preserved by design. Stop keepalive daemons first. Data from external browsers attached with --cdp-url is never deleted.",
      ].join("\n\n"),
    )
    .option(
      "--confirm",
      "Permanently delete the listed tool-owned local data after interactive confirmation prompts",
      false,
    )
    .option(
      "--include-profile",
      "Also preview/delete tool-owned browser profile data; destructive mode adds a second confirmation",
      false,
    )
    .addHelpText(
      "after",
      [
        "",
        "Deletes when confirmed:",
        "  - state.sqlite and SQLite sidecars",
        "  - run artifacts and logs",
        "  - keepalive daemon state",
        "  - auth cooldown state",
        "  - all tool-owned browser profiles when --include-profile is set",
        "",
        "Safety:",
        "  - default behavior is a dry-run preview",
        "  - config.json is preserved by design",
        "  - active keepalive daemons must be stopped first",
        "  - data from external browsers attached with --cdp-url is never deleted",
        "",
        "Interactive flow:",
        "  - --confirm requires an interactive terminal",
        '  - answering anything other than "yes" cancels without deleting files',
        "  - --include-profile adds a second prompt for browser sessions and cookies",
        "",
        "Partial failures:",
        "  - the command keeps deleting other targets when possible",
        "  - failed_paths reports path, code, message, and recoveryHint",
        "  - fix the reported issue and rerun the same command",
      ].join("\n"),
    )
    .action(async (options: { confirm: boolean; includeProfile: boolean }) => {
      await runDataDelete({
        confirm: options.confirm,
        includeProfile: options.includeProfile,
        cdpUrl: readCdpUrl(),
      });
    });

  program
    .command("feedback")
    .description(
      "File agent feedback as a GitHub issue or submit saved feedback",
    )
    .option("--type <type>", `Feedback type (${FEEDBACK_TYPES.join(", ")})`)
    .option("--title <title>", "Short summary for the feedback issue")
    .option(
      "--description <description>",
      "Detailed explanation. Omit to enter a multiline prompt interactively.",
    )
    .option(
      "--submit-pending",
      "Submit all locally saved feedback files after authenticating with gh",
      false,
    )
    .option("--json", "Print the structured feedback result as JSON", false)
    .addHelpText(
      "after",
      [
        "",
        "Interactive mode:",
        "  - running `linkedin-buddy feedback` with no text flags prompts for type, title, and description",
        "  - the description prompt accepts multiple lines and ends on an empty line",
        "",
        "Privacy:",
        "  - secrets, emails, LinkedIn URLs, member identifiers, IP addresses, and user-home file paths are redacted automatically",
        "  - command arguments, response payloads, and LinkedIn data are never attached automatically",
        "",
        "Fallback:",
        "  - if `gh auth status` is not authenticated, feedback is saved under `.linkedin-buddy/pending-feedback/`",
        "  - later submit saved files with `gh auth login` then `linkedin-buddy feedback --submit-pending`",
        "",
        `Encouragement hints appear once per active session, every ${DEFAULT_FEEDBACK_HINT_EVERY_N} invocations, and after errors.`,
      ].join("\n"),
    )
    .action(
      async (options: {
        description?: string;
        json: boolean;
        submitPending: boolean;
        title?: string;
        type?: string;
      }) => {
        await runFeedbackCommand({
          json: options.json,
          submitPending: options.submitPending,
          ...(options.description ? { description: options.description } : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(options.type ? { type: options.type } : {}),
        });
      },
    );

  const keepAliveCommand = program
    .command("keepalive")
    .description(
      "Manage the local session keepalive daemon that records background LinkedIn health checks to disk",
    )
    .addHelpText(
      "after",
      [
        "",
        "Interactive terminals default to human-readable keepalive summaries; non-interactive runs default to JSON.",
        "Use --json for automation or to inspect the structured daemon state directly.",
        "Use --verbose for recent daemon events, saved diagnostics, and extra recovery context.",
        "Use --quiet for a concise human summary and to suppress progress notices.",
        "Status keeps showing the last saved state after the daemon stops, so recovery stays inspectable.",
        "",
        "Examples:",
        "  linkedin keepalive start --profile default",
        "  linkedin keepalive status --profile default --verbose",
        "  linkedin keepalive stop --profile default",
        "  linkedin keepalive status --profile smoke --json",
      ].join("\n"),
    );

  keepAliveCommand
    .command("start")
    .description(
      "Start the local keepalive daemon for a profile and begin background session health checks",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--interval-seconds <seconds>",
      "Health/refresh check interval in seconds",
      "300",
    )
    .option(
      "--jitter-seconds <seconds>",
      "Random +/- jitter per interval in seconds",
      "30",
    )
    .option(
      "--max-consecutive-failures <count>",
      "Mark daemon degraded after this many consecutive failures",
      "5",
    )
    .option("--json", "Print the structured keepalive payload", false)
    .option(
      "--verbose",
      "Show extra diagnostics in human-readable output",
      false,
    )
    .option("--quiet", "Print a concise human-readable summary", false)
    .addHelpText(
      "after",
      [
        "",
        "Startup returns after the detached daemon writes PID, state, and event-log files under the keepalive directory.",
        "Checks continue on the configured interval/jitter cadence and the saved state becomes degraded after the configured failure threshold.",
        "If a stale PID file already exists for this profile, start removes it before launching the new daemon.",
        "Human output shows a startup summary and reminds you how to inspect the first background health checks.",
        "Use --quiet if you only need a compact confirmation message.",
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        intervalSeconds: string;
        jitterSeconds: string;
        maxConsecutiveFailures: string;
        json: boolean;
        quiet: boolean;
        verbose: boolean;
      }) => {
        await runKeepAliveCliAction(options, async (outputOptions) => {
          await runKeepAliveStart(
            {
              profileName: options.profile,
              intervalSeconds: coercePositiveInt(
                options.intervalSeconds,
                "interval-seconds",
              ),
              jitterSeconds: coerceNonNegativeInt(
                options.jitterSeconds,
                "jitter-seconds",
              ),
              maxConsecutiveFailures: coercePositiveInt(
                options.maxConsecutiveFailures,
                "max-consecutive-failures",
              ),
            },
            outputOptions,
            readCdpUrl(),
          );
        });
      },
    );

  keepAliveCommand
    .command("status")
    .description(
      "Show daemon health, the latest saved session check, and recovery guidance",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured keepalive payload", false)
    .option(
      "--verbose",
      "Show recent daemon events and extra diagnostics",
      false,
    )
    .option("--quiet", "Print a concise human-readable summary", false)
    .addHelpText(
      "after",
      [
        "",
        "Status reads the daemon state and recent keepalive events saved for the selected profile.",
        "Interactive terminals show a human summary with Next Steps and Action Needed guidance when recovery is needed.",
        "Use --verbose to include recent daemon events, timestamps, and extra session detail.",
        "Use --json for automation or to inspect the raw saved state.",
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        json: boolean;
        quiet: boolean;
        verbose: boolean;
      }) => {
        await runKeepAliveCliAction(options, async (outputOptions) => {
          await runKeepAliveStatus(options.profile, outputOptions);
        });
      },
    );

  keepAliveCommand
    .command("stop")
    .description(
      "Stop the local keepalive daemon and preserve the last saved health state",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured keepalive payload", false)
    .option(
      "--verbose",
      "Show extra diagnostics in human-readable output",
      false,
    )
    .option("--quiet", "Print a concise human-readable summary", false)
    .addHelpText(
      "after",
      [
        "",
        "Stopping the daemon preserves the last saved state file and event log for later inspection.",
        "Use status after stopping if you want to confirm the daemon is idle or review the last recorded failure.",
        "If the daemon ignores SIGTERM for 5 seconds, stop force-kills it and records that in the saved state.",
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        json: boolean;
        quiet: boolean;
        verbose: boolean;
      }) => {
        await runKeepAliveCliAction(options, async (outputOptions) => {
          await runKeepAliveStop(options.profile, outputOptions);
        });
      },
    );

  keepAliveCommand
    .command("__run", { hidden: true })
    .description("Internal daemon command")
    .requiredOption("-p, --profile <profile>", "Profile name")
    .requiredOption("--interval-seconds <seconds>", "Loop interval in seconds")
    .requiredOption("--jitter-seconds <seconds>", "Interval jitter in seconds")
    .requiredOption(
      "--max-consecutive-failures <count>",
      "Maximum failures before degraded status",
    )
    .action(
      async (options: {
        profile: string;
        intervalSeconds: string;
        jitterSeconds: string;
        maxConsecutiveFailures: string;
      }) => {
        await runKeepAliveDaemon(
          {
            profileName: options.profile,
            intervalSeconds: coercePositiveInt(
              options.intervalSeconds,
              "interval-seconds",
            ),
            jitterSeconds: coerceNonNegativeInt(
              options.jitterSeconds,
              "jitter-seconds",
            ),
            maxConsecutiveFailures: coercePositiveInt(
              options.maxConsecutiveFailures,
              "max-consecutive-failures",
            ),
          },
          readCdpUrl(),
        );
      },
    );

  const schedulerCommand = program
    .command("scheduler")
    .description(
      "Manage the local follow-up scheduler daemon. The scheduler only prepares follow-ups near their due time, and prepared actions still require manual confirmation.",
    )
    .addHelpText(
      "afterAll",
      [
        "",
        "Interactive terminals default to human-readable scheduler summaries.",
        "Use --json for automation, piping, or to inspect the full structured payload.",
        "The scheduler only prepares follow-ups; confirmation always remains manual.",
        "",
        "Examples:",
        "  linkedin scheduler start --profile default",
        "  linkedin scheduler status --profile default --jobs 10",
        "  linkedin scheduler run-once --profile default --json",
        "  linkedin scheduler stop --profile default",
      ].join("\n"),
    );

  schedulerCommand
    .command("start")
    .description(
      "Start the local scheduler daemon for a profile using the current poll interval and business-hours settings",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured scheduler payload", false)
    .addHelpText(
      "after",
      [
        "",
        "The daemon wakes up on the configured poll interval and respects scheduler business hours.",
        "It only prepares due follow-ups; confirmation always remains manual.",
        "Use `linkedin scheduler status` to inspect queue counts, recent history, and state/log paths.",
      ].join("\n"),
    )
    .action(async (options: { profile: string; json: boolean }) => {
      await runSchedulerCliAction(options, async (outputMode) => {
        await runSchedulerStart(options.profile, outputMode, readCdpUrl());
      });
    });

  schedulerCommand
    .command("status")
    .description(
      "Show daemon health, queue summary, and recent scheduler history",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--jobs <count>",
      "Show up to this many queued and recent jobs in the status output",
      String(DEFAULT_SCHEDULER_STATUS_JOB_LIMIT),
    )
    .option("--json", "Print the structured scheduler payload", false)
    .addHelpText(
      "after",
      [
        "",
        "Status output previews queued jobs and recent history for the selected profile.",
        "Use --jobs <count> to control how many queued and recent jobs are shown.",
        "Use --json for automation or to inspect the full structured scheduler payload.",
      ].join("\n"),
    )
    .action(
      async (options: { profile: string; jobs: string; json: boolean }) => {
        await runSchedulerCliAction(options, async (outputMode) => {
          await runSchedulerStatus(
            options.profile,
            outputMode,
            coercePositiveInt(options.jobs, "jobs"),
          );
        });
      },
    );

  schedulerCommand
    .command("stop")
    .description(
      "Stop the local scheduler daemon and clean up stale state without deleting queued jobs",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured scheduler payload", false)
    .addHelpText(
      "after",
      [
        "",
        "Stopping the daemon does not delete queued jobs or prepared follow-up actions.",
        "Use `linkedin scheduler status` after stopping if you want to confirm the daemon is idle.",
      ].join("\n"),
    )
    .action(async (options: { profile: string; json: boolean }) => {
      await runSchedulerCliAction(options, async (outputMode) => {
        await runSchedulerStop(options.profile, outputMode);
      });
    });

  schedulerCommand
    .command("run-once")
    .alias("tick")
    .description(
      "Run one scheduler tick immediately, refresh queue state, and summarize the result",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured scheduler payload", false)
    .addHelpText(
      "after",
      [
        "",
        "A tick refreshes accepted invitations, syncs queue state, and prepares any due follow-ups.",
        "Prepared actions still require manual confirmation after a successful tick.",
        "Use this command when you want an immediate scheduler pass without starting the daemon.",
      ].join("\n"),
    )
    .action(async (options: { profile: string; json: boolean }) => {
      await runSchedulerCliAction(options, async (outputMode) => {
        await runSchedulerRunOnce(options.profile, outputMode, readCdpUrl());
      });
    });

  schedulerCommand
    .command("__run", { hidden: true })
    .description("Internal daemon command")
    .requiredOption("-p, --profile <profile>", "Profile name")
    .action(async (options: { profile: string }) => {
      await runSchedulerDaemon(options.profile, readCdpUrl());
    });

  const activityCommand = program
    .command("activity")
    .description(
      "Use human-readable activity summaries by default in interactive terminals. Manage poll-based LinkedIn activity watches, webhook subscriptions, and the local activity daemon.",
    )
    .addHelpText(
      "after",
      [
        "",
        "Interactive terminals default to human-readable activity summaries.",
        "Use --json for automation, piping, or to inspect the full structured activity payload.",
        "Use `linkedin activity run-once` when you want an immediate poll without keeping the daemon running.",
        "",
        "Examples:",
        "  linkedin activity watch add --profile default --kind notifications --interval-seconds 600",
        "  linkedin activity webhook add --watch <watch-id> --url https://example.com/hooks/linkedin",
        "  linkedin activity run-once --profile default --json",
        "  linkedin activity start --profile default",
        "  linkedin activity status --profile default",
        "  linkedin activity stop --profile default",
      ].join("\n"),
    );

  const activityWatchCommand = activityCommand
    .command("watch")
    .description("Manage durable LinkedIn polling watches");

  activityWatchCommand
    .command("add")
    .description("Create a new activity watch")
    .requiredOption(
      "--kind <kind>",
      `Watch kind: ${ACTIVITY_WATCH_KINDS.join(", ")}`,
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--interval-seconds <seconds>", "Poll interval in seconds")
    .option("--cron <expression>", "Cron schedule expression")
    .option("--target <json>", "Watch target as JSON object text")
    .option("--target-file <path>", "Read watch target from a JSON file")
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: {
        kind: string;
        json: boolean;
        profile: string;
        intervalSeconds?: string;
        cron?: string;
        target?: string;
        targetFile?: string;
      }) => {
        await runActivityCliAction(options, async (outputMode) => {
          const target = await readActivityTargetInput(options);
          await runActivityWatchAdd(
            {
              profileName: options.profile,
              kind: coerceActivityWatchKind(options.kind),
              ...(typeof options.intervalSeconds === "string"
                ? {
                    intervalSeconds: coercePositiveInt(
                      options.intervalSeconds,
                      "interval-seconds",
                    ),
                  }
                : {}),
              ...(options.cron ? { cron: options.cron } : {}),
              ...(target ? { target } : {}),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityWatchCommand
    .command("list")
    .description("List activity watches for a profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--status <status>",
      `Filter by status: ${ACTIVITY_WATCH_STATUSES.join(", ")}`,
    )
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: { profile: string; status?: string; json: boolean }) => {
        await runActivityCliAction(options, async (outputMode) => {
          await runActivityWatchList(
            {
              profileName: options.profile,
              ...(options.status
                ? { status: coerceActivityWatchStatusValue(options.status) }
                : {}),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityWatchCommand
    .command("pause")
    .description("Pause an activity watch")
    .argument("<watchId>", "Activity watch id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (watchId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWatchPause(watchId, outputMode, readCdpUrl());
      });
    });

  activityWatchCommand
    .command("resume")
    .description("Resume an activity watch and make it due immediately")
    .argument("<watchId>", "Activity watch id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (watchId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWatchResume(watchId, outputMode, readCdpUrl());
      });
    });

  activityWatchCommand
    .command("remove")
    .description("Remove an activity watch")
    .argument("<watchId>", "Activity watch id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (watchId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWatchRemove(watchId, outputMode, readCdpUrl());
      });
    });

  const activityWebhookCommand = activityCommand
    .command("webhook")
    .description("Manage webhook subscriptions for activity watches");

  activityWebhookCommand
    .command("add")
    .description("Register a webhook subscription for one watch")
    .requiredOption("--watch <watchId>", "Activity watch id")
    .requiredOption("--url <deliveryUrl>", "Webhook delivery URL")
    .option(
      "-e, --event <eventType...>",
      `Event filters: ${ACTIVITY_EVENT_TYPES.join(", ")}`,
    )
    .option("--secret <secret>", "Webhook signing secret")
    .option("--max-attempts <count>", "Maximum delivery attempts")
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: {
        watch: string;
        url: string;
        event?: string[];
        json: boolean;
        secret?: string;
        maxAttempts?: string;
      }) => {
        await runActivityCliAction(options, async (outputMode) => {
          await runActivityWebhookAdd(
            {
              watchId: options.watch,
              deliveryUrl: options.url,
              ...(options.event
                ? { eventTypes: coerceActivityEventTypes(options.event) }
                : {}),
              ...(options.secret ? { signingSecret: options.secret } : {}),
              ...(typeof options.maxAttempts === "string"
                ? {
                    maxAttempts: coercePositiveInt(
                      options.maxAttempts,
                      "max-attempts",
                    ),
                  }
                : {}),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityWebhookCommand
    .command("list")
    .description("List webhook subscriptions")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--watch <watchId>", "Filter by watch id")
    .option(
      "--status <status>",
      `Filter by status: ${WEBHOOK_SUBSCRIPTION_STATUSES.join(", ")}`,
    )
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: {
        profile: string;
        watch?: string;
        status?: string;
        json: boolean;
      }) => {
        await runActivityCliAction(options, async (outputMode) => {
          await runActivityWebhookList(
            {
              profileName: options.profile,
              ...(options.watch ? { watchId: options.watch } : {}),
              ...(options.status
                ? {
                    status: coerceWebhookSubscriptionStatusValue(
                      options.status,
                    ),
                  }
                : {}),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityWebhookCommand
    .command("pause")
    .description("Pause a webhook subscription")
    .argument("<subscriptionId>", "Webhook subscription id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (subscriptionId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWebhookPause(subscriptionId, outputMode, readCdpUrl());
      });
    });

  activityWebhookCommand
    .command("resume")
    .description("Resume a webhook subscription")
    .argument("<subscriptionId>", "Webhook subscription id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (subscriptionId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWebhookResume(
          subscriptionId,
          outputMode,
          readCdpUrl(),
        );
      });
    });

  activityWebhookCommand
    .command("remove")
    .description("Remove a webhook subscription")
    .argument("<subscriptionId>", "Webhook subscription id")
    .option("--json", "Print the structured activity payload", false)
    .action(async (subscriptionId: string, options: { json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityWebhookRemove(
          subscriptionId,
          outputMode,
          readCdpUrl(),
        );
      });
    });

  activityCommand
    .command("events")
    .description("List recently emitted activity events")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--watch <watchId>", "Filter by watch id")
    .option("-l, --limit <limit>", "Maximum events to return", "20")
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: {
        profile: string;
        watch?: string;
        limit: string;
        json: boolean;
      }) => {
        await runActivityCliAction(options, async (outputMode) => {
          await runActivityEventsList(
            {
              profileName: options.profile,
              ...(options.watch ? { watchId: options.watch } : {}),
              limit: coercePositiveInt(options.limit, "limit"),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityCommand
    .command("deliveries")
    .description("List recent webhook delivery attempts")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--watch <watchId>", "Filter by watch id")
    .option(
      "--subscription <subscriptionId>",
      "Filter by webhook subscription id",
    )
    .option(
      "--status <status>",
      `Filter by status: ${WEBHOOK_DELIVERY_ATTEMPT_STATUSES.join(", ")}`,
    )
    .option("-l, --limit <limit>", "Maximum deliveries to return", "20")
    .option("--json", "Print the structured activity payload", false)
    .action(
      async (options: {
        profile: string;
        watch?: string;
        subscription?: string;
        status?: string;
        limit: string;
        json: boolean;
      }) => {
        await runActivityCliAction(options, async (outputMode) => {
          await runActivityDeliveriesList(
            {
              profileName: options.profile,
              ...(options.watch ? { watchId: options.watch } : {}),
              ...(options.subscription
                ? { subscriptionId: options.subscription }
                : {}),
              ...(options.status
                ? { status: coerceWebhookDeliveryStatusValue(options.status) }
                : {}),
              limit: coercePositiveInt(options.limit, "limit"),
            },
            outputMode,
            readCdpUrl(),
          );
        });
      },
    );

  activityCommand
    .command("start")
    .description("Start the local activity polling daemon for a profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured activity payload", false)
    .action(async (options: { profile: string; json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityStart(options.profile, outputMode, readCdpUrl());
      });
    });

  activityCommand
    .command("status")
    .description("Show local activity daemon state and persistent queue counts")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured activity payload", false)
    .action(async (options: { profile: string; json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityStatus(options.profile, outputMode);
      });
    });

  activityCommand
    .command("stop")
    .description("Stop the local activity polling daemon")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured activity payload", false)
    .action(async (options: { profile: string; json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityStop(options.profile, outputMode);
      });
    });

  activityCommand
    .command("run-once")
    .alias("tick")
    .description("Run one activity polling tick immediately")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--json", "Print the structured activity payload", false)
    .action(async (options: { profile: string; json: boolean }) => {
      await runActivityCliAction(options, async (outputMode) => {
        await runActivityRunOnce(options.profile, outputMode, readCdpUrl());
      });
    });

  activityCommand
    .command("__run", { hidden: true })
    .description("Internal activity daemon command")
    .requiredOption("-p, --profile <profile>", "Profile name")
    .action(async (options: { profile: string }) => {
      await runActivityDaemon(options.profile, readCdpUrl());
    });

  program
    .command("login")
    .description("Open LinkedIn login in a persistent Playwright profile")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-t, --timeout-minutes <minutes>",
      "How long to wait for successful login",
      "10",
    )
    .option(
      "--headless",
      "Authenticate headlessly with email and password",
      false,
    )
    .option(
      "--headed",
      "Force headed (non-headless) mode for headless login",
      false,
    )
    .option(
      "--headed-fallback",
      "Retry in headed mode if CAPTCHA is detected during headless login",
      false,
    )
    .option(
      "--warm-profile",
      "Browse LinkedIn organically before login to reduce CAPTCHA risk",
      false,
    )
    .option(
      "--manual",
      "Capture an encrypted stored session via manual browser login (stealth-hardened)",
      false,
    )
    .option(
      "-s, --session <session>",
      "Stored session name (used with --manual)",
      "default",
    )
    .option("--email <email>", "LinkedIn email (or set LINKEDIN_EMAIL env var)")
    .option(
      "--password <password>",
      "LinkedIn password (or set LINKEDIN_PASSWORD env var)",
    )
    .option(
      "--mfa-code <code>",
      "MFA verification code (or set LINKEDIN_MFA_CODE env var)",
    )
    .option(
      "--mfa-interactive",
      "Prompt for MFA code interactively via stdin",
      false,
    )
    .action(
      async (options: {
        profile: string;
        timeoutMinutes: string;
        headless: boolean;
        headed: boolean;
        headedFallback: boolean;
        warmProfile: boolean;
        manual: boolean;
        session: string;
        email?: string;
        password?: string;
        mfaCode?: string;
        mfaInteractive: boolean;
      }) => {
        const timeoutMinutes = coercePositiveInt(
          options.timeoutMinutes,
          "timeout-minutes",
        );

        if (options.manual) {
          await runManualLogin(
            {
              sessionName: coerceProfileName(options.session, "session"),
              timeoutMinutes,
            },
            readCdpUrl(),
          );
          return;
        }

        if (options.headless) {
          const email = options.email ?? process.env.LINKEDIN_EMAIL;
          const password = options.password ?? process.env.LINKEDIN_PASSWORD;
          const mfaCode = options.mfaCode ?? process.env.LINKEDIN_MFA_CODE;

          let mfaCallback: (() => Promise<string | undefined>) | undefined;
          if (options.mfaInteractive && !mfaCode) {
            mfaCallback = async () => {
              const rl = createInterface({
                input: stdin,
                output: process.stderr,
              });
              try {
                const code = await rl.question("LinkedIn verification code: ");
                return code.trim() || undefined;
              } finally {
                rl.close();
              }
            };
          }

          if (!email) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "Headless login requires --email or LINKEDIN_EMAIL environment variable.",
            );
          }

          if (!password) {
            throw new LinkedInBuddyError(
              "ACTION_PRECONDITION_FAILED",
              "Headless login requires --password or LINKEDIN_PASSWORD environment variable.",
            );
          }

          await runHeadlessLogin(
            {
              profileName: options.profile,
              email,
              password,
              ...(typeof mfaCode === "string" ? { mfaCode } : {}),
              ...(mfaCallback ? { mfaCallback } : {}),
              timeoutMinutes,
              headed: options.headed,
              headedFallback: options.headedFallback,
              warmProfile: options.warmProfile,
            },
            readCdpUrl(),
          );
        } else {
          await runLogin(options.profile, timeoutMinutes, readCdpUrl());
        }
      },
    );

  const sessionCommand = program
    .command("session")
    .description("Manage stored encrypted LinkedIn sessions");

  sessionCommand
    .command("check")
    .description(
      "Validate the health of a stored LinkedIn session without launching a browser",
    )
    .option("-s, --session <session>", "Stored session name", "default")
    .addHelpText(
      "after",
      [
        "",
        "Checks:",
        "  - whether the encrypted session file exists on disk",
        "  - whether the li_at authentication cookie is present",
        "  - whether the li_at cookie has expired",
        "  - whether a browser fingerprint is stored for the session",
        "",
        "Examples:",
        "  linkedin session check",
        "  linkedin session check --session smoke",
      ].join("\n"),
    )
    .action(async (options: { session: string }) => {
      await runSessionCheck(coerceProfileName(options.session, "session"));
    });

  const runFixtureRecordCommand = async (options: {
    har: boolean;
    height: string;
    manifest?: string;
    page: LinkedInReplayPageType[];
    profile: string;
    set: string;
    width: string;
  }) => {
    const pageTypes = uniqueFixtureReplayPageTypes(
      options.page.length > 0 ? options.page : [...LINKEDIN_REPLAY_PAGE_TYPES],
    );

    await runFixturesRecord({
      har: options.har,
      height: coercePositiveInt(options.height, "height"),
      ...(options.manifest ? { manifestPath: options.manifest } : {}),
      pageTypes,
      profileName: coerceProfileName(options.profile),
      setName: coerceProfileName(options.set, "set"),
      width: coercePositiveInt(options.width, "width"),
    });
  };

  const runFixtureCheckCommand = async (options: {
    manifest?: string;
    maxAgeDays: string;
    set?: string;
  }) => {
    await runFixturesCheck({
      ...(options.manifest ? { manifestPath: options.manifest } : {}),
      maxAgeDays: coercePositiveInt(options.maxAgeDays, "max-age-days"),
      ...(options.set
        ? { setName: coerceProfileName(options.set, "set") }
        : {}),
    });
  };

  const configureFixtureRecordCommand = (command: Command): Command =>
    command
      .description(
        "Launch a manual Playwright capture flow and update a LinkedIn replay fixture set",
      )
      .option(
        "-p, --profile <profile>",
        "Profile name used for the manual LinkedIn browser session",
        DEFAULT_FIXTURE_RECORD_PROFILE,
      )
      .option(
        "-s, --set <name>",
        "Fixture set name stored under test/fixtures/",
        DEFAULT_FIXTURE_RECORD_SET,
      )
      .option(
        "--page <type>",
        `Repeat or comma-separate page types (${LINKEDIN_REPLAY_PAGE_TYPES.join(", ")})`,
        collectFixtureReplayPageTypes,
        [] as LinkedInReplayPageType[],
      )
      .option(
        "--manifest <path>",
        `Fixture manifest path (default: ${resolveFixtureManifestPath()})`,
      )
      .option(
        "--width <px>",
        "Viewport width in pixels",
        String(DEFAULT_FIXTURE_VIEWPORT.width),
      )
      .option(
        "--height <px>",
        "Viewport height in pixels",
        String(DEFAULT_FIXTURE_VIEWPORT.height),
      )
      .option(
        "--no-har",
        "Skip HAR capture and only save HTML snapshots + replay routes",
      )
      .addHelpText(
        "after",
        [
          "",
          "Capture flow:",
          "  - launches a persistent Playwright browser for manual LinkedIn navigation",
          "  - records only linkedin.com / licdn.com responses into the selected fixture set",
          "  - rewrites the requested pages while preserving untouched page entries and routes",
          "",
          "Examples:",
          "  linkedin fixtures record --page feed --page messaging",
          "  linkedin-buddy fixtures record --set da-dk --page feed,notifications --no-har",
          "",
          "Next steps:",
          "  linkedin fixtures check --set <name>",
          "  LINKEDIN_E2E_FIXTURE_SET=<name> npm run test:e2e:fixtures -- packages/core/src/__tests__/e2e/inbox.e2e.test.ts",
        ].join("\n"),
      )
      .action(runFixtureRecordCommand);

  const configureFixtureCheckCommand = (command: Command): Command =>
    command
      .description(
        "Validate replay fixture freshness and print staleness warnings",
      )
      .option(
        "-s, --set <name>",
        "Only validate one fixture set from the manifest",
      )
      .option(
        "--manifest <path>",
        `Fixture manifest path (default: ${resolveFixtureManifestPath()})`,
      )
      .option(
        "--max-age-days <days>",
        "Warn when captured pages are older than this many days",
        String(DEFAULT_FIXTURE_STALENESS_DAYS),
      )
      .addHelpText(
        "after",
        [
          "",
          "Examples:",
          "  linkedin fixtures check",
          "  linkedin-buddy fixtures check --set ci --max-age-days 14",
          "",
          "Follow-up:",
          "  Re-record stale pages with linkedin fixtures record --set <name> --page <type>",
          "  Replay a checked set with LINKEDIN_E2E_FIXTURE_SET=<name> npm run test:e2e:fixtures",
        ].join("\n"),
      )
      .action(runFixtureCheckCommand);

  const fixturesCommand = program
    .command("fixtures")
    .description("Record and validate LinkedIn replay fixture sets");

  configureFixtureRecordCommand(fixturesCommand.command("record"));
  configureFixtureCheckCommand(fixturesCommand.command("check"));
  configureFixtureRecordCommand(
    program.command("fixtures:record", { hidden: true }),
  );
  configureFixtureCheckCommand(
    program.command("fixtures:check", { hidden: true }),
  );

  program
    .command("search")
    .description("Search LinkedIn")
    .argument("<query>", "Search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-c, --category <category>",
      `Search category: ${SEARCH_CATEGORIES.join(", ")}`,
      "people",
    )
    .option("-l, --limit <limit>", "Max results", "10")
    .action(
      async (
        query: string,
        options: { profile: string; category: string; limit: string },
      ) => {
        await runSearch(
          {
            profileName: options.profile,
            query,
            category: coerceSearchCategory(options.category),
            limit: coercePositiveInt(options.limit, "limit"),
          },
          readCdpUrl(),
        );
      },
    );

  const inboxCommand = program
    .command("inbox")
    .description("List and inspect LinkedIn inbox threads");

  inboxCommand
    .command("search-recipients")
    .description("Search LinkedIn recipients for new messaging flows")
    .requiredOption("--query <query>", "Recipient search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max recipients", "10")
    .action(
      async (options: { profile: string; query: string; limit: string }) => {
        await runInboxSearchRecipients(
          {
            profileName: options.profile,
            query: options.query,
            limit: coercePositiveInt(options.limit, "limit"),
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("list")
    .description("List inbox threads")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-u, --unread", "Only show unread threads", false)
    .option("-l, --limit <limit>", "Max threads", "20")
    .action(
      async (options: { profile: string; unread: boolean; limit: string }) => {
        await runInboxList(
          {
            profileName: options.profile,
            unreadOnly: options.unread,
            limit: coercePositiveInt(options.limit, "limit"),
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("show")
    .description("Show details for one inbox thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max messages to return", "20")
    .action(
      async (options: { profile: string; thread: string; limit: string }) => {
        await runInboxShow(
          {
            profileName: options.profile,
            thread: options.thread,
            limit: coercePositiveInt(options.limit, "limit"),
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("prepare-new-thread")
    .description("Prepare a two-phase first message for a new LinkedIn thread")
    .requiredOption(
      "-r, --recipient <recipient>",
      "LinkedIn profile URL, /in/ path, or vanity name",
      collectNonEmptyStrings,
      [] as string[],
    )
    .requiredOption("--text <text>", "First message text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: {
        profile: string;
        recipient: string[];
        text: string;
      }) => {
        await runPrepareNewThread(
          {
            profileName: options.profile,
            recipients: options.recipient,
            text: options.text,
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("prepare-reply")
    .description("Prepare a two-phase send_message action for a thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .requiredOption("--text <text>", "Message text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string; text: string }) => {
        await runPrepareReply(
          {
            profileName: options.profile,
            thread: options.thread,
            text: options.text,
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("prepare-add-recipients")
    .description("Prepare a two-phase recipient update for an existing thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .requiredOption(
      "-r, --recipient <recipient>",
      "LinkedIn profile URL, /in/ path, or vanity name",
      collectNonEmptyStrings,
      [] as string[],
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: {
        profile: string;
        recipient: string[];
        thread: string;
      }) => {
        await runPrepareAddRecipients(
          {
            profileName: options.profile,
            recipients: options.recipient,
            thread: options.thread,
          },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("archive")
    .description("Archive an inbox thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string }) => {
        await runInboxArchive(
          { profileName: options.profile, thread: options.thread },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("unarchive")
    .description("Unarchive an inbox thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string }) => {
        await runInboxUnarchive(
          { profileName: options.profile, thread: options.thread },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("mark-unread")
    .description("Mark an inbox thread as unread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string }) => {
        await runInboxMarkUnread(
          { profileName: options.profile, thread: options.thread },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("mute")
    .description("Mute an inbox thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (options: { profile: string; thread: string }) => {
        await runInboxMute(
          { profileName: options.profile, thread: options.thread },
          readCdpUrl(),
        );
      },
    );

  inboxCommand
    .command("prepare-react")
    .description("Prepare a two-phase reaction on a message in a thread")
    .requiredOption("--thread <thread>", "Thread id or LinkedIn thread URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--reaction <reaction>",
      "Reaction type: like, celebrate, support, love, insightful, funny",
    )
    .option(
      "--message-index <index>",
      "Zero-based message index (default: latest message)",
    )
    .action(
      async (options: {
        profile: string;
        thread: string;
        reaction?: string;
        messageIndex?: string;
      }) => {
        await runPrepareReact(
          {
            profileName: options.profile,
            thread: options.thread,
            ...(options.reaction ? { reaction: options.reaction } : {}),
            ...(options.messageIndex !== undefined
              ? {
                  messageIndex: coerceNonNegativeInt(
                    options.messageIndex,
                    "message-index",
                  ),
                }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const connectionsCommand = program
    .command("connections")
    .description("Manage LinkedIn connections");

  connectionsCommand
    .command("list")
    .description("List your LinkedIn connections")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max connections to return", "40")
    .action(async (options: { profile: string; limit: string }) => {
      await runConnectionsList(
        {
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit"),
        },
        readCdpUrl(),
      );
    });

  connectionsCommand
    .command("pending")
    .description("List pending connection invitations")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-f, --filter <filter>", "Filter: sent, received, or all", "all")
    .action(async (options: { profile: string; filter: string }) => {
      const filter = options.filter as "sent" | "received" | "all";
      if (!["sent", "received", "all"].includes(filter)) {
        throw new LinkedInBuddyError(
          "ACTION_PRECONDITION_FAILED",
          "Filter must be 'sent', 'received', or 'all'.",
        );
      }
      await runConnectionsPending(
        {
          profileName: options.profile,
          filter,
        },
        readCdpUrl(),
      );
    });

  connectionsCommand
    .command("invite")
    .description("Prepare a connection invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-n, --note <note>", "Optional invitation note")
    .action(
      async (target: string, options: { profile: string; note?: string }) => {
        await runConnectionsInvite(
          {
            profileName: options.profile,
            targetProfile: target,
            ...(options.note ? { note: options.note } : {}),
          },
          readCdpUrl(),
        );
      },
    );

  connectionsCommand
    .command("accept")
    .description("Prepare to accept a connection invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL of the sender")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runConnectionsAccept(
        {
          profileName: options.profile,
          targetProfile: target,
        },
        readCdpUrl(),
      );
    });

  connectionsCommand
    .command("withdraw")
    .description("Prepare to withdraw a sent invitation (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runConnectionsWithdraw(
        {
          profileName: options.profile,
          targetProfile: target,
        },
        readCdpUrl(),
      );
    });

  const membersCommand = program
    .command("members")
    .description("Prepare LinkedIn member safety actions");

  membersCommand
    .command("block")
    .description("Prepare to block a LinkedIn member (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runMembersPrepareBlock(
        {
          profileName: options.profile,
          targetProfile: target,
        },
        readCdpUrl(),
      );
    });

  membersCommand
    .command("unblock")
    .description("Prepare to unblock a LinkedIn member (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runMembersPrepareUnblock(
        {
          profileName: options.profile,
          targetProfile: target,
        },
        readCdpUrl(),
      );
    });

  membersCommand
    .command("report")
    .description("Prepare to report a LinkedIn member (two-phase)")
    .argument("<target>", "Vanity name or profile URL")
    .requiredOption(
      "-r, --reason <reason>",
      `Report reason (${LINKEDIN_MEMBER_REPORT_REASONS.join(", ")})`,
    )
    .option(
      "-d, --details <details>",
      "Optional report details for free-text steps",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (
        target: string,
        options: {
          details?: string;
          profile: string;
          reason: string;
        },
      ) => {
        await runMembersPrepareReport(
          {
            profileName: options.profile,
            targetProfile: target,
            reason: options.reason,
            ...(options.details ? { details: options.details } : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const privacyCommand = program
    .command("privacy")
    .description("Inspect and prepare LinkedIn privacy setting changes");

  privacyCommand
    .command("settings")
    .description("Read supported LinkedIn privacy settings")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runPrivacyGetSettings(
        {
          profileName: options.profile,
        },
        readCdpUrl(),
      );
    });

  privacyCommand
    .command("update")
    .description("Prepare to update a LinkedIn privacy setting (two-phase)")
    .argument(
      "<settingKey>",
      `Setting key (${LINKEDIN_PRIVACY_SETTING_KEYS.join(", ")})`,
    )
    .argument("<value>", "Requested setting value")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (
        settingKey: string,
        value: string,
        options: { profile: string },
      ) => {
        await runPrivacyPrepareUpdateSetting(
          {
            profileName: options.profile,
            settingKey,
            value,
          },
          readCdpUrl(),
        );
      },
    );

  const followupsCommand = program
    .command("followups")
    .description("Detect accepted invitations and prepare follow-up messages");

  followupsCommand
    .command("list")
    .description(
      "List recently accepted connections detected from sent invites",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-s, --since <window>",
      "Lookback window such as 30m, 12h, 7d, or 2w",
      DEFAULT_FOLLOWUP_SINCE,
    )
    .action(async (options: { profile: string; since: string }) => {
      await runFollowupsList(
        {
          profileName: options.profile,
          since: options.since,
        },
        readCdpUrl(),
      );
    });

  followupsCommand
    .command("prepare")
    .description(
      "Prepare follow-up messages for newly accepted connections (two-phase)",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-s, --since <window>",
      "Lookback window such as 30m, 12h, 7d, or 2w",
      DEFAULT_FOLLOWUP_SINCE,
    )
    .action(async (options: { profile: string; since: string }) => {
      await runFollowupsPrepare(
        {
          profileName: options.profile,
          since: options.since,
        },
        readCdpUrl(),
      );
    });

  const feedCommand = program
    .command("feed")
    .description("Browse and prepare actions for LinkedIn feed posts");

  feedCommand
    .command("list")
    .description("List posts from your LinkedIn feed")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max posts to return", "10")
    .option(
      "-m, --mine",
      "Show only your own posts (navigates to your activity page)",
    )
    .action(
      async (options: { profile: string; limit: string; mine?: true }) => {
        await runFeedList(
          {
            profileName: options.profile,
            limit: coercePositiveInt(options.limit, "limit"),
            mine: options.mine === true,
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("view")
    .description("View details for one LinkedIn feed post")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (post: string, options: { profile: string }) => {
      await runFeedView(
        {
          profileName: options.profile,
          postUrl: post,
        },
        readCdpUrl(),
      );
    });

  feedCommand
    .command("like")
    .alias("react")
    .description("Prepare to react to a LinkedIn post (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "-r, --reaction <reaction>",
      `Reaction type (${LINKEDIN_FEED_REACTION_TYPES.join(", ")})`,
      "like",
    )
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; reaction: string; operatorNote?: string },
      ) => {
        await runFeedLike(
          {
            profileName: options.profile,
            postUrl: post,
            reaction: options.reaction,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("comment")
    .description("Prepare to comment on a LinkedIn post (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .requiredOption("--text <text>", "Comment text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; text: string; operatorNote?: string },
      ) => {
        await runFeedComment(
          {
            profileName: options.profile,
            postUrl: post,
            text: options.text,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("repost")
    .description("Prepare to repost a LinkedIn post (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runFeedRepost(
          {
            profileName: options.profile,
            postUrl: post,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("share")
    .description(
      "Prepare to share a LinkedIn post with your own text (two-phase)",
    )
    .argument("<post>", "Post URL, URN, or activity id")
    .requiredOption("--text <text>", "Share text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; text: string; operatorNote?: string },
      ) => {
        await runFeedShare(
          {
            profileName: options.profile,
            postUrl: post,
            text: options.text,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("save")
    .description("Prepare to save a LinkedIn post for later (two-phase)")
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runFeedSave(
          {
            profileName: options.profile,
            postUrl: post,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("unsave")
    .description(
      "Prepare to remove a LinkedIn post from saved items (two-phase)",
    )
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runFeedUnsave(
          {
            profileName: options.profile,
            postUrl: post,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  feedCommand
    .command("remove-reaction")
    .description(
      "Prepare to remove your current reaction from a LinkedIn post (two-phase)",
    )
    .argument("<post>", "Post URL, URN, or activity id")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        post: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runFeedRemoveReaction(
          {
            profileName: options.profile,
            postUrl: post,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const groupsCommand = program
    .command("groups")
    .description(
      "Search, view, join, leave, and post in LinkedIn groups",
    );

  groupsCommand
    .command("search")
    .description("Search LinkedIn groups by keyword")
    .requiredOption("-q, --query <query>", "Search keywords for LinkedIn groups")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Maximum number of results", "10")
    .action(
      async (options: { profile: string; query: string; limit: string }) => {
        await runGroupsSearch(
          {
            profileName: options.profile,
            query: options.query,
            limit: parseInt(options.limit, 10) || 10,
          },
          readCdpUrl(),
        );
      },
    );

  groupsCommand
    .command("view")
    .description("View details of a LinkedIn group")
    .argument("<group>", "LinkedIn group URL or numeric group ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (group: string, options: { profile: string }) => {
        await runGroupsView(
          {
            profileName: options.profile,
            group,
          },
          readCdpUrl(),
        );
      },
    );

  groupsCommand
    .command("join")
    .description("Prepare to join a LinkedIn group (two-phase)")
    .argument("<group>", "LinkedIn group URL or numeric group ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        group: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runGroupsPrepareJoin(
          {
            profileName: options.profile,
            group,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  groupsCommand
    .command("leave")
    .description("Prepare to leave a LinkedIn group (two-phase)")
    .argument("<group>", "LinkedIn group URL or numeric group ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        group: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runGroupsPrepareLeave(
          {
            profileName: options.profile,
            group,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  groupsCommand
    .command("post")
    .description("Prepare to post in a LinkedIn group (two-phase)")
    .argument("<group>", "LinkedIn group URL or numeric group ID")
    .requiredOption("-t, --text <text>", "Post text")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        group: string,
        options: { profile: string; text: string; operatorNote?: string },
      ) => {
        await runGroupsPreparePost(
          {
            profileName: options.profile,
            group,
            text: options.text,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const eventsCommand = program
    .command("events")
    .description(
      "Search, view, and RSVP to LinkedIn events",
    );

  eventsCommand
    .command("search")
    .description("Search LinkedIn events by keyword")
    .requiredOption("-q, --query <query>", "Search keywords for LinkedIn events")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Maximum number of results", "10")
    .action(
      async (options: { profile: string; query: string; limit: string }) => {
        await runEventsSearch(
          {
            profileName: options.profile,
            query: options.query,
            limit: parseInt(options.limit, 10) || 10,
          },
          readCdpUrl(),
        );
      },
    );

  eventsCommand
    .command("view")
    .description("View details of a LinkedIn event")
    .argument("<event>", "LinkedIn event URL or numeric event ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(
      async (event: string, options: { profile: string }) => {
        await runEventsView(
          {
            profileName: options.profile,
            event,
          },
          readCdpUrl(),
        );
      },
    );

  eventsCommand
    .command("rsvp")
    .description("Prepare to RSVP attend for a LinkedIn event (two-phase)")
    .argument("<event>", "LinkedIn event URL or numeric event ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (
        event: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runEventsPrepareRsvp(
          {
            profileName: options.profile,
            event,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const postCommand = program
    .command("post")
    .description("Prepare and confirm LinkedIn post creation");

  postCommand
    .command("prepare")
    .description("Prepare a new LinkedIn post (two-phase)")
    .requiredOption("--text <text>", "Post text")
    .option(
      "-v, --visibility <visibility>",
      `Visibility (${LINKEDIN_POST_VISIBILITY_TYPES.join(", ")})`,
      "public",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        text: string;
        visibility: string;
        operatorNote?: string;
      }) => {
        await runPostPrepare(
          {
            profileName: options.profile,
            text: options.text,
            visibility: options.visibility,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  postCommand
    .command("confirm")
    .description("Confirm and publish a prepared LinkedIn post by token")
    .requiredOption("--token <token>", "Confirmation token (ct_...)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-y, --yes", "Skip interactive confirmation prompt", false)
    .action(
      async (options: { profile: string; token: string; yes: boolean }) => {
        await runConfirmAction(
          {
            profileName: options.profile,
            token: options.token,
            yes: options.yes,
          },
          readCdpUrl(),
        );
      },
    );

  const articleCommand = program
    .command("article")
    .description(
      "Prepare and confirm LinkedIn article creation and publishing",
    );

  articleCommand
    .command("prepare-create")
    .description("Prepare a new LinkedIn article draft (two-phase)")
    .requiredOption("--title <title>", "Article headline")
    .requiredOption(
      "--body <body>",
      "Plain-text article body (paragraph breaks preserved)",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        title: string;
        body: string;
        operatorNote?: string;
      }) => {
        await runArticlePrepareCreate(
          {
            profileName: options.profile,
            title: options.title,
            body: options.body,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  articleCommand
    .command("prepare-publish")
    .description(
      "Prepare to publish an existing LinkedIn article draft (two-phase)",
    )
    .requiredOption("--draft-url <url>", "LinkedIn article draft URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        draftUrl: string;
        operatorNote?: string;
      }) => {
        await runArticlePreparePublish(
          {
            profileName: options.profile,
            draftUrl: options.draftUrl,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const newsletterCommand = program
    .command("newsletter")
    .description("Manage LinkedIn newsletters");

  newsletterCommand
    .command("prepare-create")
    .description("Prepare a new LinkedIn newsletter series (two-phase)")
    .requiredOption("--title <title>", "Newsletter title")
    .requiredOption(
      "--description <description>",
      "Short newsletter description",
    )
    .requiredOption(
      "--cadence <cadence>",
      "Publishing cadence (daily, weekly, biweekly, monthly)",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        title: string;
        description: string;
        cadence: string;
        operatorNote?: string;
      }) => {
        await runNewsletterPrepareCreate(
          {
            profileName: options.profile,
            title: options.title,
            description: options.description,
            cadence: options.cadence,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  newsletterCommand
    .command("prepare-publish-issue")
    .description("Prepare a new LinkedIn newsletter issue (two-phase)")
    .requiredOption(
      "--newsletter <newsletter>",
      "Newsletter title as returned by newsletter list",
    )
    .requiredOption("--title <title>", "Issue title")
    .requiredOption(
      "--body <body>",
      "Plain-text issue body (paragraph breaks preserved)",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Optional operator note")
    .action(
      async (options: {
        profile: string;
        newsletter: string;
        title: string;
        body: string;
        operatorNote?: string;
      }) => {
        await runNewsletterPreparePublishIssue(
          {
            profileName: options.profile,
            newsletter: options.newsletter,
            title: options.title,
            body: options.body,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  newsletterCommand
    .command("list")
    .description(
      "List newsletter series available in the LinkedIn publishing editor",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runNewsletterList(
        {
          profileName: options.profile,
        },
        readCdpUrl(),
      );
    });

  const notificationsCommand = program
    .command("notifications")
    .description("Browse LinkedIn notifications");

  notificationsCommand
    .command("list")
    .description("List your LinkedIn notifications")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max notifications to return", "20")
    .action(async (options: { profile: string; limit: string }) => {
      await runNotificationsList(
        {
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit"),
        },
        readCdpUrl(),
      );
    });

  notificationsCommand
    .command("mark-read")
    .description("Mark a LinkedIn notification as read")
    .argument("<notificationId>", "Notification ID from notifications list")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (notificationId: string, options: { profile: string }) => {
      await runNotificationsMarkRead(
        { profileName: options.profile, notificationId },
        readCdpUrl(),
      );
    });

  notificationsCommand
    .command("dismiss")
    .description("Prepare to dismiss a LinkedIn notification (two-phase)")
    .argument("<notificationId>", "Notification ID from notifications list")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-o, --operator-note <note>", "Internal note for audit")
    .action(
      async (
        notificationId: string,
        options: { profile: string; operatorNote?: string },
      ) => {
        await runNotificationsDismiss(
          {
            profileName: options.profile,
            notificationId,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const notificationPreferencesCommand = notificationsCommand
    .command("preferences")
    .description("Manage LinkedIn notification preferences");

  notificationPreferencesCommand
    .command("get")
    .description("View LinkedIn notification preferences")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--preference-url <url>", "Specific preference page URL")
    .action(async (options: { profile: string; preferenceUrl?: string }) => {
      await runNotificationsPreferencesGet(
        {
          profileName: options.profile,
          ...(options.preferenceUrl
            ? { preferenceUrl: options.preferenceUrl }
            : {}),
        },
        readCdpUrl(),
      );
    });

  notificationPreferencesCommand
    .command("prepare-update")
    .description("Prepare a notification preference update (two-phase)")
    .requiredOption(
      "--preference-url <url>",
      "Preference page URL from preferences get",
    )
    .requiredOption("--enabled <enabled>", "Enable or disable (true/false)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--channel <channel>",
      "Channel: in_app, push, or email (required for subcategories)",
    )
    .option("-o, --operator-note <note>", "Internal note for audit")
    .action(
      async (options: {
        profile: string;
        preferenceUrl: string;
        enabled: string;
        channel?: string;
        operatorNote?: string;
      }) => {
        const enabled = options.enabled === "true";
        await runNotificationsPreferencesPrepareUpdate(
          {
            profileName: options.profile,
            preferenceUrl: options.preferenceUrl,
            enabled,
            ...(options.channel ? { channel: options.channel } : {}),
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const jobsCommand = program
    .command("jobs")
    .description("Search and view LinkedIn job postings");

  jobsCommand
    .command("search")
    .description("Search for LinkedIn jobs")
    .argument("<query>", "Search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--location <location>", "Location filter")
    .option("-l, --limit <limit>", "Max results", "10")
    .action(
      async (
        query: string,
        options: { profile: string; location?: string; limit: string },
      ) => {
        await runJobsSearch(
          {
            profileName: options.profile,
            query,
            ...(options.location ? { location: options.location } : {}),
            limit: coercePositiveInt(options.limit, "limit"),
          },
          readCdpUrl(),
        );
      },
    );

  jobsCommand
    .command("view")
    .description("View details for a LinkedIn job posting")
    .argument("<jobId>", "LinkedIn job ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (jobId: string, options: { profile: string }) => {
      await runJobsView(
        {
          profileName: options.profile,
          jobId,
        },
        readCdpUrl(),
      );
    });

  jobsCommand
    .command("save")
    .description("Prepare to save a LinkedIn job for later (two-phase)")
    .argument("<jobId>", "LinkedIn job ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        jobId: string,
        options: { operatorNote?: string; profile: string },
      ) => {
        await runJobsSave(
          {
            profileName: options.profile,
            jobId,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  jobsCommand
    .command("unsave")
    .description("Prepare to unsave a LinkedIn job (two-phase)")
    .argument("<jobId>", "LinkedIn job ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        jobId: string,
        options: { operatorNote?: string; profile: string },
      ) => {
        await runJobsUnsave(
          {
            profileName: options.profile,
            jobId,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const jobsAlertsCommand = jobsCommand
    .command("alerts")
    .description("List and prepare LinkedIn job alert changes");

  jobsAlertsCommand
    .command("list")
    .description("List your LinkedIn job alerts")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-l, --limit <limit>", "Max alerts to return", "20")
    .action(async (options: { profile: string; limit: string }) => {
      await runJobAlertsList(
        {
          profileName: options.profile,
          limit: coercePositiveInt(options.limit, "limit"),
        },
        readCdpUrl(),
      );
    });

  jobsAlertsCommand
    .command("create")
    .description("Prepare to create a LinkedIn job alert (two-phase)")
    .argument("<query>", "Search keywords")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--location <location>", "Location filter")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        query: string,
        options: {
          location?: string;
          operatorNote?: string;
          profile: string;
        },
      ) => {
        await runJobAlertsCreate(
          {
            profileName: options.profile,
            query,
            ...(options.location ? { location: options.location } : {}),
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  jobsAlertsCommand
    .command("remove")
    .description("Prepare to remove a LinkedIn job alert (two-phase)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--alert-id <alertId>", "Alert id returned by jobs alerts list")
    .option(
      "--search-url <searchUrl>",
      "LinkedIn jobs search URL for the alert",
    )
    .option(
      "--query <query>",
      "Alert query if no alert id or search URL is available",
    )
    .option("--location <location>", "Alert location filter")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (options: {
        alertId?: string;
        location?: string;
        operatorNote?: string;
        profile: string;
        query?: string;
        searchUrl?: string;
      }) => {
        await runJobAlertsRemove(
          {
            profileName: options.profile,
            ...(options.alertId ? { alertId: options.alertId } : {}),
            ...(options.searchUrl ? { searchUrl: options.searchUrl } : {}),
            ...(options.query ? { query: options.query } : {}),
            ...(options.location ? { location: options.location } : {}),
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  jobsCommand
    .command("easy-apply")
    .description("Prepare a LinkedIn Easy Apply submission (two-phase)")
    .argument("<jobId>", "LinkedIn job ID")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--phone <phoneNumber>", "Phone number to use in the application")
    .option("--email <email>", "Email address to use in the application")
    .option("--city <city>", "City field value for the application")
    .option("--resume <resumePath>", "Resume file to upload")
    .option("--cover-letter <coverLetter>", "Cover letter text")
    .option(
      "--answers-file <path>",
      "JSON object file with extra Easy Apply answers",
    )
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        jobId: string,
        options: {
          answersFile?: string;
          city?: string;
          coverLetter?: string;
          email?: string;
          operatorNote?: string;
          phone?: string;
          profile: string;
          resume?: string;
        },
      ) => {
        await runJobsEasyApplyPrepare(
          {
            profileName: options.profile,
            jobId,
            ...(options.phone ? { phone: options.phone } : {}),
            ...(options.email ? { email: options.email } : {}),
            ...(options.city ? { city: options.city } : {}),
            ...(options.resume ? { resume: options.resume } : {}),
            ...(options.coverLetter
              ? { coverLetter: options.coverLetter }
              : {}),
            ...(options.answersFile
              ? { answersFile: options.answersFile }
              : {}),
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const profileCommand = program
    .command("profile")
    .description("View LinkedIn profiles");

  profileCommand
    .command("view")
    .description("View a LinkedIn profile")
    .argument(
      "[target]",
      "Vanity name, profile URL, or 'me' for own profile",
      "me",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runProfileView(
        {
          profileName: options.profile,
          target,
        },
        readCdpUrl(),
      );
    });

  const companyCommand = program
    .command("company")
    .description("View LinkedIn company pages and prepare follow changes");

  companyCommand
    .command("view")
    .description("View a LinkedIn company page")
    .argument("<target>", "Company slug, /company/ path, or company URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (target: string, options: { profile: string }) => {
      await runCompanyPageView(
        {
          profileName: options.profile,
          target,
        },
        readCdpUrl(),
      );
    });

  companyCommand
    .command("follow")
    .description("Prepare to follow a LinkedIn company page (two-phase)")
    .argument("<target>", "Company slug, /company/ path, or company URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        target: string,
        options: { operatorNote?: string; profile: string },
      ) => {
        await runCompanyPrepareFollow(
          {
            profileName: options.profile,
            targetCompany: target,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  companyCommand
    .command("unfollow")
    .description("Prepare to unfollow a LinkedIn company page (two-phase)")
    .argument("<target>", "Company slug, /company/ path, or company URL")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        target: string,
        options: { operatorNote?: string; profile: string },
      ) => {
        await runCompanyPrepareUnfollow(
          {
            profileName: options.profile,
            targetCompany: target,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  profileCommand
    .command("editable")
    .description(
      "Inspect the logged-in member's editable LinkedIn profile surface",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .action(async (options: { profile: string }) => {
      await runProfileViewEditable(
        {
          profileName: options.profile,
        },
        readCdpUrl(),
      );
    });

  profileCommand
    .command("update-settings")
    .description(
      "Prepare to update LinkedIn profile-level settings (two-phase)",
    )
    .requiredOption(
      "--industry <industry>",
      'Primary professional category / industry (e.g. "Software Development")',
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (options: {
        industry: string;
        operatorNote?: string;
        profile: string;
      }) => {
        await runProfilePrepareUpdateSettings(
          {
            profileName: options.profile,
            industry: options.industry,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  profileCommand
    .command("update-public-profile")
    .description(
      "Prepare to update the LinkedIn custom public profile URL (two-phase)",
    )
    .argument(
      "<vanityName>",
      'Custom public profile vanity name (e.g. "avery-cole") or linkedin.com/in/ URL. Must be 3\u2013100 chars, letters/digits/hyphens only.',
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--operator-note <note>",
      "Optional note attached to the prepared action",
    )
    .action(
      async (
        vanityName: string,
        options: { operatorNote?: string; profile: string },
      ) => {
        await runProfilePrepareUpdatePublicProfile(
          {
            profileName: options.profile,
            vanityName,
            ...(options.operatorNote
              ? { operatorNote: options.operatorNote }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  profileCommand
    .command("apply-spec")
    .description(
      "Apply a JSON profile seed spec with paced LinkedIn profile edits",
    )
    .requiredOption("--spec <path>", "Path to a JSON profile seed spec")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--replace",
      "Remove unmatched supported section items for sections included in the spec",
      false,
    )
    .option(
      "--allow-partial",
      "Continue when the spec includes unsupported fields such as skills",
      false,
    )
    .option(
      "--delay-ms <ms>",
      "Base delay between confirmed profile edits",
      "3500",
    )
    .option("-y, --yes", "Skip the interactive confirmation prompt", false)
    .option("--output <path>", "Write the final JSON report to a file")
    .addHelpText(
      "after",
      [
        "",
        "Notes:",
        "  - uses the existing two-phase profile edit actions under the hood and confirms them one by one",
        "  - paces edits with a randomized delay so large profile updates do not fire back-to-back",
        "  - unsupported fields currently include skills (#228)",
        '  - run "linkedin profile editable" first if you want to inspect the current section structure',
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        spec: string;
        replace: boolean;
        allowPartial: boolean;
        delayMs: string;
        yes: boolean;
        output?: string;
      }) => {
        await runProfileApplySpec(
          {
            profileName: options.profile,
            specPath: options.spec,
            replace: options.replace,
            allowPartial: options.allowPartial,
            delayMs: coerceNonNegativeInt(options.delayMs, "delay-ms"),
            yes: options.yes,
            ...(options.output ? { outputPath: options.output } : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const assetsCommand = program
    .command("assets")
    .description("Generate LinkedIn-ready AI image assets");

  assetsCommand
    .command("generate-profile-images")
    .description(
      "Generate a profile photo, banner, and post images from a persona spec",
    )
    .requiredOption("--spec <path>", "Path to a JSON persona/profile seed spec")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("--post-count <count>", "Number of post images to generate", "6")
    .option("--model <model>", "OpenAI image model override")
    .option(
      "--upload-profile-media",
      "Upload the generated photo and banner through the existing LinkedIn profile flow",
      false,
    )
    .option(
      "--upload-delay-ms <ms>",
      "Base delay between the photo and banner upload when --upload-profile-media is enabled",
      "4500",
    )
    .option("--output <path>", "Write the final JSON report to a file")
    .addHelpText(
      "after",
      [
        "",
        "Notes:",
        "  - requires OPENAI_API_KEY in the environment",
        "  - generated assets are stored in the run artifacts directory under linkedin-ai-assets/",
        "  - --upload-profile-media reuses the existing profile photo/banner upload actions and paces the two uploads",
        "  - the issue-210 persona spec is a good default source for the test account",
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        spec: string;
        postCount: string;
        model?: string;
        uploadProfileMedia: boolean;
        uploadDelayMs: string;
        output?: string;
      }) => {
        await runAssetsGenerateProfileImages(
          {
            profileName: options.profile,
            specPath: options.spec,
            postImageCount: coercePositiveInt(options.postCount, "post-count"),
            uploadProfileMedia: options.uploadProfileMedia,
            uploadDelayMs: coerceNonNegativeInt(
              options.uploadDelayMs,
              "upload-delay-ms",
            ),
            ...(options.model ? { model: options.model } : {}),
            ...(options.output ? { outputPath: options.output } : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const seedCommand = program
    .command("seed")
    .description(
      "Run reusable LinkedIn profile and activity seeding workflows",
    );

  seedCommand
    .command("activity")
    .description(
      "Apply a paced activity seed spec for connections, posts, engagement, jobs, messaging, and notifications",
    )
    .requiredOption("--spec <path>", "Path to a JSON activity seed spec")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--delay-ms <ms>",
      "Base delay between confirmed write actions",
      "4500",
    )
    .option("-y, --yes", "Skip the interactive confirmation prompt", false)
    .option("--output <path>", "Write the final JSON report to a file")
    .addHelpText(
      "after",
      [
        "",
        "Notes:",
        "  - this command batches real LinkedIn actions, so it stays CLI-only and asks for confirmation unless you pass --yes",
        "  - start `linkedin keepalive start` first for longer seeding sessions",
        "  - posts default to `connections` visibility when the spec omits visibility",
        "  - generated-image posts can reuse the issue-211 image manifest via assets.generatedImageManifestPath",
        "  - verification re-reads connections, feed, and inbox state at the end of the run",
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        spec: string;
        delayMs: string;
        yes: boolean;
        output?: string;
      }) => {
        await runSeedActivity(
          {
            profileName: options.profile,
            specPath: options.spec,
            delayMs: coerceNonNegativeInt(options.delayMs, "delay-ms"),
            yes: options.yes,
            ...(options.output ? { outputPath: options.output } : {}),
          },
          readCdpUrl(),
        );
      },
    );

  const auditCommand = program
    .command("audit")
    .description("Run read-only LinkedIn audits and diagnostics");

  auditCommand
    .command("selectors")
    .description(
      "Audit selector groups across key LinkedIn pages and capture failure artifacts",
    )
    .option("-p, --profile <profile>", "Profile name", "default")
    .option(
      "--json",
      "Print the full JSON report (recommended for automation)",
      false,
    )
    .option(
      "--verbose",
      "Show selector-by-selector details in human-readable output",
      false,
    )
    .option(
      "--no-progress",
      "Hide per-page progress updates in human-readable output",
    )
    .addHelpText(
      "after",
      [
        "",
        "Interactive terminals default to a human-readable summary with per-page progress.",
        "Use --json for automation, piping, or other agent workflows.",
        SELECTOR_AUDIT_DOC_REFERENCE,
      ].join("\n"),
    )
    .action(
      async (options: {
        profile: string;
        json: boolean;
        progress: boolean;
        verbose: boolean;
      }) => {
        await runSelectorAudit(
          {
            profileName: options.profile,
            json: options.json,
            progress: options.progress,
            verbose: options.verbose,
          },
          readCdpUrl(),
        );
      },
    );

  auditCommand
    .command("draft-quality")
    .description(
      "Evaluate draft replies against case-specific quality expectations",
    )
    .requiredOption(
      "--dataset <path>",
      "Path to the draft-quality dataset JSON file (cases + expectations)",
    )
    .option(
      "--candidates <path>",
      "Optional JSON file with candidate drafts keyed by case_id/draft_id",
    )
    .option(
      "--json",
      "Print the full JSON report (recommended for automation)",
      false,
    )
    .option(
      "--verbose",
      "Show per-draft metric details in human-readable output",
      false,
    )
    .option(
      "--no-progress",
      "Hide per-case progress updates in human-readable output",
    )
    .option("--output <path>", "Write the JSON report to a file")
    .addHelpText(
      "after",
      [
        "",
        "The dataset can embed candidate_drafts/candidateDrafts or you can provide --candidates.",
        "Interactive terminals default to a human-readable summary with per-case progress.",
        "Use --json for automation and --output to persist the JSON report.",
        "",
        "Examples:",
        "  linkedin audit draft-quality --dataset dataset.json",
        "  linkedin audit draft-quality --dataset dataset.json --candidates candidates.json --verbose",
        "  linkedin audit draft-quality --dataset dataset.json --json --output reports/draft-quality.json",
      ].join("\n"),
    )
    .action(
      async (options: {
        dataset: string;
        candidates?: string;
        json: boolean;
        progress: boolean;
        verbose: boolean;
        output?: string;
      }) => {
        await runDraftQualityAudit({
          datasetPath: options.dataset,
          json: options.json,
          progress: options.progress,
          verbose: options.verbose,
          ...(options.candidates ? { candidatesPath: options.candidates } : {}),
          ...(options.output ? { outputPath: options.output } : {}),
        });
      },
    );

  const actionsCommand = program
    .command("actions")
    .description("Manage prepared actions");

  actionsCommand
    .command("confirm")
    .description("Confirm and execute a prepared action by confirmation token")
    .requiredOption("--token <token>", "Confirmation token (ct_...)")
    .option("-p, --profile <profile>", "Profile name", "default")
    .option("-y, --yes", "Skip interactive confirmation prompt", false)
    .action(
      async (options: { profile: string; token: string; yes: boolean }) => {
        await runConfirmAction(
          {
            profileName: options.profile,
            token: options.token,
            yes: options.yes,
          },
          readCdpUrl(),
        );
      },
    );

  actionsCommand
    .command("list")
    .description("List prepared actions")
    .option(
      "--status <status>",
      `Filter by effective status: ${PREPARED_ACTION_EFFECTIVE_STATUSES.join(", ")}`,
    )
    .option("-l, --limit <limit>", "Max actions to show", "20")
    .action(
      async (options: { status?: string; limit: string }) => {
        await runActionsList(
          {
            limit: coercePositiveInt(options.limit, "limit"),
            ...(options.status
              ? { status: coerceActionStatus(options.status) }
              : {}),
          },
          readCdpUrl(),
        );
      },
    );

  actionsCommand
    .command("show")
    .description("Show details of a prepared action")
    .requiredOption("--id <id>", "Prepared action ID (pa_...)")
    .action(
      async (options: { id: string }) => {
        await runActionsShow(
          {
            id: options.id,
          },
          readCdpUrl(),
        );
      },
    );

  program
    .command("health")
    .description("Check browser and LinkedIn session health")
    .option("-p, --profile <profile>", "Profile name", "default")
    .addHelpText(
      "after",
      [
        "",
        "Diagnostics:",
        "  - output includes session.evasion with the resolved anti-bot profile and diagnostics status",
        `  - ${LINKEDIN_BUDDY_EVASION_LEVEL_ENV}=minimal|moderate|paranoid selects the default anti-bot profile`,
        `  - ${LINKEDIN_BUDDY_EVASION_DIAGNOSTICS_ENV}=true records debug evasion events in the run log`,
      ].join("\n"),
    )
    .action(async (options: { profile: string }) => {
      const runtime = createRuntime(readCdpUrl());
      try {
        runtime.logger.log("info", "cli.health.start", {
          profileName: options.profile,
        });
        const health = await runtime.healthCheck({
          profileName: options.profile,
        });
        runtime.logger.log("info", "cli.health.done", {
          profileName: options.profile,
          browser_healthy: health.browser.healthy,
          authenticated: health.session.authenticated,
          evasion_level: health.session.evasion.level,
          evasion_diagnostics_enabled:
            health.session.evasion.diagnosticsEnabled,
        });
        printJson({
          run_id: runtime.runId,
          profile_name: options.profile,
          ...health,
        });
        if (!health.browser.healthy || !health.session.authenticated) {
          process.exitCode = 1;
        }
      } finally {
        runtime.close();
      }
    });

  return program;
}

/** Runs the `linkedin` CLI with the provided argument vector. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  const originalArgv = process.argv;
  process.argv = argv;

  const program = createCliProgram();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    await maybeEmitCliFeedbackHint(error);
    throw error;
  } finally {
    activeCliInvocation = undefined;
    cliEvasionEnabled = true;
    cliEvasionLevel = undefined;
    cliSelectorLocale = undefined;
    process.argv = originalArgv;
  }
}

export function isDirectExecution(
  moduleUrl: string,
  entrypoint: string | undefined = process.argv[1],
): boolean {
  if (!entrypoint) {
    return false;
  }

  return (
    resolveCliEntrypointPath(entrypoint) ===
    resolveCliEntrypointPath(fileURLToPath(moduleUrl))
  );
}

function resolveCliEntrypointPath(entrypoint: string): string {
  const resolvedEntrypoint = path.resolve(entrypoint);

  try {
    return realpathSync(resolvedEntrypoint);
  } catch {
    return resolvedEntrypoint;
  }
}

if (isDirectExecution(import.meta.url)) {
  runCli().catch((error: unknown) => {
    const payload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);
    console.error(JSON.stringify(payload, null, 2));
    process.exit(process.exitCode ?? 1);
  });
}

function coerceWriteValidationDesignation(
  value: string,
): "primary" | "secondary" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "primary" || normalized === "secondary") {
    return normalized;
  }

  throw new LinkedInBuddyError(
    "ACTION_PRECONDITION_FAILED",
    'designation must be either "primary" or "secondary".',
  );
}

function buildWriteValidationAccountTargets(input: {
  followupProfile: string | undefined;
  inviteNote: string | undefined;
  inviteProfile: string | undefined;
  messageParticipantPattern: string | undefined;
  messageThread: string | undefined;
  postVisibility: string | undefined;
  reaction: string | undefined;
  reactionPost: string | undefined;
}): WriteValidationAccountTargets {
  const targets: WriteValidationAccountTargets = {};
  const messageParticipantPattern = input.messageParticipantPattern?.trim();
  const inviteNote = input.inviteNote?.trim();

  if (input.messageThread) {
    targets.send_message = {
      thread: input.messageThread,
      ...(messageParticipantPattern
        ? { participantPattern: messageParticipantPattern }
        : {}),
    };
  }

  if (input.inviteProfile) {
    targets["connections.send_invitation"] = {
      targetProfile: input.inviteProfile,
      ...(inviteNote ? { note: inviteNote } : {}),
    };
  }

  if (input.followupProfile) {
    targets["network.followup_after_accept"] = {
      profileUrlKey: input.followupProfile,
    };
  }

  if (input.reactionPost) {
    targets["feed.like_post"] = {
      postUrl: input.reactionPost,
      ...(input.reaction
        ? { reaction: normalizeLinkedInFeedReaction(input.reaction) }
        : {}),
    };
  }

  if (input.postVisibility) {
    targets["post.create"] = {
      visibility: normalizeLinkedInPostVisibility(
        input.postVisibility,
        "connections",
      ),
    };
  }

  return targets;
}

function resolveLiveWriteValidationAccountId(input: {
  account?: string | undefined;
  readOnly: boolean;
  session: string;
}): string {
  if (input.readOnly) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      'Choose either "--read-only" or "--write-validation", not both.',
    );
  }

  if (!input.account) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      'Write validation requires "--account <id>".',
    );
  }

  if (input.session !== "default") {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      'Write validation resolves stored sessions through the account registry. Remove "--session" and rerun.',
    );
  }

  return input.account;
}

function formatWriteValidationPrompt(
  preview: WriteValidationActionPreview,
  actionIndex: number,
): string[] {
  return [
    `Action ${actionIndex}/${TOTAL_WRITE_VALIDATION_ACTIONS}: ${preview.action_type}`,
    `Summary: ${preview.summary}`,
    `Risk: ${preview.risk_class}`,
    `Target: ${JSON.stringify(preview.target)}`,
    `Payload: ${JSON.stringify(preview.outbound)}`,
    `Expected: ${preview.expected_outcome}`,
  ];
}

function createWriteValidationPrompter(
  output: typeof stdout | typeof process.stderr,
): (preview: WriteValidationActionPreview) => Promise<boolean> {
  let nextActionIndex = 1;
  let firstPrompt = true;

  return async (preview) => {
    if (!firstPrompt) {
      output.write("\n");
    }
    firstPrompt = false;

    for (const line of formatWriteValidationPrompt(preview, nextActionIndex)) {
      output.write(`${line}\n`);
    }
    nextActionIndex += 1;

    return promptYesNo("Execute this action?", output);
  };
}

function emitWriteValidationResult(
  report: WriteValidationReport,
  outputMode: WriteValidationOutputMode,
): void {
  if (outputMode === "json") {
    printJson(report);
  } else {
    const redactedReport = redactStructuredValue(
      report,
      cliPrivacyConfig,
      "cli",
    ) as WriteValidationReport;
    console.log(
      formatWriteValidationReport(redactedReport, {
        color: shouldUseAnsiColor(stdout),
      }),
    );
  }

  if (report.outcome !== "pass") {
    process.exitCode = LIVE_VALIDATION_FAIL_EXIT_CODE;
  }
}

function emitWriteValidationFailure(
  error: unknown,
  outputMode: WriteValidationOutputMode,
): void {
  process.exitCode = LIVE_VALIDATION_ERROR_EXIT_CODE;

  if (outputMode === "json") {
    throw error;
  }

  const errorPayload = toLinkedInBuddyErrorPayload(error, cliPrivacyConfig);
  process.stderr.write(
    `${formatWriteValidationError(errorPayload, {
      color: shouldUseAnsiColor(process.stderr),
      helpCommand: LIVE_VALIDATION_HELP_COMMAND,
    })}\n`,
  );
}

function assertWriteValidationExecutionPreconditions(
  input: { yes: boolean },
  cdpUrl?: string,
): void {
  assertNoExternalSessionOverrideForStoredSession(cdpUrl);
  assertInteractiveTerminal("run write validation");

  if (input.yes) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      'Write validation requires typing "yes" for every action. Remove "--yes" and rerun.',
    );
  }
}

async function runLiveWriteValidation(
  input: {
    accountId?: string | undefined;
    cooldownSeconds: number;
    json: boolean;
    progress: boolean;
    readOnly: boolean;
    session: string;
    timeoutSeconds: number;
    yes: boolean;
  },
  cdpUrl?: string,
): Promise<void> {
  const outputMode = resolveWriteValidationOutputMode(
    { json: input.json },
    Boolean(stdout.isTTY),
  );
  const promptOutput = outputMode === "json" ? process.stderr : stdout;
  const progressEnabled =
    outputMode === "human" && input.progress && Boolean(process.stderr.isTTY);
  const progressReporter = new WriteValidationProgressReporter({
    enabled: progressEnabled,
  });

  try {
    const accountId = resolveLiveWriteValidationAccountId({
      account: input.accountId,
      readOnly: input.readOnly,
      session: input.session,
    });

    assertWriteValidationExecutionPreconditions(input, cdpUrl);

    writeCliWarning(`${WRITE_VALIDATION_WARNING}.`);
    writeCliNotice(
      `Running write validation against account "${accountId}". See ${WRITE_VALIDATION_DOC_PATH} for account setup and approved targets.`,
    );
    writeCliNotice(
      "Preparing the stored session, validating approved targets, and opening the interactive harness.",
    );

    const report = await runLinkedInWriteValidation({
      accountId: coerceProfileName(accountId, "account"),
      cooldownMs: input.cooldownSeconds * 1_000,
      interactive: Boolean(stdin.isTTY && stdout.isTTY),
      ...(progressEnabled
        ? {
            onLog: (entry) => {
              progressReporter.handleLog(entry);
            },
          }
        : {}),
      onBeforeAction: createWriteValidationPrompter(promptOutput),
      timeoutMs: input.timeoutSeconds * 1_000,
    });

    emitWriteValidationResult(report, outputMode);
  } catch (error) {
    emitWriteValidationFailure(error, outputMode);
  }
}

async function runAccountsAdd(input: {
  accountId: string;
  designation: string;
  followupProfile: string | undefined;
  force: boolean;
  inviteNote: string | undefined;
  inviteProfile: string | undefined;
  label: string | undefined;
  messageParticipantPattern: string | undefined;
  messageThread: string | undefined;
  postVisibility: string | undefined;
  profileName: string | undefined;
  reaction: string | undefined;
  reactionPost: string | undefined;
  sessionName: string | undefined;
}): Promise<void> {
  const accountId = coerceProfileName(input.accountId, "account");
  const registry = await upsertWriteValidationAccount({
    accountId,
    designation: coerceWriteValidationDesignation(input.designation),
    ...(input.label ? { label: input.label.trim() } : {}),
    overwrite: input.force,
    ...(input.profileName
      ? { profileName: coerceProfileName(input.profileName, "profile") }
      : {}),
    ...(input.sessionName
      ? { sessionName: coerceProfileName(input.sessionName, "session") }
      : {}),
    targets: buildWriteValidationAccountTargets({
      followupProfile: input.followupProfile,
      inviteNote: input.inviteNote,
      inviteProfile: input.inviteProfile,
      messageParticipantPattern: input.messageParticipantPattern,
      messageThread: input.messageThread,
      postVisibility: input.postVisibility,
      reaction: input.reaction,
      reactionPost: input.reactionPost,
    }),
  });

  printJson({
    account: registry.accounts[accountId],
    config_path: registry.configPath,
    saved: true,
  });
}
