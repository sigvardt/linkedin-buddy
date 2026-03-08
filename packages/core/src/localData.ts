import { access, rm } from "node:fs/promises";
import path from "node:path";
import {
  resolveLegacyRateLimitStateFilePath,
  resolveRateLimitStateFilePath
} from "./auth/rateLimitState.js";
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

function resolveKeepAliveDir(baseDir: string): string {
  return path.join(baseDir, "keepalive");
}

function shouldIncludeLegacyRateLimitStatePath(
  options: LocalDataDeletionPlanOptions
): boolean {
  return (
    !options.rateLimitStatePath &&
    typeof process.env.LINKEDIN_ASSISTANT_HOME !== "string"
  );
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function isSameOrChildPath(parentPath: string, candidatePath: string): boolean {
  return (
    candidatePath === parentPath ||
    candidatePath.startsWith(`${parentPath}${path.sep}`)
  );
}

function dedupePaths(targetPaths: string[]): string[] {
  return [...new Set(targetPaths.map((targetPath) => normalizePath(targetPath)))];
}

function assertSafeBaseDir(baseDir: string): void {
  const resolvedBaseDir = normalizePath(baseDir);
  if (resolvedBaseDir === path.parse(resolvedBaseDir).root) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Refusing to delete local data when the configured base directory is the filesystem root.",
      {
        base_dir: resolvedBaseDir
      }
    );
  }
}

function createAllowedTargetSet(options: LocalDataDeletionPlanOptions): Set<string> {
  const paths = resolveConfigPaths(options.baseDir);
  return new Set(
    dedupePaths([
      paths.dbPath,
      paths.artifactsDir,
      resolveKeepAliveDir(paths.baseDir),
      paths.profilesDir,
      resolveRateLimitStateFilePath(options.rateLimitStatePath),
      ...(shouldIncludeLegacyRateLimitStatePath(options)
        ? [resolveLegacyRateLimitStateFilePath()]
        : [])
    ])
  );
}

function assertSafeDeletionTarget(
  targetPath: string,
  options: LocalDataDeletionPlanOptions
): void {
  const paths = resolveConfigPaths(options.baseDir);
  assertSafeBaseDir(paths.baseDir);

  const resolvedTargetPath = normalizePath(targetPath);
  const allowedTargets = createAllowedTargetSet(options);
  const resolvedBaseDir = normalizePath(paths.baseDir);

  if (!allowedTargets.has(resolvedTargetPath)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Refusing to delete an unexpected local-data path.",
      {
        target_path: resolvedTargetPath
      }
    );
  }

  const isLegacyRateLimitStatePath =
    resolvedTargetPath === normalizePath(resolveLegacyRateLimitStateFilePath());
  const isExplicitRateLimitStatePath =
    typeof options.rateLimitStatePath === "string" &&
    resolvedTargetPath ===
      normalizePath(resolveRateLimitStateFilePath(options.rateLimitStatePath));

  if (
    !isLegacyRateLimitStatePath &&
    !isExplicitRateLimitStatePath &&
    !isSameOrChildPath(resolvedBaseDir, resolvedTargetPath)
  ) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Refusing to delete a path outside the configured local-data directory.",
      {
        base_dir: resolvedBaseDir,
        target_path: resolvedTargetPath
      }
    );
  }

  if (resolvedTargetPath === resolvedBaseDir) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Refusing to delete the configured local-data base directory directly.",
      {
        base_dir: resolvedBaseDir
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
  const rateLimitTargets = options.rateLimitStatePath
    ? [resolveRateLimitStateFilePath(options.rateLimitStatePath)]
    : shouldIncludeLegacyRateLimitStatePath(options)
      ? [
          resolveRateLimitStateFilePath(),
          resolveLegacyRateLimitStateFilePath()
        ]
      : [resolveRateLimitStateFilePath()];

  const targets = dedupePaths([
    paths.dbPath,
    paths.artifactsDir,
    resolveKeepAliveDir(paths.baseDir),
    ...rateLimitTargets,
    ...(includeProfile ? [paths.profilesDir] : [])
  ]);

  return {
    baseDir: normalizePath(paths.baseDir),
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
    assertSafeDeletionTarget(targetPath, options);

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
