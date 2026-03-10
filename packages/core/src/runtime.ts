import { ArtifactHelpers } from "./artifacts.js";
import { ActivityPollerService } from "./activityPoller.js";
import { ActivityWatchesService } from "./activityWatches.js";
import {
  ensureConfigPaths,
  getLinkedInSelectorLocaleConfigWarning,
  resolveConfigPaths,
  resolveConfirmFailureArtifactConfig,
  resolveLinkedInSelectorLocaleConfigResolution,
  resolveActivityWebhookConfig,
  resolveEvasionConfig,
  type ActivityWebhookConfig,
  type ConfigPaths,
  type ConfirmFailureArtifactConfig,
  type EvasionConfig
} from "./config.js";
import { AssistantDatabase } from "./db/database.js";
import { LinkedInAuthService } from "./auth/session.js";
import {
  createConnectionActionExecutors,
  LinkedInConnectionsService,
  type LinkedInConnectionsRuntime
} from "./linkedinConnections.js";
import {
  createMemberActionExecutors,
  LinkedInMembersService,
  type LinkedInMembersRuntime
} from "./linkedinMembers.js";
import {
  createFollowupActionExecutors,
  LinkedInFollowupsService,
  type LinkedInFollowupsRuntime
} from "./linkedinFollowups.js";
import {
  createFeedActionExecutors,
  LinkedInFeedService,
  type LinkedInFeedRuntime
} from "./linkedinFeed.js";
import {
  createLinkedInActionExecutors,
  LinkedInInboxService,
  type LinkedInMessagingRuntime
} from "./linkedinInbox.js";
import {
  createProfileActionExecutors,
  LinkedInProfileService,
  type LinkedInProfileRuntime
} from "./linkedinProfile.js";
import { LinkedInImageAssetsService } from "./linkedinImageAssets.js";
import {
  LinkedInJobsService,
  type LinkedInJobsRuntime
} from "./linkedinJobs.js";
import {
  createNotificationActionExecutors,
  LinkedInNotificationsService,
  type LinkedInNotificationsRuntime
} from "./linkedinNotifications.js";
import {
  LinkedInSearchService,
  type LinkedInSearchRuntime
} from "./linkedinSearch.js";
import {
  createPrivacySettingActionExecutors,
  LinkedInPrivacySettingsService,
  type LinkedInPrivacySettingsRuntime
} from "./linkedinPrivacySettings.js";
import {
  LinkedInPostsService,
  createPostActionExecutors,
  resolveLinkedInPostSafetyLintConfig,
  type LinkedInPostSafetyLintConfig,
  type LinkedInPostsRuntime
} from "./linkedinPosts.js";
import { JsonEventLogger } from "./logging.js";
import { ProfileManager } from "./profileManager.js";
import { RateLimiter } from "./rateLimiter.js";
import { createRunId } from "./run.js";
import { checkFullHealth, type FullHealthStatus } from "./healthCheck.js";
import {
  TwoPhaseCommitService,
  TestEchoActionExecutor,
  TEST_ECHO_ACTION_TYPE,
  createDefaultTestAutoConfirmConfig,
  type TestAutoConfirmConfig
} from "./twoPhaseCommit.js";
import { resolvePrivacyConfig, type PrivacyConfig } from "./privacy.js";
import { LinkedInSelectorAuditService } from "./selectorAudit.js";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";
import type { EvasionLevel } from "./evasion.js";

function summarizeSelectorLocaleInput(
  normalizedInput: string | undefined,
  inputLength: number | undefined
): Record<string, string | number> {
  if (typeof normalizedInput !== "string") {
    return {};
  }

  return {
    normalized_selector_locale: normalizedInput,
    ...(typeof inputLength === "number"
      ? { requested_selector_locale_length: inputLength }
      : {})
  };
}

/**
 * Options for constructing a fully wired LinkedIn Assistant runtime.
 *
 * @example
 * ```ts
 * const options: CreateCoreRuntimeOptions = {
 *   evasionLevel: "moderate",
 *   evasionDiagnostics: true
 * };
 * ```
 */
export interface CreateCoreRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
  runId?: string;
  cdpUrl?: string | undefined;
  privacy?: Partial<PrivacyConfig>;
  /** Enables verbose anti-bot evasion diagnostics in run logs. */
  evasionDiagnostics?: boolean;
  /** Overrides the default anti-bot evasion level for this runtime. */
  evasionLevel?: string | EvasionLevel;
  selectorLocale?: string | LinkedInSelectorLocale;
}

/**
 * Fully wired service graph used by the CLI, MCP server, and real-session E2E
 * suites. `close()` is safe to call repeatedly.
 *
 * @example
 * ```ts
 * const runtime = createCoreRuntime();
 * console.log(runtime.evasion.level);
 * runtime.close();
 * ```
 */
export interface CoreRuntime {
  paths: ConfigPaths;
  runId: string;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  /** Resolved anti-bot evasion snapshot shared across status and health checks. */
  evasion: EvasionConfig;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  privacy: PrivacyConfig;
  postSafetyLint: LinkedInPostSafetyLintConfig;
  activityConfig: ActivityWebhookConfig;
  db: AssistantDatabase;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  twoPhaseCommit: TwoPhaseCommitService<LinkedInMessagingRuntime>;
  rateLimiter: RateLimiter;
  profileManager: ProfileManager;
  auth: LinkedInAuthService;
  profile: LinkedInProfileService;
  imageAssets: LinkedInImageAssetsService;
  search: LinkedInSearchService;
  jobs: LinkedInJobsService;
  notifications: LinkedInNotificationsService;
  connections: LinkedInConnectionsService;
  members: LinkedInMembersService;
  privacySettings: LinkedInPrivacySettingsService;
  followups: LinkedInFollowupsService;
  feed: LinkedInFeedService;
  posts: LinkedInPostsService;
  inbox: LinkedInInboxService;
  activityWatches: ActivityWatchesService;
  activityPoller: ActivityPollerService;
  selectorAudit: LinkedInSelectorAuditService;
  testAutoConfirm: TestAutoConfirmConfig;
  healthCheck: (options?: { profileName?: string }) => Promise<FullHealthStatus>;
  close: () => void;
}

/**
 * Creates the fully wired LinkedIn Assistant runtime and all supporting
 * services for one execution context.
 *
 * @example
 * ```ts
 * const runtime = createCoreRuntime({
 *   evasionLevel: "paranoid",
 *   evasionDiagnostics: true
 * });
 *
 * console.log(runtime.evasion.summary);
 * runtime.close();
 * ```
 */
export function createCoreRuntime(
  options: CreateCoreRuntimeOptions = {}
): CoreRuntime {
  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);
  const privacy = resolvePrivacyConfig(options.privacy);
  const postSafetyLint = resolveLinkedInPostSafetyLintConfig(paths.baseDir);
  const activityConfig = resolveActivityWebhookConfig();
  const evasion = resolveEvasionConfig({
    ...(typeof options.evasionDiagnostics === "boolean"
      ? { diagnosticsEnabled: options.evasionDiagnostics }
      : {}),
    ...(typeof options.evasionLevel === "string"
      ? { level: options.evasionLevel }
      : {})
  });
  const selectorLocaleResolution = resolveLinkedInSelectorLocaleConfigResolution(
    options.selectorLocale
  );
  const selectorLocale = selectorLocaleResolution.locale;

  const db = new AssistantDatabase(options.dbPath ?? paths.dbPath);
  const runId = options.runId ?? createRunId();
  const logger = new JsonEventLogger(paths, runId, db, privacy);
  const artifacts = new ArtifactHelpers(paths, runId, db, privacy);
  const confirmFailureArtifacts = resolveConfirmFailureArtifactConfig();
  const profileManager = new ProfileManager(paths);
  let closed = false;
  let runtime: CoreRuntime;

  if (
    selectorLocaleResolution.fallbackUsed &&
    selectorLocale === DEFAULT_LINKEDIN_SELECTOR_LOCALE &&
    selectorLocaleResolution.source !== "default"
  ) {
    const selectorLocaleWarning = getLinkedInSelectorLocaleConfigWarning(
      selectorLocaleResolution,
      "runtime"
    );

    logger.log("warn", "runtime.selector_locale.fallback_to_english", {
      selector_locale_source: selectorLocaleResolution.source,
      resolved_selector_locale: selectorLocale,
      reason: selectorLocaleResolution.fallbackReason,
      ...(selectorLocaleWarning
        ? {
            message: selectorLocaleWarning.message,
            action_taken: selectorLocaleWarning.actionTaken,
            guidance: selectorLocaleWarning.guidance,
            supported_selector_locales: selectorLocaleWarning.supportedLocales
          }
        : {}),
      ...summarizeSelectorLocaleInput(
        selectorLocaleResolution.normalizedInput,
        selectorLocaleResolution.inputLength
      )
    });
  }

  const testAutoConfirm = createDefaultTestAutoConfirmConfig();
  const linkedInExecutors = createLinkedInActionExecutors();
  const profileExecutors = createProfileActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const connectionExecutors = createConnectionActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const memberExecutors = createMemberActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const feedExecutors = createFeedActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const followupExecutors = createFollowupActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const postExecutors = createPostActionExecutors() as unknown as Record<
    string,
    import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
  >;
  const notificationExecutors =
    createNotificationActionExecutors() as unknown as Record<
      string,
      import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
    >;
  const privacySettingExecutors =
    createPrivacySettingActionExecutors() as unknown as Record<
      string,
      import("./twoPhaseCommit.js").ActionExecutor<LinkedInMessagingRuntime>
    >;
  const testEchoExecutor = new TestEchoActionExecutor<LinkedInMessagingRuntime>();
  const twoPhaseCommit = new TwoPhaseCommitService<LinkedInMessagingRuntime>(db, {
    privacy,
    executors: {
      ...linkedInExecutors,
      ...profileExecutors,
      ...connectionExecutors,
      ...memberExecutors,
      ...followupExecutors,
      ...feedExecutors,
      ...postExecutors,
      ...notificationExecutors,
      ...privacySettingExecutors,
      [TEST_ECHO_ACTION_TYPE]: testEchoExecutor
    },
    getRuntime: () => runtime
  });

  runtime = {
    paths,
    runId,
    cdpUrl: options.cdpUrl,
    selectorLocale,
    evasion,
    confirmFailureArtifacts,
    privacy,
    postSafetyLint,
    activityConfig,
    db,
    logger,
    artifacts,
    twoPhaseCommit,
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(
      profileManager,
      options.cdpUrl,
      selectorLocale,
      logger,
      evasion
    ),
    profile: undefined as unknown as LinkedInProfileService,
    imageAssets: undefined as unknown as LinkedInImageAssetsService,
    search: undefined as unknown as LinkedInSearchService,
    jobs: undefined as unknown as LinkedInJobsService,
    notifications: undefined as unknown as LinkedInNotificationsService,
    connections: undefined as unknown as LinkedInConnectionsService,
    members: undefined as unknown as LinkedInMembersService,
    privacySettings: undefined as unknown as LinkedInPrivacySettingsService,
    followups: undefined as unknown as LinkedInFollowupsService,
    feed: undefined as unknown as LinkedInFeedService,
    posts: undefined as unknown as LinkedInPostsService,
    inbox: undefined as unknown as LinkedInInboxService,
    activityWatches: undefined as unknown as ActivityWatchesService,
    activityPoller: undefined as unknown as ActivityPollerService,
    selectorAudit: undefined as unknown as LinkedInSelectorAuditService,
    testAutoConfirm,
    healthCheck: async (
      healthOptions: { profileName?: string } = {}
    ): Promise<FullHealthStatus> => {
      const profileName = healthOptions.profileName ?? "default";
      return profileManager.runWithContext(
        {
          cdpUrl: options.cdpUrl,
          profileName,
          headless: true
        },
        (context) => checkFullHealth(context, { evasion })
      );
    },
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      logger.log("info", "runtime.closed", { runId });
      db.close();
    }
  };

  const profileRuntime: LinkedInProfileRuntime = runtime;
  runtime.profile = new LinkedInProfileService(profileRuntime);
  runtime.imageAssets = new LinkedInImageAssetsService(
    {
      logger,
      artifacts,
      profile: runtime.profile,
      confirmPreparedAction: (confirmToken) =>
        runtime.twoPhaseCommit.confirmByToken({ confirmToken })
    },
    {
      ...(process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : {}),
      ...(process.env.OPENAI_BASE_URL
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
      ...(process.env.LINKEDIN_ASSISTANT_OPENAI_IMAGE_MODEL
        ? { defaultModel: process.env.LINKEDIN_ASSISTANT_OPENAI_IMAGE_MODEL }
        : {})
    }
  );
  const searchRuntime: LinkedInSearchRuntime = runtime;
  runtime.search = new LinkedInSearchService(searchRuntime);
  const jobsRuntime: LinkedInJobsRuntime = runtime;
  runtime.jobs = new LinkedInJobsService(jobsRuntime);
  const notificationsRuntime: LinkedInNotificationsRuntime = runtime;
  runtime.notifications = new LinkedInNotificationsService(notificationsRuntime);
  const connectionsRuntime: LinkedInConnectionsRuntime = runtime;
  runtime.connections = new LinkedInConnectionsService(connectionsRuntime);
  const membersRuntime: LinkedInMembersRuntime = runtime;
  runtime.members = new LinkedInMembersService(membersRuntime);
  const privacySettingsRuntime: LinkedInPrivacySettingsRuntime = runtime;
  runtime.privacySettings = new LinkedInPrivacySettingsService(
    privacySettingsRuntime
  );
  const followupsRuntime: LinkedInFollowupsRuntime = runtime;
  runtime.followups = new LinkedInFollowupsService(followupsRuntime);
  const feedRuntime: LinkedInFeedRuntime = runtime;
  runtime.feed = new LinkedInFeedService(feedRuntime);
  const postsRuntime: LinkedInPostsRuntime = runtime;
  runtime.posts = new LinkedInPostsService(postsRuntime);
  runtime.inbox = new LinkedInInboxService(runtime);
  runtime.activityWatches = new ActivityWatchesService(runtime);
  runtime.activityPoller = new ActivityPollerService(runtime);
  runtime.selectorAudit = new LinkedInSelectorAuditService(runtime);

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir,
    evasion_diagnostics_enabled: evasion.diagnosticsEnabled,
    evasion_level: evasion.level,
    evasion_source: evasion.source,
    selector_locale: selectorLocale
  });

  logger.log("debug", "runtime.evasion.configured", {
    diagnostics_enabled: evasion.diagnosticsEnabled,
    disabled_features: evasion.disabledFeatures,
    enabled_features: evasion.enabledFeatures,
    evasion_level: evasion.level,
    evasion_source: evasion.source,
    profile: evasion.profile,
    summary: evasion.summary
  });

  return runtime;
}
