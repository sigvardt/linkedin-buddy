import { ArtifactHelpers } from "./artifacts.js";
import { ensureConfigPaths, resolveConfigPaths, type ConfigPaths } from "./config.js";
import { AssistantDatabase } from "./db/database.js";
import { LinkedInAuthService } from "./auth/session.js";
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
  twoPhaseCommit: TwoPhaseCommitService;
  rateLimiter: RateLimiter;
  profileManager: ProfileManager;
  auth: LinkedInAuthService;
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

  const runtime: CoreRuntime = {
    paths,
    runId,
    db,
    logger,
    artifacts,
    twoPhaseCommit: new TwoPhaseCommitService(db),
    rateLimiter: new RateLimiter(db),
    profileManager,
    auth: new LinkedInAuthService(profileManager),
    close: () => {
      logger.log("info", "runtime.closed", { runId });
      db.close();
    }
  };

  logger.log("info", "runtime.started", {
    runId,
    baseDir: paths.baseDir
  });

  return runtime;
}
