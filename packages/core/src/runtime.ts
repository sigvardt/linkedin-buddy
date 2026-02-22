import { ArtifactHelpers } from "./artifacts.js";
import { ensureConfigPaths, resolveConfigPaths, type ConfigPaths } from "./config.js";
import { AssistantDatabase } from "./db/database.js";
import { LinkedInAuthService } from "./auth/session.js";
import {
  createLinkedInActionExecutors,
  LinkedInInboxService,
  type LinkedInMessagingRuntime
} from "./linkedinInbox.js";
import { JsonEventLogger } from "./logging.js";
import { ProfileManager } from "./profileManager.js";
import { RateLimiter } from "./rateLimiter.js";
import { createRunId } from "./run.js";
import { TwoPhaseCommitService } from "./twoPhaseCommit.js";

export interface CreateCoreRuntimeOptions {
  baseDir?: string;
  dbPath?: string;
  runId?: string;
}

export interface CoreRuntime {
  paths: ConfigPaths;
  runId: string;
  db: AssistantDatabase;
  logger: JsonEventLogger;
  artifacts: ArtifactHelpers;
  twoPhaseCommit: TwoPhaseCommitService<LinkedInMessagingRuntime>;
  rateLimiter: RateLimiter;
  profileManager: ProfileManager;
  auth: LinkedInAuthService;
  inbox: LinkedInInboxService;
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

  const twoPhaseCommit = new TwoPhaseCommitService<LinkedInMessagingRuntime>(db, {
    executors: createLinkedInActionExecutors(),
    getRuntime: () => runtime
  });

  runtime = {
    paths,
    runId,
    db,
    logger,
    artifacts,
    twoPhaseCommit,
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(profileManager),
    inbox: undefined as unknown as LinkedInInboxService,
    close: () => {
      logger.log("info", "runtime.closed", { runId });
      db.close();
    }
  };

  runtime.inbox = new LinkedInInboxService(runtime);

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir
  });

  return runtime;
}
