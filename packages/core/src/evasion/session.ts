import type { Page } from "playwright-core";
import {
  applyFingerprintHardening,
  detectCaptcha as detectCaptchaOnPage,
  findHoneypotFields as findHoneypotFieldsOnPage,
  scrollPageBy,
  simulateIdleDrift,
  simulateMomentumScroll,
  simulateTabBlur as simulateTabBlurOnPage,
  simulateViewportJitter as simulateViewportJitterOnPage
} from "./browser.js";
import { computeBezierPath, computeReadingPauseMs, samplePoissonInterval } from "./math.js";
import { EVASION_PROFILES } from "./profiles.js";
import { MAX_SCROLL_DISTANCE_PX } from "./shared.js";
import type { EvasionLevel, EvasionProfile, Point2D } from "./types.js";

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
  private readonly profile: Readonly<EvasionProfile>;
  private readonly level: EvasionLevel;
  private mouseX = 0;
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
    if (!this.profile.fingerprintHardening) {
      return;
    }

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
    const path = this.profile.bezierMouseMovement
      ? computeBezierPath(from, to, { overshootFactor: this.profile.mouseOvershootFactor })
      : [to];
    const steps = this.profile.bezierMouseMovement ? 1 : 5;

    for (const point of path) {
      await this.page.mouse.move(point.x, point.y, { steps });
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
      return;
    }

    await scrollPageBy(this.page, pixels, "smooth");
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

    const shouldDrift = this.profile.idleDriftEnabled && this.profile.mouseJitterRadius > 0;
    if (shouldDrift) {
      const driftSteps = Math.max(1, Math.floor(durationMs / 300));
      await simulateIdleDrift(
        this.page,
        this.mouseX,
        this.mouseY,
        driftSteps,
        this.profile.mouseJitterRadius
      );
      return;
    }

    await this.page.waitForTimeout(durationMs);
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

    await simulateTabBlurOnPage(this.page, blurDurationMs);
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

    await simulateViewportJitterOnPage(this.page);
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
    return this.profile.poissonIntervals ? samplePoissonInterval(baseMs) : baseMs;
  }

  /**
   * Check whether a CAPTCHA challenge is currently visible on the page.
   *
   * Returns `true` when a CAPTCHA is detected. The session does NOT solve
   * CAPTCHAs; callers should pause and alert an operator.
   */
  async detectCaptcha(): Promise<boolean> {
    return detectCaptchaOnPage(this.page);
  }

  /**
   * Find likely honeypot form fields on the page.
   *
   * Returns CSS selectors of hidden inputs that should NOT be filled.
   */
  async findHoneypotFields(): Promise<readonly string[]> {
    return findHoneypotFieldsOnPage(this.page);
  }
}
