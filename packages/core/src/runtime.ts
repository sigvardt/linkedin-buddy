import { ArtifactHelpers } from "./artifacts.js";
import {
  ensureConfigPaths,
  resolveConfigPaths,
  resolveConfirmFailureArtifactConfig,
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

export interface CreateCoreRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
  runId?: string;
  cdpUrl?: string | undefined;
  privacy?: Partial<PrivacyConfig>;
}

export interface CoreRuntime {
  paths: ConfigPaths;
  runId: string;
  cdpUrl?: string | undefined;
  confirmFailureArtifacts: ConfirmFailureArtifactConfig;
  privacy: PrivacyConfig;
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

  const db = new AssistantDatabase(options.dbPath ?? paths.dbPath);
  const runId = options.runId ?? createRunId();
  const logger = new JsonEventLogger(paths, runId, db, privacy);
  const artifacts = new ArtifactHelpers(paths, runId, db, privacy);
  const confirmFailureArtifacts = resolveConfirmFailureArtifactConfig();
  const profileManager = new ProfileManager(paths);
  let runtime: CoreRuntime;

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
    confirmFailureArtifacts,
    privacy,
    db,
    logger,
    artifacts,
    twoPhaseCommit,
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(profileManager, options.cdpUrl),
    profile: undefined as unknown as LinkedInProfileService,
    search: undefined as unknown as LinkedInSearchService,
    jobs: undefined as unknown as LinkedInJobsService,
    notifications: undefined as unknown as LinkedInNotificationsService,
    connections: undefined as unknown as LinkedInConnectionsService,
    followups: undefined as unknown as LinkedInFollowupsService,
    feed: undefined as unknown as LinkedInFeedService,
    posts: undefined as unknown as LinkedInPostsService,
    inbox: undefined as unknown as LinkedInInboxService,
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

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir
  });

  return runtime;
}
