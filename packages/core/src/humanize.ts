import type { Locator, Page } from "playwright-core";
import { isRecord } from "./shared.js";

const QWERTY_KEYBOARD_ROWS = [
  "1234567890",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
] as const;
const QWERTY_ROW_OFFSETS = [0, 0.5, 0.85, 1.35] as const;
const ADJACENCY_HORIZONTAL_THRESHOLD = 1.1;
const ADJACENCY_VERTICAL_THRESHOLD = 1.05;
const DIRECT_INPUT_TIMEOUT_MS = 10_000;
const FAST_TYPING_TIMEOUT_MS = 20_000;
const HUMANIZE_LOGGER_KEY = "__linkedinAssistantLogger";
const HUMANIZE_LOGGER_BY_PAGE = new WeakMap<object, LoggerLike>();
const MAX_HUMANIZED_DELAY_MS = 10_000;
const MAX_HUMANIZED_MULTIPLIER = 10;
const MAX_MOUSE_COORDINATE_ABS = 100_000;
const MAX_SCROLL_DISTANCE_PX = 20_000;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_SIMULATED_TYPING_GRAPHEMES = 500;
const MAX_TEXT_GRAPHEMES = 20_000;
const MAX_TYPING_TIMEOUT_MS = 60_000;
const MAX_URL_LENGTH = 8_192;
const MIN_TYPING_TIMEOUT_MS = 5_000;
const COMMON_BURST_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "the",
  "to",
  "we",
  "you",
]);

const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Keyboard-hand metadata attached to nearby-key typo candidates.
 */
export type KeyboardHand = "left" | "right";

/**
 * Finger metadata for a normalized QWERTY key.
 */
export type KeyboardFinger =
  | "left-pinky"
  | "left-ring"
  | "left-middle"
  | "left-index"
  | "right-index"
  | "right-middle"
  | "right-ring"
  | "right-pinky";

/**
 * Inclusive millisecond range sampled for pause-like typing behavior.
 */
export interface DelayRange {
  /** Minimum sampled delay in milliseconds. */
  minMs: number;
  /** Maximum sampled delay in milliseconds. */
  maxMs: number;
}

/**
 * Built-in typing presets shipped with the simulation layer.
 */
export type TypingProfileName = "casual" | "careful" | "fast";

/**
 * Tunable typing profile used to simulate realistic text entry.
 */
export interface TypingProfile {
  /** Probability in `[0, 1]` of typing a nearby-key typo before correcting it. */
  typoRate: number;
  /** Probability in `[0, 1]` of briefly overshooting a correction by one backspace. */
  doubleBackspaceRate: number;
  /** Probability in `[0, 1]` of missing `Shift` on the first attempt for uppercase letters. */
  shiftMissRate: number;
  /** Baseline delay before each typed character. */
  baseCharDelayMs: number;
  /** Additional random jitter added to each per-character delay. */
  charDelayJitterMs: number;
  /** Multiplier applied to characters in the middle of a word. */
  midWordMultiplier: number;
  /** Multiplier applied to characters at the start or end of a word. */
  wordBoundaryMultiplier: number;
  /** Multiplier applied to whitespace characters. */
  whitespaceMultiplier: number;
  /** Multiplier applied to punctuation and other non-word characters. */
  punctuationMultiplier: number;
  /** Multiplier applied to short common “burst” words such as `the` or `and`. */
  burstWordMultiplier: number;
  /** Multiplier applied to repeated characters such as the second `l` in `hello`. */
  repeatedCharacterMultiplier: number;
  /** Probability in `[0, 1]` of a short thinking pause before a new word. */
  thinkingPauseChance: number;
  /** Delay range used for short thinking pauses. */
  thinkingPauseRange: DelayRange;
  /** Probability in `[0, 1]` of a longer pause near sentence restarts. */
  longPauseChance: number;
  /** Delay range used for longer reflective pauses. */
  longPauseRange: DelayRange;
  /** Delay range between a typo and the corrective backspace. */
  correctionPauseRange: DelayRange;
  /** Delay range between correcting a typo and resuming forward typing. */
  correctionResumeRange: DelayRange;
  /** Delay range between pressing `Shift` and the uppercase character key. */
  shiftLeadRange: DelayRange;
}

/**
 * Default configuration for `humanize()` and `HumanizedPage`.
 *
 * Typing profile resolution order is:
 * 1. the named preset from `typingProfile`
 * 2. constructor-level `typingDelay` / `typingJitter` overrides
 * 3. constructor-level `typingProfileOverrides`
 * 4. per-call `HumanizedTypingOptions.profileOverrides`
 */
export interface HumanizeOptions {
  /** Base delay between non-typing actions in milliseconds. Defaults to `800`. */
  baseDelay?: number;
  /** Maximum random jitter added to non-typing delays. Defaults to `1500`. */
  jitterRange?: number;
  /** Whether to shorten default delays for faster development and validation flows. */
  fast?: boolean;
  /** Legacy override for `baseCharDelayMs` applied after the chosen preset. */
  typingDelay?: number;
  /** Legacy override for `charDelayJitterMs` applied after the chosen preset. */
  typingJitter?: number;
  /** Default typing preset used when `HumanizedPage.type()` does not pass `profile`. */
  typingProfile?: TypingProfileName;
  /** Default partial override merged into the resolved typing profile. */
  typingProfileOverrides?: Partial<TypingProfile>;
}

/**
 * Per-call overrides for `HumanizedPage.type()`.
 */
export interface HumanizedTypingOptions {
  /** Typing preset to use for this call instead of the constructor default. */
  profile?: TypingProfileName;
  /** Additional one-off overrides merged after the resolved preset and constructor defaults. */
  profileOverrides?: Partial<TypingProfile>;
  /** Optional field label used in diagnostics and progress output. */
  fieldLabel?: string;
  /** Optional per-call timeout applied to element targeting and direct input fallbacks. */
  timeoutMs?: number;
}

/**
 * Weighted nearby-key typo candidate for a single normalized character.
 */
export interface AdjacentTypoCandidate {
  /** Candidate character that could be mistyped. */
  key: string;
  /** Relative sampling weight for this candidate. */
  weight: number;
  /** Keyboard hand usually responsible for this candidate key. */
  hand: KeyboardHand;
  /** Keyboard finger usually responsible for this candidate key. */
  finger: KeyboardFinger;
}

/**
 * Severity labels used by the humanize logger interface.
 */
export type HumanizeLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured logger interface for `humanize.*` lifecycle events.
 */
export interface HumanizeLogger {
  /** Emit one humanize event. */
  log(
    level: HumanizeLogLevel,
    event: string,
    payload?: Record<string, unknown>,
  ): void;
}

interface ResolvedHumanizeOptions {
  baseDelay: number;
  jitterRange: number;
  fast: boolean;
  typingProfile: TypingProfileName;
  typingDelayOverride: number | null;
  typingJitterOverride: number | null;
  typingProfileOverrides: Partial<TypingProfile>;
}

interface KeyboardKeyGeometry {
  key: string;
  x: number;
  y: number;
  hand: KeyboardHand;
  finger: KeyboardFinger;
}

interface TypingContext {
  previousMeaningful: string | null;
  isBurstWord: boolean;
  isRepeatedCharacter: boolean;
  isSentenceRestart: boolean;
  isWhitespace: boolean;
  isWordCharacter: boolean;
  isWordEnd: boolean;
  isWordStart: boolean;
}

type LoggerLike = HumanizeLogger;

interface TypingSimulationState {
  consumedDelayMs: number;
  maxDurationMs: number;
  shiftPressed: boolean;
  timedOut: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

class HumanizeTypingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanizeTypingTimeoutError";
  }
}

const KEY_FINGER_BY_CHARACTER = {
  "1": "left-pinky",
  "2": "left-ring",
  "3": "left-middle",
  "4": "left-index",
  "5": "left-index",
  "6": "right-index",
  "7": "right-index",
  "8": "right-middle",
  "9": "right-ring",
  "0": "right-pinky",
  q: "left-pinky",
  w: "left-ring",
  e: "left-middle",
  r: "left-index",
  t: "left-index",
  y: "right-index",
  u: "right-index",
  i: "right-middle",
  o: "right-ring",
  p: "right-pinky",
  a: "left-pinky",
  s: "left-ring",
  d: "left-middle",
  f: "left-index",
  g: "left-index",
  h: "right-index",
  j: "right-index",
  k: "right-middle",
  l: "right-ring",
  z: "left-pinky",
  x: "left-ring",
  c: "left-middle",
  v: "left-index",
  b: "left-index",
  n: "right-index",
  m: "right-index",
} as const satisfies Record<string, KeyboardFinger>;

/**
 * Built-in typing presets for common operator workflows.
 *
 * - `careful` is the default and favors accuracy over speed.
 * - `casual` adds more pauses, jitter, and typo/correction loops.
 * - `fast` reduces delays for short flows and local validation.
 */
export const TYPING_PROFILES = {
  casual: {
    typoRate: 0.04,
    doubleBackspaceRate: 0.08,
    shiftMissRate: 0.02,
    baseCharDelayMs: 85,
    charDelayJitterMs: 95,
    midWordMultiplier: 0.82,
    wordBoundaryMultiplier: 1.35,
    whitespaceMultiplier: 1.4,
    punctuationMultiplier: 1.5,
    burstWordMultiplier: 0.72,
    repeatedCharacterMultiplier: 0.78,
    thinkingPauseChance: 0.18,
    thinkingPauseRange: { minMs: 300, maxMs: 1500 },
    longPauseChance: 0.03,
    longPauseRange: { minMs: 2000, maxMs: 5000 },
    correctionPauseRange: { minMs: 60, maxMs: 220 },
    correctionResumeRange: { minMs: 40, maxMs: 160 },
    shiftLeadRange: { minMs: 20, maxMs: 70 },
  },
  careful: {
    typoRate: 0.018,
    doubleBackspaceRate: 0.03,
    shiftMissRate: 0.005,
    baseCharDelayMs: 95,
    charDelayJitterMs: 55,
    midWordMultiplier: 0.9,
    wordBoundaryMultiplier: 1.18,
    whitespaceMultiplier: 1.25,
    punctuationMultiplier: 1.35,
    burstWordMultiplier: 0.82,
    repeatedCharacterMultiplier: 0.9,
    thinkingPauseChance: 0.08,
    thinkingPauseRange: { minMs: 250, maxMs: 900 },
    longPauseChance: 0.01,
    longPauseRange: { minMs: 1800, maxMs: 3200 },
    correctionPauseRange: { minMs: 70, maxMs: 170 },
    correctionResumeRange: { minMs: 50, maxMs: 120 },
    shiftLeadRange: { minMs: 25, maxMs: 60 },
  },
  fast: {
    typoRate: 0.025,
    doubleBackspaceRate: 0.05,
    shiftMissRate: 0.01,
    baseCharDelayMs: 45,
    charDelayJitterMs: 25,
    midWordMultiplier: 0.74,
    wordBoundaryMultiplier: 1.1,
    whitespaceMultiplier: 1.12,
    punctuationMultiplier: 1.2,
    burstWordMultiplier: 0.58,
    repeatedCharacterMultiplier: 0.7,
    thinkingPauseChance: 0.04,
    thinkingPauseRange: { minMs: 180, maxMs: 450 },
    longPauseChance: 0.004,
    longPauseRange: { minMs: 2000, maxMs: 3500 },
    correctionPauseRange: { minMs: 50, maxMs: 120 },
    correctionResumeRange: { minMs: 30, maxMs: 100 },
    shiftLeadRange: { minMs: 15, maxMs: 40 },
  },
} satisfies Record<TypingProfileName, TypingProfile>;

const TYPING_PROFILE_NAMES = Object.keys(
  TYPING_PROFILES,
) as TypingProfileName[];
const DELAY_RANGE_KEYS = ["minMs", "maxMs"] as const;
const HUMANIZE_OPTION_KEYS = [
  "baseDelay",
  "fast",
  "jitterRange",
  "typingDelay",
  "typingJitter",
  "typingProfile",
  "typingProfileOverrides",
] as const;
const HUMANIZED_TYPING_OPTION_KEYS = [
  "fieldLabel",
  "profile",
  "profileOverrides",
  "timeoutMs",
] as const;
const TYPING_PROFILE_OVERRIDE_KEYS = [
  "baseCharDelayMs",
  "burstWordMultiplier",
  "charDelayJitterMs",
  "correctionPauseRange",
  "correctionResumeRange",
  "doubleBackspaceRate",
  "longPauseChance",
  "longPauseRange",
  "midWordMultiplier",
  "punctuationMultiplier",
  "repeatedCharacterMultiplier",
  "shiftLeadRange",
  "shiftMissRate",
  "thinkingPauseChance",
  "thinkingPauseRange",
  "typoRate",
  "whitespaceMultiplier",
  "wordBoundaryMultiplier",
] as const;

function computeLevenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from(
    { length: right.length + 1 },
    (_unused, index) => index,
  );
  const current = new Array<number>(right.length + 1).fill(0);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    const leftCharacter = left[leftIndex] ?? "";

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightCharacter = right[rightIndex] ?? "";
      const substitutionCost = leftCharacter === rightCharacter ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        (current[rightIndex] ?? 0) + 1,
        (previous[rightIndex + 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + substitutionCost,
      );
    }

    for (let index = 0; index < current.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? right.length;
}

function findSuggestedKey(
  unexpectedKey: string,
  allowedKeys: readonly string[],
): string | null {
  const normalizedUnexpectedKey = unexpectedKey.trim().toLowerCase();
  if (normalizedUnexpectedKey.length === 0) {
    return null;
  }

  let bestMatch: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPrefixMatch: {
    key: string;
    prefixLength: number;
    distance: number;
  } | null = null;

  for (const allowedKey of allowedKeys) {
    const normalizedAllowedKey = allowedKey.toLowerCase();
    if (normalizedAllowedKey === normalizedUnexpectedKey) {
      return allowedKey;
    }

    if (
      normalizedAllowedKey.startsWith(normalizedUnexpectedKey) ||
      normalizedUnexpectedKey.startsWith(normalizedAllowedKey)
    ) {
      return allowedKey;
    }

    const maxPrefixLength = Math.min(
      normalizedUnexpectedKey.length,
      normalizedAllowedKey.length,
    );
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < maxPrefixLength &&
      normalizedUnexpectedKey[commonPrefixLength] ===
        normalizedAllowedKey[commonPrefixLength]
    ) {
      commonPrefixLength += 1;
    }

    const distance = computeLevenshteinDistance(
      normalizedUnexpectedKey,
      normalizedAllowedKey,
    );
    if (
      commonPrefixLength >= 4 &&
      (bestPrefixMatch === null ||
        commonPrefixLength > bestPrefixMatch.prefixLength ||
        (commonPrefixLength === bestPrefixMatch.prefixLength &&
          distance < bestPrefixMatch.distance))
    ) {
      bestPrefixMatch = {
        key: allowedKey,
        prefixLength: commonPrefixLength,
        distance,
      };
    }

    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = allowedKey;
    }
  }

  if (bestPrefixMatch) {
    return bestPrefixMatch.key;
  }

  const maxDistance = normalizedUnexpectedKey.length <= 6 ? 2 : 3;
  return bestDistance <= maxDistance ? bestMatch : null;
}

function assertNoUnexpectedKeys(
  value: Record<string, unknown>,
  name: string,
  allowedKeys: readonly string[],
): void {
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKeys.length === 0) {
    return;
  }

  const [unexpectedKey = ""] = unexpectedKeys;
  const suggestion = findSuggestedKey(unexpectedKey, allowedKeys);
  throw new TypeError(
    suggestion
      ? `${name} has unsupported key "${unexpectedKey}". Did you mean "${suggestion}"? Supported keys: ${allowedKeys.join(", ")}.`
      : `${name} has unsupported key "${unexpectedKey}". Supported keys: ${allowedKeys.join(", ")}.`,
  );
}

function normalizeFieldLabel(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function describeTypingFallbackReason(reason: string): string {
  switch (reason) {
    case "text_too_long":
      return `Simulated typing is capped at ${MAX_SIMULATED_TYPING_GRAPHEMES} graphemes per field.`;
    case "timeout":
      return "Simulated typing exceeded the per-field safety budget.";
    case "simulation_failed":
      return "LinkedIn or Playwright interrupted simulated keystrokes.";
    default:
      return "Simulated typing could not continue.";
  }
}

function suggestTypingFallbackAction(reason: string): string {
  switch (reason) {
    case "text_too_long":
      return "Use shorter inputs to keep full keystroke simulation, or allow the direct-input fallback for long text.";
    case "timeout":
    case "simulation_failed":
      return "Retry once. If it repeats, inspect the input selector or recent LinkedIn UI changes around that field.";
    default:
      return "Retry once and inspect the target field if the problem persists.";
  }
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    value: String(error),
  };
}

function getPageLogger(page: Page): LoggerLike | null {
  const weakMapLogger = HUMANIZE_LOGGER_BY_PAGE.get(page as object);
  if (weakMapLogger) {
    return weakMapLogger;
  }

  const logger = Reflect.get(page as object, HUMANIZE_LOGGER_KEY);
  if (!isRecord(logger) || typeof logger.log !== "function") {
    return null;
  }

  return logger as unknown as LoggerLike;
}

/**
 * Attach a structured logger that receives `humanize.*` lifecycle events for `page`.
 */
export function attachHumanizeLogger(page: Page, logger: HumanizeLogger): void {
  HUMANIZE_LOGGER_BY_PAGE.set(page as object, logger);
}

/**
 * Remove a previously attached humanize logger from `page`.
 */
export function detachHumanizeLogger(page: Page): void {
  HUMANIZE_LOGGER_BY_PAGE.delete(page as object);
  Reflect.deleteProperty(page as object, HUMANIZE_LOGGER_KEY);
}

function logHumanizeEvent(
  page: Page,
  level: HumanizeLogLevel,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const logger = getPageLogger(page);
  if (logger) {
    logger.log(level, event, payload);
    return;
  }

  const consoleMethod =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;

  consoleMethod(
    JSON.stringify({
      component: "humanize",
      event,
      level,
      payload,
      ts: new Date().toISOString(),
    }),
  );
}

function assertNonNegativeFiniteNumber(
  value: unknown,
  name: string,
  options?: { max?: number },
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }

  if (value < 0) {
    throw new RangeError(`${name} must be greater than or equal to 0.`);
  }

  if (options?.max !== undefined && value > options.max) {
    throw new RangeError(
      `${name} must be less than or equal to ${options.max}.`,
    );
  }
}

function assertNumberInRange(
  value: unknown,
  name: string,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }

  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}.`);
  }
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean.`);
  }
}

function assertString(
  value: unknown,
  name: string,
  options?: { allowEmpty?: boolean; maxLength?: number },
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }

  if (!options?.allowEmpty && value.trim().length === 0) {
    throw new RangeError(`${name} must not be empty.`);
  }

  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new RangeError(
      `${name} must be at most ${options.maxLength} characters long.`,
    );
  }
}

function validateDelayRangeValue(value: unknown, name: string): void {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object with minMs and maxMs.`);
  }

  assertNoUnexpectedKeys(value, name, DELAY_RANGE_KEYS);

  const minMs = value.minMs;
  const maxMs = value.maxMs;
  assertNonNegativeFiniteNumber(minMs, `${name}.minMs`, {
    max: MAX_HUMANIZED_DELAY_MS,
  });
  assertNonNegativeFiniteNumber(maxMs, `${name}.maxMs`, {
    max: MAX_HUMANIZED_DELAY_MS,
  });

  if (minMs > maxMs) {
    throw new RangeError(
      `${name}.minMs must be less than or equal to ${name}.maxMs.`,
    );
  }
}

function validateTypingProfileOverrides(
  value: unknown,
  name: string,
): asserts value is Partial<TypingProfile> {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an object.`);
  }

  assertNoUnexpectedKeys(value, name, TYPING_PROFILE_OVERRIDE_KEYS);

  const chanceKeys = [
    "doubleBackspaceRate",
    "longPauseChance",
    "shiftMissRate",
    "thinkingPauseChance",
    "typoRate",
  ] as const;
  for (const key of chanceKeys) {
    const entry = value[key];
    if (entry !== undefined) {
      assertNumberInRange(entry, `${name}.${key}`, 0, 1);
    }
  }

  const delayKeys = ["baseCharDelayMs", "charDelayJitterMs"] as const;
  for (const key of delayKeys) {
    const entry = value[key];
    if (entry !== undefined) {
      assertNonNegativeFiniteNumber(entry, `${name}.${key}`, {
        max: MAX_HUMANIZED_DELAY_MS,
      });
    }
  }

  const multiplierKeys = [
    "burstWordMultiplier",
    "midWordMultiplier",
    "punctuationMultiplier",
    "repeatedCharacterMultiplier",
    "whitespaceMultiplier",
    "wordBoundaryMultiplier",
  ] as const;
  for (const key of multiplierKeys) {
    const entry = value[key];
    if (entry !== undefined) {
      assertNonNegativeFiniteNumber(entry, `${name}.${key}`, {
        max: MAX_HUMANIZED_MULTIPLIER,
      });
    }
  }

  const rangeKeys = [
    "correctionPauseRange",
    "correctionResumeRange",
    "longPauseRange",
    "shiftLeadRange",
    "thinkingPauseRange",
  ] as const;
  for (const key of rangeKeys) {
    const entry = value[key];
    if (entry !== undefined) {
      validateDelayRangeValue(entry, `${name}.${key}`);
    }
  }
}

function validateHumanizeOptionsValue(
  options: unknown,
): asserts options is HumanizeOptions {
  if (options === undefined) {
    return;
  }

  if (!isRecord(options)) {
    throw new TypeError("options must be an object.");
  }

  assertNoUnexpectedKeys(options, "options", HUMANIZE_OPTION_KEYS);

  if (options.baseDelay !== undefined) {
    assertNonNegativeFiniteNumber(options.baseDelay, "options.baseDelay", {
      max: MAX_HUMANIZED_DELAY_MS,
    });
  }

  if (options.fast !== undefined) {
    assertBoolean(options.fast, "options.fast");
  }

  if (options.jitterRange !== undefined) {
    assertNonNegativeFiniteNumber(options.jitterRange, "options.jitterRange", {
      max: MAX_HUMANIZED_DELAY_MS,
    });
  }

  if (options.typingDelay !== undefined) {
    assertNonNegativeFiniteNumber(options.typingDelay, "options.typingDelay", {
      max: MAX_HUMANIZED_DELAY_MS,
    });
  }

  if (options.typingJitter !== undefined) {
    assertNonNegativeFiniteNumber(
      options.typingJitter,
      "options.typingJitter",
      {
        max: MAX_HUMANIZED_DELAY_MS,
      },
    );
  }

  if (
    options.typingProfile !== undefined &&
    (typeof options.typingProfile !== "string" ||
      !TYPING_PROFILE_NAMES.includes(
        options.typingProfile as TypingProfileName,
      ))
  ) {
    throw new RangeError(
      `options.typingProfile must be one of: ${TYPING_PROFILE_NAMES.join(", ")}. Omit it to use the default "careful" profile, or use "fast" for shorter waits in tests.`,
    );
  }

  validateTypingProfileOverrides(
    options.typingProfileOverrides,
    "options.typingProfileOverrides",
  );
}

function validateHumanizedTypingOptionsValue(
  options: unknown,
): asserts options is HumanizedTypingOptions {
  if (options === undefined) {
    return;
  }

  if (!isRecord(options)) {
    throw new TypeError("typing options must be an object.");
  }

  assertNoUnexpectedKeys(
    options,
    "typing options",
    HUMANIZED_TYPING_OPTION_KEYS,
  );

  if (options.fieldLabel !== undefined) {
    assertString(options.fieldLabel, "typing options.fieldLabel", {
      maxLength: 80,
    });
  }

  if (
    options.profile !== undefined &&
    (typeof options.profile !== "string" ||
      !TYPING_PROFILE_NAMES.includes(options.profile as TypingProfileName))
  ) {
    throw new RangeError(
      `typing options.profile must be one of: ${TYPING_PROFILE_NAMES.join(", ")}. Omit it to inherit the page default typing profile.`,
    );
  }

  validateTypingProfileOverrides(
    options.profileOverrides,
    "typing options.profileOverrides",
  );

  if (options.timeoutMs !== undefined) {
    assertNonNegativeFiniteNumber(
      options.timeoutMs,
      "typing options.timeoutMs",
      {
        max: MAX_TYPING_TIMEOUT_MS,
      },
    );
  }
}

function assertPageLike(page: unknown): asserts page is Page {
  if (!isRecord(page)) {
    throw new TypeError("page must be a Playwright Page instance.");
  }

  const requiredFunctions = [
    "evaluate",
    "goto",
    "locator",
    "waitForLoadState",
    "waitForTimeout",
  ] as const;
  for (const key of requiredFunctions) {
    if (typeof page[key] !== "function") {
      throw new TypeError("page must be a Playwright Page instance.");
    }
  }

  if (!isRecord(page.keyboard) || !isRecord(page.mouse)) {
    throw new TypeError("page must provide keyboard and mouse controls.");
  }

  const keyboardFunctions = ["down", "press", "type", "up"] as const;
  for (const key of keyboardFunctions) {
    if (typeof page.keyboard[key] !== "function") {
      throw new TypeError(`page.keyboard.${key} must be a function.`);
    }
  }

  if (typeof page.mouse.move !== "function") {
    throw new TypeError("page.mouse.move must be a function.");
  }
}

function assertLocatorLike(locator: unknown): asserts locator is Locator {
  if (!isRecord(locator)) {
    throw new TypeError("locator must be a Playwright Locator instance.");
  }

  const requiredFunctions = ["click", "scrollIntoViewIfNeeded"] as const;

  for (const key of requiredFunctions) {
    if (typeof locator[key] !== "function") {
      throw new TypeError("locator must be a Playwright Locator instance.");
    }
  }
}

function splitTypingCharacters(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  if (GRAPHEME_SEGMENTER === null) {
    return Array.from(text);
  }

  return Array.from(
    GRAPHEME_SEGMENTER.segment(text),
    (segment) => segment.segment,
  );
}

function containsUnicodeCharacters(text: string): boolean {
  return Array.from(text).some(
    (character) => (character.codePointAt(0) ?? 0) > 0x7f,
  );
}

function buildTypingLogPayload(
  text: string,
  characters: readonly string[],
): Record<string, unknown> {
  return {
    containsEmoji: /\p{Extended_Pictographic}/u.test(text),
    containsRtlScript: /[\u0590-\u08FF]/u.test(text),
    containsUnicode: containsUnicodeCharacters(text),
    graphemeCount: characters.length,
    textLength: text.length,
  };
}

function buildTypingEventPayload(input: {
  text: string;
  characters: readonly string[];
  fieldLabel?: string | null | undefined;
  profileName?: TypingProfileName | undefined;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...buildTypingLogPayload(input.text, input.characters),
    ...(input.fieldLabel ? { field_label: input.fieldLabel } : {}),
    ...(input.profileName ? { typing_profile: input.profileName } : {}),
    ...input.extra,
  };
}

const KEYBOARD_GEOMETRY = createKeyboardGeometry();
const KEYBOARD_KEYS = Object.values(KEYBOARD_GEOMETRY);

/**
 * Read-only map of normalized QWERTY keys to their nearby neighbors.
 */
export const QWERTY_KEY_ADJACENCY_MAP = createQwertyAdjacencyMap();

const WEIGHTED_QWERTY_KEY_ADJACENCY_MAP = createWeightedQwertyAdjacencyMap();

function createKeyboardGeometry(): Readonly<
  Record<string, KeyboardKeyGeometry>
> {
  const entries = QWERTY_KEYBOARD_ROWS.flatMap((row, rowIndex) =>
    Array.from(row).map((key, keyIndex) => {
      const mappedKey = key as keyof typeof KEY_FINGER_BY_CHARACTER;
      const finger = KEY_FINGER_BY_CHARACTER[mappedKey];
      const hand: KeyboardHand = finger.startsWith("left") ? "left" : "right";
      return [
        key,
        {
          key,
          x: keyIndex + (QWERTY_ROW_OFFSETS[rowIndex] ?? 0),
          y: rowIndex,
          hand,
          finger,
        },
      ] as const;
    }),
  );

  return Object.freeze(
    Object.fromEntries(entries) as Record<string, KeyboardKeyGeometry>,
  );
}

function getKeyDistance(
  source: KeyboardKeyGeometry,
  target: KeyboardKeyGeometry,
): number {
  return Math.hypot(source.x - target.x, source.y - target.y);
}

function getAdjacentKeyboardKeys(
  source: KeyboardKeyGeometry,
): KeyboardKeyGeometry[] {
  return KEYBOARD_KEYS.filter(
    (target) =>
      target.key !== source.key &&
      Math.abs(source.x - target.x) <= ADJACENCY_HORIZONTAL_THRESHOLD &&
      Math.abs(source.y - target.y) <= ADJACENCY_VERTICAL_THRESHOLD,
  ).sort(
    (left, right) =>
      getKeyDistance(source, left) - getKeyDistance(source, right) ||
      left.key.localeCompare(right.key),
  );
}

function createQwertyAdjacencyMap(): Readonly<
  Record<string, readonly string[]>
> {
  const entries = Object.values(KEYBOARD_GEOMETRY).map((source) => {
    const adjacent = getAdjacentKeyboardKeys(source).map(
      (target) => target.key,
    );

    return [source.key, Object.freeze(adjacent)] as const;
  });

  return Object.freeze(
    Object.fromEntries(entries) as Record<string, readonly string[]>,
  );
}

function createWeightedCandidate(
  source: KeyboardKeyGeometry,
  target: KeyboardKeyGeometry,
): AdjacentTypoCandidate {
  const sameFinger = source.finger === target.finger;
  const sameHand = source.hand === target.hand;
  const distance = getKeyDistance(source, target);
  const baseWeight = sameFinger ? 6 : sameHand ? 3 : 1.5;
  const distanceBonus = distance < 1 ? 1.25 : 1;

  return {
    key: target.key,
    weight: baseWeight * distanceBonus,
    hand: target.hand,
    finger: target.finger,
  };
}

function createWeightedQwertyAdjacencyMap(): Readonly<
  Record<string, readonly AdjacentTypoCandidate[]>
> {
  const entries = Object.values(KEYBOARD_GEOMETRY).map((source) => {
    const weighted = getAdjacentKeyboardKeys(source)
      .map((target) => createWeightedCandidate(source, target))
      .sort(
        (left, right) =>
          right.weight - left.weight || left.key.localeCompare(right.key),
      );

    return [source.key, Object.freeze(weighted)] as const;
  });

  return Object.freeze(
    Object.fromEntries(entries) as Record<
      string,
      readonly AdjacentTypoCandidate[]
    >,
  );
}

function isUppercaseLetter(character: string): boolean {
  return /^[A-Z]$/u.test(character);
}

function isWhitespaceCharacter(character: string | null): boolean {
  return character !== null && /^\s$/u.test(character);
}

function normalizeContextCharacter(character: string | null): string | null {
  if (character === null || !isWordCharacter(character)) {
    return null;
  }

  return character.normalize("NFC").toLocaleLowerCase();
}

function normalizeTypingCharacter(character: string | null): string | null {
  if (character === null || !/^[A-Za-z0-9]$/u.test(character)) {
    return null;
  }

  return character.toLowerCase();
}

function isWordCharacter(character: string | null): boolean {
  return character !== null && /[\p{L}\p{N}]/u.test(character);
}

function applyCharacterCase(
  candidate: string,
  intendedCharacter: string,
): string {
  return isUppercaseLetter(intendedCharacter)
    ? candidate.toUpperCase()
    : candidate;
}

/**
 * Return weighted nearby-key typo candidates for one grapheme.
 *
 * Unsupported characters, whitespace, and multi-grapheme input return an empty array.
 */
export function getAdjacentTypoCandidates(
  character: string,
): readonly AdjacentTypoCandidate[] {
  assertString(character, "character", { allowEmpty: true });
  const characters = splitTypingCharacters(character);
  if (characters.length !== 1) {
    return [];
  }

  const normalizedCharacter = normalizeTypingCharacter(characters[0] ?? null);
  if (normalizedCharacter === null) {
    return [];
  }

  return WEIGHTED_QWERTY_KEY_ADJACENCY_MAP[normalizedCharacter] ?? [];
}

/**
 * Pick one nearby-key typo candidate for `character`.
 *
 * Pass `randomValue` to make selection deterministic in tests.
 */
export function pickAdjacentTypoCharacter(
  character: string,
  randomValue = Math.random(),
): string | null {
  assertString(character, "character", { allowEmpty: true });
  const candidates = getAdjacentTypoCandidates(character);
  if (candidates.length === 0) {
    return null;
  }

  const totalWeight = candidates.reduce(
    (sum, candidate) => sum + candidate.weight,
    0,
  );
  const normalizedRandomValue =
    typeof randomValue === "number" && Number.isFinite(randomValue)
      ? randomValue
      : 0.999999;
  const clampedRandom = Math.max(0, Math.min(normalizedRandomValue, 0.999999));
  let remainingWeight = clampedRandom * totalWeight;

  for (const candidate of candidates) {
    remainingWeight -= candidate.weight;
    if (remainingWeight < 0) {
      return applyCharacterCase(candidate.key, character);
    }
  }

  return applyCharacterCase(candidates[candidates.length - 1]!.key, character);
}

/**
 * Wrap a Playwright `Page` with human-like navigation, mouse, and typing helpers.
 *
 * `type()` simulates word-boundary pacing, pauses, typos, and corrections, then
 * falls back to direct input when safety limits are reached.
 */
export class HumanizedPage {
  private readonly page: Page;
  private readonly options: ResolvedHumanizeOptions;

  /**
   * Create a wrapper with reusable delay and typing defaults.
   */
  constructor(page: Page, options?: HumanizeOptions) {
    assertPageLike(page);
    validateHumanizeOptionsValue(options);

    const fast = options?.fast ?? false;
    this.page = page;
    this.options = {
      baseDelay: options?.baseDelay ?? (fast ? 200 : 800),
      jitterRange: options?.jitterRange ?? (fast ? 400 : 1500),
      fast,
      typingProfile: options?.typingProfile ?? (fast ? "fast" : "careful"),
      typingDelayOverride: options?.typingDelay ?? null,
      typingJitterOverride: options?.typingJitter ?? null,
      typingProfileOverrides: options?.typingProfileOverrides ?? {},
    };
  }

  /**
   * Underlying Playwright page.
   */
  get raw(): Page {
    return this.page;
  }

  /**
   * Wait for the configured base delay plus random jitter.
   */
  async delay(baseMs?: number): Promise<void> {
    if (baseMs !== undefined) {
      assertNonNegativeFiniteNumber(baseMs, "baseMs", {
        max: MAX_HUMANIZED_DELAY_MS,
      });
    }

    const base = baseMs ?? this.options.baseDelay;
    const jitter =
      this.options.jitterRange > 0
        ? Math.random() * this.options.jitterRange
        : 0;
    await this.waitForDelay(base + jitter, "humanize.delay");
  }

  /**
   * Navigate to `url` with short pre/post pauses.
   */
  async navigate(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "networkidle" | "load" },
  ): Promise<void> {
    assertString(url, "url", { maxLength: MAX_URL_LENGTH });
    if (options !== undefined && !isRecord(options)) {
      throw new TypeError("options must be an object.");
    }
    if (
      options?.waitUntil !== undefined &&
      !["domcontentloaded", "networkidle", "load"].includes(options.waitUntil)
    ) {
      throw new RangeError(
        "options.waitUntil must be one of: domcontentloaded, networkidle, load.",
      );
    }

    await this.delay(300);
    await this.page.goto(url, {
      waitUntil: options?.waitUntil ?? "domcontentloaded",
    });
    await this.delay(600);
  }

  /**
   * Scroll the first matching element into view, then pause briefly.
   */
  async scrollIntoView(selector: string): Promise<void> {
    this.validateSelector(selector);
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);
  }

  /**
   * Smooth-scroll the page downward by an explicit or random amount.
   */
  async scrollDown(pixels?: number): Promise<void> {
    if (pixels !== undefined) {
      assertNonNegativeFiniteNumber(pixels, "pixels", {
        max: MAX_SCROLL_DISTANCE_PX,
      });
    }

    const amount = pixels ?? 300 + Math.random() * 500;
    await this.page.evaluate((scrollAmount) => {
      globalThis.scrollBy({ top: scrollAmount, behavior: "smooth" });
    }, amount);
    await this.delay(400);
  }

  /**
   * Move the pointer near a coordinate with slight randomness, then pause.
   */
  async moveMouseNear(x: number, y: number): Promise<void> {
    assertNumberInRange(
      x,
      "x",
      -MAX_MOUSE_COORDINATE_ABS,
      MAX_MOUSE_COORDINATE_ABS,
    );
    assertNumberInRange(
      y,
      "y",
      -MAX_MOUSE_COORDINATE_ABS,
      MAX_MOUSE_COORDINATE_ABS,
    );

    const offsetX = (Math.random() - 0.5) * 10;
    const offsetY = (Math.random() - 0.5) * 10;
    await this.page.mouse.move(x + offsetX, y + offsetY, {
      steps: 3 + Math.floor(Math.random() * 5),
    });
    await this.delay(150);
  }

  /**
   * Click the first matching element after scrolling it into view and settling the pointer.
   */
  async click(selector: string): Promise<void> {
    this.validateSelector(selector);
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.delay(200);

    const box = await element.boundingBox();
    if (box) {
      const targetX =
        box.x + box.width / 2 + (Math.random() - 0.5) * (box.width * 0.3);
      const targetY =
        box.y + box.height / 2 + (Math.random() - 0.5) * (box.height * 0.3);
      await this.page.mouse.move(targetX, targetY, {
        steps: 3 + Math.floor(Math.random() * 4),
      });
      await this.delay(100);
    }

    await element.click({ timeout: 10_000 });
    await this.delay(300);
  }

  /**
   * Type `text` into the first matching element with human-like cadence.
   *
   * The simulation applies profile-based delays, pause patterns, and occasional
   * typo/correction loops. Very long input or timeout/failure cases degrade to
   * direct input after emitting `humanize.typing.*` diagnostics.
   */
  async type(
    selector: string,
    text: string,
    options?: HumanizedTypingOptions,
  ): Promise<void> {
    this.validateSelector(selector);
    assertString(text, "text", { allowEmpty: true });
    validateHumanizedTypingOptionsValue(options);

    await this.typeInto(this.page.locator(selector).first(), text, options);
  }

  /**
   * Type `text` into `locator` with the same simulation used by `type()`.
   */
  async typeInto(
    locator: Locator,
    text: string,
    options?: HumanizedTypingOptions,
  ): Promise<void> {
    assertLocatorLike(locator);
    assertString(text, "text", { allowEmpty: true });
    validateHumanizedTypingOptionsValue(options);

    await this.typeIntoLocator(locator, text, options, false);
  }

  /**
   * Replace the current value of `locator` with `text` using simulated typing.
   */
  async fillInto(
    locator: Locator,
    text: string,
    options?: HumanizedTypingOptions,
  ): Promise<void> {
    assertLocatorLike(locator);
    assertString(text, "text", { allowEmpty: true });
    validateHumanizedTypingOptionsValue(options);

    await this.typeIntoLocator(locator, text, options, true);
  }

  private async typeIntoLocator(
    element: Locator,
    text: string,
    options: HumanizedTypingOptions | undefined,
    replaceExisting: boolean,
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs;
    const characters = splitTypingCharacters(text);
    if (characters.length > MAX_TEXT_GRAPHEMES) {
      throw new RangeError(
        `text must be at most ${MAX_TEXT_GRAPHEMES} Unicode graphemes long. Split very large text into smaller chunks or bypass humanized typing for bulk input.`,
      );
    }

    const fieldLabel = normalizeFieldLabel(options?.fieldLabel);
    const profileName = options?.profile ?? this.options.typingProfile;
    const profile = this.resolveTypingProfile(options);
    logHumanizeEvent(
      this.page,
      "info",
      "humanize.typing.start",
      buildTypingEventPayload({
        text,
        characters,
        fieldLabel,
        profileName,
      }),
    );

    try {
      await element.scrollIntoViewIfNeeded(
        timeoutMs === undefined ? undefined : { timeout: timeoutMs },
      );
      await this.delay(200);
      await element.click(
        timeoutMs === undefined ? undefined : { timeout: timeoutMs },
      );
      await this.delay(150);

      if (replaceExisting) {
        await this.clearFocusedInput();
        await this.delay(80);
      }

      if (characters.length === 0) {
        logHumanizeEvent(
          this.page,
          "info",
          "humanize.typing.done",
          buildTypingEventPayload({
            text,
            characters,
            fieldLabel,
            profileName,
            extra: { mode: "simulated" },
          }),
        );
        await this.delay(200);
        return;
      }

      if (characters.length > MAX_SIMULATED_TYPING_GRAPHEMES) {
        const fallbackMethod = await this.tryDirectInput(
          element,
          text,
          characters,
          "text_too_long",
          fieldLabel,
          profileName,
          undefined,
          timeoutMs,
        );
        if (fallbackMethod === null) {
          throw new HumanizeTypingTimeoutError(
            "Typing simulation exceeded the maximum safe text length and the direct-input fallback also failed. Retry once or bypass humanized typing for bulk input.",
          );
        }

        logHumanizeEvent(
          this.page,
          "info",
          "humanize.typing.done",
          buildTypingEventPayload({
            text,
            characters,
            fieldLabel,
            profileName,
            extra: {
              fallback_method: fallbackMethod,
              fallback_reason: "text_too_long",
              mode: "direct_input",
            },
          }),
        );
        await this.delay(200);
        return;
      }

      const contexts = this.buildTypingContexts(characters);
      const state = this.createTypingSimulationState(characters.length);
      let previousCommittedCharacter: string | null = null;

      try {
        for (const [index, character] of characters.entries()) {
          const context = contexts[index];
          if (!context) {
            continue;
          }

          await this.maybePauseBeforeCharacter(
            characters.length,
            index,
            context,
            profile,
            state,
          );

          const missedShift =
            isUppercaseLetter(character) &&
            this.shouldTrigger(profile.shiftMissRate);
          const mistypedCharacter = missedShift
            ? character.toLowerCase()
            : this.chooseTypoCharacter(character, profile);

          if (mistypedCharacter === null) {
            await this.typeLiteralCharacter(character, profile, state);
          } else {
            await this.typeLiteralCharacter(mistypedCharacter, profile, state);
            await this.correctCharacter(
              character,
              previousCommittedCharacter,
              profile,
              state,
              {
                allowDoubleBackspace: !missedShift,
              },
            );
          }

          previousCommittedCharacter = character;
          await this.waitForTypingDelay(
            this.computeCharacterDelay(context, profile),
            state,
            "humanize.typing.inter_character",
          );
        }
      } finally {
        await this.clearTypingSimulationState(state);
      }

      logHumanizeEvent(
        this.page,
        "info",
        "humanize.typing.done",
        buildTypingEventPayload({
          text,
          characters,
          fieldLabel,
          profileName,
          extra: { mode: "simulated" },
        }),
      );
      await this.delay(200);
    } catch (error) {
      const fallbackMethod = await this.tryDirectInput(
        element,
        text,
        characters,
        error instanceof HumanizeTypingTimeoutError
          ? "timeout"
          : "simulation_failed",
        fieldLabel,
        profileName,
        error,
        timeoutMs,
      );
      if (fallbackMethod !== null) {
        logHumanizeEvent(
          this.page,
          "info",
          "humanize.typing.done",
          buildTypingEventPayload({
            text,
            characters,
            fieldLabel,
            profileName,
            extra: {
              fallback_method: fallbackMethod,
              fallback_reason:
                error instanceof HumanizeTypingTimeoutError
                  ? "timeout"
                  : "simulation_failed",
              mode: "direct_input",
            },
          }),
        );
        await this.delay(200);
        return;
      }

      throw error;
    }
  }

  /**
   * Wait for `domcontentloaded`, then add a short post-load pause.
   */
  async waitForPageLoad(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded");
    await this.delay(400);
  }

  /**
   * Idle for a short random duration between higher-level operations.
   */
  async idle(): Promise<void> {
    const idleTime = this.options.fast
      ? 200 + Math.random() * 300
      : 1000 + Math.random() * 3000;
    await this.waitForDelay(idleTime, "humanize.idle");
  }

  private validateSelector(selector: string): void {
    assertString(selector, "selector", { maxLength: MAX_SELECTOR_LENGTH });
  }

  private clampDelay(delayMs: number, event: string): number {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return 0;
    }

    if (delayMs > MAX_HUMANIZED_DELAY_MS) {
      logHumanizeEvent(this.page, "warn", "humanize.delay.clamped", {
        clampedToMs: MAX_HUMANIZED_DELAY_MS,
        delayMs,
        event,
      });
      return MAX_HUMANIZED_DELAY_MS;
    }

    return delayMs;
  }

  private async waitForDelay(delayMs: number, event: string): Promise<void> {
    const boundedDelayMs = this.clampDelay(delayMs, event);
    if (boundedDelayMs > 0) {
      await this.page.waitForTimeout(boundedDelayMs);
    }
  }

  private async clearFocusedInput(): Promise<void> {
    try {
      await this.page.keyboard.press("ControlOrMeta+A");
    } catch {
      // Best-effort selection for fields that support text replacement.
    }

    try {
      await this.page.keyboard.press("Backspace");
    } catch {
      // Keep going; direct-input fallbacks will still attempt to overwrite.
    }
  }

  private getTypingTimeoutMs(totalCharacters: number): number {
    const perCharacterBudgetMs = this.options.fast ? 80 : 180;
    const computedTimeoutMs = Math.max(
      MIN_TYPING_TIMEOUT_MS,
      totalCharacters * perCharacterBudgetMs,
    );

    return Math.min(
      this.options.fast ? FAST_TYPING_TIMEOUT_MS : MAX_TYPING_TIMEOUT_MS,
      computedTimeoutMs,
    );
  }

  private createTypingSimulationState(
    totalCharacters: number,
  ): TypingSimulationState {
    const maxDurationMs = this.getTypingTimeoutMs(totalCharacters);
    const state: TypingSimulationState = {
      consumedDelayMs: 0,
      maxDurationMs,
      shiftPressed: false,
      timedOut: false,
      timeoutHandle: setTimeout(() => {
        state.timedOut = true;
      }, maxDurationMs),
    };
    state.timeoutHandle.unref?.();

    return state;
  }

  private async clearTypingSimulationState(
    state: TypingSimulationState,
  ): Promise<void> {
    clearTimeout(state.timeoutHandle);

    if (!state.shiftPressed) {
      return;
    }

    try {
      await this.page.keyboard.up("Shift");
    } catch (error) {
      logHumanizeEvent(this.page, "warn", "humanize.typing.cleanup_failed", {
        error: summarizeError(error),
      });
    } finally {
      state.shiftPressed = false;
    }
  }

  private assertTypingWithinBounds(state: TypingSimulationState): void {
    if (!state.timedOut && state.consumedDelayMs <= state.maxDurationMs) {
      return;
    }

    throw new HumanizeTypingTimeoutError(
      `Typing simulation exceeded the ${state.maxDurationMs}ms safety budget.`,
    );
  }

  private async waitForTypingDelay(
    delayMs: number,
    state: TypingSimulationState,
    event: string,
  ): Promise<void> {
    const boundedDelayMs = this.clampDelay(delayMs, event);
    this.assertTypingWithinBounds(state);

    if (state.consumedDelayMs + boundedDelayMs > state.maxDurationMs) {
      throw new HumanizeTypingTimeoutError(
        `Typing simulation exceeded the ${state.maxDurationMs}ms safety budget.`,
      );
    }

    state.consumedDelayMs += boundedDelayMs;
    if (boundedDelayMs > 0) {
      await this.page.waitForTimeout(boundedDelayMs);
    }
    this.assertTypingWithinBounds(state);
  }

  private async applyDirectInput(
    element: Locator,
    text: string,
    timeoutMs?: number,
  ): Promise<string> {
    if (typeof element.fill === "function") {
      await element.fill(text, {
        timeout: timeoutMs ?? DIRECT_INPUT_TIMEOUT_MS,
      });
      return "fill";
    }

    try {
      await this.page.keyboard.press("ControlOrMeta+A");
    } catch {
      // Best-effort selection for non-fill fallbacks.
    }

    if (typeof this.page.keyboard.insertText === "function") {
      await this.page.keyboard.insertText(text);
      return "insertText";
    }

    await this.page.keyboard.type(text, { delay: 0 });
    return "type";
  }

  private async tryDirectInput(
    element: Locator,
    text: string,
    characters: readonly string[],
    reason: string,
    fieldLabel?: string | null,
    profileName?: TypingProfileName,
    error?: unknown,
    timeoutMs?: number,
  ): Promise<string | null> {
    const payload = buildTypingEventPayload({
      text,
      characters,
      fieldLabel,
      profileName,
      extra: {
        diagnostic: describeTypingFallbackReason(reason),
        ...(error === undefined ? {} : { error: summarizeError(error) }),
        reason,
        suggested_action: suggestTypingFallbackAction(reason),
      },
    });

    try {
      const method = await this.applyDirectInput(element, text, timeoutMs);
      logHumanizeEvent(this.page, "warn", "humanize.typing.degraded", {
        ...payload,
        method,
      });
      return method;
    } catch (fallbackError) {
      logHumanizeEvent(this.page, "error", "humanize.typing.fallback_failed", {
        ...payload,
        fallbackError: summarizeError(fallbackError),
      });
      return null;
    }
  }

  private resolveTypingProfile(
    options?: HumanizedTypingOptions,
  ): TypingProfile {
    const name = options?.profile ?? this.options.typingProfile;
    const baseProfile = TYPING_PROFILES[name];

    return {
      ...baseProfile,
      ...(this.options.typingDelayOverride === null
        ? {}
        : { baseCharDelayMs: this.options.typingDelayOverride }),
      ...(this.options.typingJitterOverride === null
        ? {}
        : { charDelayJitterMs: this.options.typingJitterOverride }),
      ...this.options.typingProfileOverrides,
      ...options?.profileOverrides,
    };
  }

  private buildTypingContexts(characters: readonly string[]): TypingContext[] {
    const burstWordIndexes = this.findBurstWordIndexes(characters);

    return characters.map((current, index) => {
      const previous = index > 0 ? (characters[index - 1] ?? null) : null;
      const previousMeaningful = this.findPreviousMeaningfulCharacter(
        characters,
        index - 1,
      );
      const next =
        index < characters.length - 1 ? (characters[index + 1] ?? null) : null;
      const normalizedCurrent = normalizeContextCharacter(current);
      const normalizedPrevious = normalizeContextCharacter(previous);
      const currentIsWordCharacter = normalizedCurrent !== null;

      return {
        previousMeaningful,
        isBurstWord: burstWordIndexes.has(index),
        isRepeatedCharacter:
          currentIsWordCharacter && normalizedCurrent === normalizedPrevious,
        isSentenceRestart:
          previousMeaningful !== null && /[.!?]/u.test(previousMeaningful),
        isWhitespace: isWhitespaceCharacter(current),
        isWordCharacter: currentIsWordCharacter,
        isWordEnd: currentIsWordCharacter && !isWordCharacter(next),
        isWordStart: currentIsWordCharacter && !isWordCharacter(previous),
      };
    });
  }

  private findPreviousMeaningfulCharacter(
    characters: readonly string[],
    startIndex: number,
  ): string | null {
    for (let index = startIndex; index >= 0; index -= 1) {
      const character = characters[index] ?? null;
      if (!isWhitespaceCharacter(character)) {
        return character;
      }
    }

    return null;
  }

  private findBurstWordIndexes(characters: readonly string[]): Set<number> {
    const burstWordIndexes = new Set<number>();
    let wordStartIndex: number | null = null;

    for (let index = 0; index <= characters.length; index += 1) {
      const character = characters[index] ?? null;
      const isLetter = character !== null && /^[A-Za-z]$/u.test(character);

      if (isLetter) {
        if (wordStartIndex === null) {
          wordStartIndex = index;
        }
        continue;
      }

      if (wordStartIndex === null) {
        continue;
      }

      const word = characters
        .slice(wordStartIndex, index)
        .join("")
        .toLowerCase();
      if (COMMON_BURST_WORDS.has(word)) {
        for (
          let burstIndex = wordStartIndex;
          burstIndex < index;
          burstIndex += 1
        ) {
          burstWordIndexes.add(burstIndex);
        }
      }

      wordStartIndex = null;
    }

    return burstWordIndexes;
  }

  private computeCharacterDelay(
    context: TypingContext,
    profile: TypingProfile,
  ): number {
    const jitter =
      profile.charDelayJitterMs > 0
        ? Math.random() * profile.charDelayJitterMs
        : 0;
    let delay = profile.baseCharDelayMs + jitter;

    if (context.isWordCharacter) {
      delay *=
        context.isWordStart || context.isWordEnd
          ? profile.wordBoundaryMultiplier
          : profile.midWordMultiplier;

      if (context.isBurstWord) {
        delay *= profile.burstWordMultiplier;
      }

      if (context.isRepeatedCharacter) {
        delay *= profile.repeatedCharacterMultiplier;
      }
    } else if (context.isWhitespace) {
      delay *= profile.whitespaceMultiplier;
    } else {
      delay *= profile.punctuationMultiplier;
    }

    if (context.isSentenceRestart) {
      delay *= 1.08;
    }

    return Math.max(0, delay);
  }

  private chooseTypoCharacter(
    character: string,
    profile: TypingProfile,
  ): string | null {
    if (
      normalizeTypingCharacter(character) === null ||
      !this.shouldTrigger(profile.typoRate)
    ) {
      return null;
    }

    return pickAdjacentTypoCharacter(character);
  }

  private async maybePauseBeforeCharacter(
    totalCharacters: number,
    characterIndex: number,
    context: TypingContext,
    profile: TypingProfile,
    state: TypingSimulationState,
  ): Promise<void> {
    if (totalCharacters < 5 || characterIndex === 0 || !context.isWordStart) {
      return;
    }

    const longPauseEligible =
      totalCharacters >= 15 && context.isSentenceRestart;
    if (longPauseEligible && this.shouldTrigger(profile.longPauseChance)) {
      await this.waitForTypingDelay(
        this.sampleRange(profile.longPauseRange),
        state,
        "humanize.typing.long_pause",
      );
      return;
    }

    const previousCharacter = context.previousMeaningful;
    const chanceBoost =
      previousCharacter !== null && /[,;:]/u.test(previousCharacter) ? 1.35 : 1;
    const pauseChance = Math.min(1, profile.thinkingPauseChance * chanceBoost);
    if (this.shouldTrigger(pauseChance)) {
      await this.waitForTypingDelay(
        this.sampleRange(profile.thinkingPauseRange),
        state,
        "humanize.typing.thinking_pause",
      );
    }
  }

  private async correctCharacter(
    intendedCharacter: string,
    previousCommittedCharacter: string | null,
    profile: TypingProfile,
    state: TypingSimulationState,
    options: { allowDoubleBackspace: boolean },
  ): Promise<void> {
    await this.waitForTypingDelay(
      this.sampleRange(profile.correctionPauseRange),
      state,
      "humanize.typing.correction_pause",
    );
    await this.page.keyboard.press("Backspace");

    const shouldDoubleBackspace =
      options.allowDoubleBackspace &&
      previousCommittedCharacter !== null &&
      isWordCharacter(previousCommittedCharacter) &&
      this.shouldTrigger(profile.doubleBackspaceRate);

    if (shouldDoubleBackspace) {
      await this.page.keyboard.press("Backspace");
    }

    await this.waitForTypingDelay(
      this.sampleRange(profile.correctionResumeRange),
      state,
      "humanize.typing.correction_resume",
    );

    if (shouldDoubleBackspace && previousCommittedCharacter !== null) {
      await this.typeLiteralCharacter(
        previousCommittedCharacter,
        profile,
        state,
      );
    }

    await this.typeLiteralCharacter(intendedCharacter, profile, state);
  }

  private async typeLiteralCharacter(
    character: string,
    profile: TypingProfile,
    state?: TypingSimulationState,
  ): Promise<void> {
    if (character.length === 0) {
      return;
    }

    if (isUppercaseLetter(character)) {
      const shiftLeadDelay = this.sampleRange(profile.shiftLeadRange);
      if (shiftLeadDelay > 0) {
        if (state) {
          await this.waitForTypingDelay(
            shiftLeadDelay,
            state,
            "humanize.typing.shift_lead",
          );
        } else {
          await this.waitForDelay(shiftLeadDelay, "humanize.typing.shift_lead");
        }
      }

      await this.page.keyboard.down("Shift");
      if (state) {
        state.shiftPressed = true;
      }
      try {
        await this.page.keyboard.press(character.toLowerCase());
      } finally {
        await this.page.keyboard.up("Shift");
        if (state) {
          state.shiftPressed = false;
        }
      }
      return;
    }

    await this.page.keyboard.type(character, { delay: 0 });
  }

  private sampleRange(range: DelayRange): number {
    if (range.minMs >= range.maxMs) {
      return range.minMs;
    }

    return range.minMs + Math.random() * (range.maxMs - range.minMs);
  }

  private shouldTrigger(chance: number): boolean {
    if (chance <= 0) {
      return false;
    }

    if (chance >= 1) {
      return true;
    }

    return Math.random() < chance;
  }
}

/**
 * Create a `HumanizedPage` wrapper around a Playwright page.
 *
 * @example
 * const hp = humanize(page, { typingProfile: "careful" });
 * await hp.type('[role="textbox"]', "Thanks for the update.", {
 *   fieldLabel: "message composer"
 * });
 */
export function humanize(page: Page, options?: HumanizeOptions): HumanizedPage {
  return new HumanizedPage(page, options);
}
