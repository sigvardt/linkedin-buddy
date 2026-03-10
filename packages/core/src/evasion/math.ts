import {
  CHARS_PER_WORD,
  MAX_BEZIER_STEPS,
  MAX_READING_WPM,
  MIN_BEZIER_STEPS,
  clamp
} from "./shared.js";
import type { BezierPathOptions, Point2D } from "./types.js";

/**
 * Compute a cubic Bezier mouse path from `from` to `to`.
 *
 * The path curves away from a straight line via randomly placed control
 * points, optionally overshooting the target before correcting — matching
 * the slight momentum a real hand exhibits when approaching a destination.
 *
 * The function is pure: pass `options.seed` for deterministic output in tests.
 *
 * @param from - Starting coordinate.
 * @param to - Destination coordinate.
 * @param options - Optional tuning and seed.
 * @returns Read-only array of points along the curved path, including both
 *          endpoints.
 */
export function computeBezierPath(
  from: Readonly<Point2D>,
  to: Readonly<Point2D>,
  options?: BezierPathOptions
): readonly Point2D[] {
  const steps = clamp(options?.steps ?? 20, MIN_BEZIER_STEPS, MAX_BEZIER_STEPS);
  const overshootFactor = clamp(options?.overshootFactor ?? 0, 0, 1);
  const rand = options?.seed !== undefined ? makeSeededRandom(options.seed) : Math.random;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;
  const deviation1 = dist * 0.3 * (rand() - 0.5);
  const deviation2 = dist * 0.2 * (rand() - 0.5);
  const cp1: Point2D = {
    x: lerp(from.x, to.x, 0.25) + perpX * deviation1,
    y: lerp(from.y, to.y, 0.25) + perpY * deviation1
  };
  const cp2: Point2D = {
    x: lerp(from.x, to.x, 0.75) + perpX * deviation2,
    y: lerp(from.y, to.y, 0.75) + perpY * deviation2
  };

  const overshootEnabled = overshootFactor > 0;
  const overshootTarget: Point2D = overshootEnabled
    ? {
        x: to.x + dx * overshootFactor * 0.2 * rand(),
        y: to.y + dy * overshootFactor * 0.2 * rand()
      }
    : to;
  const mainSteps = overshootEnabled ? Math.ceil(steps * 0.8) : steps;
  const points: Point2D[] = [];

  for (let i = 0; i <= mainSteps; i++) {
    const t = i / mainSteps;
    points.push(evaluateCubicBezier(from, cp1, cp2, overshootTarget, t));
  }

  if (overshootEnabled) {
    appendCorrectionPoints(points, overshootTarget, to, steps - mainSteps);
  }

  return points;
}

/**
 * Sample a Poisson-distributed interval with the given mean.
 *
 * Poisson processes model random arrival times and produce non-uniform
 * distributions that better resemble human action timing than uniform random
 * or constant delays.
 *
 * @param meanMs - Expected average interval in milliseconds.
 * @returns Sampled interval in milliseconds (≥ 0).
 */
export function samplePoissonInterval(meanMs: number): number {
  if (meanMs <= 0) {
    return 0;
  }

  const u = Math.max(Number.EPSILON, Math.random());
  return -Math.log(u) * meanMs;
}

/**
 * Estimate a realistic reading pause for `charCount` visible characters at
 * the given reading speed.
 *
 * Characters are converted to words using a 5-chars-per-word average; the
 * result is rounded to the nearest millisecond.
 *
 * @param charCount - Number of visible characters to "read".
 * @param wpm - Reading speed in words per minute (1–1000).
 * @returns Estimated reading time in milliseconds (≥ 0).
 */
export function computeReadingPauseMs(charCount: number, wpm: number): number {
  if (charCount <= 0 || wpm <= 0) {
    return 0;
  }

  const clampedWpm = clamp(wpm, 0, MAX_READING_WPM);
  const words = charCount / CHARS_PER_WORD;
  const minutes = words / clampedWpm;
  return Math.round(minutes * 60_000);
}

export function computeMomentumSteps(totalPixels: number, steps: number): number[] {
  const amounts: number[] = [];
  let remaining = totalPixels;
  const decayFactor = 0.55;

  for (let i = 0; i < steps - 1; i++) {
    const amount = remaining * decayFactor;
    amounts.push(amount);
    remaining -= amount;
  }

  amounts.push(remaining);
  return amounts;
}

function appendCorrectionPoints(
  points: Point2D[],
  overshootTarget: Readonly<Point2D>,
  to: Readonly<Point2D>,
  correctionSteps: number
): void {
  for (let i = 1; i <= correctionSteps; i++) {
    const t = i / Math.max(1, correctionSteps);
    points.push({
      x: lerp(overshootTarget.x, to.x, t),
      y: lerp(overshootTarget.y, to.y, t)
    });
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function evaluateCubicBezier(
  p0: Readonly<Point2D>,
  p1: Readonly<Point2D>,
  p2: Readonly<Point2D>,
  p3: Readonly<Point2D>,
  t: number
): Point2D {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y
  };
}

function makeSeededRandom(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
