import type { Page } from "playwright-core";

// --- Constants ---

const MAX_BEZIER_STEPS = 200;
const MAX_DRIFT_RADIUS_PX = 100;
const MAX_SCROLL_DISTANCE_PX = 20_000;
const MAX_BLUR_DURATION_MS = 30_000;
const MAX_READING_WPM = 1_000;
const CHARS_PER_WORD = 5;

const CAPTCHA_SELECTORS = [
  "[class*='captcha' i]",
  "[id*='captcha' i]",
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "[class*='hcaptcha' i]",
  "[data-sitekey]"
] as const;

const HONEYPOT_SELECTORS = [
  "input[style*='display:none']",
  "input[style*='display: none']",
  "input[style*='visibility:hidden']",
  "input[style*='visibility: hidden']",
  "input[tabindex='-1']",
  "input[aria-hidden='true']"
] as const;

// --- Public Types ---

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

/**
 * Predefined detection-evasion profiles ordered by intensity.
 *
 * Most production workflows should use `"moderate"`. Reserve `"paranoid"` for
 * environments with aggressive bot detection.
 */
export const EVASION_PROFILES: Readonly<Record<EvasionLevel, EvasionProfile>> = {
  minimal: {
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
  },
  moderate: {
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
  },
  paranoid: {
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
  }
};

// --- Pure Math Utilities ---

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
  const steps = Math.max(2, Math.min(MAX_BEZIER_STEPS, options?.steps ?? 20));
  const overshootFactor = Math.max(0, Math.min(1, options?.overshootFactor ?? 0));
  const rand = options?.seed !== undefined ? makeSeededRandom(options.seed) : () => Math.random();

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  // Perpendicular unit vector — controls curve deviation direction.
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  const deviation1 = dist * 0.3 * (rand() - 0.5);
  const deviation2 = dist * 0.2 * (rand() - 0.5);

  // Cubic Bezier control points with perpendicular offset.
  const cp1: Point2D = {
    x: lerp(from.x, to.x, 0.25) + perpX * deviation1,
    y: lerp(from.y, to.y, 0.25) + perpY * deviation1
  };
  const cp2: Point2D = {
    x: lerp(from.x, to.x, 0.75) + perpX * deviation2,
    y: lerp(from.y, to.y, 0.75) + perpY * deviation2
  };

  // Overshoot target: push slightly past destination then correct.
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

  // Correction phase: linear move from overshoot back to actual target.
  if (overshootEnabled) {
    const correctionSteps = steps - mainSteps;
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / Math.max(1, correctionSteps);
      points.push({
        x: lerp(overshootTarget.x, to.x, t),
        y: lerp(overshootTarget.y, to.y, t)
      });
    }
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

  // Inverse CDF sampling: -ln(U) * mean, U ~ Uniform(0, 1).
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

  const clampedWpm = Math.min(MAX_READING_WPM, wpm);
  const words = charCount / CHARS_PER_WORD;
  const minutes = words / clampedWpm;
  return Math.round(minutes * 60_000);
}

// --- Browser Interaction Utilities ---

/**
 * Apply navigator and canvas fingerprint hardening to `page` by injecting
 * JavaScript into the current page context.
 *
 * Hardening levels:
 * - `minimal`: no-op.
 * - `moderate`: Removes the `navigator.webdriver` flag.
 * - `paranoid`: All `moderate` hardening plus per-session canvas pixel noise
 *   to reduce canvas fingerprint stability across sessions.
 *
 * @param page - Playwright Page to harden.
 * @param level - Desired evasion level (defaults to `"moderate"`).
 */
export async function applyFingerprintHardening(
  page: Page,
  level: EvasionLevel = "moderate"
): Promise<void> {
  if (level === "minimal") {
    return;
  }

  // Remove navigator.webdriver — the most reliable automation signal.
  await page.evaluate(() => {
    try {
      const nav = (globalThis as Record<string, unknown>)["navigator"];
      if (nav && typeof nav === "object") {
        Object.defineProperty(nav, "webdriver", {
          get: () => undefined,
          configurable: true
        });
      }
    } catch {
      // Already defined non-configurably; skip.
    }
  });

  if (level === "paranoid") {
    // Canvas noise: add a stable 1-bit salt to the first pixel of every
    // getImageData call so the canvas fingerprint differs across sessions.
    const noiseSalt = (Math.random() * 256) | 0;
    await page.evaluate((salt: number) => {
      try {
        const g = globalThis as Record<string, unknown>;
        const Ctx = g["CanvasRenderingContext2D"];
        if (typeof Ctx !== "function") return;
        const proto = (Ctx as { prototype: Record<string, unknown> }).prototype;
        const origFn = proto["getImageData"];
        if (typeof origFn !== "function") return;
        const typedOrig = origFn as (
          this: unknown,
          sx: number,
          sy: number,
          sw: number,
          sh: number
        ) => { data: { length: number; [n: number]: number } };
        proto["getImageData"] = function (
          this: unknown,
          sx: number,
          sy: number,
          sw: number,
          sh: number
        ): unknown {
          const imageData = typedOrig.call(this, sx, sy, sw, sh);
          if (imageData.data.length > 0) {
            imageData.data[0] = ((imageData.data[0] ?? 0) + (salt & 1)) & 255;
          }
          return imageData;
        };
      } catch {
        // Canvas API unavailable; skip.
      }
    }, noiseSalt);
  }
}

/**
 * Simulate a momentum-based scroll that decelerates over several steps,
 * matching the inertia of a real mouse-wheel or trackpad gesture.
 *
 * @param page - Playwright Page to scroll.
 * @param pixels - Total scroll distance in pixels (positive = down,
 *   negative = up).
 * @param steps - Number of deceleration steps (2–20, default 6).
 */
export async function simulateMomentumScroll(
  page: Page,
  pixels: number,
  steps = 6
): Promise<void> {
  if (pixels === 0) {
    return;
  }

  const totalSteps = Math.max(2, Math.min(20, steps));
  const stepAmounts = computeMomentumSteps(pixels, totalSteps);

  for (const amount of stepAmounts) {
    await page.evaluate((scrollAmount: number) => {
      globalThis.scrollBy({ top: scrollAmount, behavior: "auto" });
    }, amount);
    // Short inter-step pause to let the scroll settle between bursts.
    await page.waitForTimeout(20 + Math.floor(Math.random() * 30));
  }
}

/**
 * Simulate idle cursor micro-jitter — the involuntary hand movement that
 * keeps a real cursor from ever being perfectly still.
 *
 * @param page - Playwright Page.
 * @param currentX - Current mouse X coordinate.
 * @param currentY - Current mouse Y coordinate.
 * @param driftCount - Number of micro-moves to perform (1–20, default 3).
 * @param radius - Maximum drift radius in pixels (0–100, default 5).
 */
export async function simulateIdleDrift(
  page: Page,
  currentX: number,
  currentY: number,
  driftCount = 3,
  radius = 5
): Promise<void> {
  const clampedRadius = Math.min(MAX_DRIFT_RADIUS_PX, Math.max(0, radius));
  const clampedCount = Math.max(1, Math.min(20, driftCount));

  for (let i = 0; i < clampedCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * clampedRadius;
    await page.mouse.move(
      currentX + Math.cos(angle) * distance,
      currentY + Math.sin(angle) * distance,
      { steps: 1 }
    );
    await page.waitForTimeout(80 + Math.floor(Math.random() * 120));
  }
}

/**
 * Fire synthetic `blur` / `focus` and `visibilitychange` events to simulate
 * the user briefly switching to another tab before returning.
 *
 * Some platforms track focus events and flag sessions that never blur as
 * potential automation.
 *
 * @param page - Playwright Page.
 * @param blurDurationMs - Duration of the simulated blur in milliseconds
 *   (100–30 000, default 2 000).
 */
export async function simulateTabBlur(page: Page, blurDurationMs = 2_000): Promise<void> {
  const duration = Math.min(MAX_BLUR_DURATION_MS, Math.max(100, blurDurationMs));

  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("blur"));
    globalThis.dispatchEvent(new Event("visibilitychange"));
  });

  await page.waitForTimeout(duration);

  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.dispatchEvent(new Event("visibilitychange"));
  });
}

/**
 * Fire a synthetic `resize` event to simulate a minor viewport dimension
 * change. Real browsers resize occasionally; platforms that never see a
 * resize event may flag the session.
 *
 * @param page - Playwright Page.
 */
export async function simulateViewportJitter(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("resize"));
  });
}

/**
 * Check whether a visible CAPTCHA challenge is present on `page`.
 *
 * Returns `true` when any known CAPTCHA selector matches at least one element.
 * This library does **not** solve CAPTCHAs; callers should pause and alert an
 * operator when this returns `true`.
 *
 * @param page - Playwright Page to inspect.
 */
export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const selector of CAPTCHA_SELECTORS) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Find likely honeypot form fields on `page`.
 *
 * Honeypot fields are hidden inputs that bots tend to fill but real users
 * never interact with. Filling them sends a bot signal to the server. Returns
 * an array of CSS selectors for any suspected honeypot fields found.
 *
 * @param page - Playwright Page to inspect.
 */
export async function findHoneypotFields(page: Page): Promise<readonly string[]> {
  const found: string[] = [];

  for (const selector of HONEYPOT_SELECTORS) {
    const count = await page.locator(selector).count();
    if (count > 0) {
      found.push(selector);
    }
  }

  return found;
}

// --- EvasionSession ---

/**
 * High-level detection-evasion session that combines a Playwright Page with
 * a named evasion profile.
 *
 * Instantiate once per page and call {@link EvasionSession.hardenFingerprint}
 * after the first navigation. Then use {@link EvasionSession.moveMouse} and
 * {@link EvasionSession.scroll} in place of raw Playwright APIs to get
 * profile-appropriate behavioural signals.
 *
 * @example
 * ```typescript
 * const session = new EvasionSession(page, "moderate");
 * await session.hardenFingerprint();
 * await session.moveMouse({ x: 0, y: 0 }, { x: 200, y: 150 });
 * await session.scroll(400);
 * await session.idle(1500);
 * ```
 */
export class EvasionSession {
  private readonly page: Page;
  private readonly profile: EvasionProfile;
  private readonly level: EvasionLevel;

  /** Current tracked mouse X position — updated by {@link moveMouse}. */
  private mouseX = 0;
  /** Current tracked mouse Y position — updated by {@link moveMouse}. */
  private mouseY = 0;

  constructor(page: Page, level: EvasionLevel = "moderate") {
    this.page = page;
    this.level = level;
    this.profile = EVASION_PROFILES[level];
  }

  /** The active evasion level. */
  get activeLevel(): EvasionLevel {
    return this.level;
  }

  /** The resolved evasion profile in use. */
  get activeProfile(): Readonly<EvasionProfile> {
    return this.profile;
  }

  /**
   * Apply fingerprint hardening for this session's evasion level.
   * Call this once after the first page navigation.
   */
  async hardenFingerprint(): Promise<void> {
    await applyFingerprintHardening(this.page, this.level);
  }

  /**
   * Move the mouse from `from` to `to`.
   *
   * Uses a cubic Bezier curve with optional overshoot when the profile
   * enables `bezierMouseMovement`; otherwise moves directly.
   *
   * @param from - Starting coordinate.
   * @param to - Destination coordinate.
   */
  async moveMouse(from: Readonly<Point2D>, to: Readonly<Point2D>): Promise<void> {
    if (this.profile.bezierMouseMovement) {
      const path = computeBezierPath(from, to, {
        overshootFactor: this.profile.mouseOvershootFactor
      });
      for (const point of path) {
        await this.page.mouse.move(point.x, point.y, { steps: 1 });
      }
    } else {
      await this.page.mouse.move(to.x, to.y, { steps: 5 });
    }

    this.mouseX = to.x;
    this.mouseY = to.y;
  }

  /**
   * Scroll by `pixels` using momentum simulation when the profile enables it.
   *
   * @param pixels - Distance in pixels (positive = down, negative = up).
   */
  async scroll(pixels: number): Promise<void> {
    if (Math.abs(pixels) > MAX_SCROLL_DISTANCE_PX) {
      throw new RangeError(`Scroll distance must not exceed ${MAX_SCROLL_DISTANCE_PX}px.`);
    }

    if (this.profile.momentumScroll) {
      await simulateMomentumScroll(this.page, pixels);
    } else {
      await this.page.evaluate((scrollAmount: number) => {
        globalThis.scrollBy({ top: scrollAmount, behavior: "smooth" });
      }, pixels);
    }
  }

  /**
   * Idle for `durationMs` milliseconds.
   *
   * When `idleDriftEnabled` is set in the profile, the cursor performs small
   * random moves during the pause to simulate involuntary hand movement.
   *
   * @param durationMs - Idle duration in milliseconds.
   */
  async idle(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return;
    }

    if (this.profile.idleDriftEnabled && this.profile.mouseJitterRadius > 0) {
      const driftSteps = Math.max(1, Math.floor(durationMs / 300));
      await simulateIdleDrift(
        this.page,
        this.mouseX,
        this.mouseY,
        driftSteps,
        this.profile.mouseJitterRadius
      );
    } else {
      await this.page.waitForTimeout(durationMs);
    }
  }

  /**
   * Simulate a brief tab blur/focus cycle if the profile enables it.
   *
   * No-op when `simulateTabBlur` is `false` in the profile.
   *
   * @param blurDurationMs - Duration of the simulated blur in milliseconds.
   */
  async simulateTabSwitch(blurDurationMs = 2_000): Promise<void> {
    if (!this.profile.simulateTabBlur) {
      return;
    }

    await simulateTabBlur(this.page, blurDurationMs);
  }

  /**
   * Fire a synthetic viewport resize event if the profile enables it.
   *
   * No-op when `simulateViewportResize` is `false` in the profile.
   */
  async simulateViewportJitter(): Promise<void> {
    if (!this.profile.simulateViewportResize) {
      return;
    }

    await simulateViewportJitter(this.page);
  }

  /**
   * Wait for a content-proportional reading pause.
   *
   * Computes a realistic reading time for `charCount` visible characters
   * based on the profile's `readingPauseWpm`. No-op when `readingPauseWpm`
   * is `0`.
   *
   * @param charCount - Number of visible characters to "read".
   */
  async readingPause(charCount: number): Promise<void> {
    if (this.profile.readingPauseWpm <= 0) {
      return;
    }

    const pauseMs = computeReadingPauseMs(charCount, this.profile.readingPauseWpm);
    if (pauseMs > 0) {
      await this.page.waitForTimeout(pauseMs);
    }
  }

  /**
   * Sample an interval using the profile's timing strategy.
   *
   * Returns a Poisson-distributed value when `poissonIntervals` is enabled,
   * otherwise returns `baseMs` unchanged. Use this between any two sequential
   * actions to add realistic timing variation.
   *
   * @param baseMs - Base interval in milliseconds.
   * @returns Sampled interval in milliseconds.
   */
  sampleInterval(baseMs: number): number {
    if (!this.profile.poissonIntervals) {
      return baseMs;
    }

    return samplePoissonInterval(baseMs);
  }

  /**
   * Check whether a CAPTCHA challenge is currently visible on the page.
   *
   * Returns `true` when a CAPTCHA is detected. The session does NOT solve
   * CAPTCHAs; callers should pause and alert an operator.
   */
  async detectCaptcha(): Promise<boolean> {
    return detectCaptcha(this.page);
  }

  /**
   * Find likely honeypot form fields on the page.
   *
   * Returns CSS selectors of hidden inputs that should NOT be filled.
   */
  async findHoneypotFields(): Promise<readonly string[]> {
    return findHoneypotFields(this.page);
  }
}

// --- Private Helpers ---

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

/**
 * Simple xorshift-based seeded PRNG that returns values in [0, 1).
 */
function makeSeededRandom(seed: number): () => number {
  // xorshift32 with two rounds for better distribution.
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * Distribute `totalPixels` across `steps` amounts using exponential decay,
 * simulating the deceleration of a real scroll gesture.
 */
function computeMomentumSteps(totalPixels: number, steps: number): number[] {
  const amounts: number[] = [];
  let remaining = totalPixels;
  const decayFactor = 0.55;

  for (let i = 0; i < steps - 1; i++) {
    const amount = remaining * decayFactor;
    amounts.push(amount);
    remaining -= amount;
  }

  // Final step carries whatever is left to avoid rounding drift.
  amounts.push(remaining);
  return amounts;
}
