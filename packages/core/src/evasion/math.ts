import {
  CHARS_PER_WORD,
  MAX_BEZIER_STEPS,
  MAX_READING_WPM,
  MIN_BEZIER_STEPS,
  clamp,
  normalizeFiniteNumber
} from "./shared.js";
import type { BezierPathOptions, IntervalSampleOptions, Point2D } from "./types.js";

const ORIGIN_POINT: Readonly<Point2D> = Object.freeze({ x: 0, y: 0 });
const RATE_LIMIT_STATUS_CODES = new Set([429, 999]);

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
  const safeFrom = normalizePoint(from);
  const safeTo = normalizePoint(to, safeFrom);
  const steps = Math.round(clamp(options?.steps ?? 20, MIN_BEZIER_STEPS, MAX_BEZIER_STEPS));
  const overshootFactor = clamp(options?.overshootFactor ?? 0, 0, 1);
  const rand = options?.seed !== undefined ? makeSeededRandom(options.seed) : Math.random;

  const dx = safeTo.x - safeFrom.x;
  const dy = safeTo.y - safeFrom.y;
  const dist = Math.hypot(dx, dy);

  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;
  const deviation1 = dist * 0.3 * (rand() - 0.5);
  const deviation2 = dist * 0.2 * (rand() - 0.5);
  const cp1: Point2D = {
    x: lerp(safeFrom.x, safeTo.x, 0.25) + perpX * deviation1,
    y: lerp(safeFrom.y, safeTo.y, 0.25) + perpY * deviation1
  };
  const cp2: Point2D = {
    x: lerp(safeFrom.x, safeTo.x, 0.75) + perpX * deviation2,
    y: lerp(safeFrom.y, safeTo.y, 0.75) + perpY * deviation2
  };

  const overshootEnabled = overshootFactor > 0;
  const overshootTarget: Point2D = overshootEnabled
    ? {
        x: safeTo.x + dx * overshootFactor * 0.2 * rand(),
        y: safeTo.y + dy * overshootFactor * 0.2 * rand()
      }
    : safeTo;
  const mainSteps = Math.max(1, overshootEnabled ? Math.ceil(steps * 0.8) : steps);
  const points: Point2D[] = [];

  for (let i = 0; i <= mainSteps; i++) {
    const t = i / mainSteps;
    points.push(evaluateCubicBezier(safeFrom, cp1, cp2, overshootTarget, t));
  }

  if (overshootEnabled) {
    appendCorrectionPoints(points, overshootTarget, safeTo, steps - mainSteps);
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
 * Optional constraints can clamp the sample, respect existing keep-alive
 * cadences, and apply rate-limit backoff for `429` / `999` style responses.
 *
 * @param meanMs - Expected average interval in milliseconds.
 * @param options - Optional bounds and rate-limit hints.
 * @returns Sampled interval in milliseconds (≥ 0).
 */
export function samplePoissonInterval(meanMs: number, options?: IntervalSampleOptions): number {
  const safeMeanMs = Math.max(0, normalizeFiniteNumber(meanMs, 0));
  if (safeMeanMs <= 0) {
    return 0;
  }

  const u = Math.max(Number.EPSILON, Math.random());
  const sampledMs = -Math.log(u) * safeMeanMs;
  return applyIntervalConstraints(sampledMs, safeMeanMs, options);
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
  const safeCharCount = Math.max(0, normalizeFiniteNumber(charCount, 0));
  const clampedWpm = clamp(wpm, 0, MAX_READING_WPM);
  if (safeCharCount <= 0 || clampedWpm <= 0) {
    return 0;
  }

  const words = safeCharCount / CHARS_PER_WORD;
  const minutes = words / clampedWpm;
  return Math.round(minutes * 60_000);
}

/**
 * Breaks a total scroll distance into a decelerating sequence of momentum
 * steps that sum back to the requested distance.
 *
 * @param totalPixels - Total distance to scroll.
 * @param steps - Number of momentum steps to generate.
 * @returns Array of per-step scroll deltas.
 */
export function computeMomentumSteps(totalPixels: number, steps: number): number[] {
  const safeTotalPixels = normalizeFiniteNumber(totalPixels, 0);
  if (safeTotalPixels === 0) {
    return [];
  }

  const safeSteps = Math.max(1, Math.floor(normalizeFiniteNumber(steps, 1)));
  if (safeSteps === 1) {
    return [safeTotalPixels];
  }

  const amounts: number[] = [];
  let remaining = safeTotalPixels;
  const decayFactor = 0.55;

  for (let index = 0; index < safeSteps - 1; index++) {
    const amount = remaining * decayFactor;
    amounts.push(amount);
    remaining -= amount;
  }

  amounts.push(remaining);
  return amounts;
}

/**
 * Applies interval bounds and rate-limit backoff rules to a fixed base delay.
 *
 * @param baseMs - Base interval in milliseconds.
 * @param options - Optional bounds and rate-limit hints.
 * @returns Resolved interval in milliseconds.
 */
export function resolveIntervalMs(baseMs: number, options?: IntervalSampleOptions): number {
  const safeBaseMs = Math.max(0, normalizeFiniteNumber(baseMs, 0));
  return applyIntervalConstraints(safeBaseMs, safeBaseMs, options);
}

function appendCorrectionPoints(
  points: Point2D[],
  overshootTarget: Readonly<Point2D>,
  to: Readonly<Point2D>,
  correctionSteps: number
): void {
  for (let index = 1; index <= correctionSteps; index++) {
    const t = index / Math.max(1, correctionSteps);
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

function normalizePoint(
  point: Readonly<Point2D>,
  fallback: Readonly<Point2D> = ORIGIN_POINT
): Point2D {
  return {
    x: normalizeFiniteNumber(point.x, fallback.x),
    y: normalizeFiniteNumber(point.y, fallback.y)
  };
}

function applyIntervalConstraints(
  intervalMs: number,
  baseMs: number,
  options?: IntervalSampleOptions
): number {
  const safeBaseMs = Math.max(0, normalizeFiniteNumber(baseMs, 0));
  const safeIntervalMs = Math.max(0, normalizeFiniteNumber(intervalMs, safeBaseMs));
  const minIntervalMs = Math.max(0, normalizeFiniteNumber(options?.minIntervalMs ?? 0, 0));
  const maxIntervalMs = resolveMaxIntervalMs(options?.maxIntervalMs);
  const keepAliveIntervalMs = Math.max(
    0,
    normalizeFiniteNumber(options?.keepAliveIntervalMs ?? 0, 0)
  );
  const retryAfterMs = Math.max(0, normalizeFiniteNumber(options?.retryAfterMs ?? 0, 0));
  const backoffMultiplier = clamp(options?.rateLimitBackoffMultiplier ?? 2, 1, 10);
  const rateLimitFloor = isRateLimited(options)
    ? Math.max(retryAfterMs, keepAliveIntervalMs, safeBaseMs * backoffMultiplier)
    : 0;
  const effectiveMinIntervalMs = Math.max(minIntervalMs, rateLimitFloor);
  const effectiveMaxIntervalMs = Math.max(effectiveMinIntervalMs, maxIntervalMs);

  return clamp(safeIntervalMs, effectiveMinIntervalMs, effectiveMaxIntervalMs);
}

function isRateLimited(options?: IntervalSampleOptions): boolean {
  if (!options) {
    return false;
  }

  return (
    options.rateLimited === true ||
    RATE_LIMIT_STATUS_CODES.has(Math.trunc(normalizeFiniteNumber(options.responseStatus ?? 0, 0))) ||
    (options.retryAfterMs ?? 0) > 0
  );
}

function resolveMaxIntervalMs(maxIntervalMs: number | undefined): number {
  if (maxIntervalMs === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const safeMaxIntervalMs = normalizeFiniteNumber(maxIntervalMs, Number.POSITIVE_INFINITY);
  return safeMaxIntervalMs >= 0 ? safeMaxIntervalMs : Number.POSITIVE_INFINITY;
}
