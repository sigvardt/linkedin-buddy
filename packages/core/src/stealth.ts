/**
 * Stealth browser launcher that wraps Playwright's chromium with the
 * `playwright-extra` + `puppeteer-extra-plugin-stealth` plugin chain.
 *
 * When stealth is enabled (the default for `moderate` and `paranoid` evasion
 * levels), the launcher applies 14+ detection-evasion patches before any page
 * JavaScript executes: WebGL vendor spoofing, navigator.plugins emulation,
 * chrome.runtime mocking, user-agent override, and more.
 *
 * When stealth is disabled (`minimal` evasion level or explicit opt-out), the
 * module returns the bare `playwright-core` chromium launcher unchanged.
 *
 * @module
 */
import { chromium as bareChromium, type BrowserContext } from "playwright-core";
import type { EvasionLevel } from "./evasion/types.js";

type BrowserType = typeof bareChromium;
type PersistentLaunchOptions = NonNullable<
  Parameters<BrowserType["launchPersistentContext"]>[1]
>;

/**
 * Environment variable that disables the stealth plugin entirely when set to a
 * falsy value. Overrides the evasion-level default.
 *
 * @example
 * ```bash
 * LINKEDIN_BUDDY_STEALTH_ENABLED=false linkedin login
 * ```
 */
export const LINKEDIN_BUDDY_STEALTH_ENABLED_ENV =
  "LINKEDIN_BUDDY_STEALTH_ENABLED";

/**
 * Environment variable that sets the browser locale for stealth sessions.
 * Defaults to `"en-US"`.
 */
export const LINKEDIN_BUDDY_LOCALE_ENV = "LINKEDIN_BUDDY_LOCALE";

/**
 * Environment variable that sets the browser timezone for stealth sessions.
 * Defaults to `"America/New_York"`.
 */
export const LINKEDIN_BUDDY_TIMEZONE_ENV = "LINKEDIN_BUDDY_TIMEZONE";

/**
 * Environment variable that enables the headed-mode fallback when a CAPTCHA
 * checkpoint is detected during headless login.
 */
export const LINKEDIN_BUDDY_HEADED_FALLBACK_ENV =
  "LINKEDIN_BUDDY_HEADED_FALLBACK";

/** Default browser viewport for stealth sessions (common 1440p laptop). */
const DEFAULT_STEALTH_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DEFAULT_STEALTH_LOCALE = "en-US";
const DEFAULT_STEALTH_TIMEZONE = "America/New_York";

/**
 * Chrome launch arguments that reduce automation fingerprinting without
 * breaking normal browser operation.
 */
const STEALTH_LAUNCH_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
];

/**
 * Default Chromium arguments that Playwright adds which leak automation
 * signals. These are removed via `ignoreDefaultArgs` when stealth is active.
 */
const IGNORED_DEFAULT_ARGS: readonly string[] = ["--enable-automation"];

/** Parsed stealth configuration. */
export interface StealthConfig {
  /** Whether the stealth plugin is active. */
  enabled: boolean;
  /** Browser locale (e.g. `"en-US"`). */
  locale: string;
  /** IANA timezone (e.g. `"America/New_York"`). */
  timezone: string;
  /** Whether to retry login in headed mode when a CAPTCHA is detected. */
  headedFallback: boolean;
}

/**
 * Resolves the stealth configuration from the evasion level and environment
 * variables.
 *
 * - `minimal` → stealth disabled by default.
 * - `moderate` / `paranoid` → stealth enabled by default.
 * - `LINKEDIN_BUDDY_STEALTH_ENABLED` overrides the level-based default.
 */
export function resolveStealthConfig(
  evasionLevel: EvasionLevel = "moderate",
): StealthConfig {
  const envEnabled = process.env[LINKEDIN_BUDDY_STEALTH_ENABLED_ENV];
  const enabled =
    typeof envEnabled === "string" && envEnabled.trim().length > 0
      ? isTruthyString(envEnabled)
      : evasionLevel !== "minimal";
  const locale =
    process.env[LINKEDIN_BUDDY_LOCALE_ENV]?.trim() || DEFAULT_STEALTH_LOCALE;
  const timezone =
    process.env[LINKEDIN_BUDDY_TIMEZONE_ENV]?.trim() ||
    DEFAULT_STEALTH_TIMEZONE;
  const headedFallback = isTruthyString(
    process.env[LINKEDIN_BUDDY_HEADED_FALLBACK_ENV] ?? "",
  );

  return { enabled, locale, timezone, headedFallback };
}

/**
 * Returns a chromium browser type with the stealth plugin applied when
 * `config.enabled` is `true`. Returns the bare `playwright-core` chromium
 * unchanged when stealth is disabled.
 *
 * Uses the non-singleton `addExtra()` approach so multiple callers can
 * coexist safely.
 */
export async function createStealthChromium(
  config: StealthConfig,
): Promise<BrowserType> {
  if (!config.enabled) {
    return bareChromium;
  }

  const { addExtra } = await import("playwright-extra");
  const { default: StealthPlugin } =
    await import("puppeteer-extra-plugin-stealth");

  const stealthChromium = addExtra(bareChromium);
  stealthChromium.use(StealthPlugin());

  return stealthChromium as unknown as BrowserType;
}

/**
 * Merges stealth-specific launch options into existing persistent context
 * options. Does not mutate the input.
 */
export function applyStealthLaunchOptions(
  baseOptions: PersistentLaunchOptions,
  config: StealthConfig,
): PersistentLaunchOptions {
  if (!config.enabled) {
    return baseOptions;
  }

  const existingArgs = Array.isArray(baseOptions.args) ? baseOptions.args : [];
  const existingIgnored = Array.isArray(baseOptions.ignoreDefaultArgs)
    ? baseOptions.ignoreDefaultArgs
    : [];

  const mergedArgs = dedupeStrings([...existingArgs, ...STEALTH_LAUNCH_ARGS]);
  const mergedIgnored = dedupeStrings([
    ...existingIgnored,
    ...IGNORED_DEFAULT_ARGS,
  ]);

  return {
    ...baseOptions,
    args: mergedArgs,
    ignoreDefaultArgs: mergedIgnored,
    locale: baseOptions.locale ?? config.locale,
    timezoneId: baseOptions.timezoneId ?? config.timezone,
    viewport: baseOptions.viewport ?? DEFAULT_STEALTH_VIEWPORT,
    colorScheme: baseOptions.colorScheme ?? "light",
    deviceScaleFactor: baseOptions.deviceScaleFactor ?? 1,
  };
}

/**
 * Applies additional stealth hardening to a browser context after launch.
 * This supplements the stealth plugin with LinkedIn-specific patches that
 * the plugin does not cover.
 */
export async function hardenBrowserContext(
  context: BrowserContext,
  config: StealthConfig,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Set extra HTTP headers that real browsers send but headless often omits.
  await context
    .setExtraHTTPHeaders({
      "Accept-Language": `${config.locale},${config.locale.split("-")[0]};q=0.9`,
    })
    .catch(() => undefined);
}

function isTruthyString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
