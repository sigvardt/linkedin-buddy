import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RateLimitState {
  rateLimitedUntil: string;
  detectedAt: string;
  consecutiveRateLimits: number;
}

const DEFAULT_STATE_FILE_PATH = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "rate-limit-state.json"
);

function resolveStateFilePath(stateFilePath?: string): string {
  return stateFilePath ?? DEFAULT_STATE_FILE_PATH;
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
  const resolvedStateFilePath = resolveStateFilePath(stateFilePath);

  try {
    const rawState = await readFile(resolvedStateFilePath, "utf8");
    const parsed = JSON.parse(rawState) as unknown;
    return isValidRateLimitState(parsed) ? parsed : null;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export async function writeRateLimitState(
  state: RateLimitState,
  stateFilePath?: string
): Promise<void> {
  const resolvedStateFilePath = resolveStateFilePath(stateFilePath);
  await mkdir(path.dirname(resolvedStateFilePath), { recursive: true });
  await writeFile(
    resolvedStateFilePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

export async function clearRateLimitState(stateFilePath?: string): Promise<void> {
  const resolvedStateFilePath = resolveStateFilePath(stateFilePath);

  try {
    await unlink(resolvedStateFilePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }

    throw error;
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
