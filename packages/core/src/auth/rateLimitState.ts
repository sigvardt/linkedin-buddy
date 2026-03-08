import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfigPaths } from "../config.js";

export interface RateLimitState {
  rateLimitedUntil: string;
  detectedAt: string;
  consecutiveRateLimits: number;
}

const LEGACY_STATE_FILE_PATH = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "rate-limit-state.json"
);

export function resolveRateLimitStateFilePath(
  stateFilePath?: string,
  baseDir?: string
): string {
  if (stateFilePath) {
    return stateFilePath;
  }

  return path.join(resolveConfigPaths(baseDir).baseDir, "rate-limit-state.json");
}

export function resolveLegacyRateLimitStateFilePath(): string {
  return LEGACY_STATE_FILE_PATH;
}

function shouldIncludeLegacyStateFilePath(
  stateFilePath?: string,
  baseDir?: string
): boolean {
  return (
    !stateFilePath &&
    typeof baseDir !== "string" &&
    typeof process.env.LINKEDIN_ASSISTANT_HOME !== "string"
  );
}

export function resolveRateLimitStateFilePaths(
  stateFilePath?: string,
  baseDir?: string
): string[] {
  const primaryStateFilePath = resolveRateLimitStateFilePath(
    stateFilePath,
    baseDir
  );
  if (!shouldIncludeLegacyStateFilePath(stateFilePath, baseDir)) {
    return [primaryStateFilePath];
  }

  const legacyStateFilePath = resolveLegacyRateLimitStateFilePath();
  if (primaryStateFilePath === legacyStateFilePath) {
    return [primaryStateFilePath];
  }

  return [primaryStateFilePath, legacyStateFilePath];
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isValidRateLimitState(value: unknown): value is RateLimitState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RateLimitState>;
  return (
    isValidDateString(candidate.rateLimitedUntil) &&
    isValidDateString(candidate.detectedAt) &&
    typeof candidate.consecutiveRateLimits === "number" &&
    Number.isInteger(candidate.consecutiveRateLimits) &&
    candidate.consecutiveRateLimits > 0
  );
}

export async function readRateLimitState(
  stateFilePath?: string
): Promise<RateLimitState | null> {
  for (const resolvedStateFilePath of resolveRateLimitStateFilePaths(
    stateFilePath
  )) {
    try {
      const rawState = await readFile(resolvedStateFilePath, "utf8");
      const parsed = JSON.parse(rawState) as unknown;
      if (isValidRateLimitState(parsed)) {
        return parsed;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }

      if (error instanceof SyntaxError) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

export async function writeRateLimitState(
  state: RateLimitState,
  stateFilePath?: string
): Promise<void> {
  const resolvedStateFilePath = resolveRateLimitStateFilePath(stateFilePath);
  await mkdir(path.dirname(resolvedStateFilePath), { recursive: true });
  await writeFile(
    resolvedStateFilePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

export async function clearRateLimitState(stateFilePath?: string): Promise<void> {
  for (const resolvedStateFilePath of resolveRateLimitStateFilePaths(
    stateFilePath
  )) {
    try {
      await unlink(resolvedStateFilePath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }

      throw error;
    }
  }
}

export async function isInRateLimitCooldown(
  stateFilePath?: string
): Promise<{ active: boolean; state: RateLimitState | null }> {
  const state = await readRateLimitState(stateFilePath);
  if (!state) {
    return {
      active: false,
      state: null
    };
  }

  return {
    active: new Date(state.rateLimitedUntil).getTime() > Date.now(),
    state
  };
}

export async function recordRateLimit(
  stateFilePath?: string
): Promise<RateLimitState> {
  const existingState = await readRateLimitState(stateFilePath);
  const consecutiveRateLimits = (existingState?.consecutiveRateLimits ?? 0) + 1;

  const backoffHours =
    consecutiveRateLimits === 1 ? 2 : consecutiveRateLimits === 2 ? 4 : 8;

  const detectedAt = new Date();
  const rateLimitedUntil = new Date(
    detectedAt.getTime() + backoffHours * 60 * 60 * 1_000
  );

  const nextState: RateLimitState = {
    rateLimitedUntil: rateLimitedUntil.toISOString(),
    detectedAt: detectedAt.toISOString(),
    consecutiveRateLimits
  };

  await writeRateLimitState(nextState, stateFilePath);
  return nextState;
}
