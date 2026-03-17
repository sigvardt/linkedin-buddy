import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LINKEDIN_BUDDY_HOME } from "./config.js";
import { LinkedInBuddyError } from "./errors.js";

export const LINKEDIN_BUDDY_UPDATE_CHECK_ENV = "LINKEDIN_BUDDY_UPDATE_CHECK";
export const DEFAULT_UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 5_000;
export const UPDATE_CHECK_CACHE_FILENAME = "update-check.json";
export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
export const UPDATE_CHECK_PACKAGE_NAME = "@linkedin-buddy/cli";

export interface UpdateCheckConfig {
  enabled: boolean;
  cacheTtlMs: number;
  timeoutMs: number;
  cacheFilePath: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
  checkedAt: string;
  cached: boolean;
}

interface UpdateCheckCache {
  latestVersion: string;
  checkedAt: string;
}

export type InstallMethod = "global-npm" | "npx" | "local-npm" | "unknown";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeNumericTuple(version: string): number[] {
  return version
    .split(".")
    .flatMap((segment) =>
      segment.split("-").map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      })
    );
}

function createResult(
  currentVersion: string,
  latestVersion: string,
  checkedAt: string,
  cached: boolean
): UpdateCheckResult {
  const updateAvailable = isNewerVersion(currentVersion, latestVersion);
  return {
    updateAvailable,
    currentVersion,
    latestVersion,
    updateCommand: updateAvailable
      ? buildUpdateCommand(detectInstallMethod())
      : "",
    checkedAt,
    cached
  };
}

export function resolveUpdateCheckConfig(
  options: Partial<UpdateCheckConfig> = {}
): UpdateCheckConfig {
  const enabledFromSource =
    typeof options.enabled === "boolean"
      ? options.enabled
      : parseBoolean(process.env[LINKEDIN_BUDDY_UPDATE_CHECK_ENV], true);

  const enabled =
    enabledFromSource &&
    !parseBoolean(process.env.CI, false) &&
    process.env.NODE_ENV !== "test";

  return {
    enabled,
    cacheTtlMs:
      typeof options.cacheTtlMs === "number" && options.cacheTtlMs > 0
        ? options.cacheTtlMs
        : DEFAULT_UPDATE_CHECK_CACHE_TTL_MS,
    timeoutMs:
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
    cacheFilePath:
      typeof options.cacheFilePath === "string" && options.cacheFilePath.length > 0
        ? options.cacheFilePath
        : path.join(DEFAULT_LINKEDIN_BUDDY_HOME, UPDATE_CHECK_CACHE_FILENAME)
  };
}

export async function checkForUpdate(
  config: UpdateCheckConfig,
  currentVersion: string
): Promise<UpdateCheckResult> {
  const checkedAt = new Date().toISOString();

  if (!config.enabled) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      updateCommand: "",
      checkedAt,
      cached: false
    };
  }

  try {
    const cache = readUpdateCheckCache(config.cacheFilePath);
    if (cache) {
      const ageMs = Date.now() - Date.parse(cache.checkedAt);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= config.cacheTtlMs) {
        return createResult(currentVersion, cache.latestVersion, cache.checkedAt, true);
      }
    }

    const latestVersion = await fetchLatestVersion(
      UPDATE_CHECK_PACKAGE_NAME,
      config.timeoutMs
    );
    const nextCheckedAt = new Date().toISOString();
    writeUpdateCheckCache(config.cacheFilePath, {
      latestVersion,
      checkedAt: nextCheckedAt
    });
    return createResult(currentVersion, latestVersion, nextCheckedAt, false);
  } catch {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      updateCommand: "",
      checkedAt,
      cached: false
    };
  }
}

export async function fetchLatestVersion(
  packageName: string,
  timeoutMs: number
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/latest`,
      {
        headers: {
          accept: "application/json"
        },
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch (error) {
    if (error instanceof Error && /aborted|timeout/i.test(error.name)) {
      throw new LinkedInBuddyError("TIMEOUT", "Update check timed out.", {
        packageName,
        timeoutMs
      });
    }

    throw new LinkedInBuddyError("NETWORK_ERROR", "Failed to reach npm registry.", {
      packageName
    });
  }

  if (!response.ok) {
    throw new LinkedInBuddyError(
      "NETWORK_ERROR",
      `npm registry returned HTTP ${response.status}.`,
      {
        packageName,
        status: response.status
      }
    );
  }

  try {
    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== "string") {
      throw new Error("Invalid version payload.");
    }
    return payload.version;
  } catch (error) {
    throw new LinkedInBuddyError(
      "NETWORK_ERROR",
      "Invalid npm registry response for latest package metadata.",
      {
        packageName,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

export function readUpdateCheckCache(filePath: string): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      latestVersion?: unknown;
      checkedAt?: unknown;
    };
    if (
      typeof parsed.latestVersion !== "string" ||
      typeof parsed.checkedAt !== "string"
    ) {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      checkedAt: parsed.checkedAt
    };
  } catch {
    return null;
  }
}

export function writeUpdateCheckCache(
  filePath: string,
  cache: UpdateCheckCache
): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    return;
  }
}

export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = normalizeNumericTuple(current);
  const latestParts = normalizeNumericTuple(latest);
  const maxLength = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const currentValue = currentParts[index] ?? 0;
    const latestValue = latestParts[index] ?? 0;
    if (latestValue > currentValue) {
      return true;
    }
    if (latestValue < currentValue) {
      return false;
    }
  }

  return false;
}

export function detectInstallMethod(): InstallMethod {
  const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? "";
  if (userAgent.includes("npx")) {
    return "npx";
  }

  const executablePath = process.argv[1]?.toLowerCase() ?? "";
  const hasNodeModulesPath = executablePath.includes(`${path.sep}node_modules${path.sep}`);
  const hasGlobalPrefix =
    executablePath.includes(`${path.sep}lib${path.sep}node_modules${path.sep}`) ||
    executablePath.includes(`${path.sep}share${path.sep}node_modules${path.sep}`);

  if (hasNodeModulesPath && hasGlobalPrefix) {
    return "global-npm";
  }

  if (hasNodeModulesPath) {
    return "local-npm";
  }

  return "unknown";
}

export function buildUpdateCommand(installMethod: InstallMethod): string {
  if (installMethod === "global-npm") {
    return "npm install -g @linkedin-buddy/cli@latest";
  }
  if (installMethod === "npx") {
    return "npx @linkedin-buddy/cli@latest (always runs latest)";
  }
  if (installMethod === "local-npm") {
    return "npm install @linkedin-buddy/cli@latest";
  }
  return "npm install -g @linkedin-buddy/cli@latest";
}
