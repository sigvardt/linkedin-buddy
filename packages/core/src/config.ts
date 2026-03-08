import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  resolveLinkedInSelectorLocale,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";

export const DEFAULT_LINKEDIN_ASSISTANT_HOME = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "linkedin-owa-agentools"
);

export interface ConfigPaths {
  baseDir: string;
  artifactsDir: string;
  profilesDir: string;
  dbPath: string;
}

export const DEFAULT_CONFIRM_TRACE_MAX_BYTES = 25 * 1024 * 1024;

export interface ConfirmFailureArtifactConfig {
  traceMaxBytes: number;
}

export const LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV =
  "LINKEDIN_ASSISTANT_SELECTOR_LOCALE";

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function resolveConfigPaths(baseDir?: string): ConfigPaths {
  const resolvedBaseDir =
    baseDir ??
    process.env.LINKEDIN_ASSISTANT_HOME ??
    DEFAULT_LINKEDIN_ASSISTANT_HOME;

  return {
    baseDir: resolvedBaseDir,
    artifactsDir: path.join(resolvedBaseDir, "artifacts"),
    profilesDir: path.join(resolvedBaseDir, "profiles"),
    dbPath: path.join(resolvedBaseDir, "state.sqlite")
  };
}

export function ensureConfigPaths(paths: ConfigPaths): void {
  mkdirSync(paths.baseDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.profilesDir, { recursive: true });
}

export function resolveConfirmFailureArtifactConfig(): ConfirmFailureArtifactConfig {
  return {
    traceMaxBytes: parsePositiveInteger(
      process.env.LINKEDIN_ASSISTANT_CONFIRM_TRACE_MAX_BYTES,
      DEFAULT_CONFIRM_TRACE_MAX_BYTES
    )
  };
}

export function resolveLinkedInSelectorLocaleConfig(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocale {
  return resolveLinkedInSelectorLocale(
    selectorLocale ?? process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV],
    DEFAULT_LINKEDIN_SELECTOR_LOCALE
  );
}
