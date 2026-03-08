import { ArtifactHelpers } from "./artifacts.js";
import {
  ensureConfigPaths,
  resolveConfigPaths,
  resolveConfirmFailureArtifactConfig,
  resolveLinkedInSelectorLocaleConfigResolution,
  type ConfigPaths,
  type ConfirmFailureArtifactConfig
} from "./config.js";
import { AssistantDatabase } from "./db/database.js";
import { LinkedInAuthService } from "./auth/session.js";
import {
  createConnectionActionExecutors,
  LinkedInConnectionsService,
  type LinkedInConnectionsRuntime
} from "./linkedinConnections.js";
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
  LinkedInProfileService,
  type LinkedInProfileRuntime
} from "./linkedinProfile.js";
import {
  LinkedInJobsService,
  type LinkedInJobsRuntime
} from "./linkedinJobs.js";
import {
  LinkedInNotificationsService,
  type LinkedInNotificationsRuntime
} from "./linkedinNotifications.js";
import {
  LinkedInSearchService,
  type LinkedInSearchRuntime
} from "./linkedinSearch.js";
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

export interface CreateCoreRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
  runId?: string;
  cdpUrl?: string | undefined;
  privacy?: Partial<PrivacyConfig>;
  selectorLocale?: string | LinkedInSelectorLocale;
}

export interface CoreRuntime {
  paths: ConfigPaths;
  runId: string;
  cdpUrl?: string | undefined;
  selectorLocale: LinkedInSelectorLocale;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  privacy: PrivacyConfig;
  postSafetyLint: LinkedInPostSafetyLintConfig;
  db: AssistantDatabase;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  twoPhaseCommit: TwoPhaseCommitService<LinkedInMessagingRuntime>;
  rateLimiter: RateLimiter;
  profileManager: ProfileManager;
  auth: LinkedInAuthService;
  profile: LinkedInProfileService;
  search: LinkedInSearchService;
  jobs: LinkedInJobsService;
  notifications: LinkedInNotificationsService;
  connections: LinkedInConnectionsService;
  followups: LinkedInFollowupsService;
  feed: LinkedInFeedService;
  posts: LinkedInPostsService;
  inbox: LinkedInInboxService;
  selectorAudit: LinkedInSelectorAuditService;
  testAutoConfirm: TestAutoConfirmConfig;
  healthCheck: (options?: { profileName?: string }) => Promise<FullHealthStatus>;
  close: () => void;
}

export function createCoreRuntime(
  options: CreateCoreRuntimeOptions = {}
): CoreRuntime {
  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);
  const privacy = resolvePrivacyConfig(options.privacy);
  const postSafetyLint = resolveLinkedInPostSafetyLintConfig(paths.baseDir);
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
  let runtime: CoreRuntime;

  if (
    selectorLocaleResolution.fallbackUsed &&
    selectorLocale === DEFAULT_LINKEDIN_SELECTOR_LOCALE &&
    selectorLocaleResolution.source !== "default"
  ) {
    logger.log("warn", "runtime.selector_locale.fallback_to_english", {
      selector_locale_source: selectorLocaleResolution.source,
      resolved_selector_locale: selectorLocale,
      reason: selectorLocaleResolution.fallbackReason,
      ...summarizeSelectorLocaleInput(
        selectorLocaleResolution.normalizedInput,
        selectorLocaleResolution.inputLength
      )
    });
  }

  const testAutoConfirm = createDefaultTestAutoConfirmConfig();
  const linkedInExecutors = createLinkedInActionExecutors();
  const connectionExecutors = createConnectionActionExecutors() as unknown as Record<
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
  const testEchoExecutor = new TestEchoActionExecutor<LinkedInMessagingRuntime>();
  const twoPhaseCommit = new TwoPhaseCommitService<LinkedInMessagingRuntime>(db, {
    privacy,
    executors: {
      ...linkedInExecutors,
      ...connectionExecutors,
      ...followupExecutors,
      ...feedExecutors,
      ...postExecutors,
      [TEST_ECHO_ACTION_TYPE]: testEchoExecutor
    },
    getRuntime: () => runtime
  });

  runtime = {
    paths,
    runId,
    cdpUrl: options.cdpUrl,
    selectorLocale,
    confirmFailureArtifacts,
    privacy,
    postSafetyLint,
    db,
    logger,
    artifacts,
    twoPhaseCommit,
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(
      profileManager,
      options.cdpUrl,
      selectorLocale
    ),
    profile: undefined as unknown as LinkedInProfileService,
    search: undefined as unknown as LinkedInSearchService,
    jobs: undefined as unknown as LinkedInJobsService,
    notifications: undefined as unknown as LinkedInNotificationsService,
    connections: undefined as unknown as LinkedInConnectionsService,
    followups: undefined as unknown as LinkedInFollowupsService,
    feed: undefined as unknown as LinkedInFeedService,
    posts: undefined as unknown as LinkedInPostsService,
    inbox: undefined as unknown as LinkedInInboxService,
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
        (context) => checkFullHealth(context)
      );
    },
    close: () => {
      logger.log("info", "runtime.closed", { runId });
      db.close();
    }
  };

  const profileRuntime: LinkedInProfileRuntime = runtime;
  runtime.profile = new LinkedInProfileService(profileRuntime);
  const searchRuntime: LinkedInSearchRuntime = runtime;
  runtime.search = new LinkedInSearchService(searchRuntime);
  const jobsRuntime: LinkedInJobsRuntime = runtime;
  runtime.jobs = new LinkedInJobsService(jobsRuntime);
  const notificationsRuntime: LinkedInNotificationsRuntime = runtime;
  runtime.notifications = new LinkedInNotificationsService(notificationsRuntime);
  const connectionsRuntime: LinkedInConnectionsRuntime = runtime;
  runtime.connections = new LinkedInConnectionsService(connectionsRuntime);
  const followupsRuntime: LinkedInFollowupsRuntime = runtime;
  runtime.followups = new LinkedInFollowupsService(followupsRuntime);
  const feedRuntime: LinkedInFeedRuntime = runtime;
  runtime.feed = new LinkedInFeedService(feedRuntime);
  const postsRuntime: LinkedInPostsRuntime = runtime;
  runtime.posts = new LinkedInPostsService(postsRuntime);
  runtime.inbox = new LinkedInInboxService(runtime);
  runtime.selectorAudit = new LinkedInSelectorAuditService(runtime);

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir,
    selector_locale: selectorLocale
  });

  return runtime;
}
