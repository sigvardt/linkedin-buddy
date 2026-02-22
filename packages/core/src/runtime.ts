import { ArtifactHelpers } from "./artifacts.js";
import { ensureConfigPaths, resolveConfigPaths, type ConfigPaths } from "./config.js";
import { AssistantDatabase } from "./db/database.js";
import { LinkedInAuthService } from "./auth/session.js";
import {
  createConnectionActionExecutors,
  LinkedInConnectionsService,
  type LinkedInConnectionsRuntime
} from "./linkedinConnections.js";
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
  LinkedInSearchService,
  type LinkedInSearchRuntime
} from "./linkedinSearch.js";
import { JsonEventLogger } from "./logging.js";
import { ProfileManager } from "./profileManager.js";
import { RateLimiter } from "./rateLimiter.js";
import { createRunId } from "./run.js";
import {
  TwoPhaseCommitService,
  TestEchoActionExecutor,
  TEST_ECHO_ACTION_TYPE,
  createDefaultTestAutoConfirmConfig,
  type TestAutoConfirmConfig
} from "./twoPhaseCommit.js";

export interface CreateCoreRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
  runId?: string;
  cdpUrl?: string | undefined;
}

export interface CoreRuntime {
  paths: ConfigPaths;
  runId: string;
  cdpUrl?: string | undefined;
  db: AssistantDatabase;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  twoPhaseCommit: TwoPhaseCommitService<LinkedInMessagingRuntime>;
  rateLimiter: RateLimiter;
  profileManager: ProfileManager;
  auth: LinkedInAuthService;
  profile: LinkedInProfileService;
  search: LinkedInSearchService;
  connections: LinkedInConnectionsService;
  feed: LinkedInFeedService;
  inbox: LinkedInInboxService;
  testAutoConfirm: TestAutoConfirmConfig;
  close: () => void;
}

export function createCoreRuntime(
  options: CreateCoreRuntimeOptions = {}
): CoreRuntime {
  const paths = resolveConfigPaths(options.baseDir);
  ensureConfigPaths(paths);

  const db = new AssistantDatabase(options.dbPath ?? paths.dbPath);
  const runId = options.runId ?? createRunId();
  const logger = new JsonEventLogger(paths, runId, db);
  const artifacts = new ArtifactHelpers(paths, runId, db);
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
  const testEchoExecutor = new TestEchoActionExecutor<LinkedInMessagingRuntime>();
  const twoPhaseCommit = new TwoPhaseCommitService<LinkedInMessagingRuntime>(db, {
    executors: {
      ...linkedInExecutors,
      ...connectionExecutors,
      ...feedExecutors,
      [TEST_ECHO_ACTION_TYPE]: testEchoExecutor
    },
    getRuntime: () => runtime
  });

  runtime = {
    paths,
    runId,
    cdpUrl: options.cdpUrl,
    db,
    logger,
    artifacts,
    twoPhaseCommit,
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(profileManager, options.cdpUrl),
    profile: undefined as unknown as LinkedInProfileService,
    search: undefined as unknown as LinkedInSearchService,
    connections: undefined as unknown as LinkedInConnectionsService,
    feed: undefined as unknown as LinkedInFeedService,
    inbox: undefined as unknown as LinkedInInboxService,
    testAutoConfirm,
    close: () => {
      logger.log("info", "runtime.closed", { runId });
      db.close();
    }
  };

  const profileRuntime: LinkedInProfileRuntime = runtime;
  runtime.profile = new LinkedInProfileService(profileRuntime);
  const searchRuntime: LinkedInSearchRuntime = runtime;
  runtime.search = new LinkedInSearchService(searchRuntime);
  const connectionsRuntime: LinkedInConnectionsRuntime = runtime;
  runtime.connections = new LinkedInConnectionsService(connectionsRuntime);
  const feedRuntime: LinkedInFeedRuntime = runtime;
  runtime.feed = new LinkedInFeedService(feedRuntime);
  runtime.inbox = new LinkedInInboxService(runtime);

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir
  });

  return runtime;
}
