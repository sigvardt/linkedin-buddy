import { LinkedInAssistantError } from "../errors.js";
import type {
  EvasionConfigSource,
  EvasionFeatureName,
  EvasionLevel,
  EvasionProfile,
  EvasionStatus
} from "./types.js";

/**
 * Default evasion level applied when no explicit override is configured.
 *
 * @example
 * ```ts
 * console.log(DEFAULT_EVASION_LEVEL);
 * // "moderate"
 * ```
 */
export const DEFAULT_EVASION_LEVEL: EvasionLevel = "moderate";

/**
 * Supported evasion levels in ascending order of intensity.
 *
 * @example
 * ```ts
 * if (EVASION_LEVELS.includes("paranoid")) {
 *   console.log("supported");
 * }
 * ```
 */
export const EVASION_LEVELS = ["minimal", "moderate", "paranoid"] as const;

const MINIMAL_PROFILE: Readonly<EvasionProfile> = Object.freeze({
  bezierMouseMovement: false,
  mouseOvershootFactor: 0,
  mouseJitterRadius: 0,
  momentumScroll: false,
  simulateTabBlur: false,
  simulateViewportResize: false,
  idleDriftEnabled: false,
  readingPauseWpm: 0,
  poissonIntervals: false,
  fingerprintHardening: false
});

const MODERATE_PROFILE: Readonly<EvasionProfile> = Object.freeze({
  bezierMouseMovement: true,
  mouseOvershootFactor: 0.15,
  mouseJitterRadius: 3,
  momentumScroll: true,
  simulateTabBlur: false,
  simulateViewportResize: false,
  idleDriftEnabled: true,
  readingPauseWpm: 230,
  poissonIntervals: true,
  fingerprintHardening: true
});

const PARANOID_PROFILE: Readonly<EvasionProfile> = Object.freeze({
  bezierMouseMovement: true,
  mouseOvershootFactor: 0.25,
  mouseJitterRadius: 6,
  momentumScroll: true,
  simulateTabBlur: true,
  simulateViewportResize: true,
  idleDriftEnabled: true,
  readingPauseWpm: 200,
  poissonIntervals: true,
  fingerprintHardening: true
});

/**
 * Predefined detection-evasion profiles ordered by intensity.
 *
 * Most production workflows should use `"moderate"`. Reserve `"paranoid"` for
 * environments with aggressive bot detection.
 *
 * @example
 * ```ts
 * const overshoot = EVASION_PROFILES.paranoid.mouseOvershootFactor;
 * ```
 */
export const EVASION_PROFILES: Readonly<Record<EvasionLevel, Readonly<EvasionProfile>>> =
  Object.freeze({
    minimal: MINIMAL_PROFILE,
    moderate: MODERATE_PROFILE,
    paranoid: PARANOID_PROFILE
  });

const EVASION_FEATURES = [
  {
    name: "bezier_mouse_movement",
    enabled: (profile: Readonly<EvasionProfile>) => profile.bezierMouseMovement
  },
  {
    name: "momentum_scroll",
    enabled: (profile: Readonly<EvasionProfile>) => profile.momentumScroll
  },
  {
    name: "tab_blur_simulation",
    enabled: (profile: Readonly<EvasionProfile>) => profile.simulateTabBlur
  },
  {
    name: "viewport_resize_simulation",
    enabled: (profile: Readonly<EvasionProfile>) => profile.simulateViewportResize
  },
  {
    name: "idle_drift",
    enabled: (profile: Readonly<EvasionProfile>) => profile.idleDriftEnabled
  },
  {
    name: "reading_pauses",
    enabled: (profile: Readonly<EvasionProfile>) => profile.readingPauseWpm > 0
  },
  {
    name: "poisson_timing",
    enabled: (profile: Readonly<EvasionProfile>) => profile.poissonIntervals
  },
  {
    name: "fingerprint_hardening",
    enabled: (profile: Readonly<EvasionProfile>) => profile.fingerprintHardening
  }
] as const satisfies readonly {
  name: EvasionFeatureName;
  enabled: (profile: Readonly<EvasionProfile>) => boolean;
}[];

/**
 * Returns whether `value` is one of the supported evasion levels.
 *
 * @example
 * ```ts
 * if (isEvasionLevel(input)) {
 *   console.log(`Using ${input}`);
 * }
 * ```
 */
export function isEvasionLevel(value: string): value is EvasionLevel {
  return EVASION_LEVELS.includes(value as EvasionLevel);
}

/**
 * Resolves a user-supplied evasion level and throws a clear error when the
 * value is unsupported.
 *
 * @example
 * ```ts
 * const level = resolveEvasionLevel(process.env.LINKEDIN_ASSISTANT_EVASION_LEVEL);
 * ```
 */
export function resolveEvasionLevel(
  value: string | EvasionLevel | undefined,
  sourceLabel = "evasion level",
  defaultLevel: EvasionLevel = DEFAULT_EVASION_LEVEL
): EvasionLevel {
  if (typeof value !== "string" || value.trim().length === 0) {
    return defaultLevel;
  }

  const normalized = value.trim().toLowerCase();
  if (isEvasionLevel(normalized)) {
    return normalized;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${sourceLabel} must be one of ${EVASION_LEVELS.join(", ")}.`,
    {
      source: sourceLabel,
      value,
      supported_values: [...EVASION_LEVELS],
      default_value: defaultLevel,
      suggestion:
        "Use minimal for deterministic development and test flows, moderate for the default balance, or paranoid for the most aggressive evasion profile."
    }
  );
}

/**
 * Returns the immutable evasion profile for `level`.
 *
 * @example
 * ```ts
 * const profile = resolveEvasionProfile("moderate");
 * console.log(profile.fingerprintHardening);
 * ```
 */
export function resolveEvasionProfile(level: EvasionLevel): Readonly<EvasionProfile> {
  return EVASION_PROFILES[level];
}

/**
 * Returns the stable feature names enabled by `profile`.
 *
 * @example
 * ```ts
 * const enabled = getEnabledEvasionFeatures(EVASION_PROFILES.moderate);
 * ```
 */
export function getEnabledEvasionFeatures(
  profile: Readonly<EvasionProfile>
): readonly EvasionFeatureName[] {
  return EVASION_FEATURES.filter((feature) => feature.enabled(profile)).map(
    (feature) => feature.name
  );
}

/**
 * Returns the stable feature names disabled by `profile`.
 *
 * @example
 * ```ts
 * const disabled = getDisabledEvasionFeatures(EVASION_PROFILES.minimal);
 * ```
 */
export function getDisabledEvasionFeatures(
  profile: Readonly<EvasionProfile>
): readonly EvasionFeatureName[] {
  return EVASION_FEATURES.filter((feature) => !feature.enabled(profile)).map(
    (feature) => feature.name
  );
}

/**
 * Returns a human-readable summary for the supplied evasion level.
 *
 * @example
 * ```ts
 * console.log(describeEvasionLevel("paranoid"));
 * ```
 */
export function describeEvasionLevel(level: EvasionLevel): string {
  switch (level) {
    case "minimal":
      return "Minimal evasion keeps behavioral and fingerprint simulation disabled for deterministic development and test flows.";
    case "moderate":
      return "Moderate evasion enables Bezier mouse movement, momentum scroll, idle drift, reading pauses, Poisson timing, and fingerprint hardening.";
    case "paranoid":
      return "Paranoid evasion enables the moderate profile plus synthetic tab blur and viewport resize signals with stronger cursor jitter.";
  }
}

/**
 * Builds a structured evasion status snapshot for diagnostics and status output.
 *
 * @example
 * ```ts
 * const status = createEvasionStatus({
 *   level: "moderate",
 *   diagnosticsEnabled: true,
 *   source: "option"
 * });
 * ```
 */
export function createEvasionStatus(input: {
  diagnosticsEnabled?: boolean;
  level?: string | EvasionLevel;
  source?: EvasionConfigSource;
} = {}): EvasionStatus {
  const source = input.source ?? "default";
  const level = resolveEvasionLevel(input.level, "evasion level");
  const profile = resolveEvasionProfile(level);

  return {
    diagnosticsEnabled: input.diagnosticsEnabled ?? false,
    disabledFeatures: getDisabledEvasionFeatures(profile),
    enabledFeatures: getEnabledEvasionFeatures(profile),
    level,
    profile,
    source,
    summary: describeEvasionLevel(level)
  };
}
