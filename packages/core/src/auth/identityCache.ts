import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveConfigPaths } from "../config.js";
import { LinkedInBuddyError } from "../errors.js";

const IDENTITY_CACHE_DIR_NAME = "identity-cache";
const IDENTITY_CACHE_FILE_SUFFIX = ".identity.json";

/** Cached LinkedIn member identity for a named session. */
export interface CachedLinkedInIdentity {
  fullName: string | null;
  vanityName: string | null;
  profileUrl: string | null;
  cachedAt: string;
}

/** Input shape for writing an identity cache entry. */
export interface IdentityCacheEntry {
  fullName: string | null;
  vanityName: string | null;
  profileUrl: string | null;
}

function normalizeSessionName(sessionName: string | undefined): string {
  const normalized = (sessionName ?? "default").trim();
  if (normalized.length === 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not be empty.",
    );
  }
  if (normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "session name must not contain path separators or relative path segments.",
      { session_name: normalized },
    );
  }
  return normalized;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isCachedIdentity(value: unknown): value is CachedLinkedInIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    isStringOrNull(entry.fullName) &&
    isStringOrNull(entry.vanityName) &&
    isStringOrNull(entry.profileUrl) &&
    typeof entry.cachedAt === "string"
  );
}

export function resolveIdentityCacheDir(baseDir?: string): string {
  return path.join(resolveConfigPaths(baseDir).profilesDir, IDENTITY_CACHE_DIR_NAME);
}

export function resolveIdentityCachePath(
  sessionName: string = "default",
  baseDir?: string,
): string {
  const normalizedSessionName = normalizeSessionName(sessionName);
  return path.join(
    resolveIdentityCacheDir(baseDir),
    `${normalizedSessionName}${IDENTITY_CACHE_FILE_SUFFIX}`,
  );
}

export async function readIdentityCache(
  sessionName: string = "default",
  baseDir?: string,
): Promise<CachedLinkedInIdentity | null> {
  try {
    const raw = await readFile(resolveIdentityCachePath(sessionName, baseDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isCachedIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeIdentityCache(
  sessionName: string,
  identity: IdentityCacheEntry,
  baseDir?: string,
): Promise<void> {
  await mkdir(resolveIdentityCacheDir(baseDir), { recursive: true });
  const payload: CachedLinkedInIdentity = {
    ...identity,
    cachedAt: new Date().toISOString(),
  };
  await writeFile(
    resolveIdentityCachePath(sessionName, baseDir),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export async function clearIdentityCache(
  sessionName: string = "default",
  baseDir?: string,
): Promise<boolean> {
  try {
    await unlink(resolveIdentityCachePath(sessionName, baseDir));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}
