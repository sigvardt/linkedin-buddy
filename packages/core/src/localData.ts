import { realpathSync, statSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { resolveRateLimitStateFilePaths } from "./auth/rateLimitState.js";
import { resolveConfigPaths } from "./config.js";
import { LinkedInAssistantError } from "./errors.js";

/**
 * Filesystem-first helpers for inventorying and deleting tool-owned local
 * state.
 *
 * @remarks
 * These helpers intentionally avoid booting the normal runtime.
 * `createCoreRuntime()` eagerly creates directories, opens `state.sqlite`, and
 * writes lifecycle logs, which would recreate state during a deletion flow.
 */
export interface LocalDataDeletionPlanOptions {
  /**
   * Optional assistant home override used to resolve the owned local-state
   * footprint.
   */
  baseDir?: string;
  /**
   * When true, the deletion plan also includes tool-owned browser profile
   * directories.
   */
  includeProfile?: boolean;
  /**
   * Optional override for the auth cooldown file, mainly for tests and custom
   * installs.
   */
  rateLimitStatePath?: string;
}

/**
 * Canonical local-data inventory resolved before any destructive action runs.
 */
export interface LocalDataDeletionPlan {
  /** Canonical assistant home used to scope in-base deletion targets. */
  baseDir: string;
  /** Indicates whether browser profiles were explicitly opted into the plan. */
  includeProfile: boolean;
  /** Absolute target paths that the deletion workflow may remove. */
  targets: string[];
}

/**
 * Actionable information about a single filesystem target that could not be
 * removed.
 */
export interface LocalDataDeletionFailure {
  /** Absolute path that failed deletion. */
  path: string;
  /** Best-effort filesystem error code, when one is available. */
  code: string | null;
  /** Human-readable error message surfaced to the operator. */
  message: string;
  /** Optional retry guidance derived from the filesystem error code. */
  recoveryHint?: string;
}

/**
 * Summary returned after a deletion attempt finishes scanning every target.
 */
export interface LocalDataDeletionResult {
  /** Timestamp captured immediately before deletion begins. */
  startedAt: string;
  /** Timestamp captured after the last deletion attempt completes. */
  completedAt: string;
  /** Paths that were removed successfully. */
  deletedPaths: string[];
  /** Paths that were already absent when the command reached them. */
  missingPaths: string[];
  /** Paths that still require operator attention or a retry. */
  failedPaths: LocalDataDeletionFailure[];
}

const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"] as const;

/**
 * Resolves the directory that stores keepalive PID, state, and event-log
 * files.
 */
export function resolveKeepAliveDir(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).baseDir, "keepalive");
}

function resolveDatabasePaths(dbPath: string): string[] {
  return [dbPath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)];
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function resolvePathInput(targetPath: string, label: string): string {
  if (targetPath.trim().length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must not be empty.`,
      {
        target_path: targetPath
      }
    );
  }

  return normalizePath(targetPath);
}

function dedupePaths(targetPaths: string[]): string[] {
  return [...new Set(targetPaths.map((targetPath) => normalizePath(targetPath)))];
}

function isErrnoException(
  error: unknown
): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}

function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
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

function resolveCanonicalDirectoryPath(targetPath: string): string {
  const normalizedTargetPath = normalizePath(targetPath);

  try {
    const existingTargetPath = realpathSync(normalizedTargetPath);
    if (!statSync(existingTargetPath).isDirectory()) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Refusing to delete local data because its configured base directory is not a directory.",
        {
          base_dir: normalizedTargetPath,
          resolved_path: existingTargetPath
        }
      );
    }

    return existingTargetPath;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }

    const parentPath = path.dirname(normalizedTargetPath);
    if (parentPath === normalizedTargetPath) {
      return normalizedTargetPath;
    }

    return path.resolve(
      resolveCanonicalDirectoryPath(parentPath),
      path.basename(normalizedTargetPath)
    );
  }
}

function resolveDeletionTargetPath(targetPath: string): string {
  const normalizedTargetPath = normalizePath(targetPath);

  return path.resolve(
    resolveCanonicalDirectoryPath(path.dirname(normalizedTargetPath)),
    path.basename(normalizedTargetPath)
  );
}

function isPathWithinParent(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(parentPath, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function assertTargetWithinBaseDir(targetPath: string, baseDir: string): void {
  if (isPathWithinParent(baseDir, targetPath)) {
    return;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Refusing to delete a local-data target that escapes the configured base directory.",
    {
      base_dir: baseDir,
      target_path: targetPath
    }
  );
}

function resolveRecoveryHint(code: string | undefined): string | undefined {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "Check filesystem permissions for this path and retry.";
    case "EBUSY":
      return "Close any process still using this path, then retry the deletion.";
    case "ENOSPC":
      return "Free disk space and retry the deletion.";
    case "ENOTEMPTY":
      return "Another process changed this directory during deletion. Retry once local activity has stopped.";
    case "EROFS":
      return "This path is on a read-only filesystem. Remount it writable or choose a writable assistant home.";
    default:
      return undefined;
  }
}

function toDeletionFailure(
  targetPath: string,
  error: unknown
): LocalDataDeletionFailure {
  if (error instanceof Error) {
    const code = isErrnoException(error) && typeof error.code === "string"
      ? error.code
      : null;
    const recoveryHint = resolveRecoveryHint(code ?? undefined);
    return {
      path: targetPath,
      code,
      message: error.message,
      ...(recoveryHint ? { recoveryHint } : {})
    };
  }

  return {
    path: targetPath,
    code: null,
    message: String(error)
  };
}

/**
 * Resolves the canonical set of tool-owned paths eligible for local-data
 * deletion.
 *
 * @remarks
 * The plan only includes runtime-owned state. `config.json` remains outside
 * the deletion plan so the command behaves like privacy cleanup instead of a
 * full factory reset.
 */
export function createLocalDataDeletionPlan(
  options: LocalDataDeletionPlanOptions = {}
): LocalDataDeletionPlan {
  const paths = resolveConfigPaths(options.baseDir);
  const includeProfile = options.includeProfile ?? false;
  const normalizedBaseDir = resolvePathInput(
    paths.baseDir,
    "local data base directory"
  );
  const canonicalBaseDir = resolveCanonicalDirectoryPath(normalizedBaseDir);

  assertSafeDeletePath(canonicalBaseDir, "local data");

  const rawTargets = [
    ...resolveDatabasePaths(paths.dbPath),
    paths.artifactsDir,
    resolveKeepAliveDir(paths.baseDir),
    ...resolveRateLimitStateFilePaths(options.rateLimitStatePath, options.baseDir),
    ...(includeProfile ? [paths.profilesDir] : [])
  ];

  const targets = dedupePaths(
    rawTargets.map((targetPath) => {
      const normalizedTargetPath = resolvePathInput(
        targetPath,
        "local-data target path"
      );

      if (isPathWithinParent(normalizedBaseDir, normalizedTargetPath)) {
        const relativeTargetPath = path.relative(
          normalizedBaseDir,
          normalizedTargetPath
        );
        const canonicalTargetPath = path.resolve(
          canonicalBaseDir,
          relativeTargetPath
        );

        assertTargetWithinBaseDir(canonicalTargetPath, canonicalBaseDir);
        return canonicalTargetPath;
      }

      return resolveDeletionTargetPath(normalizedTargetPath);
    })
  );

  for (const targetPath of targets) {
    assertSafeDeletePath(targetPath, "a local-data target");
  }

  return {
    baseDir: canonicalBaseDir,
    includeProfile,
    targets
  };
}

/**
 * Deletes the planned local-data targets from disk.
 *
 * @remarks
 * Missing paths are reported in `missingPaths` and do not fail the command.
 * Other filesystem errors are accumulated so the helper can continue deleting
 * remaining targets before throwing a `LinkedInAssistantError` with
 * `failed_paths` details.
 */
export async function deleteLocalData(
  options: LocalDataDeletionPlanOptions = {}
): Promise<LocalDataDeletionResult> {
  const deletionPlan = createLocalDataDeletionPlan(options);
  const startedAt = new Date().toISOString();
  const deletedPaths: string[] = [];
  const missingPaths: string[] = [];
  const failedPaths: LocalDataDeletionFailure[] = [];

  for (const targetPath of deletionPlan.targets) {
    try {
      await fsPromises.rm(targetPath, {
        force: false,
        recursive: true,
        maxRetries: 3,
        retryDelay: 100
      });
      deletedPaths.push(targetPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        missingPaths.push(targetPath);
        continue;
      }

      failedPaths.push(toDeletionFailure(targetPath, error));
    }
  }

  const completedAt = new Date().toISOString();
  const result: LocalDataDeletionResult = {
    startedAt,
    completedAt,
    deletedPaths,
    missingPaths,
    failedPaths
  };

  if (failedPaths.length > 0) {
    throw new LinkedInAssistantError(
      "UNKNOWN",
      "Local data deletion completed with some failures. Review failed_paths and retry after following the recovery guidance.",
      {
        started_at: startedAt,
        completed_at: completedAt,
        deleted_paths: deletedPaths,
        missing_paths: missingPaths,
        failed_paths: failedPaths
      }
    );
  }

  return result;
}
