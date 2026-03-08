import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_LINKEDIN_SELECTOR_LOCALE,
  LINKEDIN_SELECTOR_LOCALES,
  resolveLinkedInSelectorLocaleResolution,
  type LinkedInSelectorLocaleFallbackReason,
  type LinkedInSelectorLocaleResolution,
  type LinkedInSelectorLocale
} from "./selectorLocale.js";

/**
 * Default directory used for tool-owned state when no custom home is configured.
 */
export const DEFAULT_LINKEDIN_ASSISTANT_HOME = path.join(
  os.homedir(),
  ".linkedin-assistant",
  "linkedin-owa-agentools"
);

/**
 * Resolved on-disk locations for profiles, database state, and run artifacts.
 */
export interface ConfigPaths {
  baseDir: string;
  artifactsDir: string;
  profilesDir: string;
  dbPath: string;
}

/**
 * Default maximum trace size captured for confirm-failure artifacts.
 */
export const DEFAULT_CONFIRM_TRACE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Configures confirm-failure artifact capture limits.
 */
export interface ConfirmFailureArtifactConfig {
  traceMaxBytes: number;
}

/**
 * Environment variable that sets the default selector locale for the current
 * shell or process tree.
 */
export const LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV =
  "LINKEDIN_ASSISTANT_SELECTOR_LOCALE";

/**
 * Indicates where the effective selector-locale value came from.
 */
export type LinkedInSelectorLocaleConfigSource = "default" | "env" | "option";

/**
 * Detailed selector-locale resolution, including precedence source and any
 * fallback diagnostics.
 */
export interface LinkedInSelectorLocaleConfigResolution
  extends LinkedInSelectorLocaleResolution {
  source: LinkedInSelectorLocaleConfigSource;
}

/**
 * Controls whether selector-locale guidance is formatted for runtime logs or
 * end-user CLI output.
 */
export type LinkedInSelectorLocaleConfigWarningContext = "runtime" | "cli";

/**
 * Human-readable guidance for a selector-locale fallback.
 */
export interface LinkedInSelectorLocaleConfigWarning {
  message: string;
  actionTaken: string;
  guidance: string;
  supportedLocales: LinkedInSelectorLocale[];
}

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

/**
 * Resolves the base configuration directories for the current process.
 */
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

/**
 * Ensures the configured state directories exist before the runtime writes to
 * them.
 */
export function ensureConfigPaths(paths: ConfigPaths): void {
  mkdirSync(paths.baseDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  mkdirSync(paths.profilesDir, { recursive: true });
}

/**
 * Resolves artifact capture limits from the environment.
 */
export function resolveConfirmFailureArtifactConfig(): ConfirmFailureArtifactConfig {
  return {
    traceMaxBytes: parsePositiveInteger(
      process.env.LINKEDIN_ASSISTANT_CONFIRM_TRACE_MAX_BYTES,
      DEFAULT_CONFIRM_TRACE_MAX_BYTES
    )
  };
}

/**
 * Resolves the effective selector locale after applying option → env → default
 * precedence.
 */
export function resolveLinkedInSelectorLocaleConfig(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocale {
  return resolveLinkedInSelectorLocaleConfigResolution(selectorLocale).locale;
}

/**
 * Resolves selector-locale config with source and fallback diagnostics.
 *
 * @remarks
 * Explicit `selectorLocale` values win over
 * `LINKEDIN_ASSISTANT_SELECTOR_LOCALE`, which in turn wins over the default
 * English locale.
 */
export function resolveLinkedInSelectorLocaleConfigResolution(
  selectorLocale?: string | LinkedInSelectorLocale
): LinkedInSelectorLocaleConfigResolution {
  const envSelectorLocale = process.env[LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV];
  const source: LinkedInSelectorLocaleConfigSource =
    selectorLocale === undefined
      ? envSelectorLocale === undefined
        ? "default"
        : "env"
      : "option";
  const resolution = resolveLinkedInSelectorLocaleResolution(
    source === "option" ? selectorLocale : envSelectorLocale
  );

  return {
    ...resolution,
    source
  };
}

function formatSelectorLocaleSourceLabel(
  source: LinkedInSelectorLocaleConfigSource,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  if (source === "env") {
    return LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV;
  }

  if (source === "option") {
    return context === "cli" ? "--selector-locale" : "selectorLocale option";
  }

  return "default selector locale";
}

function formatSelectorLocalePreview(
  normalizedInput: string | undefined
): string | null {
  return typeof normalizedInput === "string" && normalizedInput.length > 0
    ? `"${normalizedInput}"`
    : null;
}

function formatSelectorLocaleFallbackMessage(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  const sourceLabel = formatSelectorLocaleSourceLabel(resolution.source, context);
  const localePreview = formatSelectorLocalePreview(resolution.normalizedInput);

  switch (resolution.fallbackReason) {
    case "blank":
      return resolution.source === "env"
        ? `${sourceLabel} was set but blank.`
        : `${sourceLabel} was blank.`;
    case "invalid_format":
      return localePreview
        ? `Invalid selector locale ${localePreview} from ${sourceLabel}.`
        : `Invalid selector locale from ${sourceLabel}.`;
    case "too_long":
      return typeof resolution.inputLength === "number"
        ? `Selector locale from ${sourceLabel} is too long (${resolution.inputLength} characters).`
        : `Selector locale from ${sourceLabel} is too long.`;
    case "unsupported_locale":
    default:
      return localePreview
        ? `Unsupported selector locale ${localePreview} from ${sourceLabel}.`
        : `Unsupported selector locale from ${sourceLabel}.`;
  }
}

function formatSelectorLocaleExamples(
  reason: LinkedInSelectorLocaleFallbackReason | undefined
): string {
  return reason === "unsupported_locale"
    ? `Supported locales: ${LINKEDIN_SELECTOR_LOCALES.join(", ")}.`
    : `Supported locales: ${LINKEDIN_SELECTOR_LOCALES.join(", ")}. Use a locale tag like en, da, or da-DK.`;
}

function formatSelectorLocaleGuidance(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext
): string {
  const supportedLocalesMessage = formatSelectorLocaleExamples(
    resolution.fallbackReason
  );
  const normalizedTagMessage = "Region tags like da-DK normalize to da.";

  if (context === "cli") {
    if (resolution.source === "env") {
      return [
        supportedLocalesMessage,
        normalizedTagMessage,
        `Update ${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV} or override it for one command with --selector-locale <locale>.`
      ].join(" ");
    }

    return [
      supportedLocalesMessage,
      normalizedTagMessage,
      "Pass --selector-locale <locale> or omit the flag to use the default English selectors."
    ].join(" ");
  }

  return [
    supportedLocalesMessage,
    normalizedTagMessage,
    `Pass a supported selectorLocale value or update ${LINKEDIN_ASSISTANT_SELECTOR_LOCALE_ENV}.`
  ].join(" ");
}

function formatSelectorLocaleActionTaken(
  locale: LinkedInSelectorLocale
): string {
  const localeLabel =
    locale === DEFAULT_LINKEDIN_SELECTOR_LOCALE
      ? 'English ("en")'
      : `selector locale "${locale}"`;

  return `Using ${localeLabel} selector phrases for this run.`;
}

/**
 * Builds a human-readable warning when selector-locale config falls back away
 * from the requested input.
 */
export function getLinkedInSelectorLocaleConfigWarning(
  resolution: LinkedInSelectorLocaleConfigResolution,
  context: LinkedInSelectorLocaleConfigWarningContext = "runtime"
): LinkedInSelectorLocaleConfigWarning | null {
  if (!resolution.fallbackUsed || resolution.source === "default") {
    return null;
  }

  return {
    message: formatSelectorLocaleFallbackMessage(resolution, context),
    actionTaken: formatSelectorLocaleActionTaken(resolution.locale),
    guidance: formatSelectorLocaleGuidance(resolution, context),
    supportedLocales: [...LINKEDIN_SELECTOR_LOCALES]
  };
}
