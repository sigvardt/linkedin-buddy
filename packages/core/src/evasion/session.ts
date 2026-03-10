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
import {
  computeBezierPath,
  computeReadingPauseMs,
  resolveIntervalMs,
  samplePoissonInterval
} from "./math.js";
import { resolveEvasionLevel, resolveEvasionProfile } from "./profiles.js";
import { MAX_SCROLL_DISTANCE_PX, clamp, isFiniteNumber, normalizeFiniteNumber } from "./shared.js";
import type {
  EvasionLevel,
  EvasionProfile,
  EvasionSessionOptions,
  IntervalSampleOptions,
  Point2D
} from "./types.js";

const MIN_IDLE_DRIFT_DELAY_MS = 80;
const ORIGIN_POINT: Readonly<Point2D> = Object.freeze({ x: 0, y: 0 });

type PageWithViewportSize = Page & Partial<Pick<Page, "viewportSize">>;

interface ViewportBounds {
  width: number;
  height: number;
}

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
  private readonly diagnosticsEnabled: boolean;
  private readonly diagnosticsLabel: string;
  private readonly logger: EvasionSessionOptions["logger"];
  private mouseX = 0;
  private mouseY = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private fingerprintHardeningPromise: Promise<void> | undefined;

  /**
   * @param page - Playwright page to wrap with evasion helpers.
   * @param level - Desired evasion level. Defaults to `"moderate"`.
   * @param options - Optional diagnostics controls for debug logging.
   */
  constructor(
    page: Page,
    level: EvasionLevel = "moderate",
    options: EvasionSessionOptions = {}
  ) {
    this.page = page;
    this.level = resolveEvasionLevel(level, "EvasionSession level");
    this.profile = resolveEvasionProfile(this.level);
    this.logger = options.logger;
    this.diagnosticsEnabled = options.diagnosticsEnabled ?? this.logger !== undefined;
    this.diagnosticsLabel = options.diagnosticsLabel ?? "default";

    this.logDebug("evasion.session.created", {
      diagnostics_enabled: this.diagnosticsEnabled,
      diagnostics_label: this.diagnosticsLabel,
      profile: this.profile
    });
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

    if (this.fingerprintHardeningPromise === undefined) {
      this.fingerprintHardeningPromise = this.enqueue("harden_fingerprint", async () => {
        await applyFingerprintHardening(this.page, this.level);
        this.logDebug("evasion.session.fingerprint_hardening.applied", {
          diagnostics_label: this.diagnosticsLabel
        });
      }, undefined);
    }

    await this.fingerprintHardeningPromise;
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
    await this.enqueue("move_mouse", async () => {
      const safeFrom = this.normalizePoint(from);
      const safeTo = this.normalizePoint(to, safeFrom);
      const path = this.profile.bezierMouseMovement
        ? computeBezierPath(safeFrom, safeTo, { overshootFactor: this.profile.mouseOvershootFactor })
        : [safeTo];
      const steps = this.profile.bezierMouseMovement ? 1 : 5;
      let lastPoint = safeFrom;

      for (const pointOnPath of path) {
        const point = this.normalizePoint(pointOnPath, lastPoint);
        const moved = await this.tryMoveMouse(point, steps);
        if (!moved) {
          this.logDebug("evasion.session.mouse_move.fallback_to_direct", {
            diagnostics_label: this.diagnosticsLabel,
            destination: safeTo,
            attempted_point: point
          });
          await this.tryMoveMouse(safeTo, 5);
          this.setMousePosition(safeTo);
          return;
        }

        lastPoint = point;
      }

      this.setMousePosition(safeTo);
    }, undefined);
  }

  /**
   * Scroll by `pixels` using momentum simulation when the profile enables it.
   *
   * Distances are clamped into the supported range to avoid unrealistic jumps
   * or throwing during recovery paths.
   *
   * @param pixels - Distance in pixels (positive = down, negative = up).
   */
  async scroll(pixels: number): Promise<void> {
    await this.enqueue("scroll", async () => {
      const requestedPixels = normalizeFiniteNumber(pixels, 0);
      const clampedPixels = clamp(
        requestedPixels,
        -MAX_SCROLL_DISTANCE_PX,
        MAX_SCROLL_DISTANCE_PX
      );
      if (clampedPixels === 0) {
        return;
      }

      if (requestedPixels !== clampedPixels) {
        this.logDebug("evasion.session.scroll.clamped", {
          diagnostics_label: this.diagnosticsLabel,
          requested_pixels: requestedPixels,
          clamped_pixels: clampedPixels,
          max_scroll_distance_px: MAX_SCROLL_DISTANCE_PX
        });
      }

      if (this.profile.momentumScroll) {
        await simulateMomentumScroll(this.page, clampedPixels);
        return;
      }

      await scrollPageBy(this.page, clampedPixels, "smooth");
    }, undefined);
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
    const safeDurationMs = Math.max(0, Math.round(normalizeFiniteNumber(durationMs, 0)));
    if (safeDurationMs <= 0) {
      return;
    }

    await this.enqueue("idle", async () => {
      const shouldDrift = this.profile.idleDriftEnabled && this.profile.mouseJitterRadius > 0;
      if (shouldDrift) {
        const driftSteps = Math.max(1, Math.floor(safeDurationMs / 300));
        this.logDebug("evasion.session.idle.drift", {
          diagnostics_label: this.diagnosticsLabel,
          drift_steps: driftSteps,
          jitter_radius_px: this.profile.mouseJitterRadius,
          requested_duration_ms: safeDurationMs
        });
        await simulateIdleDrift(
          this.page,
          this.mouseX,
          this.mouseY,
          driftSteps,
          this.profile.mouseJitterRadius
        );
        const remainingMs = Math.max(0, safeDurationMs - driftSteps * MIN_IDLE_DRIFT_DELAY_MS);
        await this.waitForTimeoutSafely(remainingMs);
        return;
      }

      await this.waitForTimeoutSafely(safeDurationMs);
    }, undefined);
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

    await this.enqueue("simulate_tab_switch", async () => {
      await simulateTabBlurOnPage(this.page, blurDurationMs);
      this.logDebug("evasion.session.tab_switch.simulated", {
        blur_duration_ms: blurDurationMs,
        diagnostics_label: this.diagnosticsLabel
      });
    }, undefined);
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

    await this.enqueue("simulate_viewport_jitter", async () => {
      await simulateViewportJitterOnPage(this.page);
      this.logDebug("evasion.session.viewport_jitter.simulated", {
        diagnostics_label: this.diagnosticsLabel
      });
    }, undefined);
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

    await this.enqueue("reading_pause", async () => {
      const pauseMs = computeReadingPauseMs(charCount, this.profile.readingPauseWpm);
      if (pauseMs > 0) {
        this.logDebug("evasion.session.reading_pause.applied", {
          char_count: charCount,
          diagnostics_label: this.diagnosticsLabel,
          pause_ms: pauseMs,
          reading_pause_wpm: this.profile.readingPauseWpm
        });
        await this.waitForTimeoutSafely(pauseMs);
      }
    }, undefined);
  }

  /**
   * Sample an interval using the profile's timing strategy.
   *
   * Returns a Poisson-distributed value when `poissonIntervals` is enabled,
   * otherwise returns `baseMs` unchanged apart from optional clamping and
   * rate-limit backoff. Use this between any two sequential actions to add
   * realistic timing variation.
   *
   * @param baseMs - Base interval in milliseconds.
   * @param options - Optional bounds and rate-limit hints.
   * @returns Sampled interval in milliseconds.
   */
  sampleInterval(baseMs: number, options?: IntervalSampleOptions): number {
    const intervalMs = this.profile.poissonIntervals
      ? samplePoissonInterval(baseMs, options)
      : resolveIntervalMs(baseMs, options);

    if (
      this.profile.poissonIntervals &&
      (options?.rateLimited === true ||
        typeof options?.retryAfterMs === "number" ||
        typeof options?.responseStatus === "number")
    ) {
      this.logDebug("evasion.session.interval.sampled", {
        base_ms: baseMs,
        diagnostics_label: this.diagnosticsLabel,
        interval_ms: intervalMs,
        options
      });
    }

    return intervalMs;
  }

  /**
   * Check whether a CAPTCHA challenge is currently visible on the page.
   *
   * Returns `true` when a CAPTCHA is detected. The session does NOT solve
   * CAPTCHAs; callers should pause and alert an operator.
   */
  async detectCaptcha(): Promise<boolean> {
    return this.enqueue("detect_captcha", async () => {
      const detected = await detectCaptchaOnPage(this.page);
      if (detected) {
        this.logDebug("evasion.session.captcha.detected", {
          diagnostics_label: this.diagnosticsLabel
        });
      }

      return detected;
    }, false);
  }

  /**
   * Find likely honeypot form fields on the page.
   *
   * Returns CSS selectors of hidden inputs that should NOT be filled.
   */
  async findHoneypotFields(): Promise<readonly string[]> {
    return this.enqueue("find_honeypot_fields", async () => {
      const fields = await findHoneypotFieldsOnPage(this.page);
      if (fields.length > 0) {
        this.logDebug("evasion.session.honeypots.detected", {
          diagnostics_label: this.diagnosticsLabel,
          selectors: fields
        });
      }

      return fields;
    }, []);
  }

  private logDebug(event: string, payload: Record<string, unknown>): void {
    if (!this.diagnosticsEnabled || this.logger === undefined) {
      return;
    }

    this.logger.log("debug", event, {
      evasion_level: this.level,
      ...payload
    });
  }

  private enqueue<T>(
    operationName: string,
    operation: () => Promise<T>,
    fallback: T
  ): Promise<T> {
    const task = this.operationQueue.catch(() => undefined).then(async () => {
      try {
        return await operation();
      } catch (error) {
        this.logDebug("evasion.session.operation.failed", {
          diagnostics_label: this.diagnosticsLabel,
          error_message: getErrorMessage(error),
          operation_name: operationName
        });
        return fallback;
      }
    });

    this.operationQueue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  }

  private normalizePoint(
    point: Readonly<Point2D>,
    fallback: Readonly<Point2D> = ORIGIN_POINT
  ): Point2D {
    const normalizedPoint = {
      x: normalizeFiniteNumber(point.x, fallback.x),
      y: normalizeFiniteNumber(point.y, fallback.y)
    };

    return this.clampPointToViewport(normalizedPoint, this.resolveViewportBounds());
  }

  private resolveViewportBounds(): ViewportBounds | null {
    const pageWithViewportSize = this.page as PageWithViewportSize;
    if (typeof pageWithViewportSize.viewportSize !== "function") {
      return null;
    }

    try {
      const viewportSize = pageWithViewportSize.viewportSize();
      if (!isViewportSize(viewportSize)) {
        return null;
      }

      return {
        width: Math.max(0, viewportSize.width),
        height: Math.max(0, viewportSize.height)
      };
    } catch {
      return null;
    }
  }

  private clampPointToViewport(
    point: Readonly<Point2D>,
    viewportBounds: ViewportBounds | null
  ): Point2D {
    if (viewportBounds === null) {
      return {
        x: normalizeFiniteNumber(point.x, 0),
        y: normalizeFiniteNumber(point.y, 0)
      };
    }

    return {
      x: clamp(point.x, 0, viewportBounds.width),
      y: clamp(point.y, 0, viewportBounds.height)
    };
  }

  private setMousePosition(point: Readonly<Point2D>): void {
    this.mouseX = point.x;
    this.mouseY = point.y;
  }

  private async tryMoveMouse(point: Readonly<Point2D>, steps: number): Promise<boolean> {
    try {
      await this.page.mouse.move(point.x, point.y, { steps });
      return true;
    } catch (error) {
      this.logDebug("evasion.session.mouse_move.failed", {
        diagnostics_label: this.diagnosticsLabel,
        error_message: getErrorMessage(error),
        point,
        steps
      });
      return false;
    }
  }

  private async waitForTimeoutSafely(delayMs: number): Promise<void> {
    const safeDelayMs = Math.max(0, Math.round(normalizeFiniteNumber(delayMs, 0)));
    if (safeDelayMs <= 0) {
      return;
    }

    try {
      await this.page.waitForTimeout(safeDelayMs);
    } catch (error) {
      this.logDebug("evasion.session.wait_for_timeout.failed", {
        delay_ms: safeDelayMs,
        diagnostics_label: this.diagnosticsLabel,
        error_message: getErrorMessage(error)
      });
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isViewportSize(value: unknown): value is ViewportBounds {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return isFiniteNumber(record["width"]) && isFiniteNumber(record["height"]);
}
