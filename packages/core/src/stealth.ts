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
  // Removes `navigator.webdriver` style Blink automation fingerprints.
  "--disable-blink-features=AutomationControlled",
  // Prevents first-run onboarding UI from exposing fresh automation profiles.
  "--no-first-run",
  // Suppresses default-browser prompts uncommon in active user sessions.
  "--no-default-browser-check",
  // Hides infobars that can reveal controlled-browser state.
  "--disable-infobars",
  // Keeps timer behavior closer to active user browsing patterns.
  "--disable-background-timer-throttling",
  // Avoids occlusion backgrounding heuristics that differ under automation.
  "--disable-backgrounding-occluded-windows",
  // Prevents renderer throttling that can alter page timing fingerprints.
  "--disable-renderer-backgrounding",
  // Disables automation/translate feature surfaces used by bot detectors.
  "--disable-features=AutomationControlled,TranslateUI",
  // Blocks WebRTC local IP leakage that can expose proxy inconsistencies.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  // Enforces WebRTC permission checks to reduce unsolicited network leaks.
  "--enforce-webrtc-ip-permission-check",
  // Uses realistic desktop dimensions instead of headless-like defaults.
  "--window-size=1440,900",
  // Keeps GPU backend selection aligned with typical desktop Chrome stacks.
  "--use-gl=angle",
  // Uses default ANGLE backend to avoid unusual renderer fingerprints.
  "--use-angle=default",
  // Disables crash handler initialization often absent in real sessions.
  "--disable-breakpad",
  // Prevents automated crash uploads that can signal non-user execution.
  "--no-crash-upload",
  // Avoids sync enrollment flows that can look synthetic in automation.
  "--disable-sync",
  // Removes translation prompt surfaces often disabled by real users.
  "--disable-translate",
];

/**
 * Default Chromium arguments that Playwright adds which leak automation
 * signals. These are removed via `ignoreDefaultArgs` when stealth is active.
 */
const IGNORED_DEFAULT_ARGS: readonly string[] = [
  // Removes the canonical Chrome automation switch exposed by WebDriver checks.
  "--enable-automation",
  // Restores extension behavior closer to normal user Chrome profiles.
  "--disable-extensions",
  // Avoids startup behavior tied to stripped-down automation shells.
  "--disable-default-apps",
  // Prevents disabling component updates in a way atypical for real users.
  "--disable-component-update",
  // Avoids suppressing component background pages used in real browsers.
  "--disable-component-extensions-with-background-pages",
  // Prevents disabling phishing detection, which is suspicious at scale.
  "--disable-client-side-phishing-detection",
  // Preserves default popup protections expected in standard Chrome sessions.
  "--disable-popup-blocking",
  // Avoids metrics-only mode tied to controlled automation environments.
  "--metrics-recording-only",
  // Removes synthetic input scheduling flag uncommon in user launches.
  "--allow-pre-commit-input",
  // Avoids disabled IPC flood protection that differs from consumer Chrome.
  "--disable-ipc-flooding-protection",
  // Removes devtools self-XSS suppression flag associated with automation.
  "--unsafely-disable-devtools-self-xss-warnings",
  // Preserves default BFCache behavior to match real-world navigation traces.
  "--disable-back-forward-cache",
];

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

  const primaryLocale = config.locale;
  const shortLocale = primaryLocale.split("-")[0];

  // Uses realistic language negotiation order and q-values for Chrome requests.
  await context
    .setExtraHTTPHeaders({
      "Accept-Language": `${primaryLocale},${shortLocale};q=0.9,en;q=0.8`,
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
