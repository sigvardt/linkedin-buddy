import { access, rm } from "node:fs/promises";
import path from "node:path";
import { resolveRateLimitStateFilePaths } from "./auth/rateLimitState.js";
import { resolveConfigPaths } from "./config.js";
import { LinkedInAssistantError } from "./errors.js";

export interface LocalDataDeletionPlanOptions {
  baseDir?: string;
  includeProfile?: boolean;
  rateLimitStatePath?: string;
}

export interface LocalDataDeletionPlan {
  baseDir: string;
  includeProfile: boolean;
  targets: string[];
}

export interface LocalDataDeletionResult {
  deletedPaths: string[];
  missingPaths: string[];
}

const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

export function resolveKeepAliveDir(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).baseDir, "keepalive");
}

function resolveDatabasePaths(dbPath: string): string[] {
  return [dbPath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)];
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function dedupePaths(targetPaths: string[]): string[] {
  return [...new Set(targetPaths.map((targetPath) => normalizePath(targetPath)))];
}

function assertSafeDeletePath(targetPath: string, label: string): void {
  const resolvedTargetPath = normalizePath(targetPath);
  if (resolvedTargetPath === path.parse(resolvedTargetPath).root) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `Refusing to delete ${label} because it resolves to the filesystem root.`,
      {
        target_path: resolvedTargetPath
      }
    );
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

export function createLocalDataDeletionPlan(
  options: LocalDataDeletionPlanOptions = {}
): LocalDataDeletionPlan {
  const paths = resolveConfigPaths(options.baseDir);
  const includeProfile = options.includeProfile ?? false;
  const baseDir = normalizePath(paths.baseDir);

  assertSafeDeletePath(baseDir, "local data");

  const targets = dedupePaths([
    ...resolveDatabasePaths(paths.dbPath),
    paths.artifactsDir,
    resolveKeepAliveDir(paths.baseDir),
    ...resolveRateLimitStateFilePaths(options.rateLimitStatePath, options.baseDir),
    ...(includeProfile ? [paths.profilesDir] : [])
  ]);

  for (const targetPath of targets) {
    assertSafeDeletePath(targetPath, "a local-data target");
  }

  return {
    baseDir,
    includeProfile,
    targets
  };
}

export async function deleteLocalData(
  options: LocalDataDeletionPlanOptions = {}
): Promise<LocalDataDeletionResult> {
  const deletionPlan = createLocalDataDeletionPlan(options);
  const deletedPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const targetPath of deletionPlan.targets) {
    if (!(await pathExists(targetPath))) {
      missingPaths.push(targetPath);
      continue;
    }

    await rm(targetPath, {
      force: false,
      recursive: true,
      maxRetries: 3,
      retryDelay: 100
    });
    deletedPaths.push(targetPath);
  }

  return {
    deletedPaths,
    missingPaths
  };
}
