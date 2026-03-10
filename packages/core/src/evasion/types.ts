/**
 * Detection-evasion intensity levels.
 *
 * - `minimal`: Basic timing variation only; suitable for development and test flows.
 * - `moderate`: Bezier mouse paths, momentum scroll, and navigator fingerprint hardening.
 * - `paranoid`: All `moderate` techniques plus tab simulation, viewport jitter, and
 *   canvas noise hardening.
 *
 * @example
 * ```ts
 * const level: EvasionLevel = "moderate";
 * ```
 */
export type EvasionLevel = "minimal" | "moderate" | "paranoid";

/**
 * 2D coordinate used for Bezier path computation.
 *
 * @example
 * ```ts
 * const point: Point2D = { x: 120, y: 48 };
 * ```
 */
export interface Point2D {
  /** Horizontal coordinate in pixels. */
  x: number;
  /** Vertical coordinate in pixels. */
  y: number;
}

/**
 * Options for {@link computeBezierPath}.
 *
 * @example
 * ```ts
 * const options: BezierPathOptions = {
 *   steps: 24,
 *   overshootFactor: 0.2,
 *   seed: 7
 * };
 * ```
 */
export interface BezierPathOptions {
  /**
   * Number of intermediate coordinate points to generate (min 2, max 200).
   * Defaults to `20`.
   */
  steps?: number;
  /**
   * How far past the target to overshoot before correcting, expressed as a
   * fraction of total travel distance. `0` disables overshoot; max useful
   * value is `1`. Defaults to `0`.
   */
  overshootFactor?: number;
  /**
   * Optional integer seed for deterministic output in tests. When omitted
   * the function uses `Math.random()`.
   */
  seed?: number;
}

/**
 * Optional guards and backoff hints for sampled action intervals.
 *
 * @example
 * ```ts
 * const options: IntervalSampleOptions = {
 *   minIntervalMs: 300,
 *   maxIntervalMs: 1_500,
 *   responseStatus: 429,
 *   retryAfterMs: 2_000
 * };
 * ```
 */
export interface IntervalSampleOptions {
  /** Lower bound for the returned interval in milliseconds. */
  minIntervalMs?: number;
  /** Upper bound for the returned interval in milliseconds. */
  maxIntervalMs?: number;
  /** Existing keep-alive cadence to respect when backing off. */
  keepAliveIntervalMs?: number;
  /** Server-provided retry hint in milliseconds, when available. */
  retryAfterMs?: number;
  /** Response status associated with the interval, such as `429` or `999`. */
  responseStatus?: number;
  /** Explicit rate-limit signal when a response status is unavailable. */
  rateLimited?: boolean;
  /** Multiplier applied to the base interval when rate limited. Defaults to `2`. */
  rateLimitBackoffMultiplier?: number;
}

/**
 * Configurable detection-evasion parameters.
 *
 * @example
 * ```ts
 * import { EVASION_PROFILES } from "@linkedin-assistant/core";
 *
 * const profile: EvasionProfile = EVASION_PROFILES.moderate;
 * ```
 */
export interface EvasionProfile {
  /** Whether to use cubic Bezier curves instead of straight-line mouse moves. */
  bezierMouseMovement: boolean;
  /**
   * Fraction of travel distance to overshoot when moving to a target (0–1).
   * `0` disables overshoot.
   */
  mouseOvershootFactor: number;
  /** Radius in pixels for idle micro-jitter (`0` disables). */
  mouseJitterRadius: number;
  /** Whether to simulate momentum/inertia deceleration when scrolling. */
  momentumScroll: boolean;
  /** Whether to occasionally fire synthetic tab blur/focus events. */
  simulateTabBlur: boolean;
  /** Whether to occasionally fire synthetic viewport resize events. */
  simulateViewportResize: boolean;
  /** Whether idle pauses include small randomised cursor drift. */
  idleDriftEnabled: boolean;
  /**
   * Reading speed in words per minute used for content-proportional pauses.
   * `0` disables reading pauses.
   */
  readingPauseWpm: number;
  /** Whether to use Poisson-distributed intervals for action timing. */
  poissonIntervals: boolean;
  /**
   * Whether to apply navigator and canvas fingerprint hardening via
   * `page.evaluate`.
   */
  fingerprintHardening: boolean;
}

/**
 * Source used to resolve the effective evasion level.
 *
 * @example
 * ```ts
 * const source: EvasionConfigSource = "env";
 * ```
 */
export type EvasionConfigSource = "default" | "env" | "option";

/**
 * Stable feature names surfaced in status output and diagnostics.
 *
 * @example
 * ```ts
 * const feature: EvasionFeatureName = "fingerprint_hardening";
 * ```
 */
export type EvasionFeatureName =
  | "bezier_mouse_movement"
  | "momentum_scroll"
  | "tab_blur_simulation"
  | "viewport_resize_simulation"
  | "idle_drift"
  | "reading_pauses"
  | "poisson_timing"
  | "fingerprint_hardening";

/**
 * Minimal logger surface used by optional evasion diagnostics.
 *
 * @example
 * ```ts
 * const logger: EvasionDiagnosticsLogger = {
 *   log(level, event, payload) {
 *     console.log(level, event, payload);
 *   }
 * };
 * ```
 */
export interface EvasionDiagnosticsLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    payload?: Record<string, unknown>
  ): unknown;
}

/**
 * Resolved evasion status exposed through runtime/session diagnostics.
 *
 * @example
 * ```ts
 * import { createEvasionStatus } from "@linkedin-assistant/core";
 *
 * const status: EvasionStatus = createEvasionStatus({
 *   level: "paranoid",
 *   diagnosticsEnabled: true,
 *   source: "option"
 * });
 * ```
 */
export interface EvasionStatus {
  /** Whether verbose evasion diagnostics are enabled for this run. */
  diagnosticsEnabled: boolean;
  /** Stable feature names disabled by the active profile. */
  disabledFeatures: readonly EvasionFeatureName[];
  /** Stable feature names enabled by the active profile. */
  enabledFeatures: readonly EvasionFeatureName[];
  /** Effective evasion level. */
  level: EvasionLevel;
  /** Concrete profile values used for this run. */
  profile: Readonly<EvasionProfile>;
  /** Whether the level came from the default, env, or runtime option. */
  source: EvasionConfigSource;
  /** Human-readable summary for CLI, MCP, and logs. */
  summary: string;
}

/**
 * Optional diagnostics controls for {@link EvasionSession}.
 *
 * @example
 * ```ts
 * const options: EvasionSessionOptions = {
 *   diagnosticsEnabled: true,
 *   diagnosticsLabel: "feed",
 *   logger: {
 *     log(level, event) {
 *       console.log(level, event);
 *     }
 *   }
 * };
 * ```
 */
export interface EvasionSessionOptions {
  /** Override whether debug diagnostics are emitted for this session. */
  diagnosticsEnabled?: boolean;
  /** Optional label added to emitted diagnostics for easier correlation. */
  diagnosticsLabel?: string;
  /** Structured logger that receives optional evasion diagnostics. */
  logger?: EvasionDiagnosticsLogger;
}
