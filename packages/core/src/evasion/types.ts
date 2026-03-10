/**
 * Detection-evasion intensity levels.
 *
 * - `minimal`: Basic timing variation only; suitable for development and test flows.
 * - `moderate`: Bezier mouse paths, momentum scroll, and navigator fingerprint hardening.
 * - `paranoid`: All `moderate` techniques plus tab simulation, viewport jitter, and
 *   canvas noise hardening.
 */
export type EvasionLevel = "minimal" | "moderate" | "paranoid";

/** 2D coordinate used for Bezier path computation. */
export interface Point2D {
  /** Horizontal coordinate in pixels. */
  x: number;
  /** Vertical coordinate in pixels. */
  y: number;
}

/** Options for {@link computeBezierPath}. */
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

/** Configurable detection-evasion parameters. */
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
